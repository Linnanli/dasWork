#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runtime validation makes JSDoc return annotations redundant in this executable verifier. */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, relative, resolve } from 'node:path'

const scriptDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)))
const appRoot = resolve(scriptDirectory, '..')
const defaultSpecPath = resolve(appRoot, 'tests/app-tools-release-gates.json')
const evidenceSchema = 'dascowork-app-tools-evidence.v1'
const gateSchema = 'dascowork-app-tools-release-gates.v1'
const maxEvidenceAgeMs = 14 * 24 * 60 * 60 * 1000
const tracedRuntimeGateIds = new Set(['AT-E2E-01', 'AT-LIVE-01', 'AT-LIVE-PKG-01'])

export async function loadAppToolsReleaseGates(specPath = defaultSpecPath) {
  const parsed = JSON.parse(await readFile(specPath, 'utf8'))
  if (!isRecord(parsed) || parsed.schemaVersion !== gateSchema || !Array.isArray(parsed.gates)) {
    throw new Error('App Tools release-gate specification has an invalid schema version.')
  }
  const ids = new Set()
  const gates = parsed.gates.map((gate) => {
    if (
      !isRecord(gate) ||
      typeof gate.id !== 'string' ||
      !/^AT-[A-Z0-9-]+$/u.test(gate.id) ||
      ids.has(gate.id) ||
      (gate.layer !== 'engineering' && gate.layer !== 'release') ||
      !Array.isArray(gate.producers) ||
      gate.producers.length === 0 ||
      !gate.producers.every((producer) => typeof producer === 'string' && producer.length > 0) ||
      typeof gate.assetBound !== 'boolean' ||
      typeof gate.runtimeBound !== 'boolean' ||
      'status' in gate ||
      'covered' in gate
    ) {
      throw new Error('App Tools release-gate specification contains an invalid or mutable gate.')
    }
    ids.add(gate.id)
    return Object.freeze({
      id: gate.id,
      layer: gate.layer,
      producers: Object.freeze([...gate.producers]),
      assetBound: gate.assetBound,
      runtimeBound: gate.runtimeBound
    })
  })
  return Object.freeze(gates)
}

export async function verifyAppToolsReleaseGates({
  specPath = defaultSpecPath,
  evidenceDirectory,
  commit,
  assetSha256,
  now = Date.now(),
  ids
} = {}) {
  const gates = await loadAppToolsReleaseGates(specPath)
  const requiredIds = ids ?? gates.map((gate) => gate.id)
  if (!Array.isArray(requiredIds) || requiredIds.length === 0) {
    throw new Error('At least one App Tools release gate must be required.')
  }
  if (!evidenceDirectory || !commit) {
    throw new Error('Evidence directory and commit are required to verify App Tools release gates.')
  }
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new Error('App Tools release-gate commit must be a full hexadecimal revision.')
  }
  const required = new Map(gates.map((gate) => [gate.id, gate]))
  for (const id of requiredIds) {
    if (!required.has(id)) throw new Error(`Unknown App Tools release gate: ${id}`)
  }
  if (new Set(requiredIds).size !== requiredIds.length) {
    throw new Error('Duplicate App Tools release gates were requested.')
  }
  if (requiredIds.some((id) => required.get(id).assetBound) && !isSha256(assetSha256)) {
    throw new Error('Asset-bound App Tools release gates require one release asset-set SHA256.')
  }

  const evidenceRoot = resolve(evidenceDirectory)
  const evidence = await readEvidence(evidenceRoot)
  const evidenceByGate = new Map()
  for (const record of evidence) {
    if (!required.has(record.gateId)) continue
    if (evidenceByGate.has(record.gateId)) {
      throw new Error(`Duplicate evidence for App Tools release gate ${record.gateId}.`)
    }
    evidenceByGate.set(record.gateId, record)
  }

  const verified = []
  for (const id of requiredIds) {
    const gate = required.get(id)
    const record = evidenceByGate.get(id)
    if (!record) throw new Error(`Missing evidence for App Tools release gate ${id}.`)
    if (!gate.producers.includes(record.producer)) {
      throw new Error(`Evidence for ${id} was produced by an unapproved producer.`)
    }
    if (record.commit !== commit) {
      throw new Error(`Evidence for ${id} belongs to a different commit.`)
    }
    if (now - record.capturedAtMs > maxEvidenceAgeMs || record.capturedAtMs > now + 5 * 60 * 1000) {
      throw new Error(`Evidence for ${id} is expired or has an invalid capture time.`)
    }
    if (gate.assetBound && record.assetSha256 !== assetSha256) {
      throw new Error(`Evidence for ${id} does not bind to the release asset set.`)
    }
    if (!gate.assetBound && record.assetSha256 !== undefined) {
      throw new Error(`Engineering evidence for ${id} must not claim a release asset binding.`)
    }
    if (gate.runtimeBound) verifyRuntimeEvidence(record, id)
    if (!gate.runtimeBound && record.runtime !== undefined) {
      throw new Error(`Non-Runtime evidence for ${id} must not include a Runtime binding.`)
    }
    await verifySourceReport(evidenceRoot, record)
    verified.push({
      id,
      producer: record.producer,
      capturedAt: new Date(record.capturedAtMs).toISOString()
    })
  }
  return { schemaVersion: gateSchema, commit, assetSha256, verified }
}

