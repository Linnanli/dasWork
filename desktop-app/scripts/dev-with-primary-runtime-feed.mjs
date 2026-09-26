/* eslint-disable @typescript-eslint/explicit-function-return-type -- E2E helper configuration is covered by Node contract tests. */

import { isAbsolute, resolve } from 'node:path'

import {
  parseFeedPublicKeyring,
  publishRepository
} from '../../services/primary-runtime-feed/src/repository.mjs'
import { createPrimaryRuntimeFeedServer } from '../../services/primary-runtime-feed/src/server.mjs'

/**
 * Starts an already-built, signed local feed and launches Electron with only
 * the product-config path enabled. Runtime construction stays in the release
 * builder; this command intentionally cannot point Electron at a local root
 * or a direct archive override.
 */
export function resolvePrimaryRuntimeFeedDevelopmentConfiguration(env = process.env) {
  const host = (env.DASCOWORK_PRIMARY_RUNTIME_FEED_HOST ?? '127.0.0.1').trim()
  const port = Number(env.DASCOWORK_PRIMARY_RUNTIME_FEED_PORT ?? '9443')
  if (!isLoopbackHost(host)) {
    throw new Error('Primary Runtime development feed host must be a loopback address.')
  }
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('Primary Runtime development feed port is invalid.')
  }

  const configuration = {
    repositoryRoot: requiredAbsolutePath(env, 'DASCOWORK_PRIMARY_RUNTIME_FEED_REPOSITORY_ROOT'),
    stagedRoot: requiredAbsolutePath(env, 'DASCOWORK_PRIMARY_RUNTIME_FEED_STAGED_ROOT'),
    tlsKeyPath: requiredAbsolutePath(env, 'DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_KEY'),
    tlsCertPath: requiredAbsolutePath(env, 'DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CERT'),
    tlsCaPath: requiredAbsolutePath(env, 'DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA'),
    configPublicKeys: requiredValue(env, 'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON'),
    manifestPublicKeys: requiredValue(
      env,
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON'
    ),
    channel: requiredValue(env, 'DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL'),
    host,
    port
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(configuration.channel)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL is invalid.')
  }
  return Object.freeze(configuration)
}

export function primaryRuntimeFeedChildEnvironment(configuration, baseEnvironment = process.env) {
  const origin = `https://${configuration.host}:${configuration.port}`
  const environment = { ...baseEnvironment }
  for (const key of directRuntimeOverrides) delete environment[key]
  return {
    ...environment,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL: `${origin}/v1/runtime/config.json`,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS: origin,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS: origin,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: configuration.channel,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: configuration.configPublicKeys,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: configuration.manifestPublicKeys,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: configuration.tlsCaPath
  }
}

export async function startPrimaryRuntimeFeed(
  configuration,
  { allowSyntheticTestOnly = false, allowCalibrationCandidate = false } = {}
) {
  await publishRepository({
    repositoryRoot: configuration.repositoryRoot,
    stagedRoot: configuration.stagedRoot,
    configPublicKeys: parseFeedPublicKeyring(configuration.configPublicKeys, 'config'),
    manifestPublicKeys: parseFeedPublicKeyring(configuration.manifestPublicKeys, 'manifest'),
    allowSyntheticTestOnly,
    allowCalibrationCandidate
  })
  const server = await createPrimaryRuntimeFeedServer({
    repositoryRoot: configuration.repositoryRoot,
    tls: { keyPath: configuration.tlsKeyPath, certPath: configuration.tlsCertPath },
    allowedHosts: [runtimeFeedRequestHost(configuration.host, configuration.port)]
  })
  await new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(configuration.port, configuration.host, () => {
      server.off('error', reject)
      resolveServer(undefined)
    })
  })
  return server
}

function runtimeFeedRequestHost(host, port) {
  const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `${formattedHost}:${port}`
}

function requiredValue(env, name) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function requiredAbsolutePath(env, name) {
  const value = requiredValue(env, name)
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`)
  return value
}

function isLoopbackHost(host) {
  const normalized = host.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1'
}

const directRuntimeOverrides = [
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
  console.error(
    'dev-with-primary-runtime-feed.mjs is an internal signed-Feed E2E helper. Use npm run dev:local-feed for desktop development.'
  )
  process.exitCode = 1
}
