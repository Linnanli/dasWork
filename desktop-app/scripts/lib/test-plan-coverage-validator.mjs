/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const coverageStatuses = new Set([
  'missing',
  'partial',
  'covered',
  'deferred',
  'not-applicable'
])

const priorities = new Set(['P0', 'P1', 'P2'])
const layers = new Set(['client-unit', 'desktop-unit', 'integration', 'mock-e2e', 'release-e2e'])

export const expectedScenarioIds = Object.entries({
  A: 14,
  B: 16,
  C: 24,
  D: 20,
  E: 28,
  F: 20,
  G: 12
}).flatMap(([prefix, count]) =>
  Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`)
)

export const expectedMockIds = Array.from(
  { length: 12 },
  (_, index) => `M${String(index + 1).padStart(2, '0')}`
)

export const expectedReleaseIds = Array.from(
  { length: 6 },
  (_, index) => `R${String(index + 1).padStart(2, '0')}`
)

export const expectedP004Ids = Array.from(
  { length: 20 },
  (_, index) => `P004-E2E-${String(index + 1).padStart(2, '0')}`
)

export const expectedP004EdgeIds = Array.from(
  { length: 13 },
  (_, index) => `P004-EDGE-${String(index + 1).padStart(2, '0')}`
)

export async function validateTestPlanCoverage({ manifest, desktopRoot, execution }) {
  const failures = []
  const executionIndex = indexExecutionEvidence(execution, failures)

  if (manifest?.schemaVersion !== 1) {
    failures.push('schemaVersion must be 1')
  }

  const { p004CaseCount, p004EdgeCaseCount } = await checkP004Coverage(
    manifest?.p004,
    desktopRoot,
    executionIndex,
    failures
  )

  const scenarios = Array.isArray(manifest?.scenarios) ? manifest.scenarios : []
  checkExpectedIds('scenario', scenarios, expectedScenarioIds, failures)
  await Promise.all(
    scenarios.map((scenario) => checkScenario(scenario, desktopRoot, executionIndex, failures))
  )
  const scenariosById = new Map(scenarios.map((scenario) => [scenario?.id, scenario]))

  const mockE2E = Array.isArray(manifest?.mockE2E) ? manifest.mockE2E : []
  checkExpectedIds('minimum Mock E2E', mockE2E, expectedMockIds, failures)
  await Promise.all(
    mockE2E.map((group) =>
      checkAcceptanceGroup({
        group,
        kind: 'minimum Mock E2E',
        mustBeCovered: true,
        evidenceLayer: 'mock-e2e',
        scenariosById,
        desktopRoot,
        executionIndex,
        failures
      })
    )
  )

  const releaseE2E = Array.isArray(manifest?.releaseE2E) ? manifest.releaseE2E : []
  checkExpectedIds('release E2E', releaseE2E, expectedReleaseIds, failures)
  await Promise.all(
    releaseE2E.map((group) =>
      checkAcceptanceGroup({
        group,
        kind: 'release E2E',
        mustBeCovered: false,
        evidenceLayer: 'release-e2e',
        scenariosById,
        desktopRoot,
        executionIndex,
        failures
      })
    )
  )

  return {
    failures,
    p004CaseCount,
    p004EdgeCaseCount,
    scenarioCount: scenarios.length,
    summary: summarize(scenarios)
  }
}

async function checkP004Coverage(p004, desktopRoot, executionIndex, failures) {
  if (!p004 || typeof p004 !== 'object') {
    failures.push('P0-04 coverage is missing')
    return { p004CaseCount: 0, p004EdgeCaseCount: 0 }
  }
  checkTitle(p004.title, 'P0-04 coverage', failures)
  const cases = Array.isArray(p004.cases) ? p004.cases : []
  checkExpectedIds('P0-04 case', cases, expectedP004Ids, failures)
  await Promise.all(cases.map((entry) => checkP004Case(entry, desktopRoot, failures)))
  const edgeCases = Array.isArray(p004.edgeCases) ? p004.edgeCases : []
  checkExpectedIds('P0-04 edge case', edgeCases, expectedP004EdgeIds, failures)
  await Promise.all(
    edgeCases.map((entry) => checkP004EdgeCase(entry, desktopRoot, executionIndex, failures))
  )
  return { p004CaseCount: cases.length, p004EdgeCaseCount: edgeCases.length }
}

async function checkP004Case(entry, desktopRoot, failures) {
  const label = `P0-04 case ${entry?.id ?? '<unknown>'}`
  if (!entry || typeof entry !== 'object') return
  if (!coverageStatuses.has(entry.status)) {
    failures.push(`${label} has invalid status ${String(entry.status)}`)
  } else if (entry.status !== 'covered') {
    failures.push(`${label} must be covered`)
  }
  if (typeof entry.evidence !== 'string' || entry.evidence.trim() === '') {
    failures.push(`${label} has no evidence file`)
    return
  }

  const path = resolve(desktopRoot, entry.evidence)
  const pathFromDesktopRoot = relative(desktopRoot, path)
  if (
    pathFromDesktopRoot === '..' ||
    pathFromDesktopRoot.startsWith(`..${sep}`) ||
    pathFromDesktopRoot === ''
  ) {
    failures.push(`${label} evidence points outside desktop-app`)
    return
  }

  try {
    const [source, fileStat] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    if (!fileStat.isFile()) failures.push(`${label} evidence is not a file`)
    const testNames = extractDeclaredTests(source).keys()
    if (![...testNames].some((testName) => testName.includes(entry.id))) {
      failures.push(`${label} evidence has no declared test named ${entry.id}`)
    }
  } catch {
    failures.push(`${label} evidence file does not exist: ${entry.evidence}`)
  }
}

async function checkP004EdgeCase(entry, desktopRoot, executionIndex, failures) {
  const label = `P0-04 edge case ${entry?.id ?? '<unknown>'}`
  if (!entry || typeof entry !== 'object') return

  checkTitle(entry.title, label, failures)
  if (entry.status !== 'covered') {
    failures.push(`${label} must be covered`)
  }
  const requiredLayers = checkRequiredLayers(entry.requiredLayer, label, failures)
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
    failures.push(`${label} must declare evidence`)
    return
  }

  const evidencedLayers = new Set()
  await Promise.all(
    entry.evidence.map(async (evidence, index) => {
      const evidenceLabel = `${label} evidence #${index + 1}`
      if (!evidence || typeof evidence !== 'object') {
        failures.push(`${evidenceLabel} must be an object`)
        return
      }
      checkEvidenceLayer(evidence.layer, evidenceLabel, requiredLayers, evidencedLayers, failures)
      if (typeof evidence.testName === 'string' && !evidence.testName.includes(entry.id)) {
        failures.push(`${evidenceLabel} test name must include edge case ID ${entry.id}`)
      }
      await checkEvidenceTestReference({
        entry: evidence,
        evidenceLabel,
        covered: true,
        desktopRoot,
        executionIndex,
        failures
      })
    })
  )

  for (const layer of requiredLayers) {
    if (!evidencedLayers.has(layer)) {
      failures.push(`${label} is covered but has no evidence for required layer ${layer}`)
    }
  }
}

