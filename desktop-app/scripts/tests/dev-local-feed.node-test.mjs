import assert from 'node:assert/strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test helpers stay compact in Node contract tests. */
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  assertLocalFeedClientProfileAvailable,
  defaultLocalFeedClientProfilePath,
  defaultLocalFeedUserDataPath,
  localFeedChildEnvironment,
  localFeedUserDataEnvironmentVariable,
  prepareLocalFeedUserDataDirectory,
  validateLocalFeedClientProfile
} from '../dev-local-feed.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const repositoryRoot = resolve(appRoot, '..')
const publicKey = generateKeyPairSync('ed25519').publicKey.export({
  type: 'spki',
  format: 'pem'
})

function validProfile(overrides = {}) {
  return {
    origin: 'https://127.0.0.1:9443',
    channel: 'development',
    configPublicKeys: { config: publicKey },
    manifestPublicKeys: { manifest: publicKey },
    caPath: '/private/tmp/runtime-feed-ca.pem',
    ...overrides
  }
}

test('local Feed launcher is the only public desktop development feed command', async () => {
  const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.dev, 'electron-vite dev')
  assert.equal(packageJson.scripts['dev:local-feed'], 'node scripts/dev-local-feed.mjs')
  assert.equal(packageJson.scripts['dev:primary-runtime'], undefined)
  assert.equal(packageJson.scripts['dev:with-primary-runtime-feed'], undefined)
  assert.match(packageJson.scripts['test:release-contract'], /dev-local-feed\.node-test/u)
  assert.doesNotMatch(packageJson.scripts['test:release-contract'], /dev-primary-runtime/u)
})

test('local Feed launcher reads the public client profile from the Feed development var directory', () => {
  assert.equal(
    defaultLocalFeedClientProfilePath,
    join(repositoryRoot, 'services/primary-runtime-feed/var/development/client-profile.json')
  )
})

test('local Feed client profile schema accepts only public connection material', () => {
  const profile = validateLocalFeedClientProfile(validProfile())
  assert.deepEqual(Object.keys(profile).sort(), [
    'caPath',
    'channel',
    'configPublicKeys',
    'manifestPublicKeys',
    'origin'
  ])
  assert.equal(profile.origin, 'https://127.0.0.1:9443')
  assert.equal(profile.channel, 'development')
  assert.equal(profile.caPath, '/private/tmp/runtime-feed-ca.pem')
  assert.deepEqual(profile.configPublicKeys, { config: publicKey })

  assert.throws(
    () => validateLocalFeedClientProfile(validProfile({ origin: 'https://feed.example.test' })),
    /loopback HTTPS/u
  )
  assert.throws(
    () => validateLocalFeedClientProfile(validProfile({ caPath: 'relative-ca.pem' })),
    /absolute/u
  )
  assert.throws(
    () => validateLocalFeedClientProfile(validProfile({ signingPrivateKeyPath: '/tmp/key.pem' })),
    /unsupported fields/u
  )
  assert.throws(
    () =>
      validateLocalFeedClientProfile(
        validProfile({ configPublicKeys: { config: '-----BEGIN PRIVATE KEY-----\\n' } })
      ),
    /public keys only/u
  )
})

test('local Feed launcher verifies CA file and Feed reachability before starting Electron', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dascowork-local-feed-profile-'))
  const caPath = join(temporaryRoot, 'ca.pem')
  await writeFile(caPath, 'test ca')
  const profile = validateLocalFeedClientProfile(validProfile({ caPath }))
  let probedOrigin
  await assertLocalFeedClientProfileAvailable(profile, {
    probe: async (candidate) => {
      probedOrigin = candidate.origin
    }
  })
  assert.equal(probedOrigin, 'https://127.0.0.1:9443')
})

test('local Feed child environment strips direct Runtime overrides and isolates userData', () => {
  const profile = validateLocalFeedClientProfile(validProfile())
  const environment = localFeedChildEnvironment(profile, {
    DASCOWORK_PRIMARY_RUNTIME_ROOT: '/private/tmp/forbidden-root',
    DASCOWORK_PRIMARY_RUNTIME_VERSION: 'forbidden-direct-release',
    DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL: 'https://forbidden.example.test/manifest.json'
  })

  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_ROOT, undefined)
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_VERSION, undefined)
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL, undefined)
  assert.equal(environment[localFeedUserDataEnvironmentVariable], defaultLocalFeedUserDataPath)
  assert.equal(
    environment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL,
    'https://127.0.0.1:9443/v1/runtime/config.json'
  )
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS, profile.origin)
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL, 'development')
  assert.equal(environment.DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH, profile.caPath)
  assert.throws(
    () =>
      localFeedChildEnvironment(profile, {
        [localFeedUserDataEnvironmentVariable]: 'relative-user-data'
      }),
    /absolute/u
  )
})

test('local Feed launcher creates the dedicated userData directory on cold start', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dascowork-local-feed-user-data-'))
  const userDataPath = join(temporaryRoot, 'cold-start-user-data')
  await prepareLocalFeedUserDataDirectory(userDataPath)

  const details = await stat(userDataPath)
  assert.equal(details.isDirectory(), true)
  assert.equal(details.mode & 0o777, 0o700)
})

test('local Feed launcher rejects a non-directory userData path', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dascowork-local-feed-user-data-'))
  const userDataPath = join(temporaryRoot, 'not-a-directory')
  await writeFile(userDataPath, 'file')
  await assert.rejects(() => prepareLocalFeedUserDataDirectory(userDataPath), /directory/u)
})
