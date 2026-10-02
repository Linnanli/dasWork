import assert from 'node:assert/strict'
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node test fixtures use inferred JavaScript returns. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { measurementFingerprint } from '../../../primary-runtime/scripts/runtime-budgets.mjs'

const executeFile = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const packageJsonPath = resolve(repositoryRoot, 'desktop-app/package.json')
const runnerPath = resolve(
  repositoryRoot,
  'desktop-app/scripts/run-primary-runtime-performance.mjs'
)
const performanceTestPath = resolve(
  repositoryRoot,
  'desktop-app/src/main/primaryRuntime/PrimaryRuntimePerformance.test.ts'
)

test('primary runtime performance runner is registered and fail-closed', async () => {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  assert.equal(
    packageJson.scripts['test:primary-runtime:performance'],
    'node scripts/run-primary-runtime-performance.mjs'
  )
  await assert.rejects(
    () => executeFile(process.execPath, [runnerPath], { cwd: repositoryRoot }),
    /Expected --target/u
  )
})

test('ten-install calibration has a collection timeout without weakening Runtime budgets', async () => {
  const performanceTestSource = await readFile(performanceTestPath, 'utf8')
  assert.match(performanceTestSource, /const performanceTestTimeoutMs = 3_600_000/u)
  assert.match(performanceTestSource, /afterEach\(async \(\) => \{[\s\S]*?\}, performanceTestTimeoutMs\)/u)
  assert.match(performanceTestSource, /\}, performanceTestTimeoutMs\)/u)
})

test('P3b performance runner consumes Electron Main overlap evidence instead of direct Vitest installs', async () => {
  const runnerSource = await readFile(runnerPath, 'utf8')
  assert.doesNotMatch(runnerSource, /PrimaryRuntimePerformance\.test\.ts/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_NORMAL_CHAT_PASSED/u)
  assert.match(runnerSource, /dascowork-primary-runtime-main-overlap-performance\.v1/u)
  assert.match(runnerSource, /electron-main/u)
  assert.match(runnerSource, /completedDuringInstall/u)
  assert.match(runnerSource, /diskProbe/u)
  assert.match(runnerSource, /minimumAvailableDiskBytes/u)
})

test('primary runtime performance runner verifies an external measurement report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-performance-'))
  const measurementsPath = join(directory, 'measurements.json')
  const budgetPath = join(directory, 'runtime-budgets.json')
  try {
    const report = await measurements()
    await writeFile(measurementsPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(budgetPath, `${JSON.stringify(budget(report), null, 2)}\n`)
    const { stdout } = await executeFile(process.execPath, [
      runnerPath,
      '--measurements',
      measurementsPath,
      '--budget',
      budgetPath
    ])
    assert.match(stdout, /budgets verified/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function measurements() {
  const sample = {
    archiveBytes: [1000, 1000, 1000, 1000, 1000],
    unpackedBytes: [2000, 2000, 2000, 2000, 2000],
    coldInstallMs: [1000, 950, 900, 850, 800, 750, 700, 650, 600, 550],
    mainEventLoopDelayP99Ms: [20, 19, 18, 17, 16, 15, 14, 13, 12, 11],
    mainEventLoopDelayMaxMs: [100, 95, 90, 85, 80, 75, 70, 65, 60, 55],
    minimumAvailableDiskBytes: [
      12_000_000, 11_990_000, 11_980_000, 11_970_000, 11_960_000, 11_950_000,
      11_940_000, 11_930_000, 11_920_000, 11_910_000
    ],
    chatInstallOverlapMs: [500, 490, 480, 470, 460, 450, 440, 430, 420, 410]
  }
  return {
    schemaVersion: 'dascowork-primary-runtime-budget-measurements.v1',
    evidence: {
      sourceRunId: '123456',
      sourceCommit: 'a'.repeat(40),
      installerCommit: 'b'.repeat(40),
      ...(await currentCheckoutEvidence())
    },
    targets: {
      'darwin-x64': sampleFor('a'),
      'darwin-arm64': sampleFor('b'),
      'win32-x64': sampleFor('c'),
      'linux-x64': sampleFor('d')
    }
  }

  function sampleFor(character) {
    return {
      ...sample,
      runner: `${character}-runner`,
      candidateArchiveSha256: character.repeat(64),
      p1aBuildUnpackReceiptSha256: 'f'.repeat(64)
    }
  }
}

async function currentCheckoutEvidence() {
  return {
    hardLimitsSha256: await sha256File(resolve(repositoryRoot, 'primary-runtime/runtime-hard-limits.json')),
    sourceLockSha256: await sha256File(resolve(repositoryRoot, 'primary-runtime/runtime-sources.lock.json')),
    toolchainsLockSha256: await sha256File(
      resolve(repositoryRoot, 'primary-runtime/runtime-toolchains.lock.json')
    )
  }
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function budget(report) {
  return {
    schemaVersion: 'dascowork-primary-runtime-budgets.v1',
    evidence: {
      reviewed: true,
      ...report.evidence,
      measurementsFingerprint: measurementFingerprint(report),
      candidateArchiveSha256: Object.fromEntries(
        Object.entries(report.targets).map(([target, value]) => [
          target,
          value.candidateArchiveSha256
        ])
      )
    },
    targets: Object.fromEntries(
      Object.keys(report.targets).map((target) => [
        target,
        {
          maxArchiveBytes: 2_000_000,
          maxUnpackedBytes: 4_000_000,
          minimumFreeDiskBytes: 11_500_000,
          maxColdInstallMs: 2_000,
          maxMainEventLoopDelayP99Ms: 50,
          maxMainEventLoopDelayMaxMs: 200
        }
      ])
    )
  }
}
