// @vitest-environment jsdom

import { act, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { UserMessageNavigationRail } from './UserMessageNavigationRail'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function NavigationHarness(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={viewportRef}>
      <article data-role="user">First request</article>
      <article data-role="assistant">First reply</article>
      <article data-role="user">Second request</article>
      <article data-role="user">Third request</article>
      <UserMessageNavigationRail viewportRef={viewportRef} />
    </div>
  )
}

function ProgressiveNavigationHarness(): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [firstMessageLoaded, setFirstMessageLoaded] = useState(false)
  return (
    <div ref={viewportRef}>
      {firstMessageLoaded ? <article data-message-id="message-1" data-role="user">First request</article> : null}
      <article data-message-id="message-2" data-role="user">Second request</article>
      <article data-message-id="message-3" data-role="user">Third request</article>
      <UserMessageNavigationRail
        viewportRef={viewportRef}
        items={[
          { id: 'message-1', label: 'First request' },
          { id: 'message-2', label: 'Second request' },
          { id: 'message-3', label: 'Third request' }
        ]}
        onRevealItem={(id) => {
          if (id === 'message-1') setFirstMessageLoaded(true)
        }}
      />
    </div>
  )
}

describe('UserMessageNavigationRail', () => {
  it('shows a marker for each user message and scrolls to the selected message', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const scrollIntoView = vi.fn()
    vi.stubGlobal('IntersectionObserver', undefined)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })

    await act(async () => {
      root.render(<NavigationHarness />)
    })

    const rail = container.querySelector<HTMLElement>('[data-slot="user-message-navigation-rail"]')
    expect(rail).not.toBeNull()
    expect(rail?.className).toContain('hidden')
    expect(rail?.className).toContain('lg:flex')
    expect(rail?.style.right).toContain('48rem')
    expect(rail?.style.right).toContain('2.75rem')
    const thirdMessage = rail?.querySelector<HTMLButtonElement>('[aria-label^="跳转到消息 3"]')
    await act(async () => thirdMessage?.click())

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    expect(thirdMessage?.getAttribute('aria-current')).toBe('true')
    root.unmount()
  })

  it('loads an unmounted user message before scrolling to its marker', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const scrollIntoView = vi.fn()
    vi.stubGlobal('IntersectionObserver', undefined)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })

    await act(async () => {
      root.render(<ProgressiveNavigationHarness />)
    })

    const firstMessage = container.querySelector<HTMLButtonElement>('[aria-label^="跳转到消息 1"]')
    await act(async () => firstMessage?.click())

    await vi.waitFor(() => {
      expect(container.querySelector('[data-message-id="message-1"]')).not.toBeNull()
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
    })
    root.unmount()
  })
})
