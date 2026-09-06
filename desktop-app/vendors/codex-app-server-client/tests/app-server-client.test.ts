import { describe, expect, it, vi } from 'vitest'

import { AppServerClient } from '../src/client/app-server-client'
import type {
  CodexTransport,
  CodexTransportEventMap,
  JsonRpcMessage
} from '../src/client/transport'

class MemoryTransport implements CodexTransport {
  readonly sentMessages: JsonRpcMessage[] = []
  private readonly listeners = {
    message: new Set<CodexTransportEventMap['message']>(),
    error: new Set<CodexTransportEventMap['error']>(),
    close: new Set<CodexTransportEventMap['close']>()
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  sendMessage(message: JsonRpcMessage): Promise<void> {
    this.sentMessages.push(message)
    return Promise.resolve()
  }

  async sendNotification(_method: string, _params?: unknown): Promise<void> {}

  on<K extends keyof CodexTransportEventMap>(
    event: K,
    listener: CodexTransportEventMap[K]
  ): () => void {
    const listeners = this.listeners[event] as Set<CodexTransportEventMap[K]>
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  emit(message: JsonRpcMessage): void {
    for (const listener of this.listeners.message) {
      listener(message)
    }
  }
}

describe('AppServerClient', () => {
  it('serializes asynchronous notifications received in one transport tick', async () => {
    const transport = new MemoryTransport()
    const client = new AppServerClient(transport)
    const firstNotification = deferred<void>()
    const events: string[] = []
    client.onAnyNotification(async (method) => {
      events.push(`${method}:started`)
      if (method === 'item/started') {
        await firstNotification.promise
      }
      events.push(`${method}:finished`)
    })
    await client.connect()

    transport.emit({ method: 'item/started', params: { itemId: 'message-1' } })
    transport.emit({ method: 'item/agentMessage/delta', params: { itemId: 'message-1' } })

    await vi.waitFor(() => expect(events).toEqual(['item/started:started']))
    firstNotification.resolve()
    await vi.waitFor(() =>
      expect(events).toEqual([
        'item/started:started',
        'item/started:finished',
        'item/agentMessage/delta:started',
        'item/agentMessage/delta:finished'
      ])
    )
  })

  it('rejects an unknown inbound server request instead of leaving the connection pending', async () => {
    const transport = new MemoryTransport()
    const client = new AppServerClient(transport)
    await client.connect()

    transport.emit({
      id: 17,
      method: 'future/server/request',
      params: { untrusted: 'payload' }
    })

    await vi.waitFor(() =>
      expect(transport.sentMessages).toContainEqual({
        id: 17,
        error: {
          code: -32601,
          message: 'Method not found: future/server/request'
        }
      })
    )
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
