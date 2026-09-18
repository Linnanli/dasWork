/* eslint-disable @typescript-eslint/explicit-function-return-type */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  expectedMockIds,
  expectedP004EdgeIds,
  expectedP004Ids,
  expectedReleaseIds,
  expectedScenarioIds,
  validateTestPlanCoverage
} from '../lib/test-plan-coverage-validator.mjs'
import {
  createExecutedTestIdentity,
  createPlanAssertionRecorder,
  planAssert,
  planAssertionsForScenarios
} from '../lib/test-plan-assertions.mjs'
import {
  flattenPlaywrightReporterSuites,
  normalizePlaywrightReporterFile
} from '../lib/test-plan-playwright-reporter.mjs'
import { playwrightEvidenceSelection } from '../lib/test-plan-playwright-selection.mjs'
import { vitestEvidenceSelection } from '../lib/test-plan-vitest-selection.mjs'

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

test('recognizes the dedicated R07 Primary Runtime presentation-skill release scenario', () => {
  assert.ok(expectedScenarioIds.includes('PRESENTATION-SKILL-RUNTIME'))
  assert.ok(expectedReleaseIds.includes('R07'))
})

test('normalizes Playwright reporter files from its configured test root', () => {
  assert.equal(
    normalizePlaywrightReporterFile({
      desktopRoot: '/workspace/desktop-app',
      reportRootDir: '/workspace/desktop-app/tests/e2e',
      specFile: 'approvals.e2e.ts'
    }),
    'tests/e2e/approvals.e2e.ts'
  )
  assert.throws(
    () =>
      normalizePlaywrightReporterFile({
        desktopRoot: '/workspace/desktop-app',
        reportRootDir: '/workspace/desktop-app/tests/e2e',
        specFile: '../../../outside.e2e.ts'
      }),
    /outside desktop-app/u
  )
})

test('keeps parameterized Playwright cases distinct instead of collapsing them into one spec', () => {
  const records = flattenPlaywrightReporterSuites({
    desktopRoot: '/workspace/desktop-app',
    report: {
      config: { rootDir: '/workspace/desktop-app/tests/e2e' },
      suites: [
        {
          title: 'approvals.e2e.ts',
          file: 'approvals.e2e.ts',
          specs: [
            {
              title: 'B06 preserves rejection for $label',
              file: 'approvals.e2e.ts',
              tests: [
                { expectedStatus: 'passed', results: [{ status: 'passed' }] },
                { expectedStatus: 'passed', results: [{ status: 'passed' }] }
              ]
            }
          ]
        }
      ]
    }
  })

  assert.equal(records.length, 2)
  assert.ok(records.every((record) => record.fullTestName === 'B06 preserves rejection for $label'))
})

test('selects only manifest-declared Playwright evidence by literal test title', () => {
  assert.deepEqual(
    playwrightEvidenceSelection([
      { file: 'tests/e2e/approvals.e2e.ts', testName: 'A01 verifies (the) approval' },
      { file: 'tests/e2e/approvals.e2e.ts', testName: 'A01 verifies (the) approval' },
      { file: 'tests/e2e/fault-injection.e2e.ts', testName: 'C22 handles $late event' }
    ]),
    {
      files: ['tests/e2e/approvals.e2e.ts', 'tests/e2e/fault-injection.e2e.ts'],
      grep: '(?:A01 verifies \\(the\\) approval|C22 handles \\$late event)'
    }
  )
})

test('selects only manifest-declared Vitest evidence by file and parameterized title', () => {
  assert.deepEqual(
    vitestEvidenceSelection([
      { file: 'src/main/service.test.ts', testName: 'A01 verifies (the) behavior' },
      { file: 'src/main/service.test.ts', testName: 'A01 verifies (the) behavior' },
      { file: 'src/main/queue.test.ts', testName: 'E13 pauses persisted %s delivery' },
      { file: 'src/main/runtime.test.ts', testName: 'C23 terminates once $phase' }
    ]),
    {
      files: ['src/main/service.test.ts', 'src/main/queue.test.ts', 'src/main/runtime.test.ts'],
      testNamePattern:
        '(?:A01 verifies \\(the\\) behavior|E13 pauses persisted .+ delivery|C23 terminates once .+)'
    }
  )
})

