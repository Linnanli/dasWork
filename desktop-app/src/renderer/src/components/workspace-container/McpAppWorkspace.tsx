import { useEffect, useRef, useState } from 'react'
import { BlocksIcon, LoaderCircleIcon, RefreshCcwIcon, ShieldCheckIcon, TriangleAlertIcon } from 'lucide-react'

import { isMcpAppHtmlContent, type McpAppResourceContent } from '../../../../shared/mcpAppResource'
import {
  errorMessage,
  mcpAppHostResponse,
  mcpAppSrcDoc,
  parseMcpAppHostRequest
} from './mcpAppWorkspaceProtocol'

export type McpAppWorkspaceProps = {
  threadId: string
  server: string
  resourceUri: string
  title: string
}

type LoadState =
  | { type: 'loading' }
  | { type: 'ready'; document: McpAppResourceContent }
  | { type: 'error'; message: string }

export function McpAppWorkspace({
  threadId,
  server,
  resourceUri,
  title
}: McpAppWorkspaceProps): React.JSX.Element {
  const [reloadKey, setReloadKey] = useState(0)

  return (
    <McpAppWorkspaceLoader
      key={`${threadId}:${server}:${resourceUri}:${reloadKey}`}
      threadId={threadId}
      server={server}
      resourceUri={resourceUri}
      title={title}
      onRetry={() => setReloadKey((value) => value + 1)}
    />
  )
}

type McpAppWorkspaceLoaderProps = McpAppWorkspaceProps & {
  onRetry(): void
}

/**
 * The App executes in an opaque-origin iframe. It receives only a small MCP
 * Apps JSON-RPC surface: initialization, health checks, and read-only `ui://`
 * resource reads from the App's already-authorized server.
 */
function McpAppWorkspaceLoader({
  threadId,
  server,
  resourceUri,
  title,
  onRetry
}: McpAppWorkspaceLoaderProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ type: 'loading' })
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    let active = true
    void window.desktopApp.codex
      .readMcpAppResource({ version: 1, threadId, server, resourceUri })
      .then((result) => {
        const document = result.contents.find(isMcpAppHtmlContent)
        if (!document) throw new Error('MCP App 未返回可渲染的 HTML 资源。')
        if (active) setState({ type: 'ready', document })
      })
      .catch((error: unknown) => {
        if (active) setState({ type: 'error', message: errorMessage(error) })
      })
    return () => {
      active = false
    }
  }, [resourceUri, server, threadId])

  useEffect(() => {
    if (state.type !== 'ready') return
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const request = parseMcpAppHostRequest(event.data)
      if (!request) return
      void mcpAppHostResponse(request, {
        readResource: (assetUri) =>
          window.desktopApp.codex.readMcpAppResource({
            version: 1,
            threadId,
            server,
            resourceUri,
            assetUri
          })
      }).then((response) => {
        if (response) iframeRef.current?.contentWindow?.postMessage(response, '*')
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [resourceUri, server, state.type, threadId])

  return (
    <section data-slot="mcp-app-workspace" className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/70 px-4 py-3">
        <BlocksIcon aria-hidden className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{title}</h2>
          <p className="truncate text-xs text-muted-foreground">{server}</p>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground" title="隔离运行；仅允许读取该 App 的 ui:// 资源">
          <ShieldCheckIcon aria-hidden className="size-3.5" />
          受限模式
        </span>
      </header>
      {state.type === 'loading' ? (
        <div data-slot="mcp-app-loading" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          正在载入 MCP App…
        </div>
      ) : null}
      {state.type === 'error' ? (
        <div data-slot="mcp-app-error" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <TriangleAlertIcon aria-hidden className="size-5 text-destructive" />
          <p className="text-sm">无法载入 MCP App</p>
          <p className="max-w-md text-xs text-muted-foreground">{state.message}</p>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-accent"
            onClick={onRetry}
          >
            <RefreshCcwIcon aria-hidden className="size-3.5" />
            重试
          </button>
        </div>
      ) : null}
      {state.type === 'ready' ? (
        <iframe
          ref={iframeRef}
          data-slot="mcp-app-frame"
          title={title}
          sandbox="allow-scripts"
          srcDoc={mcpAppSrcDoc(state.document.text)}
          className="min-h-0 w-full flex-1 border-0 bg-transparent"
        />
      ) : null}
    </section>
  )
}
