import { describe, expect, it } from 'vitest'

import {
  type CodexEventMapperInput,
  type CodexRunEvent,
  CodexRunEventNormalizer
} from '../src'
import { planAssertionsForTest } from './helpers/plan-assertion'

function mapEvents(events: readonly CodexEventMapperInput[]): CodexRunEvent[] {
  const normalizer = new CodexRunEventNormalizer()
  return events.flatMap((event) => normalizer.map(event))
}

function completedTurn(status: 'completed' | 'failed' = 'completed', error: unknown = null) {
  return {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        items: [],
        itemsView: 'notLoaded',
        status,
        error,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1
      }
    }
  }
}

describe('CodexRunEventNormalizer native runtime regressions', () => {
  it('D03 marks a non-zero command exit as failed without masking the final answer', async () => {
    const assertD03 = planAssertionsForTest('D03')
    const parts = mapEvents([
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      {
        method: 'item/started',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'command-1',
            command: 'rg missing-file',
            cwd: '/project',
            processId: null,
            source: 'agent',
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null
          }
        }
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'commandExecution',
            id: 'command-1',
            command: 'rg missing-file',
            cwd: '/project',
            processId: 'pid-1',
            source: 'agent',
            status: 'completed',
            commandActions: [],
            aggregatedOutput: 'No files matched.',
            exitCode: 1,
            durationMs: 10
          }
        }
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'answer-1',
          delta: 'The command found no matching files.'
        }
      },
      completedTurn()
    ])

    await assertD03('非零退出映射失败工具结果且保留回答', () => {
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: 'tool-result',
          toolCallId: 'command-1',
          isError: true
        })
      )
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: 'text-delta',
          id: 'answer-1',
          delta: 'The command found no matching files.'
        })
      )
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'completed' }
        })
      )
    })
  })

  it('C15/D10 safely closes a completion-before-call sequence once', async () => {
    const assertC15 = planAssertionsForTest('C15')
    const assertD10 = planAssertionsForTest('D10')
    const parts = mapEvents([
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            type: 'dynamicToolCall',
            id: 'tool-out-of-order',
            namespace: null,
            tool: 'lookup',
            arguments: { id: 'TICK-42' },
            status: 'completed',
            contentItems: [{ type: 'inputText', text: 'open' }],
            success: true
          }
        }
      },
      {
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'tool-out-of-order',
          tool: 'lookup',
          arguments: { id: 'TICK-42' }
        }
      },
      completedTurn()
    ])

    const callIndex = parts.findIndex(
      (part) => part.type === 'tool-call' && part.toolCallId === 'tool-out-of-order'
    )
    const resultIndex = parts.findIndex(
      (part) => part.type === 'tool-result' && part.toolCallId === 'tool-out-of-order'
    )
    const assertSafeTerminal = (): void => {
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(resultIndex).toBeGreaterThan(callIndex)
      expect(parts[resultIndex]).toMatchObject({ type: 'tool-result', isError: true })
      expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(1)
      expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
    }

    await assertC15('保留可见内容并显示单一终态', assertSafeTerminal)
    await assertC15('terminal 只结算一次且 Composer 恢复', assertSafeTerminal)
    await assertC15('无自动重试、额外请求或迟到事件应用', assertSafeTerminal)
    await assertD10('非法顺序安全关闭为单个错误结果与单终态', assertSafeTerminal)
  })

  it('D09 closes a native tool call that never completes when the turn ends', async () => {
    const assertD09 = planAssertionsForTest('D09')
    const parts = mapEvents([
      {
        method: 'item/tool/call',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          callId: 'tool-stalled',
          tool: 'lookup',
          arguments: {}
        }
      },
      completedTurn()
    ])

    await assertD09('未完成工具由 turn/completed 以错误结果关闭', () => {
      expect(parts.filter((part) => part.type === 'tool-result')).toEqual([
        expect.objectContaining({
          type: 'tool-result',
          toolCallId: 'tool-stalled',
          isError: true,
          result: { error: 'Tool call did not complete before turn ended' }
        })
      ])
      expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
    })
  })

  it('D11 ignores a duplicated native tool completion', async () => {
    const assertD11 = planAssertionsForTest('D11')
    const started = {
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          type: 'dynamicToolCall',
          id: 'tool-dedup',
          namespace: null,
          tool: 'lookup',
          arguments: {},
          status: 'inProgress',
          contentItems: null,
          success: null
        }
      }
    }
    const completed = {
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: {
          ...started.params.item,
          status: 'completed',
          contentItems: [{ type: 'inputText', text: 'open' }],
          success: true
        }
      }
    }
    const parts = mapEvents([started, completed, completed, completedTurn()])

    await assertD11('恢复步骤不重复工具生命周期结果', () => {
      expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1)
      expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(1)
      expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
    })
  })

  it('C18 emits one error and one finish for a failed turn with an error message', async () => {
    const assertC18 = planAssertionsForTest('C18')
    const parts = mapEvents([
      completedTurn('failed', {
        message: 'The free quota has been exhausted.',
        codexErrorInfo: 'usageLimitExceeded',
        additionalDetails: null
      })
    ])
    const error = parts.find((part) => part.type === 'error')
    const assertSingleTerminal = (): void => {
      expect(parts.map((part) => part.type)).toEqual(['stream-start', 'error', 'finish'])
      expect(error?.error).toMatchObject({ message: 'The free quota has been exhausted.' })
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1)
    }

    await assertC18('terminal 只结算一次且 Composer 恢复', assertSingleTerminal)
    await assertC18('保留可见内容并显示单一终态', assertSingleTerminal)
    await assertC18('无自动重试、额外请求或迟到事件应用', assertSingleTerminal)
  })

  it('C19 emits one fallback error and one finish when failed turn text is absent', async () => {
    const assertC19 = planAssertionsForTest('C19')
    const parts = mapEvents([completedTurn('failed')])
    const error = parts.find((part) => part.type === 'error')
    const assertSingleTerminal = (): void => {
      expect(parts.map((part) => part.type)).toEqual(['stream-start', 'error', 'finish'])
      expect(error?.error).toMatchObject({
        message: 'The model request failed before completion.'
      })
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1)
    }

    await assertC19('terminal 只结算一次且 Composer 恢复', assertSingleTerminal)
    await assertC19('保留可见内容并显示单一终态', assertSingleTerminal)
    await assertC19('无自动重试、额外请求或迟到事件应用', assertSingleTerminal)
  })
})