test('accepts a complete manifest whose evidence covers every layer and assertion', async () => {
  const fixture = await createFixture()

  const result = await validateTestPlanCoverage(fixture)

  assert.deepEqual(result.failures, [])
})

test('requires every P0-04 case to point at a declared test', async () => {
  const fixture = await createFixture()
  fixture.manifest.p004.cases[0].evidence = 'tests/missing-p004.test.ts'

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'P0-04 case P004-E2E-01 evidence file does not exist: tests/missing-p004.test.ts'
  )
})

test('requires the complete P0-04 case matrix', () => {
  assert.equal(expectedP004Ids.length, 20)
  assert.ok(expectedP004Ids.includes('P004-E2E-01'))
  assert.ok(expectedP004Ids.includes('P004-E2E-19'))
  assert.ok(expectedP004Ids.includes('P004-E2E-20'))
})

test('requires the complete P0-04 edge-case matrix', () => {
  assert.equal(expectedP004EdgeIds.length, 13)
  assert.ok(expectedP004EdgeIds.includes('P004-EDGE-01'))
  assert.ok(expectedP004EdgeIds.includes('P004-EDGE-13'))
})

test('core recorder records only a successful callback under runner-owned identity', async () => {
  const recorder = createPlanAssertionRecorder(
    'plan-assertion-test-run',
    createExecutedTestIdentity({
      runner: 'node-test',
      file: 'scripts/tests/verify-test-plan-coverage.node-test.mjs',
      fullTestName: 'core recorder records only a successful callback under runner-owned identity'
    })
  )

  await recorder.planAssert({
    scenarioId: 'A01',
    assertionId: 'callback succeeds',
    assertion: () => assert.equal(1, 1)
  })
  await assert.rejects(() =>
    recorder.planAssert({
      scenarioId: 'A01',
      assertionId: 'callback fails',
      assertion: () => assert.fail('the callback failed')
    })
  )

  assert.deepEqual(recorder.records(), [
    {
      runId: 'plan-assertion-test-run',
      scenarioId: 'A01',
      assertionId: 'callback succeeds',
      runner: 'node-test',
      file: 'scripts/tests/verify-test-plan-coverage.node-test.mjs',
      fullTestName: 'core recorder records only a successful callback under runner-owned identity',
      invocationId:
        'node-test\u0000scripts/tests/verify-test-plan-coverage.node-test.mjs\u0000core recorder records only a successful callback under runner-owned identity'
    }
  ])
})

test('scenario recorder fan-out keeps the injected runner-bound recorder identity', async () => {
  const recorder = createPlanAssertionRecorder(
    'scenario-fan-out-run',
    createExecutedTestIdentity({
      runner: 'node-test',
      file: 'scripts/tests/verify-test-plan-coverage.node-test.mjs',
      fullTestName: 'scenario recorder fan-out keeps the injected runner-bound recorder identity'
    })
  )
  const assertScenarios = planAssertionsForScenarios(['A01', 'A02'], recorder.planAssert)

  await assertScenarios('shared assertion', () => assert.equal(1, 1))

  assert.deepEqual(
    recorder.records().map(({ scenarioId, assertionId, runner, file, fullTestName }) => ({
      scenarioId,
      assertionId,
      runner,
      file,
      fullTestName
    })),
    [
      {
        scenarioId: 'A01',
        assertionId: 'shared assertion',
        runner: 'node-test',
        file: 'scripts/tests/verify-test-plan-coverage.node-test.mjs',
        fullTestName: 'scenario recorder fan-out keeps the injected runner-bound recorder identity'
      },
      {
        scenarioId: 'A02',
        assertionId: 'shared assertion',
        runner: 'node-test',
        file: 'scripts/tests/verify-test-plan-coverage.node-test.mjs',
        fullTestName: 'scenario recorder fan-out keeps the injected runner-bound recorder identity'
      }
    ]
  )
})

test('planAssert rejects caller-provided evidence identity fields', async () => {
  await assert.rejects(
    planAssert({
      scenarioId: 'A01',
      assertionId: 'caller identity',
      file: 'tests/impersonated.test.ts',
      assertion: () => assert.equal(1, 1)
    }),
    /does not accept file/u
  )
})

