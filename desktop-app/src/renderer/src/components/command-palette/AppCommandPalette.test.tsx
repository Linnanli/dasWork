// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppCommandPalette } from './AppCommandPalette'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView

describe('AppCommandPalette', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect(): void {
          return undefined
        }
        observe(): void {
          return undefined
        }
        unobserve(): void {
          return undefined
        }
      }
    )
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    if (nativeScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: nativeScrollIntoView
      })
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('closes before running each selected desktop action', async () => {
    const onFocusTaskSearch = vi.fn()
    const onNewConversation = vi.fn()
    const onOpenChange = vi.fn()
    const onOpenKeyboardShortcuts = vi.fn()
    const onOpenPlugins = vi.fn()
    const onToggleSidebar = vi.fn()

    await act(async () => {
      root.render(
        <AppCommandPalette
          open
          sidebarCollapsed={false}
          onFocusTaskSearch={onFocusTaskSearch}
          onNewConversation={onNewConversation}
          onOpenChange={onOpenChange}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
          onOpenPlugins={onOpenPlugins}
          onToggleSidebar={onToggleSidebar}
        />
      )
    })

    const newTask = [...document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')].find(
      (item) => item.textContent?.includes('新建任务')
    )
    expect(newTask).not.toBeUndefined()

    await act(async () => newTask?.click())

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onNewConversation).toHaveBeenCalledOnce()
    expect(onFocusTaskSearch).not.toHaveBeenCalled()
    expect(onOpenPlugins).not.toHaveBeenCalled()
    expect(onToggleSidebar).not.toHaveBeenCalled()
    expect(onOpenKeyboardShortcuts).not.toHaveBeenCalled()
  })
})