function checkExpectedIds(kind, entries, expectedIds, failures) {
  const seen = new Set()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      failures.push(`${kind} entry is missing a string id`)
      continue
    }
    if (seen.has(entry.id)) failures.push(`${kind} id ${entry.id} is duplicated`)
    seen.add(entry.id)
  }

  for (const id of expectedIds) {
    if (!seen.has(id)) failures.push(`${kind} id ${id} is missing`)
  }
  for (const id of seen) {
    if (!expectedIds.includes(id)) failures.push(`${kind} id ${id} is not recognised`)
  }
}

async function checkScenario(scenario, desktopRoot, executionIndex, failures) {
  const label = `scenario ${scenario?.id ?? '<unknown>'}`
  if (!scenario || typeof scenario !== 'object') return

  checkTitle(scenario.title, label, failures)
  if (!priorities.has(scenario.priority)) {
    failures.push(`${label} has invalid priority ${String(scenario.priority)}`)
  }
  if (!coverageStatuses.has(scenario.status)) {
    failures.push(`${label} has invalid status ${String(scenario.status)}`)
  }

  const requiredLayer = checkRequiredLayers(scenario.requiredLayer, label, failures)
  const requiredAssertions = checkRequiredAssertions(scenario.requiredAssertions, label, failures)

  if (scenario.status === 'deferred') {
    checkDeferredMetadata(scenario, label, failures)
  }

  if ((scenario.priority === 'P0' || scenario.priority === 'P1') && scenario.status !== 'covered') {
    failures.push(`${label} is P0/P1 and must be covered`)
  }

  await checkEvidence({
    evidence: scenario.evidence,
    label,
    covered: scenario.status === 'covered',
    requiredLayers: requiredLayer,
    requiredAssertions,
    scenarioId: scenario.id,
    desktopRoot,
    executionIndex,
    failures
  })
}

