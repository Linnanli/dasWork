import { describe, expect, it, vi } from 'vitest'

import { McpAppResourceService } from './McpAppResourceService'

const request = {
  version: 1 as const,
  threadId: 'thread-1',
  server: 'calendar',
  resourceUri: 'ui://calendar/app.html'
}

describe('McpAppResourceService', () => {
  it('reads a text HTML document only after finding its server and URI in the task transcript', async () => {
    const provider = {
      listTurns: vi.fn(async () => ({
        data: [
          {
            id: 'turn-1',
            items: [
              {
                type: 'mcpToolCall',
                server: 'calendar',
                appContext: { resourceUri: 'ui://calendar/app.html' }
              }
            ]
          }
        ],
        nextCursor: null
      })),
      readMcpResource: vi.fn(async () => ({
        contents: [
          {
            uri: 'ui://calendar/app.html',
            mimeType: 'text/html;profile=mcp-app',
            text: '<main>Calendar</main>',
            _meta: { secret: 'must not cross the IPC boundary' }
          }
        ]
      }))
    }
    const service = new McpAppResourceService({ provider })

    await expect(service.read(request)).resolves.toEqual({
      version: 1,
      contents: [
        {
          uri: 'ui://calendar/app.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>Calendar</main>'
        }
      ]
    })
    expect(provider.listTurns).toHaveBeenCalledWith('thread-1', {
      limit: 100,
      sortDirection: 'desc',
      itemsView: 'full'
    })
    expect(provider.readMcpResource).toHaveBeenCalledWith({
      threadId: 'thread-1',
      server: 'calendar',
      uri: 'ui://calendar/app.html'
    })
  })

  it('rejects resources that did not originate in this task transcript', async () => {
    const provider = {
      listTurns: vi.fn(async () => ({
        data: [
          {
            items: [
              {
                type: 'mcpToolCall',
                server: 'other-server',
                appContext: { resourceUri: 'ui://other/app.html' }
              }
            ]
          }
        ],
        nextCursor: null
      })),
      readMcpResource: vi.fn()
    }
    const service = new McpAppResourceService({ provider })

    await expect(service.read(request)).rejects.toThrow('not authorized')
    expect(provider.readMcpResource).not.toHaveBeenCalled()
  })

  it('allows an authorized App to read another UI-only resource from its own server', async () => {
    const provider = {
      listTurns: vi.fn(async () => ({
        data: [
          {
            items: [
              {
                type: 'mcpToolCall',
                server: 'calendar',
                mcpAppResourceUri: 'ui://calendar/app.html'
              }
            ]
          }
        ],
        nextCursor: null
      })),
      readMcpResource: vi.fn(async () => ({
        contents: [{ uri: 'ui://calendar/state.json', mimeType: 'application/json', text: '{"ok":true}' }]
      }))
    }
    const service = new McpAppResourceService({ provider })

    await expect(
      service.read({ ...request, assetUri: 'ui://calendar/state.json' })
    ).resolves.toMatchObject({
      contents: [{ uri: 'ui://calendar/state.json', text: '{"ok":true}' }]
    })
  })

  it('rejects non-HTML primary resources and binary-only responses', async () => {
    const provider = {
      listTurns: vi.fn(async () => ({
        data: [
          {
            items: [
              {
                type: 'mcpToolCall',
                server: 'calendar',
                appContext: { resourceUri: 'ui://calendar/app.html' }
              }
            ]
          }
        ],
        nextCursor: null
      })),
      readMcpResource: vi.fn(async () => ({
        contents: [{ uri: 'ui://calendar/app.html', mimeType: 'image/png', blob: 'base64-data' }]
      }))
    }
    const service = new McpAppResourceService({ provider })

    await expect(service.read(request)).rejects.toThrow('readable text')
  })
})
