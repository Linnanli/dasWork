#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runtime validation keeps this executable producer compact. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  canonicalJson,
  canonicalSignedPayload
} from '../../services/primary-runtime-feed/src/repository.mjs'

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const repositoryRoot = resolve(scriptDirectory, '../..')
const defaultSourceLock = resolve(repositoryRoot, 'primary-runtime/runtime-sources.lock.json')
const defaultToolchainsLock = resolve(
  repositoryRoot,
  'primary-runtime/runtime-toolchains.lock.json'
)
const defaultHardLimits = resolve(repositoryRoot, 'primary-runtime/runtime-hard-limits.json')
const evidenceSchema = 'dascowork-app-tools-evidence.v1'
const liveTraceSchema = 'dascowork-primary-runtime-r07-live-trace.v1'

export async function writeAppToolsReleaseEvidence(options) {
  const input = normalizeOptions(options)
  const [
    liveTrace,
    provenance,
    runtimeManifest,
    runtimeBudgets,
    sourceLockBytes,
    toolchainsLockBytes,
    hardLimitsBytes,
    archiveSha256,
    runtimeManifestSha256,
    budgetSha256,
    performanceReportSha256,
    configMetadata,
    manifestMetadata
  ] = await Promise.all([
    readJson(input.liveReport),
    readJson(join(input.targetRoot, 'provenance.json')),
    readJson(join(input.targetRoot, 'runtime.json')),
    readJson(join(input.targetRoot, 'runtime-budgets.json')),
    readFile(input.sourceLock),
    readFile(input.toolchainsLock),
    readFile(input.hardLimits),
    sha256File(join(input.targetRoot, 'primary-runtime.zip')),
    sha256File(join(input.targetRoot, 'runtime.json')),
    sha256File(join(input.targetRoot, 'runtime-budgets.json')),
    sha256File(join(input.targetRoot, 'performance-report.json')),
    readJson(join(input.feedRoot, 'config.json')),
    readJson(join(input.feedRoot, 'channels', input.channel, 'manifest.json'))
  ])
  const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'))
  const sourceLockSha256 = createHash('sha256').update(sourceLockBytes).digest('hex')
  const toolchainsLockSha256 = createHash('sha256').update(toolchainsLockBytes).digest('hex')
  const hardLimitsSha256 = createHash('sha256').update(hardLimitsBytes).digest('hex')
  assertLiveTrace(liveTrace)
  assertRuntimeInputs({
    provenance,
    runtimeManifest,
    runtimeBudgets,
    sourceLock,
    sourceLockSha256,
    toolchainsLockSha256,
    hardLimitsSha256,
    archiveSha256,
    runtimeManifestSha256,
    budgetSha256,
    performanceReportSha256,
    manifest: manifestMetadata,
    target: input.target,
    liveTrace
  })

  const config = signedMetadataBinding(configMetadata, 'config')
  const manifest = signedMetadataBinding(manifestMetadata, 'manifest')
  const assetSha256 = input.assetSha256
  const reportRelativePath = `reports/${input.gateId.toLowerCase()}-${basename(input.liveReport)}`
  const reportPath = join(input.outputDir, reportRelativePath)
  await mkdir(dirname(reportPath), { recursive: true })
  const liveReportBytes = await readFile(input.liveReport)
  await writeFile(reportPath, liveReportBytes, { mode: 0o600 })

  const evidence = {
    schemaVersion: evidenceSchema,
    gateId: input.gateId,
    producer: input.producer,
    commit: input.commit,
    capturedAt: liveTrace.capturedAt,
    ...(assetSha256 ? { assetSha256 } : {}),
    runtime: {
      bundleSha256: provenance.archiveSha256,
      config,
      manifest,
      target: input.target,
      plugin: {
        commit: sourceLock.candidate.commit,
        sourceArchiveSha256: sourceLock.candidate.sourceArchive.sha256,
        patchSha256: sourceLock.candidate.patch.sha256
      },
      budget: {
        fileSha256: budgetSha256,
        performanceReportSha256
      },
      activation: {
        operationId: liveTrace.activation.operationId,
        activeVersion: liveTrace.activation.activeVersion,
        manifestSequence: liveTrace.activation.manifestSequence
      },
      live: {
        threadId: liveTrace.threadId,
        turnId: liveTrace.turnId,
        loader: liveTrace.loader,
        command: liveTrace.command,
        artifact: liveTrace.artifact,
        preview: liveTrace.preview,
        renderReportSha256: liveTrace.renderReportSha256
      }
    },
    report: {
      path: reportRelativePath,
      sha256: createHash('sha256').update(liveReportBytes).digest('hex')
    }
  }

  await mkdir(input.outputDir, { recursive: true })
  const evidencePath = join(input.outputDir, `${input.gateId.toLowerCase()}.json`)
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return { evidencePath, evidence }
}