async function checkAcceptanceGroup({
  group,
  kind,
  mustBeCovered,
  evidenceLayer,
  scenariosById,
  desktopRoot,
  executionIndex,
  failures
}) {
  const label = `${kind} ${group?.id ?? '<unknown>'}`
  if (!group || typeof group !== 'object') return

  checkTitle(group.title, label, failures)
  if (!coverageStatuses.has(group.status)) {
    failures.push(`${label} has invalid status ${String(group.status)}`)
  }
  if (mustBeCovered && group.status !== 'covered') {
    failures.push(`${label} must be covered`)
  }

  if (!Array.isArray(group.scenarioIds) || group.scenarioIds.length === 0) {
    failures.push(`${label} must reference one or more scenario IDs`)
  } else {
    for (const id of group.scenarioIds) {
      if (!expectedScenarioIds.includes(id)) {
        failures.push(`${label} references unknown scenario ${id}`)
      } else if (group.status === 'covered' && scenariosById.get(id)?.status !== 'covered') {
        failures.push(`${label} is covered but referenced scenario ${id} is not covered`)
      }
    }
  }

  if (kind === 'release E2E' && (typeof group.owner !== 'string' || group.owner.trim() === '')) {
    failures.push(`${label} must name a test owner`)
  }

  const requiredAssertions = checkRequiredAssertions(group.requiredAssertions, label, failures)
  await checkEvidence({
    evidence: group.evidence,
    label,
    covered: group.status === 'covered',
    requiredLayers: new Set([evidenceLayer]),
    requiredAssertions,
    scenarioId: group.id,
    desktopRoot,
    executionIndex,
    failures
  })
}

function checkTitle(title, label, failures) {
  if (typeof title !== 'string' || title.trim() === '') {
    failures.push(`${label} must declare a title`)
  }
}

function checkRequiredLayers(requiredLayer, label, failures) {
  if (!Array.isArray(requiredLayer) || requiredLayer.length === 0) {
    failures.push(`${label} must declare requiredLayer`)
    return new Set()
  }

  const validRequiredLayers = new Set()
  for (const layer of requiredLayer) {
    if (!layers.has(layer)) {
      failures.push(`${label} has invalid layer ${String(layer)}`)
    } else {
      validRequiredLayers.add(layer)
    }
  }
  return validRequiredLayers
}

function checkRequiredAssertions(assertions, label, failures) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    failures.push(`${label} must declare requiredAssertions`)
    return new Set()
  }

  const validAssertions = new Set()
  for (const assertion of assertions) {
    if (typeof assertion !== 'string' || assertion.trim() === '') {
      failures.push(`${label} has an empty required assertion`)
    } else {
      validAssertions.add(assertion)
    }
  }
  return validAssertions
}

function checkDeferredMetadata(entry, label, failures) {
  for (const field of ['deferredReason', 'deferredOwner', 'deferredPlan']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      failures.push(`${label} is deferred but has no ${field}`)
    }
  }
}

