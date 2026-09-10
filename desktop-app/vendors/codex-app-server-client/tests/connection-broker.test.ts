import { describe, expect, it } from 'vitest'

import { AppServerClient } from '../src/client/app-server-client'
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
      expect(diagnostics.cancelledRequestCount).toBe(1)
      expect(diagnostics.lateResponseCount).toBe(1)
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

  it('routes registered host requests before thread owners while catalog requests remain pending', async () => {
    const physical = new MemoryTransport()
    const connection = new CodexAppServerConnection({
      transportFactory: () => physical
    })
    const unregister = connection.registerHostRequestHandler('currentTime/read', () => ({
      currentTimeAt: 1_800_000_000
    }))
    const catalogChannel = connection.createTransport()
    const threadChannel = connection.createTransport({ threadId: 'thread-owned' })
    const catalogReceived: JsonRpcMessage[] = []
    const threadReceived: JsonRpcMessage[] = []

    await Promise.all([catalogChannel.connect(), threadChannel.connect()])
    catalogChannel.on('message', (message) => catalogReceived.push(message))
    threadChannel.on('message', (message) => threadReceived.push(message))
    await catalogChannel.sendMessage({ id: 'local-catalog', method: 'plugin/installed' })

    const catalogWireRequest = physical.sentMessages.find(
      (message): message is Extract<JsonRpcMessage, { id: string | number; method: string }> =>
        'method' in message && message.method === 'plugin/installed'
    )
    expect(catalogWireRequest).toBeDefined()

    physical.emit({
      id: 'server-current-time',
      method: 'currentTime/read',
      params: { threadId: 'thread-owned' }
    })
    await Promise.resolve()

    expect(
      physical.sentMessages.find(
        (message) => 'id' in message && message.id === 'server-current-time'
      )
    ).toEqual({
      id: 'server-current-time',
      result: { currentTimeAt: 1_800_000_000 }
    })
    expect(threadReceived).toEqual([])
    expect(catalogReceived).toEqual([])

    physical.emit({ id: catalogWireRequest!.id, result: { plugins: [] } })
    expect(catalogReceived).toEqual([{ id: 'local-catalog', result: { plugins: [] } }])

    unregister()
    await Promise.all([catalogChannel.disconnect(), threadChannel.disconnect()])
    await connection.shutdown()
  })

  it('rejects registered host requests for inactive thread ids without invoking the handler', async () => {
    const physical = new MemoryTransport()
    const connection = new CodexAppServerConnection({
      transportFactory: () => physical
    })
    let calls = 0
    const unregister = connection.registerHostRequestHandler('currentTime/read', () => {
      calls += 1
      return { currentTimeAt: 1 }
    })
    const channel = connection.createTransport()

    await channel.connect()
    physical.emit({
      id: 'server-current-time',
      method: 'currentTime/read',
      params: { threadId: 'missing-thread' }
    })
    await Promise.resolve()

    expect(calls).toBe(0)
    expect(
      physical.sentMessages.find(
        (message) => 'id' in message && message.id === 'server-current-time'
      )
    ).toEqual({
      id: 'server-current-time',
      error: {
        code: -32002,
        message: 'Host capability request references an inactive thread.'
      }
    })

    unregister()
    await channel.disconnect()
    await connection.shutdown()
  })

  it('returns method-not-found for untargeted unregistered server requests', async () => {
    const physical = new MemoryTransport()
    const connection = new CodexAppServerConnection({
      transportFactory: () => physical
    })
    const channel = connection.createTransport()

    await channel.connect()
    physical.emit({ id: 'server-auth', method: 'account/chatgptAuthTokens/refresh' })
    await Promise.resolve()

    expect(
      physical.sentMessages.find((message) => 'id' in message && message.id === 'server-auth')
    ).toEqual({
      id: 'server-auth',
      error: {
        code: -32601,
        message: 'Method not found: account/chatgptAuthTokens/refresh'
      }
    })

    await channel.disconnect()
    await connection.shutdown()
  })

  it('does not attach a pre-aborted logical transport', async () => {
    const physical = new MemoryTransport()
    const connection = new CodexAppServerConnection({
      transportFactory: () => physical
    })
    const controller = new AbortController()
    controller.abort()
    const channel = connection.createTransport({ signal: controller.signal })

    await expect(channel.connect()).rejects.toThrow(/aborted/u)
    expect(connection.getDiagnostics()).toMatchObject({
      logicalChannelCount: 0,
      activeLeaseCount: 0,
      pendingRequestCount: 0
    })
    await connection.shutdown()
  })

  it('aborts an attached logical transport and tracks the cancelled late response once', async () => {
    const physical = new MemoryTransport()
    const connection = new CodexAppServerConnection({
      transportFactory: () => physical
    })
    const controller = new AbortController()
    const client = new AppServerClient(connection.createTransport({ signal: controller.signal }))

    await client.connect()
    const pending = client.request('plugin/installed')
    const outbound = await waitForSentRequest(physical, 'plugin/installed')
    expect(outbound).toBeDefined()

    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/u)
    expect(connection.getDiagnostics()).toMatchObject({
      logicalChannelCount: 0,
      activeLeaseCount: 0,
      pendingRequestCount: 0,
      cancelledRequestCount: 1,
      lateResponseCount: 0
    })

    physical.emit({ id: outbound.id, result: { plugins: [] } })
    expect(connection.getDiagnostics()).toMatchObject({
      cancelledRequestCount: 1,
      lateResponseCount: 1
    })

    await client.disconnect()
    await connection.shutdown()
  })
})

async function waitForSentRequest(
  transport: MemoryTransport,
  method: string
): Promise<Extract<JsonRpcMessage, { id: string | number; method: string }>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const outbound = transport.sentMessages.find(
      (message): message is Extract<JsonRpcMessage, { id: string | number; method: string }> =>
        'method' in message && message.method === method
    )
    if (outbound) {
      return outbound
    }
    await Promise.resolve()
  }
  throw new Error(`Timed out waiting for ${method}`)
}
