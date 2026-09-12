#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executable test orchestration is covered by its Node contract test. */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { buildSyntheticRuntime } from '../../primary-runtime/scripts/build-synthetic-runtime.mjs'
import { signFeedMetadata } from '../../services/primary-runtime-feed/src/repository.mjs'

import {
  primaryRuntimeFeedChildEnvironment,
  resolvePrimaryRuntimeFeedDevelopmentConfiguration,
  startPrimaryRuntimeFeed
} from './dev-with-primary-runtime-feed.mjs'

const executeFile = promisify(execFile)
const appRoot = resolve(import.meta.dirname, '..')
const syntheticChannel = 'synthetic-test'

if (resolve(process.argv[1] ?? '') === new URL(import.meta.url).pathname) {
  process.exitCode = await main()
}

/** Keeps this intentionally non-default: it proves a local test lane, not a release. */
export function requirePrimaryRuntimeSyntheticFeedE2eEnvironment(env = process.env) {
  if (env.DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E !== '1') {
    throw new Error(
      'Set DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E=1 to run the synthetic Primary Runtime Feed E2E test.'
    )
  }
}

export async function createSyntheticFeedFixture(root, { host, port }) {
  const build = await buildSyntheticRuntime({ outputRoot: join(root, 'runtime-build') })
  const configKey = generateFeedKey()
  const manifestKey = generateFeedKey()
  const metadataRoot = join(root, 'metadata')
  const stagedRoot = join(root, 'repository', 'staged')
  const origin = `https://${host}:${port}`
  const issuedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const releases = build.targets.map((target) => ({
    platform: target.platform,
    arch: target.arch,
    version: build.version,
    archiveFormat: 'zip',
    archiveUrl: `${origin}/v1/runtime/archives/${build.version}/${target.target}/primary-runtime.zip`,
    archiveSizeBytes: target.archiveSizeBytes,
    archiveSha256: target.archiveSha256,
    budget: syntheticReleaseBudget(target.archiveSizeBytes)
  }))
  const manifest = signFeedMetadata(
    {
      schemaVersion: 1,
      sequence: 1,
      channel: syntheticChannel,
      issuedAt,
      expiresAt,
      keyId: 'synthetic-manifest-v1',
      releases
    },
    manifestKey.privateKey
  )
  const config = signFeedMetadata(
    {
      schemaVersion: 1,
      sequence: 1,
      channel: syntheticChannel,
      manifestUrl: `${origin}/v1/runtime/channels/${syntheticChannel}/manifest.json`,
      pollIntervalMs: 30_000,
      issuedAt,
      expiresAt,
      keyId: 'synthetic-config-v1'
    },
    configKey.privateKey
  )

  await writeJson(join(metadataRoot, 'config.json'), config)
  await writeJson(join(metadataRoot, 'channels', syntheticChannel, 'manifest.json'), manifest)
  await mkdir(stagedRoot, { recursive: true })
  await cp(join(metadataRoot, 'config.json'), join(stagedRoot, 'config.json'))
  await cp(
    join(metadataRoot, 'channels', syntheticChannel, 'manifest.json'),
    join(stagedRoot, 'channels', syntheticChannel, 'manifest.json'),
    { recursive: true }
  )
  for (const target of build.targets) {
    const destination = join(stagedRoot, 'archives', build.version, target.target)
    await mkdir(destination, { recursive: true })
    await cp(target.archivePath, join(destination, 'primary-runtime.zip'))
    const provenance = JSON.parse(await readFile(target.provenancePath, 'utf8'))
    await writeJson(join(destination, 'provenance.json'), {
      ...provenance,
      // The Feed validator binds provenance to signed metadata. This value is
      // explicitly a deterministic synthetic identifier, never a source commit.
      commit: syntheticCommitFor(target.target),
      configSequence: config.sequence,
      manifestSequence: manifest.sequence
    })
  }

  const tls = await createLocalTls(root)
  return {
    repositoryRoot: join(root, 'repository'),
    stagedRoot,
    tls,
    configPublicKeys: JSON.stringify({ 'synthetic-config-v1': configKey.publicKey }),
    manifestPublicKeys: JSON.stringify({ 'synthetic-manifest-v1': manifestKey.publicKey }),
    sourceLockPath: build.sourceLockPath,
    metadata: build
  }
}

function syntheticReleaseBudget(archiveSizeBytes) {
  // Synthetic bundles intentionally compress far better than a production runtime.
  // Give their signed test metadata a conservative, static envelope so the installer
  // exercises budget validation without treating compression ratio as a release fact.
  const maxArchiveBytes = Math.max(archiveSizeBytes, 512 * 1024 * 1024)
  const maxUnpackedBytes = 2 * 1024 * 1024 * 1024
  return {
    maxArchiveBytes,
    maxUnpackedBytes,
    minimumFreeDiskBytes: Math.ceil((maxArchiveBytes + 2 * maxUnpackedBytes) * 1.15),
    maxColdInstallMs: 60_000,
    maxMainEventLoopDelayP99Ms: 50,
    maxMainEventLoopDelayMaxMs: 250
  }
}

