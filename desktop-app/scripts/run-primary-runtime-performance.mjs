#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Small process launcher uses inferred JavaScript returns. */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const options = parseOptions(process.argv.slice(2), process.env)

if (options.mode === 'verify') {
  await access(options.reportPath)
  await run(process.execPath, [
    resolve(repositoryRoot, 'primary-runtime/scripts/verify-runtime-budgets.mjs'),
    '--budget',
    options.budgetPath,
    '--measurements',
    options.reportPath
  ])
  process.exit(0)
}

await runCalibration(options)

async function runCalibration(input) {
  const target = nativeTarget()
  if (input.target !== target) {
    throw new Error(
      `P3b performance target ${input.target} must run on its native ${target} runner.`
    )
  }
  await access(input.archive)
  const archive = await stat(input.archive)
  const archiveSha256 = await sha256File(input.archive)
  if (archiveSha256 !== input.sha256) {
    throw new Error('P3b performance archive digest does not match --sha256.')
  }
  const measurements = await readP1aMeasurements(input.p1aMeasurementDirectory, input.target)
  const selectedReceipt = await readP1aReceipt(input.p1aReceipt, input.target)
  if (
    selectedReceipt.archiveSha256 !== archiveSha256 ||
    selectedReceipt.archiveBytes !== archive.size
  ) {
    throw new Error('P3b performance archive is not bound to the selected P1a measurement receipt.')
  }
  const installSamples = await readMainOverlapReceipt(
    input.mainOverlapReceipt,
    input.target,
    archiveSha256
  )
  const evidence = {
    sourceRunId: input.sourceRunId,
    sourceCommit: input.sourceCommit,
    installerCommit: input.installerCommit,
    hardLimitsSha256: await sha256File(
      resolve(repositoryRoot, 'primary-runtime/runtime-hard-limits.json')
    ),
    sourceLockSha256: await sha256File(
      resolve(repositoryRoot, 'primary-runtime/runtime-sources.lock.json')
    ),
    toolchainsLockSha256: await sha256File(
      resolve(repositoryRoot, 'primary-runtime/runtime-toolchains.lock.json')
    ),
    runner: input.runner
  }
  await mkdir(dirname(input.output), { recursive: true })
  await writeFile(
    input.output,
    `${JSON.stringify(
      {
        schemaVersion: 'dascowork-primary-runtime-performance-target.v1',
        target: input.target,
        evidence,
        runner: evidence.runner,
        candidateArchiveSha256: archiveSha256,
        p1aBuildUnpackReceiptSha256: (await sha256File(input.p1aReceipt)).toLowerCase(),
        archiveBytes: measurements.map((measurement) => measurement.archiveBytes),
        unpackedBytes: measurements.map((measurement) => measurement.unpackedBytes),
        minimumAvailableDiskBytes: installSamples.map((sample) => sample.minimumAvailableDiskBytes),
        coldInstallMs: installSamples.map((sample) => sample.coldInstallMs),
        mainEventLoopDelayP99Ms: installSamples.map((sample) => sample.mainEventLoopDelayP99Ms),
        mainEventLoopDelayMaxMs: installSamples.map((sample) => sample.mainEventLoopDelayMaxMs),
        chatInstallOverlapMs: installSamples.map((sample) => sample.chatInstallOverlapMs)
      },
      null,
      2
    )}\n`
  )
}

async function readP1aMeasurements(directory, target) {
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = entries
    .filter((entry) => entry.isFile() && /^build-unpack-[1-5]\.json$/u.test(entry.name))
    .map((entry) => resolve(directory, entry.name))
    .sort()
  if (paths.length !== 5) {
    throw new Error('P3b performance requires exactly five P1a build/unpack receipts.')
  }
  return Promise.all(paths.map((path) => readP1aReceipt(path, target)))
}

async function readP1aReceipt(path, target) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (
    value?.schemaVersion !== 'dascowork-primary-runtime-p1a-build-unpack-measurement.v1' ||
    value.target !== target ||
    !isSha256(value.archiveSha256) ||
    !positiveInteger(value.archiveBytes) ||
    !positiveInteger(value.unpackedBytes)
  ) {
    throw new Error(`P3b performance found an invalid P1a measurement receipt: ${path}`)
  }
  return {
    archiveSha256: value.archiveSha256,
    archiveBytes: value.archiveBytes,
    unpackedBytes: value.unpackedBytes
  }
}

