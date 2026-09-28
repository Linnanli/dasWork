#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Native integration launcher validates its inputs before spawning Vitest. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const options = parseOptions(process.argv.slice(2))
const target = `${process.platform}-${process.arch}`
if (options.target !== target) throw new Error('Runtime migration must run on its native target.')
for (const version of ['v2', 'v3']) {
  const archive = options[`${version}-archive`]
  const receipt = JSON.parse(await readFile(options[`${version}-provenance`], 'utf8'))
  await access(archive)
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk)
    bytes += chunk.length
  }
  const sha256 = hash.digest('hex')
  if (
    receipt.schemaVersion !== 'dascowork-primary-runtime-provenance.v1' ||
    receipt.target !== target ||
    receipt.bundleVersion !== options[`${version}-version`] ||
    receipt.archiveSha256 !== sha256 ||
    receipt.archiveSizeBytes !== bytes ||
    !/^[a-f0-9]{64}$/u.test(options[`${version}-sha256`]) ||
    options[`${version}-sha256`] !== sha256
  )
    throw new Error(`${version} migration archive must match its original verified provenance.`)
}

const root = await mkdtemp(join(tmpdir(), 'primary-runtime-migration-tls-'))
try {
  const cert = join(root, 'cert.pem')
  const key = join(root, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE'
    ],
    { stdio: 'ignore' }
  )
  await mkdir(resolve(options.output, '..'), { recursive: true })
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'src/main/primaryRuntime/PrimaryRuntimeMigrationReal.test.ts'
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        DASCOWORK_PRIMARY_RUNTIME_MIGRATION: '1',
        DASCOWORK_PRIMARY_RUNTIME_MIGRATION_OPTIONS: JSON.stringify(options),
        DASCOWORK_PRIMARY_RUNTIME_MIGRATION_CERT: cert,
        DASCOWORK_PRIMARY_RUNTIME_MIGRATION_KEY: key
      },
      stdio: 'inherit'
    }
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(root, { recursive: true, force: true })
}

function parseOptions(argv) {
  const names = [
    'target',
    'v2-archive',
    'v2-version',
    'v2-sha256',
    'v2-provenance',
    'v3-archive',
    'v3-version',
    'v3-sha256',
    'v3-provenance',
    'output'
  ]
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/u, '')
    const value = argv[i + 1]
    if (
      (!names.includes(name) && name !== 'retain-cache') ||
      !value ||
      value.startsWith('--') ||
      options[name]
    ) {
      throw new Error(
        'Expected unique --target, --v2/v3-archive/version/sha256/provenance and --output.'
      )
    }
    options[name] =
      name.endsWith('archive') || name.endsWith('provenance') || name === 'output'
        ? resolve(value)
        : value
  }
  if (names.some((name) => !options[name])) {
    throw new Error('Expected --target, --v2/v3-archive/version/sha256/provenance and --output.')
  }
  if (options['retain-cache'] && options['retain-cache'] !== '1')
    throw new Error('--retain-cache must be 1 when requested.')
  return options
}
