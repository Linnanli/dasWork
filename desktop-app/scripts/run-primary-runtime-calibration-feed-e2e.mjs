#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- The runner's options and receipts are covered by its Node contract test. */

import { execFile, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { signFeedMetadata } from '../../services/primary-runtime-feed/src/repository.mjs'

import {
  primaryRuntimeFeedChildEnvironment,
  resolvePrimaryRuntimeFeedDevelopmentConfiguration,
  startPrimaryRuntimeFeed
} from './dev-with-primary-runtime-feed.mjs'

const executeFile = promisify(execFile)
const appRoot = resolve(import.meta.dirname, '..')
const channel = 'p3b-calibration'
const options = parseOptions(process.argv.slice(2))

const root = await mkdtemp(join(tmpdir(), 'dascowork-primary-runtime-p3b-feed-'))
let server
try {
  const fixture = await createP1aCalibrationFeedFixture(root, options)
  const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration({
    ...process.env,
    DASCOWORK_PRIMARY_RUNTIME_FEED_REPOSITORY_ROOT: fixture.repositoryRoot,
    DASCOWORK_PRIMARY_RUNTIME_FEED_STAGED_ROOT: fixture.stagedRoot,
    DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_KEY: fixture.tls.keyPath,
    DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CERT: fixture.tls.certPath,
    DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA: fixture.tls.caPath,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: fixture.configPublicKeys,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: fixture.manifestPublicKeys,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: channel,
    DASCOWORK_PRIMARY_RUNTIME_FEED_HOST: fixture.host,
    DASCOWORK_PRIMARY_RUNTIME_FEED_PORT: String(fixture.port)
  })
  server = await startPrimaryRuntimeFeed(configuration, { allowCalibrationCandidate: true })
  await assertFeedReachable(configuration, await readFile(fixture.tls.caPath, 'utf8'))
  const environment = primaryRuntimeFeedChildEnvironment(configuration, {
    ...process.env,
    DASCOWORK_PRIMARY_RUNTIME_FEED_E2E: '1',
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: fixture.tls.caPath
  })
  const buildStatus = await run('npm', ['run', 'build'], environment)
  if (buildStatus !== 0) process.exitCode = buildStatus
  else {
    const e2eStatus = await run(
      'npx',
      ['playwright', 'test', 'tests/e2e/primary-runtime-feed.e2e.ts', '--reporter=line'],
      environment
    )
    if (e2eStatus !== 0) process.exitCode = e2eStatus
    else await writeReceipt(options.output, fixture)
  }
} finally {
  if (server?.listening) {
    server.close()
    await once(server, 'close')
  }
  await rm(root, { recursive: true, force: true })
}

async function createP1aCalibrationFeedFixture(root, input) {
  const archive = await stat(input.archive)
  const archiveSha256 = await sha256File(input.archive)
  if (archiveSha256 !== input.sha256) {
    throw new Error('P3b normal-chat feed archive digest does not match --sha256.')
  }
  const provenance = JSON.parse(await readFile(input.provenance, 'utf8'))
  if (
    provenance?.schemaVersion !== 'dascowork-primary-runtime-provenance.v1' ||
    provenance.target !== input.target ||
    provenance.bundleVersion !== input.version ||
    provenance.archiveSha256 !== archiveSha256 ||
    provenance.archiveSizeBytes !== archive.size ||
    provenance.releaseClass !== 'engineering-candidate' ||
    provenance.productionTrust !== false
  ) {
    throw new Error('P3b normal-chat feed requires the exact verified P1a candidate provenance.')
  }
  const measurement = JSON.parse(await readFile(input.p1aReceipt, 'utf8'))
  if (
    measurement?.schemaVersion !== 'dascowork-primary-runtime-p1a-build-unpack-measurement.v1' ||
    measurement.target !== input.target ||
    measurement.archiveSha256 !== archiveSha256 ||
    !positiveInteger(measurement.unpackedBytes)
  ) {
    throw new Error('P3b normal-chat feed requires a P1a receipt bound to the archive.')
  }

  const host = '127.0.0.1'
  const port = await reserveLoopbackPort(host)
  const origin = `https://${host}:${port}`
  const configKey = generateFeedKey()
  const manifestKey = generateFeedKey()
  const now = Date.now()
  const issuedAt = new Date(now).toISOString()
  const expiresAt = new Date(now + 60 * 60 * 1000).toISOString()
  const budget = calibrationFeedBudget(archive.size, measurement.unpackedBytes)
  const manifest = signFeedMetadata(
    {
      schemaVersion: 1,
      sequence: 1,
      channel,
      issuedAt,
      expiresAt,
      keyId: 'p3b-calibration-manifest-v1',
      releases: [
        {
          platform: input.target.split('-')[0],
          arch: input.target.split('-')[1],
          version: input.version,
          archiveFormat: 'zip',
          archiveUrl: `${origin}/v1/runtime/archives/${input.version}/${input.target}/primary-runtime.zip`,
          archiveSizeBytes: archive.size,
          archiveSha256,
          budget
        }
      ]
    },
    manifestKey.privateKey
  )
  const config = signFeedMetadata(
    {
      schemaVersion: 1,
      sequence: 1,
      channel,
      manifestUrl: `${origin}/v1/runtime/channels/${channel}/manifest.json`,
      pollIntervalMs: 30_000,
      issuedAt,
      expiresAt,
      keyId: 'p3b-calibration-config-v1'
    },
    configKey.privateKey
  )
  const repositoryRoot = join(root, 'repository')
  const stagedRoot = join(repositoryRoot, 'staged')
  const archiveRoot = join(stagedRoot, 'archives', input.version, input.target)
  await writeJson(join(stagedRoot, 'config.json'), config)
  await writeJson(join(stagedRoot, 'channels', channel, 'manifest.json'), manifest)
  await mkdir(archiveRoot, { recursive: true })
  await copyFile(input.archive, join(archiveRoot, 'primary-runtime.zip'))
  await copyFile(input.provenance, join(archiveRoot, 'provenance.json'))
  const tls = await createLocalTls(root)
  return {
    archiveSha256,
    host,
    port,
    repositoryRoot,
    stagedRoot,
    tls,
    configPublicKeys: JSON.stringify({ 'p3b-calibration-config-v1': configKey.publicKey }),
    manifestPublicKeys: JSON.stringify({ 'p3b-calibration-manifest-v1': manifestKey.publicKey })
  }
}

function calibrationFeedBudget(archiveBytes, unpackedBytes) {
  const maxArchiveBytes = archiveBytes
  const maxUnpackedBytes = unpackedBytes
  return {
    maxArchiveBytes,
    maxUnpackedBytes,
    minimumFreeDiskBytes: Math.ceil((maxArchiveBytes + 2 * maxUnpackedBytes) * 1.15),
    maxColdInstallMs: 86_400_000,
    maxMainEventLoopDelayP99Ms: 60_000,
    maxMainEventLoopDelayMaxMs: 60_000
  }
}

async function writeReceipt(path, fixture) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schemaVersion: 'dascowork-primary-runtime-normal-chat-smoke.v1',
        target: options.target,
        candidateArchiveSha256: fixture.archiveSha256,
        normalChatPassed: true
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}

