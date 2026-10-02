import { describe, expect, it } from 'vitest'

import { CodexRunEventNormalizer } from '../src/run-events/CodexRunEventNormalizer'
import { toolInvocationForItem, userMessageCompareKey } from '../src/protocol/shared-item-extractors'
import { normalizedFailedTurnError } from '../src/turn-error'

describe('Codex 0.158 protocol compatibility', () => {
  it('keeps completed sub-agent activity in the live tool stream', () => {
    const normalizer = new CodexRunEventNormalizer()
    const item = {
      type: 'subAgentActivity',
      id: 'subagent-completed',
      kind: 'completed',
      agentThreadId: 'agent-thread',
      agentPath: '/root/agent'
    }
    const params = { threadId: 'thread', turnId: 'turn', item }

    const events = [
      ...normalizer.map({ method: 'item/started', params }),
      ...normalizer.map({ method: 'item/completed', params })
    ]

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-call',
      toolCallId: item.id,
      toolName: 'codex_sub_agent_activity'
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      toolCallId: item.id,
      result: { item }
    }))
  })

  it('preserves function output and distinguishes file-backed images', () => {
    const output = { type: 'functionCallOutput' as const, id: 'output', name: 'lookup', namespace: 'codex_app', output: 'done' }
    expect(toolInvocationForItem(output)).toMatchObject({
      toolName: 'codex_function_call_output',
      input: { name: 'lookup', namespace: 'codex_app' },
      result: { item: output }
    })

    const message = { type: 'userMessage' as const, id: 'message', clientId: null }
    expect(userMessageCompareKey({ ...message, content: [{ type: 'image', fileId: 'file-1' }] })).not.toBe(
      userMessageCompareKey({ ...message, content: [{ type: 'image', url: 'https://example.test/image.png' }] })
    )
  })

  it('preserves misalignment details when normalizing failed turns', () => {
    const misalignment = { errorType: 'policy', detailedExplanation: 'Further input is needed.', steer: null }
    expect(normalizedFailedTurnError('failed', {
      message: 'Cannot continue.',
      codexErrorInfo: null,
      additionalDetails: null,
      misalignment
    })?.misalignment).toEqual(misalignment)
  })
})
