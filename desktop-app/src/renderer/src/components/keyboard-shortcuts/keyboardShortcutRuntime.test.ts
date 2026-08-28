// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { defaultKeyboardShortcutConfig } from '../../../../shared/keyboardShortcutsApi'
import { keyboardShortcutCommandForEvent } from './keyboardShortcutRuntime'

describe('keyboardShortcutCommandForEvent', () => {
  it('uses Ctrl on Windows/Linux and Cmd on macOS', () => {
    expect(
      keyboardShortcutCommandForEvent(
        defaultKeyboardShortcutConfig,
        new KeyboardEvent('keydown', { key: 'g', ctrlKey: true })
      )
    ).toBe('focus-task-search')
    expect(
      keyboardShortcutCommandForEvent(
        defaultKeyboardShortcutConfig,
        new KeyboardEvent('keydown', { key: 'g', metaKey: true })
      )
    ).toBe('focus-task-search')
  })

  it('does not run in inputs, terminals, or while composing', () => {
    const input = document.createElement('input')
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const composing = new KeyboardEvent('keydown', { key: 'g', ctrlKey: true })
    Object.defineProperty(composing, 'isComposing', { value: true })

    expect(
      keyboardShortcutCommandForEvent(
        defaultKeyboardShortcutConfig,
        keyboardEventFor(input, { key: 'g', ctrlKey: true })
      )
    ).toBeUndefined()
    expect(
      keyboardShortcutCommandForEvent(
        defaultKeyboardShortcutConfig,
        keyboardEventFor(terminal, { key: 'g', ctrlKey: true })
      )
    ).toBeUndefined()
    expect(keyboardShortcutCommandForEvent(defaultKeyboardShortcutConfig, composing)).toBeUndefined()
  })
})

function keyboardEventFor(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  return event
}
