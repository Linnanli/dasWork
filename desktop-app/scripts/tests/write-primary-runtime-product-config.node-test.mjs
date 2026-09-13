import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PACKAGED_PRODUCT_CONFIG_SCHEMA,
  disabledPackagedProductConfig,
  engineeringTestPackagedProductConfigFromEnvironment,
  packagedProductConfigFromEnvironment,
  writePackagedProductConfig
} from '../write-primary-runtime-product-config.mjs'

const releaseEnvironment = {
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL: 'https://runtime.example.test/v1/runtime/config.json',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS: 'https://runtime.example.test',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS: 'https://runtime.example.test',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: 'stable',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON:
    '{"config-1":"-----BEGIN PUBLIC KEY-----\\nconfig\\n-----END PUBLIC KEY-----"}',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON:
    '{"manifest-1":"-----BEGIN PUBLIC KEY-----\\nmanifest\\n-----END PUBLIC KEY-----"}',
  DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS: '30000'
}

test('creates a public packaged trust configuration from release inputs', () => {
  assert.deepEqual(packagedProductConfigFromEnvironment(releaseEnvironment), {
    schemaVersion: PACKAGED_PRODUCT_CONFIG_SCHEMA,
    enabled: true,
    configUrl: 'https://runtime.example.test/v1/runtime/config.json',
    allowedConfigOrigins: ['https://runtime.example.test'],
    allowedManifestOrigins: ['https://runtime.example.test'],
    channel: 'stable',
    configPublicKeys: {
      'config-1': '-----BEGIN PUBLIC KEY-----\nconfig\n-----END PUBLIC KEY-----'
    },
    manifestPublicKeys: {
      'manifest-1': '-----BEGIN PUBLIC KEY-----\nmanifest\n-----END PUBLIC KEY-----'
    },
    pollIntervalMs: 30000
  })
  assert.throws(
    () =>
      packagedProductConfigFromEnvironment({
        ...releaseEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: '/tmp/test-ca.pem'
      }),
    /local test CA/u
  )
})

test('fails closed for missing or malformed public inputs', () => {
  assert.throws(
    () =>
      packagedProductConfigFromEnvironment({
        ...releaseEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: ''
      }),
    /CONFIG_CHANNEL/u
  )
  assert.throws(
    () =>
      packagedProductConfigFromEnvironment({
        ...releaseEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: '{}'
      }),
    /non-empty PEM public keys/u
  )
  assert.throws(
    () =>
      packagedProductConfigFromEnvironment({
        ...releaseEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS: '1'
      }),
    /at least 30000/u
  )
})

test('allows an ephemeral CA only for a loopback packaged engineering test', () => {
  const engineeringEnvironment = {
    ...releaseEnvironment,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL: 'https://127.0.0.1:9443/v1/runtime/config.json',
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS: 'https://127.0.0.1:9443',
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS: 'https://127.0.0.1:9443',
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: '/private/tmp/engineering-test-ca.pem'
  }
  assert.deepEqual(engineeringTestPackagedProductConfigFromEnvironment(engineeringEnvironment), {
    ...packagedProductConfigFromEnvironment({
      ...engineeringEnvironment,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: undefined
    }),
    engineeringTestLocalCaPath: '/private/tmp/engineering-test-ca.pem'
  })
  assert.throws(
    () =>
      engineeringTestPackagedProductConfigFromEnvironment({
        ...engineeringEnvironment,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL:
          releaseEnvironment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS:
          releaseEnvironment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS,
        DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS:
          releaseEnvironment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS
      }),
    /loopback HTTPS/u
  )
})

test('writes an atomic disabled configuration for ordinary package builds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-packaged-config-writer-'))
  const destination = join(directory, 'primary-runtime-product-config.json')
  try {
    await writePackagedProductConfig(disabledPackagedProductConfig(), destination)
    assert.deepEqual(
      JSON.parse(await readFile(destination, 'utf8')),
      disabledPackagedProductConfig()
    )
  } finally {
    await rm(directory, { recursive: true })
  }
})