test('planAssert leaves ordinary test runs unrecorded', () => {
  const previousRunId = process.env.DASCOWORK_TEST_PLAN_RUN_ID
  const previousOutputPath = process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH
  delete process.env.DASCOWORK_TEST_PLAN_RUN_ID
  delete process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH
  try {
    void planAssert({
      scenarioId: 'A01',
      assertionId: 'normal run',
      assertion: () => assert.equal(1, 1)
    })
  } finally {
    if (previousRunId === undefined) delete process.env.DASCOWORK_TEST_PLAN_RUN_ID
    else process.env.DASCOWORK_TEST_PLAN_RUN_ID = previousRunId
    if (previousOutputPath === undefined) delete process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH
    else process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH = previousOutputPath
  }
})

test('planAssert rejects an incomplete evidence-run configuration', async (t) => {
  const previousRunId = process.env.DASCOWORK_TEST_PLAN_RUN_ID
  const previousOutputPath = process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH
  t.after(() => {
    if (previousRunId === undefined) delete process.env.DASCOWORK_TEST_PLAN_RUN_ID
    else process.env.DASCOWORK_TEST_PLAN_RUN_ID = previousRunId
    if (previousOutputPath === undefined) delete process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH
    else process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH = previousOutputPath
  })
  process.env.DASCOWORK_TEST_PLAN_RUN_ID = 'incomplete-plan-assertion-run'
  delete process.env.DASCOWORK_TEST_PLAN_ASSERTIONS_PATH

  await assert.rejects(
    planAssert({
      scenarioId: 'A01',
      assertionId: 'incomplete configuration',
      assertion: () => assert.equal(1, 1)
    }),
    /DASCOWORK_TEST_PLAN_RUN_ID and DASCOWORK_TEST_PLAN_ASSERTIONS_PATH/u
  )
})

test('rejects covered scenario evidence with a missing layer', async () => {
  const fixture = await createFixture()
  delete fixture.manifest.scenarios[0].evidence[0].layer

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario A01 evidence #1 has no layer')
  assertFailure(
    result,
    'scenario A01 is covered but has no evidence for required layer desktop-unit'
  )
})

test('rejects covered scenario evidence with a missing required assertion', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[0].evidence[0].assertions = []

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario A01 evidence #1 has no assertions')
  assertFailure(
    result,
    'scenario A01 is covered but has no evidence for required assertion assertion A01'
  )
})

test('rejects evidence assertions that are not declared by the scenario', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[0].evidence[0].assertions = ['invented assertion']

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'scenario A01 evidence #1 assertion is not declared in requiredAssertions: invented assertion'
  )
  assertFailure(
    result,
    'scenario A01 is covered but has no evidence for required assertion assertion A01'
  )
})

test('rejects a fake evidence test name that is absent from the referenced file', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[0].evidence[0].testName = 'A01 fake evidence name'

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'scenario A01 evidence #1 test name is not declared as a test in tests/evidence.test.ts'
  )
})

test('rejects covered evidence without a fresh executed report or assertion record', async () => {
  const fixture = await createFixture()
  fixture.execution = undefined

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'execution evidence is required for covered entries')
  assertFailure(result, 'scenario A01 evidence #1 has no fresh execution evidence')
})

test('rejects an empty test and skipped execution evidence', async () => {
  const fixture = await createFixture()
  const evidencePath = join(fixture.desktopRoot, 'tests/evidence.test.ts')
  const source = await readFile(evidencePath, 'utf8')
  await writeFile(
    evidencePath,
    source.replace(
      'test("A01 evidence", () => { expect(true).toBe(true) })',
      'test("A01 evidence", () => {})'
    ),
    'utf8'
  )
  let result = await validateTestPlanCoverage(fixture)
  assertFailure(result, 'scenario A01 evidence #1 is an empty or assertion-free test')

  fixture.execution.tests = fixture.execution.tests.map((record) =>
    record.testName === 'A01 evidence' ? { ...record, status: 'skipped', mode: 'skip' } : record
  )

  result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario A01 evidence #1 executed with status skipped')
})

test('rejects covered evidence declared with only, skip, fixme, or fail modifiers', async () => {
  for (const modifier of ['only', 'skip', 'fixme', 'fail']) {
    const fixture = await createFixture()
    await writeFile(
      join(fixture.desktopRoot, 'tests/evidence.test.ts'),
      `test.${modifier}('A01 evidence', () => { expect(true).toBe(true) })`,
      'utf8'
    )

    const result = await validateTestPlanCoverage(fixture)

    assertFailure(result, `scenario A01 evidence #1 source test is marked ${modifier}`)
  }
})

