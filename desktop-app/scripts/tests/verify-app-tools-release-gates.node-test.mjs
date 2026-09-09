import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  loadAppToolsReleaseGates,
  verifyAppToolsReleaseGates
} from '../verify-app-tools-release-gates.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const specPath = join(appRoot, 'tests/app-tools-release-gates.json')
const commit = 'a'.repeat(40)
const assetSha256 = 'b'.repeat(64)
const now = Date.parse('2026-09-07T00:00:00.000Z')

test('release-gate specification has immutable coverage definitions', async () => {
  const gates = await loadAppToolsReleaseGates(specPath)
  assert.equal(gates.length, 15)
  assert.equal(gates.find((gate) => gate.id === 'AT-E2E-01').assetBound, false)
  assert.equal(gates.find((gate) => gate.id === 'AT-SIGN-MAC-01').assetBound, true)
})

test('verifies an evidence report only when it binds to the requested commit and source report', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeEvidence(directory, {
      gateId: 'AT-E2E-01',
      producer: 'real-app-server-e2e',
      commit,
      capturedAt: new Date(now).toISOString()
    })
    const result = await verifyAppToolsReleaseGates({
      specPath,
      evidenceDirectory: directory,
      commit,
      ids: ['AT-E2E-01'],
      now
    })
    assert.deepEqual(result.verified.map((entry) => entry.id), ['AT-E2E-01'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects missing evidence, mutable coverage claims, commit mismatch, asset mismatch, duplicate evidence, and expired evidence', async () => {
  const directory = await fixtureDirectory()
  try {
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-E2E-01'],
        now
      }),
      /Missing evidence/u
    )

    await writeEvidence(directory, {
      filename: 'first.json',
      gateId: 'AT-PKG-MAC-01',
      producer: 'packaged-macos',
      commit: 'c'.repeat(40),
      assetSha256,
      capturedAt: new Date(now).toISOString()
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        assetSha256,
        ids: ['AT-PKG-MAC-01'],
        now
      }),
      /different commit/u
    )

    await rm(join(directory, 'first.json'))
    await writeEvidence(directory, {
      filename: 'first.json',
      gateId: 'AT-PKG-MAC-01',
      producer: 'packaged-macos',
      commit,
      assetSha256: 'd'.repeat(64),
      capturedAt: new Date(now).toISOString()
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        assetSha256,
        ids: ['AT-PKG-MAC-01'],
        now
      }),
      /does not bind/u
    )

    await rm(join(directory, 'first.json'))
    await writeEvidence(directory, {
      filename: 'first.json',
      gateId: 'AT-E2E-01',
      producer: 'real-app-server-e2e',
      commit,
      capturedAt: new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString()
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-E2E-01'],
        now
      }),
      /expired/u
    )

    await rm(join(directory, 'first.json'))
    await writeEvidence(directory, {
      filename: 'first.json',
      gateId: 'AT-E2E-01',
      producer: 'real-app-server-e2e',
      commit,
      capturedAt: new Date(now).toISOString(),
      extra: { covered: true }
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-E2E-01'],
        now
      }),
      /Invalid/u
    )

    await rm(join(directory, 'first.json'))
    await writeEvidence(directory, {
      filename: 'first.json',
      gateId: 'AT-E2E-01',
      producer: 'real-app-server-e2e',
      commit,
      capturedAt: new Date(now).toISOString()
    })
    await writeEvidence(directory, {
      filename: 'second.json',
      gateId: 'AT-E2E-01',
      producer: 'real-app-server-e2e',
      commit,
      capturedAt: new Date(now).toISOString()
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-E2E-01'],
        now
      }),
      /Duplicate evidence/u
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), 'app-tools-release-gates-'))
}

async function writeEvidence(
  directory,
  { filename = 'evidence.json', gateId, producer, commit, assetSha256, capturedAt, extra = {} }
) {
  const reportDirectory = join(directory, 'reports')
  const reportPath = join(reportDirectory, `${filename}.txt`)
  const report = `${gateId}:${producer}:${commit}\n`
  await mkdir(reportDirectory, { recursive: true })
  await writeFile(reportPath, report)
  const relativeReport = join('reports', `${filename}.txt`)
  await writeFile(
    join(directory, filename),
    `${JSON.stringify({
      schemaVersion: 'dascowork-app-tools-evidence.v1',
      gateId,
      producer,
      commit,
      capturedAt,
      ...(assetSha256 ? { assetSha256 } : {}),
      report: {
        path: relativeReport,
        sha256: createHash('sha256').update(report).digest('hex')
      },
      ...extra
    })}\n`
  )
}