async function main() {
  requirePrimaryRuntimeSyntheticFeedE2eEnvironment()
  const root = await mkdtemp(join(tmpdir(), 'dascowork-primary-runtime-synthetic-feed-'))
  const host = '127.0.0.1'
  const port = await reserveLoopbackPort(host)
  let server
  try {
    const fixture = await createSyntheticFeedFixture(root, { host, port })
    const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration({
      ...process.env,
      DASCOWORK_PRIMARY_RUNTIME_FEED_REPOSITORY_ROOT: fixture.repositoryRoot,
      DASCOWORK_PRIMARY_RUNTIME_FEED_STAGED_ROOT: fixture.stagedRoot,
      DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_KEY: fixture.tls.keyPath,
      DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CERT: fixture.tls.certPath,
      DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA: fixture.tls.caPath,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: fixture.configPublicKeys,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: fixture.manifestPublicKeys,
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: syntheticChannel,
      DASCOWORK_PRIMARY_RUNTIME_FEED_HOST: host,
      DASCOWORK_PRIMARY_RUNTIME_FEED_PORT: String(port)
    })
    server = await startPrimaryRuntimeFeed(configuration, { allowSyntheticTestOnly: true })
    await assertSyntheticFeedReachable(configuration, await readFile(fixture.tls.caPath, 'utf8'))
    const environment = primaryRuntimeFeedChildEnvironment(configuration, {
      ...process.env,
      DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E: '1',
      DASCOWORK_PRIMARY_RUNTIME_ALLOW_SYNTHETIC_TEST_RUNTIME: '1',
      DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: fixture.tls.caPath,
      DASCOWORK_SYNTHETIC_RUNTIME_HOST_NODE: process.execPath
    })
    const buildStatus = await run('npm', ['run', 'build'], environment)
    if (buildStatus !== 0) return buildStatus
    return await run(
      'npx',
      ['playwright', 'test', 'tests/e2e/primary-runtime-synthetic-feed.e2e.ts', '--reporter=line'],
      environment
    )
  } finally {
    if (server?.listening) {
      server.close()
      await once(server, 'close')
    }
    await rm(root, { recursive: true, force: true })
  }
}

function generateFeedKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }
}

function syntheticCommitFor(target) {
  return createHash('sha256').update(`synthetic-feed-e2e:${target}\n`).digest('hex').slice(0, 40)
}

async function assertSyntheticFeedReachable(configuration, ca) {
  const url = `https://${configuration.host}:${configuration.port}/v1/runtime/config.json`
  const body = await new Promise((resolveBody, reject) => {
    const request = httpsRequest(url, { ca, rejectUnauthorized: true }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Synthetic Feed probe returned HTTP ${response.statusCode ?? 0}: ${Buffer.concat(chunks).toString('utf8')}`
            )
          )
          return
        }
        resolveBody(Buffer.concat(chunks).toString('utf8'))
      })
    })
    request.setTimeout(5_000, () => request.destroy(new Error('Synthetic Feed probe timed out.')))
    request.once('error', reject)
    request.end()
  })
  const config = JSON.parse(body)
  if (config.channel !== syntheticChannel)
    throw new Error('Synthetic Feed probe returned the wrong channel.')
}

async function createLocalTls(root) {
  const directory = join(root, 'tls')
  const caKeyPath = join(directory, 'test-ca-key.pem')
  const caPath = join(directory, 'test-ca-cert.pem')
  const keyPath = join(directory, 'server-key.pem')
  const requestPath = join(directory, 'server.csr')
  const certPath = join(directory, 'server-cert.pem')
  const extensionsPath = join(directory, 'server-extensions.cnf')
  await mkdir(directory, { recursive: true })
  await executeFile('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    caKeyPath,
    '-out',
    caPath,
    '-days',
    '1',
    '-subj',
    '/CN=dascowork-synthetic-feed-test-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign'
  ])
  await executeFile('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    requestPath,
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1'
  ])
  await writeFile(
    extensionsPath,
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:127.0.0.1\n',
    { mode: 0o600 }
  )
  await executeFile('openssl', [
    'x509',
    '-req',
    '-in',
    requestPath,
    '-CA',
    caPath,
    '-CAkey',
    caKeyPath,
    '-CAcreateserial',
    '-out',
    certPath,
    '-days',
    '1',
    '-extfile',
    extensionsPath
  ])
  return { keyPath, certPath, caPath }
}

async function reserveLoopbackPort(host) {
  const server = createServer()
  await new Promise((resolveServer, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolveServer(undefined)
    })
  })
  const address = server.address()
  server.close()
  await once(server, 'close')
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port.')
  return address.port
}

async function writeJson(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function run(command, args, environment) {
  const env = { ...environment }
  delete env.CODEX_APP_SERVER_BIN
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: appRoot, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}