test('rejects a passed test when one required assertion was not recorded', async () => {
  const fixture = await createFixture()
  fixture.execution.assertions = fixture.execution.assertions.filter(
    (record) => !(record.scenarioId === 'A01' && record.assertionId === 'assertion A01')
  )

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario A01 evidence #1 did not record executed assertion assertion A01')
})

test('rejects an assertion recorded by a different reporter invocation', async () => {
  const fixture = await createFixture()
  const spoofed = fixture.execution.assertions.find(
    (record) => record.scenarioId === 'A01' && record.assertionId === 'assertion A01'
  )
  assert.ok(spoofed)
  Object.assign(spoofed, executedIdentity(fixture.manifest.scenarios[1].evidence[0]))

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario A01 evidence #1 did not record executed assertion assertion A01')
})

test('rejects matching leaf titles from different suites without a unique full test identity', async () => {
  const fixture = await createFixture()
  const evidence = fixture.manifest.scenarios[0].evidence[0]
  evidence.testName = 'A01 shared leaf title'
  await writeFixtureTestFile(fixture.desktopRoot, fixture.manifest)
  await writeFile(
    join(fixture.desktopRoot, 'tests/evidence.test.ts'),
    `${await readFile(join(fixture.desktopRoot, 'tests/evidence.test.ts'), 'utf8')}
describe('second suite', () => test('A01 shared leaf title', () => { expect(true).toBe(true) }))`,
    'utf8'
  )
  fixture.execution = executionForManifest(fixture.manifest)
  fixture.execution.tests = fixture.execution.tests
    .filter((record) => record.testName !== evidence.testName)
    .concat([
      executedTest(evidence, {
        fullTestName: 'first suite > A01 shared leaf title'
      }),
      executedTest(evidence, {
        fullTestName: 'second suite > A01 shared leaf title'
      })
    ])

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'scenario A01 evidence #1 matches 2 reporter invocations; manifest evidence must select one full test name'
  )
})

test('accepts a parameterized test only when evidence selects one exact reporter full name', async () => {
  const fixture = await createFixture()
  const evidence = fixture.manifest.scenarios[0].evidence[0]
  evidence.testName = 'A01 parameterized $phase'
  evidence.fullTestName = 'first suite > A01 parameterized first'
  await writeFixtureTestFile(
    fixture.desktopRoot,
    fixture.manifest,
    new Map([
      [
        evidence.testName,
        "test.each([{ phase: 'first' }, { phase: 'second' }])('A01 parameterized $phase', () => { expect(true).toBe(true) })"
      ]
    ])
  )
  fixture.execution = executionForManifest(fixture.manifest)
  const first = fixture.execution.tests.find(
    (record) => record.fullTestName === evidence.fullTestName
  )
  assert.ok(first)
  Object.assign(first, {
    testName: 'A01 parameterized first',
    invocationId: `vitest\u0000${evidence.file}\u0000${evidence.fullTestName}`
  })
  fixture.execution.tests.push(
    executedTest(evidence, {
      testName: 'A01 parameterized second',
      fullTestName: 'first suite > A01 parameterized second'
    })
  )

  const result = await validateTestPlanCoverage(fixture)

  assert.deepEqual(result.failures, [])
})

test('accepts an implicit callback when a local helper contains the assertion', async () => {
  const fixture = await createFixture()
  const evidencePath = join(fixture.desktopRoot, 'tests/evidence.test.ts')
  const source = await readFile(evidencePath, 'utf8')
  await writeFile(
    evidencePath,
    source.replace(
      'test("A01 evidence", () => { expect(true).toBe(true) })',
      `test('A01 evidence', () => proveA01())
async function proveA01() {
  await planAssert({
    scenarioId: 'A01',
    assertionId: 'assertion A01',
    assertion: () => expect(true).toBe(true)
  })
}`
    ),
    'utf8'
  )

  const result = await validateTestPlanCoverage(fixture)

  assert.deepEqual(result.failures, [])
})

