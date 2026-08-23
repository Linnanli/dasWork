import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CircleStopIcon,
  Globe2Icon,
  RefreshCwIcon
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  BROWSER_WORKSPACE_API_VERSION,
  type BrowserWorkspaceBounds,
  type BrowserWorkspaceEvent,
  type BrowserWorkspaceViewSnapshot
} from '../../../../../shared/browserWorkspaceApi'
import type { RightWorkspaceTab } from '../workspaceState'
import { browserWorkspaceBounds } from './browserWorkspaceMove'
import { normalizeBrowserUrl } from './browserWorkspaceUrl'

type Props = {
  tab: Extract<RightWorkspaceTab, { type: 'browser' }>
  workspaceId: string
  onRuntimeChange(runtime: { browserViewId?: string; title?: string }): void
}

export function BrowserWorkspace({ tab, workspaceId, onRuntimeChange }: Props): React.JSX.Element {
  const [view, setView] = useState<BrowserWorkspaceViewSnapshot>()
  const [draftUrl, setDraftUrl] = useState(tab.initialUrl ?? '')
  const [error, setError] = useState<string>()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const openedInitialUrl = useRef<string | undefined>(undefined)

  const updateBounds = useCallback(async (): Promise<BrowserWorkspaceBounds | undefined> => {
    const viewId = tab.browserViewId
    const surface = surfaceRef.current
    if (!viewId || !surface) return undefined
    const bounds = browserWorkspaceBounds(surface)
    if (!bounds) return undefined
    await window.desktopApp.workspace.browser.setBounds({
      version: BROWSER_WORKSPACE_API_VERSION,
      viewId,
      bounds
    })
    return bounds
  }, [tab.browserViewId])

  useEffect(() => {
    const unsubscribe = window.desktopApp.workspace.browser.onEvent((event) => {
      if (!belongsToTab(event, tab.browserViewId)) return
      if (event.type === 'destroyed') return
      setView(event.view)
      if (event.view.title) onRuntimeChange({ title: event.view.title })
      if (event.view.url !== 'about:blank') setDraftUrl(event.view.url)
    })
    return unsubscribe
  }, [onRuntimeChange, tab.browserViewId])

  useEffect(() => {
    const viewId = tab.browserViewId
    const surface = surfaceRef.current
    if (!viewId || !surface) return
    let active = true
    let revealGeneration = 0
    const reveal = async (): Promise<void> => {
      const generation = ++revealGeneration
      try {
        const bounds = await updateBounds()
        if (!active || generation !== revealGeneration || !bounds) return
        const next = await window.desktopApp.workspace.browser.show({
          version: BROWSER_WORKSPACE_API_VERSION,
          viewId
        })
        if (active && generation === revealGeneration) setView(next)
      } catch (cause) {
        if (active && generation === revealGeneration) {
          setError(cause instanceof Error ? cause.message : '浏览器视图无法显示。')
        }
      }
    }
    const observer = new ResizeObserver(() => void reveal())
    observer.observe(surface)
    const workspaceShell = surface.closest<HTMLElement>(
      '[data-workspace-panel-shell="true"], [data-slot="right-workspace-shell"]'
    )
    if (workspaceShell) observer.observe(workspaceShell)
    void reveal()
    return () => {
      active = false
      revealGeneration += 1
      observer.disconnect()
      void window.desktopApp.workspace.browser
        .hide({
          version: BROWSER_WORKSPACE_API_VERSION,
          viewId
        })
        .catch(() => undefined)
    }
  }, [tab.browserViewId, updateBounds])

  const createBrowserView = useCallback(
    (url: string): void => {
      const bounds = browserWorkspaceBounds(surfaceRef.current)
      if (!bounds) return
      void window.desktopApp.workspace.browser
        .create({ version: BROWSER_WORKSPACE_API_VERSION, workspaceId, url, bounds })
        .then((next) => {
          setView(next)
          onRuntimeChange({ browserViewId: next.viewId, title: next.title ?? 'Browser' })
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : '页面无法打开。'))
    },
    [onRuntimeChange, workspaceId]
  )

  useEffect(() => {
    const url = normalizeBrowserUrl(tab.initialUrl ?? '')
    if (!url || tab.browserViewId || openedInitialUrl.current === url) return
    openedInitialUrl.current = url
    setDraftUrl(url)
    createBrowserView(url)
  }, [createBrowserView, tab.browserViewId, tab.initialUrl])

  const navigate = (): void => {
    const url = normalizeBrowserUrl(draftUrl)
    if (!url) {
      setError('请输入有效的 HTTP 或 HTTPS 地址。')
      return
    }
    setError(undefined)
    const bounds = browserWorkspaceBounds(surfaceRef.current)
    if (!bounds) return
    if (!tab.browserViewId) {
      createBrowserView(url)
      return
    }
    void window.desktopApp.workspace.browser
      .navigate({ version: BROWSER_WORKSPACE_API_VERSION, viewId: tab.browserViewId, url })
      .then(setView)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '页面无法打开。'))
  }

  const invokeViewAction = (action: 'goBack' | 'goForward' | 'reload' | 'stop'): void => {
    if (!tab.browserViewId) return
    void window.desktopApp.workspace.browser[action]({
      version: BROWSER_WORKSPACE_API_VERSION,
      viewId: tab.browserViewId
    })
      .then(setView)
      .catch((cause) => setError(cause instanceof Error ? cause.message : '浏览器操作失败。'))
  }

  return (
    <div data-workspace-browser-tab-id={tab.id} className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-8"
          disabled={!view?.canGoBack}
          aria-label="Back"
          onClick={() => invokeViewAction('goBack')}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-8"
          disabled={!view?.canGoForward}
          aria-label="Forward"
          onClick={() => invokeViewAction('goForward')}
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-8"
          disabled={!tab.browserViewId}
          aria-label={view?.loading ? 'Stop loading' : 'Refresh'}
          onClick={() => invokeViewAction(view?.loading ? 'stop' : 'reload')}
        >
          {view?.loading ? (
            <CircleStopIcon className="size-4" />
          ) : (
            <RefreshCwIcon className="size-4" />
          )}
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            navigate()
          }}
        >
          <div className="relative">
            {view?.faviconUrl ? (
              <img
                src={view.faviconUrl}
                alt=""
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
              />
            ) : (
              <Globe2Icon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            )}
            <Input
              value={draftUrl}
              onChange={(event) => setDraftUrl(event.target.value)}
              className="h-8 border-transparent bg-muted/70 pl-8 text-sm focus-visible:bg-background"
              placeholder="输入 HTTP 或 HTTPS 地址"
              aria-label="Browser address"
              title={view?.title}
            />
          </div>
        </form>
      </div>
      <div
        ref={surfaceRef}
        data-workspace-browser-surface="true"
        className="relative min-h-0 flex-1"
      >
        {!tab.browserViewId ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Globe2Icon className="size-9 text-muted-foreground" />
            <div>
              <h2 className="text-lg font-semibold">开始浏览</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                输入一个 HTTP 或 HTTPS 地址以在隔离浏览器标签中打开。
              </p>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : error || view?.error ? (
          <div role="alert" className="p-4 text-sm text-destructive">
            {error ?? view?.error}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function belongsToTab(event: BrowserWorkspaceEvent, viewId: string | undefined): boolean {
  return Boolean(viewId && event.view.viewId === viewId)
}
