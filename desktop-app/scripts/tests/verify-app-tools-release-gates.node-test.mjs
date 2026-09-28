/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node test fixtures are validated through their assertions. */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { createCanvas, loadImage } from '@napi-rs/canvas'

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

test('requires an ordered, SHA-bound live trace for each live OfficeCLI gate', async () => {
  const directory = await fixtureDirectory()
  try {
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-office-runtime-dev',
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
    const mismatchedAssetNameRuntime = runtimeBinding(true)
    mismatchedAssetNameRuntime.officecli.nativeAssetName = 'officecli-linux-x64'
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-office-runtime-dev',
      commit,
      capturedAt: new Date(now).toISOString(),
      extra: { runtime: mismatchedAssetNameRuntime }
    })
    await assert.rejects(
      verifyAppToolsReleaseGates({
        specPath,
        evidenceDirectory: directory,
        commit,
        ids: ['AT-LIVE-01'],
        now
      }),
      /Invalid Runtime binding/u
    )
    await rm(join(directory, 'evidence.json'))
    const invalidLiveRuntime = runtimeBinding(true)
    await writeEvidence(directory, {
      gateId: 'AT-LIVE-01',
      producer: 'live-office-runtime-dev',
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
      producer: 'live-office-runtime-dev',
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
      producer: 'live-office-runtime-dev',
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

test('produces verifier-consumable AT-E2E evidence from a canonical R07 trace fixture', async () => {
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
      producer: 'live-office-runtime-packaged',
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
    assert.deepEqual(packagedEvidence.runtime.officecli, {
      candidateName: 'iOfficeAI/OfficeCLI',
      tag: 'v1.0.152',
      commit: 'ffa8a0a',
      sourceLockSha256: sha256Text(fixture.sourceLockText),
      nativeAssetName: 'officecli-linux-x64',
      nativeAssetSha256: '2'.repeat(64)
    })
    await assert.rejects(
      writeAppToolsReleaseEvidence({
        gateId: 'AT-LIVE-PKG-01',
        producer: 'live-office-runtime-packaged',
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
    const nonOfficeCliLock = structuredClone(fixture.sourceLockObject)
    nonOfficeCliLock.candidate.name = 'example/other-cli'
    await rebindSourceLockFixture(fixture, nonOfficeCliLock)
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
    const duplicateOfficeCliAssetLock = structuredClone(fixture.sourceLockObject)
    duplicateOfficeCliAssetLock.components.native.push({
      ...duplicateOfficeCliAssetLock.components.native[0],
      sha256: '6'.repeat(64)
    })
    await rebindSourceLockFixture(fixture, duplicateOfficeCliAssetLock)
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
    const mismatchedOfficeCliVersionLock = structuredClone(fixture.sourceLockObject)
    mismatchedOfficeCliVersionLock.components.native[0].version = '1.0.153'
    await rebindSourceLockFixture(fixture, mismatchedOfficeCliVersionLock)
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
    await rebindSourceLockFixture(fixture, fixture.sourceLockObject)
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
    const missingSlideHashReport = join(directory, 'missing-slide-hash-report.json')
    const missingSlideHashRenderReport = {
      ...fixture.liveTrace.renderReport,
      slides: fixture.liveTrace.renderReport.slides.map((slide, index) => {
        if (index !== 0) return slide
        const withoutHash = { ...slide }
        delete withoutHash.sha256
        return withoutHash
      })
    }
    await writeFile(
      missingSlideHashReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        renderReport: missingSlideHashRenderReport,
        renderReportSha256: sha256Text(JSON.stringify(missingSlideHashRenderReport))
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
        liveReport: missingSlideHashReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*renderReport/u
    )
    const mismatchedSlideSourceReport = join(directory, 'mismatched-slide-source-report.json')
    const mismatchedSlideSourceRenderReport = {
      ...fixture.liveTrace.renderReport,
      slides: fixture.liveTrace.renderReport.slides.map((slide, index) =>
        index === 0
          ? {
              ...slide,
              source: {
                ...slide.source,
                artifactSourceId: 'different-artifact'
              }
            }
          : slide
      )
    }
    await writeFile(
      mismatchedSlideSourceReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        renderReport: mismatchedSlideSourceRenderReport,
        renderReportSha256: sha256Text(JSON.stringify(mismatchedSlideSourceRenderReport))
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
        liveReport: mismatchedSlideSourceReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*renderReport/u
    )
    const firstSlidePath = join(fixture.visualArtifactDirectory, 'slides', 'slide-01.png')
    const visualReceiptPath = join(
      fixture.visualArtifactDirectory,
      'r07-preview-render-receipt.json'
    )
    const [originalFirstSlide, originalVisualReceipt] = await Promise.all([
      readFile(firstSlidePath),
      readFile(visualReceiptPath)
    ])
    const corruptPngReport = join(directory, 'corrupt-png-report.json')
    const corruptPngBytes = Buffer.from('not a png')
    const corruptPngRenderReport = replaceFirstSlide(fixture.liveTrace.renderReport, {
      sha256: createHash('sha256').update(corruptPngBytes).digest('hex')
    })
    await writeFile(firstSlidePath, corruptPngBytes)
    await writeVisualArtifactReceipt(
      fixture.visualArtifactDirectory,
      fixture.liveTrace,
      corruptPngRenderReport
    )
    await writeFile(
      corruptPngReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        renderReport: corruptPngRenderReport,
        renderReportSha256: sha256Text(JSON.stringify(corruptPngRenderReport))
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
        liveReport: corruptPngReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*visualArtifacts\.slide-01\.png/u
    )
    const whitePngReport = join(directory, 'white-png-report.json')
    const whitePngBytes = renderWhiteSlidePng()
    const whitePngRenderReport = replaceFirstSlide(fixture.liveTrace.renderReport, {
      sha256: createHash('sha256').update(whitePngBytes).digest('hex')
    })
    await writeFile(firstSlidePath, whitePngBytes)
    await writeVisualArtifactReceipt(
      fixture.visualArtifactDirectory,
      fixture.liveTrace,
      whitePngRenderReport
    )
    await writeFile(
      whitePngReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        renderReport: whitePngRenderReport,
        renderReportSha256: sha256Text(JSON.stringify(whitePngRenderReport))
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
        liveReport: whitePngReport,
        outputDir: fixture.outputDir,
        sourceLock: fixture.sourceLock,
        toolchainsLock: fixture.toolchainsLock,
        hardLimits: fixture.hardLimits
      }),
      /Invalid R07 live trace report.*visualArtifacts\.slide-01\.png\.metrics/u
    )
    await Promise.all([
      writeFile(firstSlidePath, originalFirstSlide),
      writeFile(visualReceiptPath, originalVisualReceipt)
    ])
    const unpaddedSlideReport = join(directory, 'unpadded-slide-report.json')
    const unpaddedRenderReport = {
      ...fixture.liveTrace.renderReport,
      slides: fixture.liveTrace.renderReport.slides.map((slide, index) =>
        index === 0 ? { ...slide, file: 'slide-1.png' } : slide
      )
    }
    await writeFile(
      unpaddedSlideReport,
      `${JSON.stringify({
        ...fixture.liveTrace,
        renderReport: unpaddedRenderReport,
        renderReportSha256: sha256Text(JSON.stringify(unpaddedRenderReport))
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
        liveReport: unpaddedSlideReport,
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
    await writeFile(fixture.sourceLock, fixture.sourceLockText)
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
    officecli: {
      candidateName: 'iOfficeAI/OfficeCLI',
      tag: 'v1.0.152',
      commit: 'ffa8a0a',
      sourceLockSha256: '1'.repeat(64),
      nativeAssetName: 'officecli-darwin-arm64',
      nativeAssetSha256: '2'.repeat(64)
    },
    budget: {
      fileSha256: '3'.repeat(64),
      performanceReportSha256: '4'.repeat(64)
    },
    activation: {
      operationId: 'activate-1',
      activeVersion: '2026.9.27-officecli',
      manifestSequence: 2
    },
    ...(includeLive
      ? {
          live: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            skill: {
              id: '/tmp/skills/dascowork-primary-runtime/officecli/SKILL.md',
              name: 'officecli',
              localPath: '/tmp/skills/dascowork-primary-runtime/officecli/SKILL.md',
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
  const visualArtifactDirectory = join(directory, 'r07-visual-artifacts')
  const activeVersion = '2026.9.21-r07'
  const archiveText = 'runtime archive\n'
  const runtimeText = `${JSON.stringify({ bundleVersion: activeVersion })}\n`
  const performanceText = '{"ok":"performance"}\n'
  const sourceLockCandidate = {
    name: 'iOfficeAI/OfficeCLI',
    repository: 'https://github.com/iOfficeAI/OfficeCLI',
    publisher: {
      githubAccount: 'iOfficeAI',
      releaseActor: 'github-actions'
    },
    tag: 'v1.0.152',
    commit: 'ffa8a0a',
    license: {
      spdx: 'Apache-2.0',
      path: 'LICENSE'
    },
    runtimeScope: {
      entryPoints: ['officecli'],
      capabilities: ['pptx-read-write'],
      excludedCapabilities: ['direct-model-http']
    }
  }
  const sourceLockObject = {
    schemaVersion: 'dascowork-primary-runtime-sources.v2',
    builderVersion: '1.3.0',
    candidate: sourceLockCandidate,
    rejectedCandidates: [],
    components: {
      node: [],
      python: [],
      native: [
        {
          name: 'officecli-linux-x64',
          capability: 'officecli',
          version: '1.0.152',
          source:
            'https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.152/officecli-linux-x64',
          sha256: '2'.repeat(64),
          license: 'Apache-2.0',
          platforms: [target]
        }
      ],
      fonts: [
        {
          name: 'test-font',
          version: '1.0.0',
          source: 'https://example.test/font.zip',
          sha256: '9'.repeat(64),
          license: 'OFL-1.1',
          platforms: [target]
        }
      ]
    }
  }
  const sourceLockText = `${JSON.stringify(sourceLockObject)}\n`
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
  const presentationSha256 = '8'.repeat(64)
  const previewSource = {
    kind: 'electron-host-preview',
    artifactSourceId: 'artifact-1',
    receiptId: 'workspace-preview:artifact-1:1',
    generation: 1,
    presentationSha256
  }
  const renderReport = await writeR07VisualArtifactFixture(visualArtifactDirectory, previewSource)
  const liveTrace = {
    schemaVersion: 'dascowork-primary-runtime-r07-live-trace.v2',
    capturedAt: new Date(now).toISOString(),
    threadId: 'thread-1',
    turnId: 'turn-1',
    skill: {
      id: '/tmp/skills/dascowork-primary-runtime/officecli/SKILL.md',
      name: 'officecli',
      localPath: '/tmp/skills/dascowork-primary-runtime/officecli/SKILL.md',
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
      presentationSha256
    },
    preview: {
      receiptId: 'workspace-preview:artifact-1:1',
      ...evidenceObservation(4),
      visible: true,
      presentationSha256
    },
    renderReport,
    renderReportSha256: sha256Text(JSON.stringify(renderReport)),
    visualArtifacts: {
      directory: visualArtifactDirectory
    }
  }
  await writeFile(
    join(visualArtifactDirectory, 'r07-preview-render-receipt.json'),
    `${JSON.stringify({
      schemaVersion: 'dascowork-r07-visual-artifacts.v1',
      previewTrace: {
        sourceId: previewSource.artifactSourceId,
        receiptId: previewSource.receiptId,
        generation: previewSource.generation,
        checksum: previewSource.presentationSha256
      },
      renderReport
    })}\n`
  )
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
        hardLimitsSha256: sha256Text(hardLimitsText)
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
    sourceLockObject,
    sourceLockText,
    sourceLockCandidate,
    budgetText,
    liveReport,
    liveTrace,
    visualArtifactDirectory
  }
}

async function writeR07VisualArtifactFixture(directory, previewSource) {
  const slidesRoot = join(directory, 'slides')
  await mkdir(slidesRoot, { recursive: true })
  const slides = []
  for (const number of ['01', '02', '03', '04', '05', '06']) {
    const png = renderFixtureSlidePng(Number(number))
    const file = `slide-${number}.png`
    await writeFile(join(slidesRoot, file), png)
    slides.push({
      file,
      ...(await measureFixtureSlide(png)),
      sha256: createHash('sha256').update(png).digest('hex'),
      source: previewSource
    })
  }
  return {
    schemaVersion: 'dascowork-r07-render-qa.v1',
    slides
  }
}

function renderFixtureSlidePng(index) {
  const canvas = createCanvas(960, 540)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 960, 540)
  for (let offset = 0; offset < 24; offset += 1) {
    context.fillStyle = `rgb(${(index * 31 + offset * 17) % 255}, ${(index * 47 + offset * 29) % 255}, ${(index * 61 + offset * 37) % 255})`
    context.fillRect(32 + offset * 36, 48 + (offset % 4) * 84, 28, 64)
  }
  context.fillStyle = '#111111'
  context.font = '32px sans-serif'
  context.fillText(`R07 ${index}`, 64, 480)
  return canvas.toBuffer('image/png')
}

function renderWhiteSlidePng() {
  const canvas = createCanvas(960, 540)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 960, 540)
  return canvas.toBuffer('image/png')
}

function replaceFirstSlide(renderReport, patch) {
  return {
    ...renderReport,
    slides: renderReport.slides.map((slide, index) =>
      index === 0
        ? {
            ...slide,
            ...patch
          }
        : slide
    )
  }
}

async function writeVisualArtifactReceipt(directory, liveTrace, renderReport) {
  await writeFile(
    join(directory, 'r07-preview-render-receipt.json'),
    `${JSON.stringify({
      schemaVersion: 'dascowork-r07-visual-artifacts.v1',
      previewTrace: {
        sourceId: liveTrace.artifact.artifactSourceId,
        receiptId: liveTrace.preview.receiptId,
        generation: liveTrace.artifact.generation,
        checksum: liveTrace.artifact.presentationSha256
      },
      renderReport
    })}\n`
  )
}

async function measureFixtureSlide(bytes) {
  const image = await loadImage(bytes)
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, image.width, image.height)
  const buckets = new Set()
  let nonWhite = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    if (red < 245 || green < 245 || blue < 245) nonWhite += 1
    buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`)
  }
  return {
    width: image.width,
    height: image.height,
    nonWhiteRatio: nonWhite / (image.width * image.height),
    colorBucketCount: buckets.size
  }
}

async function rebindSourceLockFixture(fixture, sourceLockObject) {
  const sourceLockText = `${JSON.stringify(sourceLockObject)}\n`
  const sourceLockSha256 = sha256Text(sourceLockText)
  const budget = JSON.parse(fixture.budgetText)
  budget.evidence.sourceLockSha256 = sourceLockSha256
  const budgetText = `${JSON.stringify(budget)}\n`
  const provenancePath = join(fixture.targetRoot, 'provenance.json')
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'))
  provenance.sourceLockSha256 = sourceLockSha256
  provenance.reviewedBudgetSha256 = sha256Text(budgetText)
  await Promise.all([
    writeFile(fixture.sourceLock, sourceLockText),
    writeFile(join(fixture.targetRoot, 'runtime-budgets.json'), budgetText),
    writeFile(provenancePath, `${JSON.stringify(provenance)}\n`)
  ])
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
