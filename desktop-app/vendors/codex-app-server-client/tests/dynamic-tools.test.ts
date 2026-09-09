import { describe, expect, it, vi } from 'vitest'

import { DynamicToolsDispatcher } from '../src/dynamic-tools'
import { planAssertionsForTest } from './helpers/plan-assertion'

describe('DynamicToolsDispatcher', () => {
  it('dispatches by namespace and tool name without falling through to same-name tools', async () => {
    const dispatcher = new DynamicToolsDispatcher({ timeoutMs: 100 })
    dispatcher.register('load_workspace_dependencies', () => Promise.resolve({
      success: true,
      contentItems: [{ type: 'inputText', text: 'root' }]
    }))
    dispatcher.register(
      'load_workspace_dependencies',
      (args, context) => Promise.resolve({
        success: true,
        contentItems: [
          {
            type: 'inputText',
            text: `${context.namespace}:${JSON.stringify(args)}`
          }
        ]
      }),
      { namespace: 'codex_app' }
    )

    await expect(
      dispatcher.dispatch({
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        namespace: 'codex_app',
        tool: 'load_workspace_dependencies',
        arguments: { include: 'paths' }
      })
    ).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: 'codex_app:{"include":"paths"}'
        }
      ]
    })

    await expect(
      dispatcher.dispatch({
        namespace: 'missing_namespace',
        tool: 'load_workspace_dependencies',
        arguments: {}
      })
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: 'No dynamic tool handler registered for "load_workspace_dependencies".'
        }
      ]
    })
  })

  it('preserves protocol arguments even when they are null', async () => {
    const handler = vi.fn((args) => Promise.resolve({
      success: true,
      contentItems: [{ type: 'inputText' as const, text: JSON.stringify(args) }]
    }))
    const dispatcher = new DynamicToolsDispatcher({ handlers: { nullable: handler }, timeoutMs: 100 })

    const result = await dispatcher.dispatch({
      tool: 'nullable',
      arguments: null,
      input: { shouldNotBeUsed: true }
    })

    expect(handler).toHaveBeenCalledWith(null, expect.objectContaining({ toolName: 'nullable' }))
    expect(result).toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'null' }]
    })
  })

  it('keeps legacy toolName and input dispatch working', async () => {
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        legacy: (args, context) => Promise.resolve({
          success: true,
          contentItems: [{ type: 'inputText', text: `${context.toolName}:${JSON.stringify(args)}` }]
        })
      },
      timeoutMs: 100
    })

    await expect(dispatcher.dispatch({ toolName: 'legacy', input: { id: 'A' } })).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'legacy:{"id":"A"}' }]
    })
  })

  it('unregisters a specific namespace entry', async () => {
    const dispatcher = new DynamicToolsDispatcher({ timeoutMs: 100 })
    dispatcher.register('same', () => Promise.resolve({
      success: true,
      contentItems: [{ type: 'inputText', text: 'root' }]
    }))
    dispatcher.register(
      'same',
      () => Promise.resolve({
        success: true,
        contentItems: [{ type: 'inputText', text: 'namespaced' }]
      }),
      { namespace: 'codex_app' }
    )

    expect(dispatcher.unregister('same', { namespace: 'codex_app' })).toBe(true)
    expect(dispatcher.unregister('same', { namespace: 'codex_app' })).toBe(false)

    await expect(dispatcher.dispatch({ tool: 'same', arguments: {} })).resolves.toEqual({
      success: true,
      contentItems: [{ type: 'inputText', text: 'root' }]
    })
    await expect(
      dispatcher.dispatch({ namespace: 'codex_app', tool: 'same', arguments: {} })
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'No dynamic tool handler registered for "same".' }]
    })
  })

  it('returns stable snapshots and protocol specs for registered definitions only', () => {
    const dispatcher = new DynamicToolsDispatcher({ timeoutMs: 100 })
    dispatcher.registerTool('load_workspace_dependencies', {
      description: 'Load runtime paths.',
      inputSchema: { type: 'object', additionalProperties: false },
      deferLoading: true,
      execute: () => Promise.resolve({ success: true, contentItems: [] })
    })
    dispatcher.registerTool(
      'render_presentation',
      {
        description: 'Render a presentation.',
        namespaceDescription: 'Codex app tools',
        inputSchema: { type: 'object' },
        execute: () => Promise.resolve({ success: true, contentItems: [] })
      },
      { namespace: 'codex_app' }
    )
    dispatcher.register('handler_only', () => Promise.resolve({ success: true, contentItems: [] }))

    expect(dispatcher.snapshot()).toEqual([
      {
        namespace: null,
        name: 'load_workspace_dependencies',
        description: 'Load runtime paths.',
        inputSchema: { type: 'object', additionalProperties: false },
        deferLoading: true
      },
      {
        namespace: 'codex_app',
        name: 'render_presentation',
        description: 'Render a presentation.',
        inputSchema: { type: 'object' },
        namespaceDescription: 'Codex app tools'
      },
      {
        namespace: null,
        name: 'handler_only'
      }
    ])
    expect(dispatcher.snapshotDynamicToolSpecs()).toEqual([
      {
        type: 'function',
        name: 'load_workspace_dependencies',
        description: 'Load runtime paths.',
        inputSchema: { type: 'object', additionalProperties: false },
        deferLoading: true
      },
      {
        type: 'namespace',
        name: 'codex_app',
        description: 'Codex app tools',
        tools: [
          {
            type: 'function',
            name: 'render_presentation',
            description: 'Render a presentation.',
            inputSchema: { type: 'object' }
          }
        ]
      }
    ])
  })

  it('passes external abort signals through to handlers and returns a failed tool result', async () => {
    let handlerSawAbort = false
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        cancellable: (_args, context) =>
          new Promise((resolve) => {
            expect(context.signal).toBeDefined()
            const signal = context.signal as AbortSignal
            signal.addEventListener(
              'abort',
              () => {
                handlerSawAbort = signal.aborted
                resolve({
                  success: true,
                  contentItems: [
                    {
                      type: 'inputText',
                      text: signal.aborted ? 'handler-saw-abort' : 'handler-missed-abort'
                    }
                  ]
                })
              },
              { once: true }
            )
          })
      },
      timeoutMs: 1000
    })
    const controller = new AbortController()
    const resultPromise = dispatcher.dispatch(
      { tool: 'cancellable', arguments: {} },
      { signal: controller.signal }
    )

    controller.abort(new Error('turn cancelled'))

    await expect(resultPromise).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'turn cancelled' }]
    })
    expect(handlerSawAbort).toBe(true)
  })

  it('accepts a compatibility AbortSignal carried on params without advertising it as protocol', async () => {
    let handlerSawAbort = false
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        cancellable: (_args, context) =>
          new Promise((resolve) => {
            expect(context.signal).toBeDefined()
            const signal = context.signal as AbortSignal
            signal.addEventListener(
              'abort',
              () => {
                handlerSawAbort = true
                resolve({ success: true, contentItems: [] })
              },
              { once: true }
            )
          })
      },
      timeoutMs: 1000
    })
    const controller = new AbortController()
    const resultPromise = dispatcher.dispatch({
      tool: 'cancellable',
      arguments: {},
      signal: controller.signal
    } as never)

    controller.abort('params signal cancelled')

    await expect(resultPromise).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'params signal cancelled' }]
    })
    expect(handlerSawAbort).toBe(true)
  })

  it('does not execute handlers when the external signal is already aborted', async () => {
    const handler = vi.fn(() => Promise.resolve({ success: true, contentItems: [] }))
    const dispatcher = new DynamicToolsDispatcher({
      handlers: { cancellable: handler },
      timeoutMs: 1000
    })
    const controller = new AbortController()
    controller.abort('cancelled before dispatch')

    await expect(
      dispatcher.dispatch({ tool: 'cancellable', arguments: {} }, { signal: controller.signal })
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'cancelled before dispatch' }]
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('removes the external abort listener when a non-settling handler times out', async () => {
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        stalled: () => new Promise(() => undefined)
      },
      timeoutMs: 1
    })
    const controller = new AbortController()
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener')

    await expect(
      dispatcher.dispatch({ tool: 'stalled', arguments: {} }, { signal: controller.signal })
    ).resolves.toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Dynamic tool execution timed out after 1ms.' }]
    })
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('rejects duplicate registration for the same namespace and name', () => {
    const dispatcher = new DynamicToolsDispatcher()
    dispatcher.register('same', () => Promise.resolve({ success: true, contentItems: [] }), {
      namespace: 'codex_app'
    })

    expect(() =>
      dispatcher.register('same', () => Promise.resolve({ success: true, contentItems: [] }), {
        namespace: 'codex_app'
      })
    ).toThrow('Dynamic tool "codex_app.same" is already registered.')
  })

  it('D01 returns one successful native dynamic-tool result', async () => {
    const assertD01 = planAssertionsForTest('D01')
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        lookup: () =>
          Promise.resolve({
            success: true,
            contentItems: [{ type: 'inputText', text: 'TICK-42: open' }]
          })
      }
    })

    const result = await dispatcher.dispatch({ tool: 'lookup', arguments: { id: 'TICK-42' } })

    await assertD01('单个原生工具成功结果完整回传', () => {
      expect(result).toEqual({
        success: true,
        contentItems: [{ type: 'inputText', text: 'TICK-42: open' }]
      })
    })
  })

  it('D02 keeps sequential native dynamic-tool calls ordered and isolated', async () => {
    const assertD02 = planAssertionsForTest('D02')
    const calls: string[] = []
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        lookup: (args) => {
          calls.push(`lookup:${JSON.stringify(args)}`)
          return Promise.resolve({
            success: true,
            contentItems: [{ type: 'inputText' as const, text: 'open' }]
          })
        },
        weather: (args) => {
          calls.push(`weather:${JSON.stringify(args)}`)
          return Promise.resolve({
            success: true,
            contentItems: [{ type: 'inputText' as const, text: 'sunny' }]
          })
        }
      }
    })

    const first = await dispatcher.dispatch({ tool: 'lookup', arguments: { id: 'TICK-42' } })
    const second = await dispatcher.dispatch({ tool: 'weather', arguments: { city: 'Berlin' } })

    await assertD02('多个原生工具串行结果顺序稳定', () => {
      expect(calls).toEqual(['lookup:{"id":"TICK-42"}', 'weather:{"city":"Berlin"}'])
      expect(first.contentItems).toEqual([{ type: 'inputText', text: 'open' }])
      expect(second.contentItems).toEqual([{ type: 'inputText', text: 'sunny' }])
    })
  })

  it('D05 returns one failed native tool result when execution times out', async () => {
    const assertD05 = planAssertionsForTest('D05')
    const dispatcher = new DynamicToolsDispatcher({
      handlers: { stalled: () => new Promise(() => undefined) },
      timeoutMs: 1
    })

    const result = await dispatcher.dispatch({ tool: 'stalled', arguments: {} })

    await assertD05('工具超时返回单个失败结果', () => {
      expect(result).toEqual({
        success: false,
        contentItems: [
          { type: 'inputText', text: 'Dynamic tool execution timed out after 1ms.' }
        ]
      })
    })
  })

  it('D06 preserves an empty successful native tool output', async () => {
    const assertD06 = planAssertionsForTest('D06')
    const dispatcher = new DynamicToolsDispatcher({
      handlers: { empty: () => Promise.resolve({ success: true, contentItems: [] }) }
    })

    const result = await dispatcher.dispatch({ tool: 'empty', arguments: {} })

    await assertD06('空输出作为成功结果保留', () => {
      expect(result).toEqual({ success: true, contentItems: [] })
    })
  })

  it('D07 preserves a large successful native tool output without truncation', async () => {
    const assertD07 = planAssertionsForTest('D07')
    const largeOutput = 'x'.repeat(512 * 1024)
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        large: () =>
          Promise.resolve({
            success: true,
            contentItems: [{ type: 'inputText', text: largeOutput }]
          })
      }
    })

    const result = await dispatcher.dispatch({ tool: 'large', arguments: {} })

    await assertD07('超大输出完整保留并回传', () => {
      expect(result.contentItems).toEqual([{ type: 'inputText', text: largeOutput }])
      const firstItem = result.contentItems[0]
      expect(firstItem?.type).toBe('inputText')
      if (firstItem?.type !== 'inputText') {
        throw new Error('expected inputText output')
      }
      expect(firstItem.text).toHaveLength(largeOutput.length)
    })
  })

  it('D08 preserves Unicode and complex JSON native tool output exactly once', async () => {
    const assertD08 = planAssertionsForTest('D08')
    const payload = JSON.stringify({ text: '中文🙂�', nested: { values: [1, true, null] } })
    const dispatcher = new DynamicToolsDispatcher({
      handlers: {
        complex: () =>
          Promise.resolve({
            success: true,
            contentItems: [{ type: 'inputText', text: payload }]
          })
      }
    })

    const result = await dispatcher.dispatch({ tool: 'complex', arguments: {} })

    await assertD08('复杂 JSON 工具输出完整且只回传一次', () => {
      expect(result.contentItems).toEqual([{ type: 'inputText', text: payload }])
      expect(result.contentItems).toHaveLength(1)
    })
  })
})