function normalizeOptions(options) {
  const required = [
    'gateId',
    'producer',
    'commit',
    'target',
    'targetRoot',
    'feedRoot',
    'channel',
    'liveReport',
    'outputDir'
  ]
  for (const key of required) {
    if (typeof options?.[key] !== 'string' || options[key].trim() === '') {
      throw new Error(`Missing required App Tools evidence option: ${key}`)
    }
  }
  if (!/^[a-f0-9]{40,64}$/u.test(options.commit)) {
    throw new Error('App Tools evidence commit must be a full hexadecimal revision.')
  }
  if (!/^AT-[A-Z0-9-]+$/u.test(options.gateId)) {
    throw new Error('App Tools evidence gateId is invalid.')
  }
  if (!/^(darwin|win32|linux)-(x64|arm64)$/u.test(options.target)) {
    throw new Error('App Tools evidence target is invalid.')
  }
  const assetSha256 = options.assetSha256?.toLowerCase()
  if (options.gateId === 'AT-LIVE-PKG-01' && !isSha256(assetSha256)) {
    throw new Error('Packaged App Tools evidence requires an independent assetSha256.')
  }
  if (options.gateId !== 'AT-LIVE-PKG-01' && assetSha256 !== undefined) {
    throw new Error('Only packaged App Tools evidence may bind an assetSha256.')
  }
  return {
    gateId: options.gateId,
    producer: options.producer,
    commit: options.commit,
    target: options.target,
    targetRoot: resolve(options.targetRoot),
    feedRoot: resolve(options.feedRoot),
    channel: options.channel,
    liveReport: resolve(options.liveReport),
    outputDir: resolve(options.outputDir),
    sourceLock: resolve(options.sourceLock ?? defaultSourceLock),
    toolchainsLock: resolve(options.toolchainsLock ?? defaultToolchainsLock),
    hardLimits: resolve(options.hardLimits ?? defaultHardLimits),
    assetSha256
  }
}

function assertLiveTrace(value) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== liveTraceSchema ||
    typeof value.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    typeof value.threadId !== 'string' ||
    value.threadId.length === 0 ||
    typeof value.turnId !== 'string' ||
    value.turnId.length === 0 ||
    !isEventBinding(value.loader, 'loaderCallId', 'outputSha256') ||
    !isEventBinding(value.command, 'commandItemId', 'outputSha256') ||
    !isEventBinding(value.artifact, 'artifactSourceId', 'presentationSha256') ||
    !Number.isSafeInteger(value.artifact.generation) ||
    value.artifact.generation <= 0 ||
    !isEventBinding(value.preview, 'receiptId', 'presentationSha256') ||
    value.loader.sequence >= value.command.sequence ||
    value.command.sequence >= value.artifact.sequence ||
    value.artifact.sequence >= value.preview.sequence ||
    value.artifact.presentationSha256 !== value.preview.presentationSha256 ||
    value.preview.visible !== true ||
    !isRenderReport(value.renderReport) ||
    !isSha256(value.renderReportSha256) ||
    value.renderReportSha256 !== sha256Text(JSON.stringify(value.renderReport)) ||
    !isRecord(value.activation) ||
    typeof value.activation.operationId !== 'string' ||
    value.activation.operationId.length === 0 ||
    typeof value.activation.activeVersion !== 'string' ||
    value.activation.activeVersion.length === 0 ||
    !isRecord(value.skill) ||
    typeof value.skill.localPath !== 'string' ||
    !value.skill.localPath.endsWith(
      '/skills/dascowork-primary-runtime/presentation-skill/SKILL.md'
    ) ||
    !isSha256(value.skill.instructionsSha256)
  ) {
    throw new Error('Invalid R07 live trace report for App Tools release evidence.')
  }
}

