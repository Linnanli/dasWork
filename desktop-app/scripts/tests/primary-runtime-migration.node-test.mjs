/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node integration test uses JavaScript callbacks. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { createPrimaryRuntimeLocalTls } from '../lib/primary-runtime-local-tls.mjs'

const executeFile = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const launcher = join(root, 'desktop-app/scripts/run-primary-runtime-migration.mjs')

test('native migration HTTPS fixture trusts a separate CA and rejects default trust', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'runtime-migration-tls-'))
  let server
  try {
    const tls = await createPrimaryRuntimeLocalTls(temp)
    const ca = await readFile(tls.caPath)
    const cert = await readFile(tls.certPath)
    assert.equal(new X509Certificate(ca).ca, true)
    assert.equal(new X509Certificate(cert).ca, false)
    assert.notEqual(new X509Certificate(cert).issuer, new X509Certificate(cert).subject)
    server = createServer({ key: await readFile(tls.keyPath), cert }, (_request, response) => {
      response.end('verified local fixture')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = `https://127.0.0.1:${server.address().port}`
    const request = (options) =>
      new Promise((resolveResponse, reject) => {
        get(url, { ...options, rejectUnauthorized: true }, (response) => {
          let body = ''
          response.on('data', (chunk) => (body += chunk))
          response.on('end', () => resolveResponse(body))
          response.on('error', reject)
        }).on('error', reject)
      })
    assert.equal(await request({ ca }), 'verified local fixture')
    await assert.rejects(request({}), /certificate|issuer/u)
  } finally {
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose()))
      )
    }
    await rm(temp, { recursive: true, force: true })
  }
})

test('migration launcher fails closed for missing or cross-target archive identities', async () => {
  await assert.rejects(
    executeFile(process.execPath, [launcher], { cwd: root }),
    /Expected --target/u
  )
  const args = [
    '--target',
    'invalid-target',
    ...['v2', 'v3'].flatMap((version) => [
      `--${version}-archive`,
      '/missing.zip',
      `--${version}-version`,
      version,
      `--${version}-sha256`,
      '0'.repeat(64),
      `--${version}-provenance`,
      '/missing.json'
    ]),
    '--output',
    '/missing/report.json'
  ]
  await assert.rejects(
    executeFile(process.execPath, [launcher, ...args], { cwd: root }),
    /native target/u
  )
})

test('migration launcher rejects archive bytes that differ from the recorded provenance', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'runtime-migration-contract-'))
  try {
    const archive = join(temp, 'archive.zip')
    const provenance = join(temp, 'provenance.json')
    const target = `${process.platform}-${process.arch}`
    await writeFile(archive, 'changed archive')
    await writeFile(
      provenance,
      JSON.stringify({
        schemaVersion: 'dascowork-primary-runtime-provenance.v1',
        target,
        bundleVersion: 'old',
        archiveSizeBytes: 15,
        archiveSha256: '0'.repeat(64)
      })
    )
    const args = [
      '--target',
      target,
      ...['v2', 'v3'].flatMap((version) => [
        `--${version}-archive`,
        archive,
        `--${version}-version`,
        'old',
        `--${version}-sha256`,
        '0'.repeat(64),
        `--${version}-provenance`,
        provenance
      ]),
      '--output',
      join(temp, 'report.json')
    ]
    await assert.rejects(
      executeFile(process.execPath, [launcher, ...args], { cwd: root }),
      /original verified provenance/u
    )
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('four-target CI retains real migration receipts and PNG visual artifacts', async () => {
  const workflow = await readFile(join(root, '.github/workflows/primary-runtime-build.yml'), 'utf8')
  const baseline = JSON.parse(
    await readFile(join(root, 'primary-runtime/fixtures/legacy-v2-baseline.json'), 'utf8')
  )
  assert.equal(baseline.sourceRunId, '35977341257')
  assert.equal(Object.keys(baseline.targets).length, 4)
  for (const value of Object.values(baseline.targets))
    assert.match(value.archiveSha256, /^[a-f0-9]{64}$/u)
  assert.ok(
    workflow.indexOf('Download the immutable legacy v2 target artifact') <
      workflow.indexOf('Verify native v2 and v3 switching')
  )
  assert.match(workflow, /npm --prefix desktop-app run test:primary-runtime:migration/u)
  assert.match(workflow, /cp "\$target_root\/migration-matrix\.json" "\$staging_root\/"/u)
  assert.match(workflow, /DASCOWORK_R07_VISUAL_ARTIFACT_DIRECTORY/u)
  const capture = workflow.indexOf('P3b collect Main overlap performance and dev R07')
  const comparison = workflow.indexOf('Compare six real legacy and OfficeCLI preview PNGs')
  const staging = workflow.indexOf('Stage declared P1a calibration evidence')
  assert.ok(capture >= 0 && capture < comparison && comparison < staging)
  assert.match(
    workflow,
    /npm --prefix desktop-app run test:e2e:primary-runtime-preview-comparison/u
  )
})
