import { describe, expect, it, vi } from 'vitest'

import {
  CodexRequestCancelledError,
  createCodexContextCatalogClient,
  createCodexHistoryClient
} from '../src'

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
})