test('accepts an implicit callback when its TypeScript helper declares a return type', async () => {
  const fixture = await createFixture()
  const evidencePath = join(fixture.desktopRoot, 'tests/evidence.test.ts')
  const source = await readFile(evidencePath, 'utf8')
  await writeFile(
    evidencePath,
    source.replace(
      'test("A01 evidence", () => { expect(true).toBe(true) })',
      `test('A01 evidence', () => proveA01())
async function proveA01(): Promise<void> {
  await planAssert({
    scenarioId: 'A01',
    assertionId: 'assertion A01',
    assertion: () => expect(true).toBe(true)
  })
}`
    ),
    'utf8'
  )

  const result = await validateTestPlanCoverage(fixture)

  assert.deepEqual(result.failures, [])
})

test('rejects a failed retry even if a later attempt reports passed', async () => {
  const fixture = await createFixture()
  const target = fixture.execution.tests.find((record) => record.testName === 'A01 evidence')
  assert.ok(target)
  fixture.execution.tests.push({ ...target, status: 'failed', mode: 'run' })

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'execution has duplicate reporter invocation vitest:tests/evidence.test.ts:A01 evidence'
  )
})

test('rejects assertion records with a stale run id or an invalid full-name invocation id', async () => {
  const staleRunFixture = await createFixture()
  staleRunFixture.execution.assertions[0].runId = 'old-run'
  let result = await validateTestPlanCoverage(staleRunFixture)
  assertFailure(result, 'execution assertion has a stale or mismatched runId')

  const wrongFullNameFixture = await createFixture()
  wrongFullNameFixture.execution.assertions[0].fullTestName = 'wrong full name'
  result = await validateTestPlanCoverage(wrongFullNameFixture)
  assertFailure(result, 'execution assertion has an incomplete runner identity')
})

test('rejects an evidence name found only in comments, strings, or a describe title', async () => {
  const fakeName = 'A01 comment-only evidence'
  for (const source of [
    `// ${fakeName}`,
    `/* ${fakeName} */`,
    `const evidence = ${JSON.stringify(fakeName)}`,
    `describe(${JSON.stringify(fakeName)}, () => {})`
  ]) {
    const fixture = await createFixture()
    fixture.manifest.scenarios[0].evidence[0].testName = fakeName
    await writeFile(join(fixture.desktopRoot, 'tests/evidence.test.ts'), source, 'utf8')

    const result = await validateTestPlanCoverage(fixture)

    assertFailure(
      result,
      'scenario A01 evidence #1 test name is not declared as a test in tests/evidence.test.ts'
    )
  }
})

test('accepts test, it, test.each, and it.each declarations as evidence', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[0].evidence[0].testName = 'A01 test declaration'
  fixture.manifest.scenarios[0].evidence[1].testName = 'A01 it declaration'
  fixture.manifest.mockE2E[0].evidence[0].testName = 'M01 $phase each declaration'
  fixture.manifest.releaseE2E[0].evidence[0].testName = 'R01 $phase it.each declaration'
  await writeFixtureTestFile(
    fixture.desktopRoot,
    fixture.manifest,
    new Map([
      ['A01 test declaration', "test('A01 test declaration', () => { expect(true).toBe(true) })"],
      ['A01 it declaration', 'it("A01 it declaration", () => { expect(true).toBe(true) })'],
      [
        'M01 $phase each declaration',
        "test.each([{ phase: 'first' }])(`M01 $phase each declaration`, () => { expect(true).toBe(true) })"
      ],
      [
        'R01 $phase it.each declaration',
        "it.each([{ phase: 'first' }])('R01 $phase it.each declaration', () => { expect(true).toBe(true) })"
      ]
    ])
  )
  fixture.execution = executionForManifest(fixture.manifest)

  const result = await validateTestPlanCoverage(fixture)

  assert.deepEqual(result.failures, [])
})

test('rejects dynamically composed and interpolated test names', async () => {
  const fakeName = 'A01 dynamic evidence'
  for (const source of [
    "const suffix = 'dynamic evidence'\ntest(`A01 ${suffix}`, () => {})",
    "test('A01 ' + 'dynamic evidence', () => {})",
    "test.each([{ suffix: 'dynamic evidence' }])(`A01 ${suffix}`, () => {})"
  ]) {
    const fixture = await createFixture()
    fixture.manifest.scenarios[0].evidence[0].testName = fakeName
    await writeFile(join(fixture.desktopRoot, 'tests/evidence.test.ts'), source, 'utf8')

    const result = await validateTestPlanCoverage(fixture)

    assertFailure(
      result,
      'scenario A01 evidence #1 test name is not declared as a test in tests/evidence.test.ts'
    )
  }
})