async function checkEvidence({
  evidence,
  label,
  covered,
  requiredLayers,
  requiredAssertions,
  scenarioId,
  desktopRoot,
  executionIndex,
  failures
}) {
  if (!Array.isArray(evidence)) {
    failures.push(`${label} evidence must be an array`)
    return
  }
  if (covered && evidence.length === 0) {
    failures.push(`${label} is covered but has no evidence`)
  }

  const evidencedLayers = new Set()
  const evidencedAssertions = new Set()

  await Promise.all(
    evidence.map(async (entry, index) => {
      const evidenceLabel = `${label} evidence #${index + 1}`
      if (!entry || typeof entry !== 'object') {
        failures.push(`${evidenceLabel} must be an object`)
        return
      }

      if (covered) {
        checkEvidenceLayer(entry.layer, evidenceLabel, requiredLayers, evidencedLayers, failures)
        checkEvidenceAssertions(
          entry.assertions,
          evidenceLabel,
          requiredAssertions,
          evidencedAssertions,
          failures
        )
      } else {
        checkOptionalEvidenceMetadata(
          entry,
          evidenceLabel,
          requiredLayers,
          requiredAssertions,
          failures
        )
      }

      await checkEvidenceTestReference({
        entry,
        evidenceLabel,
        covered,
        scenarioId,
        desktopRoot,
        executionIndex,
        failures
      })
    })
  )

  if (!covered) return

  for (const layer of requiredLayers) {
    if (!evidencedLayers.has(layer)) {
      failures.push(`${label} is covered but has no evidence for required layer ${layer}`)
    }
  }
  for (const assertion of requiredAssertions) {
    if (!evidencedAssertions.has(assertion)) {
      failures.push(`${label} is covered but has no evidence for required assertion ${assertion}`)
    }
  }
}

function checkEvidenceLayer(layer, label, requiredLayers, evidencedLayers, failures) {
  if (typeof layer !== 'string' || layer.trim() === '') {
    failures.push(`${label} has no layer`)
    return
  }
  if (!layers.has(layer)) {
    failures.push(`${label} has invalid layer ${String(layer)}`)
    return
  }
  if (!requiredLayers.has(layer)) {
    failures.push(`${label} layer ${layer} is not declared in requiredLayer`)
    return
  }
  evidencedLayers.add(layer)
}

function checkEvidenceAssertions(
  assertions,
  label,
  requiredAssertions,
  evidencedAssertions,
  failures
) {
  if (!Array.isArray(assertions) || assertions.length === 0) {
    failures.push(`${label} has no assertions`)
    return
  }

  for (const assertion of assertions) {
    if (typeof assertion !== 'string' || assertion.trim() === '') {
      failures.push(`${label} has an empty assertion`)
    } else if (!requiredAssertions.has(assertion)) {
      failures.push(`${label} assertion is not declared in requiredAssertions: ${assertion}`)
    } else {
      evidencedAssertions.add(assertion)
    }
  }
}

function checkOptionalEvidenceMetadata(entry, label, requiredLayers, requiredAssertions, failures) {
  if (entry.layer !== undefined) {
    checkEvidenceLayer(entry.layer, label, requiredLayers, new Set(), failures)
  }
  if (entry.assertions !== undefined) {
    checkEvidenceAssertions(entry.assertions, label, requiredAssertions, new Set(), failures)
  }
}

async function checkEvidenceTestReference({
  entry,
  evidenceLabel,
  covered,
  scenarioId,
  desktopRoot,
  executionIndex,
  failures
}) {
  if (typeof entry.file !== 'string' || entry.file.trim() === '') {
    failures.push(`${evidenceLabel} has no test file`)
    return
  }
  if (typeof entry.testName !== 'string' || entry.testName.trim() === '') {
    failures.push(`${evidenceLabel} has no complete test name`)
    return
  }
  if (
    entry.fullTestName !== undefined &&
    (typeof entry.fullTestName !== 'string' || entry.fullTestName.trim() === '')
  ) {
    failures.push(`${evidenceLabel} has no complete full test name`)
    return
  }
  if (scenarioId && !entry.testName.includes(scenarioId)) {
    failures.push(`${evidenceLabel} test name must include scenario ID ${scenarioId}`)
  }

  const path = resolve(desktopRoot, entry.file)
  const pathFromDesktopRoot = relative(desktopRoot, path)
  if (
    pathFromDesktopRoot === '..' ||
    pathFromDesktopRoot.startsWith(`..${sep}`) ||
    pathFromDesktopRoot === ''
  ) {
    failures.push(`${evidenceLabel} points outside desktop-app`)
    return
  }

  try {
    const [file, fileStat] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    const declaredTest = extractDeclaredTests(file).get(entry.testName)
    if (!declaredTest) {
      failures.push(`${evidenceLabel} test name is not declared as a test in ${entry.file}`)
    }
    if (!fileStat.isFile()) failures.push(`${evidenceLabel} path is not a file`)
    if (covered) {
      checkExecutedEvidence({
        entry,
        evidenceLabel,
        scenarioId,
        executionIndex,
        source: file,
        pathFromDesktopRoot,
        declaredTest,
        failures
      })
    }
  } catch {
    failures.push(`${evidenceLabel} file does not exist: ${entry.file}`)
  }
}

