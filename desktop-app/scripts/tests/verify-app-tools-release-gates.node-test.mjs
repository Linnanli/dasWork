/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node test fixtures are validated through their assertions. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  loadAppToolsReleaseGates,
  verifyAppToolsReleaseGates
} from '../verify-app-tools-release-gates.mjs'
import { writeAppToolsReleaseEvidence } from '../write-app-tools-release-evidence.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const specPath = join(appRoot, 'tests/app-tools-release-gates.json')
const commit = 'a'.repeat(40)
const assetSha256 = 'b'.repeat(64)
const packagedAssetSha256 = '9'.repeat(64)
const now = Date.parse('2026-09-07T00:00:00.000Z')

test('release-gate specification has immutable coverage definitions', async () => {
  const gates = await loadAppToolsReleaseGates(specPath)
  assert.equal(gates.length, 19)
  assert.equal(gates.find((gate) => gate.id === 'AT-E2E-01').assetBound, false)
  assert.equal(gates.find((gate) => gate.id === 'AT-E2E-01').runtimeBound, true)
  assert.equal(gates.find((gate) => gate.id === 'AT-SIGN-MAC-01').assetBound, true)
})

test('verifies an evidence report only when it binds to the requested commit and source report', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeEvidence(directory, {
      gateId: 'AT-E2E-01',
      producer: 'primary-runtime-feed-e2e',
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
    assert.deepEqual(
      result.verified.map((entry) => entry.id),
      ['AT-E2E-01']
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires an ordered, SHA-bound live trace for each live presentation-skill gate', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-presentation-skill-dev',
      commit,
      capturedAt: new Date(now).toISOString()
    })
    await verifyAppToolsReleaseGates({
      specPath,
      evidenceDirectory: directory,
      commit,
      ids: ['AT-LIVE-01'],
      now
    })

    await rm(join(directory, 'evidence.json'))
    const invalidLiveRuntime = runtimeBinding(true)
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-presentation-skill-dev',
      commit,
      capturedAt: new Date(now).toISOString(),
      extra: { runtime: { ...runtimeBinding(), live: { loader: {} } } }
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-LIVE-01'],
        now
      }),
      /Invalid live Runtime trace/u
    )
    await rm(join(directory, 'evidence.json'))
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-presentation-skill-dev',
      commit,
      capturedAt: new Date(now).toISOString(),
      extra: {
        runtime: {
          ...invalidLiveRuntime,
          live: {
            ...invalidLiveRuntime.live,
            artifact: { ...invalidLiveRuntime.live.artifact, generation: 0 },
            preview: { ...invalidLiveRuntime.live.preview, visible: false }
          }
        }
      }
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-LIVE-01'],
        now
      }),
      /Invalid live Runtime trace/u
    )
    await rm(join(directory, 'evidence.json'))
    const outOfOrderRuntime = runtimeBinding(true)
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-presentation-skill-dev',
      commit,
      capturedAt: new Date(now).toISOString(),
      extra: {
        runtime: {
          ...outOfOrderRuntime,
          live: {
            ...outOfOrderRuntime.live,
            preview: {
              ...outOfOrderRuntime.live.preview,
              monotonicNs: outOfOrderRuntime.live.artifact.monotonicNs
            }
          }
        }
      }
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-LIVE-01'],
        now
      }),
      /Invalid live Runtime trace/u
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('produces verifier-consumable AT-E2E evidence from a real R07 live trace report', async () => {
  const directory = await fixtureDirectory()
  try {
    const fixture = await writeAppToolsProducerFixture(directory)
    assert.equal(fixture.feedRoot, join(fixture.feedRepositoryRoot, 'current'))
    const { evidencePath } = await writeAppToolsReleaseEvidence({
      gateId: 'AT-E2E-01',
      producer: 'primary-runtime-feed-e2e',
      commit,
      target: fixture.target,
      targetRoot: fixture.targetRoot,
      feedRoot: fixture.feedRoot,
      channel: 'engineering',
      liveReport: fixture.liveReport,
      outputDir: fixture.outputDir,
      sourceLock: fixture.sourceLock,
      toolchainsLock: fixture.toolchainsLock,
      hardLimits: fixture.hardLimits
    })
    assert.equal(evidencePath, join(fixture.outputDir, 'at-e2e-01.json'))
    const result = await verifyAppToolsReleaseGates({
      specPath,
      evidenceDirectory: fixture.outputDir,
      commit,
      ids: ['AT-E2E-01'],
      now
    })
    assert.deepEqual(
      result.verified.map((entry) => entry.id),
      ['AT-E2E-01']
    )

    const packagedResult = await writeAppToolsReleaseEvidence({
      gateId: 'AT-LIVE-PKG-01',
      producer: 'live-presentation-skill-packaged',
      commit,
      target: fixture.target,
      targetRoot: fixture.targetRoot,
      feedRoot: fixture.feedRoot,
      channel: 'engineering',
      liveReport: fixture.liveReport,
      outputDir: fixture.outputDir,
      sourceLock: fixture.sourceLock,
      toolchainsLock: fixture.toolchainsLock,
      hardLimits: fixture.hardLimits,
      assetSha256: packagedAssetSha256
    })
    const packagedEvidence = JSON.parse(await readFile(packagedResult.evidencePath, 'utf8'))
    assert.equal(packagedEvidence.assetSha256, packagedAssetSha256)
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-LIVE-PKG-01',
        producer: 'live-presentation-skill-packaged',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: fixture.liveReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits,
        assetSha256: undefined
      }),
      /independent assetSha256/u
    )
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: fixture.outputDir,
        commit,
        ids: ['AT-LIVE-PKG-01'],
        now
      }),
      /Asset-bound/u
    )
    await verifyAppToolsReleaseGates({
      specPath,
      evidenceDirectory: fixture.outputDir,
      commit,
      assetSha256: packagedAssetSha256,
      ids: ['AT-LIVE-PKG-01'],
      now
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: fixture.outputDir,
        commit,
        assetSha256: '0'.repeat(64),
        ids: ['AT-LIVE-PKG-01'],
        now
      }),
      /does not bind to the release asset set/u
    )

    const badLiveReport = join(directory, 'bad-live-report.json')
    await writeFile(
      badLiveReport,
      `${JSON.stringify({ ...fixture.liveTrace, skill: { localPath: '/tmp/SKILL.md' } })}\n`
    )
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: badLiveReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*skill\.localPath/u
    )
    const badPreviewReport = join(directory, 'bad-preview-report.json')
    await writeFile(
      badPreviewReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        preview: { ...fixture.liveTrace.preview, visible: false }
      })}\n`
    )
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: badPreviewReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*preview\.visible/u
    )
    const badGenerationReport = join(directory, 'bad-generation-report.json')
    await writeFile(
      badGenerationReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        artifact: { ...fixture.liveTrace.artifact, generation: 0 }
      })}\n`
    )
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: badGenerationReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*artifact\.generation/u
    )
    const badRenderReport = join(directory, 'bad-render-report.json')
    await writeFile(
      badRenderReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        renderReport: {
          ...fixture.liveTrace.renderReport,
          slides: fixture.liveTrace.renderReport.slides.map((slide, index) =>
            index === 0 ? { ...slide, nonWhiteRatio: 0 } : slide
          )
        }
      })}\n`
    )
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: badRenderReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*renderReport/u
    )
    const badManifestSequenceReport = join(directory, 'bad-manifest-sequence-report.json')
    await writeFile(
      badManifestSequenceReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        activation: { ...fixture.liveTrace.activation, manifestSequence: 2 }
      })}\n`
    )
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: badManifestSequenceReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Runtime target evidence does not bind/u
    )
    const manifestPath = join(fixture.feedRoot, 'channels', 'engineering', 'manifest.json')
    const manifestText = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestText)
    manifest.releases[0].budget.maxColdInstallMs += 1
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: fixture.liveReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Runtime target evidence does not bind/u
    )
    await writeFile(manifestPath, manifestText)
    await writeFile(join(fixture.targetRoot, 'runtime-budgets.json'), '{"tampered":true}\n')
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: fixture.liveReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Runtime target evidence does not bind/u
    )
    await writeFile(join(fixture.targetRoot, 'runtime-budgets.json'), fixture.budgetText)
    await writeFile(
      fixture.sourceLock,
      `${JSON.stringify({ candidate: fixture.sourceLockCandidate })}\n`
    )
    const staleBudget = JSON.parse(fixture.budgetText)
    staleBudget.evidence.sourceLockSha256 = '0'.repeat(64)
    await writeFile(
      join(fixture.targetRoot, 'runtime-budgets.json'),
      `${JSON.stringify(staleBudget)}\n`
    )
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-E2E-01',
        producer: 'primary-runtime-feed-e2e',
        commit,
        target: fixture.target,
        targetRoot: fixture.targetRoot,
        feedRoot: fixture.feedRoot,
        channel: 'engineering',
        liveReport: fixture.liveReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Runtime target evidence does not bind/u
    )
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
      producer: 'primary-runtime-feed-e2e',
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
      producer: 'primary-runtime-feed-e2e',
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
      producer: 'primary-runtime-feed-e2e',
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
      ...(runtimeBoundGateIds.has(gateId)
        ? {
            runtime: runtimeBinding(
              gateId === 'AT-E2E-01' || gateId === 'AT-LIVE-01' || gateId === 'AT-LIVE-PKG-01'
            )
          }
        : {}),
      report: {
        path: relativeReport,
        sha256: createHash('sha256').update(report).digest('hex')
      },
      ...extra
    })}\n`
  )
}

const runtimeBoundGateIds = new Set([
  'AT-E2E-01',
  'AT-RT-PROVENANCE-01',
  'AT-RT-BUILD-01',
  'AT-FEED-01',
  'AT-RT-UPDATE-01',
  'AT-SKILL-CAP-01',
  'AT-PKG-MAC-01',
  'AT-PKG-WIN-01',
  'AT-PKG-LINUX-01',
  'AT-LIVE-01',
  'AT-LIVE-PKG-01'
])

function runtimeBinding(includeLive = false) {
  const presentationSha256 = 'a'.repeat(64)
  return {
    bundleSha256: 'e'.repeat(64),
    config: { sequence: 1, payloadHash: 'f'.repeat(64), keyId: 'config-test' },
    manifest: { sequence: 2, payloadHash: 'c'.repeat(64), keyId: 'manifest-test' },
    target: 'darwin-arm64',
    plugin: {
      commit: 'a'.repeat(40),
      sourceArchiveSha256: '1'.repeat(64),
      patchSha256: '2'.repeat(64)
    },
    budget: {
      fileSha256: '3'.repeat(64),
      performanceReportSha256: '4'.repeat(64)
    },
    activation: {
      operationId: 'activate-1',
      activeVersion: '2026.9.12-presentation-skill',
      manifestSequence: 2
    },
    ...(includeLive
      ? {
          live: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            skill: {
              id: '/tmp/skills/dascowork-primary-runtime/presentation-skill/SKILL.md',
              name: 'presentation-skill',
              localPath: '/tmp/skills/dascowork-primary-runtime/presentation-skill/SKILL.md',
              instructionsSha256: '5'.repeat(64)
            },
            modelEvidence: deterministicModelEvidence(),
            loader: {
              loaderCallId: 'loader-1',
              appServerLogIndex: 10,
              ...evidenceObservation(1),
              outputSha256: 'b'.repeat(64)
            },
            command: {
              commandItemId: 'command-1',
              appServerLogIndex: 20,
              ...evidenceObservation(2),
              outputSha256: 'c'.repeat(64)
            },
            artifact: {
              artifactSourceId: 'artifact-1',
              ...evidenceObservation(3),
              generation: 1,
              presentationSha256
            },
            preview: {
              receiptId: 'preview-1',
              ...evidenceObservation(4),
              visible: true,
              presentationSha256
            },
            renderReportSha256: 'd'.repeat(64)
          }
        }
      : {})
  }
}

async function writeAppToolsProducerFixture(directory) {
  const target = 'linux-x64'
  const targetRoot = join(directory, 'target')
  const feedRepositoryRoot = join(directory, 'feed-repository')
  const feedRoot = join(feedRepositoryRoot, 'current')
  const outputDir = join(directory, 'evidence')
  const sourceLock = join(directory, 'runtime-sources.lock.json')
  const toolchainsLock = join(directory, 'runtime-toolchains.lock.json')
  const hardLimits = join(directory, 'runtime-hard-limits.json')
  const liveReport = join(directory, 'r07-live-trace.json')
  const activeVersion = '2026.9.21-r07'
  const archiveText = 'runtime archive\n'
  const runtimeText = `${JSON.stringify({ bundleVersion: activeVersion })}\n`
  const performanceText = '{"ok":"performance"}\n'
  const sourceLockCandidate = {
    commit: 'a'.repeat(40),
    sourceArchive: { sha256: '1'.repeat(64) },
    patch: { sha256: '2'.repeat(64) }
  }
  const sourceLockText = `${JSON.stringify({
    candidate: sourceLockCandidate
  })}\n`
  const toolchainsLockText = '{"toolchains":"locked"}\n'
  const hardLimitsText = '{"limits":"locked"}\n'
  const targetBudget = {
    maxArchiveBytes: 1024,
    maxUnpackedBytes: 4096,
    minimumFreeDiskBytes: 9216,
    maxColdInstallMs: 30000,
    maxMainEventLoopDelayP99Ms: 40,
    maxMainEventLoopDelayMaxMs: 120
  }
  const budgetText = `${JSON.stringify({
    schemaVersion: 'dascowork-primary-runtime-budgets.v1',
    evidence: {
      reviewed: true,
      sourceRunId: '123',
      sourceCommit: 'a'.repeat(40),
      installerCommit: 'a'.repeat(40),
      hardLimitsSha256: sha256Text(hardLimitsText),
      sourceLockSha256: sha256Text(sourceLockText),
      toolchainsLockSha256: sha256Text(toolchainsLockText),
      measurementsFingerprint: '3'.repeat(64),
      candidateArchiveSha256: {
        'darwin-x64': '4'.repeat(64),
        'darwin-arm64': '5'.repeat(64),
        'win32-x64': '6'.repeat(64),
        'linux-x64': sha256Text(archiveText)
      }
    },
    targets: { [target]: targetBudget }
  })}\n`
  const renderReport = {
    schemaVersion: 'dascowork-r07-render-qa.v1',
    slides: Array.from({ length: 6 }, (_, index) => ({
      file: `slide-${index + 1}.png`,
      width: 960,
      height: 540,
      nonWhiteRatio: 0.2,
      colorBucketCount: 24
    }))
  }
  const liveTrace = {
    schemaVersion: 'dascowork-primary-runtime-r07-live-trace.v2',
    capturedAt: new Date(now).toISOString(),
    threadId: 'thread-1',
    turnId: 'turn-1',
    skill: {
      id: '/tmp/skills/dascowork-primary-runtime/presentation-skill/SKILL.md',
      name: 'presentation-skill',
      localPath: '/tmp/skills/dascowork-primary-runtime/presentation-skill/SKILL.md',
      instructionsSha256: '5'.repeat(64)
    },
    modelEvidence: deterministicModelEvidence(),
    activation: {
      operationId: 'operation-1',
      activeVersion,
      manifestSequence: 1
    },
    loader: {
      loaderCallId: 'loader-1',
      appServerLogIndex: 10,
      ...evidenceObservation(1),
      outputSha256: '6'.repeat(64)
    },
    command: {
      commandItemId: 'command-1',
      appServerLogIndex: 20,
      ...evidenceObservation(2),
      outputSha256: '7'.repeat(64)
    },
    artifact: {
      artifactSourceId: 'artifact-1',
      ...evidenceObservation(3),
      generation: 1,
      presentationSha256: '8'.repeat(64)
    },
    preview: {
      receiptId: 'workspace-preview:artifact-1:1',
      ...evidenceObservation(4),
      visible: true,
      presentationSha256: '8'.repeat(64)
    },
    renderReport,
    renderReportSha256: sha256Text(JSON.stringify(renderReport))
  }
  await mkdir(join(feedRoot, 'channels', 'engineering'), { recursive: true })
  await mkdir(targetRoot, { recursive: true })
  await Promise.all([
    writeFile(
      join(targetRoot, 'provenance.json'),
      `${JSON.stringify({
        schemaVersion: 'dascowork-primary-runtime-provenance.v1',
        target,
        bundleVersion: activeVersion,
        archiveSha256: sha256Text(archiveText),
        reviewedBudgetSha256: sha256Text(budgetText),
        performanceReportSha256: sha256Text(performanceText),
        runtimeManifestSha256: sha256Text(runtimeText),
        sourceLockSha256: sha256Text(sourceLockText),
        toolchainsLockSha256: sha256Text(toolchainsLockText),
        hardLimitsSha256: sha256Text(hardLimitsText),
        patchSha256: '2'.repeat(64)
      })}\n`
    ),
    writeFile(join(targetRoot, 'primary-runtime.zip'), archiveText),
    writeFile(join(targetRoot, 'runtime.json'), runtimeText),
    writeFile(join(targetRoot, 'runtime-budgets.json'), budgetText),
    writeFile(join(targetRoot, 'performance-report.json'), performanceText),
    writeFile(
      join(feedRoot, 'config.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sequence: 1,
        channel: 'engineering',
        manifestUrl: 'https://127.0.0.1/v1/runtime/channels/engineering/manifest.json',
        pollIntervalMs: 3600000,
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
        keyId: 'config-test',
        signature: 'test-signature'
      })}\n`
    ),
    writeFile(
      join(feedRoot, 'channels', 'engineering', 'manifest.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sequence: 1,
        channel: 'engineering',
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 1000).toISOString(),
        keyId: 'manifest-test',
        releases: [
          {
            platform: 'linux',
            arch: 'x64',
            version: activeVersion,
            archiveSha256: sha256Text(archiveText),
            budget: targetBudget
          }
        ],
        signature: 'test-signature'
      })}\n`
    ),
    writeFile(sourceLock, sourceLockText),
    writeFile(toolchainsLock, toolchainsLockText),
    writeFile(hardLimits, hardLimitsText),
    writeFile(liveReport, `${JSON.stringify(liveTrace)}\n`)
  ])
  return {
    target,
    targetRoot,
    feedRepositoryRoot,
    feedRoot,
    outputDir,
    sourceLock,
    toolchainsLock,
    hardLimits,
    sourceLockCandidate,
    budgetText,
    liveReport,
    liveTrace
  }
}

function evidenceObservation(index) {
  return {
    observedAt: new Date(now - (5 - index) * 1_000).toISOString(),
    monotonicNs: String(index * 1_000)
  }
}

function deterministicModelEvidence() {
  return {
    kind: 'scripted-external-model',
    proves: 'deterministic-desktop-runtime-command-path',
    doesNotProve: 'live-model-skill-compliance'
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}
