import { describe, expect, it, vi } from 'vitest'

import { createKeyboardShortcutIpcHandlers } from './keyboardShortcutIpc'

describe('createKeyboardShortcutIpcHandlers', () => {
  it('validates the renderer request before updating the service', async () => {
    const config = {
      'new-task': 'Mod+N',
      'command-palette': 'Mod+K',
      'find-conversation': 'Mod+F',
      'toggle-sidebar': 'Mod+B',
      'focus-task-search': 'Mod+G'
    } as const
    const service = {
      get: vi.fn(() => config),
      update: vi.fn(async () => config),
      reset: vi.fn(async () => config)
    }
    const handlers = createKeyboardShortcutIpcHandlers(service)

    expect(handlers.get()).toEqual(config)
    await expect(handlers.update({}, { command: 'new-task', binding: 'Cmd+N' })).rejects.toThrow()
    expect(service.update).not.toHaveBeenCalled()
    await handlers.update({}, { command: 'new-task', binding: 'Mod+N' })
    expect(service.update).toHaveBeenCalledWith({ command: 'new-task', binding: 'Mod+N' })
  })
})