function indexExecutionEvidence(execution, failures) {
  const index = {
    runId: undefined,
    tests: [],
    testsByInvocation: new Map(),
    assertionCounts: new Map()
  }
  if (!execution || typeof execution !== 'object') {
    failures.push('execution evidence is required for covered entries')
    return index
  }
  if (typeof execution.runId !== 'string' || execution.runId.trim() === '') {
    failures.push('execution evidence has no runId')
    return index
  }
  index.runId = execution.runId
  if (!Array.isArray(execution.tests) || !Array.isArray(execution.assertions)) {
    failures.push('execution evidence must contain tests and assertions arrays')
    return index
  }
  for (const test of execution.tests) {
    const identity = executionIdentity(test)
    if (!identity || typeof test?.testName !== 'string') {
      failures.push('execution test has an incomplete runner identity')
      continue
    }
    const key = executionInvocationKey(identity)
    if (index.testsByInvocation.has(key)) {
      failures.push(
        `execution has duplicate reporter invocation ${formatExecutionIdentity(identity)}`
      )
      continue
    }
    index.testsByInvocation.set(key, { ...test, ...identity })
    index.tests.push({ ...test, ...identity })
  }
  for (const assertion of execution.assertions) {
    const identity = executionIdentity(assertion)
    if (!assertion || typeof assertion !== 'object') continue
    if (assertion.runId !== index.runId) {
      failures.push('execution assertion has a stale or mismatched runId')
      continue
    }
    if (
      typeof assertion.scenarioId !== 'string' ||
      typeof assertion.assertionId !== 'string' ||
      !identity
    ) {
      failures.push('execution assertion has an incomplete runner identity')
      continue
    }
    const invocationKey = executionInvocationKey(identity)
    if (!index.testsByInvocation.has(invocationKey)) {
      failures.push(
        `execution assertion references no reporter invocation ${formatExecutionIdentity(identity)}`
      )
      continue
    }
    const assertionKey = executionAssertionKey(
      assertion.scenarioId,
      assertion.assertionId,
      identity
    )
    index.assertionCounts.set(assertionKey, (index.assertionCounts.get(assertionKey) ?? 0) + 1)
  }
  return index
}

function checkExecutedEvidence({
  entry,
  evidenceLabel,
  scenarioId,
  executionIndex,
  source,
  pathFromDesktopRoot,
  declaredTest,
  failures
}) {
  if (!executionIndex.runId) {
    failures.push(`${evidenceLabel} has no fresh execution evidence`)
    return
  }
  const matchingTests = executionIndex.tests.filter(
    (test) =>
      test.file === normalizeRelativePath(pathFromDesktopRoot) &&
      expectedRuntimeTestNameMatches(entry.testName, test.testName) &&
      (entry.fullTestName === undefined || entry.fullTestName === test.fullTestName)
  )
  if (matchingTests.length === 0) {
    failures.push(`${evidenceLabel} was not executed in run ${executionIndex.runId}`)
    return
  }
  if (matchingTests.length > 1) {
    failures.push(
      `${evidenceLabel} matches ${matchingTests.length} reporter invocations; manifest evidence must select one full test name`
    )
    return
  }
  const [test] = matchingTests
  if (test.status !== 'passed') {
    failures.push(`${evidenceLabel} executed with status ${String(test.status)}`)
    return
  }
  if (declaredTest?.mode !== 'run') {
    failures.push(`${evidenceLabel} source test is marked ${declaredTest.mode}`)
    return
  }
  if (
    test.mode === 'only' ||
    test.mode === 'skip' ||
    test.mode === 'todo' ||
    test.mode === 'fail'
  ) {
    failures.push(`${evidenceLabel} executed with disallowed mode ${test.mode}`)
    return
  }
  if (!sourceTestHasAssertion(source, entry.testName)) {
    failures.push(`${evidenceLabel} is an empty or assertion-free test`)
    return
  }
  if (!scenarioId || !Array.isArray(entry.assertions)) return
  for (const assertionId of entry.assertions) {
    if (
      executionIndex.assertionCounts.get(executionAssertionKey(scenarioId, assertionId, test)) !== 1
    ) {
      failures.push(`${evidenceLabel} did not record executed assertion ${assertionId}`)
    }
  }
}

