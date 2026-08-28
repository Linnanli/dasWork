import { describe, expect, it, vi } from 'vitest'

import { createReadMcpAppResourceHandler } from './mcpAppResourceIpc'

describe('MCP App resource IPC handler', () => {
  it('validates the narrow request and sanitised result DTOs', async () => {
    const service = {
      read: vi.fn(async () => ({
        version: 1 as const,
        contents: [
          {
            uri: 'ui://calendar/app.html',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>Calendar</main>'
          }
        ]
      }))
    }
    const handler = createReadMcpAppResourceHandler(service)
    const request = {
      version: 1,
      threadId: 'thread-1',
      server: 'calendar',
      resourceUri: 'ui://calendar/app.html'
    }

    await expect(handler(undefined, request)).resolves.toEqual({
      version: 1,
      contents: [
        {
          uri: 'ui://calendar/app.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>Calendar</main>'
        }
      ]
    })
    expect(service.read).toHaveBeenCalledWith(request)
    await expect(
      handler(undefined, { ...request, resourceUri: 'https://example.test/app.html' })
    ).rejects.toThrow()
  })
})
