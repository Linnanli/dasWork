import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultKeyboardShortcutConfig } from '../../shared/keyboardShortcutsApi'
import { KeyboardShortcutService } from './KeyboardShortcutService'

describe('KeyboardShortcutService', () => {
  it('persists valid changes and resets them to defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dascowork-shortcuts-'))
    const filePath = join(directory, 'shortcuts.json')
    try {
      const service = KeyboardShortcutService.onDisk(filePath)
      await service.load()
      await expect(
        service.update({ command: 'focus-task-search', binding: 'Mod+Shift+G' })
      ).resolves.toMatchObject({ 'focus-task-search': 'Mod+Shift+G' })
      await expect(KeyboardShortcutService.onDisk(filePath).load()).resolves.toMatchObject({
        'focus-task-search': 'Mod+Shift+G'
      })
      await service.reset()
      await expect(readFile(filePath, 'utf8')).resolves.toContain('"focus-task-search": "Mod+G"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('falls back to defaults when the local file is malformed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dascowork-shortcuts-'))
    const filePath = join(directory, 'shortcuts.json')
    try {
      await writeFile(filePath, '{ bad json', 'utf8')
      await expect(KeyboardShortcutService.onDisk(filePath).load()).resolves.toEqual(
        defaultKeyboardShortcutConfig
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
