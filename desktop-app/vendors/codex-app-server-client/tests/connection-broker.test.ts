import { describe, expect, it } from 'vitest'

import { CodexAppServerConnection } from '../src/client/app-server-connection'
import type {
  CodexTransport,
  CodexTransportEventMap,
  JsonRpcMessage
} from '../src/client/transport'
import { planAssertionsForTest } from './helpers/plan-assertion'

class MemoryTransport implements CodexTransport {
  readonly sentMessages: JsonRpcMessage[] = []
  readonly listeners = {
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

describe('CodexAppServerConnection', () => {
  it('G08 isolates five concurrent logical channels and one cancelled request', async () => {
    const assertG08 = planAssertionsForTest('G08')
    const physical = new MemoryTransport()
    let physicalConnections = 0
    const connection = new CodexAppServerConnection({
      transportFactory: () => {
        physicalConnections += 1
        return physical
      }
    })
    const channels = Array.from({ length: 5 }, (_, index) =>
      connection.createTransport({ threadId: `thread-${index + 1}` })
    )
    const received = channels.map(() => [] as JsonRpcMessage[])

    await Promise.all(channels.map((channel) => channel.connect()))
    channels.forEach((channel, index) => {
      channel.on('message', (message) => received[index]?.push(message))
    })
    await Promise.all(
      channels.map((channel, index) =>
        channel.sendMessage({
          id: 100 + index,
          method: 'thread/read',
          params: { threadId: `thread-${index + 1}`, secret: `secret-${index + 1}` }
        })
      )
    )

    await assertG08('跨对话与信任边界隔离', () => {
      expect(physicalConnections).toBe(1)
      expect(connection.getDiagnostics()).toMatchObject({
        physicalConnectionActive: true,
        logicalChannelCount: 5,
        pendingRequestCount: 5,
        threadOwnerCount: 5,
        activeLeaseCount: 5
      })
    })

    channels[4]?.cancelRequest(104)
    for (const message of physical.sentMessages) {
      if ('id' in message && message.id !== undefined) {
        physical.emit({ id: message.id, result: { wireId: message.id } })
      }
    }

    expect(received.slice(0, 4)).toEqual([
      [{ id: 100, result: { wireId: 1 } }],
      [{ id: 101, result: { wireId: 2 } }],
      [{ id: 102, result: { wireId: 3 } }],
      [{ id: 103, result: { wireId: 4 } }]
    ])
    expect(received[4]).toEqual([])
    const diagnostics = connection.getDiagnostics()
    await assertG08('诊断可关联而不泄露密钥', () => {
      expect(typeof diagnostics.generation).toBe('number')
      expect(diagnostics.pendingRequestCount).toBe(0)
      expect(JSON.stringify(diagnostics)).not.toContain('secret-')
      expect(JSON.stringify(diagnostics)).not.toContain('thread-')
    })

    await Promise.all(channels.map((channel) => channel.disconnect()))
    await assertG08('资源、并发和终态无残留', () => {
      expect(connection.getDiagnostics()).toMatchObject({
        logicalChannelCount: 0,
        pendingRequestCount: 0,
        threadOwnerCount: 0,
        turnOwnerCount: 0,
        continuationCount: 0,
        activeLeaseCount: 0
      })
    })
    await connection.shutdown()
  })
})
