// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrowserWorkspace } from './BrowserWorkspace'
import { repositionBrowserWorkspaceView } from './browserWorkspaceMove'
import { normalizeBrowserUrl } from './browserWorkspaceUrl'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

describe('BrowserWorkspace', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    TestResizeObserver.latest = undefined
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('clips the native browser view to the animated workspace shell', async () => {
    const view = { viewId: 'view-1' }
    const setBounds = vi.fn(async () => view)
    const show = vi.fn(async () => view)
    const hide = vi.fn(async () => view)

    vi.stubGlobal('desktopApp', {
      workspace: {
        browser: {
          setBounds,
          show,
          hide,
          onEvent: vi.fn(() => () => undefined)
        }
      }
    })
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.matches('[data-slot="right-workspace-shell"]')) {
        return domRect({ x: 700, y: 0, width: 200, height: 700 })
      }
      if (this.classList.contains('relative') && this.classList.contains('flex-1')) {
        return domRect({ x: 600, y: 100, width: 400, height: 500 })
      }
      return domRect({ x: 0, y: 0, width: 0, height: 0 })
    })

    await act(async () => {
      root.render(
        <aside data-slot="right-workspace-shell">
          <BrowserWorkspace
            tab={{ id: 'browser-1', type: 'browser', title: 'Browser', browserViewId: 'view-1' }}
            workspaceId="workspace-1"
            onRuntimeChange={vi.fn()}
          />
        </aside>
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(TestResizeObserver.latest?.observedElements).toHaveLength(2)
    expect(setBounds).toHaveBeenCalledWith({
      version: 1,
      viewId: 'view-1',
      bounds: { x: 700, y: 100, width: 200, height: 500 }
    })
    expect(show).toHaveBeenCalledWith({ version: 1, viewId: 'view-1' })
  })

  it('does not reveal a native view after the browser workspace has unmounted', async () => {
    const view = { viewId: 'view-1' }
    let resolveBounds: ((value: typeof view) => void) | undefined
    const setBounds = vi.fn(
      () =>
        new Promise<typeof view>((resolve) => {
          resolveBounds = resolve
        })
    )
    const show = vi.fn(async () => view)
    const hide = vi.fn(async () => view)

    vi.stubGlobal('desktopApp', {
      workspace: {
        browser: {
          setBounds,
          show,
          hide,
          onEvent: vi.fn(() => () => undefined)
        }
      }
    })
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      domRect({ x: 20, y: 40, width: 640, height: 480 })
    )

    await act(async () => {
      root.render(
        <BrowserWorkspace
          tab={{ id: 'browser-1', type: 'browser', title: 'Browser', browserViewId: 'view-1' }}
          workspaceId="workspace-1"
          onRuntimeChange={vi.fn()}
        />
      )
      await Promise.resolve()
    })

    expect(setBounds).toHaveBeenCalledOnce()

    await act(async () => {
      root.render(<div />)
      await Promise.resolve()
    })

    await act(async () => {
      resolveBounds?.(view)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(hide).toHaveBeenCalledOnce()
    expect(show).not.toHaveBeenCalled()
  })

  it('normalizes HTTP and HTTPS addresses without accepting unsafe schemes', () => {
    expect(normalizeBrowserUrl('example.test/docs')).toBe('https://example.test/docs')
    expect(normalizeBrowserUrl('http://example.test/docs')).toBe('http://example.test/docs')
    expect(normalizeBrowserUrl('https://example.test/docs')).toBe('https://example.test/docs')
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeUndefined()
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeUndefined()
  })

  it('repositions and reveals the same native view after a cross-panel move', async () => {
    const view = { viewId: 'view-1' }
    const setBounds = vi.fn(async () => view)
    const show = vi.fn(async () => view)
    vi.stubGlobal('desktopApp', { workspace: { browser: { setBounds, show } } })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.matches('[data-workspace-panel-shell]')) {
        return domRect({ x: 0, y: 500, width: 1_000, height: 300 })
      }
      if (this.matches('[data-workspace-browser-surface]')) {
        return domRect({ x: 20, y: 560, width: 960, height: 220 })
      }
      return domRect({ x: 0, y: 0, width: 0, height: 0 })
    })
    const shell = document.createElement('aside')
    shell.dataset.workspacePanelShell = 'true'
    const tab = document.createElement('div')
    tab.dataset.workspaceBrowserTabId = 'browser-1'
    const surface = document.createElement('div')
    surface.dataset.workspaceBrowserSurface = 'true'
    tab.appendChild(surface)
    shell.appendChild(tab)
    container.appendChild(shell)

    await repositionBrowserWorkspaceView('browser-1', 'view-1')

    expect(setBounds).toHaveBeenCalledWith({
      version: 1,
      viewId: 'view-1',
      bounds: { x: 20, y: 560, width: 960, height: 220 }
    })
    expect(show).toHaveBeenCalledWith({ version: 1, viewId: 'view-1' })
  })
})

class TestResizeObserver implements ResizeObserver {
  static latest: TestResizeObserver | undefined

  readonly observedElements: Element[] = []

  constructor() {
    TestResizeObserver.latest = this
  }

  disconnect(): void {
    this.observedElements.length = 0
  }

  observe(element: Element): void {
    this.observedElements.push(element)
  }

  unobserve(element: Element): void {
    const index = this.observedElements.indexOf(element)
    if (index >= 0) this.observedElements.splice(index, 1)
  }
}

function domRect({
  x,
  y,
  width,
  height
}: {
  x: number
  y: number
  width: number
  height: number
}): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({})
  }
}
