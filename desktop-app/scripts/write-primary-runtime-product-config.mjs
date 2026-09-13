/* eslint-disable @typescript-eslint/explicit-function-return-type -- This Node release script intentionally has no TypeScript annotation surface. */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PACKAGED_PRODUCT_CONFIG_FILE = resolve(
  import.meta.dirname,
  '../resources/runtime/primary-runtime-product-config.json'
)
export const PACKAGED_PRODUCT_CONFIG_SCHEMA = 'dascowork-primary-runtime-product-config.v1'

/**
 * Turns the release pipeline's public trust configuration into the signed app
 * resource consumed by packaged Electron. It intentionally cannot carry a
 * development CA, credentials, direct archives, or a private signing key.
 */
export function packagedProductConfigFromEnvironment(env = process.env) {
  if (env.DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH?.trim()) {
    throw new Error('A packaged Primary Runtime product config cannot contain a local test CA.')
  }

  const configUrl = httpsUrl(
    requiredEnvironmentValue(env, 'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL'),
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL'
  )
  const allowedConfigOrigins = httpsOrigins(env, 'DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS')
  if (!allowedConfigOrigins.includes(new URL(configUrl).origin)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL must be in its allowed origin list.')
  }
  const allowedManifestOrigins = httpsOrigins(
    env,
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS'
  )
  const channel = requiredEnvironmentValue(env, 'DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL')
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(channel)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL is invalid.')
  }
  const configPublicKeys = jsonEnvironmentRecord(
    env,
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON'
  )
  const manifestPublicKeys = jsonEnvironmentRecord(
    env,
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON'
  )
  const pollInterval = env.DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS?.trim()
  const pollIntervalMs = pollInterval ? positivePollInterval(pollInterval) : undefined

  return {
    schemaVersion: PACKAGED_PRODUCT_CONFIG_SCHEMA,
    enabled: true,
    configUrl,
    allowedConfigOrigins,
    allowedManifestOrigins,
    channel,
    configPublicKeys,
    manifestPublicKeys,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs })
  }
}

export function disabledPackagedProductConfig() {
  return { schemaVersion: PACKAGED_PRODUCT_CONFIG_SCHEMA, enabled: false }
}

/**
 * Produces a disposable package resource for the deterministic packaged E2E
 * gate. It can trust only one public, ephemeral CA at a loopback engineering
 * feed; ordinary package and release paths keep rejecting this input.
 */
export function engineeringTestPackagedProductConfigFromEnvironment(env = process.env) {
  const localCaPath = requiredEnvironmentValue(
    env,
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH'
  )
  if (!isAbsolute(localCaPath)) {
    throw new Error('A packaged engineering test CA path must be absolute.')
  }
  const productConfig = packagedProductConfigFromEnvironment({
    ...env,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: undefined
  })
  const engineeringOrigins = [
    productConfig.configUrl,
    ...productConfig.allowedConfigOrigins,
    ...productConfig.allowedManifestOrigins
  ]
  if (!engineeringOrigins.every(isLoopbackHttpsUrl)) {
    throw new Error('A packaged engineering test config may only contact a loopback HTTPS feed.')
  }
  return {
    ...productConfig,
    engineeringTestLocalCaPath: localCaPath
  }
}

export async function writePackagedProductConfig(
  config,
  destination = PACKAGED_PRODUCT_CONFIG_FILE
) {
  await mkdir(dirname(destination), { recursive: true })
  const temporaryPath = `${destination}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, destination)
}

function requiredEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (!value)
    throw new Error(`${name} is required to build a packaged Primary Runtime configuration.`)
  return value
}

function httpsOrigins(env, name) {
  const values = requiredEnvironmentValue(env, name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (values.length === 0) throw new Error(`${name} must contain at least one origin.`)
  return values.map((value) => {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      throw new Error(`${name} must contain only HTTPS origins.`)
    }
    return url.origin
  })
}

function httpsUrl(value, name) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment.`)
  }
  return url.toString()
}

function isLoopbackHttpsUrl(value) {
  const url = new URL(value)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost')
  )
}

function positivePollInterval(value) {
  if (!/^\d+$/u.test(value)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS must be an integer.')
  }
  const interval = Number(value)
  if (!Number.isSafeInteger(interval) || interval < 30_000) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS must be at least 30000.')
  }
  return interval
}

function jsonEnvironmentRecord(env, name) {
  const source = requiredEnvironmentValue(env, name)
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${name} must be JSON.`)
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).length === 0 ||
    Object.entries(value).some(
      ([keyId, item]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(keyId) ||
        typeof item !== 'string' ||
        !item.includes('BEGIN PUBLIC KEY') ||
        item.includes('PRIVATE KEY')
    )
  ) {
    throw new Error(`${name} must contain non-empty PEM public keys only.`)
  }
  return value
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const disabled = process.argv.slice(2).join(' ') === '--disabled'
  if (!disabled && process.argv.length > 2) {
    throw new Error('Usage: node write-primary-runtime-product-config.mjs [--disabled]')
  }
  await writePackagedProductConfig(
    disabled ? disabledPackagedProductConfig() : packagedProductConfigFromEnvironment()
  )
}
