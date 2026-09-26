#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Launcher configuration is covered by Node contract tests. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createPublicKey } from 'node:crypto'
import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, stat } from 'node:fs/promises'
import { get } from 'node:https'
import { isAbsolute, join, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(appRoot, '..')
export const defaultLocalFeedClientProfilePath = join(
  repositoryRoot,
  'services/primary-runtime-feed/var/development/client-profile.json'
)
export const localFeedUserDataEnvironmentVariable = 'DASCOWORK_DEV_LOCAL_FEED_USER_DATA_DIR'
export const defaultLocalFeedUserDataPath = join(appRoot, '.primary-runtime-local-feed-user-data')

export async function readLocalFeedClientProfile(path = defaultLocalFeedClientProfilePath) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Primary Runtime local Feed client profile is missing at ${path}. Run the Feed dev import/serve setup first.`
      )
    }
    throw error
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('Primary Runtime local Feed client profile must be valid JSON.')
  }
  return validateLocalFeedClientProfile(parsed)
}

export function validateLocalFeedClientProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Primary Runtime local Feed client profile must be an object.')
  }
  const allowedKeys = ['origin', 'channel', 'configPublicKeys', 'manifestPublicKeys', 'caPath']
  const unknownKeys = Object.keys(profile).filter((key) => !allowedKeys.includes(key))
  if (unknownKeys.length > 0) {
    throw new Error(
      `Primary Runtime local Feed client profile contains unsupported fields: ${unknownKeys.join(', ')}.`
    )
  }

  const origin = requireString(profile.origin, 'origin')
  const channel = requireString(profile.channel, 'channel')
  const caPath = requireString(profile.caPath, 'caPath')
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(channel)) {
    throw new Error('Primary Runtime local Feed client profile channel is invalid.')
  }
  if (!isAbsolute(caPath)) {
    throw new Error('Primary Runtime local Feed client profile CA path must be absolute.')
  }

  const originUrl = new URL(origin)
  if (
    originUrl.protocol !== 'https:' ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== '/' ||
    originUrl.search ||
    originUrl.hash ||
    !isLoopbackHostname(originUrl.hostname)
  ) {
    throw new Error('Primary Runtime local Feed client profile origin must be loopback HTTPS.')
  }

  return Object.freeze({
    origin: originUrl.origin,
    channel,
    configPublicKeys: validatePublicKeyring(profile.configPublicKeys, 'configPublicKeys'),
    manifestPublicKeys: validatePublicKeyring(profile.manifestPublicKeys, 'manifestPublicKeys'),
    caPath
  })
}

export async function assertLocalFeedClientProfileAvailable(
  profile,
  { probe = probeLocalFeed, statFile = stat } = {}
) {
  const ca = await statFile(profile.caPath)
  if (!ca.isFile()) {
    throw new Error('Primary Runtime local Feed client profile CA path must point to a file.')
  }
  await probe(profile)
}

export async function prepareLocalFeedUserDataDirectory(
  userDataPath,
  { makeDirectory = mkdir, chmodPath = chmod, statPath = stat, accessPath = access } = {}
) {
  let existed = true
  try {
    await statPath(userDataPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    existed = false
  }
  await makeDirectory(userDataPath, { recursive: true, mode: 0o700 })
  if (!existed) await chmodPath(userDataPath, 0o700)

  const details = await statPath(userDataPath)
  if (!details.isDirectory()) {
    throw new Error(`${localFeedUserDataEnvironmentVariable} must point to a directory.`)
  }
  try {
    await accessPath(userDataPath, constants.W_OK)
  } catch {
    throw new Error(`${localFeedUserDataEnvironmentVariable} must point to a writable directory.`)
  }
}

export function localFeedChildEnvironment(profile, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment }
  for (const key of directRuntimeOverrides) delete environment[key]
  const userDataPath =
    environment[localFeedUserDataEnvironmentVariable]?.trim() || defaultLocalFeedUserDataPath
  if (!isAbsolute(userDataPath)) {
    throw new Error(`${localFeedUserDataEnvironmentVariable} must be an absolute path.`)
  }
  return {
    ...environment,
    [localFeedUserDataEnvironmentVariable]: userDataPath,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL: `${profile.origin}/v1/runtime/config.json`,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS: profile.origin,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS: profile.origin,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: profile.channel,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: JSON.stringify(profile.configPublicKeys),
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: JSON.stringify(
      profile.manifestPublicKeys
    ),
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: profile.caPath
  }
}

async function main() {
  const profile = await readLocalFeedClientProfile()
  await assertLocalFeedClientProfileAvailable(profile)
  const environment = localFeedChildEnvironment(profile)
  await prepareLocalFeedUserDataDirectory(environment[localFeedUserDataEnvironmentVariable])
  const child = spawn('npm', ['run', 'dev'], {
    cwd: appRoot,
    env: environment,
    stdio: 'inherit'
  })
  const forwardShutdown = (signal) => child.kill(signal)
  process.once('SIGINT', () => forwardShutdown('SIGINT'))
  process.once('SIGTERM', () => forwardShutdown('SIGTERM'))
  const [code, signal] = await once(child, 'exit')
  if (signal) return 1
  return typeof code === 'number' ? code : 1
}

async function probeLocalFeed(profile) {
  const ca = await readFile(profile.caPath)
  await new Promise((resolveProbe, reject) => {
    const request = get(
      `${profile.origin}/v1/runtime/config.json`,
      { ca, timeout: 5_000 },
      (response) => {
        response.resume()
        if (response.statusCode === 200) resolveProbe(undefined)
        else reject(new Error(`Primary Runtime local Feed returned HTTP ${response.statusCode}.`))
      }
    )
    request.once('timeout', () => {
      request.destroy(new Error('Primary Runtime local Feed reachability check timed out.'))
    })
    request.once('error', (error) => {
      reject(
        new Error(
          `Primary Runtime local Feed is not reachable at ${profile.origin}: ${error.message}`
        )
      )
    })
  })
}

function validatePublicKeyring(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Primary Runtime local Feed ${label} must be a public key map.`)
  }
  const entries = Object.entries(value)
  if (entries.length === 0) {
    throw new Error(`Primary Runtime local Feed ${label} must not be empty.`)
  }
  for (const [keyId, key] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(keyId)) {
      throw new Error(`Primary Runtime local Feed ${label} contains an invalid key ID.`)
    }
    if (typeof key !== 'string' || key.includes('PRIVATE KEY')) {
      throw new Error(`Primary Runtime local Feed ${label} must contain public keys only.`)
    }
    try {
      createPublicKey(key)
    } catch {
      throw new Error(`Primary Runtime local Feed ${label} contains an invalid public key.`)
    }
  }
  return Object.freeze(Object.fromEntries(entries))
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Primary Runtime local Feed client profile ${field} is required.`)
  }
  return value.trim()
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]'
}

const directRuntimeOverrides = [
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH',
  'DASCOWORK_PRIMARY_RUNTIME_ROOT',
  'DASCOWORK_PRIMARY_RUNTIME_VERSION',
  'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL',
  'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256',
  'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES',
  'DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL',
  'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL'
]

if (resolve(process.argv[1] ?? '') === new URL(import.meta.url).pathname) {
  process.exitCode = await main()
}
