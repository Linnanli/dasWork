import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConversationPreferencesStore } from './ConversationPreferencesStore'

describe('ConversationPreferencesStore', () => {
  it('persists normalized pin and sidebar preferences', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dascowork-conversation-preferences-'))
    const filePath = join(directory, 'preferences.json')
    try {
      const store = ConversationPreferencesStore.onDisk(filePath)
      await store.set({
        organizeMode: 'chronological',
        sortKey: 'created_at',
        collapsedSectionIds: ['quick-chats', 'quick-chats'],
        collapsedGroupIds: ['local:app'],
        pinnedConversationIds: ['thread-1', '', 'thread-1', 'thread-2']
      })

      await expect(ConversationPreferencesStore.onDisk(filePath).get()).resolves.toEqual({
        organizeMode: 'chronological',
        sortKey: 'created_at',
        collapsedSectionIds: ['quick-chats'],
        collapsedGroupIds: ['local:app'],
        pinnedConversationIds: ['thread-1', 'thread-2']
      })
      await expect(readFile(filePath, 'utf8')).resolves.toContain('"pinnedConversationIds"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
