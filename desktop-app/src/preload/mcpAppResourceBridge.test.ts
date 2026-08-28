import { describe, expect, it, vi } from 'vitest'

import { createMcpAppResourceBridge } from './mcpAppResourceBridge'

describe('createMcpAppResourceBridge', () => {
  it('exposes only the strict MCP App resource channel', async () => {
    const invoke = vi.fn(async () => ({
      version: 1,
      contents: [
        {
          uri: 'ui://calendar/app.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>Calendar</main>'
        }
      ]
    }))
    const bridge = createMcpAppResourceBridge(invoke)
    const request = {
      version: 1 as const,
      threadId: 'thread-1',
      server: 'calendar',
      resourceUri: 'ui://calendar/app.html'
    }

    await bridge.readMcpAppResource(request)

    expect(invoke).toHaveBeenCalledWith('codex:read-mcp-app-resource', request)
    expect(() => bridge.readMcpAppResource({ ...request, assetUri: 'file:///secret' } as never)).toThrow()
  })

  it('rejects a main-process result that exposes provider metadata', async () => {
    const bridge = createMcpAppResourceBridge(
      vi.fn(async () => ({
        version: 1,
        contents: [
          {
            uri: 'ui://calendar/app.html',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>Calendar</main>',
            _meta: { token: 'secret' }
          }
        ]
      }))
    )

    await expect(
      bridge.readMcpAppResource({
        version: 1,
        threadId: 'thread-1',
        server: 'calendar',
        resourceUri: 'ui://calendar/app.html'
      })
    ).rejects.toThrow()
  })
})
