import { describe, expect, it, vi } from 'vitest'

const nativeState = vi.hoisted(() => ({
  start: vi.fn(),
  listModels: vi.fn(async () => []),
  shutdown: vi.fn(async () => undefined)
}))

vi.mock('./NativeCodexRunDriver', () => ({
  NativeCodexRunDriver: class {
    start(...args: unknown[]): unknown {
      return nativeState.start(...args)
    }

    listModels(): Promise<never[]> {
      return nativeState.listModels()
    }

    shutdown(): Promise<void> {
      return nativeState.shutdown()
    }
  }
}))

import { createNativeCodexRunDriver } from './CodexRunDriver'

describe('createNativeCodexRunDriver', () => {
  it('forwards fresh Goal framing to the native input adapter path', async () => {
    nativeState.start.mockReturnValueOnce({
      session: Promise.resolve(undefined),
      events: []
    })
    const driver = createNativeCodexRunDriver({
      command: '/test/codex',
      args: ['app-server', '--listen', 'stdio://'],
      displayBinary: '/test/codex app-server --listen stdio://'
    })

    await driver.start({
      request: {
        id: 'request-1',
        body: {},
        messages: [{ id: 'message-1', role: 'user', parts: [{ type: 'text', text: '目标' }] }]
      } as never,
      modelId: 'test-model',
      abortSignal: new AbortController().signal,
      goalFirstTurnObjective: '完成迁移'
    })

    expect(nativeState.start).toHaveBeenCalledWith(
      expect.objectContaining({ goalFirstTurnObjective: '完成迁移', goalControl: false })
    )
  })
})
