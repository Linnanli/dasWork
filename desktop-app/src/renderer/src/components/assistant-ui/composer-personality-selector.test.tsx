// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ComposerPersonalitySelector } from './composer-personality-selector'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {
    return undefined
  }

  unobserve(): void {
    return undefined
  }

  disconnect(): void {
    return undefined
  }
}

describe('ComposerPersonalitySelector', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('offers only the app-server personality enum and returns the selected value', async () => {
    const onPersonalityChange = vi.fn()
    await act(async () => {
      root.render(
        <ComposerPersonalitySelector
          personality="none"
          onPersonalityChange={onPersonalityChange}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="composer-personality-selector"]'
    )
    expect(trigger?.dataset.personality).toBe('none')

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger?.click()
    })

    expect(document.body.textContent).toContain('回复个性')
    expect(document.body.textContent).toContain('友好')
    expect(document.body.textContent).toContain('务实')

    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-slot="dropdown-menu-item"][data-personality="pragmatic"]')
        ?.click()
    })

    expect(onPersonalityChange).toHaveBeenCalledWith('pragmatic')
  })
})
