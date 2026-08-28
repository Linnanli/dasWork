// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { McpAppWorkspace } from './McpAppWorkspace'
import { mcpAppHostResponse, mcpAppSrcDoc } from './mcpAppWorkspaceProtocol'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.unstubAllGlobals()
})

describe('McpAppWorkspace', () => {
  it('loads only the host-returned HTML into an opaque-origin iframe', async () => {
    const readMcpAppResource = vi.fn(async () => ({
      version: 1 as const,
      contents: [
        {
          uri: 'ui://calendar/app.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<script>window.parent.postMessage({}</script><main>Calendar</main>'
        }
      ]
    }))
    vi.stubGlobal('desktopApp', { codex: { readMcpAppResource } })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <McpAppWorkspace
          threadId="thread-1"
          server="calendar"
          resourceUri="ui://calendar/app.html"
          title="Calendar"
        />
      )
      await Promise.resolve()
    })

    const iframe = container.querySelector('iframe')
    expect(readMcpAppResource).toHaveBeenCalledWith({
      version: 1,
      threadId: 'thread-1',
      server: 'calendar',
      resourceUri: 'ui://calendar/app.html'
    })
    expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe?.srcdoc).toContain("default-src 'none'")
    expect(iframe?.srcdoc).toContain("connect-src 'none'")
    expect(iframe?.srcdoc).toContain('<main>Calendar</main>')
    expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin')
  })

  it('provides only initialize, ping, and read-only ui resource requests to the App', async () => {
    const readResource = vi.fn(async () => ({
      version: 1 as const,
      contents: [{ uri: 'ui://calendar/state.json', mimeType: 'application/json', text: '{"ok":true}' }]
    }))

    await expect(
      mcpAppHostResponse(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'ui/initialize',
          params: { protocolVersion: '2026-01-26' }
        },
        { readResource }
      )
    ).resolves.toMatchObject({
      result: {
        protocolVersion: '2026-01-26',
        hostCapabilities: { serverResources: {} },
        hostContext: { platform: 'desktop' }
      }
    })
    await expect(
      mcpAppHostResponse(
        { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ui://calendar/state.json' } },
        { readResource }
      )
    ).resolves.toMatchObject({ result: { contents: [{ text: '{"ok":true}' }] } })
    expect(readResource).toHaveBeenCalledWith('ui://calendar/state.json')
    await expect(
      mcpAppHostResponse({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, { readResource })
    ).resolves.toMatchObject({ error: { code: -32601 } })
    await expect(
      mcpAppHostResponse(
        { jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'file:///secret' } },
        { readResource }
      )
    ).resolves.toMatchObject({ error: { code: -32602 } })
  })

  it('places the restrictive CSP before the untrusted resource markup', () => {
    const srcDoc = mcpAppSrcDoc('<script>window.parent.postMessage("hello", "*")</script>')
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(srcDoc.indexOf('<script>'))
    expect(srcDoc).toContain("form-action 'none'")
  })
})
