import { describe, expect, it, vi } from 'vitest'

import {
  CodexCommandClient,
  type CodexCommandJsonRpcClientLike
} from '../src/command-client'
import type { CommandExecOutputDeltaNotification } from '../src/protocol/app-server-protocol/v2/CommandExecOutputDeltaNotification'

describe('CodexCommandClient', () => {
  it('drains queued output notifications before finalizing command output', async () => {
    const notificationDrain = deferred<void>()
    const outputHandlers = new Set<(params: unknown) => void | Promise<void>>()
    const request = vi.fn((method: string, _params?: unknown, _timeoutMs?: number) => {
      if (method === 'initialize') {
        return Promise.resolve({ serverInfo: { name: 'test', version: '1.0.0' } })
      }
      if (method === 'command/exec/write') {
        return Promise.resolve({})
      }
      if (method === 'command/exec') {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
      }
      return Promise.reject(new Error(`Unexpected request: ${method}`))
    })
    const fakeClient: CodexCommandJsonRpcClientLike = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      notification: () => Promise.resolve(),
      onNotification: (method, handler) => {
        if (method === 'command/exec/outputDelta') {
          outputHandlers.add(handler)
        }
        return () => outputHandlers.delete(handler)
      },
      request: <T = unknown>(method: string, params?: unknown, timeoutMs?: number) =>
        request(method, params, timeoutMs) as Promise<T>,
      waitForQueuedNotifications: async () => {
        await notificationDrain.promise
        const notification: CommandExecOutputDeltaNotification = {
          processId: processIdFromExecRequest(request),
          stream: 'stdout',
          deltaBase64: Buffer.from('staged output').toString('base64'),
          capReached: false
        }
        for (const handler of outputHandlers) {
          await handler(notification)
        }
      }
    }
    const client = new CodexCommandClient({ createClient: () => fakeClient })

    const execution = client.exec({ command: ['git', 'status'], stdin: 'patch data' })
    const settled = vi.fn()
    void execution.then(settled)
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('command/exec/write', expect.anything(), undefined)
    )
    expect(settled).not.toHaveBeenCalled()

    notificationDrain.resolve()
    await expect(execution).resolves.toMatchObject({ stdout: 'staged output', exitCode: 0 })
  })
})

function processIdFromExecRequest(request: ReturnType<typeof vi.fn>): string {
  const call = request.mock.calls.find(([method]) => method === 'command/exec')
  const params = call?.[1] as { processId?: unknown } | undefined
  if (typeof params?.processId !== 'string') {
    throw new Error('Missing command process ID')
  }
  return params.processId
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
