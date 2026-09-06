import { describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'

import {
  createVitestPlanAssertionRecorder,
  planAssertionsForScenarios
} from '../../../../scripts/lib/test-plan-assertions.mjs'

import type {
  CodexChatStreamCallbacks,
  DesktopCodexChatApi,
  SidebarConversation,
  SidebarConversationOpenResult,
  ThreadGoalLoadResult
} from '../../../shared/codexIpcApi'
import { LOCAL_FILE_ATTACHMENT_MEDIA_TYPE } from '../../../shared/composerContext'
import { codexMessageProviderMetadata } from '../../../shared/codexMessageMetadata'
import { ConversationDraftStore } from './ConversationDraftStore'
import { ConversationChatRegistry } from './ConversationChatRegistry'
import { ConversationTranscriptRecoveryStore } from './ConversationTranscriptRecoveryStore'

const steerAssertionIds = [
  '已显示回答保持不变',
  '复用原 turn，不能额外启动 turn',
  '队列顺序与对话隔离正确'
]
const uiAssertionIds = [
  '错误、取消与重试 UI 正确',
  '历史与已显示内容保留',
  '可访问性、脱敏和 Composer 状态正确'
]
const { planAssert } = createVitestPlanAssertionRecorder(expect)

async function assertPlanEvidence(
  scenarioIds: readonly string[],
  assertionIds: readonly string[],
  assertion: () => void | Promise<void>
): Promise<void> {
  const record = planAssertionsForScenarios(scenarioIds, planAssert)
  for (const assertionId of assertionIds) {
    await record(assertionId, assertion)
  }
}

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

function registryFixture(
  options: {
    draftStore?: ConversationDraftStore
    loadThreadGoal?: (threadId: string) => Promise<ThreadGoalLoadResult>
  } = {}
): {
  bridge: DesktopCodexChatApi
  callbacks: Map<string, CodexChatStreamCallbacks>
  registry: ConversationChatRegistry
  transcriptRecoveryStore: ConversationTranscriptRecoveryStore
  recoveryStorage: MemoryStorage
} {
  const callbacks = new Map<string, CodexChatStreamCallbacks>()
  const bridge: DesktopCodexChatApi = {
    startChatStream: vi.fn((request, streamCallbacks) => {
      callbacks.set(request.chatId, streamCallbacks)
      return `stream-${request.chatId}`
    }),
    abortChatStream: vi.fn()
  }
  let sequence = 0
  const recoveryStorage = new MemoryStorage()
  const transcriptRecoveryStore = new ConversationTranscriptRecoveryStore(recoveryStorage)
  const registry = new ConversationChatRegistry({
    chatBridge: bridge,
    selectedModelId: 'gpt-test',
    draftStore: options.draftStore ?? new ConversationDraftStore(new MemoryStorage()),
    transcriptRecoveryStore,
    createId: () => `local-${sequence++}`,
    loadThreadGoal: options.loadThreadGoal
  })
  return { bridge, callbacks, registry, transcriptRecoveryStore, recoveryStorage }
}

describe('ConversationChatRegistry', () => {
  it('binds a real thread alias to the original Chat and transport', async () => {
    const { callbacks, registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry

    await entry.transport.sendMessages({
      chatId: entry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks.get(entry.controller.id)?.onThreadBound('thread-real')

    expect(registry.resolve('thread-real')).toBe(entry)
    expect(registry.getSnapshot().entries).toHaveLength(1)
    expect(entry.controller.id).toBe('local-0')
  })

  it('keeps Plan mode on a local chat when it receives a stable thread id', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry

    registry.setComposerModeKind(entry, 'plan')
    registry.bindThread(entry, 'thread-plan-mode')

    expect(entry.composerModeKind).toBe('plan')
    expect(registry.resolve('thread-plan-mode')?.composerModeKind).toBe('plan')
  })

  it('keeps approval mode on a local chat when it receives a stable thread id', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry

    registry.setApprovalModeKind(entry, 'full-access')
    registry.bindThread(entry, 'thread-approval-mode')

    expect(entry.approvalModeKind).toBe('full-access')
    expect(registry.resolve('thread-approval-mode')?.approvalModeKind).toBe('full-access')
  })

  it('starts new conversations with request approval', () => {
    const { registry } = registryFixture()

    expect(registry.getSnapshot().activeEntry.approvalModeKind).toBe('request-approval')
    expect(registry.startNewConversation().approvalModeKind).toBe('request-approval')
  })

  it('keeps approval modes isolated per conversation and sends each entry snapshot', async () => {
    const { bridge, registry } = registryFixture()
    const entryA = registry.getSnapshot().activeEntry
    registry.setApprovalModeKind(entryA, 'approve-for-me')
    registry.setDraft(entryA, 'draft A')
    registry.setComposerModeKind(entryA, 'plan')

    const entryB = registry.startNewConversation()
    registry.setApprovalModeKind(entryB, 'full-access')

    expect(entryA.approvalModeKind).toBe('approve-for-me')
    expect(entryB.approvalModeKind).toBe('full-access')
    expect(entryA.draft).toBe('draft A')
    expect(entryA.composerModeKind).toBe('plan')

    await entryA.transport.sendMessages({
      chatId: entryA.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    await entryB.transport.sendMessages({
      chatId: entryB.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    const requests = vi.mocked(bridge.startChatStream).mock.calls.map(([request]) => request)
    expect(requests.find((request) => request.chatId === entryA.controller.id)?.body).toMatchObject(
      {
        approvalModeKind: 'approve-for-me'
      }
    )
    expect(requests.find((request) => request.chatId === entryB.controller.id)?.body).toMatchObject(
      {
        approvalModeKind: 'full-access'
      }
    )
  })

  it('restores per-conversation approval mode from persisted drafts', () => {
    const draftStore = new ConversationDraftStore(new MemoryStorage())
    draftStore.setApprovalModeKind('local-0', 'approve-for-me')
    const { registry } = registryFixture({ draftStore })

    expect(registry.getSnapshot().activeEntry.approvalModeKind).toBe('approve-for-me')
  })

  it('uses the server acknowledgement to correct a conversation mode intent', async () => {
    const { callbacks, registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.setComposerModeKind(entry, 'plan')

    await entry.transport.sendMessages({
      chatId: entry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks.get(entry.controller.id)?.onModeApplied?.('thread-plan-mode', 'default')

    expect(entry.composerModeKind).toBe('default')
  })

  it('leaves Plan mode before opening the Goal editor', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.setComposerModeKind(entry, 'plan')

    registry.setGoalEditorActive(entry, true)

    expect(entry).toMatchObject({ composerModeKind: 'default', goalEditorActive: true })
  })

  it('hydrates a newly saved Goal after the first turn finishes', async () => {
    const loadThreadGoal = vi.fn().mockResolvedValue({
      status: 'loaded',
      goal: {
        threadId: 'thread-goal',
        objective: '完成目标',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1
      }
    })
    const { callbacks, registry } = registryFixture({ loadThreadGoal })
    const entry = registry.getSnapshot().activeEntry

    registry.setGoalEditorActive(entry, true)
    await entry.transport.sendMessages({
      chatId: entry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [
        {
          id: 'goal-user-message',
          role: 'user',
          parts: [{ type: 'text', text: '完成目标' }]
        }
      ],
      abortSignal: undefined
    })
    callbacks.get(entry.controller.id)?.onThreadBound('thread-goal')
    callbacks.get(entry.controller.id)?.onFinish('thread-goal')

    await vi.waitFor(() => {
      expect(entry.threadGoal?.objective).toBe('完成目标')
      expect(entry.goalEditorActive).toBe(false)
    })
    expect(loadThreadGoal).toHaveBeenCalledWith('thread-goal')
  })

  it('persists the local identity as soon as a new stream starts', async () => {
    const startedConversationIds: string[] = []
    const { bridge, callbacks, transcriptRecoveryStore } = registryFixture()
    const registry = new ConversationChatRegistry({
      chatBridge: bridge,
      selectedModelId: 'gpt-test',
      draftStore: new ConversationDraftStore(new MemoryStorage()),
      transcriptRecoveryStore,
      createId: () => 'local-persisted',
      onStreamStarted: (conversationId) => startedConversationIds.push(conversationId)
    })
    const entry = registry.getSnapshot().activeEntry

    const send = entry.controller.sendMessage({
      id: 'persist-user',
      role: 'user',
      parts: [{ type: 'text', text: 'persist before thread binding' }]
    })
    await vi.waitFor(() => expect(callbacks.get(entry.controller.id)).toBeDefined())

    expect(startedConversationIds).toEqual(['local-persisted'])
    callbacks.get(entry.controller.id)?.onAbort()
    await send
  })

  it('reuses an alias without loading history or creating a second entry', async () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.bindThread(entry, 'thread-real')
    const load = vi.fn()

    await expect(registry.openConversation('thread-real', load)).resolves.toBe(entry)
    expect(load).not.toHaveBeenCalled()
    expect(registry.getSnapshot().entries).toHaveLength(1)
  })

  it('rebinds a terminal retry to its fresh thread without retaining the failed thread alias', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.bindThread(entry, 'thread-failed')

    const rebound = registry.bindThread(entry, 'thread-retry', true)

    expect(rebound).toBe(entry)
    expect(registry.resolve('thread-failed')).toBeUndefined()
    expect(registry.resolve('thread-retry')).toBe(entry)
    expect(entry.context).toMatchObject({
      conversationId: 'thread-retry',
      threadId: 'thread-retry'
    })
  })

  it('rebinds a terminal retry when its conversation state arrives before the transport event', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.bindThread(entry, 'thread-failed')

    registry.applyConversationMetadata([
      {
        id: 'thread-retry',
        threadId: 'thread-retry',
        originConversationId: 'thread-failed',
        title: 'Retried conversation'
      }
    ])

    expect(entry.context).toMatchObject({
      conversationId: 'thread-retry',
      threadId: 'thread-retry'
    })
    expect(registry.resolve('thread-failed')).toBeUndefined()
    expect(registry.resolve('thread-retry')).toBe(entry)
  })

  it('restores a local conversation from a main-owned run before thread binding', async () => {
    const { bridge, registry } = registryFixture()
    const callbacks = new Map<string, CodexChatStreamCallbacks>()
    bridge.getActiveSnapshot = vi.fn(async (conversationId: string) =>
      conversationId === 'local-recovery'
        ? {
            run: {
              runId: 'run-local-recovery',
              conversationId,
              state: 'active' as const,
              runKind: 'single-turn' as const,
              lastSequence: 0
            },
            baseMessages: [
              {
                id: 'user-recovered',
                role: 'user',
                parts: [{ type: 'text', text: 'Restore this local prompt.' }]
              }
            ] satisfies readonly UIMessage[]
          }
        : null
    )
    bridge.attachChatStream = vi.fn(async (conversationId, streamCallbacks) => {
      callbacks.set(conversationId, streamCallbacks)
      return 'attached-local-recovery'
    })

    await expect(registry.restoreActiveConversation('local-recovery')).resolves.toBe(true)
    await vi.waitFor(() => expect(callbacks.get('local-recovery')).toBeDefined())

    callbacks.get('local-recovery')?.onThreadBound('thread-recovered')
    callbacks.get('local-recovery')?.onChunk({ type: 'text-start', id: 'text' })
    callbacks.get('local-recovery')?.onChunk({ type: 'text-delta', id: 'text', delta: 'Recovered' })
    callbacks.get('local-recovery')?.onFinish('thread-recovered')
    await flushRecoveryWork()

    const entry = registry.getSnapshot().activeEntry
    expect(entry.localId).toBe('local-recovery')
    expect(entry.context.threadId).toBe('thread-recovered')
    expect(entry.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          parts: [expect.objectContaining({ type: 'text', text: 'Restore this local prompt.' })]
        }),
        expect.objectContaining({
          role: 'assistant',
          parts: [expect.objectContaining({ type: 'text', text: 'Recovered' })]
        })
      ])
    )
    expect(vi.mocked(bridge.startChatStream)).not.toHaveBeenCalled()
  })

  it('does not attach a duplicate recovery stream to a local stream that is already live', async () => {
    const { bridge, registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    await entry.transport.sendMessages({
      chatId: entry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    bridge.getActiveSnapshot = vi.fn(async (conversationId: string) => ({
      run: {
        runId: 'run-live-local-stream',
        conversationId,
        state: 'active' as const,
        runKind: 'single-turn' as const,
        threadId: 'thread-live-local-stream',
        lastSequence: 3
      },
      baseMessages: []
    }))
    bridge.attachChatStream = vi.fn(async () => 'duplicate-attachment')

    await expect(registry.restoreActiveConversation(entry.localId)).resolves.toBe(true)

    expect(entry.context.threadId).toBe('thread-live-local-stream')
    expect(bridge.attachChatStream).not.toHaveBeenCalled()
  })

  it('coalesces local and thread identity recovery into one replay stream', async () => {
    const { bridge, registry } = registryFixture()
    const callbacks = new Map<string, CodexChatStreamCallbacks>()
    bridge.getActiveSnapshot = vi.fn(async () => ({
      run: {
        runId: 'run-identity-race',
        conversationId: 'local-identity-race',
        state: 'active' as const,
        runKind: 'single-turn' as const,
        threadId: 'thread-identity-race',
        lastSequence: 4
      },
      baseMessages: []
    }))
    bridge.attachChatStream = vi.fn(async (conversationId, streamCallbacks) => {
      callbacks.set(conversationId, streamCallbacks)
      return 'attached-identity-race'
    })

    await expect(registry.restoreActiveConversation('thread-identity-race')).resolves.toBe(true)
    expect(registry.resolve('local-identity-race')).toBe(registry.resolve('thread-identity-race'))
    await expect(registry.restoreActiveConversation('local-identity-race')).resolves.toBe(true)
    await vi.waitFor(() => expect(bridge.attachChatStream).toHaveBeenCalledOnce())

    const entry = registry.getSnapshot().activeEntry
    expect(
      registry.getSnapshot().entries.filter((candidate) => candidate.localId !== 'local-0')
    ).toEqual([entry])
    expect(registry.resolve('local-identity-race')).toBe(entry)
    expect(registry.resolve('thread-identity-race')).toBe(entry)
    callbacks.get('thread-identity-race')?.onFinish('thread-identity-race')
  })

  it('F16 treats app-server history as canonical after a failed turn', async () => {
    const { registry } = registryFixture()
    const user = {
      id: 'recovery-user',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'recover partial answer' }]
    }
    const entry = await registry.openConversation('recovery', async () => ({
      conversationId: 'recovery',
      threadId: 'thread-recovery',
      title: 'recovery',
      messages: [user]
    }))

    expect(entry.messages).toHaveLength(1)
    expect(entry.messages[0]).toMatchObject({
      role: 'user',
      sourceMessageId: user.id,
      parts: user.parts
    })
  })

  it('loads canonical history instead of replaying a retained terminal run after reload', async () => {
    const { bridge, registry } = registryFixture()
    const terminalRun = {
      runId: 'run-terminal-reload',
      conversationId: 'thread-steered',
      state: 'terminal' as const,
      runKind: 'single-turn' as const,
      threadId: 'thread-steered',
      lastSequence: 8
    }
    bridge.getActiveSnapshot = vi.fn(async () => ({
      run: terminalRun,
      baseMessages: [
        {
          id: 'initial-user',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: 'Initial request.' }]
        }
      ]
    }))
    bridge.getActiveRun = vi.fn(async () => terminalRun)
    bridge.attachChatStream = vi.fn(async () => 'unexpected-terminal-replay')

    await expect(registry.restoreActiveConversation('thread-steered')).resolves.toBe(false)

    const entry = await registry.openConversation('thread-steered', async () => ({
      conversationId: 'thread-steered',
      threadId: 'thread-steered',
      title: 'Steered conversation',
      messages: [
        {
          id: 'initial-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Initial request.' }]
        },
        {
          id: 'initial-assistant',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Initial response.' }]
        },
        {
          id: 'steer-user',
          role: 'user',
          parts: [{ type: 'text', text: 'Steer follow-up.' }]
        },
        {
          id: 'steer-assistant',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Steered response.' }]
        }
      ]
    }))
    await flushRecoveryWork()

    expect(entry.messages).toHaveLength(4)
    expect(entry.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          sourceMessageId: 'steer-user',
          parts: [{ type: 'text', text: 'Steer follow-up.' }]
        })
      ])
    )
    expect(bridge.attachChatStream).not.toHaveBeenCalled()
  })

  it('does not retry an unknown active-conversation recovery after 750ms', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, registry } = registryFixture()
      bridge.attachChatStream = vi
        .fn()
        .mockRejectedValueOnce(new Error('transport disconnected'))
        .mockResolvedValue(null)

      const entry = await registry.openConversation('recover-retry', async () =>
        openResult('recover-retry')
      )
      await flushRecoveryWork()

      expect(entry.recoveryPhase).toBe('needs_resume')
      expect(entry.recoveryError?.message).toBe('任务连接已中断，无法自动恢复。')
      await vi.advanceTimersByTimeAsync(750)
      await flushRecoveryWork()

      expect(bridge.attachChatStream).toHaveBeenCalledTimes(1)
      expect(entry.recoveryPhase).toBe('needs_resume')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps replayed recovery text visible and marks attach rejection as needs_resume', async () => {
    const { bridge, registry } = registryFixture()
    bridge.attachChatStream = vi.fn(async (_conversationId, streamCallbacks) => {
      streamCallbacks.onChunk({ type: 'text-start', id: 'replayed-text' })
      streamCallbacks.onChunk({
        type: 'text-delta',
        id: 'replayed-text',
        delta: 'Recovered partial answer.'
      })
      streamCallbacks.onError({
        code: 'run-mismatch',
        message: 'The active run changed before recovery could attach.'
      })
      return 'stream-recovered'
    })

    const entry = await registry.openConversation('recover-rejected', async () =>
      openResult('recover-rejected')
    )
    await flushRecoveryWork()

    expect(entry.recoveryPhase).toBe('needs_resume')
    expect(entry.recoveryError).toMatchObject({
      code: 'run-mismatch',
      message: 'The active run changed before recovery could attach.'
    })
    expect(entry.messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [expect.objectContaining({ type: 'text', text: 'Recovered partial answer.' })]
    })
  })

  it('drops a persisted failed fallback after a later assistant response succeeds', () => {
    const { registry, recoveryStorage } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.bindThread(entry, 'thread-recovery')
    const failedMessage = {
      id: 'assistant:failed-turn:terminal',
      role: 'assistant' as const,
      parts: [],
      metadata: { codexTurn: { turnId: 'failed-turn', status: 'failed' as const } }
    }
    const recoveredMessage = {
      id: 'assistant:recovered-turn:message',
      role: 'assistant' as const,
      parts: [{ type: 'text' as const, text: 'The queued follow-up completed.' }]
    }

    entry.controller.replaceMessages([failedMessage])
    expect(recoveryStorage.getItem('das-cowork.transcript-recovery.v1')).toContain('failed-turn')

    entry.controller.replaceMessages([failedMessage, recoveredMessage])

    expect(recoveryStorage.getItem('das-cowork.transcript-recovery.v1')).toContain(
      '"recoveries":{}'
    )
  })

  it('clears a failed fallback only after a later turn settles successfully', async () => {
    const { bridge, callbacks, registry, recoveryStorage } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    const failedSend = entry.controller.sendMessage({
      id: 'failed-user',
      role: 'user',
      parts: [{ type: 'text', text: 'fail first' }]
    })
    await vi.waitFor(() => expect(callbacks.get(entry.controller.id)).toBeDefined())
    const failedStream = callbacks.get(entry.controller.id)
    failedStream?.onThreadBound('thread-recovery')
    failedStream?.onTurnLifecycle?.({
      type: 'turn-started',
      sequence: 1,
      threadId: 'thread-recovery',
      turnId: 'failed-turn'
    })
    failedStream?.onError('network disconnect')
    await expect(failedSend).rejects.toThrow('network disconnect')
    expect(recoveryStorage.getItem('das-cowork.transcript-recovery.v1')).toContain('failed-turn')

    const recoveredSend = entry.controller.sendMessage({
      id: 'recovered-user',
      role: 'user',
      parts: [{ type: 'text', text: 'recover now' }]
    })
    await vi.waitFor(() => expect(vi.mocked(bridge.startChatStream)).toHaveBeenCalledTimes(2))
    const recoveredStream = callbacks.get(entry.controller.id)
    recoveredStream?.onTurnLifecycle?.({
      type: 'turn-started',
      sequence: 1,
      threadId: 'thread-recovery',
      turnId: 'recovered-turn'
    })
    recoveredStream?.onChunk({ type: 'start', messageId: 'recovered-assistant' })
    recoveredStream?.onChunk({ type: 'text-start', id: 'recovered-text' })
    recoveredStream?.onChunk({ type: 'text-delta', id: 'recovered-text', delta: 'Recovered.' })
    recoveredStream?.onTurnLifecycle?.({
      type: 'turn-completed',
      sequence: 2,
      threadId: 'thread-recovery',
      turnId: 'recovered-turn',
      outcome: 'completed'
    })
    recoveredStream?.onChunk({ type: 'finish' })
    recoveredStream?.onFinish('thread-recovery')
    await recoveredSend

    expect(entry.status).toBe('ready')
    expect(recoveryStorage.getItem('das-cowork.transcript-recovery.v1')).toContain(
      '"recoveries":{}'
    )
  })

  it('B08 restores only a stable-id local attachment overlay', async () => {
    const { bridge, registry, transcriptRecoveryStore } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.bindThread(entry, 'thread-client-tool')
    const user = {
      id: 'client-tool-user',
      role: 'user' as const,
      parts: [
        {
          type: 'text' as const,
          text: 'read the attached document'
        },
        {
          type: 'file' as const,
          mediaType: LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
          filename: 'notes.txt',
          url: 'file:///tmp/notes.txt'
        }
      ]
    }
    transcriptRecoveryStore.saveLocalAttachmentOverlay('thread-client-tool', [user], 'revision-1')
    const serverHistory = [
      {
        id: user.id,
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'read the attached document' }]
      }
    ]

    const reloaded = new ConversationChatRegistry({
      chatBridge: bridge,
      selectedModelId: 'gpt-test',
      draftStore: new ConversationDraftStore(new MemoryStorage()),
      transcriptRecoveryStore,
      createId: () => 'local-reloaded'
    })
    const restored = await reloaded.openConversation('thread-client-tool', async () => ({
      conversationId: 'thread-client-tool',
      threadId: 'thread-client-tool',
      title: 'attachment history',
      historyRevision: 'revision-2',
      messages: serverHistory
    }))

    expect(restored.messages).toHaveLength(1)
    expect(restored.messages[0]?.parts).toContainEqual(user.parts[1])
  })

  it('does not re-save a canonical attachment during history hydration', async () => {
    const { bridge, transcriptRecoveryStore, recoveryStorage } = registryFixture()
    const user = {
      id: 'canonical-attachment-user',
      role: 'user' as const,
      parts: [
        { type: 'text' as const, text: 'already recorded by app-server' },
        {
          type: 'file' as const,
          mediaType: LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
          filename: 'notes.txt',
          url: 'file:///tmp/notes.txt'
        }
      ]
    }
    transcriptRecoveryStore.saveLocalAttachmentOverlay('thread-canonical', [user], 'revision-1')

    const hydrated = new ConversationChatRegistry({
      chatBridge: bridge,
      transcriptRecoveryStore,
      createId: () => 'local-hydrated'
    })
    await hydrated.openConversation('thread-canonical', async () => ({
      conversationId: 'thread-canonical',
      threadId: 'thread-canonical',
      title: 'canonical attachment history',
      historyRevision: 'revision-2',
      messages: [user]
    }))

    expect(
      JSON.parse(recoveryStorage.getItem('das-cowork.transcript-recovery.v1') ?? '{}')
    ).toMatchObject({
      recoveries: {}
    })

    const reloaded = new ConversationChatRegistry({
      chatBridge: bridge,
      transcriptRecoveryStore,
      createId: () => 'local-reloaded'
    })
    const withoutAttachment = await reloaded.openConversation('thread-canonical', async () => ({
      conversationId: 'thread-canonical',
      threadId: 'thread-canonical',
      title: 'canonical attachment history',
      historyRevision: 'revision-3',
      messages: [
        {
          ...user,
          parts: [{ type: 'text' as const, text: 'already recorded by app-server' }]
        }
      ]
    }))

    expect(withoutAttachment.messages[0]?.parts).toEqual([
      { type: 'text', text: 'already recorded by app-server' }
    ])
  })

  it('keeps the last navigation active when history loads out of order', async () => {
    const { registry } = registryFixture()
    const loads = {
      a: deferred<SidebarConversationOpenResult>(),
      b: deferred<SidebarConversationOpenResult>(),
      c: deferred<SidebarConversationOpenResult>()
    }

    const openA = registry.openConversation('a', () => loads.a.promise)
    const openB = registry.openConversation('b', () => loads.b.promise)
    const openC = registry.openConversation('c', () => loads.c.promise)
    loads.b.resolve(openResult('b'))
    loads.c.resolve(openResult('c'))
    loads.a.resolve(openResult('a'))
    await Promise.all([openA, openB, openC])

    expect(registry.getSnapshot().activeEntry.context.conversationId).toBe('c')
    expect(registry.resolve('thread-a')?.messages[0]?.renderId).toBe('message:message-a')
    expect(registry.resolve('thread-b')?.messages[0]?.renderId).toBe('message:message-b')
  })

  it('seeds a loading conversation with metadata already known by the sidebar', async () => {
    const { registry } = registryFixture()
    const pending = deferred<SidebarConversationOpenResult>()
    const conversation: SidebarConversation = {
      id: 'sidebar-id',
      threadId: 'thread-sidebar-id',
      title: 'Known conversation',
      projectAssignment: { projectKind: 'local', projectId: 'project-1', cwd: '/repo' },
      cwd: '/repo'
    }
    registry.applyConversationMetadata([conversation])

    const open = registry.openConversation('sidebar-id', () => pending.promise)
    const loadingEntry = registry.getSnapshot().activeEntry

    expect(loadingEntry).toMatchObject({ loaded: false, status: 'loading' })
    expect(loadingEntry.context).toMatchObject({
      conversationId: 'sidebar-id',
      title: 'Known conversation',
      projectSelection: { projectKind: 'local', projectId: 'project-1' },
      cwd: '/repo'
    })

    pending.resolve(openResult('sidebar-id'))
    await open
  })

  it('shares a pending history load when automatic restoration and a sidebar click target the same conversation', async () => {
    const { registry } = registryFixture()
    const pending = deferred<SidebarConversationOpenResult>()
    const automaticRestore = vi.fn(() => pending.promise)
    const sidebarOpen = vi.fn(async () => openResult('sidebar-id'))

    const restored = registry.openConversation('sidebar-id', automaticRestore)
    const clicked = registry.openConversation('sidebar-id', sidebarOpen)

    expect(automaticRestore).toHaveBeenCalledOnce()
    expect(sidebarOpen).not.toHaveBeenCalled()
    expect(registry.getSnapshot().activeEntry).toMatchObject({
      localId: 'sidebar-id',
      loaded: false,
      status: 'loading'
    })

    pending.resolve(openResult('sidebar-id'))
    const [restoredEntry, clickedEntry] = await Promise.all([restored, clicked])

    expect(clickedEntry).toBe(restoredEntry)
    expect(restoredEntry).toMatchObject({ loaded: true, status: 'ready' })
    expect(restoredEntry.messages[0]?.renderId).toBe('message:message-sidebar-id')
  })

  it('does not let a pending history load overwrite a live thread-bound entry', async () => {
    const { callbacks, registry } = registryFixture()
    const liveEntry = registry.getSnapshot().activeEntry
    liveEntry.controller.replaceMessages([
      { id: 'live-message', role: 'assistant', parts: [{ type: 'text', text: 'live' }] }
    ])
    await liveEntry.transport.sendMessages({
      chatId: liveEntry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    const pending = deferred<SidebarConversationOpenResult>()
    const open = registry.openConversation('sidebar-id', () => pending.promise)
    const placeholder = registry.getSnapshot().activeEntry
    expect(placeholder.localId).toBe('sidebar-id')

    callbacks.get(liveEntry.controller.id)?.onThreadBound('thread-sidebar-id')

    pending.resolve(openResult('sidebar-id'))
    const openedEntry = await open

    expect(openedEntry).toBe(liveEntry)
    expect(liveEntry.messages[0]?.renderId).toBe('message:live-message')
    expect(registry.getSnapshot().entries).not.toContainEqual(
      expect.objectContaining({ localId: 'sidebar-id' })
    )

    registry.setDraft(placeholder, 'late draft')
    registry.setApprovalModeKind(placeholder, 'approve-for-me')
    registry.setSelectedModel(placeholder, 'late model')
    registry.setScroll(placeholder, { scrollTop: 64, followBottom: false })

    expect(liveEntry.draft).toBe('late draft')
    expect(liveEntry.approvalModeKind).toBe('approve-for-me')
    expect(liveEntry.selectedModelId).toBe('late model')
    expect(liveEntry.scroll).toEqual({ scrollTop: 64, followBottom: false })
  })

  it('merges a loaded sidebar placeholder into the live entry when thread binding arrives late', async () => {
    const { callbacks, registry } = registryFixture()
    const liveEntry = registry.getSnapshot().activeEntry
    liveEntry.controller.replaceMessages([
      { id: 'live-message', role: 'user', parts: [{ type: 'text', text: 'live' }] }
    ])
    await liveEntry.transport.sendMessages({
      chatId: liveEntry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    const placeholder = await registry.openConversation('sidebar-id', async () => ({
      ...openResult('sidebar-id'),
      title: 'Sidebar title',
      cwd: '/repo',
      projectAssignment: { projectKind: 'local', projectId: 'project-1', cwd: '/repo' }
    }))
    expect(placeholder).not.toBe(liveEntry)

    callbacks.get(liveEntry.controller.id)?.onThreadBound('thread-sidebar-id')

    expect(registry.resolve('thread-sidebar-id')).toBe(liveEntry)
    expect(registry.resolve('sidebar-id')).toBe(liveEntry)
    expect(registry.getSnapshot().activeEntry).toBe(liveEntry)
    expect(registry.getSnapshot().entries).toEqual([liveEntry])
    expect(liveEntry.messages[0]?.renderId).toBe('message:live-message')
    expect(liveEntry.context).toMatchObject({
      conversationId: 'sidebar-id',
      threadId: 'thread-sidebar-id',
      title: 'Sidebar title',
      projectSelection: { projectKind: 'local', projectId: 'project-1' },
      cwd: '/repo'
    })

    registry.setDraft(placeholder, 'canonical draft')
    registry.setApprovalModeKind(placeholder, 'full-access')
    registry.setSelectedModel(placeholder, 'model-after-merge')
    registry.setScroll(placeholder, { scrollTop: 120, followBottom: false })

    expect(liveEntry.draft).toBe('canonical draft')
    expect(liveEntry.approvalModeKind).toBe('full-access')
    expect(liveEntry.selectedModelId).toBe('model-after-merge')
    expect(liveEntry.scroll).toEqual({ scrollTop: 120, followBottom: false })
  })

  it('ignores a late scroll snapshot after the registry is destroyed', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry

    registry.destroy()

    expect(() => registry.setScroll(entry, { scrollTop: 64, followBottom: false })).not.toThrow()
  })

  it('retries a failed history load instead of turning the selected thread into a new chat', async () => {
    const { registry } = registryFixture()

    const failedOpenResult = await registry.openConversation('retry-me', async () => {
      throw new Error('temporary load failure')
    })
    const failedEntry = registry.resolve('retry-me')
    expect(failedOpenResult).toBe(failedEntry)
    expect(failedEntry).toMatchObject({ loaded: false, status: 'error' })

    const retriedEntry = await registry.openConversation('retry-me', async () =>
      openResult('retry-me')
    )

    expect(retriedEntry).toBe(failedEntry)
    expect(retriedEntry).toMatchObject({ loaded: true, status: 'ready' })
    expect(retriedEntry.context.threadId).toBe('thread-retry-me')
  })

  it('applies sidebar metadata to a live bound entry without replacing its Chat', () => {
    const { registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.bindThread(entry, 'thread-live')

    registry.applyConversationMetadata([
      {
        id: 'thread-live',
        threadId: 'thread-live',
        title: 'Live title',
        cwd: '/repo',
        projectAssignment: { projectKind: 'local', projectId: 'project-1', cwd: '/repo' }
      }
    ])

    expect(registry.resolve('thread-live')).toBe(entry)
    expect(registry.getSnapshot().entries).toEqual([entry])
    expect(entry.context).toMatchObject({
      title: 'Live title',
      cwd: '/repo',
      projectSelection: { projectKind: 'local', projectId: 'project-1' }
    })
  })

  it('binds a thread created after abort back to its origin entry', async () => {
    const { callbacks, registry } = registryFixture()
    const originEntry = registry.getSnapshot().activeEntry
    const send = originEntry.controller.sendMessage({
      id: 'aborted-user',
      role: 'user',
      parts: [{ type: 'text', text: 'abort this turn' }]
    })
    await vi.waitFor(() => expect(callbacks.get(originEntry.controller.id)).toBeDefined())
    callbacks.get(originEntry.controller.id)?.onTurnLifecycle?.({
      type: 'turn-started',
      threadId: 'thread-aborted',
      turnId: 'turn-aborted',
      sequence: 1
    })
    callbacks.get(originEntry.controller.id)?.onTurnLifecycle?.({
      type: 'turn-completed',
      threadId: 'thread-aborted',
      turnId: 'turn-aborted',
      sequence: 2,
      outcome: 'interrupted'
    })
    callbacks.get(originEntry.controller.id)?.onAbort()
    await send
    expect(originEntry.status).toBe('ready')
    expect(originEntry.error).toBeUndefined()
    expect(originEntry.messages.at(-1)).toMatchObject({
      role: 'assistant',
      metadata: {
        codexTurn: {
          status: 'interrupted'
        }
      }
    })

    registry.applyConversationMetadata([
      {
        id: 'thread-after-abort',
        threadId: 'thread-after-abort',
        originConversationId: originEntry.localId,
        title: 'Created after abort'
      }
    ])

    expect(registry.resolve('thread-after-abort')).toBe(originEntry)
    expect(registry.getSnapshot().entries).toEqual([originEntry])
    expect(originEntry.context).toMatchObject({
      conversationId: 'thread-after-abort',
      threadId: 'thread-after-abort',
      title: 'Created after abort'
    })
    const load = vi.fn()
    await expect(registry.openConversation('thread-after-abort', load)).resolves.toBe(originEntry)
    expect(load).not.toHaveBeenCalled()
  })

  it('F15 tracks submitted, background unread, and entry-scoped errors independently', async () => {
    const { callbacks, registry } = registryFixture()
    const entryA = registry.getSnapshot().activeEntry
    const send = entryA.controller.sendMessage({
      id: 'failing-user',
      role: 'user',
      parts: [{ type: 'text', text: 'fail this turn' }]
    })
    void send.catch(() => undefined)
    await vi.waitFor(() => expect(callbacks.get(entryA.controller.id)).toBeDefined())
    expect(entryA.status).toBe('submitted')

    const entryB = registry.startNewConversation()
    callbacks.get(entryA.controller.id)?.onChunk({ type: 'text-start', id: 'text-a' })
    expect(entryA.status).toBe('streaming')
    expect(entryA.unread).toBe(true)
    expect(entryB.unread).toBe(false)

    callbacks.get(entryA.controller.id)?.onError('A failed')
    await expect(send).rejects.toThrow('A failed')
    expect(entryA.status).toBe('error')
    expect(entryA.error?.message).toBe('A failed')
    expect(entryA.messages.at(-1)).toMatchObject({
      role: 'assistant',
      metadata: {
        codexTurn: {
          status: 'failed',
          error: { message: 'A failed' }
        }
      }
    })
    expect(entryB.status).toBe('ready')

    await registry.openConversation(entryA.localId, async () => openResult('unused'))
    expect(entryA.unread).toBe(false)
    await assertPlanEvidence(['F15'], uiAssertionIds, () => {
      expect(entryA.status).toBe('error')
      expect(entryA.error?.message).toBe('A failed')
      expect(entryA.unread).toBe(false)
      expect(entryB.status).toBe('ready')
    })
  })

  it('does not publish a registry snapshot for a text-only streaming delta', async () => {
    const { callbacks, registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    const send = entry.controller.sendMessage({
      id: 'streaming-user',
      role: 'user',
      parts: [{ type: 'text', text: 'stream a response' }]
    })
    void send.catch(() => undefined)
    await vi.waitFor(() => expect(callbacks.get(entry.controller.id)).toBeDefined())
    const stream = callbacks.get(entry.controller.id)
    stream?.onChunk({ type: 'start', messageId: 'streaming-assistant' })
    stream?.onChunk({ type: 'text-start', id: 'streaming-text' })
    await vi.waitFor(() => expect(entry.status).toBe('streaming'))

    let notifications = 0
    const unsubscribe = registry.subscribe(() => {
      notifications += 1
    })
    stream?.onChunk({ type: 'text-delta', id: 'streaming-text', delta: 'Visible text' })

    await vi.waitFor(() =>
      expect(entry.messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'Visible text' })
      ])
    )
    expect(notifications).toBe(0)
    stream?.onError('finish stream')
    await expect(send).rejects.toThrow('finish stream')
    expect(notifications).toBe(1)
    unsubscribe()
  })

  it('A13 preserves a pending Steer while navigating away from and back to its running conversation', async () => {
    const { bridge, callbacks, registry } = registryFixture()
    const entryA = registry.getSnapshot().activeEntry
    const send = entryA.controller.sendMessage({
      id: 'a13-user',
      role: 'user',
      parts: [{ type: 'text', text: 'keep this response visible' }]
    })
    await vi.waitFor(() => expect(callbacks.get(entryA.controller.id)).toBeDefined())
    const streamA = callbacks.get(entryA.controller.id)
    streamA?.onChunk({ type: 'start', messageId: 'a13-assistant' })
    streamA?.onChunk({ type: 'text-start', id: 'a13-text' })
    streamA?.onChunk({ type: 'text-delta', id: 'a13-text', delta: 'visible before navigation' })
    await vi.waitFor(() =>
      expect(entryA.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            parts: [expect.objectContaining({ type: 'text', text: 'visible before navigation' })]
          })
        ])
      )
    )

    entryA.controller.stageSteeringMessage(
      {
        id: 'a13-steer',
        role: 'user',
        parts: [{ type: 'text', text: 'continue with this correction' }]
      },
      { clientUserMessageId: 'a13-steer', targetTurnId: entryA.controller.getActiveTurnId()! }
    )
    const entryB = registry.startNewConversation()
    expect(registry.getSnapshot().activeEntry).toBe(entryB)
    streamA?.onChunk({ type: 'text-delta', id: 'a13-text', delta: ' while away' })
    await vi.waitFor(() => expect(entryA.unread).toBe(true))

    const reload = vi.fn(async () => openResult('should-not-reload'))
    await expect(registry.openConversation(entryA.localId, reload)).resolves.toBe(entryA)
    expect(reload).not.toHaveBeenCalled()
    expect(registry.getSnapshot().activeEntry).toBe(entryA)
    expect(entryA.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          parts: [
            expect.objectContaining({
              type: 'text',
              text: expect.stringContaining('visible before navigation')
            })
          ]
        }),
        expect.objectContaining({
          renderId: 'steer:a13-steer',
          targetTurnId: entryA.controller.getActiveTurnId(),
          status: 'pending'
        })
      ])
    )
    expect(vi.mocked(bridge.startChatStream)).toHaveBeenCalledTimes(1)
    await assertPlanEvidence(['A13'], steerAssertionIds, () => {
      expect(vi.mocked(bridge.startChatStream)).toHaveBeenCalledTimes(1)
      expect(registry.getSnapshot().activeEntry).toBe(entryA)
      expect(entryA.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ renderId: 'steer:a13-steer', status: 'pending' })
        ])
      )
    })

    streamA?.onChunk({ type: 'finish' })
    streamA?.onFinish()
    await send
  })

  it('A14 keeps concurrent Steers, transports, and transcript output isolated per conversation', async () => {
    const { bridge, callbacks, registry } = registryFixture()
    const entryA = registry.getSnapshot().activeEntry
    const sendA = entryA.controller.sendMessage({
      id: 'a14-user-a',
      role: 'user',
      parts: [{ type: 'text', text: 'conversation A' }]
    })
    await vi.waitFor(() => expect(callbacks.get(entryA.controller.id)).toBeDefined())
    const streamA = callbacks.get(entryA.controller.id)
    streamA?.onChunk({ type: 'start', messageId: 'a14-assistant-a' })
    streamA?.onChunk({ type: 'text-start', id: 'a14-text-a' })
    streamA?.onChunk({ type: 'text-delta', id: 'a14-text-a', delta: 'answer A' })
    await vi.waitFor(() =>
      expect(entryA.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            parts: [expect.objectContaining({ type: 'text', text: 'answer A' })]
          })
        ])
      )
    )

    const entryB = registry.startNewConversation()
    const sendB = entryB.controller.sendMessage({
      id: 'a14-user-b',
      role: 'user',
      parts: [{ type: 'text', text: 'conversation B' }]
    })
    await vi.waitFor(() => expect(callbacks.get(entryB.controller.id)).toBeDefined())
    const streamB = callbacks.get(entryB.controller.id)
    streamB?.onChunk({ type: 'start', messageId: 'a14-assistant-b' })
    streamB?.onChunk({ type: 'text-start', id: 'a14-text-b' })
    streamB?.onChunk({ type: 'text-delta', id: 'a14-text-b', delta: 'answer B' })
    await vi.waitFor(() =>
      expect(entryB.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            parts: [expect.objectContaining({ type: 'text', text: 'answer B' })]
          })
        ])
      )
    )

    entryA.controller.stageSteeringMessage(
      { id: 'a14-steer-a', role: 'user', parts: [{ type: 'text', text: 'steer A' }] },
      { clientUserMessageId: 'a14-steer-a', targetTurnId: entryA.controller.getActiveTurnId()! }
    )
    entryB.controller.stageSteeringMessage(
      { id: 'a14-steer-b', role: 'user', parts: [{ type: 'text', text: 'steer B' }] },
      { clientUserMessageId: 'a14-steer-b', targetTurnId: entryB.controller.getActiveTurnId()! }
    )

    const startedChatIds = vi
      .mocked(bridge.startChatStream)
      .mock.calls.map(([request]) => request.chatId)
    expect(startedChatIds).toEqual([entryA.controller.id, entryB.controller.id])
    expect(entryA.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          parts: [expect.objectContaining({ type: 'text', text: 'answer A' })]
        }),
        expect.objectContaining({ renderId: 'steer:a14-steer-a' })
      ])
    )
    expect(entryA.messages.map((message) => message.renderId)).not.toContain('steer:a14-steer-b')
    expect(entryB.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          parts: [expect.objectContaining({ type: 'text', text: 'answer B' })]
        }),
        expect.objectContaining({ renderId: 'steer:a14-steer-b' })
      ])
    )
    expect(entryB.messages.map((message) => message.renderId)).not.toContain('steer:a14-steer-a')

    streamA?.onChunk({ type: 'finish' })
    streamA?.onFinish()
    streamB?.onChunk({ type: 'finish' })
    streamB?.onFinish()
    await Promise.all([sendA, sendB])
    await assertPlanEvidence(['A14'], steerAssertionIds, () => {
      expect(vi.mocked(bridge.startChatStream)).toHaveBeenCalledTimes(2)
      expect(entryA.messages.map((message) => message.renderId)).not.toContain('steer:a14-steer-b')
      expect(entryB.messages.map((message) => message.renderId)).not.toContain('steer:a14-steer-a')
    })
  })

  it('projects one real stream into assistant, Steer user, and assistant segments', async () => {
    const { callbacks, registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    const send = entry.controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(callbacks.get(entry.controller.id)).toBeDefined())
    const stream = callbacks.get(entry.controller.id)
    stream?.onThreadBound('thread-real')
    stream?.onTurnLifecycle?.({
      type: 'turn-started',
      sequence: 1,
      threadId: 'thread-real',
      turnId: 'turn-real'
    })
    stream?.onTurnLifecycle?.({
      type: 'item-started',
      sequence: 2,
      threadId: 'thread-real',
      turnId: 'turn-real',
      itemId: 'assistant-before-item',
      itemType: 'agentMessage'
    })
    stream?.onChunk({ type: 'start', messageId: 'active-assistant' })
    stream?.onChunk({
      type: 'text-start',
      id: 'text-before',
      providerMetadata: codexMetadata('turn-real', 'assistant-before-item')
    })
    stream?.onChunk({
      type: 'text-delta',
      id: 'text-before',
      delta: 'before steer',
      providerMetadata: codexMetadata('turn-real', 'assistant-before-item')
    })
    await vi.waitFor(() => {
      expect(entry.messages.at(-1)?.renderId).toBe(
        'message:assistant:turn-real:assistant-before-item'
      )
      expect(entry.messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'before steer' })
      ])
    })

    entry.controller.stageSteeringMessage(
      {
        id: 'steer-message',
        role: 'user',
        parts: [{ type: 'text', text: 'new direction' }]
      },
      { clientUserMessageId: 'steer-message', targetTurnId: 'turn-real' }
    )
    expect(entry.messages.map((message) => message.renderId)).toEqual([
      'message:initial-user',
      'message:assistant:turn-real:assistant-before-item',
      'steer:steer-message',
      'message:assistant:local-turn-1:after-steer-message'
    ])
    expect(entry.messages[2]).toMatchObject({
      kind: 'steering-user-message',
      status: 'pending',
      targetTurnId: 'turn-real'
    })

    stream?.onTurnLifecycle?.({
      type: 'item-started',
      sequence: 3,
      threadId: 'thread-real',
      turnId: 'turn-real',
      itemId: 'steer-source-item',
      itemType: 'userMessage',
      clientUserMessageId: 'steer-message'
    })
    stream?.onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 4,
      threadId: 'thread-real',
      turnId: 'turn-real',
      itemId: 'steer-source-item',
      itemType: 'userMessage',
      clientUserMessageId: 'steer-message'
    })
    stream?.onTurnLifecycle?.({
      type: 'item-started',
      sequence: 5,
      threadId: 'thread-real',
      turnId: 'turn-real',
      itemId: 'assistant-after-item',
      itemType: 'agentMessage'
    })
    stream?.onChunk({
      type: 'text-end',
      id: 'text-before',
      providerMetadata: codexMetadata('turn-real', 'assistant-before-item')
    })
    stream?.onChunk({
      type: 'text-start',
      id: 'text-after',
      providerMetadata: codexMetadata('turn-real', 'assistant-after-item')
    })
    stream?.onChunk({
      type: 'text-delta',
      id: 'text-after',
      delta: 'after steer',
      providerMetadata: codexMetadata('turn-real', 'assistant-after-item')
    })
    await vi.waitFor(() => {
      expect(entry.messages.map((message) => message.renderId)).toEqual([
        'message:initial-user',
        'message:assistant:turn-real:assistant-before-item',
        'steer:steer-message',
        'message:assistant:turn-real:assistant-after-item'
      ])
    })
    expect(entry.messages[2]).toMatchObject({
      status: 'accepted',
      sourceItemId: 'steer-source-item'
    })

    stream?.onChunk({
      type: 'text-end',
      id: 'text-after',
      providerMetadata: codexMetadata('turn-real', 'assistant-after-item')
    })
    stream?.onTurnLifecycle?.({
      type: 'turn-completed',
      sequence: 6,
      threadId: 'thread-real',
      turnId: 'turn-real',
      outcome: 'completed'
    })
    stream?.onChunk({ type: 'finish' })
    stream?.onFinish('thread-real')
    await send

    expect(entry.status).toBe('ready')
    expect(entry.messages.map((message) => message.renderId)).toEqual([
      'message:initial-user',
      'message:assistant:turn-real:assistant-before-item',
      'steer:steer-message',
      'message:assistant:turn-real:assistant-after-item'
    ])
    expect(entry.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'before steer' })
    ])
    expect(entry.messages[3]?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: 'after steer' })
    ])
    expect(new Set(entry.messages.map((message) => message.renderId)).size).toBe(
      entry.messages.length
    )
  })

  it('keeps a draft until the stream is accepted and preserves it on early failure', async () => {
    const { callbacks, registry } = registryFixture()
    const entry = registry.getSnapshot().activeEntry
    registry.setDraft(entry, 'keep me')
    registry.setDraftAttachments(entry, [
      {
        kind: 'file',
        path: '/repo/missing.txt',
        fileUrl: 'file:///repo/missing.txt',
        label: 'missing.txt'
      }
    ])
    await entry.transport.sendMessages({
      chatId: entry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    expect(entry.draft).toBe('keep me')
    callbacks.get(entry.controller.id)?.onError('attachment validation failed')
    expect(entry.draft).toBe('keep me')
    expect(entry.draftAttachments).toHaveLength(1)

    await entry.transport.sendMessages({
      chatId: entry.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks.get(entry.controller.id)?.onThreadBound('thread-real')
    expect(entry.draft).toBe('')
    expect(entry.draftAttachments).toEqual([])
  })

  it('keeps model selection scoped to each entry and snapshots it per send', async () => {
    const { bridge, registry } = registryFixture()
    const entryA = registry.getSnapshot().activeEntry
    registry.setSelectedModel(entryA, 'model-a')
    const entryB = registry.startNewConversation()
    registry.setSelectedModel(entryB, 'model-b')

    await entryA.transport.sendMessages({
      chatId: entryA.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    await entryB.transport.sendMessages({
      chatId: entryB.controller.id,
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    const requests = vi.mocked(bridge.startChatStream).mock.calls.map(([request]) => request)
    expect(requests.find((request) => request.chatId === entryA.controller.id)?.modelId).toBe(
      'model-a'
    )
    expect(requests.find((request) => request.chatId === entryB.controller.id)?.modelId).toBe(
      'model-b'
    )
  })

  it('detaches each running Chat without interrupting its canonical turn on registry teardown', async () => {
    const { bridge, registry } = registryFixture()
    const entryA = registry.getSnapshot().activeEntry
    void entryA.controller.sendMessage({
      id: 'message-a',
      role: 'user',
      parts: [{ type: 'text', text: 'A' }]
    })
    const entryB = registry.startNewConversation()
    void entryB.controller.sendMessage({
      id: 'message-b',
      role: 'user',
      parts: [{ type: 'text', text: 'B' }]
    })
    await flushMicrotasks()

    registry.destroy()
    await flushMicrotasks()

    expect(bridge.abortChatStream).not.toHaveBeenCalled()
  })
})

function openResult(conversationId: string): SidebarConversationOpenResult {
  return {
    conversationId,
    threadId: `thread-${conversationId}`,
    title: conversationId,
    messages: [
      {
        id: `message-${conversationId}`,
        role: 'user',
        parts: [{ type: 'text', text: conversationId }]
      }
    ]
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushRecoveryWork(): Promise<void> {
  // Attaching has two asynchronous boundaries: the bridge result and the
  // controller's readable-stream consumer. Give both their completion
  // handlers a deterministic microtask turn before inspecting recovery state.
  for (let index = 0; index < 12; index += 1) await flushMicrotasks()
}

function codexMetadata(
  turnId: string,
  sourceItemId: string
): ReturnType<typeof codexMessageProviderMetadata> {
  return codexMessageProviderMetadata({ turnId, sourceItemId })
}
