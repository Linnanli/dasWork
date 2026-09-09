import { expect } from 'vitest'

// @ts-expect-error Test-only JavaScript recorder has no declaration file.
import { createVitestPlanAssertionRecorder } from '../../../../scripts/lib/test-plan-assertions.mjs'

type Assertion = () => void | Promise<void>
type PlanAssertionRecorder = {
  planAssert(input: {
    scenarioId: string
    assertionId: string
    assertion: Assertion
  }): Promise<void>
}

const createPlanAssertionRecorder = createVitestPlanAssertionRecorder as unknown as (
  matcher: typeof expect
) => PlanAssertionRecorder
const planAssertionRecorder = createPlanAssertionRecorder(expect)

export function planAssertionsForTest(
  scenarioId: string
): (assertionId: string, assertion: Assertion) => Promise<void> {
  return (assertionId, assertion) =>
    planAssertionRecorder.planAssert({ scenarioId, assertionId, assertion })
}
