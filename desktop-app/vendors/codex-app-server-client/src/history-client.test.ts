import { describe, expect, it, vi } from 'vitest'

import { createCodexHistoryClient } from './history-client'

describe('CodexHistoryClient.listExperimentalFeatures', () => {
  it('reads every page through the shared initialized host lease', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ name: 'other_feature', enabled: true }],
        nextCursor: 'next-page'
      })
      .mockResolvedValueOnce({
        data: [{ name: 'workspace_dependencies', enabled: true }],
        nextCursor: null
      })
    const release = vi.fn(() => Promise.resolve())
    const client = createCodexHistoryClient({
      acquireClient: () =>
        Promise.resolve({
          client: {
            connect: vi.fn(() => Promise.resolve()),
            disconnect: vi.fn(() => Promise.resolve()),
            notification: vi.fn(() => Promise.resolve()),
            request
          },
          release
        })
    })

    await expect(client.listExperimentalFeatures()).resolves.toEqual([
      { name: 'other_feature', enabled: true },
      { name: 'workspace_dependencies', enabled: true }
    ])
    expect(request).toHaveBeenNthCalledWith(1, 'experimentalFeature/list', { limit: 100 })
    expect(request).toHaveBeenNthCalledWith(2, 'experimentalFeature/list', {
      cursor: 'next-page',
      limit: 100
    })
    expect(release).toHaveBeenCalledOnce()
  })
})