function executionIdentity(record) {
  if (!record || typeof record !== 'object') return undefined
  if (
    typeof record.runner !== 'string' ||
    typeof record.file !== 'string' ||
    typeof record.fullTestName !== 'string' ||
    typeof record.invocationId !== 'string'
  ) {
    return undefined
  }
  const identity = {
    runner: record.runner,
    file: normalizeRelativePath(record.file),
    fullTestName: record.fullTestName,
    invocationId: record.invocationId
  }
  if (identity.invocationId !== canonicalInvocationId(identity)) return undefined
  return identity
}

function canonicalInvocationId({ runner, file, fullTestName }) {
  return `${runner}\u0000${file}\u0000${fullTestName}`
}

function executionInvocationKey(identity) {
  return `${identity.invocationId}\u0000${identity.runner}`
}

function executionAssertionKey(scenarioId, assertionId, identity) {
  return `${scenarioId}\u0000${assertionId}\u0000${executionInvocationKey(identity)}`
}

function formatExecutionIdentity({ runner, file, fullTestName }) {
  return `${runner}:${file}:${fullTestName}`
}

function normalizeRelativePath(file) {
  return file.split(sep).join('/')
}

function expectedRuntimeTestNameMatches(expected, actual) {
  if (expected === actual) return true
  const fragments = expected.split(/(%[sdifjoO]|\$[A-Za-z_][\w$]*)/u)
  if (fragments.length === 1) return false
  const pattern = fragments
    .map((fragment) =>
      /^(?:%[sdifjoO]|\$[A-Za-z_][\w$]*)$/u.test(fragment)
        ? '.+'
        : escapeForRegularExpression(fragment)
    )
    .join('')
  return new RegExp(`^${pattern}$`, 'u').test(actual)
}

function escapeForRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function sourceTestHasAssertion(source, testName) {
  const callback = findTestCallbackSource(source, testName)
  return callback !== undefined && sourceFragmentHasAssertion(source, callback, new Set())
}

function findTestCallbackSource(source, testName) {
  const declaration = findStaticTestDeclaration(source, testName)
  if (!declaration) return undefined
  const arrowIndex = source.indexOf('=>', declaration.literalIndex)
  if (arrowIndex < 0) return undefined
  const callbackStart = skipTrivia(source, arrowIndex + 2)
  if (source[callbackStart] === '{') {
    const callbackEnd = findMatchingBrace(source, callbackStart)
    return callbackEnd < 0 ? undefined : source.slice(callbackStart + 1, callbackEnd)
  }
  const callbackEnd = findImplicitCallbackExpressionEnd(source, callbackStart)
  return callbackEnd < 0 ? undefined : source.slice(callbackStart, callbackEnd)
}

function findImplicitCallbackExpressionEnd(source, start) {
  let parentheses = 0
  let brackets = 0
  let braces = 0
  for (let index = start; index < source.length; index += 1) {
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (isQuote(source[index])) {
      index = skipString(source, index) - 1
      continue
    }
    if (source[index] === '(') parentheses += 1
    if (source[index] === ')') {
      if (parentheses === 0 && brackets === 0 && braces === 0) return index
      parentheses -= 1
    }
    if (source[index] === '[') brackets += 1
    if (source[index] === ']') brackets -= 1
    if (source[index] === '{') braces += 1
    if (source[index] === '}') braces -= 1
    if (source[index] === ',' && parentheses === 0 && brackets === 0 && braces === 0) return index
  }
  return -1
}

function sourceFragmentHasAssertion(source, fragment, inspectedHelpers) {
  if (hasDirectAssertion(fragment)) return true
  for (const helperName of invokedIdentifiers(fragment)) {
    if (inspectedHelpers.has(helperName)) continue
    inspectedHelpers.add(helperName)
    const helperBody = findLocalHelperBody(source, helperName)
    if (
      helperBody !== undefined &&
      sourceFragmentHasAssertion(source, helperBody, inspectedHelpers)
    ) {
      return true
    }
  }
  return false
}