test('rejects a test-name substring that is not the declared name', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[0].evidence[0].testName = 'A01 evidence suffix'

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'scenario A01 evidence #1 test name is not declared as a test in tests/evidence.test.ts'
  )
})

test('requires an exact declared test name, including its final character', async () => {
  for (const [testName, shouldPass] of [
    ['A01 evidence', true],
    ['A01 evidence!', false],
    ['A01 evidenc', false]
  ]) {
    const fixture = await createFixture()
    fixture.manifest.scenarios[0].evidence[0].testName = testName

    const result = await validateTestPlanCoverage(fixture)

    if (shouldPass) {
      assert.deepEqual(result.failures, [])
    } else {
      assertFailure(
        result,
        'scenario A01 evidence #1 test name is not declared as a test in tests/evidence.test.ts'
      )
    }
  }
})

test('rejects duplicate scenario IDs', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[1].id = 'A01'

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario id A01 is duplicated')
})

test('rejects deferred P0 and P1 scenarios even with complete deferral metadata', async () => {
  for (const priority of ['P0', 'P1']) {
    const fixture = await createFixture()
    Object.assign(fixture.manifest.scenarios[0], {
      priority,
      status: 'deferred',
      deferredReason: 'external prerequisite',
      deferredOwner: 'desktop-e2e',
      deferredPlan: '.omx/plans/test-plan-coverage-and-acceptance-remediation.md'
    })

    const result = await validateTestPlanCoverage(fixture)

    assertFailure(result, `scenario A01 is P0/P1 and must be covered`)
  }
})

test('requires reason, owner, and plan metadata for a deferred P2 scenario', async () => {
  const fixture = await createFixture()
  fixture.manifest.scenarios[0].status = 'deferred'

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(result, 'scenario A01 is deferred but has no deferredReason')
  assertFailure(result, 'scenario A01 is deferred but has no deferredOwner')
  assertFailure(result, 'scenario A01 is deferred but has no deferredPlan')
})

test('rejects a release group marked covered without release evidence and assertion coverage', async () => {
  const fixture = await createFixture()
  const release = fixture.manifest.releaseE2E[0]
  release.status = 'covered'
  release.evidence[0].layer = 'mock-e2e'
  release.evidence[0].assertions = []

  const result = await validateTestPlanCoverage(fixture)

  assertFailure(
    result,
    'release E2E R01 evidence #1 layer mock-e2e is not declared in requiredLayer'
  )
  assertFailure(result, 'release E2E R01 evidence #1 has no assertions')
  assertFailure(
    result,
    'release E2E R01 is covered but has no evidence for required layer release-e2e'
  )
  assertFailure(
    result,
    'release E2E R01 is covered but has no evidence for required assertion release assertion R01'
  )
})

async function createFixture() {
  const desktopRoot = await mkdtemp(join(tmpdir(), 'coverage-validator-'))
  temporaryRoots.push(desktopRoot)
  await mkdir(join(desktopRoot, 'tests'), { recursive: true })

  const scenarios = expectedScenarioIds.map((id) => ({
    id,
    title: `Scenario ${id}`,
    priority: 'P2',
    requiredLayer: ['desktop-unit'],
    requiredAssertions: [`assertion ${id}`],
    status: 'covered',
    evidence: [
      {
        file: 'tests/evidence.test.ts',
        testName: `${id} evidence`,
        layer: 'desktop-unit',
        assertions: [`assertion ${id}`]
      }
    ]
  }))
  scenarios[0].requiredLayer.push('mock-e2e')
  scenarios[0].requiredAssertions.push('second assertion A01')
  scenarios[0].evidence.push({
    file: 'tests/evidence.test.ts',
    testName: 'A01 mock evidence',
    layer: 'mock-e2e',
    assertions: ['second assertion A01']
  })
  const mockE2E = expectedMockIds.map((id) => ({
    id,
    title: `Mock ${id}`,
    scenarioIds: ['A01'],
    status: 'covered',
    requiredAssertions: [`mock assertion ${id}`],
    evidence: [
      {
        file: 'tests/evidence.test.ts',
        testName: `${id} evidence`,
        layer: 'mock-e2e',
        assertions: [`mock assertion ${id}`]
      }
    ]
  }))
  const releaseE2E = expectedReleaseIds.map((id) => ({
    id,
    title: `Release ${id}`,
    scenarioIds: ['A01'],
    owner: 'desktop-e2e',
    status: 'partial',
    requiredAssertions: [`release assertion ${id}`],
    evidence: [
      {
        file: 'tests/evidence.test.ts',
        testName: `${id} evidence`,
        layer: 'release-e2e',
        assertions: [`release assertion ${id}`]
      }
    ]
  }))
  const p004 = {
    title: 'P0-04 local Git review',
    cases: expectedP004Ids.map((id) => ({
      id,
      status: 'covered',
      evidence: 'tests/p004.test.ts'
    })),
    edgeCases: expectedP004EdgeIds.map((id) => ({
      id,
      title: `P0-04 edge ${id}`,
      status: 'covered',
      requiredLayer: ['desktop-unit'],
      evidence: [
        {
          file: 'tests/evidence.test.ts',
          testName: `${id} evidence`,
          layer: 'desktop-unit'
        }
      ]
    }))
  }

  const manifest = {
    schemaVersion: 1,
    p004,
    scenarios,
    mockE2E,
    releaseE2E
  }
  await writeFixtureTestFile(desktopRoot, manifest)

  return {
    desktopRoot,
    manifest,
    execution: executionForManifest(manifest)
  }
}

