import { describe, expect, it, vi } from 'vitest'

import {
  createVitestPlanAssertionRecorder,
  planAssertionsForScenarios
} from '../../../../scripts/lib/test-plan-assertions.mjs'

import { ElectronIpcChatTransport } from './ElectronIpcChatTransport'
import type { CodexChatStreamFailure, DesktopCodexChatApi } from '../../../shared/codexIpcApi'

const terminalAssertionIds = [
  '保留可见内容并显示单一终态',
  'terminal 只结算一次且 Composer 恢复',
  '无自动重试、额外请求或迟到事件应用'
]
const securityAssertionIds = [
  '跨对话与信任边界隔离',
  '资源、并发和终态无残留',
  '诊断可关联而不泄露密钥'
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

describe('ElectronIpcChatTransport', () => {
  it('returns a stream that yields chunks from the desktop bridge', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test'
    })

    const stream = await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onChunk({ type: 'text-start', id: 'text-1' })
    callbacks?.onFinish()

    const reader = stream.getReader()
    const chunks: unknown[] = []
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    expect(chunks).toEqual([{ type: 'text-start', id: 'text-1' }])
    expect(bridge.startChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', modelId: 'gpt-test' }),
      expect.any(Object)
    )
  })

  it('aborts active stream through the desktop bridge', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const abortController = new AbortController()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: abortController.signal
    })
    abortController.abort()

    expect(bridge.abortChatStream).toHaveBeenCalledWith('stream-1')
  })

  it('C22 keeps the app-server turn running when its readable consumer cancels', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test'
    })

    const stream = await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    await stream.cancel()

    expect(bridge.abortChatStream).not.toHaveBeenCalled()
  })

  it('replays queued chunks before closing an attached stream with a terminal error', async () => {
    let callbacks: Parameters<NonNullable<DesktopCodexChatApi['attachChatStream']>>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      attachChatStream: vi.fn((_conversationId, nextCallbacks) => {
        callbacks = nextCallbacks
        return Promise.resolve('stream-recovered')
      }),
      abortChatStream: vi.fn()
    }
    const onStreamError = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamError
    })

    const stream = await transport.reconnectToStream({ chatId: 'chat-1' })
    expect(stream).not.toBeNull()
    callbacks?.onChunk({ type: 'text-start', id: 'text-replayed' })
    callbacks?.onChunk({ type: 'text-delta', id: 'text-replayed', delta: 'Partial replay.' })
    callbacks?.onError('stream disconnected before completion')

    const reader = stream!.getReader()
    const chunks: unknown[] = []
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    expect(chunks).toEqual([
      { type: 'text-start', id: 'text-replayed' },
      { type: 'text-delta', id: 'text-replayed', delta: 'Partial replay.' }
    ])
    expect(onStreamError).toHaveBeenCalledWith('stream disconnected before completion')
  })

  it('returns null when recovery finds no active run before attach', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      attachChatStream: vi.fn(() => Promise.resolve(null)),
      abortChatStream: vi.fn()
    }
    const onStreamError = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamError
    })

    await expect(transport.reconnectToStream({ chatId: 'chat-1' })).resolves.toBeNull()
    expect(onStreamError).not.toHaveBeenCalled()
  })

  it('does not expose raw IPC errors when attaching a recovery stream fails', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      attachChatStream: vi.fn(() =>
        Promise.reject(new Error('provider configuration rejected secret-provider-token'))
      ),
      abortChatStream: vi.fn()
    }
    const onStreamError = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamError
    })

    await expect(transport.reconnectToStream({ chatId: 'chat-1' })).resolves.not.toBeNull()
    expect(onStreamError).toHaveBeenCalledWith({
      code: 'unknown-recovery',
      message: '任务连接已中断，无法自动恢复。'
    })
    expect(JSON.stringify(onStreamError.mock.calls)).not.toContain('secret-provider-token')
  })

  it('preserves structured recovery failures after replayed chunks', async () => {
    let callbacks: Parameters<NonNullable<DesktopCodexChatApi['attachChatStream']>>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      attachChatStream: vi.fn((_conversationId, nextCallbacks) => {
        callbacks = nextCallbacks
        return Promise.resolve('stream-recovered')
      }),
      abortChatStream: vi.fn()
    }
    const onStreamError = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamError
    })

    const stream = await transport.reconnectToStream({ chatId: 'chat-1' })
    const failure = {
      code: 'run-mismatch',
      message: 'The active run changed before recovery could attach.'
    } satisfies CodexChatStreamFailure
    callbacks?.onChunk({ type: 'text-start', id: 'text-replayed' })
    callbacks?.onChunk({ type: 'text-delta', id: 'text-replayed', delta: 'Partial replay.' })
    callbacks?.onError(failure)

    const reader = stream!.getReader()
    const chunks: unknown[] = []
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      chunks.push(result.value)
    }

    expect(chunks).toEqual([
      { type: 'text-start', id: 'text-replayed' },
      { type: 'text-delta', id: 'text-replayed', delta: 'Partial replay.' }
    ])
    expect(onStreamError).toHaveBeenCalledWith(failure)
  })

  it('forwards an attached abort as the canonical interrupted terminal', async () => {
    let callbacks: Parameters<NonNullable<DesktopCodexChatApi['attachChatStream']>>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      attachChatStream: vi.fn((_conversationId, nextCallbacks) => {
        callbacks = nextCallbacks
        return Promise.resolve('stream-recovered')
      }),
      abortChatStream: vi.fn()
    }
    const onStreamAborted = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamAborted
    })

    const stream = await transport.reconnectToStream({ chatId: 'chat-1' })
    callbacks?.onAbort()

    await expect(stream!.getReader().read()).resolves.toEqual({ done: true, value: undefined })
    expect(onStreamAborted).toHaveBeenCalledOnce()
  })

  it('G01 strips forged renderer execution hints from the request body', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getProjectSelection: () => ({ projectKind: 'path', path: '/repo' }),
      getSelectedModelId: () => 'gpt-test',
      getReasoningEffort: () => 'high',
      getPersonality: () => 'friendly'
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: {
        conversationId: 'conversation-1',
        threadId: 'thread-1',
        cwd: '/renderer/cwd',
        projectSelection: { projectKind: 'path', path: '/renderer/project' },
        runtimeWorkspaceRoots: ['/renderer/root'],
        reasoningEffort: 'unbounded',
        personality: 'pragmatic'
      }
    })

    expect(bridge.startChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          approvalModeKind: 'request-approval',
          composerModeKind: 'default',
          personality: 'friendly',
          reasoningEffort: 'high',
          projectSelection: { projectKind: 'path', path: '/repo' }
        }
      }),
      expect.any(Object)
    )
    const request = vi.mocked(bridge.startChatStream).mock.calls[0][0]
    expect(request.body).not.toHaveProperty('conversationId')
    expect(request.body).not.toHaveProperty('threadId')
    await assertPlanEvidence(['G01'], securityAssertionIds, () => {
      expect(request.body).not.toHaveProperty('conversationId')
      expect(request.body).not.toHaveProperty('threadId')
      expect(request.body).toEqual({
        approvalModeKind: 'request-approval',
        composerModeKind: 'default',
        personality: 'friendly',
        reasoningEffort: 'high',
        projectSelection: { projectKind: 'path', path: '/repo' }
      })
    })
  })

  it('G01 replaces forged approval execution hints with the trusted approval mode kind', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getApprovalModeKind: () => 'full-access',
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-approval-mode',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: {
        approvalMode: 'renderer-forged-mode',
        approvalModeKind: 'read-only',
        approvalPolicy: 'never',
        approvalsReviewer: 'forged-reviewer',
        sandbox: { mode: 'danger-full-access' },
        sandboxPolicy: { type: 'dangerFullAccess' },
        cwd: '/renderer/cwd',
        runtimeWorkspaceRoots: ['/renderer/root']
      }
    })

    const request = vi.mocked(bridge.startChatStream).mock.calls[0][0]
    expect(request.body).toEqual({
      approvalModeKind: 'full-access',
      composerModeKind: 'default',
      personality: 'none'
    })
    expect(request.body).not.toHaveProperty('approvalMode')
    expect(request.body).not.toHaveProperty('approvalPolicy')
    expect(request.body).not.toHaveProperty('approvalsReviewer')
    expect(request.body).not.toHaveProperty('sandbox')
    expect(request.body).not.toHaveProperty('sandboxPolicy')
    expect(request.body).not.toHaveProperty('cwd')
    expect(request.body).not.toHaveProperty('runtimeWorkspaceRoots')
  })

  it('defaults forged or invalid approval mode kinds to request approval', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getApprovalModeKind: () => 'invalid-renderer-kind',
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-invalid-approval-mode',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: { approvalModeKind: 'full-access' }
    })

    expect(vi.mocked(bridge.startChatStream).mock.calls[0][0].body).toEqual({
      approvalModeKind: 'request-approval',
      composerModeKind: 'default',
      personality: 'none'
    })
  })

  it('falls back to request approval for legacy approval mode aliases', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getApprovalModeKind: () => 'auto-approve',
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-legacy-approval-mode',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    expect(vi.mocked(bridge.startChatStream).mock.calls[0][0].body).toEqual({
      approvalModeKind: 'request-approval',
      composerModeKind: 'default',
      personality: 'none'
    })
  })

  it('injects Plan mode from renderer-owned conversation state', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getComposerModeKind: () => 'plan',
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-plan-mode',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: { composerModeKind: 'default' }
    })

    expect(vi.mocked(bridge.startChatStream).mock.calls[0][0].body).toEqual({
      approvalModeKind: 'request-approval',
      composerModeKind: 'plan',
      personality: 'none'
    })
  })

  it('injects a Goal draft from the visible user message only', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getGoalEditorActive: () => true,
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-goal-mode',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [
        {
          id: 'goal-user-message',
          role: 'user',
          parts: [{ type: 'text', text: '完成参考实现的功能对齐' }]
        }
      ],
      abortSignal: undefined,
      body: {
        threadGoalDraft: { objective: 'renderer forged goal' },
        collaborationMode: { mode: 'plan' }
      }
    })

    expect(vi.mocked(bridge.startChatStream).mock.calls[0][0].body).toEqual({
      approvalModeKind: 'request-approval',
      composerModeKind: 'default',
      personality: 'none',
      threadGoalDraft: { objective: '完成参考实现的功能对齐' }
    })
  })

  it('routes an existing Goal through typed control instead of a new user draft', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getActiveConversation: () => ({
        conversationId: 'conversation-existing-goal',
        threadId: 'thread-existing-goal'
      }),
      getGoalEditorActive: () => true,
      getGoalEditorObjective: () => '继续完成遗留任务',
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'thread-existing-goal',
      // The public AI SDK union omits the Electron-owned Goal control trigger.
      trigger: 'goal-control' as never,
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: {
        threadGoalDraft: { objective: 'renderer forged goal' },
        threadGoalControl: { objective: 'renderer forged control' }
      }
    })

    expect(vi.mocked(bridge.startChatStream).mock.calls[0][0].body).toEqual({
      approvalModeKind: 'request-approval',
      composerModeKind: 'default',
      personality: 'none',
      conversationId: 'conversation-existing-goal',
      threadId: 'thread-existing-goal',
      threadGoalControl: { objective: '继续完成遗留任务' }
    })
  })

  it('G01 binds conversation identity from the trusted runtime context', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getActiveConversation: () => ({ conversationId: 'conversation-1', threadId: 'thread-1' }),
      getProjectSelection: () => ({ projectKind: 'path', path: '/repo' }),
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
      body: {
        conversationId: 'renderer-forged-conversation',
        threadId: 'renderer-forged-thread',
        cwd: '/renderer/cwd',
        runtimeWorkspaceRoots: ['/renderer/root']
      }
    })

    expect(bridge.startChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          approvalModeKind: 'request-approval',
          conversationId: 'conversation-1',
          threadId: 'thread-1',
          projectSelection: { projectKind: 'path', path: '/repo' },
          composerModeKind: 'default',
          personality: 'none'
        }
      }),
      expect.any(Object)
    )
  })

  it('uses the opened conversation project context before ambient project selection', async () => {
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn(() => 'stream-1'),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getActiveConversation: () => ({
        conversationId: 'conversation-1',
        threadId: 'thread-1',
        projectSelection: { projectKind: 'remote', projectId: 'remote-app', hostId: 'ssh-dev' }
      }),
      getProjectSelection: () => ({ projectKind: 'path', path: '/ambient-project' }),
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })

    expect(bridge.startChatStream).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          approvalModeKind: 'request-approval',
          conversationId: 'conversation-1',
          threadId: 'thread-1',
          projectSelection: {
            projectKind: 'remote',
            projectId: 'remote-app',
            hostId: 'ssh-dev'
          },
          composerModeKind: 'default',
          personality: 'none'
        }
      }),
      expect.any(Object)
    )
  })

  it('C24 ignores bridge chunks after the readable stream has finished', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onFinish()

    expect(() => callbacks?.onChunk({ type: 'text-start', id: 'late-text' })).not.toThrow()
    await assertPlanEvidence(['C24'], terminalAssertionIds, () =>
      expect(() => callbacks?.onChunk({ type: 'text-start', id: 'late-text' })).not.toThrow()
    )
  })

  it('C24 ignores bridge finish events after the readable stream has errored', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test'
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onError('boom')

    expect(() => callbacks?.onFinish()).not.toThrow()
    await assertPlanEvidence(['C24'], terminalAssertionIds, () =>
      expect(() => callbacks?.onFinish()).not.toThrow()
    )
  })

  it('calls onStreamFinished with stream-scoped context when the stream finishes', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const onStreamFinished = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getActiveConversation: () => ({ conversationId: 'conversation-1', threadId: 'thread-1' }),
      getProjectSelection: () => ({ projectKind: 'path', path: '/repo' }),
      getConversationRevision: () => 7,
      getSelectedModelId: () => 'gpt-test',
      onStreamFinished
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onFinish('thread-real')

    expect(onStreamFinished).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-real',
      activeConversation: { conversationId: 'conversation-1', threadId: 'thread-1' },
      projectSelection: { projectKind: 'path', path: '/repo' },
      conversationRevision: 7
    })
  })

  it('reports an early thread binding with the stream-scoped context', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const onThreadBound = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getActiveConversation: () => ({ conversationId: 'local-conversation' }),
      getProjectSelection: () => ({ projectKind: 'path', path: '/repo' }),
      getConversationRevision: () => 3,
      getSelectedModelId: () => 'gpt-test',
      onThreadBound
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onThreadBound('thread-real')

    expect(onThreadBound).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId: 'thread-real',
      activeConversation: { conversationId: 'local-conversation' },
      projectSelection: { projectKind: 'path', path: '/repo' },
      conversationRevision: 3
    })
  })

  it('marks a fresh terminal retry before reporting its replacement thread', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const onThreadBound = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getActiveConversation: () => ({ conversationId: 'thread-failed', threadId: 'thread-failed' }),
      getSelectedModelId: () => 'gpt-test',
      onThreadBound
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: 'assistant-failed',
      messages: [],
      body: { retryTerminalTurn: true },
      abortSignal: undefined
    })
    callbacks?.onThreadBound('thread-retry')

    expect(onThreadBound).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-retry',
        startsFreshTerminalRetry: true
      })
    )
  })

  it('C24 does not call onStreamFinished for a late finish after an error', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const onStreamFinished = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamFinished
    })

    await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onError('boom')
    callbacks?.onFinish('thread-real')

    expect(onStreamFinished).not.toHaveBeenCalled()
    await assertPlanEvidence(['C24'], terminalAssertionIds, () =>
      expect(onStreamFinished).not.toHaveBeenCalled()
    )
  })

  it('B10/C24/G11 ignores late chunk, lifecycle, binding, finish, abort, and error callbacks after the first terminal', async () => {
    let callbacks: Parameters<DesktopCodexChatApi['startChatStream']>[1] | undefined
    const bridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((_request, nextCallbacks) => {
        callbacks = nextCallbacks
        return 'stream-1'
      }),
      abortChatStream: vi.fn()
    }
    const onStreamAccepted = vi.fn()
    const onThreadBound = vi.fn()
    const onTurnLifecycle = vi.fn()
    const onStreamAborted = vi.fn()
    const onStreamError = vi.fn()
    const onStreamFinished = vi.fn()
    const transport = new ElectronIpcChatTransport({
      chatBridge: bridge,
      getSelectedModelId: () => 'gpt-test',
      onStreamAccepted,
      onThreadBound,
      onTurnLifecycle,
      onStreamAborted,
      onStreamError,
      onStreamFinished
    })

    const stream = await transport.sendMessages({
      chatId: 'chat-1',
      trigger: 'submit-message',
      messageId: undefined,
      messages: [],
      abortSignal: undefined
    })
    callbacks?.onError('first terminal')
    callbacks?.onChunk({ type: 'text-start', id: 'late-text' })
    callbacks?.onTurnLifecycle?.({
      type: 'turn-completed',
      sequence: 1,
      threadId: 'thread-late',
      turnId: 'turn-late',
      outcome: 'completed'
    })
    callbacks?.onThreadBound('thread-late')
    callbacks?.onFinish('thread-late')
    callbacks?.onAbort()
    callbacks?.onError('second terminal')

    await expect(stream.getReader().read()).rejects.toThrow('first terminal')
    expect(onStreamError).toHaveBeenCalledOnce()
    expect(onStreamError).toHaveBeenCalledWith('first terminal')
    expect(onStreamAccepted).not.toHaveBeenCalled()
    expect(onThreadBound).not.toHaveBeenCalled()
    expect(onTurnLifecycle).not.toHaveBeenCalled()
    expect(onStreamAborted).not.toHaveBeenCalled()
    expect(onStreamFinished).not.toHaveBeenCalled()
  })
})