function hasDirectAssertion(fragment) {
  return /\b(?:expect|assert|planAssert)\s*(?:\.[A-Za-z_$][\w$]*)?\s*\(/u.test(fragment)
}

function invokedIdentifiers(fragment) {
  return [...fragment.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)].map((match) => match[1])
}

function findLocalHelperBody(source, helperName) {
  const escapedName = escapeForRegularExpression(helperName)
  const functionMatch = new RegExp(`\\b(?:async\\s+)?function\\s+${escapedName}\\s*\\(`, 'u').exec(
    source
  )
  if (functionMatch) {
    const parametersStart = source.indexOf('(', functionMatch.index)
    const bodyStart = skipFunctionReturnType(
      source,
      skipTrivia(source, skipBalancedParentheses(source, parametersStart))
    )
    if (source[bodyStart] !== '{') return undefined
    const bodyEnd = findMatchingBrace(source, bodyStart)
    return bodyEnd < 0 ? undefined : source.slice(bodyStart + 1, bodyEnd)
  }

  const assignmentMatch = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\s*=`, 'u').exec(
    source
  )
  if (!assignmentMatch) return undefined
  const arrowIndex = source.indexOf('=>', assignmentMatch.index)
  if (arrowIndex < 0) return undefined
  const bodyStart = skipTrivia(source, arrowIndex + 2)
  if (source[bodyStart] !== '{') return undefined
  const bodyEnd = findMatchingBrace(source, bodyStart)
  return bodyEnd < 0 ? undefined : source.slice(bodyStart + 1, bodyEnd)
}

/**
 * A local test helper may be written in TypeScript and declare a return type
 * between its parameters and body. The source-only assertion check does not
 * need to interpret that type; it only needs to advance past it.
 */
function skipFunctionReturnType(source, start) {
  if (source[start] !== ':') return start

  let angleDepth = 0
  let parentheses = 0
  let brackets = 0
  for (let index = start + 1; index < source.length; index += 1) {
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (isQuote(source[index])) {
      index = skipString(source, index) - 1
      continue
    }
    if (source[index] === '<') angleDepth += 1
    else if (source[index] === '>' && angleDepth > 0) angleDepth -= 1
    else if (source[index] === '(') parentheses += 1
    else if (source[index] === ')' && parentheses > 0) parentheses -= 1
    else if (source[index] === '[') brackets += 1
    else if (source[index] === ']' && brackets > 0) brackets -= 1
    else if (source[index] === '{' && angleDepth === 0 && parentheses === 0 && brackets === 0) {
      return index
    }
  }
  return source.length
}

function findStaticTestDeclaration(source, testName) {
  const literals = [
    `'${escapeForSource(testName, "'")}'`,
    `"${escapeForSource(testName, '"')}"`,
    `\`${escapeForSource(testName, '`')}\``
  ]
  for (const literal of literals) {
    const literalIndex = source.indexOf(literal)
    if (literalIndex < 0) continue
    return { literalIndex }
  }
  return undefined
}

function findMatchingBrace(source, start) {
  let depth = 0
  let index = start
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index)
      continue
    }
    if (isQuote(source[index])) {
      index = skipString(source, index)
      continue
    }
    if (source[index] === '{') depth += 1
    if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
    index += 1
  }
  return -1
}

function escapeForSource(value, quote) {
  return value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)
}

function extractDeclaredTests(source) {
  const declarations = new Map()
  let index = 0

  while (index < source.length) {
    const character = source[index]
    if (isWhitespace(character)) {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index)
      continue
    }
    if (isQuote(character)) {
      index = skipString(source, index)
      continue
    }
    if (!isIdentifierStart(character)) {
      index += 1
      continue
    }

    const identifier = readIdentifier(source, index)
    if (
      (identifier.value === 'test' || identifier.value === 'it') &&
      !isPropertyAccess(source, index)
    ) {
      const declaration = readTestDeclaration(source, identifier.end)
      if (declaration) {
        declarations.set(declaration.name, declaration)
        index = declaration.end
        continue
      }
    }
    index = identifier.end
  }

  return declarations
}

