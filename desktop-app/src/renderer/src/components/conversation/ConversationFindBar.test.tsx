// @vitest-environment jsdom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationFindBar } from './ConversationFindBar'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const scrollIntoView = vi.fn()

describe('ConversationFindBar', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    scrollIntoView.mockClear()
  })

  it('opens from the shortcut, jumps between matching messages, and clears its highlight', async () => {
    const onOpen = vi.fn()
    await act(async () => {
      root.render(<ConversationFindHarness onOpen={onOpen} />)
    })

    await act(async () => window.dispatchEvent(new Event('dascowork:conversation-find')))
    expect(onOpen).toHaveBeenCalledOnce()
    const input = document.querySelector<HTMLInputElement>('input[aria-label="在当前对话中查找"]')
    expect(input).not.toBeNull()

    await setInputValue(input!, 'release')
    expect(document.body.textContent).toContain('1/2')
    const messages = [...container.querySelectorAll<HTMLElement>('[data-role]')]
    expect(messages[0]?.className).toContain('ring-primary/70')
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })

    await act(async () => buttonWithLabel('下一个对话匹配')?.click())
    expect(document.body.textContent).toContain('2/2')
    expect(messages[0]?.className).not.toContain('ring-primary/70')
    expect(messages[1]?.className).toContain('ring-primary/70')

    await act(async () => buttonWithLabel('关闭对话查找')?.click())
    expect(document.querySelector('[data-slot="conversation-find-bar"]')).toBeNull()
    expect(messages[1]?.className).not.toContain('ring-primary/70')
  })
})

function ConversationFindHarness({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={viewportRef}>
      <ConversationFindBar viewportRef={viewportRef} onOpen={onOpen} />
      <article data-role="user">Release notes request</article>
      <article data-role="assistant">Release summary</article>
      <article data-role="user">Unrelated task</article>
    </div>
  )
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.getAttribute('aria-label') === label
  )
}
