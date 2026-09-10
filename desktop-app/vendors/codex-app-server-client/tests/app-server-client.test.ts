import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppServerClient } from '../src/client/app-server-client'
import { CodexRequestCancelledError } from '../src/errors'
import type {
  CodexTransport,
  CodexTransportEventMap,
  JsonRpcMessage
} from '../src/client/transport'

class MemoryTransport implements CodexTransport {
  readonly sentMessages: JsonRpcMessage[] = []
  readonly cancelledRequestIds: Array<string | number> = []
  sendError: unknown
  private readonly listeners = {
    message: new Set<CodexTransportEventMap['message']>(),
    error: new Set<CodexTransportEventMap['error']>(),
    close: new Set<CodexTransportEventMap['close']>()
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  sendMessage(message: JsonRpcMessage): Promise<void> {
    if (this.sendError) {
      return Promise.reject(
        this.sendError instanceof Error ? this.sendError : new Error('Transport send failed')
      )
    }
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

  emitError(error: unknown): void {
    for (const listener of this.listeners.error) {
      listener(error)
    }
  }

  emitClose(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    for (const listener of this.listeners.close) {
      listener(code, signal)
    }
  }

  cancelRequest(id: string | number): void {
    this.cancelledRequestIds.push(id)
  }
}

describe('AppServerClient', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['plugin/installed', 'app/installed'])(
    'lets app-server own the %s request lifetime by default',
    async (method) => {
      vi.useFakeTimers()
      const transport = new MemoryTransport()
      const client = new AppServerClient(transport)
      await client.connect()

      const request = client.request<{ items: unknown[] }>(method)
      const settled = vi.fn()
      void request.then(settled, settled)

      await vi.advanceTimersByTimeAsync(120_000)

      expect(settled).not.toHaveBeenCalled()
      const outbound = transport.sentMessages[0]
      expect(outbound).toMatchObject({ method })
      if (!outbound || !('id' in outbound) || outbound.id === undefined) {
        throw new Error('Expected an outbound JSON-RPC request')
      }

      transport.emit({ id: outbound.id, result: { items: [] } })
      await expect(request).resolves.toEqual({ items: [] })
    }
  )

  it('still enforces an explicitly configured request deadline', async () => {
    vi.useFakeTimers()
    const transport = new MemoryTransport()
    const client = new AppServerClient(transport, { requestTimeoutMs: 1_000 })
    await client.connect()

    const request = client.request('app/installed')
    const outbound = transport.sentMessages[0]
    if (!outbound || !('id' in outbound) || outbound.id === undefined) {
      throw new Error('Expected an outbound JSON-RPC request')
    }
    const rejection = expect(request).rejects.toMatchObject({
      name: 'CodexRequestDeadlineExceededError',
      code: 'app_server_request_deadline_exceeded',
      message: 'Request timed out: app/installed'
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
    expect(transport.cancelledRequestIds).toEqual([outbound.id])
  })

  it('treats a zero request timeout as no client deadline', async () => {
    vi.useFakeTimers()
    const transport = new MemoryTransport()
    const client = new AppServerClient(transport, { requestTimeoutMs: 0 })
    await client.connect()

    const request = client.request('plugin/installed')
    const settled = vi.fn()
    void request.then(settled, settled)

    await vi.advanceTimersByTimeAsync(120_000)

    expect(settled).not.toHaveBeenCalled()
    expect(transport.cancelledRequestIds).toEqual([])
    const outbound = transport.sentMessages[0]
    if (!outbound || !('id' in outbound) || outbound.id === undefined) {
      throw new Error('Expected an outbound JSON-RPC request')
    }
    transport.emit({ id: outbound.id, result: { items: [] } })
    await expect(request).resolves.toEqual({ items: [] })
  })

  it('uses an independent drain timeout instead of the request deadline', async () => {
    vi.useFakeTimers()
    const transport = new MemoryTransport()
    const client = new AppServerClient(transport, { requestTimeoutMs: 1 })
    await client.connect()

    void client.request('plugin/installed', undefined, 0)
    const drained = client.waitForPendingRequests()

    await vi.advanceTimersByTimeAsync(1)
    const settled = vi.fn()
    void drained.then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    const outbound = transport.sentMessages[0]
    if (!outbound || !('id' in outbound) || outbound.id === undefined) {
      throw new Error('Expected an outbound JSON-RPC request')
    }
    transport.emit({ id: outbound.id, result: {} })

    await expect(drained).resolves.toBe(true)
  })

  it('reports redacted lifecycle metadata without request params', async () => {
    const transport = new MemoryTransport()
    const lifecycleEvents: unknown[] = []
    const client = new AppServerClient(transport, {
      onRequestLifecycle: (event) => lifecycleEvents.push(event)
    })
    await client.connect()

    const params = {
      cwd: '/Users/nallylin/private-project',
      accessToken: 'secret-token',
      pluginConfig: { authorization: 'Bearer secret-token' }
    }
    const request = client.request('plugin/installed', params)
    const outbound = transport.sentMessages[0]
    if (!outbound || !('id' in outbound) || outbound.id === undefined) {
      throw new Error('Expected an outbound JSON-RPC request')
    }
    transport.emit({ id: outbound.id, result: { items: [] } })

    await expect(request).resolves.toEqual({ items: [] })
    expect(lifecycleEvents).toContainEqual(
      expect.objectContaining({
        method: 'plugin/installed',
        phase: 'started',
        pendingCount: 1
      })
    )
    expect(lifecycleEvents).toContainEqual(
      expect.objectContaining({
        method: 'plugin/installed',
        phase: 'settled',
        outcome: 'completed',
        pendingCount: 0
      })
    )
    expect(JSON.stringify(lifecycleEvents)).not.toContain('secret-token')
    expect(JSON.stringify(lifecycleEvents)).not.toContain('/Users/nallylin/private-project')
    expect(JSON.stringify(lifecycleEvents)).not.toContain('pluginConfig')
  })

  it('classifies server errors separately from transport termination', async () => {
    const transport = new MemoryTransport()
    const lifecycleEvents: Array<{ outcome?: string }> = []
    const client = new AppServerClient(transport, {
      onRequestLifecycle: (event) => lifecycleEvents.push(event)
    })
    await client.connect()

    const request = client.request('app/installed')
    const outbound = transport.sentMessages[0]
    if (!outbound || !('id' in outbound) || outbound.id === undefined) {
      throw new Error('Expected an outbound JSON-RPC request')
    }
    transport.emit({
      id: outbound.id,
      error: { code: -32603, message: 'server failed' }
    })

    await expect(request).rejects.toMatchObject({
      name: 'JsonRpcError',
      code: -32603,
      message: 'server failed'
    })
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({ outcome: 'server-error' }))
    expect(transport.cancelledRequestIds).toEqual([])
  })

  it('classifies transport termination and settles each pending request once', async () => {
    const transport = new MemoryTransport()
    const lifecycleEvents: Array<{ outcome?: string }> = []
    const client = new AppServerClient(transport, {
      onRequestLifecycle: (event) => lifecycleEvents.push(event)
    })
    await client.connect()

    const request = client.request('plugin/installed')
    transport.emitClose(1)
    transport.emitError(new Error('late transport error'))

    await expect(request).rejects.toMatchObject({
      code: 'app_server_transport_closed'
    })
    expect(
      lifecycleEvents.filter((event) => event.outcome === 'transport-terminated')
    ).toHaveLength(1)
    expect(transport.cancelledRequestIds).toEqual([])
  })

  it('classifies logical transport cancellation as cancellation', async () => {
    const transport = new MemoryTransport()
    const lifecycleEvents: Array<{ outcome?: string }> = []
    const client = new AppServerClient(transport, {
      onRequestLifecycle: (event) => lifecycleEvents.push(event)
    })
    await client.connect()

    const request = client.request('plugin/installed')
    const cancellation = new CodexRequestCancelledError('Logical transport aborted.')
    transport.emitError(cancellation)

    await expect(request).rejects.toBe(cancellation)
    expect(lifecycleEvents).toContainEqual(expect.objectContaining({ outcome: 'cancelled' }))
    expect(lifecycleEvents).not.toContainEqual(
      expect.objectContaining({ outcome: 'transport-terminated' })
    )
  })

  it('classifies explicit disconnect as cancellation', async () => {
    const transport = new MemoryTransport()
    const client = new AppServerClient(transport)
    await client.connect()

    const request = client.request('plugin/installed')
    const outbound = transport.sentMessages[0]
    if (!outbound || !('id' in outbound) || outbound.id === undefined) {
      throw new Error('Expected an outbound JSON-RPC request')
    }
    await client.disconnect()

    await expect(request).rejects.toBeInstanceOf(CodexRequestCancelledError)
    expect(transport.cancelledRequestIds).toEqual([outbound.id])
  })

  it('settles send failures once and clears the transport request mapping', async () => {
    const transport = new MemoryTransport()
    const sendError = new Error('write failed')
    transport.sendError = sendError
    const lifecycleEvents: Array<{ outcome?: string }> = []
    const client = new AppServerClient(transport, {
      onRequestLifecycle: (event) => lifecycleEvents.push(event)
    })
    await client.connect()

    await expect(client.request('plugin/installed')).rejects.toBe(sendError)

    expect(transport.cancelledRequestIds).toEqual([1])
    expect(
      lifecycleEvents.filter((event) => event.outcome === 'transport-terminated')
    ).toHaveLength(1)
    expect(await client.waitForPendingRequests(0)).toBe(true)
  })

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