function readTestDeclaration(source, start) {
  let index = skipTrivia(source, start)
  if (source[index] === '(') return readStaticTestName(source, index + 1, 'run')
  if (source[index] !== '.') return undefined

  const modifier = readIdentifier(source, skipTrivia(source, index + 1))
  if (!modifier) return undefined
  index = skipTrivia(source, modifier.end)

  if (modifier.value === 'each') {
    if (source[index] !== '(') return undefined
    index = skipBalancedParentheses(source, index)
    index = skipTrivia(source, index)
    return source[index] === '(' ? readStaticTestName(source, index + 1, 'run') : undefined
  }

  if (!new Set(['only', 'skip', 'fixme', 'fail']).has(modifier.value) || source[index] !== '(') {
    return undefined
  }
  return readStaticTestName(source, index + 1, modifier.value)
}

function readStaticTestName(source, start, mode) {
  const literal = readStaticString(source, skipTrivia(source, start))
  if (!literal) return undefined
  return { name: literal.value, end: literal.end, mode }
}

function skipBalancedParentheses(source, start) {
  let depth = 0
  let index = start
  while (index < source.length) {
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index)
      continue
    }
    if (isQuote(source[index])) {
      index = skipString(source, index)
      continue
    }
    if (source[index] === '(') depth += 1
    if (source[index] === ')') {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return source.length
}

function readStaticString(source, start) {
  const quote = source[start]
  if (!isQuote(quote)) return undefined

  let index = start + 1
  let value = ''
  while (index < source.length) {
    const character = source[index]
    if (character === quote) return { value, end: index + 1 }
    if (quote === '`' && character === '$' && source[index + 1] === '{') return undefined
    if (character !== '\\') {
      value += character
      index += 1
      continue
    }

    const escape = source[index + 1]
    if (escape === undefined) return undefined
    const decoded = decodeEscape(source, index + 1)
    if (!decoded) return undefined
    value += decoded.value
    index = decoded.end
  }
  return undefined
}

function decodeEscape(source, start) {
  const escape = source[start]
  const simpleEscapes = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    0: '\0'
  }
  if (Object.hasOwn(simpleEscapes, escape)) {
    return { value: simpleEscapes[escape], end: start + 1 }
  }
  if (escape === 'x') {
    const value = Number.parseInt(source.slice(start + 1, start + 3), 16)
    return Number.isNaN(value) ? undefined : { value: String.fromCharCode(value), end: start + 3 }
  }
  if (escape === 'u') {
    const value = Number.parseInt(source.slice(start + 1, start + 5), 16)
    return Number.isNaN(value) ? undefined : { value: String.fromCharCode(value), end: start + 5 }
  }
  return { value: escape, end: start + 1 }
}

function skipTrivia(source, start) {
  let index = start
  while (index < source.length) {
    if (isWhitespace(source[index])) {
      index += 1
      continue
    }
    if (source.startsWith('//', index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith('/*', index)) {
      index = skipBlockComment(source, index)
      continue
    }
    return index
  }
  return index
}

function skipLineComment(source, start) {
  const newline = source.indexOf('\n', start + 2)
  return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source, start) {
  const closing = source.indexOf('*/', start + 2)
  return closing === -1 ? source.length : closing + 2
}

function skipString(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return source.length
}

function readIdentifier(source, start) {
  let end = start + 1
  while (end < source.length && isIdentifierPart(source[end])) end += 1
  return { value: source.slice(start, end), end }
}

function isPropertyAccess(source, index) {
  let previous = index - 1
  while (previous >= 0 && isWhitespace(source[previous])) previous -= 1
  return source[previous] === '.' || isIdentifierPart(source[previous])
}

function isIdentifierStart(character) {
  return typeof character === 'string' && /[A-Za-z_$]/u.test(character)
}

function isIdentifierPart(character) {
  return typeof character === 'string' && /[A-Za-z0-9_$]/u.test(character)
}

function isQuote(character) {
  return character === "'" || character === '"' || character === '`'
}

function isWhitespace(character) {
  return typeof character === 'string' && /\s/u.test(character)
}

function summarize(scenarios) {
  return [...coverageStatuses]
    .map(
      (status) => `${status}=${scenarios.filter((scenario) => scenario.status === status).length}`
    )
    .join(', ')
}
