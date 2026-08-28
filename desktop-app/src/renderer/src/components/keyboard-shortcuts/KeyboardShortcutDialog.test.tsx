// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyboardShortcutDialog } from './KeyboardShortcutDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const config = {
  'new-task': 'Mod+N',
  'command-palette': 'Mod+K',
  'find-conversation': 'Mod+F',
  'toggle-sidebar': 'Mod+B',
  'focus-task-search': 'Mod+G'
} as const

describe('KeyboardShortcutDialog', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('captures a safe primary-modifier combination and offers reset', async () => {
    const onReset = vi.fn(async () => undefined)
    const onUpdate = vi.fn(async () => undefined)
    await act(async () => {
      root.render(
        <KeyboardShortcutDialog
          config={config}
          open
          onOpenChange={vi.fn()}
          onReset={onReset}
          onUpdate={onUpdate}
        />
      )
    })

    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="修改搜索任务快捷键"]'
    )
    if (!button) throw new Error('Missing shortcut capture button')
    await act(async () => button.click())
    await act(async () => {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'g', ctrlKey: true })
      )
    })
    expect(onUpdate).toHaveBeenCalledWith('focus-task-search', 'Mod+G')

    const reset = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes('恢复默认')
    )
    await act(async () => reset?.click())
    expect(onReset).toHaveBeenCalledOnce()
  })
})
