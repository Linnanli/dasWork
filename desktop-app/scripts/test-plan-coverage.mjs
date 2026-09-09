/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  expectedP004EdgeIds,
  expectedP004Ids,
  validateTestPlanCoverage
} from './lib/test-plan-coverage-validator.mjs'
import { flattenPlaywrightReporterSuites } from './lib/test-plan-playwright-reporter.mjs'
import { playwrightEvidenceSelection } from './lib/test-plan-playwright-selection.mjs'
import { vitestEvidenceSelection } from './lib/test-plan-vitest-selection.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, '..')
const runDirectory = await mkdtemp(resolve(tmpdir(), 'dascowork-test-plan-'))
const runId = runDirectory.split('/').at(-1)
const assertionEvidencePath = resolve(runDirectory, 'assertions.ndjson')
const localGitIntegrationTestFiles = new Set([
  'src/main/localGit/GitManager.integration.test.ts',
  'src/main/localGit/LocalBranchService.test.ts',
  'src/main/localGit/LocalCommitService.test.ts',
  'src/main/localGit/LocalPushService.test.ts',
  'src/main/localGit/LocalGitService.integration.test.ts',
  'src/main/localGit/LocalGitService.test.ts',
  'src/main/localGit/reviewSnapshot.test.ts'
])

try {
  const manifest = JSON.parse(
    await readFile(resolve(desktopRoot, 'tests/test-plan-coverage.json'), 'utf8')
  )
  const execution = await executeEvidenceTests(manifest)
  await writeFile(resolve(runDirectory, 'execution.json'), JSON.stringify(execution), 'utf8')
  const validation = await validateTestPlanCoverage({ manifest, desktopRoot, execution })
  console.log(
    `Test-plan coverage: P0-04 ${validation.p004CaseCount}/${expectedP004Ids.length} cases, ${validation.p004EdgeCaseCount}/${expectedP004EdgeIds.length} edge cases; ${validation.scenarioCount} scenarios; ${validation.summary}`
  )
  if (validation.failures.length > 0) {
    for (const failure of validation.failures) console.error(`- ${failure}`)
    process.exitCode = 1
  }
} finally {
  await rm(runDirectory, { recursive: true, force: true })
}

async function executeEvidenceTests(manifest) {
  const coveredEntries = [
    ...(manifest.p004?.edgeCases ?? []).filter((entry) => entry.status === 'covered'),
    ...manifest.scenarios.filter((entry) => entry.status === 'covered'),
    ...manifest.mockE2E.filter((entry) => entry.status === 'covered'),
    ...manifest.releaseE2E.filter((entry) => entry.status === 'covered')
  ]
  const evidence = coveredEntries.flatMap((entry) =>
    entry.evidence.map((item) => ({ ...item, scenarioId: entry.id }))
  )
  const clientTestPrefix = 'vendors/codex-app-server-client/'
  const desktopTests = unique(
    evidence.filter((item) => !item.file.startsWith('vendors/') && !isPlaywrightEvidence(item.file))
  )
  const clientTests = unique(
    evidence
      .filter((item) => item.file.startsWith(clientTestPrefix))
      .map((item) => ({
        ...item,
        file: item.file.slice(clientTestPrefix.length)
      }))
  )
  const unsupportedVendorEvidence = evidence.filter(
    (item) => item.file.startsWith('vendors/') && !item.file.startsWith(clientTestPrefix)
  )
  if (unsupportedVendorEvidence.length > 0) {
    throw new Error(
      `Unsupported vendor test evidence: ${unsupportedVendorEvidence.map((item) => item.file).join(', ')}`
    )
  }
  const e2eEvidence = evidence.filter((item) => isPlaywrightEvidence(item.file))
  const desktopVitestRuns = [
    {
      label: 'desktop-unit',
      project: 'unit',
      cwd: desktopRoot,
      evidence: desktopTests.filter((item) => !localGitIntegrationTestFiles.has(item.file))
    },
    {
      label: 'desktop-local-git-integration',
      project: 'local-git-integration',
      cwd: desktopRoot,
      evidence: desktopTests.filter((item) => localGitIntegrationTestFiles.has(item.file))
    }
  ].filter((run) => run.evidence.length > 0)
  const tests = [
    ...(await runVitestBatches(desktopVitestRuns)),
    ...(clientTests.length === 0
      ? []
      : await runVitest({
          cwd: resolve(desktopRoot, 'vendors/codex-app-server-client'),
          evidence: clientTests,
          label: 'client-unit'
        })),
    ...(e2eEvidence.length === 0 ? [] : await runPlaywright(e2eEvidence))
  ]
  return {
    runId,
    // Keep the reporter's invocations intact. In particular, do not project
    // them onto manifest file/name pairs: that would let a test body claim a
    // neighbouring test's evidence identity.
    tests,
    assertions: await readRecordedAssertions(assertionEvidencePath)
  }
}