async function readEvidence(evidenceRoot) {
  const entries = await readdir(evidenceRoot, { withFileTypes: true })
  const records = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = joinInside(evidenceRoot, entry.name)
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    records.push(parseEvidenceRecord(parsed, entry.name))
  }
  return records
}

function parseEvidenceRecord(value, filename) {
  if (
    !isRecord(value) ||
    value.schemaVersion !== evidenceSchema ||
    typeof value.gateId !== 'string' ||
    typeof value.producer !== 'string' ||
    typeof value.commit !== 'string' ||
    typeof value.capturedAt !== 'string' ||
    !isRecord(value.report) ||
    typeof value.report.path !== 'string' ||
    typeof value.report.sha256 !== 'string' ||
    !isSha256(value.report.sha256) ||
    (value.assetSha256 !== undefined && !isSha256(value.assetSha256)) ||
    'covered' in value
  ) {
    throw new Error(`Invalid App Tools release-gate evidence: ${filename}`)
  }
  const capturedAtMs = Date.parse(value.capturedAt)
  if (!Number.isFinite(capturedAtMs)) {
    throw new Error(`Evidence capture time is invalid: ${filename}`)
  }
  return {
    gateId: value.gateId,
    producer: value.producer,
    commit: value.commit,
    capturedAtMs,
    ...(value.assetSha256 ? { assetSha256: value.assetSha256 } : {}),
    ...(value.runtime !== undefined
      ? { runtime: parseRuntimeEvidence(value.runtime, filename) }
      : {}),
    report: { path: value.report.path, sha256: value.report.sha256 }
  }
}

function parseRuntimeEvidence(value, filename) {
  if (
    !isRecord(value) ||
    !isSha256(value.bundleSha256) ||
    !isRecord(value.config) ||
    !isRecord(value.manifest) ||
    !isSequenceBinding(value.config) ||
    !isSequenceBinding(value.manifest) ||
    typeof value.target !== 'string' ||
    !/^(darwin|win32|linux)-(x64|arm64)$/u.test(value.target) ||
    !isPluginSourceBinding(value.plugin) ||
    !isBudgetBinding(value.budget) ||
    !isActivationBinding(value.activation)
  ) {
    throw new Error(`Invalid Runtime binding in App Tools release-gate evidence: ${filename}`)
  }
  return {
    bundleSha256: value.bundleSha256,
    config: value.config,
    manifest: value.manifest,
    target: value.target,
    plugin: value.plugin,
    budget: value.budget,
    activation: value.activation,
    ...(value.live !== undefined ? { live: parseLiveEvidence(value.live, filename) } : {})
  }
}

function isSequenceBinding(value) {
  return (
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    isSha256(value.payloadHash) &&
    typeof value.keyId === 'string' &&
    value.keyId.length > 0
  )
}