async function writeFixtureTestFile(desktopRoot, manifest, declarations = new Map()) {
  const evidenceNames = [
    ...manifest.scenarios.flatMap((entry) => entry.evidence.map((evidence) => evidence.testName)),
    ...manifest.mockE2E.flatMap((entry) => entry.evidence.map((evidence) => evidence.testName)),
    ...manifest.releaseE2E.flatMap((entry) => entry.evidence.map((evidence) => evidence.testName)),
    ...manifest.p004.edgeCases.flatMap((entry) =>
      entry.evidence.map((evidence) => evidence.testName)
    )
  ]
  await writeFile(
    join(desktopRoot, 'tests/evidence.test.ts'),
    evidenceNames
      .map(
        (name) =>
          declarations.get(name) ??
          `test(${JSON.stringify(name)}, () => { expect(true).toBe(true) })`
      )
      .join('\n'),
    'utf8'
  )
  await writeFile(
    join(desktopRoot, 'tests/p004.test.ts'),
    manifest.p004.cases
      .map(
        (entry) =>
          `test(${JSON.stringify(`${entry.id} is covered by the local Git review flow`)}, () => { expect(true).toBe(true) })`
      )
      .join('\n'),
    'utf8'
  )
}

function executionForManifest(manifest) {
  const runId = 'fixture-run'
  const entries = [
    ...manifest.scenarios.map((entry) => ({ id: entry.id, evidence: entry.evidence })),
    ...manifest.mockE2E.map((entry) => ({ id: entry.id, evidence: entry.evidence })),
    ...manifest.releaseE2E.map((entry) => ({ id: entry.id, evidence: entry.evidence })),
    ...manifest.p004.edgeCases.map((entry) => ({ id: entry.id, evidence: entry.evidence }))
  ]
  return {
    runId,
    tests: entries.flatMap((entry) => entry.evidence.map((evidence) => executedTest(evidence))),
    assertions: entries.flatMap((entry) =>
      entry.evidence.flatMap((evidence) =>
        (evidence.assertions ?? []).map((assertionId) => ({
          runId,
          scenarioId: entry.id,
          assertionId,
          ...executedIdentity(evidence)
        }))
      )
    )
  }
}

function executedTest(evidence, overrides = {}) {
  return {
    ...executedIdentity(evidence, overrides),
    testName: evidence.testName,
    status: 'passed',
    mode: 'run',
    ...overrides
  }
}

function executedIdentity(evidence, overrides = {}) {
  const fullTestName = overrides.fullTestName ?? evidence.fullTestName ?? evidence.testName
  return {
    runner: 'vitest',
    file: evidence.file,
    fullTestName,
    invocationId: `vitest\u0000${evidence.file}\u0000${fullTestName}`,
    ...overrides
  }
}

function assertFailure(result, expected) {
  assert.ok(
    result.failures.includes(expected),
    `expected failure ${JSON.stringify(expected)}; received:\n${result.failures.join('\n')}`
  )
}