async function runVitestBatches(runs) {
  const results = []
  for (const run of runs) results.push(...(await runVitest(run)))
  return results
}

async function runVitest({ cwd, evidence, label, project }) {
  const { files, testNamePattern } = vitestEvidenceSelection(evidence)
  const reportPath = resolve(runDirectory, `${label}-vitest.json`)
  runOrThrow(
    'npx',
    [
      'vitest',
      'run',
      ...files,
      ...(project ? ['--project', project] : []),
      '--retry=0',
      '--reporter=json',
      `--outputFile=${reportPath}`,
      ...(testNamePattern ? ['--testNamePattern', testNamePattern] : [])
    ],
    cwd
  )
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  return report.testResults.flatMap((result) =>
    result.assertionResults.map((assertion) => {
      const file = relative(desktopRoot, result.name)
      const fullTestName = vitestFullTestName(assertion)
      return {
        runner: 'vitest',
        file,
        testName: assertion.title,
        fullTestName,
        invocationId: invocationId('vitest', file, fullTestName),
        status: assertion.status,
        mode: vitestExecutionMode(assertion.status)
      }
    })
  )
}

function vitestExecutionMode(status) {
  return ['pending', 'skipped', 'todo'].includes(status) ? 'skip' : 'run'
}

async function runPlaywright(evidence) {
  const { files, grep } = playwrightEvidenceSelection(evidence)
  if (files.length === 0 || !grep) return []

  const reportPath = resolve(runDirectory, 'playwright.json')
  runOrThrow('npm', ['run', 'build'], desktopRoot)
  const result = spawnSync(
    'npx',
    [
      'playwright',
      'test',
      ...files,
      '--grep',
      grep,
      '--retries=0',
      '--workers=1',
      '--reporter=json'
    ],
    {
      cwd: desktopRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      env: testEnvironment()
    }
  )
  await writeFile(reportPath, result.stdout, 'utf8')
  if (result.status !== 0) {
    throw new Error(
      formatPlaywrightFailures(result.stdout) || result.stderr || 'Playwright evidence run failed'
    )
  }
  const report = JSON.parse(result.stdout)
  return flattenPlaywrightReporterSuites({ desktopRoot, report }).map((test) => ({
    ...test,
    invocationId: invocationId(test.runner, test.file, test.fullTestName)
  }))
}

function formatPlaywrightFailures(output) {
  try {
    const report = JSON.parse(output)
    const failures = flattenPlaywrightReporterSuites({ desktopRoot, report }).filter(
      (spec) => spec.status !== 'passed'
    )
    return failures.map((spec) => `${spec.file} :: ${spec.testName} (${spec.status})`).join('\n')
  } catch {
    return undefined
  }
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    env: testEnvironment()
  })
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed`)
}

function testEnvironment() {
  return {
    ...process.env,
    DASCOWORK_TEST_PLAN_RUN_ID: runId,
    DASCOWORK_TEST_PLAN_ASSERTIONS_PATH: assertionEvidencePath,
    DASCOWORK_TEST_PLAN_DESKTOP_ROOT: desktopRoot
  }
}

async function readRecordedAssertions(path) {
  try {
    return (await readFile(path, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
}

function isPlaywrightEvidence(file) {
  return file.startsWith('tests/e2e/') && file.endsWith('.e2e.ts')
}

function unique(values) {
  return [...new Set(values)]
}

function invocationId(runner, file, fullTestName) {
  return `${runner}\u0000${file}\u0000${fullTestName}`
}

function vitestFullTestName(assertion) {
  const ancestors = Array.isArray(assertion.ancestorTitles)
    ? assertion.ancestorTitles.filter((title) => typeof title === 'string' && title.trim() !== '')
    : []
  return [...ancestors, assertion.title].join(' > ')
}