function isRenderReport(value) {
  return (
    isRecord(value) &&
    value.schemaVersion === 'dascowork-r07-render-qa.v1' &&
    Array.isArray(value.slides) &&
    value.slides.length === 6 &&
    value.slides.every(
      (slide, index) =>
        isRecord(slide) &&
        slide.file === `slide-${index + 1}.png` &&
        typeof slide.width === 'number' &&
        slide.width >= 900 &&
        typeof slide.height === 'number' &&
        slide.height >= 500 &&
        typeof slide.nonWhiteRatio === 'number' &&
        slide.nonWhiteRatio > 0.01 &&
        typeof slide.colorBucketCount === 'number' &&
        slide.colorBucketCount > 12
    )
  )
}

function isEventBinding(value, idKey, hashKey) {
  return (
    isRecord(value) &&
    typeof value[idKey] === 'string' &&
    value[idKey].length > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    isSha256(value[hashKey])
  )
}

function assertRuntimeInputs({
  provenance,
  runtimeManifest,
  runtimeBudgets,
  sourceLock,
  sourceLockSha256,
  toolchainsLockSha256,
  hardLimitsSha256,
  archiveSha256,
  runtimeManifestSha256,
  budgetSha256,
  performanceReportSha256,
  manifest,
  target,
  liveTrace
}) {
  const [platform, arch] = target.split('-')
  const selectedRelease = Array.isArray(manifest?.releases)
    ? manifest.releases.find((release) => release?.platform === platform && release?.arch === arch)
    : undefined
  const selectedBudget = runtimeBudgets?.targets?.[target]
  if (
    !isRecord(provenance) ||
    provenance.schemaVersion !== 'dascowork-primary-runtime-provenance.v1' ||
    provenance.target !== target ||
    provenance.archiveSha256 !== archiveSha256 ||
    provenance.reviewedBudgetSha256 !== budgetSha256 ||
    provenance.performanceReportSha256 !== performanceReportSha256 ||
    provenance.runtimeManifestSha256 !== runtimeManifestSha256 ||
    provenance.sourceLockSha256 !== sourceLockSha256 ||
    provenance.toolchainsLockSha256 !== toolchainsLockSha256 ||
    provenance.hardLimitsSha256 !== hardLimitsSha256 ||
    provenance.patchSha256 !== sourceLock?.candidate?.patch?.sha256 ||
    !isRecord(runtimeManifest) ||
    runtimeManifest.bundleVersion !== liveTrace.activation.activeVersion ||
    !isRecord(runtimeBudgets) ||
    runtimeBudgets.schemaVersion !== 'dascowork-primary-runtime-budgets.v1' ||
    !isRecord(runtimeBudgets.evidence) ||
    runtimeBudgets.evidence.reviewed !== true ||
    runtimeBudgets.evidence.sourceLockSha256 !== sourceLockSha256 ||
    runtimeBudgets.evidence.toolchainsLockSha256 !== toolchainsLockSha256 ||
    runtimeBudgets.evidence.hardLimitsSha256 !== hardLimitsSha256 ||
    runtimeManifest.bundleVersion !== provenance.bundleVersion ||
    !isRecord(selectedRelease) ||
    selectedRelease.version !== liveTrace.activation.activeVersion ||
    selectedRelease.archiveSha256 !== provenance.archiveSha256 ||
    liveTrace.activation.manifestSequence !== manifest.sequence ||
    !isRecord(selectedBudget) ||
    !isRecord(selectedRelease.budget) ||
    canonicalJson(selectedRelease.budget) !== canonicalJson(selectedBudget) ||
    sourceLock?.candidate?.commit === undefined ||
    !/^[a-f0-9]{40,64}$/u.test(sourceLock.candidate.commit) ||
    !isSha256(sourceLock.candidate.sourceArchive?.sha256) ||
    !isSha256(sourceLock.candidate.patch?.sha256)
  ) {
    throw new Error('Runtime target evidence does not bind to the R07 live trace.')
  }
}

function signedMetadataBinding(metadata, label) {
  if (
    !isRecord(metadata) ||
    !Number.isSafeInteger(metadata.sequence) ||
    metadata.sequence <= 0 ||
    typeof metadata.keyId !== 'string' ||
    metadata.keyId.length === 0
  ) {
    throw new Error(`Signed Runtime metadata is invalid: ${label}`)
  }
  return {
    sequence: metadata.sequence,
    payloadHash: createHash('sha256').update(canonicalSignedPayload(metadata)).digest('hex'),
    keyId: metadata.keyId
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`)
    }
    values.set(key.slice(2), value)
    index += 1
  }
  return Object.fromEntries(values)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await writeAppToolsReleaseEvidence(parseArguments(process.argv.slice(2)))
  console.log(JSON.stringify({ ok: true, evidencePath: result.evidencePath }))
}
