import { describe, expect, it, vi } from 'vitest'

import { createCodexContextCatalogClient, createCodexHistoryClient } from '../src'

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
})
