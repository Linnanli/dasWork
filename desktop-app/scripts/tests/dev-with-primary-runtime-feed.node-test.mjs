import assert from 'node:assert/strict'
import test from 'node:test'

import {
  primaryRuntimeFeedChildEnvironment,
  resolvePrimaryRuntimeFeedDevelopmentConfiguration
} from '../dev-with-primary-runtime-feed.mjs'

const configurationEnvironment = {
  DASCOWORK_PRIMARY_RUNTIME_FEED_REPOSITORY_ROOT: '/private/tmp/runtime-feed',
  DASCOWORK_PRIMARY_RUNTIME_FEED_STAGED_ROOT: '/private/tmp/runtime-feed/staged',
  DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_KEY: '/private/tmp/runtime-feed/tls/key.pem',
  DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CERT: '/private/tmp/runtime-feed/tls/cert.pem',
  DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA: '/private/tmp/runtime-feed/tls/ca.pem',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: '{"config-1":"public-key"}',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: '{"manifest-1":"public-key"}',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: 'stable'
}

test('development feed config requires local TLS and signed product-config inputs', () => {
  const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration(configurationEnvironment)
  assert.equal(configuration.host, '127.0.0.1')
  assert.equal(configuration.port, 9443)
  assert.throws(
    () =>
      resolvePrimaryRuntimeFeedDevelopmentConfiguration({
        ...configurationEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_FEED_HOST: 'feed.example.test'
      }),
    /loopback/u
  )
  assert.throws(
    () =>
      resolvePrimaryRuntimeFeedDevelopmentConfiguration({
        ...configurationEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA: 'relative-ca.pem'
      }),
    /absolute/u
  )
})

test('development feed child receives product config only and never direct Runtime overrides', () => {
  const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration(configurationEnvironment)
  const environment = primaryRuntimeFeedChildEnvironment(configuration, {
    DASCOWORK_PRIMARY_RUNTIME_ROOT: '/private/tmp/forbidden-root',
    DASCOWORK_PRIMARY_RUNTIME_VERSION: 'forbidden-direct-release',
    DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL: 'https://forbidden.example.test/manifest.json'
  })

  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_ROOT, undefined)
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_VERSION, undefined)
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL, undefined)
  assert.equal(
    environment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL,
    'https://127.0.0.1:9443/v1/runtime/config.json'
  )
  assert.equal(
    environment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH,
    configuration.tlsCaPath
  )
})