function isActivationBinding(value) {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    value.operationId.length > 0 &&
    typeof value.activeVersion === 'string' &&
    value.activeVersion.length > 0
  )
}

function isPluginSourceBinding(value) {
  return (
    isRecord(value) &&
    typeof value.commit === 'string' &&
    /^[a-f0-9]{40,64}$/u.test(value.commit) &&
    isSha256(value.sourceArchiveSha256) &&
    isSha256(value.patchSha256)
  )
}

function isBudgetBinding(value) {
  return isRecord(value) && isSha256(value.fileSha256) && isSha256(value.performanceReportSha256)
}

function parseLiveEvidence(value, filename) {
  if (
    !isRecord(value) ||
    typeof value.threadId !== 'string' ||
    value.threadId.length === 0 ||
    typeof value.turnId !== 'string' ||
    value.turnId.length === 0 ||
    !isEventBinding(value.loader, 'loaderCallId') ||
    !isSha256(value.loader.outputSha256) ||
    !isEventBinding(value.command, 'commandItemId') ||
    !isSha256(value.command.outputSha256) ||
    !isEventBinding(value.artifact, 'artifactSourceId') ||
    !isSha256(value.artifact.presentationSha256) ||
    !isEventBinding(value.preview, 'receiptId') ||
    !isSha256(value.preview.presentationSha256) ||
    !isSha256(value.renderReportSha256) ||
    value.loader.sequence >= value.command.sequence ||
    value.command.sequence >= value.artifact.sequence ||
    value.artifact.sequence >= value.preview.sequence ||
    value.artifact.presentationSha256 !== value.preview.presentationSha256
  ) {
    throw new Error(`Invalid live Runtime trace in App Tools release-gate evidence: ${filename}`)
  }
  return value
}

function isEventBinding(value, id) {
  return (
    isRecord(value) &&
    typeof value[id] === 'string' &&
    value[id].length > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0
  )
}

function verifyRuntimeEvidence(record, id) {
  if (!record.runtime)
    throw new Error(`Evidence for ${id} is missing its Runtime bundle and feed binding.`)
  if (tracedRuntimeGateIds.has(id) && !record.runtime.live) {
    throw new Error(`Evidence for ${id} is missing its ordered live Runtime trace.`)
  }
}

async function verifySourceReport(evidenceRoot, record) {
  const path = joinInside(evidenceRoot, record.report.path)
  const details = await stat(path)
  if (!details.isFile())
    throw new Error(`Evidence report is not a regular file: ${record.report.path}`)
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  if (digest !== record.report.sha256) {
    throw new Error(`Evidence report SHA256 does not match: ${record.report.path}`)
  }
}

function joinInside(root, candidate) {
  if (!candidate || isAbsolute(candidate) || candidate.includes('\\')) {
    throw new Error('Evidence report path must be a relative POSIX path.')
  }
  const resolved = resolve(root, candidate)
  if (!isInside(root, resolved))
    throw new Error('Evidence report path escapes its evidence directory.')
  return resolved
}

function isInside(root, candidate) {
  const diff = relative(root, candidate)
  return diff !== '' && !diff.startsWith('..') && !isAbsolute(diff)
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.checkSpec) {
    const gates = await loadAppToolsReleaseGates(options.specPath)
    console.log(
      JSON.stringify({ ok: true, gateCount: gates.length, gates: gates.map((gate) => gate.id) })
    )
    return
  }
  const result = await verifyAppToolsReleaseGates(options)
  console.log(JSON.stringify({ ok: true, ...result }))
}

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check-spec') {
      options.checkSpec = true
      continue
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
    index += 1
    if (argument === '--spec') options.specPath = resolve(value)
    else if (argument === '--evidence-dir') options.evidenceDirectory = resolve(value)
    else if (argument === '--commit') options.commit = value
    else if (argument === '--asset-sha256') options.assetSha256 = value
    else if (argument === '--ids') options.ids = value.split(',').filter(Boolean)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main()
}
