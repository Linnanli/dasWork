import type { UIMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import {
  LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
  LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE
} from '../../../shared/composerContext'
import {
  ConversationTranscriptRecoveryStore,
  TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS,
  TRANSCRIPT_RECOVERY_MAX_STORAGE_BYTES,
  TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS
} from './ConversationTranscriptRecoveryStore'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

const storageKey = 'das-cowork.transcript-recovery.v1'

const serverUser = {
  id: 'user-1',
  role: 'user' as const,
  parts: [{ type: 'text' as const, text: 'open the file' }]
}

const localAttachment = {
  type: 'file' as const,
  mediaType: LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
  filename: 'notes.txt',
  url: 'file:///tmp/notes.txt'
}

describe('ConversationTranscriptRecoveryStore', () => {
  it('F16 leaves canonical history untouched when no local attachment overlay exists', () => {
    const store = new ConversationTranscriptRecoveryStore(new MemoryStorage())
    const history = [
      serverUser,
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'canonical response' }]
      }
    ]

    expect(store.mergeWithHistory('thread-1', history)).toEqual(history)
  })

  it('B08 merges persisted local file and folder attachments only by stable message id', () => {
    const store = new ConversationTranscriptRecoveryStore(new MemoryStorage())
    store.saveLocalAttachmentOverlay('thread-1', [
      {
        ...serverUser,
        parts: [
          ...serverUser.parts,
          localAttachment,
          {
            type: 'file' as const,
            mediaType: LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE,
            filename: 'reference',
            url: 'file:///tmp/reference'
          }
        ]
      }
    ])

    expect(store.mergeWithHistory('thread-1', [serverUser])).toEqual([
      {
        ...serverUser,
        parts: [
          ...serverUser.parts,
          localAttachment,
          {
            type: 'file',
            mediaType: LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE,
            filename: 'reference',
            url: 'file:///tmp/reference'
          }
        ]
      }
    ])
  })

  it('does not match an attachment overlay by message role or matching text', () => {
    const store = new ConversationTranscriptRecoveryStore(new MemoryStorage())
    store.saveLocalAttachmentOverlay('thread-1', [
      { ...serverUser, parts: [...serverUser.parts, localAttachment] }
    ])
    const sameTextDifferentId = { ...serverUser, id: 'different-user' }

    expect(store.mergeWithHistory('thread-1', [sameTextDifferentId])).toEqual([sameTextDifferentId])
  })

  it('restores already-rendered active text only when recovery cannot reattach the live journal', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    store.saveActiveTextFallback('thread-1', [
      {
        id: 'assistant:local-turn-1:initial',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Visible partial response.' }]
      }
    ])

    const restored = new ConversationTranscriptRecoveryStore(storage).mergeActiveTextFallback(
      'thread-1',
      [serverUser]
    )

    expect(restored).toEqual([
      serverUser,
      {
        id: 'assistant:local-turn-1:initial',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Visible partial response.' }]
      }
    ])
    expect(restored[1]?.metadata).toBeUndefined()
  })

  it('merges already-rendered active text into canonical failed history for the same turn', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    store.saveActiveTextFallback('thread-1', [
      {
        id: 'assistant:turn-1:provider-message-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Visible partial response.' }]
      }
    ])

    const restored = new ConversationTranscriptRecoveryStore(storage).mergeWithHistory('thread-1', [
      serverUser,
      {
        id: 'assistant:turn-1:terminal',
        role: 'assistant',
        parts: [],
        metadata: { codexTurn: { turnId: 'turn-1', status: 'failed' } }
      }
    ])

    expect(restored[1]).toEqual(
      expect.objectContaining({
        parts: [{ type: 'text', text: 'Visible partial response.' }]
      })
    )
    expect(recoveriesFrom(storage)).toEqual({})
  })

  it('batches stream recovery writes and flushes the latest visible text on teardown', () => {
    vi.useFakeTimers()
    try {
      const storage = new MemoryStorage()
      const setItem = vi.spyOn(storage, 'setItem')
      const store = new ConversationTranscriptRecoveryStore(storage)
      const first = {
        id: 'assistant:local-turn-1:initial',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'Visible' }]
      }
      const latest = {
        ...first,
        parts: [{ type: 'text' as const, text: 'Visible partial response.' }]
      }

      store.saveActiveTextFallbackDeferred('thread-1', [first])
      store.saveActiveTextFallbackDeferred('thread-1', [latest])
      expect(setItem).not.toHaveBeenCalled()

      vi.advanceTimersByTime(250)
      expect(setItem).toHaveBeenCalledTimes(1)
      expect(
        new ConversationTranscriptRecoveryStore(storage).mergeActiveTextFallback('thread-1', [])
      ).toEqual([latest])

      const newest = {
        ...latest,
        parts: [{ type: 'text' as const, text: 'Visible partial response, newest.' }]
      }
      store.saveActiveTextFallbackDeferred('thread-1', [newest])
      store.flushPendingActiveTextFallbacks()
      vi.runAllTimers()

      expect(setItem).toHaveBeenCalledTimes(2)
      expect(
        new ConversationTranscriptRecoveryStore(storage).mergeActiveTextFallback('thread-1', [])
      ).toEqual([newest])
    } finally {
      vi.useRealTimers()
    }
  })

  it('migrates a legacy terminal fallback without overriding canonical history', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        recoveries: {
          'thread-1': {
            createdAt: 1,
            attachmentsByMessageId: {},
            terminalByTurnId: {
              'turn-1': { turnId: 'turn-1', status: 'failed', error: 'legacy failure' }
            }
          }
        }
      })
    )
    const store = new ConversationTranscriptRecoveryStore(storage, () => 1)
    const canonicalHistory = [
      {
        id: 'assistant:turn-1:reloaded-history-item',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'canonical response' }],
        metadata: {
          codexSource: { turnId: 'turn-1' },
          codexTurn: { turnId: 'turn-1', status: 'completed' }
        }
      }
    ]

    expect(store.mergeWithHistory('thread-1', canonicalHistory)).toEqual([
      ...canonicalHistory,
      {
        id: 'assistant:turn-1:terminal',
        role: 'assistant',
        parts: [],
        metadata: {
          codexTurn: {
            turnId: 'turn-1',
            status: 'failed',
            error: { message: 'legacy failure' }
          }
        }
      }
    ])
    expect(storage.getItem(storageKey)).toContain('"version":8')
  })

  it('restores completed tool identity without persisting its input or output', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const terminalMessage: UIMessage = {
      id: 'assistant:turn-1:terminal',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolCallId: 'tool-1',
          toolName: 'shell',
          state: 'output-available',
          input: { command: 'contains-private-input' },
          output: { stdout: 'contains-private-output' }
        }
      ],
      metadata: {
        codexTurn: { turnId: 'turn-1', status: 'failed' }
      }
    }

    store.saveTerminalFallback('thread-1', [terminalMessage])

    const persisted = storage.getItem(storageKey) ?? ''
    expect(persisted).not.toContain('contains-private-input')
    expect(persisted).not.toContain('contains-private-output')
    expect(
      new ConversationTranscriptRecoveryStore(storage).mergeWithHistory('thread-1', [])
    ).toEqual([
      {
        id: 'assistant:turn-1:terminal',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolCallId: 'tool-1',
            toolName: 'shell',
            state: 'output-available',
            input: null,
            output: null
          }
        ],
        metadata: {
          codexTurn: { turnId: 'turn-1', status: 'failed' }
        }
      }
    ])
  })

  it('does not restore a failed fallback after canonical history has a later assistant response', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const failedFallback: UIMessage = {
      id: 'assistant:failed-turn:terminal',
      role: 'assistant',
      parts: [],
      metadata: {
        codexSource: { turnId: 'failed-turn' },
        codexTurn: { turnId: 'failed-turn', status: 'failed' }
      }
    }
    const canonicalHistory: UIMessage[] = [
      {
        id: failedFallback.id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'The initial response is canonical.' }],
        metadata: { codexSource: { turnId: 'failed-turn' } }
      },
      {
        id: 'assistant:recovered-turn:message',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The queued follow-up completed.' }],
        metadata: { codexSource: { turnId: 'recovered-turn' } }
      }
    ]

    store.saveTerminalFallback('thread-1', [failedFallback])

    expect(
      new ConversationTranscriptRecoveryStore(storage).mergeWithHistory(
        'thread-1',
        canonicalHistory
      )
    ).toEqual(canonicalHistory)
    expect(storage.getItem(storageKey)).toContain('"recoveries":{}')
  })

  it('retains a failed fallback when no later assistant response exists', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const failedFallback: UIMessage = {
      id: 'assistant:failed-turn:terminal',
      role: 'assistant',
      parts: [],
      metadata: { codexTurn: { turnId: 'failed-turn', status: 'failed' } }
    }

    store.saveTerminalFallback('thread-1', [failedFallback])

    expect(
      new ConversationTranscriptRecoveryStore(storage).mergeWithHistory('thread-1', [])
    ).toEqual([failedFallback])
  })

  it('restores rendered partial text into a canonical failed assistant item', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const renderedFailure: UIMessage = {
      id: 'assistant:turn-1:item-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Partial output before the transport failed.' }],
      metadata: {
        codexTurn: {
          turnId: 'turn-1',
          status: 'failed',
          error: { message: 'Transport failure' }
        }
      }
    }

    store.saveTerminalFallback('thread-1', [renderedFailure])

    const canonicalFailure: UIMessage = {
      ...renderedFailure,
      parts: [],
      metadata: {
        codexTurn: {
          turnId: 'turn-1',
          status: 'failed',
          error: { message: 'Canonical failure' }
        }
      }
    }

    expect(
      new ConversationTranscriptRecoveryStore(storage).mergeWithHistory('thread-1', [
        canonicalFailure
      ])
    ).toEqual([
      {
        ...canonicalFailure,
        parts: [{ type: 'text', text: 'Partial output before the transport failed.' }]
      }
    ])
  })

  it('merges a recovery fallback into the canonical history message for the same turn', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const fallback: UIMessage = {
      id: 'assistant:turn-1:renderer-item',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Partial output before the transport failed.' }],
      metadata: {
        codexTurn: {
          turnId: 'turn-1',
          status: 'failed',
          error: { message: 'Renderer failure' }
        }
      }
    }
    const canonicalFailure: UIMessage = {
      id: 'assistant:turn-1:server-item',
      role: 'assistant',
      parts: [],
      metadata: {
        codexSource: { turnId: 'turn-1' },
        codexTurn: {
          turnId: 'turn-1',
          status: 'failed',
          error: { message: 'Canonical failure' }
        }
      }
    }

    store.saveTerminalFallback('thread-1', [fallback])

    expect(
      new ConversationTranscriptRecoveryStore(storage).mergeWithHistory('thread-1', [
        canonicalFailure
      ])
    ).toEqual([
      {
        ...canonicalFailure,
        parts: [{ type: 'text', text: 'Partial output before the transport failed.' }]
      }
    ])
    expect(storage.getItem(storageKey)).toContain('"recoveries":{}')
  })

  it('removes an overlay after canonical history contains the same metadata', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const canonical = { ...serverUser, parts: [...serverUser.parts, localAttachment] }
    store.saveLocalAttachmentOverlay('thread-1', [canonical])

    expect(store.mergeWithHistory('thread-1', [canonical])).toEqual([canonical])
    expect(storage.getItem(storageKey)).toContain('"recoveries":{}')
  })

  it('tracks the canonical history revision without matching overlays by content', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    store.saveLocalAttachmentOverlay(
      'thread-1',
      [{ ...serverUser, parts: [...serverUser.parts, localAttachment] }],
      'revision-1'
    )

    expect(store.mergeWithHistory('thread-1', [serverUser], 'revision-2')).toEqual([
      { ...serverUser, parts: [...serverUser.parts, localAttachment] }
    ])
    expect(JSON.parse(storage.getItem(storageKey) ?? '{}')).toMatchObject({
      recoveries: { 'thread-1': { baseRevision: 'revision-2' } }
    })
  })

  it('removes each canonicalized attachment overlay without retaining sibling overlays', () => {
    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    const secondAttachment = {
      ...localAttachment,
      filename: 'second.txt',
      url: 'file:///tmp/second.txt'
    }
    const secondUser = {
      ...serverUser,
      id: 'user-2',
      parts: [...serverUser.parts, secondAttachment]
    }
    store.saveLocalAttachmentOverlay('thread-1', [
      { ...serverUser, parts: [...serverUser.parts, localAttachment] },
      secondUser
    ])

    expect(
      store.mergeWithHistory('thread-1', [
        { ...serverUser, parts: [...serverUser.parts, localAttachment] },
        { ...secondUser, parts: serverUser.parts }
      ])
    ).toHaveLength(2)

    expect(JSON.parse(storage.getItem(storageKey) ?? '{}')).toMatchObject({
      recoveries: {
        'thread-1': {
          attachmentsByMessageId: { 'user-2': [secondAttachment] }
        }
      }
    })
  })

  it('enforces the conversation limit at limit - 1, limit, and limit + 1 by evicting oldest overlays', () => {
    const storage = new MemoryStorage()
    let now = 0
    const store = new ConversationTranscriptRecoveryStore(storage, () => now)
    const makeMessage = (id: string): UIMessage => ({
      ...serverUser,
      id,
      parts: [
        ...serverUser.parts,
        { ...localAttachment, filename: `${id}.txt`, url: `file:///tmp/${id}.txt` }
      ]
    })

    for (let index = 0; index < TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS - 1; index += 1) {
      now += 1
      store.saveLocalAttachmentOverlay(`thread-${index}`, [makeMessage(`user-${index}`)])
    }
    expect(recoveryCount(storage)).toBe(TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS - 1)

    now += 1
    store.saveLocalAttachmentOverlay('thread-limit', [makeMessage('user-limit')])
    expect(recoveryCount(storage)).toBe(TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS)

    now += 1
    store.saveLocalAttachmentOverlay('thread-over-limit', [makeMessage('user-over-limit')])
    const recoveries = recoveriesFrom(storage)
    expect(Object.keys(recoveries)).toHaveLength(TRANSCRIPT_RECOVERY_MAX_CONVERSATIONS)
    expect(recoveries).not.toHaveProperty('thread-0')
    expect(recoveries).toHaveProperty('thread-over-limit')
  })

  it('enforces the byte limit at limit - 1, limit, and limit + 1', () => {
    const payloadBytesForUrlLength = (urlLength: number): number => {
      const storage = new MemoryStorage()
      const store = new ConversationTranscriptRecoveryStore(storage)
      store.saveLocalAttachmentOverlay('thread-size', [
        {
          ...serverUser,
          parts: [...serverUser.parts, { ...localAttachment, url: 'x'.repeat(urlLength) }]
        }
      ])
      return byteLength(storage.getItem(storageKey) ?? '')
    }
    const baselineBytes = payloadBytesForUrlLength(1)
    const urlLengthForPayload = (targetBytes: number): number => targetBytes - baselineBytes + 1

    for (const targetBytes of [
      TRANSCRIPT_RECOVERY_MAX_STORAGE_BYTES - 1,
      TRANSCRIPT_RECOVERY_MAX_STORAGE_BYTES
    ]) {
      const storage = new MemoryStorage()
      const store = new ConversationTranscriptRecoveryStore(storage)
      store.saveLocalAttachmentOverlay('thread-size', [
        {
          ...serverUser,
          parts: [
            ...serverUser.parts,
            { ...localAttachment, url: 'x'.repeat(urlLengthForPayload(targetBytes)) }
          ]
        }
      ])
      expect(byteLength(storage.getItem(storageKey) ?? '')).toBe(targetBytes)
      expect(recoveryCount(storage)).toBe(1)
    }

    const storage = new MemoryStorage()
    const store = new ConversationTranscriptRecoveryStore(storage)
    store.saveLocalAttachmentOverlay('thread-size', [
      {
        ...serverUser,
        parts: [
          ...serverUser.parts,
          {
            ...localAttachment,
            url: 'x'.repeat(urlLengthForPayload(TRANSCRIPT_RECOVERY_MAX_STORAGE_BYTES + 1))
          }
        ]
      }
    ])
    expect(recoveryCount(storage)).toBe(0)
  })

  it('migrates v1 data by retaining only whitelisted local attachments', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        recoveries: {
          'thread-1': {
            messages: [
              { ...serverUser, parts: [...serverUser.parts, localAttachment] },
              {
                id: 'assistant-1',
                role: 'assistant',
                parts: [{ type: 'text', text: 'must not be cached' }]
              }
            ]
          }
        }
      })
    )

    const store = new ConversationTranscriptRecoveryStore(storage)
    const merged = store.mergeWithHistory('thread-1', [serverUser])

    expect(merged[0]?.parts).toContainEqual(localAttachment)
    expect(JSON.stringify(storage.getItem(storageKey))).not.toContain('must not be cached')
    expect(storage.getItem(storageKey)).toContain('"version":8')
  })

  it('migrates v3 attachments and terminal fallbacks', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 3,
        recoveries: {
          'thread-1': {
            createdAt: 1,
            attachmentsByMessageId: { [serverUser.id]: [localAttachment] },
            terminalByMessageId: {
              'assistant:turn-1:live-item': { turnId: 'turn-1', status: 'failed' }
            }
          }
        }
      })
    )

    const store = new ConversationTranscriptRecoveryStore(storage, () => 1)
    const merged = store.mergeWithHistory('thread-1', [serverUser])
    expect(merged[0]?.parts).toContainEqual(localAttachment)
    expect(merged.at(-1)).toMatchObject({
      id: 'assistant:turn-1:live-item',
      metadata: { codexTurn: { turnId: 'turn-1', status: 'failed' } }
    })
    expect(storage.getItem(storageKey)).toContain('"version":8')
    expect(storage.getItem(storageKey)).not.toContain('terminalByTurnId')
  })

  it('migrates v5 overlays by adding an empty base revision', () => {
    const storage = new MemoryStorage()
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 5,
        recoveries: {
          'thread-1': {
            createdAt: 1,
            attachmentsByMessageId: { [serverUser.id]: [localAttachment] }
          }
        }
      })
    )

    const store = new ConversationTranscriptRecoveryStore(storage, () => 1)
    expect(store.mergeWithHistory('thread-1', [serverUser])[0]?.parts).toContainEqual(
      localAttachment
    )
    expect(JSON.parse(storage.getItem(storageKey) ?? '{}')).toMatchObject({
      version: 8,
      recoveries: { 'thread-1': { baseRevision: null } }
    })
  })

  it('discards expired overlays and reports malformed persisted data without using it', () => {
    const storage = new MemoryStorage()
    const now = 1_000_000
    storage.setItem(
      storageKey,
      JSON.stringify({
        version: 2,
        recoveries: {
          'thread-1': {
            createdAt: now - 8 * 24 * 60 * 60 * 1_000,
            attachmentsByMessageId: { [serverUser.id]: [localAttachment] }
          }
        }
      })
    )
    const store = new ConversationTranscriptRecoveryStore(storage, () => now)
    expect(store.mergeWithHistory('thread-1', [serverUser])).toEqual([serverUser])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    storage.setItem(storageKey, '{not json')
    const malformed = new ConversationTranscriptRecoveryStore(storage)
    expect(malformed.mergeWithHistory('thread-1', [serverUser])).toEqual([serverUser])
    expect(warn).toHaveBeenCalledWith(
      '[transcript-recovery]',
      expect.objectContaining({ reason: 'storage-read-or-migration-failed' })
    )
    warn.mockRestore()
  })

  it('retains overlays at TTL - 1 and TTL, then discards them at TTL + 1', () => {
    const now = TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS + 1_000
    for (const [age, shouldRetain] of [
      [TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS - 1, true],
      [TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS, true],
      [TRANSCRIPT_RECOVERY_OVERLAY_TTL_MS + 1, false]
    ] as const) {
      const storage = new MemoryStorage()
      storage.setItem(
        storageKey,
        JSON.stringify({
          version: 4,
          recoveries: {
            'thread-1': {
              createdAt: now - age,
              attachmentsByMessageId: { [serverUser.id]: [localAttachment] },
              terminalByTurnId: {}
            }
          }
        })
      )

      const store = new ConversationTranscriptRecoveryStore(storage, () => now)
      const merged = store.mergeWithHistory('thread-1', [serverUser])
      expect(merged[0]?.parts).toEqual(
        shouldRetain ? [...serverUser.parts, localAttachment] : serverUser.parts
      )
    }
  })
})

function recoveriesFrom(storage: MemoryStorage): Record<string, unknown> {
  const payload = JSON.parse(storage.getItem(storageKey) ?? '{}') as {
    recoveries?: Record<string, unknown>
  }
  return payload.recoveries ?? {}
}

function recoveryCount(storage: MemoryStorage): number {
  return Object.keys(recoveriesFrom(storage)).length
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
