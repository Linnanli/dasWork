// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RightWorkspaceProvider, useRightWorkspace } from './RightWorkspaceProvider'
import { RightWorkspaceTabBar } from './RightWorkspaceTabBar'
import type { RightWorkspaceTab } from './workspaceState'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

class TestResizeObserver {
  static callback: ResizeObserverCallback | undefined

  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback
  }

  observe(): void {
    return undefined
  }

  unobserve(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }

  static trigger(): void {
    TestResizeObserver.callback?.([], {} as ResizeObserver)
  }
}

describe('RightWorkspaceTabBar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    TestResizeObserver.callback = undefined
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('activates, navigates, and closes workspace tabs', async () => {
    const onTabClosed = vi.fn<(tab: RightWorkspaceTab) => void>()

    await renderTabBar({ onTabClosed })
    await clickButton('Open Browser')
    await clickButton('Open terminal')

    let tabs = workspaceTabs()
    expect(tabs.map((tab) => tab.textContent)).toEqual(['New tab', 'Terminal'])
    expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0'])

    await pressKey(tabs[1], 'ArrowRight')
    tabs = workspaceTabs()
    expect(document.activeElement).toBe(tabs[0])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')

    await pressKey(tabs[0], 'End')
    tabs = workspaceTabs()
    expect(document.activeElement).toBe(tabs[1])

    await clickButton('关闭Terminal标签页')
    expect(onTabClosed).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal' }))
    expect(workspaceTabs()).toHaveLength(1)
  })

  it('opens new tab types from a focused menu and reports menu visibility', async () => {
    const onMenuVisibilityChange = vi.fn<(visible: boolean) => void>()

    await renderTabBar({ onMenuVisibilityChange })
    await clickButton('Open workspace tab')

    const menu = document.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu?.getAttribute('data-slot')).toBe('popover-content')
    expect(document.activeElement?.textContent).toContain('Review')
    expect(onMenuVisibilityChange).toHaveBeenLastCalledWith(true)

    await clickButton('Open workspace tab')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(onMenuVisibilityChange).toHaveBeenLastCalledWith(false)

    await clickButton('Open workspace tab')
    await clickButtonWithText('Review')
    expect(workspaceTabs().map((tab) => tab.textContent)).toEqual(['Review'])
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await clickButton('Open workspace tab')
    expect(menuItemLabels()).toEqual([
      'Task',
      'Timeline',
      'Outputs',
      'Sources',
      'Processes',
      'Terminal⌘ T',
      'Browser⌘ B',
      'Files'
    ])

    await clickButtonWithText('Files')
    expect(workspaceTabs().map((tab) => tab.textContent)).toEqual(['Review', 'Files'])
    expect(onMenuVisibilityChange).toHaveBeenLastCalledWith(false)
  })

  it('limits tabs to the reference width and fades overflowing titles', async () => {
    await renderTabBar({})
    await clickButton('Open Browser')

    const tab = workspaceTabs()[0]
    const tabContainer = tab.parentElement
    expect(tabContainer?.className).toContain('min-w-[90px]')
    expect(tabContainer?.className).toContain('max-w-40')
    expect(tabContainer?.querySelector('[data-slot="right-workspace-tab-title-fade"]')).toBeNull()

    const title = tabContainer?.querySelector<HTMLElement>(
      '[data-slot="right-workspace-tab-title"]'
    )
    if (!title) throw new Error('Expected a workspace tab title element')

    Object.defineProperties(title, {
      clientWidth: { configurable: true, value: 90 },
      scrollWidth: { configurable: true, value: 160 }
    })
    await act(async () => TestResizeObserver.trigger())

    expect(
      tabContainer?.querySelector('[data-slot="right-workspace-tab-title-fade"]')
    ).not.toBeNull()
  })
})

function WorkspaceTestControls(): React.JSX.Element {
  const { openTab } = useRightWorkspace()

  return (
    <div>
      <button aria-label="Open Browser" onClick={() => openTab('browser')} type="button" />
      <button aria-label="Open terminal" onClick={() => openTab('terminal')} type="button" />
    </div>
  )
}

async function renderTabBar({
  onTabClosed,
  onMenuVisibilityChange
}: {
  onTabClosed?(tab: RightWorkspaceTab): void
  onMenuVisibilityChange?(visible: boolean): void
}): Promise<void> {
  await act(async () => {
    root.render(
      <RightWorkspaceProvider projectScope="tab-bar-test">
        <RightWorkspaceTabBar
          onTabClosed={onTabClosed}
          onMenuVisibilityChange={onMenuVisibilityChange}
        />
        <WorkspaceTestControls />
      </RightWorkspaceProvider>
    )
  })
}

async function clickButton(label: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  expect(button).not.toBeNull()
  await act(async () => button?.click())
}

async function clickButtonWithText(text: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  )
  expect(button).toBeDefined()
  await act(async () => button?.click())
}

async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.focus()
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await new Promise((resolve) => window.setTimeout(resolve, 20))
  })
}

function workspaceTabs(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

function menuItemLabels(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(
    (item) => item.textContent ?? ''
  )
}
