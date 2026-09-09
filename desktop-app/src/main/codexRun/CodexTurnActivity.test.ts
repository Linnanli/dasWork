import { describe, expect, it } from 'vitest'

import {
  codexTurnActivityFromNotification,
  codexTurnActivityFromServerRequest
} from './CodexTurnActivity'

describe('codexTurnActivityFromNotification', () => {
  const threadId = 'thread-activity'
  const turnId = 'turn-activity'

  it.each([
    'turn/started',
    'turn/completed',
    'thread/tokenUsage/updated',
    'thread/status/changed',
    'turn/moderationMetadata'
  ])('ignores lifecycle or metadata notification %s', (method) => {
    expect(codexTurnActivityFromNotification(method, { threadId, turnId })).toBeUndefined()
  })

  it('ignores the submitted user message lifecycle', () => {
    expect(
      codexTurnActivityFromNotification('item/started', {
        threadId,
        turnId,
        item: { id: 'user-message', type: 'userMessage' }
      })
    ).toBeUndefined()
  })

  it.each(['userMessage', 'hookPrompt', 'futureMetadataItem'])(
    'does not treat %s item lifecycle as model or tool activity',
    (itemType) => {
      expect(
        codexTurnActivityFromNotification('item/started', {
          threadId,
          turnId,
          item: { id: 'non-activity-item', type: itemType }
        })
      ).toBeUndefined()
    }
  )

  it.each([
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
  ])('recognizes the explicit %s work-item lifecycle', (itemType) => {
    expect(
      codexTurnActivityFromNotification('item/started', {
        threadId,
        turnId,
        item: { id: 'activity-item', type: itemType }
      })
    ).toEqual({ threadId, turnId })
  })

  it.each([
    ['item/started', { item: { id: 'assistant-message', type: 'agentMessage' } }],
    ['item/agentMessage/delta', { itemId: 'assistant-message', delta: 'hello' }],
    ['item/reasoning/textDelta', { itemId: 'reasoning', delta: 'checking' }],
    ['item/commandExecution/outputDelta', { itemId: 'command', delta: 'done' }],
    ['item/mcpToolCall/progress', { itemId: 'mcp', message: 'working' }],
    ['turn/plan/updated', { plan: [] }],
    ['turn/diff/updated', { diff: 'diff' }]
  ])('recognizes model or tool activity from %s', (method, params) => {
    expect(codexTurnActivityFromNotification(method, { threadId, turnId, ...params })).toEqual({
      threadId,
      turnId
    })
  })

  it('requires activity to identify its thread and turn', () => {
    expect(
      codexTurnActivityFromNotification('item/agentMessage/delta', {
        itemId: 'assistant-message',
        delta: 'hello'
      })
    ).toBeUndefined()
  })

  it.each([
    'model/rerouted',
    'model/safetyBuffering/updated',
    'model/verification',
    'rawResponseItem/completed',
    'rawResponse/completed',
    'hook/started',
    'hook/completed'
  ])('recognizes turn-scoped model or hook activity from %s', (method) => {
    expect(codexTurnActivityFromNotification(method, { threadId, turnId })).toEqual({
      threadId,
      turnId
    })
  })

  it('recognizes a turn-scoped dynamic tool server request', () => {
    expect(
      codexTurnActivityFromServerRequest('item/tool/call', {
        threadId,
        turnId,
        callId: 'dynamic-tool-call'
      })
    ).toEqual({ threadId, turnId })
    expect(
      codexTurnActivityFromServerRequest('item/commandExecution/requestApproval', {
        threadId,
        turnId
      })
    ).toBeUndefined()
  })
})
