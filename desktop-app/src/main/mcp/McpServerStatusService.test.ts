import { describe, expect, it, vi } from 'vitest'

import { McpServerStatusService } from './McpServerStatusService'

describe('McpServerStatusService', () => {
  it('requests tools-and-auth-only status and wraps the provider summaries', async () => {
    const provider = {
      listMcpServerStatus: vi.fn(async () => [
        {
          name: 'github',
          connected: true,
          authStatus: 'oAuth',
          toolCount: 2
        }
      ])
    }
    const service = new McpServerStatusService({
      provider,
      now: () => new Date('2026-08-01T00:00:00.000Z')
    })

    await expect(service.list({ version: 1, threadId: 'thread-1' })).resolves.toEqual({
      version: 1,
      generatedAt: '2026-08-01T00:00:00.000Z',
      servers: [
        {
          name: 'github',
          connected: true,
          authStatus: 'oAuth',
          toolCount: 2
        }
      ]
    })
    expect(provider.listMcpServerStatus).toHaveBeenCalledWith({
      threadId: 'thread-1',
      detail: 'toolsAndAuthOnly',
      pageSize: 100
    })
  })

  it('rejects provider summaries with raw extra fields', async () => {
    const service = new McpServerStatusService({
      provider: {
        listMcpServerStatus: vi.fn(async () => [
          {
            name: 'github',
            connected: true,
            authStatus: 'oAuth',
            toolCount: 1,
            tools: { read: {} }
          }
        ])
      }
    })

    await expect(service.list({ version: 1 })).rejects.toThrow()
  })
})
