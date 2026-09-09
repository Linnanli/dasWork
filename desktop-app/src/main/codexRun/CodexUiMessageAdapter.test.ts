import { describe, expect, it } from 'vitest'

import { CodexRunEventNormalizer } from '@dascowork/codex-app-server-client'
import { createVitestPlanAssertionRecorder } from '../../../scripts/lib/test-plan-assertions.mjs'
import { CodexUiMessageAdapter } from './CodexUiMessageAdapter'

const { planAssert } = createVitestPlanAssertionRecorder(expect)

describe('CodexUiMessageAdapter', () => {
  it('D04 maps a failed native dynamic tool to one output-error chunk', async () => {
    const normalizer = new CodexRunEventNormalizer()
    const adapter = new CodexUiMessageAdapter()
    const startedItem = {
      type: 'dynamicToolCall',
      id: 'tool-failed',
      namespace: null,
      tool: 'lookup',
      arguments: { id: 'TICK-42' },
      status: 'inProgress',
      contentItems: null,
      success: null
    }
    const chunks = [
      {
        method: 'item/started',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: startedItem }
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            ...startedItem,
            status: 'failed',
            contentItems: [{ type: 'inputText', text: 'upstream rejected the request' }],
            success: false
          }
        }
      }
    ].flatMap((event) => normalizer.map(event).flatMap((part) => adapter.map(part)))

    await planAssert({
      scenarioId: 'D04',
      assertionId: '失败动态工具映射为单个 output-error',
      assertion: () => {
        expect(chunks.filter((chunk) => chunk.type === 'tool-output-error')).toEqual([
          expect.objectContaining({
            type: 'tool-output-error',
            toolCallId: 'tool-failed',
            providerExecuted: true,
            dynamic: true
          })
        ])
      }
    })
  })
})
