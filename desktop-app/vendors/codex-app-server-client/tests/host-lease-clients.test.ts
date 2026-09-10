import { describe, expect, it, vi } from 'vitest'

import {
  CodexRequestCancelledError,
  createCodexContextCatalogClient,
  createCodexHistoryClient
} from '../src'
import type { TransportContext } from '../src/client-settings'
import type { CodexContextCatalogJsonRpcClientLike } from '../src/context-catalog-client'

describe('host-owned client leases', () => {
  it('uses an acquired history lease without performing another initialize handshake', async () => {
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      notification: vi.fn(),
      request: vi.fn().mockResolvedValue({ data: [], nextCursor: null })
    }
    const release = vi.fn().mockResolvedValue(undefined)
    const acquireClient = vi.fn().mockResolvedValue({ client, release })
    const history = createCodexHistoryClient({ acquireClient })

    await expect(history.listThreads()).resolves.toEqual({ data: [], nextCursor: null })
    expect(acquireClient).toHaveBeenCalledOnce()
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.notification).not.toHaveBeenCalled()
    expect(client.request).toHaveBeenCalledWith('thread/list', {
      limit: 100,
      modelProviders: [],
      sortKey: 'updated_at',
      sortDirection: 'desc'
    })
    expect(release).toHaveBeenCalledOnce()
  })

  it('uses an acquired catalog lease without performing another initialize handshake', async () => {
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      notification: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      request: vi.fn().mockResolvedValue({ data: [] })
    }
    const release = vi.fn().mockResolvedValue(undefined)
    const acquireClient = vi.fn().mockResolvedValue({ client, release })
    const catalog = createCodexContextCatalogClient({ acquireClient })

    await expect(catalog.listSkills({ cwd: '/workspace' })).resolves.toEqual([])
    expect(acquireClient).toHaveBeenCalledOnce()
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.notification).not.toHaveBeenCalled()
    expect(client.request).toHaveBeenCalledWith('skills/list', { cwds: ['/workspace'] })
    expect(release).toHaveBeenCalledOnce()
  })

  it('passes the caller signal into an acquired catalog lease', async () => {
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      notification: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      request: vi.fn().mockResolvedValue({ marketplaces: [] })
    }
    const release = vi.fn().mockResolvedValue(undefined)
    const acquireClient = vi.fn().mockResolvedValue({ client, release })
    const catalog = createCodexContextCatalogClient({ acquireClient })
    const controller = new AbortController()

    await expect(
      catalog.listPluginCatalog({ cwd: '/workspace' }, { signal: controller.signal })
    ).resolves.toEqual({ marketplaces: [] })

    expect(acquireClient).toHaveBeenCalledWith({ signal: controller.signal })
    expect(client.request).toHaveBeenCalledWith('plugin/list', { cwds: ['/workspace'] })
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not fall back to app/list when app/installed was cancelled', async () => {
    const cancellation = new CodexRequestCancelledError()
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      notification: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      request: vi.fn().mockRejectedValue(cancellation)
    }
    const release = vi.fn().mockResolvedValue(undefined)
    const catalog = createCodexContextCatalogClient({
      acquireClient: vi.fn().mockResolvedValue({ client, release })
    })

    await expect(catalog.listAppsForManagement()).rejects.toBe(cancellation)

    expect(client.request).toHaveBeenCalledTimes(1)
    expect(client.request).toHaveBeenCalledWith('app/installed', {})
    expect(release).toHaveBeenCalledOnce()
  })

  it('keeps a shared MCP status read alive for a remaining consumer', async () => {
    const response = deferred<{ data: []; nextCursor: null }>()
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      notification: vi.fn(),
      onNotification: vi.fn(() => () => undefined),
      request: vi.fn().mockImplementation(() => response.promise)
    }
    const release = vi.fn().mockResolvedValue(undefined)
    let ownerSignal: AbortSignal | undefined
    const acquireClient = vi.fn((context: Readonly<TransportContext>) => {
      ownerSignal = context.signal
      return Promise.resolve({ client, release })
    })
    const catalog = createCodexContextCatalogClient({ acquireClient })
    const controller = new AbortController()

    const cancelled = catalog.listMcpServerStatus({}, { signal: controller.signal })
    await vi.waitFor(() => expect(acquireClient).toHaveBeenCalledOnce())
    const remaining = catalog.listMcpServerStatus()
    controller.abort()

    await expect(cancelled).rejects.toBeInstanceOf(CodexRequestCancelledError)
    expect(ownerSignal).not.toBe(controller.signal)
    expect(ownerSignal?.aborted).toBe(false)

    response.resolve({ data: [], nextCursor: null })
    await expect(remaining).resolves.toEqual([])
    expect(acquireClient).toHaveBeenCalledOnce()
  })

  it('preserves the snapshot transport context for the shared MCP status request', async () => {
    const client: CodexContextCatalogJsonRpcClientLike = {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      notification: vi.fn(() => Promise.resolve()),
      onNotification: vi.fn(() => () => undefined),
      request<T = unknown>(method: string, _params?: unknown): Promise<T> {
        const response =
          method === 'config/read'
            ? { config: {}, layers: [], origins: {} }
            : { data: [], nextCursor: null }
        return Promise.resolve(response as T)
      }
    }
    const release = vi.fn().mockResolvedValue(undefined)
    const acquiredContexts: Readonly<TransportContext>[] = []
    const acquireClient = vi.fn((context: Readonly<TransportContext>) => {
      acquiredContexts.push(context)
      return Promise.resolve({ client, release })
    })
    const catalog = createCodexContextCatalogClient({ acquireClient })

    await expect(
      catalog.readMcpManagementSnapshot({}, { threadId: 'snapshot-thread' })
    ).resolves.toMatchObject({ config: {}, servers: [] })

    expect(acquireClient).toHaveBeenCalledWith({ threadId: 'snapshot-thread' })
    const statusContext = acquiredContexts.find(
      (context) => context.threadId === 'snapshot-thread' && context.signal
    )
    expect(statusContext?.threadId).toBe('snapshot-thread')
    expect(statusContext?.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not share MCP status reads across different lease thread contexts', async () => {
    const firstPage = {
      data: [{ name: 'first', connected: true, authStatus: 'unsupported', toolCount: 1 }],
      nextCursor: null
    }
    const secondPage = {
      data: [{ name: 'second', connected: true, authStatus: 'unsupported', toolCount: 2 }],
      nextCursor: null
    }
    const firstResponse = deferred<typeof firstPage>()
    const secondResponse = deferred<typeof secondPage>()
    let requestCount = 0
    const client: CodexContextCatalogJsonRpcClientLike = {
      connect: vi.fn(() => Promise.resolve()),
      disconnect: vi.fn(() => Promise.resolve()),
      notification: vi.fn(() => Promise.resolve()),
      onNotification: vi.fn(() => () => undefined),
      request<T = unknown>(_method: string, _params?: unknown): Promise<T> {
        const response = requestCount++ === 0 ? firstResponse.promise : secondResponse.promise
        return response as Promise<T>
      }
    }
    const release = vi.fn().mockResolvedValue(undefined)
    const acquiredContexts: Readonly<TransportContext>[] = []
    const acquireClient = vi.fn((context: Readonly<TransportContext>) => {
      acquiredContexts.push(context)
      return Promise.resolve({ client, release })
    })
    const catalog = createCodexContextCatalogClient({ acquireClient })

    const first = catalog.listMcpServerStatus({}, { threadId: 'thread-a' })
    await vi.waitFor(() => expect(acquireClient).toHaveBeenCalledOnce())
    const second = catalog.listMcpServerStatus({}, { threadId: 'thread-b' })
    await vi.waitFor(() => expect(acquireClient).toHaveBeenCalledTimes(2))

    expect(acquiredContexts.map((context) => context.threadId)).toEqual(['thread-a', 'thread-b'])
    firstResponse.resolve(firstPage)
    secondResponse.resolve(secondPage)

    await expect(first).resolves.toMatchObject([{ name: 'first' }])
    await expect(second).resolves.toMatchObject([{ name: 'second' }])
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}