function parseOptions(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!flag.startsWith('--')) throw new Error(`Unknown argument: ${flag}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${flag}.`)
    values.set(flag, value)
    index += 1
  }
  const required = (name) => {
    const value = values.get(name)
    if (!value) throw new Error(`Expected ${name}.`)
    return value
  }
  const target = required('--target')
  if (target !== `${process.platform}-${process.arch}`) {
    throw new Error(`P3b normal-chat feed target ${target} must run on its native runner.`)
  }
  const sha256 = required('--sha256').toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error('P3b normal-chat feed SHA256 is invalid.')
  return {
    target,
    archive: resolve(required('--archive')),
    version: required('--version'),
    sha256,
    provenance: resolve(required('--provenance')),
    p1aReceipt: resolve(required('--p1a-receipt')),
    output: resolve(required('--output'))
  }
}

function generateFeedKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }
}

async function assertFeedReachable(configuration, ca) {
  const url = `https://${configuration.host}:${configuration.port}/v1/runtime/config.json`
  const body = await new Promise((resolveBody, reject) => {
    const request = httpsRequest(url, { ca, rejectUnauthorized: true }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`P3b normal-chat feed probe returned HTTP ${response.statusCode ?? 0}.`))
          return
        }
        resolveBody(Buffer.concat(chunks).toString('utf8'))
      })
    })
    request.setTimeout(5_000, () =>
      request.destroy(new Error('P3b normal-chat feed probe timed out.'))
    )
    request.once('error', reject)
    request.end()
  })
  if (JSON.parse(body).channel !== channel)
    throw new Error('P3b normal-chat feed returned the wrong channel.')
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
    '/CN=dascowork-p3b-feed-test-ca',
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
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
