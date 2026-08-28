import { describe, expect, it } from 'vitest'

import {
  defaultKeyboardShortcutConfig,
  keyboardShortcutConfigSchema,
  keyboardShortcutFromKeyEvent,
  keyboardShortcutMatchesKeyEvent
} from './keyboardShortcutsApi'

describe('keyboard shortcut API', () => {
  it('keeps defaults valid', () => {
    expect(keyboardShortcutConfigSchema.parse(defaultKeyboardShortcutConfig)).toEqual(
      defaultKeyboardShortcutConfig
    )
  })

  it('rejects duplicate and reserved shortcuts', () => {
    expect(() =>
      keyboardShortcutConfigSchema.parse({
        ...defaultKeyboardShortcutConfig,
        'focus-task-search': 'Mod+B'
      })
    ).toThrow('已用于')
    expect(() =>
      keyboardShortcutConfigSchema.parse({ ...defaultKeyboardShortcutConfig, 'new-task': 'Mod+Q' })
    ).toThrow('保留组合')
  })

  it('recognizes only primary-modifier shortcuts without Alt', () => {
    const event = { key: 'g', altKey: false, ctrlKey: true, metaKey: false, shiftKey: true }
    expect(keyboardShortcutFromKeyEvent(event)).toBe('Mod+Shift+G')
    expect(keyboardShortcutMatchesKeyEvent('Mod+Shift+G', event)).toBe(true)
    expect(
      keyboardShortcutMatchesKeyEvent('Mod+G', {
        key: 'g',
        altKey: false,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false
      })
    ).toBe(true)
    expect(keyboardShortcutFromKeyEvent({ ...event, altKey: true })).toBeUndefined()
    expect(keyboardShortcutFromKeyEvent({ ...event, key: 'Enter' })).toBeUndefined()
  })
})