async function readMainOverlapReceipt(path, target, archiveSha256) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (
    value?.schemaVersion !== 'dascowork-primary-runtime-main-overlap-performance.v1' ||
    value.target !== target ||
    value.candidateArchiveSha256 !== archiveSha256 ||
    !Array.isArray(value.installAttempts) ||
    value.installAttempts.length !== 10
  ) {
    throw new Error('P3b performance requires ten real Electron Main overlap samples.')
  }
  return value.installAttempts.map((sample, index) => {
    if (
      sample?.sampleIndex !== index + 1 ||
      sample.mainEventLoop?.source !== 'electron-main' ||
      sample.diskProbe?.source !== 'electron-main' ||
      sample.diskProbe.minimumAvailableDiskBytes !== sample.minimumAvailableDiskBytes ||
      !positiveInteger(sample.diskProbe.sampleCount) ||
      sample.diskProbe.sampleCount < 2 ||
      !positiveInteger(sample.coldInstallMs) ||
      !positiveInteger(sample.minimumAvailableDiskBytes) ||
      !positiveInteger(sample.chatInstallOverlapMs) ||
      !positiveInteger(sample.mainEventLoop.p99Ms) ||
      !positiveInteger(sample.mainEventLoop.maxMs) ||
      sample.normalChat?.passed !== true ||
      !positiveInteger(sample.normalChat.responseMs) ||
      sample.normalChat.completedDuringInstall !== true
    ) {
      throw new Error(`P3b performance sample ${index + 1} is not bound to Main overlap evidence.`)
    }
    return {
      coldInstallMs: sample.coldInstallMs,
      minimumAvailableDiskBytes: sample.minimumAvailableDiskBytes,
      chatInstallOverlapMs: sample.chatInstallOverlapMs,
      mainEventLoopDelayP99Ms: sample.mainEventLoop.p99Ms,
      mainEventLoopDelayMaxMs: sample.mainEventLoop.maxMs
    }
  })
}

function parseOptions(argv, env) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) throw new Error(`Unknown argument: ${item}`)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Expected a value after ${item}.`)
    values.set(item, next)
    index += 1
  }
  const reportPath =
    values.get('--measurements') ?? env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_REPORT
  const budgetPath = values.get('--budget') ?? env.DASCOWORK_PRIMARY_RUNTIME_REVIEWED_BUDGET
  if (reportPath || budgetPath) {
    if (!reportPath || !budgetPath || values.size !== 2) {
      throw new Error(
        'Expected exactly --measurements <path> and --budget <reviewed-runtime-budgets.json>.'
      )
    }
    return { mode: 'verify', reportPath: resolve(reportPath), budgetPath: resolve(budgetPath) }
  }
  const required = (name) => {
    const value = values.get(name)
    if (!value) throw new Error(`Expected ${name}.`)
    return value
  }
  const target = required('--target')
  if (!/^(?:darwin|win32|linux)-(?:x64|arm64)$/u.test(target)) {
    throw new Error('P3b performance target is invalid.')
  }
  const sha256 = required('--sha256').toLowerCase()
  if (!isSha256(sha256)) throw new Error('P3b performance archive SHA256 is invalid.')
  for (const commit of ['--source-commit', '--installer-commit']) {
    if (!/^[a-f0-9]{40,64}$/iu.test(required(commit))) {
      throw new Error(`P3b performance ${commit} must be an immutable commit digest.`)
    }
  }
  if (!/^[1-9][0-9]*$/u.test(required('--source-run-id'))) {
    throw new Error('P3b performance source run ID is invalid.')
  }
  return {
    mode: 'calibrate',
    target,
    archive: resolve(required('--archive')),
    version: required('--version'),
    sha256,
    p1aReceipt: resolve(required('--p1a-receipt')),
    p1aMeasurementDirectory: resolve(required('--p1a-measurement-directory')),
    mainOverlapReceipt: resolve(required('--main-overlap-receipt')),
    sourceRunId: required('--source-run-id'),
    sourceCommit: required('--source-commit').toLowerCase(),
    installerCommit: required('--installer-commit').toLowerCase(),
    runner: required('--runner'),
    output: resolve(required('--output'))
  }
}

function nativeTarget() {
  const platform = process.platform
  const arch = process.arch
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`P3b performance cannot run on unsupported host ${platform}-${arch}.`)
  }
  return `${platform}-${arch}`
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      ...options
    })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(
          new Error(`Primary Runtime performance runner failed with ${signal ?? `exit ${code}`}.`)
        )
      }
    })
  })
}
