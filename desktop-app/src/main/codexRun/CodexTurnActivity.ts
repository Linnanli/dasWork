export type CodexTurnActivityEvent = {
  threadId: string
  turnId: string
}

const activityNotificationMethods = new Set([
  'hook/completed',
  'hook/started',
  'item/agentMessage/delta',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/plan/delta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/tool/callDelta',
  'item/tool/callFinished',
  'item/tool/callStarted',
  'model/rerouted',
  'model/safetyBuffering/updated',
  'model/verification',
  'rawResponse/completed',
  'rawResponseItem/completed',
  'turn/diff/updated',
  'turn/plan/updated'
])

const activityItemTypes = new Set([
  'agentMessage',
  'plan',
  'reasoning',
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'sleep',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction'
])

/**
 * Classifies only turn-scoped model and tool work as liveness. Generic stream
 * setup, token accounting, thread metadata, and the submitted user message do
 * not prove that the model is still making progress.
 */
export function codexTurnActivityFromNotification(
  method: string,
  params: unknown
): CodexTurnActivityEvent | undefined {
  if (!isRecord(params)) return undefined

  if (method === 'item/started' || method === 'item/completed') {
    const item = params['item']
    const itemType = isRecord(item) ? item['type'] : undefined
    if (typeof itemType !== 'string' || !activityItemTypes.has(itemType)) {
      return undefined
    }
  } else if (!activityNotificationMethods.has(method)) {
    return undefined
  }

  return turnScopedActivity(params)
}

export function codexTurnActivityFromServerRequest(
  method: string,
  params: unknown
): CodexTurnActivityEvent | undefined {
  return method === 'item/tool/call' ? turnScopedActivity(params) : undefined
}

function turnScopedActivity(params: unknown): CodexTurnActivityEvent | undefined {
  if (!isRecord(params)) return undefined
  const threadId = nonEmptyString(params['threadId'])
  const turnId = nonEmptyString(params['turnId'])
  return threadId && turnId ? { threadId, turnId } : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
