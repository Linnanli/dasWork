import { describe, expect, it, vi } from 'vitest'

import {
  CodexAppServerConnection,
  type CodexTransport,
  type CodexTransportEventMap,
  type JsonRpcMessage
} from '@dascowork/codex-app-server-client'

import { HostCodexConnection, redactAppServerDebugPacket } from './HostCodexConnection'

class FakePhysicalTransport implements CodexTransport {
  readonly sentMessages: JsonRpcMessage[] = []
  readonly requests: Array<Extract<JsonRpcMessage, { id: string | number; method: string }>> = []
  readonly notifications: Array<{ method: string; params?: unknown }> = []
  private readonly closeListeners = new Set<CodexTransportEventMap['close']>()
  private readonly errorListeners = new Set<CodexTransportEventMap['error']>()
  private readonly messageListeners = new Set<CodexTransportEventMap['message']>()

  async connect(): Promise<void> {
    await Promise.resolve()
  }

  async disconnect(): Promise<void> {
    await Promise.resolve()
  }

  async sendMessage(message: JsonRpcMessage): Promise<void> {
    this.sentMessages.push(message)
    if (!('method' in message) || !('id' in message)) return
    this.requests.push(message)
    queueMicrotask(() => {
      this.emitMessage({
        id: message.id,
        result: message.method === 'thread/list' ? { data: [], nextCursor: null } : {}
      })
    })
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params })
  }

  on<K extends keyof CodexTransportEventMap>(
    event: K,
    listener: CodexTransportEventMap[K]
  ): () => void {
    if (event === 'message') {
      this.messageListeners.add(listener as CodexTransportEventMap['message'])
      return () => this.messageListeners.delete(listener as CodexTransportEventMap['message'])
    }
    if (event === 'error') {
      this.errorListeners.add(listener as CodexTransportEventMap['error'])
      return () => this.errorListeners.delete(listener as CodexTransportEventMap['error'])
    }
    this.closeListeners.add(listener as CodexTransportEventMap['close'])
    return () => this.closeListeners.delete(listener as CodexTransportEventMap['close'])
  }

  closeUnexpectedly(): void {
    for (const listener of this.closeListeners) listener(1, null)
  }

  emitMessage(message: JsonRpcMessage): void {
    for (const listener of this.messageListeners) listener(message)
  }
}

const launch = {
  command: '/test/codex',
  args: ['app-server', '--listen', 'stdio://'],
  displayBinary: '/test/codex app-server --listen stdio://'
}

describe('HostCodexConnection', () => {
  it('redacts credentials before protocol packets reach desktop diagnostics', () => {
    const packet = redactAppServerDebugPacket({
      direction: 'inbound',
      message: {
        method: 'turn/started',
        params: {
          api_key: 'sk-live-1234567890',
          providerHeaders: { authorization: 'Bearer rk-live-1234567890' },
          nested: ['pk-live-1234567890', 'authorization=Bearer sk-text-1234567890']
        }
      }
    })

    const serialized = JSON.stringify(packet)
    expect(serialized).toContain('"method":"turn/started"')
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toMatch(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/u)
  })

  it('redacts prompts and dynamic-tool arguments before protocol packets reach desktop diagnostics', () => {
    const packet = redactAppServerDebugPacket({
      direction: 'outbound',
      message: {
        id: 7,
        method: 'turn/start',
        params: {
          input: [{ type: 'text', text: 'private user prompt' }],
          developerInstructions: 'private developer instruction'
        }
      }
    })
    const toolPacket = redactAppServerDebugPacket({
      direction: 'inbound',
      message: {
        id: 8,
        method: 'item/tool/call',
        params: {
          tool: 'desktop_tool',
          arguments: { query: 'private tool argument' }
        }
      }
    })

    const serialized = JSON.stringify([packet, toolPacket])
    expect(serialized).toContain('"method":"turn/start"')
    expect(serialized).toContain('"method":"item/tool/call"')
    expect(serialized).toContain('[redacted]')
    expect(serialized).not.toContain('private user prompt')
    expect(serialized).not.toContain('private developer instruction')
    expect(serialized).not.toContain('private tool argument')
  })

  it('performs a fresh canonical handshake after the physical transport restarts', async () => {
    const physicalTransports: FakePhysicalTransport[] = []
    const connection = new CodexAppServerConnection({
      transportFactory: () => {
        const transport = new FakePhysicalTransport()
        physicalTransports.push(transport)
        return transport
      }
    })
    const host = new HostCodexConnection(launch, connection, async () => '0.148.0-alpha.21')

    const firstLease = await host.acquire()
    await firstLease.disconnect()
    physicalTransports[0].closeUnexpectedly()

    const recoveredLease = await host.acquire()
    await recoveredLease.disconnect()

    expect(physicalTransports).toHaveLength(2)
    for (const transport of physicalTransports) {
      expect(transport.requests.map((request) => request.method)).toEqual(['initialize'])
      expect(transport.requests[0]?.params).toMatchObject({
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      })
      expect(transport.notifications.map((notification) => notification.method)).toEqual([
        'initialized'
      ])
    }
    expect(host.diagnostics()?.generation).toBe(1)
  })

  it('answers currentTime/read as a host capability for active threads', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-09T12:00:07.000Z'))
      const physical = new FakePhysicalTransport()
      const connection = new CodexAppServerConnection({
        transportFactory: () => physical
      })
      const host = new HostCodexConnection(launch, connection, async () => '0.148.0-alpha.21')

      const client = await host.acquire('thread-clock')
      physical.emitMessage({
        id: 'server-current-time',
        method: 'currentTime/read',
        params: { threadId: 'thread-clock' }
      })
      await Promise.resolve()

      expect(
        physical.sentMessages.find(
          (message) => 'id' in message && message.id === 'server-current-time'
        )
      ).toEqual({
        id: 'server-current-time',
        result: { currentTimeAt: 1_788_955_207 }
      })

      await client.disconnect()
      await host.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })
})
