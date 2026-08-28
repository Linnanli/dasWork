import { describe, expect, it } from 'vitest'

import {
  ConversationDraftStore,
  conversationDraftStorageKey,
  legacyConversationDraftStorageKey,
  previousConversationDraftStorageKey,
  v3ConversationDraftStorageKey,
  v2ConversationDraftStorageKey
} from './ConversationDraftStore'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('ConversationDraftStore', () => {
  it('restores versioned drafts across store instances', () => {
    const storage = new MemoryStorage()
    new ConversationDraftStore(storage).set('thread-a', 'draft A')

    expect(new ConversationDraftStore(storage).get('thread-a')).toBe('draft A')
  })

  it('restores path-backed attachments without storing file bytes', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.setAttachments('thread-a', [
      {
        capabilityToken: 'folder-picker-token',
        kind: 'folder',
        path: '/repo/docs',
        label: 'docs',
        fileUrl: 'file:///repo/docs'
      }
    ])

    expect(new ConversationDraftStore(storage).getAttachments('thread-a')).toEqual([
      {
        capabilityToken: 'folder-picker-token',
        kind: 'folder',
        path: '/repo/docs',
        label: 'docs',
        fileUrl: 'file:///repo/docs'
      }
    ])
    expect(storage.getItem(conversationDraftStorageKey)).not.toContain('file contents')
  })

  it('migrates legacy text-only drafts into the current in-memory shape with safe settings', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      legacyConversationDraftStorageKey,
      JSON.stringify({ version: 1, drafts: { 'thread-a': 'legacy draft' } })
    )

    const store = new ConversationDraftStore(storage)
    expect(store.get('thread-a')).toBe('legacy draft')
    expect(store.getAttachments('thread-a')).toEqual([])
    expect(store.getComposerModeKind('thread-a')).toBe('default')
    expect(store.getApprovalModeKind('thread-a')).toBe('request-approval')
    expect(store.getPersonality('thread-a')).toBe('none')
  })

  it('migrates v2 drafts with default composer and approval modes', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      v2ConversationDraftStorageKey,
      JSON.stringify({
        version: 2,
        drafts: {
          'thread-a': {
            text: 'existing draft',
            attachments: []
          }
        }
      })
    )

    const store = new ConversationDraftStore(storage)

    expect(store.get('thread-a')).toBe('existing draft')
    expect(store.getComposerModeKind('thread-a')).toBe('default')
    expect(store.getApprovalModeKind('thread-a')).toBe('request-approval')
    expect(store.getPersonality('thread-a')).toBe('none')
  })

  it('migrates v3 drafts with a safe approval mode', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      v3ConversationDraftStorageKey,
      JSON.stringify({
        version: 3,
        drafts: {
          'thread-a': {
            text: 'existing draft',
            attachments: [],
            composerModeKind: 'plan'
          }
        }
      })
    )

    const store = new ConversationDraftStore(storage)

    expect(store.get('thread-a')).toBe('existing draft')
    expect(store.getComposerModeKind('thread-a')).toBe('plan')
    expect(store.getApprovalModeKind('thread-a')).toBe('request-approval')
    expect(store.getPersonality('thread-a')).toBe('none')
  })

  it('migrates v4 drafts with their approval mode and a default personality', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      previousConversationDraftStorageKey,
      JSON.stringify({
        version: 4,
        drafts: {
          'thread-a': {
            text: 'existing draft',
            attachments: [],
            composerModeKind: 'plan',
            approvalModeKind: 'approve-for-me'
          }
        }
      })
    )

    const store = new ConversationDraftStore(storage)

    expect(store.getApprovalModeKind('thread-a')).toBe('approve-for-me')
    expect(store.getPersonality('thread-a')).toBe('none')
  })

  it('persists plan mode even when the draft is empty', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.setComposerModeKind('thread-a', 'plan')

    expect(new ConversationDraftStore(storage).getComposerModeKind('thread-a')).toBe('plan')

    store.setComposerModeKind('thread-a', 'default')
    expect(storage.getItem(conversationDraftStorageKey)).not.toContain('thread-a')
  })

  it('persists non-default approval mode even when the draft is empty', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.setApprovalModeKind('thread-a', 'full-access')

    expect(new ConversationDraftStore(storage).getApprovalModeKind('thread-a')).toBe('full-access')

    store.setApprovalModeKind('thread-a', 'request-approval')
    expect(storage.getItem(conversationDraftStorageKey)).not.toContain('thread-a')
  })

  it('persists a non-default personality even when the draft is empty', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.setPersonality('thread-a', 'friendly')

    expect(new ConversationDraftStore(storage).getPersonality('thread-a')).toBe('friendly')

    store.setPersonality('thread-a', 'none')
    expect(storage.getItem(conversationDraftStorageKey)).not.toContain('thread-a')
  })

  it('preserves draft, attachments, composer mode, and approval mode independently', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.set('thread-a', 'draft A')
    store.setAttachments('thread-a', [
      {
        kind: 'file',
        path: '/repo/file.txt',
        label: 'file.txt',
        fileUrl: 'file:///repo/file.txt'
      }
    ])
    store.setComposerModeKind('thread-a', 'plan')
    store.setApprovalModeKind('thread-a', 'approve-for-me')
    store.setPersonality('thread-a', 'pragmatic')

    const restored = new ConversationDraftStore(storage)
    expect(restored.get('thread-a')).toBe('draft A')
    expect(restored.getAttachments('thread-a')).toHaveLength(1)
    expect(restored.getComposerModeKind('thread-a')).toBe('plan')
    expect(restored.getApprovalModeKind('thread-a')).toBe('approve-for-me')
    expect(restored.getPersonality('thread-a')).toBe('pragmatic')
  })

  it('falls back to request approval for unknown stored approval values', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      conversationDraftStorageKey,
      JSON.stringify({
        version: 5,
        drafts: {
          'thread-a': {
            text: '',
            attachments: [],
            composerModeKind: 'default',
            approvalModeKind: 'fullAccess',
            personality: 'enthusiastic'
          }
        }
      })
    )

    expect(new ConversationDraftStore(storage).getApprovalModeKind('thread-a')).toBe(
      'request-approval'
    )
    expect(new ConversationDraftStore(storage).getPersonality('thread-a')).toBe('none')
  })

  it('migrates a local draft to the bound thread and removes the local key', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.set('local-a', 'draft A')

    expect(store.migrate('local-a', 'thread-a')).toBe('draft A')
    expect(store.get('local-a')).toBe('')
    expect(store.get('thread-a')).toBe('draft A')
  })

  it('migrates approval mode from the local draft to the bound thread', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.setApprovalModeKind('local-a', 'full-access')

    expect(store.migrate('local-a', 'thread-a')).toBe('')
    expect(store.getApprovalModeKind('local-a')).toBe('request-approval')
    expect(store.getApprovalModeKind('thread-a')).toBe('full-access')
  })

  it('migrates personality from the local draft to the bound thread', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.setPersonality('local-a', 'friendly')

    expect(store.migrate('local-a', 'thread-a')).toBe('')
    expect(store.getPersonality('local-a')).toBe('none')
    expect(store.getPersonality('thread-a')).toBe('friendly')
  })

  it('keeps an existing stable-thread draft when migration keys conflict', () => {
    const storage = new MemoryStorage()
    const store = new ConversationDraftStore(storage)
    store.set('local-a', 'temporary draft')
    store.set('thread-a', 'stable draft')

    expect(store.migrate('local-a', 'thread-a')).toBe('stable draft')
    expect(store.get('local-a')).toBe('')
  })

  it('ignores corrupted and unknown-version storage payloads', () => {
    const corrupted = new MemoryStorage()
    corrupted.setItem(conversationDraftStorageKey, '{bad json')
    expect(new ConversationDraftStore(corrupted).get('thread-a')).toBe('')

    const unknownVersion = new MemoryStorage()
    unknownVersion.setItem(
      conversationDraftStorageKey,
      JSON.stringify({ version: 2, drafts: { 'thread-a': 'old format' } })
    )
    expect(new ConversationDraftStore(unknownVersion).get('thread-a')).toBe('')
  })

  it('keeps drafts in memory when storage access fails', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage denied')
      },
      setItem: () => {
        throw new Error('quota exceeded')
      }
    }
    const store = new ConversationDraftStore(storage)

    expect(() => store.set('thread-a', 'draft A')).not.toThrow()
    expect(store.get('thread-a')).toBe('draft A')
  })
})
