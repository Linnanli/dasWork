import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CodexProviderError,
  CodexSteerError,
  type CodexCallOptions,
  type CodexCommandApprovalRequest,
  type CodexSession
} from '@janole/ai-sdk-provider-codex-asp'

import { createVitestPlanAssertionRecorder } from '../../scripts/lib/test-plan-assertions.mjs'

const { planAssert } = createVitestPlanAssertionRecorder(expect)

const raceAssertionIds = [
  'claim、接受与队列结算至多一次',
  '正确的恢复、暂停或拒绝状态',
  'terminal 和 active run 不被竞态覆盖'
]

async function assertRacePlanEvidence(
  scenarioIds: readonly string[],
  assertion: () => void | Promise<void>
): Promise<void> {
  for (const scenarioId of scenarioIds) {
    for (const assertionId of raceAssertionIds) {
      await planAssert({ scenarioId, assertionId, assertion })
    }
  }
}

const providerState = vi.hoisted(() => ({
  listModels: vi.fn(),
  shutdown: vi.fn(),
  startThread: vi.fn()
}))

vi.mock('./codexAspProvider', () => ({
  createCodexAspProvider: vi.fn(() => ({
    listModels: providerState.listModels,
    shutdown: providerState.shutdown,
    startThread: providerState.startThread,
    chat: vi.fn()
  }))
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    isPackaged: false
  }
}))

import {
  CodexChatRuntimeService,
  approvalSettingsForMode,
  commandApprovalDecisionFromResponse,
  mcpElicitationResponseFromApprovalResponse,
  permissionsApprovalResponseFromApprovalResponse,
  type CodexPortLike,
  type CodexChatRuntimeServiceOptions,
  type ModelCatalogLike
} from './codexChatRuntimeService'
import type {
  CodexChatStreamEnvelope,
  CodexChatStreamEvent,
  CodexChatRequest,
  CodexTurnLifecycleEvent
} from '../shared/codexIpcApi'
import type {
  ConversationFollowUpQueueService,
  FollowUpClaim
} from './followUps/ConversationFollowUpQueueService'
import { ProjectStore, createDefaultProjectState } from './projects/ProjectStore'

class FakePort implements CodexPortLike {
  readonly messages: unknown[] = []
  readonly envelopes: CodexChatStreamEnvelope[] = []
  started = false
  closed = false
  private handler: ((event: { data: unknown }) => void) | undefined

  constructor(
    private readonly acknowledgeThreadBinding = true,
    private readonly onPostMessage?: (message: unknown) => void
  ) {}

  postMessage(message: CodexChatStreamEnvelope | CodexChatStreamEvent): void {
    const event = isStreamEnvelope(message) ? message.event : message
    if (isStreamEnvelope(message)) this.envelopes.push(message)
    this.messages.push(event)
    this.onPostMessage?.(event)
    if (
      this.acknowledgeThreadBinding &&
      event.type === 'thread-bound' &&
      typeof event.threadId === 'string'
    ) {
      this.emit({ type: 'thread-bound-ack', threadId: event.threadId })
    }
  }

  on(event: 'message', handler: (event: { data: unknown }) => void): void {
    if (event === 'message') this.handler = handler
  }

  start(): void {
    this.started = true
  }

  close(): void {
    this.closed = true
  }

  emit(message: unknown): void {
    this.handler?.({ data: message })
  }
}

function isStreamEnvelope(
  message: CodexChatStreamEnvelope | CodexChatStreamEvent
): message is CodexChatStreamEnvelope {
  return 'runId' in message && 'sequence' in message && 'event' in message
}

async function* emptyUiMessageStream(): AsyncGenerator<never, void, unknown> {
  if (process.env['NODE_ENV'] === '__unused_test_stream__') {
    yield undefined as never
  }
}

type RuntimeStreamTextInput = {
  request: CodexChatRequest
  collaborationMode?: {
    mode: 'default' | 'plan'
    settings: {
      model: string
      reasoning_effort: string | null
      developer_instructions: string | null
    }
  }
  approvalSettings?: Pick<
    CodexCallOptions,
    'approvalPolicy' | 'approvalsReviewer' | 'sandbox' | 'sandboxPolicy'
  >
  personality?: CodexCallOptions['personality']
  goalControlObjective?: string
  goalContinuous?: boolean
  resumeThreadId?: string
  resumeActiveTurn?: boolean
  existingTurnRecoveryState?: {
    turnId?: string
    textByItemId: Record<string, string>
    emittedProviderToolCallIds: string[]
    completedProviderToolCallIds: string[]
  }
  startFreshTerminalRetry?: boolean
  onThreadStarted?: (thread: { threadId: string; threadPath?: string }) => void | Promise<void>
  onTurnLifecycle?: (event: CodexTurnLifecycleEvent) => void | Promise<void>
  onTurnDiffUpdated?: (event: {
    threadId: string
    turnId: string
    diff: string
  }) => void | Promise<void>
  onThreadSettingsUpdated?: CodexCallOptions['onThreadSettingsUpdated']
  onThreadGoalUpdated?: CodexCallOptions['onThreadGoalUpdated']
  onSessionCreated?: (session: CodexSession) => void
  onExistingTurnRecoveryState?: (
    state: NonNullable<RuntimeStreamTextInput['existingTurnRecoveryState']>
  ) => void
  onProviderToolCall?: (toolName: string) => void
}

type RecordedStreamText = NonNullable<CodexChatRuntimeServiceOptions['streamText']> & {
  mock: { calls: Array<[RuntimeStreamTextInput]> }
}

function streamTextWithStartedThread(threadId = 'thread-prestarted'): RecordedStreamText {
  return vi.fn(async (input: RuntimeStreamTextInput) => {
    await input.onThreadStarted?.({ threadId })
    await completeCanonicalTurn(input, threadId)
    return {
      toUIMessageStream: () => emptyUiMessageStream()
    }
  }) as unknown as RecordedStreamText
}

function recordedStreamInput(streamText: RecordedStreamText): RuntimeStreamTextInput | undefined {
  return streamText.mock.calls[0]?.[0]
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function activeSession(
  threadId: string,
  turnId: string,
  interrupt: () => Promise<void>
): CodexSession {
  return {
    threadId,
    turnId,
    isActive: () => true,
    injectMessage: async () => undefined,
    steerPrompt: async () => ({ turnId }),
    getThreadGoal: async () => null,
    setThreadGoal: async () => ({
      threadId,
      objective: 'goal',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0
    }),
    clearThreadGoal: async () => true,
    interrupt
  }
}

async function completeCanonicalTurn(
  input: RuntimeStreamTextInput,
  threadId = 'thread-prestarted',
  turnId = 'turn-prestarted'
): Promise<void> {
  input.onSessionCreated?.(activeSession(threadId, turnId, async () => undefined))
  await input.onTurnLifecycle?.({
    type: 'turn-started',
    sequence: 1,
    threadId,
    turnId
  })
  await input.onTurnLifecycle?.({
    type: 'turn-completed',
    sequence: 2,
    threadId,
    turnId,
    outcome: 'completed'
  })
}

function isTerminalMessage(value: unknown): value is { type: 'finish' | 'aborted' | 'error' } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    ((value as { type?: unknown }).type === 'finish' ||
      (value as { type?: unknown }).type === 'aborted' ||
      (value as { type?: unknown }).type === 'error')
  )
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function* waitThenEnd(promise: Promise<unknown>): AsyncGenerator<never, void, unknown> {
  await promise
  if (process.env['NODE_ENV'] === '__unused_test_stream__') {
    yield undefined as never
  }
}

function createSteerClaim(overrides: Partial<FollowUpClaim> = {}): FollowUpClaim {
  return {
    conversationKey: 'conversation-1',
    leaseToken: 'lease-1',
    item: {
      id: 'follow-up-1',
      conversationKey: 'conversation-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      preferredMode: 'steer',
      message: {
        id: 'follow-up-1',
        text: 'change direction',
        attachments: [],
        contextReferences: [],
        trustedContext: {
          conversationId: 'conversation-1',
          threadId: 'thread-1',
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo']
        }
      },
      status: 'steering',
      lease: {
        token: 'lease-1',
        operation: 'turn-steer',
        claimedAt: '2026-07-18T00:00:00.000Z',
        owner: 'main'
      }
    },
    ...overrides
  }
}

describe('CodexChatRuntimeService', () => {
  beforeEach(() => {
    providerState.listModels.mockReset()
    providerState.shutdown.mockReset()
    providerState.startThread.mockReset()
    providerState.startThread.mockResolvedValue({ threadId: 'thread-prestarted' })
  })

  it('generates a commit subject through the configured Codex provider in the trusted local cwd', async () => {
    const streamText = vi.fn(async () => ({
      toUIMessageStream: () =>
        (async function* () {
          yield {
            type: 'text-delta',
            id: 'commit-subject',
            delta: 'Update local review flow'
          } as never
        })()
    }))
    const resolveExistingThreadTarget = vi.fn(async () => ({
      hostId: 'local',
      cwd: '/repo',
      workspaceRoots: ['/repo']
    }))
    const service = new CodexChatRuntimeService({
      modelCatalog: {
        listModels: vi.fn(async () => ({
          models: [{ id: 'gpt-test', displayName: 'Test', inputModalities: [], isDefault: true }],
          selectedModelId: 'gpt-test'
        })),
        setSelectedModel: vi.fn(async (modelId: string) => ({ selectedModelId: modelId })),
        resolveClientModel: vi.fn(async () => ({
          model_id: 'gpt-test',
          display_name: 'Test',
          description: null,
          provider: 'test',
          is_default: true,
          capabilities: [],
          api_base_url: null,
          api_key: null,
          api_format: 'responses',
          source: 'test'
        }))
      } satisfies ModelCatalogLike,
      projectService: { resolveExistingThreadTarget } as never,
      streamText
    })

    await expect(
      service.generateCommitMessage({
        target: {
          conversationId: 'conversation-1',
          threadId: 'thread-1',
          hostId: 'local',
          cwd: '/repo',
          gitRoot: '/repo'
        },
        changeSummary: 'Staged changes:\n review.ts | 2 +-'
      })
    ).resolves.toBe('Update local review flow')

    expect(resolveExistingThreadTarget).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      threadId: 'thread-1',
      allowActiveProjectFallback: false
    })
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'gpt-test',
        executionTarget: { cwd: '/repo', runtimeWorkspaceRoots: ['/repo'] },
        request: expect.objectContaining({
          body: expect.not.objectContaining({ threadId: expect.anything() })
        })
      })
    )
  })

  it('resolves renderer composer mode into an explicit app-server collaboration mode', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-plan-mode' })
      await completeCanonicalTurn(input, 'thread-plan-mode', 'turn-plan-mode')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-plan-mode',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { composerModeKind: 'plan' }
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'gpt-test',
            reasoning_effort: null,
            developer_instructions: null
          }
        }
      })
    )
  })

  it('passes the selected reasoning effort through the default collaboration mode', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-reasoning-effort' })
      await completeCanonicalTurn(input, 'thread-reasoning-effort', 'turn-reasoning-effort')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-reasoning-effort',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { reasoningEffort: 'high' }
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: {
          mode: 'default',
          settings: {
            model: 'gpt-test',
            reasoning_effort: 'high',
            developer_instructions: null
          }
        }
      })
    )
  })

  it('adds desktop instructions without changing normal user messages', async () => {
    const port = new FakePort()
    const streamText = streamTextWithStartedThread()
    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'Review this change.' }]
      }
    ]
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'local',
        cwd: '/repo',
        workspaceRoots: ['/repo'],
        workspaceKind: 'project',
        projectAssignment: {
          projectKind: 'local',
          projectId: 'project-1',
          cwd: '/repo'
        }
      }),
      resolveExistingThreadTarget: vi.fn()
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      projectService,
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-desktop-context',
        trigger: 'submit-message',
        messages,
        modelId: 'gpt-test',
        body: {
          system: 'Preserve these existing instructions.',
          projectSelection: { projectKind: 'local', projectId: 'project-1' }
        }
      },
      port
    )

    const modelInput = recordedStreamInput(streamText)
    expect(modelInput?.request.body?.system).toContain('Preserve these existing instructions.')
    expect(modelInput?.request.body?.system).toContain('<app-context>')
    expect(modelInput?.request.body?.system).toContain('# DasCowork desktop context')
    expect(modelInput?.request.body?.system).toContain('### Inline Code Comments')
    expect(modelInput?.request.body?.system).not.toContain('### Projectless Chat')
    expect(modelInput?.request.body?.system).not.toContain('automation_update')
    expect(modelInput?.request.messages).toEqual(messages)
  })

  it('adds verified projectless directories to developer instructions only for projectless threads', async () => {
    const port = new FakePort()
    const streamText = streamTextWithStartedThread()
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'local',
        cwd: '/tmp/dascowork/projectless/task-1',
        workspaceRoots: ['/tmp/dascowork/projectless/task-1'],
        workspaceKind: 'projectless',
        projectAssignment: {
          projectKind: 'projectless',
          cwd: '/tmp/dascowork/projectless/task-1',
          workspaceRoot: '/tmp/dascowork/projectless/task-1',
          outputDirectory: '/tmp/dascowork/projectless/task-1/out'
        }
      }),
      resolveExistingThreadTarget: vi.fn()
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      projectService,
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-projectless-context',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { projectSelection: { projectKind: 'projectless' } }
      },
      port
    )

    const instructions = recordedStreamInput(streamText)?.request.body?.system
    expect(instructions).toContain('### Projectless Chat')
    expect(instructions).toContain('Workspace root: /tmp/dascowork/projectless/task-1.')
    expect(instructions).toContain('Working directory: /tmp/dascowork/projectless/task-1.')
    expect(instructions).toContain('deliverables directory: /tmp/dascowork/projectless/task-1/out.')
  })

  it('maps approval mode kinds into provider approval and sandbox settings', () => {
    expect(
      approvalSettingsForMode(
        'request-approval',
        { cwd: '/repo', runtimeWorkspaceRoots: ['/repo'] },
        '/fallback'
      )
    ).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/repo'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    })
    expect(
      approvalSettingsForMode(
        'approve-for-me',
        { cwd: '/repo', runtimeWorkspaceRoots: ['/repo'] },
        '/fallback'
      )
    ).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
      sandboxPolicy: { type: 'workspaceWrite', networkAccess: false }
    })
    expect(approvalSettingsForMode('full-access', undefined, '/fallback')).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    expect(approvalSettingsForMode('request-approval', undefined, '/fallback')).toMatchObject({
      sandboxPolicy: { writableRoots: ['/fallback'] }
    })
  })

  it('passes the current approval, sandbox, and personality snapshots to the provider stream', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-full-access' })
      await completeCanonicalTurn(input, 'thread-full-access', 'turn-full-access')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-full-access',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { approvalModeKind: 'full-access', personality: 'pragmatic' }
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalSettings: {
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: 'danger-full-access',
          sandboxPolicy: { type: 'dangerFullAccess' }
        },
        personality: 'pragmatic'
      })
    )
  })

  it('defaults omitted personality to none before calling the provider', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-default-personality' })
      await completeCanonicalTurn(input, 'thread-default-personality', 'turn-default-personality')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({ streamText })

    await service.startChatStream(
      {
        chatId: 'chat-default-personality',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ personality: 'none' }))
  })

  it('uses the app-server Plan preset when the collaboration catalog is available', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-plan-preset' })
      await completeCanonicalTurn(input, 'thread-plan-preset', 'turn-plan-preset')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const listCollaborationModes = vi.fn().mockResolvedValue([
      { name: 'Default', mode: 'default', model: null, reasoning_effort: null },
      { name: 'Plan', mode: 'plan', model: 'preset-model', reasoning_effort: 'high' }
    ])
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      collaborationModeClient: { listCollaborationModes } as never
    })

    await service.startChatStream(
      {
        chatId: 'chat-plan-preset',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { composerModeKind: 'plan', reasoningEffort: 'low' }
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'preset-model',
            reasoning_effort: 'high',
            developer_instructions: null
          }
        }
      })
    )
    expect(listCollaborationModes).toHaveBeenCalledOnce()
  })

  it('rejects Plan when an advertised collaboration catalog omits its preset', async () => {
    const streamText = vi.fn()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      collaborationModeClient: {
        listCollaborationModes: vi
          .fn()
          .mockResolvedValue([
            { name: 'Default', mode: 'default', model: null, reasoning_effort: null }
          ])
      } as never
    })

    const port = new FakePort()
    await service.startChatStream(
      {
        chatId: 'chat-plan-unsupported',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { composerModeKind: 'plan' }
      },
      port
    )
    expect(port.messages).toContainEqual({
      type: 'error',
      error: '当前 Codex 服务不支持计划模式'
    })
    expect(streamText).not.toHaveBeenCalled()
  })

  it('binds a new Goal immediately after its thread is created', async () => {
    const port = new FakePort()
    const setThreadGoal = vi.fn().mockResolvedValue({
      threadId: 'thread-goal-mode',
      objective: '完成参考实现的功能对齐',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0
    })
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-goal-mode' })
      await input.onSessionCreated?.({
        ...activeSession('thread-goal-mode', 'turn-goal-mode', async () => undefined),
        setThreadGoal
      })
      await input.onTurnLifecycle?.({
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-goal-mode',
        turnId: 'turn-goal-mode'
      })
      await input.onTurnLifecycle?.({
        type: 'turn-completed',
        sequence: 2,
        threadId: 'thread-goal-mode',
        turnId: 'turn-goal-mode',
        outcome: 'completed'
      })
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-goal-mode',
        trigger: 'submit-message',
        messages: [
          {
            id: 'goal-user-message',
            role: 'user',
            parts: [{ type: 'text', text: '完成参考实现的功能对齐' }]
          }
        ],
        modelId: 'gpt-test',
        body: {
          threadGoalDraft: { objective: '完成参考实现的功能对齐' }
        }
      },
      port
    )

    expect(setThreadGoal).toHaveBeenCalledWith({
      objective: '完成参考实现的功能对齐',
      status: 'active'
    })
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        goalFirstTurnObjective: '完成参考实现的功能对齐',
        goalContinuous: true
      })
    )
  })

  it('resumes an existing thread Goal on one continuous owner without a user turn', async () => {
    const port = new FakePort()
    const setThreadGoal = vi.fn().mockResolvedValue({
      threadId: 'thread-existing-goal',
      objective: '完成遗留任务',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 0,
      updatedAt: 0
    })
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onSessionCreated?.({
        ...activeSession('thread-existing-goal', 'turn-placeholder', async () => undefined),
        turnId: undefined,
        setThreadGoal
      })
      await input.onTurnLifecycle?.({
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-existing-goal',
        turnId: 'turn-existing-goal'
      })
      await input.onTurnLifecycle?.({
        type: 'turn-completed',
        sequence: 2,
        threadId: 'thread-existing-goal',
        turnId: 'turn-existing-goal',
        outcome: 'completed'
      })
      await input.onThreadGoalUpdated?.({
        threadId: 'thread-existing-goal',
        goal: {
          threadId: 'thread-existing-goal',
          objective: '完成遗留任务',
          status: 'complete',
          tokenBudget: null,
          tokensUsed: 1,
          timeUsedSeconds: 1,
          createdAt: 0,
          updatedAt: 1
        }
      })
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'thread-existing-goal',
        trigger: 'goal-control',
        messages: [],
        modelId: 'gpt-test',
        body: {
          conversationId: 'thread-existing-goal',
          threadId: 'thread-existing-goal',
          threadGoalControl: { objective: '完成遗留任务' }
        }
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeThreadId: 'thread-existing-goal',
        goalControlObjective: '完成遗留任务',
        goalContinuous: true
      })
    )
    expect(setThreadGoal).toHaveBeenCalledTimes(1)
    expect(setThreadGoal).toHaveBeenCalledWith({ objective: '完成遗留任务', status: 'active' })
    expect(port.messages).toContainEqual({
      type: 'thread-goal',
      threadId: 'thread-existing-goal',
      goal: expect.objectContaining({ objective: '完成遗留任务', status: 'active' })
    })
  })

  it('forwards Goal updates from the provider as renderer-safe stream events', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-goal-events' })
      await input.onThreadGoalUpdated?.({
        threadId: 'thread-goal-events',
        goal: {
          threadId: 'thread-goal-events',
          objective: '完成参考实现的功能对齐',
          status: 'active',
          tokenBudget: 1200,
          tokensUsed: 12,
          timeUsedSeconds: 3,
          createdAt: 1,
          updatedAt: 2
        }
      })
      await completeCanonicalTurn(input, 'thread-goal-events', 'turn-goal-events')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-goal-events',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages).toContainEqual({
      type: 'thread-goal',
      threadId: 'thread-goal-events',
      goal: {
        threadId: 'thread-goal-events',
        objective: '完成参考实现的功能对齐',
        status: 'active',
        tokenBudget: 1200,
        tokensUsed: 12,
        timeUsedSeconds: 3,
        createdAt: 1,
        updatedAt: 2
      }
    })
  })

  it('forwards the applied collaboration mode without exposing thread settings', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-mode-events' })
      await input.onThreadSettingsUpdated?.({
        threadId: 'thread-mode-events',
        modeKind: 'plan',
        model: 'internal-model-configuration',
        effort: 'high'
      })
      await completeCanonicalTurn(input, 'thread-mode-events', 'turn-mode-events')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-mode-events',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages).toContainEqual({
      type: 'mode-applied',
      threadId: 'thread-mode-events',
      modeKind: 'plan'
    })
  })

  it('returns the exact advertised command policy decision instead of renderer-provided policy data', () => {
    const execPolicyDecision = {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git status *'] }
    }
    const networkPolicyDecision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: 'github.com', action: 'allow' }
      }
    }
    const params = {
      availableDecisions: ['accept', execPolicyDecision, networkPolicyDecision, 'decline', 'cancel']
    }

    expect(
      commandApprovalDecisionFromResponse(params, {
        action: 'approveWithExecpolicyAmendment'
      })
    ).toBe(execPolicyDecision)
    expect(
      commandApprovalDecisionFromResponse(params, { action: 'applyNetworkPolicyAmendment' })
    ).toBe(networkPolicyDecision)
    expect(
      commandApprovalDecisionFromResponse(
        { availableDecisions: ['accept'] },
        { action: 'applyNetworkPolicyAmendment' }
      )
    ).toBe('cancel')
    expect(commandApprovalDecisionFromResponse(params, { action: 'decline' })).toBe('decline')
    expect(commandApprovalDecisionFromResponse(params, { action: 'cancel' })).toBe('cancel')
  })

  it('keeps typed MCP form values intact when rebuilding the protocol response', () => {
    expect(
      mcpElicitationResponseFromApprovalResponse({
        action: 'submitMcpForm',
        values: { features: ['logs', 'metrics'], replicas: 2, dryRun: true }
      })
    ).toEqual({
      action: 'accept',
      content: { features: ['logs', 'metrics'], replicas: 2, dryRun: true },
      _meta: null
    })
  })

  it('rebuilds permission grants only from the original Main-process request', () => {
    const originalPermissions = {
      network: { enabled: true },
      fileSystem: { read: ['/repo'], write: null }
    }
    expect(
      permissionsApprovalResponseFromApprovalResponse(
        { permissions: originalPermissions },
        { action: 'approvePermissions', scope: 'session' }
      )
    ).toEqual({ permissions: originalPermissions, scope: 'session' })
    expect(
      permissionsApprovalResponseFromApprovalResponse(
        { permissions: originalPermissions },
        { action: 'decline' }
      )
    ).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('replays an active turn to a replacement renderer port without interrupting it', async () => {
    const firstPort = new FakePort()
    const replacementPort = new FakePort()
    const releaseTurn = deferred()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-recoverable' })
      await releaseTurn.promise
      await completeCanonicalTurn(input, 'thread-recoverable', 'turn-recoverable')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    const running = service.startChatStream(
      {
        chatId: 'conversation-recoverable',
        trigger: 'submit-message',
        messages: [
          {
            id: 'user-recoverable',
            role: 'user',
            parts: [{ type: 'text', text: 'Preserve this local prompt.' }]
          }
        ],
        modelId: 'gpt-test'
      },
      firstPort,
      undefined,
      'stream-initial'
    )
    await flushAsyncWork()
    service.handleChatStreamPortClosed('conversation-recoverable', 'stream-initial')

    const descriptor = service.getActiveChatRun('thread-recoverable')
    expect(descriptor).toMatchObject({
      conversationId: 'conversation-recoverable',
      threadId: 'thread-recoverable'
    })
    expect(descriptor?.runId).toEqual(expect.any(String))
    expect(descriptor?.lastSequence).toBeGreaterThan(0)
    expect(service.getActiveChatSnapshot('conversation-recoverable')).toEqual({
      run: descriptor,
      baseMessages: [
        {
          id: 'user-recoverable',
          role: 'user',
          parts: [{ type: 'text', text: 'Preserve this local prompt.' }]
        }
      ]
    })
    expect(
      service.attachChatStream(
        'thread-recoverable',
        'stream-stale-run',
        new FakePort(),
        'stale-run-id'
      )
    ).toEqual({ status: 'run-mismatch' })
    const caughtUpPort = new FakePort()
    expect(
      service.attachChatStream(
        'thread-recoverable',
        'stream-caught-up',
        caughtUpPort,
        descriptor?.runId,
        descriptor?.lastSequence
      )
    ).toEqual({ status: 'attached' })
    expect(caughtUpPort.messages).toEqual([])

    expect(
      service.attachChatStream(
        'thread-recoverable',
        'stream-replacement',
        replacementPort,
        descriptor?.runId
      )
    ).toEqual({ status: 'attached' })
    expect(replacementPort.messages).toContainEqual({
      type: 'thread-bound',
      threadId: 'thread-recoverable'
    })
    expect(replacementPort.envelopes).toContainEqual(
      expect.objectContaining({
        runId: descriptor?.runId,
        sequence: 1,
        event: { type: 'thread-bound', threadId: 'thread-recoverable' }
      })
    )
    expect(service.isConversationRunning('thread-recoverable')).toBe(true)

    releaseTurn.resolve()
    await running
    expect(replacementPort.messages).toContainEqual({
      type: 'finish',
      threadId: 'thread-recoverable'
    })
  })

  it('distinguishes a disappeared run from a stale run id without emitting a terminal', () => {
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      }
    })
    const port = new FakePort()

    expect(
      service.attachChatStream('conversation-gone', 'replacement-gone', port, 'run-disappeared')
    ).toEqual({ status: 'run-unavailable' })
    expect(port.messages).toEqual([])
  })

  it('returns catalog unavailability instead of provider fallback when catalog is configured', async () => {
    providerState.listModels.mockResolvedValue([])
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn().mockResolvedValue({
        models: [],
        unavailableReason: 'backend down'
      }),
      setSelectedModel: vi.fn().mockRejectedValue(new Error('model catalog unavailable')),
      resolveClientModel: vi.fn().mockRejectedValue(new Error('model catalog unavailable'))
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      modelCatalog
    })

    await expect(service.listModels()).resolves.toEqual({
      models: [],
      unavailableReason: 'backend down'
    })
    expect(providerState.listModels).not.toHaveBeenCalled()
  })

  it('adds app-server reasoning capabilities to configured backend models', async () => {
    providerState.listModels.mockResolvedValue([
      {
        id: 'gpt-test',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast' },
          { reasoningEffort: 'xhigh', description: 'Thorough' },
          { reasoningEffort: 'unbounded', description: 'Unsupported' }
        ],
        defaultReasoningEffort: 'xhigh'
      }
    ])
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      modelCatalog: {
        listModels: vi.fn().mockResolvedValue({
          models: [{ id: 'gpt-test', displayName: 'Test', inputModalities: [], isDefault: true }],
          selectedModelId: 'gpt-test'
        }),
        setSelectedModel: vi.fn(),
        resolveClientModel: vi.fn()
      } satisfies ModelCatalogLike
    })

    await expect(service.listModels()).resolves.toEqual({
      models: [
        {
          id: 'gpt-test',
          displayName: 'Test',
          inputModalities: [],
          reasoningEfforts: [
            { id: 'low', description: 'Fast' },
            { id: 'xhigh', description: 'Thorough' }
          ],
          defaultReasoningEffort: 'xhigh',
          isDefault: true
        }
      ],
      selectedModelId: 'gpt-test'
    })
  })

  it('replays a recent failed terminal to a renderer that detached before it arrived', async () => {
    const firstPort = new FakePort()
    const replacementPort = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => ({
        toUIMessageStream: () =>
          (async function* () {
            yield { type: 'text-start', id: 'retained-text' } as never
            yield { type: 'text-delta', id: 'retained-text', delta: 'partial' } as never
            yield { type: 'error', errorText: 'upstream disconnected' } as never
          })()
      })
    })

    await service.startChatStream(
      {
        chatId: 'conversation-retained-terminal',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      firstPort,
      undefined,
      'initial-retained-terminal'
    )
    const descriptor = service.getActiveChatRun('conversation-retained-terminal')
    expect(descriptor?.runId).toEqual(expect.any(String))
    expect(
      service.attachChatStream(
        'conversation-retained-terminal',
        'replacement-retained-terminal',
        replacementPort,
        descriptor?.runId
      )
    ).toEqual({ status: 'attached' })
    expect(replacementPort.messages).toEqual([
      { type: 'chunk', chunk: { type: 'text-start', id: 'retained-text' } },
      { type: 'chunk', chunk: { type: 'text-delta', id: 'retained-text', delta: 'partial' } },
      { type: 'error', error: 'upstream disconnected' }
    ])
  })

  it('keeps catalog validation required after an unavailable catalog list', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await completeCanonicalTurn(input)
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    providerState.listModels.mockResolvedValue([
      {
        id: 'provider-model',
        displayName: 'Provider Model',
        inputModalities: ['text'],
        isDefault: true
      }
    ])
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn().mockResolvedValue({
        models: [],
        unavailableReason: 'backend down'
      }),
      setSelectedModel: vi.fn().mockRejectedValue(new Error('model catalog unavailable')),
      resolveClientModel: vi.fn().mockRejectedValue(new Error('model catalog unavailable'))
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      modelCatalog,
      streamText
    })

    await service.listModels()
    await expect(service.setSelectedModel('provider-model')).rejects.toThrow(
      'model catalog unavailable'
    )
    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'provider-model'
      },
      port
    )

    expect(modelCatalog.setSelectedModel).toHaveBeenCalledWith('provider-model')
    expect(modelCatalog.resolveClientModel).toHaveBeenCalledWith('provider-model')
    expect(streamText).not.toHaveBeenCalled()
    expect(port.messages).toEqual([{ type: 'error', error: 'model catalog unavailable' }])
  })

  it('restores app media URLs only in the model-input request copy', async () => {
    const port = new FakePort()
    let originalMessages: unknown
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await completeCanonicalTurn(input)
      return {
        toUIMessageStream: (options?: { originalMessages?: unknown }) => {
          originalMessages = options?.originalMessages
          return emptyUiMessageStream()
        }
      }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })
    const messages = [
      {
        id: 'user-image',
        role: 'user' as const,
        parts: [
          {
            type: 'file' as const,
            mediaType: 'image/png',
            url: 'app://fs/@fs/tmp/codex-clipboard.png'
          },
          { type: 'text' as const, text: 'Describe this image' }
        ]
      }
    ]

    await service.startChatStream(
      {
        chatId: 'chat-media',
        trigger: 'submit-message',
        messages,
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          messages: [
            expect.objectContaining({
              parts: [
                expect.objectContaining({ url: 'file:///tmp/codex-clipboard.png' }),
                expect.objectContaining({ text: 'Describe this image' })
              ]
            })
          ]
        })
      })
    )
    expect(originalMessages).toBe(messages)
    expect(messages[0]!.parts[0]!.url).toBe('app://fs/@fs/tmp/codex-clipboard.png')
    expect(port.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-prestarted' })
  })

  it('rejects invalid app media URLs before invoking the provider boundary', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async () => ({
      toUIMessageStream: () => emptyUiMessageStream()
    }))
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-invalid-media',
        trigger: 'submit-message',
        messages: [
          {
            id: 'user-image',
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'image/png',
                url: 'app://fs/@fs/tmp/%252e%252e/secret.png'
              }
            ]
          }
        ],
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).not.toHaveBeenCalled()
    expect(port.messages).toEqual([
      { type: 'error', error: 'Invalid local media URL in model input' }
    ])
  })

  it('revalidates local path attachments before invoking the provider boundary', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await completeCanonicalTurn(input)
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'chat-invalid-local-attachment',
        trigger: 'submit-message',
        messages: [
          {
            id: 'user-file',
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'application/vnd.dascowork.local-file',
                filename: 'missing.txt',
                url: 'file:///definitely-missing-dascowork-runtime.txt'
              }
            ]
          }
        ],
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).not.toHaveBeenCalled()
    expect(port.messages).toEqual([
      {
        type: 'error',
        error: 'Invalid local attachment “missing.txt”: path does not exist or is not readable'
      }
    ])
  })

  it('uses the configured model catalog for listModels', async () => {
    const catalogList = {
      models: [
        {
          id: 'backend-model',
          displayName: 'Backend Model',
          description: 'Catalog model',
          inputModalities: ['text'],
          isDefault: true
        }
      ],
      selectedModelId: 'backend-model'
    }
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn().mockResolvedValue(catalogList),
      setSelectedModel: vi.fn(),
      resolveClientModel: vi.fn()
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      modelCatalog
    })

    await expect(service.listModels()).resolves.toEqual(catalogList)
    expect(modelCatalog.listModels).toHaveBeenCalledTimes(1)
  })

  it('exposes only supported provider reasoning efforts to the renderer', async () => {
    providerState.listModels.mockResolvedValue([
      {
        id: 'provider-model',
        model: 'provider-model',
        displayName: 'Provider Model',
        description: 'Provider model',
        inputModalities: ['text'],
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Faster responses' },
          { reasoningEffort: 'xhigh', description: 'More thorough responses' },
          { reasoningEffort: 'unbounded', description: 'Unsupported effort' }
        ],
        defaultReasoningEffort: 'xhigh',
        isDefault: true
      }
    ])
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      }
    })

    await expect(service.listModels()).resolves.toEqual({
      models: [
        {
          id: 'provider-model',
          displayName: 'Provider Model',
          description: 'Provider model',
          inputModalities: ['text'],
          reasoningEfforts: [
            { id: 'low', description: 'Faster responses' },
            { id: 'xhigh', description: 'More thorough responses' }
          ],
          defaultReasoningEffort: 'xhigh',
          isDefault: true
        }
      ],
      selectedModelId: 'provider-model'
    })
  })

  it('uses the catalog selected model when chat requests omit modelId', async () => {
    const port = new FakePort()
    const streamText = streamTextWithStartedThread()
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn().mockResolvedValue({
        models: [
          {
            id: 'backend-default',
            displayName: 'Backend Default',
            inputModalities: ['text'],
            isDefault: true
          }
        ],
        selectedModelId: 'backend-default'
      }),
      setSelectedModel: vi.fn(),
      resolveClientModel: vi.fn().mockResolvedValue({
        model_id: 'backend-default',
        display_name: 'Backend Default',
        description: null,
        provider: 'openai',
        capabilities: ['text'],
        is_default: true,
        api_base_url: 'https://models.example.test',
        api_key: 'secret',
        api_format: 'openai',
        source: 'admin'
      })
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      modelCatalog
    })

    await service.listModels()
    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: []
      },
      port
    )

    expect(modelCatalog.resolveClientModel).toHaveBeenCalledWith('backend-default')
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'backend-default'
      })
    )
    expect(port.messages).toContainEqual({ type: 'thread-bound', threadId: 'thread-prestarted' })
    expect(port.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-prestarted' })
  })

  it('rejects chat request modelId values that are not in the catalog', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async () => ({
      toUIMessageStream: () => emptyUiMessageStream()
    }))
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn(),
      setSelectedModel: vi.fn(),
      resolveClientModel: vi.fn().mockRejectedValue(new Error('Unknown model: unknown-model'))
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      modelCatalog
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'unknown-model'
      },
      port
    )

    expect(streamText).not.toHaveBeenCalled()
    expect(port.messages).toEqual([{ type: 'error', error: 'Unknown model: unknown-model' }])
  })

  it('streams with the canonical catalog model id after resolving padded request values', async () => {
    const port = new FakePort()
    const streamText = streamTextWithStartedThread()
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn(),
      setSelectedModel: vi.fn(),
      resolveClientModel: vi.fn().mockResolvedValue({
        model_id: 'canonical-model',
        display_name: 'Canonical Model',
        description: null,
        provider: 'openai',
        capabilities: ['text'],
        is_default: false,
        api_base_url: 'https://models.example.test',
        api_key: 'secret',
        api_format: 'openai',
        source: 'admin'
      })
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      modelCatalog
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: '  canonical-model  '
      },
      port
    )

    expect(modelCatalog.resolveClientModel).toHaveBeenCalledWith('  canonical-model  ')
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'canonical-model'
      })
    )
    expect(port.messages).toContainEqual({ type: 'thread-bound', threadId: 'thread-prestarted' })
    expect(port.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-prestarted' })
  })

  it('delegates selected model validation to the catalog', async () => {
    const modelCatalog: ModelCatalogLike = {
      listModels: vi.fn(),
      setSelectedModel: vi.fn().mockResolvedValue({ selectedModelId: 'backend-model' }),
      resolveClientModel: vi.fn()
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      modelCatalog
    })

    await expect(service.setSelectedModel('backend-model')).resolves.toEqual({
      selectedModelId: 'backend-model'
    })
    expect(modelCatalog.setSelectedModel).toHaveBeenCalledWith('backend-model')
  })

  it('streams UI message chunks to the provided port', async () => {
    const port = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async (input: RuntimeStreamTextInput) => {
        await input.onThreadStarted?.({ threadId: 'thread-prestarted' })
        await completeCanonicalTurn(input)
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield { type: 'text-start', id: 'text-1' }
              yield { type: 'text-delta', id: 'text-1', delta: 'hello' }
              yield { type: 'text-end', id: 'text-1' }
            })()
        }
      }
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages).toEqual(
      expect.arrayContaining([
        { type: 'thread-bound', threadId: 'thread-prestarted' },
        { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } },
        { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', delta: 'hello' } },
        { type: 'chunk', chunk: { type: 'text-end', id: 'text-1' } }
      ])
    )
    expect(port.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-prestarted' })
  })

  it('forwards completed provider turn patches without keeping a Main-memory copy', async () => {
    const port = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async (input: RuntimeStreamTextInput) => {
        await input.onThreadStarted?.({ threadId: 'thread-prestarted' })
        await completeCanonicalTurn(input)
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield {
                type: 'tool-output-available',
                toolCallId: 'turn-diff:turn-prestarted',
                output: {
                  item: {
                    type: 'turnDiff',
                    status: 'completed',
                    patchBatches: [{ cwd: '/repo', gitRoot: '/repo', diff: 'trusted patch' }]
                  }
                }
              } as never
            })()
        }
      }
    })

    await service.startChatStream(
      { chatId: 'chat-turn-diff', trigger: 'submit-message', messages: [], modelId: 'gpt-test' },
      port
    )

    expect(port.messages).toContainEqual({
      type: 'chunk',
      chunk: {
        type: 'tool-output-available',
        toolCallId: 'turn-diff:turn-prestarted',
        output: {
          item: {
            type: 'turnDiff',
            status: 'completed',
            patchBatches: [{ cwd: '/repo', gitRoot: '/repo', diff: 'trusted patch' }]
          }
        }
      }
    })
  })

  it('persists the final net turn diff when the turn completes', async () => {
    const port = new FakePort()
    const turnDiffStore = { save: vi.fn(async () => undefined) }
    const finalDiff = 'diff --git a/kept.ts b/kept.ts\n+kept\n'
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      turnDiffStore,
      streamText: async (input: RuntimeStreamTextInput) => {
        input.onSessionCreated?.(
          activeSession('thread-final-diff', 'turn-final-diff', async () => undefined)
        )
        await input.onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-final-diff',
          turnId: 'turn-final-diff'
        })
        await input.onTurnDiffUpdated?.({
          threadId: 'thread-final-diff',
          turnId: 'turn-final-diff',
          diff: 'diff --git a/restored.ts b/restored.ts\n+temporary\n'
        })
        await input.onTurnDiffUpdated?.({
          threadId: 'thread-final-diff',
          turnId: 'turn-final-diff',
          diff: finalDiff
        })
        await input.onTurnLifecycle?.({
          type: 'turn-completed',
          sequence: 2,
          threadId: 'thread-final-diff',
          turnId: 'turn-final-diff',
          outcome: 'completed'
        })
        return { toUIMessageStream: () => emptyUiMessageStream() }
      }
    })

    await service.startChatStream(
      { chatId: 'chat-final-diff', trigger: 'submit-message', messages: [], modelId: 'gpt-test' },
      port
    )

    expect(turnDiffStore.save).toHaveBeenCalledWith({
      threadId: 'thread-final-diff',
      turnId: 'turn-final-diff',
      diff: finalDiff
    })
  })

  it('resumes the same active turn after an app-server transport disconnect', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      if (!input.resumeActiveTurn) {
        input.onSessionCreated?.(
          activeSession('thread-recover', 'turn-recover', async () => undefined)
        )
        input.onExistingTurnRecoveryState?.({
          turnId: 'turn-recover',
          textByItemId: { 'text-recover': 'Hel' },
          emittedProviderToolCallIds: [],
          completedProviderToolCallIds: []
        })
        await input.onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-recover',
          turnId: 'turn-recover'
        })
        return {
          toUIMessageStream: (options?: { onError?: (error: unknown) => string }) =>
            (async function* () {
              yield { type: 'text-start', id: 'text-recover' } as never
              yield { type: 'text-delta', id: 'text-recover', delta: 'Hel' } as never
              yield {
                type: 'error',
                errorText:
                  options?.onError?.(
                    new CodexProviderError('any transport message', {
                      code: 'app_server_transport_closed'
                    })
                  ) ?? 'any transport message'
              } as never
            })()
        }
      }

      expect(input.resumeThreadId).toBe('thread-recover')
      expect(input.existingTurnRecoveryState).toMatchObject({
        turnId: 'turn-recover',
        textByItemId: { 'text-recover': 'Hel' }
      })
      input.onSessionCreated?.(
        activeSession('thread-recover', 'turn-recover', async () => undefined)
      )
      await input.onTurnLifecycle?.({
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-recover',
        turnId: 'turn-recover'
      })
      await input.onTurnLifecycle?.({
        type: 'turn-completed',
        sequence: 2,
        threadId: 'thread-recover',
        turnId: 'turn-recover',
        outcome: 'completed'
      })
      return {
        toUIMessageStream: () =>
          (async function* () {
            yield { type: 'text-delta', id: 'text-recover', delta: 'lo' } as never
          })()
      }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'conversation-recover-active-turn',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).toHaveBeenCalledTimes(2)
    expect(streamText.mock.calls[0]?.[0]).not.toHaveProperty('resumeActiveTurn')
    expect(streamText.mock.calls[0]?.[0]).toMatchObject({ resumeThreadId: undefined })
    expect(streamText.mock.calls[1]?.[0]).toMatchObject({
      resumeActiveTurn: true,
      resumeThreadId: 'thread-recover'
    })
    expect(port.messages).toEqual(
      expect.arrayContaining([
        { type: 'chunk', chunk: { type: 'text-delta', id: 'text-recover', delta: 'Hel' } },
        { type: 'chunk', chunk: { type: 'text-delta', id: 'text-recover', delta: 'lo' } },
        { type: 'finish', threadId: 'thread-recover' }
      ])
    )
    expect(port.messages).not.toContainEqual({
      type: 'error',
      error: 'App Server transport closed unexpectedly (code 1).'
    })
  })

  it('settles as interrupted when the restarted app-server no longer has the active turn', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      if (input.resumeActiveTurn) {
        expect(input.resumeThreadId).toBe('thread-restart')
        return {
          toUIMessageStream: (options?: { onError?: (error: unknown) => string }) =>
            (async function* () {
              yield {
                type: 'error',
                errorText:
                  options?.onError?.(
                    new CodexProviderError('any unavailable-turn message', {
                      code: 'active_turn_unavailable'
                    })
                  ) ?? 'any unavailable-turn message'
              } as never
            })()
        }
      }
      input.onSessionCreated?.(
        activeSession('thread-restart', 'turn-restart', async () => undefined)
      )
      input.onExistingTurnRecoveryState?.({
        turnId: 'turn-restart',
        textByItemId: { 'text-restart': 'partial history' },
        emittedProviderToolCallIds: [],
        completedProviderToolCallIds: []
      })
      await input.onTurnLifecycle?.({
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-restart',
        turnId: 'turn-restart'
      })
      return {
        toUIMessageStream: (options?: { onError?: (error: unknown) => string }) =>
          (async function* () {
            yield { type: 'text-start', id: 'text-restart' } as never
            yield { type: 'text-delta', id: 'text-restart', delta: 'partial history' } as never
            yield {
              type: 'error',
              errorText:
                options?.onError?.(
                  new CodexProviderError('another arbitrary transport message', {
                    code: 'app_server_transport_terminated'
                  })
                ) ?? 'another arbitrary transport message'
            } as never
          })()
      }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'conversation-restart-no-active-turn',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).toHaveBeenCalledTimes(2)
    expect(streamText.mock.calls[1]?.[0]).toMatchObject({
      resumeActiveTurn: true,
      resumeThreadId: 'thread-restart'
    })
    expect(port.messages).toEqual(
      expect.arrayContaining([
        {
          type: 'chunk',
          chunk: { type: 'text-delta', id: 'text-restart', delta: 'partial history' }
        },
        { type: 'aborted' }
      ])
    )
    expect(port.messages).not.toContainEqual(expect.objectContaining({ type: 'error' }))
  })

  it('does not resume an existing turn from a transport-looking message without a provider code', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      input.onSessionCreated?.(
        activeSession('thread-uncoded-transport', 'turn-uncoded-transport', async () => undefined)
      )
      input.onExistingTurnRecoveryState?.({
        turnId: 'turn-uncoded-transport',
        textByItemId: {},
        emittedProviderToolCallIds: [],
        completedProviderToolCallIds: []
      })
      return {
        toUIMessageStream: (options?: { onError?: (error: unknown) => string }) =>
          (async function* () {
            yield {
              type: 'error',
              errorText:
                options?.onError?.(
                  new Error('App Server transport closed unexpectedly, but this is uncoded.')
                ) ?? 'uncoded transport failure'
            } as never
          })()
      }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'conversation-uncoded-transport',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(streamText).toHaveBeenCalledOnce()
    expect(port.messages).toContainEqual({
      type: 'error',
      error: 'App Server transport closed unexpectedly, but this is uncoded.'
    })
  })

  it('forwards completed turn duration to UI message metadata', async () => {
    const port = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => ({
        toUIMessageStream: (options) => {
          expect(
            options?.messageMetadata?.({
              part: {
                providerMetadata: {
                  '@janole/ai-sdk-provider-codex-asp': { turnDurationMs: 1250 }
                }
              }
            })
          ).toEqual({ codexTurnDurationMs: 1250 })
          return emptyUiMessageStream()
        }
      })
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )
  })

  it('forwards model stream error messages as terminal IPC errors', async () => {
    const port = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => ({
        toUIMessageStream: (options: { onError?: (error: unknown) => string } = {}) =>
          (async function* () {
            yield {
              type: 'error',
              errorText:
                options.onError?.(new Error('The free quota has been exhausted.')) ??
                'missing error'
            }
          })()
      })
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages.filter((message) => isTerminalMessage(message))).toEqual([
      { type: 'error', error: 'The free quota has been exhausted.' }
    ])
  })

  it('preserves an upstream failure detail after canonical failed completion', async () => {
    const port = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        onSessionCreated?.(activeSession('thread-quota', 'turn-quota', async () => undefined))
        const failedLifecycle = {
          type: 'turn-completed',
          sequence: 1,
          threadId: 'thread-quota',
          turnId: 'turn-quota',
          outcome: 'failed',
          error: 'The canonical quota has been exhausted.'
        } as const
        await onTurnLifecycle?.(failedLifecycle)
        return {
          toUIMessageStream: (options: { onError?: (error: unknown) => string } = {}) =>
            (async function* () {
              yield {
                type: 'error',
                errorText:
                  options.onError?.(new Error('The stream quota has been exhausted.')) ??
                  'missing error'
              }
            })()
        }
      }
    })

    await service.startChatStream(
      {
        chatId: 'chat-quota',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages.filter((message) => isTerminalMessage(message))).toEqual([
      { type: 'error', error: 'The canonical quota has been exhausted.' }
    ])
  })

  it('forwards accepted item state without exposing its payload to the renderer', async () => {
    const port = new FakePort()
    const command = {
      id: 'command-journal',
      type: 'commandExecution' as const,
      pluginId: null,
      scriptPath: null,
      command: 'pwd',
      cwd: '/repo',
      processId: 'pid-journal',
      source: 'agent' as const,
      status: 'completed' as const,
      commandActions: [],
      aggregatedOutput: '/repo',
      exitCode: 0,
      durationMs: 8
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        onSessionCreated?.(activeSession('thread-journal', 'turn-journal', async () => undefined))
        await onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-journal',
          turnId: 'turn-journal'
        })
        await onTurnLifecycle?.({
          type: 'item-completed',
          sequence: 2,
          threadId: 'thread-journal',
          turnId: 'turn-journal',
          itemId: command.id,
          itemType: command.type,
          item: command
        })
        await onTurnLifecycle?.({
          type: 'turn-completed',
          sequence: 3,
          threadId: 'thread-journal',
          turnId: 'turn-journal',
          outcome: 'completed'
        })
        return { toUIMessageStream: () => emptyUiMessageStream() }
      }
    })

    await service.startChatStream(
      {
        chatId: 'chat-journal',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages).toContainEqual({
      type: 'turn-lifecycle',
      event: expect.objectContaining({
        type: 'item-completed',
        itemId: command.id,
        itemType: command.type
      })
    })
    expect(JSON.stringify(port.messages)).not.toContain('aggregatedOutput')
  })

  it('redacts credentials, explains a missing Codex CLI, and supplies a fallback before forwarding stream errors', async () => {
    const errors = [
      new Error('Authorization: Bearer secret-token api_key=secret-value sk-secret123'),
      Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
      new Error('   ')
    ]
    const ports = [new FakePort(), new FakePort(), new FakePort()]
    let invocation = 0
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => {
        const currentError = errors[invocation++]
        return {
          toUIMessageStream: (options: { onError?: (error: unknown) => string } = {}) =>
            (async function* () {
              yield {
                type: 'error',
                errorText: options.onError?.(currentError) ?? 'missing error'
              }
            })()
        }
      }
    })

    for (const [index, port] of ports.entries()) {
      await service.startChatStream(
        {
          chatId: `chat-${index}`,
          trigger: 'submit-message',
          messages: [],
          modelId: 'gpt-test',
          body: { conversationId: `conversation-${index}` }
        },
        port
      )
    }

    expect(ports[0].messages).toEqual([
      {
        type: 'error',
        error: 'Authorization: [REDACTED] api_key=[REDACTED] sk-[REDACTED]'
      }
    ])
    expect(ports[1].messages).toEqual([
      {
        type: 'error',
        error: '未找到 Codex CLI。请安装 Codex CLI、将 codex 加入 PATH 并完成登录后重试。'
      }
    ])
    expect(ports[2].messages).toEqual([{ type: 'error', error: '模型响应未完成，请重试。' }])
  })

  it('persists project assignment to the canonical app-server thread id', async () => {
    const port = new FakePort()
    const projectStore = ProjectStore.inMemory(createDefaultProjectState())
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'local',
        cwd: '/repo',
        workspaceRoots: ['/repo'],
        workspaceKind: 'project',
        projectAssignment: {
          projectKind: 'local',
          projectId: 'project-1',
          cwd: '/repo'
        }
      }),
      resolveExistingThreadTarget: vi.fn()
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      projectService,
      projectStore,
      streamText: async (input: RuntimeStreamTextInput) => {
        await input.onThreadStarted?.({ threadId: 'thread-prestarted' })
        await completeCanonicalTurn(input)
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield {
                type: 'text-start',
                id: 'text-1',
                providerMetadata: {
                  '@janole/ai-sdk-provider-codex-asp': {
                    threadId: 'thread-prestarted'
                  }
                }
              } as never
            })()
        }
      }
    })

    await service.startChatStream(
      {
        chatId: 'chat-temp',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: {
          projectSelection: { projectKind: 'local', projectId: 'project-1' }
        }
      },
      port
    )

    await flushAsyncWork()
    await expect(projectStore.getState()).resolves.toMatchObject({
      threadProjectAssignments: {
        'thread-prestarted': {
          projectKind: 'local',
          projectId: 'project-1',
          cwd: '/repo'
        }
      }
    })
    expect((await projectStore.getState()).threadProjectAssignments).not.toHaveProperty('chat-temp')
  })

  it('does not fail the chat stream when project assignment persistence fails', async () => {
    const port = new FakePort()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'local',
        cwd: '/repo',
        workspaceRoots: ['/repo'],
        workspaceKind: 'project',
        projectAssignment: {
          projectKind: 'local',
          projectId: 'project-1',
          cwd: '/repo'
        }
      }),
      resolveExistingThreadTarget: vi.fn()
    }
    const projectStore = {
      getState: vi.fn(async () => createDefaultProjectState()),
      setState: vi.fn(async () => {
        throw new Error('project store unavailable')
      })
    }
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      projectService,
      projectStore,
      streamText: async (input: RuntimeStreamTextInput) => {
        await input.onThreadStarted?.({ threadId: 'thread-prestarted' })
        await completeCanonicalTurn(input)
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield { type: 'text-start', id: 'text-1' } as never
            })()
        }
      }
    })

    try {
      await service.startChatStream(
        {
          chatId: 'chat-1',
          trigger: 'submit-message',
          messages: [],
          modelId: 'gpt-test',
          body: {
            projectSelection: { projectKind: 'local', projectId: 'project-1' }
          }
        },
        port
      )
      await flushAsyncWork()

      expect(projectStore.setState).toHaveBeenCalled()
      expect(consoleError).toHaveBeenCalledWith(
        'failed to persist project assignment for thread-prestarted',
        expect.any(Error)
      )
      expect(port.messages).toEqual(
        expect.arrayContaining([
          { type: 'thread-bound', threadId: 'thread-prestarted' },
          { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } }
        ])
      )
      expect(port.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-prestarted' })
    } finally {
      consoleError.mockRestore()
    }
  })

  it('publishes the provider-started thread before streaming first-turn chunks', async () => {
    const port = new FakePort()
    const events: string[] = []
    const postMessage = port.postMessage.bind(port)
    vi.spyOn(port, 'postMessage').mockImplementation((message) => {
      const event = isStreamEnvelope(message) ? message.event : message
      if (event.type === 'thread-bound') {
        events.push(`port:${event.threadId}`)
      }
      postMessage(message)
    })
    const onThreadIdAvailable = vi.fn((threadId: string) => {
      events.push(`callback:${threadId}`)
    })
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      const { resumeThreadId, onThreadStarted } = input
      expect(resumeThreadId).toBeUndefined()
      events.push('streamText')
      await onThreadStarted?.({ threadId: 'thread-prestarted' })
      await completeCanonicalTurn(input)
      return {
        toUIMessageStream: () =>
          (async function* () {
            events.push('chunk')
            yield { type: 'text-start', id: 'text-1' } as never
          })()
      }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    const result = await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            parts: [
              {
                type: 'text',
                text: [
                  '## Code review guidelines:',
                  '# Review Guidelines',
                  'internal instructions',
                  '## My request for Codex:',
                  '请检查我未提交的更改'
                ].join('\n')
              }
            ]
          }
        ],
        modelId: 'gpt-test'
      },
      port,
      { onThreadIdAvailable }
    )

    expect(events).toEqual([
      'streamText',
      'callback:thread-prestarted',
      'port:thread-prestarted',
      'chunk'
    ])
    expect(providerState.startThread).not.toHaveBeenCalled()
    expect(onThreadIdAvailable).toHaveBeenCalledWith(
      'thread-prestarted',
      expect.objectContaining({
        threadId: 'thread-prestarted',
        originConversationId: 'chat-1',
        title: '请检查我未提交的更改'
      })
    )
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeThreadId: undefined,
        onThreadStarted: expect.any(Function)
      })
    )
    expect(result.threadId).toBe('thread-prestarted')
    expect(port.messages).toEqual(
      expect.arrayContaining([
        { type: 'thread-bound', threadId: 'thread-prestarted' },
        { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } }
      ])
    )
    expect(port.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-prestarted' })
  })

  it('starts an explicit terminal retry in a fresh app-server thread', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-replacement' })
      await completeCanonicalTurn(input, 'thread-replacement')
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    await service.startChatStream(
      {
        chatId: 'conversation-1',
        trigger: 'regenerate-message',
        messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'retry' }] }],
        modelId: 'gpt-test',
        body: { threadId: 'thread-existing', retryTerminalTurn: true }
      },
      port
    )

    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeThreadId: undefined,
        startFreshTerminalRetry: true,
        onThreadStarted: expect.any(Function)
      })
    )
    expect(port.messages).toContainEqual({ type: 'thread-bound', threadId: 'thread-replacement' })
  })

  it('waits for async thread publication work before streaming first-turn chunks', async () => {
    const port = new FakePort()
    const publication = deferred()
    const events: string[] = []
    const streamText = vi.fn(async ({ onThreadStarted }: RuntimeStreamTextInput) => {
      await onThreadStarted?.({ threadId: 'thread-migrated' })
      return {
        toUIMessageStream: () =>
          (async function* () {
            events.push('chunk')
            yield { type: 'text-start', id: 'text-1' } as never
          })()
      }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    const run = service.startChatStream(
      {
        chatId: 'chat-local',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port,
      {
        onThreadIdAvailable: async () => {
          events.push('publication-started')
          await publication.promise
          events.push('publication-finished')
        }
      }
    )

    await flushAsyncWork()
    expect(events).toEqual(['publication-started'])
    publication.resolve()
    await run
    expect(events).toEqual(['publication-started', 'publication-finished', 'chunk'])
  })

  it('releases a prepared queue lease when another turn wins the conversation race', async () => {
    const firstPort = new FakePort()
    const secondPort = new FakePort()
    const firstTurn = deferred()
    const queueItem = {
      id: 'follow-up-1',
      conversationKey: 'conversation-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      preferredMode: 'queue' as const,
      message: {
        id: 'follow-up-1',
        text: 'queued',
        attachments: [],
        contextReferences: [],
        trustedContext: {
          conversationId: 'conversation-1',
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo']
        }
      },
      status: 'sending' as const,
      lease: {
        token: 'lease-1',
        operation: 'turn-start' as const,
        claimedAt: '2026-07-18T00:00:00.000Z',
        owner: 'runtime'
      }
    }
    const failClaim = vi.fn(async () => ({
      version: 1 as const,
      revision: 1,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const followUpQueue = {
      claimHead: vi.fn(async () => ({
        conversationKey: 'conversation-1',
        item: queueItem,
        leaseToken: 'lease-1'
      })),
      materializeClaimMessage: vi.fn(async () => ({
        id: 'follow-up-1',
        parts: [{ type: 'text' as const, text: 'queued' }],
        contextReferences: [],
        trustedContext: queueItem.message.trustedContext
      })),
      failClaim
    } as unknown as ConversationFollowUpQueueService
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue,
      streamText: vi.fn(async () => ({
        toUIMessageStream: () => waitThenEnd(firstTurn.promise)
      }))
    })

    const activeRun = service.startChatStream(
      {
        chatId: 'chat-first',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1' }
      },
      firstPort
    )
    await flushAsyncWork()

    await service.startChatStream(
      {
        chatId: 'chat-second',
        trigger: 'submit-message',
        messageId: 'follow-up-1',
        messages: [],
        modelId: 'gpt-test',
        body: {
          conversationId: 'conversation-1',
          followUpRequest: {
            conversationKey: 'conversation-1',
            itemId: 'follow-up-1'
          }
        }
      },
      secondPort
    )

    expect(failClaim).toHaveBeenCalledWith(
      'conversation-1',
      'follow-up-1',
      'lease-1',
      expect.objectContaining({ kind: 'send-failed' })
    )
    expect(secondPort.messages).toEqual([
      {
        type: 'error',
        error: 'Conversation already has an active turn: conversation-1'
      }
    ])

    firstTurn.resolve()
    await activeRun
  })

  it('settles an accepted follow-up under its migrated thread key', async () => {
    const item = {
      id: 'follow-up-migrated',
      conversationKey: 'conversation-local',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      preferredMode: 'queue' as const,
      message: {
        id: 'follow-up-migrated',
        text: 'queued',
        attachments: [],
        contextReferences: [],
        trustedContext: {
          conversationId: 'conversation-local',
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo']
        }
      },
      status: 'sending' as const,
      lease: {
        token: 'lease-migrated',
        operation: 'turn-start' as const,
        claimedAt: '2026-07-18T00:00:00.000Z',
        owner: 'runtime'
      }
    }
    const commitClaim = vi.fn(async () => ({
      version: 1 as const,
      revision: 3,
      conversationKey: 'thread-real',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const followUpQueue = {
      claimHead: vi.fn(async () => ({
        conversationKey: 'conversation-local',
        item,
        leaseToken: 'lease-migrated'
      })),
      materializeClaimMessage: vi.fn(async () => ({
        id: item.id,
        parts: [{ type: 'text' as const, text: item.message.text }],
        contextReferences: [],
        trustedContext: item.message.trustedContext
      })),
      commitClaim,
      failClaim: vi.fn()
    } as unknown as ConversationFollowUpQueueService
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue,
      streamText: async (input: RuntimeStreamTextInput) => {
        await input.onThreadStarted?.({ threadId: 'thread-real' })
        input.onSessionCreated?.({
          threadId: 'thread-real',
          turnId: 'turn-real',
          isActive: () => true,
          steerPrompt: vi.fn(),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        await input.onTurnLifecycle?.({
          type: 'item-completed',
          sequence: 1,
          threadId: 'thread-real',
          turnId: 'turn-real',
          itemId: 'user-message-real',
          itemType: 'userMessage',
          compareKey: JSON.stringify({ text: 'queued', attachments: [] })
        })
        return { toUIMessageStream: () => emptyUiMessageStream() }
      }
    })

    await service.startChatStream(
      {
        chatId: 'conversation-local',
        trigger: 'submit-message',
        messageId: item.id,
        messages: [],
        modelId: 'gpt-test',
        body: {
          conversationId: 'conversation-local',
          followUpRequest: {
            conversationKey: 'conversation-local',
            itemId: item.id
          }
        }
      },
      new FakePort(),
      { onThreadIdAvailable: vi.fn() }
    )

    expect(commitClaim).toHaveBeenCalledWith('thread-real', 'follow-up-migrated', 'lease-migrated')
  })

  it('publishes durable thread metadata before asking the renderer to bind', async () => {
    const port = new FakePort(false)
    const onThreadIdAvailable = vi.fn()
    const streamText = vi.fn(async ({ onThreadStarted }: RuntimeStreamTextInput) => {
      await onThreadStarted?.({ threadId: 'thread-acknowledged' })
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })

    const running = service.startChatStream(
      {
        chatId: 'chat-acknowledged',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port,
      { onThreadIdAvailable }
    )

    await vi.waitFor(() =>
      expect(port.messages).toContainEqual({
        type: 'thread-bound',
        threadId: 'thread-acknowledged'
      })
    )
    expect(onThreadIdAvailable).toHaveBeenCalledWith(
      'thread-acknowledged',
      expect.objectContaining({ threadId: 'thread-acknowledged' })
    )

    port.emit({ type: 'thread-bound-ack', threadId: 'thread-acknowledged' })
    await running
  })

  it('fails the stream when resumed metadata reports a different thread id', async () => {
    const port = new FakePort()
    const onThreadIdAvailable = vi.fn()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => ({
        toUIMessageStream: () =>
          (async function* () {
            yield {
              type: 'text-start',
              id: 'text-1',
              providerMetadata: {
                '@janole/ai-sdk-provider-codex-asp': {
                  threadId: 'thread-real',
                  turnId: 'turn-real'
                }
              }
            } as never
            yield { type: 'text-end', id: 'text-1' } as never
          })()
      })
    })

    const result = await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { threadId: 'thread-old' }
      },
      port,
      { onThreadIdAvailable }
    )

    expect(providerState.startThread).not.toHaveBeenCalled()
    expect(onThreadIdAvailable).not.toHaveBeenCalled()
    expect(result.threadId).toBe('thread-old')
    expect(port.messages).not.toContainEqual({ type: 'thread-bound', threadId: 'thread-real' })
    expect(port.messages.at(-1)).toEqual({
      type: 'error',
      error: 'Active conversation thread changed from thread-old to thread-real'
    })
  })

  it('tracks and interrupts an active conversation by conversation id or app-server thread id', async () => {
    const port = new FakePort()
    const metadataSeen = deferred()
    const completed = deferred()
    const interrupt = vi.fn(async () => {
      await lifecycle?.({
        type: 'turn-completed',
        sequence: 2,
        threadId: 'thread-real',
        turnId: 'turn-real',
        outcome: 'interrupted'
      })
      completed.resolve()
    })
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        onSessionCreated?.(activeSession('thread-real', 'turn-real', interrupt))
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield {
                type: 'text-start',
                id: 'text-1',
                providerMetadata: {
                  '@janole/ai-sdk-provider-codex-asp': {
                    threadId: 'thread-real',
                    turnId: 'turn-real'
                  }
                }
              } as never
              metadataSeen.resolve()
              await completed.promise
            })()
        }
      }
    })

    const streamPromise = service.startChatStream(
      {
        chatId: 'chat-temp',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1' }
      },
      port
    )

    await metadataSeen.promise
    expect(service.isConversationRunning('conversation-1')).toBe(true)
    expect(service.isConversationRunning('thread-real')).toBe(true)

    service.interruptConversation('thread-real')
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
    await streamPromise

    expect(service.isConversationRunning('conversation-1')).toBe(false)
    expect(service.isConversationRunning('thread-real')).toBe(false)
    expect(port.messages.at(-1)).toEqual({ type: 'aborted' })
  })

  it('only lets an attached stream stop the run whose runId it received', async () => {
    const initialPort = new FakePort()
    const replacementPort = new FakePort()
    const metadataSeen = deferred()
    const completed = deferred()
    const interrupt = vi.fn(async () => {
      await lifecycle?.({
        type: 'turn-completed',
        sequence: 2,
        threadId: 'thread-stop-identity',
        turnId: 'turn-stop-identity',
        outcome: 'interrupted'
      })
      completed.resolve()
    })
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        onSessionCreated?.(activeSession('thread-stop-identity', 'turn-stop-identity', interrupt))
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield {
                type: 'text-start',
                id: 'text-stop-identity',
                providerMetadata: {
                  '@janole/ai-sdk-provider-codex-asp': {
                    threadId: 'thread-stop-identity',
                    turnId: 'turn-stop-identity'
                  }
                }
              } as never
              metadataSeen.resolve()
              await completed.promise
            })()
        }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'conversation-stop-identity',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      initialPort,
      undefined,
      'initial-stop-identity'
    )
    await metadataSeen.promise
    const descriptor = service.getActiveChatRun('thread-stop-identity')
    expect(descriptor).toBeDefined()
    expect(
      service.attachChatStream(
        'thread-stop-identity',
        'replacement-stop-identity',
        replacementPort,
        descriptor?.runId
      )
    ).toEqual({ status: 'attached' })

    replacementPort.emit({ type: 'abort', runId: 'stale-run' })
    await flushAsyncWork()
    expect(interrupt).not.toHaveBeenCalled()

    replacementPort.emit({ type: 'abort', runId: descriptor?.runId })
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce())
    await running
    expect(replacementPort.messages.at(-1)).toEqual({ type: 'aborted' })
  })

  it('does not deliver a terminal until the matching canonical completion arrives', async () => {
    const port = new FakePort()
    const releaseStream = deferred()
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const interrupt = vi.fn(async () => undefined)
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        onSessionCreated?.(activeSession('thread-gated', 'turn-gated', interrupt))
        return { toUIMessageStream: () => waitThenEnd(releaseStream.promise) }
      }
    })

    const run = service.startChatStream(
      {
        chatId: 'chat-gated',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-gated' }
      },
      port
    )

    await vi.waitFor(() => expect(service.isConversationRunning('conversation-gated')).toBe(true))
    service.interruptConversation('conversation-gated')
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
    expect(port.messages.filter((message) => isTerminalMessage(message))).toEqual([])
    expect(service.isConversationRunning('conversation-gated')).toBe(true)

    await lifecycle?.({
      type: 'turn-completed',
      sequence: 1,
      threadId: 'thread-gated',
      turnId: 'turn-gated',
      outcome: 'interrupted'
    })
    releaseStream.resolve()
    await run

    expect(port.messages.filter((message) => isTerminalMessage(message))).toEqual([
      { type: 'aborted' }
    ])
  })

  it('interrupts a stop requested before session and turn binding once the session becomes available', async () => {
    const port = new FakePort()
    const publishSession = deferred()
    const completed = deferred()
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const interrupt = vi.fn(async () => {
      await lifecycle?.({
        type: 'turn-completed',
        sequence: 1,
        threadId: 'thread-late',
        turnId: 'turn-late',
        outcome: 'interrupted'
      })
      completed.resolve()
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        await publishSession.promise
        onSessionCreated?.(activeSession('thread-late', 'turn-late', interrupt))
        return { toUIMessageStream: () => waitThenEnd(completed.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-late',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-late' }
      },
      port
    )

    await vi.waitFor(() => expect(service.isConversationRunning('conversation-late')).toBe(true))
    service.interruptConversation('conversation-late')
    expect(interrupt).not.toHaveBeenCalled()

    publishSession.resolve()
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
    await run

    expect(port.messages.filter((message) => isTerminalMessage(message))).toEqual([
      { type: 'aborted' }
    ])
  })

  it.each([
    ['completed', { type: 'finish', threadId: 'thread-race' }],
    ['failed', { type: 'error', error: '模型响应未完成，请重试。' }]
  ] as const)('lets canonical %s win a stop race', async (outcome, expectedTerminal) => {
    const port = new FakePort()
    const releaseStream = deferred()
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        onSessionCreated?.(activeSession('thread-race', 'turn-race', async () => undefined))
        return { toUIMessageStream: () => waitThenEnd(releaseStream.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: `chat-race-${outcome}`,
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: `conversation-race-${outcome}` }
      },
      port
    )

    await vi.waitFor(() =>
      expect(service.isConversationRunning(`conversation-race-${outcome}`)).toBe(true)
    )
    service.interruptConversation(`conversation-race-${outcome}`)
    await lifecycle?.({
      type: 'turn-completed',
      sequence: 1,
      threadId: 'thread-race',
      turnId: 'turn-race',
      outcome
    })
    releaseStream.resolve()
    await run

    expect(port.messages.at(-1)).toEqual(expectedTerminal)
  })

  it('reconciles a missing completion from matching thread history before aborting the provider stream', async () => {
    const port = new FakePort()
    const abortSeen = deferred()
    const readCanonicalTurnOutcome = vi.fn(async () => 'interrupted' as const)
    const interrupt = vi.fn(async () => undefined)
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      canonicalOutcomeTimeoutMs: 0,
      readCanonicalTurnOutcome,
      streamText: async ({ abortSignal, onSessionCreated }) => {
        onSessionCreated?.(activeSession('thread-history', 'turn-history', interrupt))
        abortSignal.addEventListener('abort', () => abortSeen.resolve(), { once: true })
        return { toUIMessageStream: () => waitThenEnd(abortSeen.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-history',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-history' }
      },
      port
    )

    await vi.waitFor(() => expect(service.isConversationRunning('conversation-history')).toBe(true))
    service.interruptConversation('conversation-history')
    await run

    expect(readCanonicalTurnOutcome).toHaveBeenCalledWith('thread-history', 'turn-history')
    expect(port.messages.at(-1)).toEqual({ type: 'aborted' })
  })

  it('reports an unknown stop outcome as an error instead of an interrupted terminal', async () => {
    const port = new FakePort()
    const abortSeen = deferred()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      canonicalOutcomeTimeoutMs: 0,
      readCanonicalTurnOutcome: async () => undefined,
      streamText: async ({ abortSignal, onSessionCreated }) => {
        onSessionCreated?.(activeSession('thread-unknown', 'turn-unknown', async () => undefined))
        abortSignal.addEventListener('abort', () => abortSeen.resolve(), { once: true })
        return { toUIMessageStream: () => waitThenEnd(abortSeen.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-unknown',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-unknown' }
      },
      port
    )

    await vi.waitFor(() => expect(service.isConversationRunning('conversation-unknown')).toBe(true))
    service.interruptConversation('conversation-unknown')
    await run

    expect(port.messages.at(-1)).toEqual({
      type: 'error',
      error: '停止结果无法确认，请重新打开任务检查状态'
    })
  })

  it('B15 rejects a duplicate active turn without replacing the original run', async () => {
    const firstPort = new FakePort()
    const duplicatePort = new FakePort()
    const firstEntered = deferred()
    const firstCompleted = deferred()
    const streamText = vi.fn(
      async ({ onSessionCreated, onTurnLifecycle }: RuntimeStreamTextInput) => {
        onSessionCreated?.(
          activeSession('thread-first', 'turn-first', async () => {
            await onTurnLifecycle?.({
              type: 'turn-completed',
              sequence: 1,
              threadId: 'thread-first',
              turnId: 'turn-first',
              outcome: 'interrupted'
            })
            firstCompleted.resolve()
          })
        )
        firstEntered.resolve()
        return {
          toUIMessageStream: () => waitThenEnd(firstCompleted.promise)
        }
      }
    ) as NonNullable<CodexChatRuntimeServiceOptions['streamText']>
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })
    const firstRequest = service.startChatStream(
      {
        chatId: 'chat-first',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1' }
      },
      firstPort
    )

    await firstEntered.promise
    await service.startChatStream(
      {
        chatId: 'chat-duplicate',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1' }
      },
      duplicatePort
    )

    expect(streamText).toHaveBeenCalledTimes(1)
    expect(duplicatePort.messages).toEqual([
      {
        type: 'error',
        error: 'Conversation already has an active turn: conversation-1'
      }
    ])
    expect(duplicatePort.closed).toBe(true)
    expect(service.isConversationRunning('conversation-1')).toBe(true)

    service.interruptConversation('conversation-1')
    await firstRequest
    expect(firstPort.messages.at(-1)).toEqual({ type: 'aborted' })
    expect(service.isConversationRunning('conversation-1')).toBe(false)
    await assertRacePlanEvidence(['B15'], () => {
      expect(streamText).toHaveBeenCalledTimes(1)
      expect(duplicatePort.messages).toEqual([
        {
          type: 'error',
          error: 'Conversation already has an active turn: conversation-1'
        }
      ])
      expect(firstPort.messages.at(-1)).toEqual({ type: 'aborted' })
      expect(service.isConversationRunning('conversation-1')).toBe(false)
    })
  })

  it('clears the active run before delivering the authoritative terminal event', async () => {
    const secondPort = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await completeCanonicalTurn(input)
      return { toUIMessageStream: () => emptyUiMessageStream() }
    })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })
    let secondRun: Promise<unknown> | undefined
    const firstPort = new FakePort()
    const onTerminal = (terminal: { type: string }): void => {
      if (terminal.type === 'finish') {
        secondRun = service.startChatStream(
          {
            chatId: 'chat-second',
            trigger: 'submit-message',
            messages: [],
            modelId: 'gpt-test',
            body: { conversationId: 'conversation-1' }
          },
          secondPort
        )
      }
    }

    await service.startChatStream(
      {
        chatId: 'chat-first',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1' }
      },
      firstPort,
      { onTerminal }
    )
    await expect.poll(() => secondRun).toBeDefined()
    await secondRun

    expect(secondPort.messages.at(-1)).toEqual({
      type: 'finish',
      threadId: 'thread-prestarted'
    })
  })

  it('steers through the exact provider session associated with the active run', async () => {
    const finish = deferred()
    const steerPrompt = vi.fn().mockResolvedValue({ turnId: 'turn-1' })
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async (input: RuntimeStreamTextInput) => {
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt,
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return {
          toUIMessageStream: () => waitThenEnd(finish.promise)
        }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    await expect(
      service.steerConversation(
        'conversation-1',
        {
          id: 'follow-up-1',
          role: 'user',
          parts: [{ type: 'text', text: 'change direction' }]
        },
        'follow-up-1'
      )
    ).resolves.toEqual({ turnId: 'turn-1' })
    expect(steerPrompt).toHaveBeenCalledWith([expect.objectContaining({ role: 'user' })], {
      clientUserMessageId: 'follow-up-1'
    })

    finish.resolve()
    await run
  })

  it('B13 preserves a pending Steer claim when the local conversation id migrates to a thread id', async () => {
    const finish = deferred()
    const acknowledgeClaim = vi.fn(async (conversationKey: string) => ({
      version: 2 as const,
      revision: 2,
      conversationKey,
      defaultMode: 'queue' as const,
      archived: false,
      items: [createSteerClaim().item]
    }))
    const commitClaim = vi.fn(async (conversationKey: string) => ({
      version: 2 as const,
      revision: 3,
      conversationKey,
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    let onThreadStarted: RuntimeStreamTextInput['onThreadStarted']
    let onTurnLifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        acknowledgeClaim,
        commitClaim,
        failClaim: vi.fn()
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        onThreadStarted = input.onThreadStarted
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-real',
          turnId: 'turn-real',
          isActive: () => true,
          steerPrompt: vi.fn(async () => ({ turnId: 'turn-real' })),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-local',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-local' }
      },
      new FakePort(),
      { onThreadIdAvailable: vi.fn(async () => undefined) }
    )
    await flushAsyncWork()

    const baseClaim = createSteerClaim()
    const localClaim: FollowUpClaim = {
      ...baseClaim,
      conversationKey: 'conversation-local',
      item: {
        ...baseClaim.item,
        conversationKey: 'conversation-local',
        message: {
          ...baseClaim.item.message,
          trustedContext: {
            ...baseClaim.item.message.trustedContext,
            conversationId: 'conversation-local',
            threadId: undefined
          }
        }
      }
    }
    await service.steerClaimedFollowUp(localClaim, {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    await onThreadStarted?.({ threadId: 'thread-real' })
    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 1,
      threadId: 'thread-real',
      turnId: 'turn-real',
      itemId: 'canonical-user-item',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    })

    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('thread-real', 'follow-up-1', 'lease-1')
    )
    expect(acknowledgeClaim).toHaveBeenCalledWith('thread-real', 'follow-up-1', 'lease-1')
    expect(commitClaim).not.toHaveBeenCalledWith('conversation-local', 'follow-up-1', 'lease-1')
    await assertRacePlanEvidence(['B13'], () => {
      expect(acknowledgeClaim).toHaveBeenCalledWith('thread-real', 'follow-up-1', 'lease-1')
      expect(commitClaim).toHaveBeenCalledWith('thread-real', 'follow-up-1', 'lease-1')
      expect(commitClaim).not.toHaveBeenCalledWith('conversation-local', 'follow-up-1', 'lease-1')
      expect(service.isConversationRunning('thread-real')).toBe(true)
    })

    finish.resolve()
    await run
  })

  it('B16 rejects a provider session bound to another active run without steering either session', async () => {
    const firstFinish = deferred()
    const firstSteerPrompt = vi.fn(async () => ({ turnId: 'turn-first' }))
    const mismatchedSteerPrompt = vi.fn(async () => ({ turnId: 'turn-mismatched' }))
    let invocation = 0
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async (input: RuntimeStreamTextInput) => {
        invocation += 1
        if (invocation === 1) {
          await input.onSessionCreated?.({
            threadId: 'thread-shared',
            turnId: 'turn-first',
            isActive: () => true,
            steerPrompt: firstSteerPrompt,
            injectMessage: vi.fn(),
            interrupt: vi.fn()
          })
          return {
            toUIMessageStream: () => waitThenEnd(firstFinish.promise)
          }
        }
        await input.onSessionCreated?.({
          threadId: 'thread-shared',
          turnId: 'turn-mismatched',
          isActive: () => true,
          steerPrompt: mismatchedSteerPrompt,
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => emptyUiMessageStream() }
      }
    })
    const firstRun = service.startChatStream(
      {
        chatId: 'chat-first',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-first' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    const mismatchedPort = new FakePort()
    await service.startChatStream(
      {
        chatId: 'chat-mismatched',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-mismatched' }
      },
      mismatchedPort
    )

    expect(mismatchedPort.messages.at(-1)).toEqual({
      type: 'error',
      error: 'Conversation already has an active turn: thread-shared'
    })
    await expect(
      service.steerConversation(
        'conversation-mismatched',
        { id: 'wrong-steer', role: 'user', parts: [{ type: 'text', text: 'wrong' }] },
        'wrong-steer'
      )
    ).rejects.toMatchObject({ code: 'session_inactive' })
    expect(firstSteerPrompt).not.toHaveBeenCalled()
    expect(mismatchedSteerPrompt).not.toHaveBeenCalled()
    await assertRacePlanEvidence(['B16'], () => {
      expect(mismatchedPort.messages.at(-1)).toEqual({
        type: 'error',
        error: 'Conversation already has an active turn: thread-shared'
      })
      expect(firstSteerPrompt).not.toHaveBeenCalled()
      expect(mismatchedSteerPrompt).not.toHaveBeenCalled()
      expect(service.isConversationRunning('conversation-first')).toBe(true)
    })

    firstFinish.resolve()
    await firstRun
  })

  it('B04/E14 keeps a steer claim leased until canonical acknowledgement is durable', async () => {
    const finish = deferred()
    const acknowledgeClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 2,
      conversationKey: 'thread-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: [createSteerClaim().item]
    }))
    const commitClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'thread-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const followUpQueue = {
      acknowledgeClaim,
      commitClaim,
      failClaim: vi.fn()
    } as unknown as ConversationFollowUpQueueService
    let onTurnLifecycle: ((event: CodexTurnLifecycleEvent) => void | Promise<void>) | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue,
      streamText: async (input: RuntimeStreamTextInput) => {
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()
    const claim = {
      conversationKey: 'conversation-1',
      leaseToken: 'lease-1',
      item: {
        id: 'follow-up-1',
        conversationKey: 'conversation-1',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
        preferredMode: 'steer' as const,
        message: {
          id: 'follow-up-1',
          text: 'change direction',
          attachments: [],
          contextReferences: [],
          trustedContext: {
            conversationId: 'conversation-1',
            threadId: 'thread-1',
            hostId: 'local',
            cwd: '/repo',
            workspaceRoots: ['/repo']
          }
        },
        status: 'steering' as const,
        lease: {
          token: 'lease-1',
          operation: 'turn-steer' as const,
          claimedAt: '2026-07-18T00:00:00.000Z',
          owner: 'main'
        }
      }
    }

    await service.steerClaimedFollowUp(claim, {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    expect(commitClaim).not.toHaveBeenCalled()

    await onTurnLifecycle?.({
      type: 'item-started',
      sequence: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    })
    expect(commitClaim).not.toHaveBeenCalled()

    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 2,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    })
    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
    )
    expect(acknowledgeClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
    expect(acknowledgeClaim.mock.invocationCallOrder[0]).toBeLessThan(
      commitClaim.mock.invocationCallOrder[0]
    )
    await assertRacePlanEvidence(['B04'], () => {
      expect(acknowledgeClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
      expect(acknowledgeClaim.mock.invocationCallOrder[0]).toBeLessThan(
        commitClaim.mock.invocationCallOrder[0]
      )
      expect(service.isConversationRunning('conversation-1')).toBe(true)
    })

    finish.resolve()
    await run
  })

  it('B08 moves an unconfirmed successful steer to recovery-uncertain at the fake-clock 30s deadline', async () => {
    const finish = deferred()
    const failClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const steerPrompt = vi.fn(async () => ({ turnId: 'turn-1' }))
    let expireConfirmation: (() => void) | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim: vi.fn(),
        failClaim
      } as unknown as ConversationFollowUpQueueService,
      scheduleTimeout: (callback, timeoutMs) => {
        expect(timeoutMs).toBe(30_000)
        expireConfirmation = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearScheduledTimeout: vi.fn(),
      streamText: async (input: RuntimeStreamTextInput) => {
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt,
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    await service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    expireConfirmation?.()
    await vi.waitFor(() =>
      expect(failClaim).toHaveBeenCalledWith(
        'conversation-1',
        'follow-up-1',
        'lease-1',
        expect.objectContaining({
          status: 'paused-recovery-uncertain',
          kind: 'recovery-uncertain'
        })
      )
    )
    expect(steerPrompt).toHaveBeenCalledTimes(1)

    finish.resolve()
    await run
    expect(failClaim).toHaveBeenCalledTimes(1)
    await assertRacePlanEvidence(['B08'], () => {
      expect(steerPrompt).toHaveBeenCalledTimes(1)
      expect(failClaim).toHaveBeenCalledTimes(1)
      expect(failClaim).toHaveBeenCalledWith(
        'conversation-1',
        'follow-up-1',
        'lease-1',
        expect.objectContaining({
          status: 'paused-recovery-uncertain',
          kind: 'recovery-uncertain'
        })
      )
      expect(service.isConversationRunning('conversation-1')).toBe(false)
    })
  })

  it.each(['completed', 'failed', 'interrupted'] as const)(
    'keeps an RPC-successful steer recovery-uncertain when canonical %s arrives before its acknowledgement',
    async (outcome) => {
      const finish = deferred()
      const failClaim = vi.fn(async () => ({
        version: 2 as const,
        revision: 3,
        conversationKey: 'conversation-1',
        defaultMode: 'queue' as const,
        archived: false,
        items: []
      }))
      const commitClaim = vi.fn()
      let onTurnLifecycle: RuntimeStreamTextInput['onTurnLifecycle']
      const service = new CodexChatRuntimeService({
        cwd: '/repo',
        launch: {
          command: '/bin/codex-app-server',
          args: ['--listen', 'stdio://'],
          displayBinary: '/bin/codex-app-server --listen stdio://'
        },
        followUpQueue: {
          commitClaim,
          failClaim
        } as unknown as ConversationFollowUpQueueService,
        streamText: async (input: RuntimeStreamTextInput) => {
          onTurnLifecycle = input.onTurnLifecycle
          input.onSessionCreated?.({
            threadId: 'thread-1',
            turnId: 'turn-1',
            isActive: () => true,
            steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
            injectMessage: vi.fn(),
            interrupt: vi.fn()
          })
          return { toUIMessageStream: () => waitThenEnd(finish.promise) }
        }
      })
      const run = service.startChatStream(
        {
          chatId: `chat-${outcome}`,
          trigger: 'submit-message',
          messages: [],
          modelId: 'gpt-test',
          body: { conversationId: 'conversation-1', threadId: 'thread-1' }
        },
        new FakePort()
      )
      await flushAsyncWork()

      await service.steerClaimedFollowUp(createSteerClaim(), {
        id: 'follow-up-1',
        role: 'user',
        parts: [{ type: 'text', text: 'change direction' }]
      })
      const terminal: CodexTurnLifecycleEvent = {
        type: 'turn-completed',
        sequence: 1,
        threadId: 'thread-1',
        turnId: 'turn-1',
        outcome
      }
      await onTurnLifecycle?.(terminal)
      await onTurnLifecycle?.({ ...terminal, sequence: 2 })

      expect(failClaim).toHaveBeenCalledTimes(1)
      expect(failClaim).toHaveBeenCalledWith(
        'conversation-1',
        'follow-up-1',
        'lease-1',
        expect.objectContaining({
          status: 'paused-recovery-uncertain',
          kind: 'recovery-uncertain'
        })
      )

      await onTurnLifecycle?.({
        type: 'item-completed',
        sequence: 3,
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'late-canonical-user-item',
        itemType: 'userMessage',
        clientUserMessageId: 'follow-up-1'
      })
      expect(commitClaim).not.toHaveBeenCalled()

      finish.resolve()
      await run
      expect(failClaim).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps an explicit app-server steer rejection classified as rejected', async () => {
    const finish = deferred()
    const failClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim: vi.fn(),
        failClaim
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(async () => {
            throw new CodexSteerError('app_server_rejected', 'steer rejected')
          }),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-rejected',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    await expect(
      service.steerClaimedFollowUp(createSteerClaim(), {
        id: 'follow-up-1',
        role: 'user',
        parts: [{ type: 'text', text: 'change direction' }]
      })
    ).rejects.toThrow('steer rejected')
    expect(failClaim).toHaveBeenCalledWith(
      'conversation-1',
      'follow-up-1',
      'lease-1',
      expect.objectContaining({ status: 'paused-failed', kind: 'steer-rejected' })
    )

    finish.resolve()
    await run
    expect(failClaim).toHaveBeenCalledTimes(1)
  })

  it('keeps an acknowledged steer consumed when the model stream later fails', async () => {
    const failStream = deferred()
    const commitClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const failClaim = vi.fn()
    let onTurnLifecycle: ((event: CodexTurnLifecycleEvent) => void | Promise<void>) | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim,
        failClaim
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return {
          toUIMessageStream: () =>
            (async function* () {
              await failStream.promise
              yield { type: 'error', errorText: 'stream disconnected before completion' }
            })()
        }
      }
    })
    const port = new FakePort()
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      port
    )
    await flushAsyncWork()

    await service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    })
    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
    )

    failStream.resolve()
    await run

    expect(failClaim).not.toHaveBeenCalled()
    expect(port.messages.at(-1)).toEqual({
      type: 'error',
      error: 'stream disconnected before completion'
    })
  })

  it('matches a legacy canonical steer acknowledgement by compare key', async () => {
    const finish = deferred()
    const commitClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'thread-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const followUpQueue = {
      commitClaim,
      failClaim: vi.fn()
    } as unknown as ConversationFollowUpQueueService
    let onTurnLifecycle: ((event: CodexTurnLifecycleEvent) => void | Promise<void>) | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue,
      streamText: async (input: RuntimeStreamTextInput) => {
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    await service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 2,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      compareKey: JSON.stringify({ text: 'change direction', attachments: [] })
    })

    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
    )
    finish.resolve()
    await run
  })

  it('B11 ignores an ambiguous legacy acknowledgement and logs only sanitized correlation', async () => {
    const finish = deferred()
    const commitClaim = vi.fn()
    const failClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let onTurnLifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim,
        failClaim
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-ambiguous',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    const firstClaim = createSteerClaim()
    const secondClaim = createSteerClaim({
      leaseToken: 'lease-2',
      item: {
        ...firstClaim.item,
        id: 'follow-up-2',
        message: { ...firstClaim.item.message, id: 'follow-up-2' },
        lease: { ...firstClaim.item.lease!, token: 'lease-2' }
      }
    })
    await Promise.all([
      service.steerClaimedFollowUp(firstClaim, {
        id: 'follow-up-1',
        role: 'user',
        parts: [{ type: 'text', text: 'sensitive duplicate prompt' }]
      }),
      service.steerClaimedFollowUp(secondClaim, {
        id: 'follow-up-2',
        role: 'user',
        parts: [{ type: 'text', text: 'sensitive duplicate prompt' }]
      })
    ])
    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'legacy-user-item',
      itemType: 'userMessage',
      compareKey: JSON.stringify({ text: 'sensitive duplicate prompt', attachments: [] })
    })

    expect(commitClaim).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith('ambiguous legacy steer acknowledgement ignored', {
      turnId: 'turn-1',
      candidateCount: 2,
      messageIds: ['follow-up-1', 'follow-up-2']
    })
    expect(JSON.stringify(warning.mock.calls)).not.toContain('sensitive duplicate prompt')

    finish.resolve()
    await run
    expect(failClaim).toHaveBeenCalledTimes(2)
    await assertRacePlanEvidence(['B11'], () => {
      expect(commitClaim).not.toHaveBeenCalled()
      expect(warning).toHaveBeenCalledWith('ambiguous legacy steer acknowledgement ignored', {
        turnId: 'turn-1',
        candidateCount: 2,
        messageIds: ['follow-up-1', 'follow-up-2']
      })
      expect(failClaim).toHaveBeenCalledTimes(2)
      expect(service.isConversationRunning('conversation-1')).toBe(false)
    })
    warning.mockRestore()
  })

  it('B05/B09 accepts one ID-bearing canonical steer before its RPC settles and ignores the duplicate', async () => {
    const finish = deferred()
    const steerResult = deferred<{ turnId: string }>()
    const commitClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: [] as []
    }))
    let onTurnLifecycle: ((event: CodexTurnLifecycleEvent) => void | Promise<void>) | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim,
        failClaim: vi.fn()
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(() => steerResult.promise),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    const steer = service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    await flushAsyncWork()
    const canonicalEvent: CodexTurnLifecycleEvent = {
      type: 'item-completed',
      sequence: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    }
    await onTurnLifecycle?.(canonicalEvent)
    await onTurnLifecycle?.(canonicalEvent)

    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
    )
    expect(commitClaim).toHaveBeenCalledTimes(1)
    steerResult.resolve({ turnId: 'turn-1' })
    await expect(steer).resolves.toEqual({ turnId: 'turn-1' })

    finish.resolve()
    await run
    await assertRacePlanEvidence(['B05', 'B09'], async () => {
      expect(commitClaim).toHaveBeenCalledTimes(1)
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
      await expect(steerResult.promise).resolves.toEqual({ turnId: 'turn-1' })
      expect(service.isConversationRunning('conversation-1')).toBe(false)
    })
  })

  it('does not let an accepted same-content steer absorb a later legacy acknowledgement', async () => {
    const finish = deferred()
    const firstCommit = deferred<{
      version: 2
      revision: number
      conversationKey: string
      defaultMode: 'queue'
      archived: boolean
      items: []
    }>()
    const commitClaim = vi.fn(async (_conversationKey: string, itemId: string) => {
      if (itemId === 'follow-up-1') return firstCommit.promise
      return {
        version: 2 as const,
        revision: 4,
        conversationKey: 'conversation-1',
        defaultMode: 'queue' as const,
        archived: false,
        items: [] as []
      }
    })
    let onTurnLifecycle: ((event: CodexTurnLifecycleEvent) => void | Promise<void>) | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim,
        failClaim: vi.fn()
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        onTurnLifecycle = input.onTurnLifecycle
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    await service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 1,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    })
    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-1', 'lease-1')
    )

    const baseClaim = createSteerClaim()
    const secondClaim = createSteerClaim({
      leaseToken: 'lease-2',
      item: {
        ...baseClaim.item,
        id: 'follow-up-2',
        message: {
          ...baseClaim.item.message,
          id: 'follow-up-2'
        },
        lease: {
          ...baseClaim.item.lease!,
          token: 'lease-2'
        }
      }
    })
    await service.steerClaimedFollowUp(secondClaim, {
      id: 'follow-up-2',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    await onTurnLifecycle?.({
      type: 'item-completed',
      sequence: 2,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-2',
      itemType: 'userMessage',
      compareKey: JSON.stringify({ text: 'change direction', attachments: [] })
    })

    await vi.waitFor(() =>
      expect(commitClaim).toHaveBeenCalledWith('conversation-1', 'follow-up-2', 'lease-2')
    )
    firstCommit.resolve({
      version: 2,
      revision: 5,
      conversationKey: 'conversation-1',
      defaultMode: 'queue',
      archived: false,
      items: []
    })
    finish.resolve()
    await run
  })

  it('retains a run and retries durable steer settlement before the next turn', async () => {
    const firstFinish = deferred()
    const failClaim = vi
      .fn()
      .mockRejectedValueOnce(new Error('queue write unavailable'))
      .mockResolvedValue({
        version: 2 as const,
        revision: 3,
        conversationKey: 'conversation-1',
        defaultMode: 'queue' as const,
        archived: false,
        items: []
      })
    let streamInvocation = 0
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim: vi.fn(),
        failClaim
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        streamInvocation += 1
        if (streamInvocation === 1) {
          input.onSessionCreated?.({
            threadId: 'thread-1',
            turnId: 'turn-1',
            isActive: () => true,
            steerPrompt: vi.fn(async () => ({ turnId: 'turn-1' })),
            injectMessage: vi.fn(),
            interrupt: vi.fn()
          })
          return { toUIMessageStream: () => waitThenEnd(firstFinish.promise) }
        }
        await completeCanonicalTurn(input, 'thread-1', 'turn-recovery')
        return { toUIMessageStream: () => emptyUiMessageStream() }
      }
    })
    const firstPort = new FakePort()
    const firstRun = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      firstPort
    )
    await flushAsyncWork()
    await service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })

    firstFinish.resolve()
    await firstRun

    expect(firstPort.messages.at(-1)).toEqual({
      type: 'error',
      error:
        'The task ended, but follow-up state could not be saved. Retry this conversation to recover it.'
    })
    expect(service.isConversationRunning('conversation-1')).toBe(true)
    expect(failClaim).toHaveBeenCalledTimes(1)

    const recoveryPort = new FakePort()
    await service.startChatStream(
      {
        chatId: 'chat-2',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      recoveryPort
    )

    expect(failClaim).toHaveBeenCalledTimes(2)
    expect(recoveryPort.messages.at(-1)).toEqual({ type: 'finish', threadId: 'thread-1' })
    expect(service.isConversationRunning('conversation-1')).toBe(false)
  })

  it.each([
    {
      label: 'turn-race',
      rejection: new CodexSteerError('session_inactive', 'turn ended'),
      disposition: { status: 'queued', kind: 'turn-race' }
    },
    {
      label: 'server-rejection',
      rejection: new CodexSteerError('app_server_rejected', 'steer rejected'),
      disposition: { status: 'paused-failed', kind: 'steer-rejected' }
    }
  ])(
    'B06/D20 preserves an explicit $label steer rejection after terminal settlement',
    async ({ rejection, disposition }) => {
      const finish = deferred()
      const steerResult = deferred<{ turnId: string }>()
      const commitClaim = vi.fn()
      const failClaim = vi.fn(async () => ({
        version: 2 as const,
        revision: 3,
        conversationKey: 'conversation-1',
        defaultMode: 'queue' as const,
        archived: false,
        items: []
      }))
      const service = new CodexChatRuntimeService({
        cwd: '/repo',
        launch: {
          command: '/bin/codex-app-server',
          args: ['--listen', 'stdio://'],
          displayBinary: '/bin/codex-app-server --listen stdio://'
        },
        followUpQueue: {
          commitClaim,
          failClaim
        } as unknown as ConversationFollowUpQueueService,
        streamText: async (input: RuntimeStreamTextInput) => {
          input.onSessionCreated?.({
            threadId: 'thread-1',
            turnId: 'turn-1',
            isActive: () => true,
            steerPrompt: vi.fn(() => steerResult.promise),
            injectMessage: vi.fn(),
            interrupt: vi.fn()
          })
          return {
            toUIMessageStream: () =>
              (async function* () {
                await finish.promise
                yield {
                  type: 'tool-output-error',
                  toolCallId: 'tool-failed-before-steer-rejection',
                  errorText: 'tool failed'
                } as never
              })()
          }
        }
      })
      const run = service.startChatStream(
        {
          chatId: 'chat-1',
          trigger: 'submit-message',
          messages: [],
          modelId: 'gpt-test',
          body: { conversationId: 'conversation-1', threadId: 'thread-1' }
        },
        new FakePort()
      )
      await flushAsyncWork()

      const steer = service.steerClaimedFollowUp(createSteerClaim(), {
        id: 'follow-up-1',
        role: 'user',
        parts: [{ type: 'text', text: 'change direction' }]
      })
      finish.resolve()
      await run
      expect(failClaim).not.toHaveBeenCalled()
      expect(commitClaim).not.toHaveBeenCalled()
      expect(service.isConversationRunning('conversation-1')).toBe(false)
      steerResult.reject(rejection)

      await expect(steer).rejects.toThrow(rejection.message)
      await vi.waitFor(() =>
        expect(failClaim).toHaveBeenCalledWith(
          'conversation-1',
          'follow-up-1',
          'lease-1',
          expect.objectContaining(disposition)
        )
      )
      expect(failClaim).toHaveBeenCalledTimes(1)
      expect(commitClaim).not.toHaveBeenCalled()
      await planAssert({
        scenarioId: 'D20',
        assertionId: '工具失败与 steer 拒绝并发时只结算一次',
        assertion: () => {
          expect(service.isConversationRunning('conversation-1')).toBe(false)
          expect(failClaim).toHaveBeenCalledTimes(1)
          expect(failClaim).toHaveBeenCalledWith(
            'conversation-1',
            'follow-up-1',
            'lease-1',
            expect.objectContaining(disposition)
          )
          expect(commitClaim).not.toHaveBeenCalled()
        }
      })
      await assertRacePlanEvidence(['B06'], () => {
        expect(service.isConversationRunning('conversation-1')).toBe(false)
        expect(failClaim).toHaveBeenCalledTimes(1)
        expect(failClaim).toHaveBeenCalledWith(
          'conversation-1',
          'follow-up-1',
          'lease-1',
          expect.objectContaining(disposition)
        )
        expect(commitClaim).not.toHaveBeenCalled()
      })
    }
  )

  it('B07 reports a late steer RPC success as unknown after terminal recovery', async () => {
    const finish = deferred()
    const steerResult = deferred<{ turnId: string }>()
    const failClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 3,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: {
        commitClaim: vi.fn(),
        failClaim
      } as unknown as ConversationFollowUpQueueService,
      streamText: async (input: RuntimeStreamTextInput) => {
        input.onSessionCreated?.({
          threadId: 'thread-1',
          turnId: 'turn-1',
          isActive: () => true,
          steerPrompt: vi.fn(() => steerResult.promise),
          injectMessage: vi.fn(),
          interrupt: vi.fn()
        })
        return { toUIMessageStream: () => waitThenEnd(finish.promise) }
      }
    })
    const run = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'conversation-1', threadId: 'thread-1' }
      },
      new FakePort()
    )
    await flushAsyncWork()

    const steer = service.steerClaimedFollowUp(createSteerClaim(), {
      id: 'follow-up-1',
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })
    finish.resolve()
    await run
    expect(failClaim).not.toHaveBeenCalled()
    steerResult.resolve({ turnId: 'turn-1' })

    await expect(steer).rejects.toMatchObject({ code: 'steer_result_unknown' })
    await vi.waitFor(() =>
      expect(failClaim).toHaveBeenCalledWith(
        'conversation-1',
        'follow-up-1',
        'lease-1',
        expect.objectContaining({
          status: 'paused-recovery-uncertain',
          kind: 'recovery-uncertain'
        })
      )
    )
    expect(failClaim).toHaveBeenCalledTimes(1)
    await assertRacePlanEvidence(['B07'], () => {
      expect(failClaim).toHaveBeenCalledTimes(1)
      expect(failClaim).toHaveBeenCalledWith(
        'conversation-1',
        'follow-up-1',
        'lease-1',
        expect.objectContaining({
          status: 'paused-recovery-uncertain',
          kind: 'recovery-uncertain'
        })
      )
      expect(service.isConversationRunning('conversation-1')).toBe(false)
    })
  })

  it('B01 returns an inactive preflight steer to the queue before throwing', async () => {
    const failClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 2,
      conversationKey: 'conversation-1',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: { failClaim } as unknown as ConversationFollowUpQueueService
    })

    await expect(
      service.steerClaimedFollowUp(createSteerClaim(), {
        id: 'follow-up-1',
        role: 'user',
        parts: [{ type: 'text', text: 'change direction' }]
      })
    ).rejects.toThrow('steerable active turn')
    expect(failClaim).toHaveBeenCalledWith(
      'conversation-1',
      'follow-up-1',
      'lease-1',
      expect.objectContaining({ status: 'queued', kind: 'turn-race' })
    )
    await assertRacePlanEvidence(['B01'], () => {
      expect(failClaim).toHaveBeenCalledTimes(1)
      expect(failClaim).toHaveBeenCalledWith(
        'conversation-1',
        'follow-up-1',
        'lease-1',
        expect.objectContaining({ status: 'queued', kind: 'turn-race' })
      )
      expect(service.isConversationRunning('conversation-1')).toBe(false)
    })
  })

  it('allows different conversations to enter execution concurrently', async () => {
    const ports = [new FakePort(), new FakePort()]
    const entered = [deferred(), deferred()]
    const completed = [deferred(), deferred()]
    let invocation = 0
    const streamText = vi.fn(
      async ({ onSessionCreated, onTurnLifecycle }: RuntimeStreamTextInput) => {
        const index = invocation++
        onSessionCreated?.(
          activeSession(`thread-${index}`, `turn-${index}`, async () => {
            await onTurnLifecycle?.({
              type: 'turn-completed',
              sequence: 1,
              threadId: `thread-${index}`,
              turnId: `turn-${index}`,
              outcome: 'interrupted'
            })
            completed[index].resolve()
          })
        )
        entered[index].resolve()
        return {
          toUIMessageStream: () => waitThenEnd(completed[index].promise)
        }
      }
    ) as NonNullable<CodexChatRuntimeServiceOptions['streamText']>
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText
    })
    const requests = ['conversation-a', 'conversation-b'].map((conversationId, index) =>
      service.startChatStream(
        {
          chatId: `chat-${index}`,
          trigger: 'submit-message',
          messages: [],
          modelId: 'gpt-test',
          body: { conversationId }
        },
        ports[index]
      )
    )

    await Promise.all(entered.map((entry) => entry.promise))
    expect(streamText).toHaveBeenCalledTimes(2)
    expect(service.isConversationRunning('conversation-a')).toBe(true)
    expect(service.isConversationRunning('conversation-b')).toBe(true)

    service.interruptConversation('conversation-a')
    service.interruptConversation('conversation-b')
    await Promise.all(requests)
    expect(ports.map((port) => port.messages.at(-1))).toEqual([
      { type: 'aborted' },
      { type: 'aborted' }
    ])
  })

  it('keeps a healthy concurrent run and global status isolated from another turn error', async () => {
    const healthyPort = new FakePort()
    const failedPort = new FakePort()
    const healthyEntered = deferred()
    const healthyCompleted = deferred()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ request, onSessionCreated, onTurnLifecycle }) => {
        if (request.body?.conversationId === 'healthy') {
          onSessionCreated?.(
            activeSession('thread-healthy', 'turn-healthy', async () => {
              await onTurnLifecycle?.({
                type: 'turn-completed',
                sequence: 1,
                threadId: 'thread-healthy',
                turnId: 'turn-healthy',
                outcome: 'interrupted'
              })
              healthyCompleted.resolve()
            })
          )
          healthyEntered.resolve()
          return {
            toUIMessageStream: () => waitThenEnd(healthyCompleted.promise)
          }
        }
        return {
          toUIMessageStream: () =>
            (async function* () {
              yield { type: 'error', errorText: 'turn failed' } as never
            })()
        }
      }
    })
    const healthyRequest = service.startChatStream(
      {
        chatId: 'chat-healthy',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'healthy' }
      },
      healthyPort
    )
    await healthyEntered.promise
    await flushAsyncWork()

    await service.startChatStream(
      {
        chatId: 'chat-failed',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: { conversationId: 'failed' }
      },
      failedPort
    )

    expect(failedPort.messages).toEqual([{ type: 'error', error: 'turn failed' }])
    expect(healthyPort.messages).toEqual([])
    expect(service.isConversationRunning('healthy')).toBe(true)
    expect(service.getStatus()).toMatchObject({ state: 'ready' })

    service.interruptConversation('healthy')
    await healthyRequest
    expect(healthyPort.messages.at(-1)).toEqual({ type: 'aborted' })
  })

  it('sends stream errors to the provided port', async () => {
    const port = new FakePort()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => {
        throw new Error('boom')
      }
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(port.messages).toEqual([{ type: 'error', error: 'boom' }])
  })

  it('D15 closes a pending approval when the model stream fails', async () => {
    const port = new FakePort()
    const approvalRequested = deferred<void>()
    let pendingApproval: Promise<unknown> | undefined
    let approvalRequestId: string | undefined
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async (input) => {
        const requestApproval = input.approvals?.onCommandApproval
        if (!requestApproval) throw new Error('Expected the runtime to configure command approvals')
        pendingApproval = Promise.resolve(
          requestApproval({
            threadId: 'thread-approval-failure',
            turnId: 'turn-approval-failure',
            itemId: 'item-approval-failure',
            startedAtMs: 0,
            environmentId: null,
            command: 'pwd'
          } satisfies CodexCommandApprovalRequest)
        )
        void pendingApproval?.catch(() => undefined)
        return {
          toUIMessageStream: () =>
            (async function* () {
              await approvalRequested.promise
              yield { type: 'error', errorText: 'model transport disconnected' } as never
            })()
        }
      }
    })
    service.onApprovalRequest((request) => {
      approvalRequestId = request.id
      approvalRequested.resolve()
    })

    await service.startChatStream(
      {
        chatId: 'chat-approval-failure',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    await expect(pendingApproval).rejects.toThrow('The task ended before approval was completed.')
    expect(port.messages).toEqual([{ type: 'error', error: 'model transport disconnected' }])
    expect(service.isConversationRunning('chat-approval-failure')).toBe(false)
    expect(() => service.respondApproval(approvalRequestId!, { action: 'approve' })).toThrow(
      'Unknown approval request'
    )
    await planAssert({
      scenarioId: 'D15',
      assertionId: '终态后旧审批失效且不能再执行',
      assertion: async () => {
        await expect(pendingApproval).rejects.toThrow(
          'The task ended before approval was completed.'
        )
        expect(port.messages).toEqual([{ type: 'error', error: 'model transport disconnected' }])
        expect(service.isConversationRunning('chat-approval-failure')).toBe(false)
        expect(() => service.respondApproval(approvalRequestId!, { action: 'approve' })).toThrow(
          'Unknown approval request'
        )
      }
    })
  })

  it('C22 keeps the canonical turn running when the MessagePort closes', async () => {
    const port = new FakePort()
    const entered = deferred<void>()
    const completed = deferred<void>()
    const onTerminal = vi.fn()
    const interrupt = vi.fn(async () => undefined)
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        onSessionCreated?.(activeSession('thread-port-close', 'turn-port-close', interrupt))
        await onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-port-close',
          turnId: 'turn-port-close'
        })
        entered.resolve()
        return { toUIMessageStream: () => waitThenEnd(completed.promise) }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port,
      { onTerminal }
    )
    await entered.promise
    service.handleChatStreamPortClosed('chat-1')
    expect(interrupt).not.toHaveBeenCalled()
    await lifecycle?.({
      type: 'turn-completed',
      sequence: 2,
      threadId: 'thread-port-close',
      turnId: 'turn-port-close',
      outcome: 'completed'
    })
    completed.resolve()
    await running

    expect(port.messages).toContainEqual({
      type: 'turn-lifecycle',
      event: {
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-port-close',
        turnId: 'turn-port-close'
      }
    })
    expect(
      port.messages.filter((message) =>
        Boolean(
          message &&
          typeof message === 'object' &&
          'type' in message &&
          (message.type === 'finish' || message.type === 'aborted' || message.type === 'error')
        )
      )
    ).toEqual([])
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith({
      type: 'finish',
      threadId: 'thread-port-close'
    })
    expect(service.isConversationRunning('chat-1')).toBe(false)
    await planAssert({
      scenarioId: 'C22',
      assertionId: '保留可见内容并显示单一终态',
      assertion: () =>
        expect(onTerminal).toHaveBeenCalledWith({
          type: 'finish',
          threadId: 'thread-port-close'
        })
    })
    await planAssert({
      scenarioId: 'C22',
      assertionId: 'terminal 只结算一次且 Composer 恢复',
      assertion: () => {
        expect(onTerminal).toHaveBeenCalledTimes(1)
        expect(service.isConversationRunning('chat-1')).toBe(false)
      }
    })
    await planAssert({
      scenarioId: 'C22',
      assertionId: '无自动重试、额外请求或迟到事件应用',
      assertion: () => {
        expect(interrupt).not.toHaveBeenCalled()
        expect(
          port.messages.filter((message) =>
            Boolean(
              message &&
              typeof message === 'object' &&
              'type' in message &&
              (message.type === 'finish' || message.type === 'aborted' || message.type === 'error')
            )
          )
        ).toEqual([])
      }
    })
  })

  it('rejects lifecycle events for another thread, another turn, or an old sequence', async () => {
    const port = new FakePort()
    const entered = deferred<void>()
    const completed = deferred<void>()
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onSessionCreated, onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        onSessionCreated?.(
          activeSession('thread-canonical', 'turn-canonical', async () => undefined)
        )
        await onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-canonical',
          turnId: 'turn-canonical'
        })
        entered.resolve()
        return { toUIMessageStream: () => waitThenEnd(completed.promise) }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'chat-lifecycle-identity',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )
    await entered.promise

    await lifecycle?.({
      type: 'turn-started',
      sequence: 2,
      threadId: 'thread-other',
      turnId: 'turn-canonical'
    })
    await lifecycle?.({
      type: 'turn-started',
      sequence: 2,
      threadId: 'thread-canonical',
      turnId: 'turn-other'
    })
    await lifecycle?.({
      type: 'turn-started',
      sequence: 1,
      threadId: 'thread-canonical',
      turnId: 'turn-canonical'
    })

    expect(
      port.messages.filter((message) => {
        return (
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'turn-lifecycle'
        )
      })
    ).toEqual([
      {
        type: 'turn-lifecycle',
        event: {
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-canonical',
          turnId: 'turn-canonical'
        }
      }
    ])
    expect(service.isConversationRunning('chat-lifecycle-identity')).toBe(true)

    await lifecycle?.({
      type: 'turn-completed',
      sequence: 2,
      threadId: 'thread-canonical',
      turnId: 'turn-canonical',
      outcome: 'completed'
    })
    completed.resolve()
    await running

    expect(port.messages).toContainEqual({ type: 'finish', threadId: 'thread-canonical' })
  })

  it('does not bind an alias from a rejected lifecycle event before turn-started', async () => {
    const port = new FakePort()
    const entered = deferred<void>()
    const completed = deferred<void>()
    let lifecycle: RuntimeStreamTextInput['onTurnLifecycle']
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async ({ onTurnLifecycle }) => {
        lifecycle = onTurnLifecycle
        entered.resolve()
        return { toUIMessageStream: () => waitThenEnd(completed.promise) }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'chat-pre-bind-lifecycle',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )
    await entered.promise

    await lifecycle?.({
      type: 'item-started',
      sequence: 1,
      threadId: 'thread-rejected-before-bind',
      turnId: 'turn-rejected-before-bind',
      itemId: 'item-rejected',
      itemType: 'agentMessage'
    })

    expect(service.isConversationRunning('thread-rejected-before-bind')).toBe(false)
    expect(
      port.messages.filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'type' in message &&
          message.type === 'turn-lifecycle'
      )
    ).toEqual([])

    await lifecycle?.({
      type: 'turn-started',
      sequence: 2,
      threadId: 'thread-canonical-after-rejection',
      turnId: 'turn-canonical-after-rejection'
    })
    expect(service.isConversationRunning('thread-canonical-after-rejection')).toBe(true)

    await lifecycle?.({
      type: 'turn-completed',
      sequence: 3,
      threadId: 'thread-canonical-after-rejection',
      turnId: 'turn-canonical-after-rejection',
      outcome: 'completed'
    })
    completed.resolve()
    await running

    expect(port.messages).toContainEqual({
      type: 'finish',
      threadId: 'thread-canonical-after-rejection'
    })
  })

  it('closes admission before shutdown and drains an already-admitted start', async () => {
    const preparation = deferred<void>()
    const streamStarted = deferred<void>()
    const streamFinished = deferred<void>()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => {
        streamStarted.resolve()
        return { toUIMessageStream: () => waitThenEnd(streamFinished.promise) }
      }
    })
    const recoverBlockedConversationRun = vi.spyOn(
      service as unknown as { recoverBlockedConversationRun: () => Promise<void> },
      'recoverBlockedConversationRun'
    )
    recoverBlockedConversationRun.mockImplementation(() => preparation.promise)

    const admittedStart = service.startChatStream(
      {
        chatId: 'chat-admitted-before-stop',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      new FakePort()
    )
    await flushAsyncWork()

    const stopping = service.stop()
    const rejectedPort = new FakePort()
    const rejectedStart = await service.startChatStream(
      {
        chatId: 'chat-rejected-during-stop',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      rejectedPort
    )

    expect(rejectedStart).toEqual({ threadId: undefined })
    expect(rejectedPort.messages).toEqual([{ type: 'error', error: 'Codex runtime is stopping' }])
    expect(recoverBlockedConversationRun).toHaveBeenCalledOnce()
    expect(providerState.shutdown).not.toHaveBeenCalled()

    preparation.resolve()
    await streamStarted.promise
    await flushAsyncWork()
    expect(providerState.shutdown).not.toHaveBeenCalled()

    streamFinished.resolve()
    await Promise.all([admittedStart, stopping])

    expect(service.isConversationRunning('chat-admitted-before-stop')).toBe(false)
    expect(providerState.shutdown).toHaveBeenCalledTimes(1)
  })

  it('shares one shutdown promise across concurrent stop calls', async () => {
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      }
    })

    await Promise.all([service.stop(), service.stop()])

    expect(providerState.shutdown).toHaveBeenCalledTimes(1)
  })

  it('waits for active stream cleanup before shutting down the provider', async () => {
    const entered = deferred<void>()
    const finished = deferred<void>()
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText: async () => {
        entered.resolve()
        return { toUIMessageStream: () => waitThenEnd(finished.promise) }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'chat-stop-waits',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      new FakePort()
    )
    await entered.promise

    let stopped = false
    const stopping = service.stop().then(() => {
      stopped = true
    })
    await flushAsyncWork()
    expect(stopped).toBe(false)
    expect(providerState.shutdown).not.toHaveBeenCalled()

    finished.resolve()
    await Promise.all([running, stopping])

    expect(providerState.shutdown).toHaveBeenCalledTimes(1)
  })

  it('forces local stream release when shutdown misses its canonical deadline', async () => {
    const entered = deferred<void>()
    const released = deferred<void>()
    let triggerDeadline: (() => void) | undefined
    const interrupt = vi.fn(async () => new Promise<void>(() => undefined))
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      shutdownTimeoutMs: 1,
      scheduleTimeout: (callback) => {
        triggerDeadline = callback
        return {} as ReturnType<typeof setTimeout>
      },
      clearScheduledTimeout: vi.fn(),
      streamText: async ({ abortSignal, onSessionCreated, onTurnLifecycle }) => {
        onSessionCreated?.(activeSession('thread-shutdown', 'turn-shutdown', interrupt))
        await onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-shutdown',
          turnId: 'turn-shutdown'
        })
        abortSignal.addEventListener('abort', () => released.resolve(), { once: true })
        entered.resolve()
        return { toUIMessageStream: () => waitThenEnd(released.promise) }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'chat-shutdown-deadline',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      new FakePort()
    )
    await entered.promise

    const stopping = service.stop()
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
    expect(triggerDeadline).toBeDefined()
    triggerDeadline?.()
    await stopping
    await running

    expect(service.isConversationRunning('chat-shutdown-deadline')).toBe(false)
    expect(providerState.shutdown).toHaveBeenCalledTimes(1)
  })

  it('releases follow-up leases and steer confirmation timers when shutdown misses its deadline', async () => {
    const entered = deferred<void>()
    const released = deferred<void>()
    const scheduled: Array<{ callback: () => void; timeoutMs: number; timer: object }> = []
    const clearScheduledTimeout = vi.fn()
    const failClaim = vi.fn(async () => ({
      version: 2 as const,
      revision: 2,
      conversationKey: 'conversation-shutdown-follow-up',
      defaultMode: 'queue' as const,
      archived: false,
      items: []
    }))
    const interrupt = vi.fn(async () => new Promise<void>(() => undefined))
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      followUpQueue: { failClaim } as unknown as ConversationFollowUpQueueService,
      shutdownTimeoutMs: 1,
      scheduleTimeout: (callback, timeoutMs) => {
        const timer = {}
        scheduled.push({ callback, timeoutMs, timer })
        return timer as ReturnType<typeof setTimeout>
      },
      clearScheduledTimeout,
      streamText: async ({ abortSignal, onSessionCreated, onTurnLifecycle }) => {
        onSessionCreated?.(
          activeSession('thread-shutdown-follow-up', 'turn-shutdown-follow-up', interrupt)
        )
        await onTurnLifecycle?.({
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-shutdown-follow-up',
          turnId: 'turn-shutdown-follow-up'
        })
        abortSignal.addEventListener('abort', () => released.resolve(), { once: true })
        entered.resolve()
        return { toUIMessageStream: () => waitThenEnd(released.promise) }
      }
    })

    const running = service.startChatStream(
      {
        chatId: 'conversation-shutdown-follow-up',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      new FakePort()
    )
    await entered.promise

    const claim = createSteerClaim({
      conversationKey: 'conversation-shutdown-follow-up',
      item: {
        ...createSteerClaim().item,
        conversationKey: 'conversation-shutdown-follow-up',
        message: {
          ...createSteerClaim().item.message,
          trustedContext: {
            ...createSteerClaim().item.message.trustedContext,
            conversationId: 'conversation-shutdown-follow-up'
          }
        }
      }
    })
    await service.steerClaimedFollowUp(claim, {
      id: claim.item.id,
      role: 'user',
      parts: [{ type: 'text', text: 'change direction' }]
    })

    const steerTimer = scheduled.find(({ timeoutMs }) => timeoutMs === 30_000)
    expect(steerTimer).toBeDefined()
    const stopping = service.stop()
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledTimes(1))
    const shutdownTimer = scheduled.find(({ timeoutMs }) => timeoutMs === 1)
    expect(shutdownTimer).toBeDefined()
    shutdownTimer?.callback()

    await Promise.all([running, stopping])

    expect(failClaim).toHaveBeenCalledWith(
      'conversation-shutdown-follow-up',
      claim.item.id,
      claim.leaseToken,
      expect.objectContaining({ kind: 'recovery-uncertain', status: 'paused-recovery-uncertain' })
    )
    expect(clearScheduledTimeout).toHaveBeenCalledWith(steerTimer?.timer)
    expect(service.isConversationRunning('conversation-shutdown-follow-up')).toBe(false)
  })

  it('passes the live-agent lifecycle observer into the active stream call', async () => {
    const port = new FakePort()
    const onAgentLifecycle = vi.fn()
    let observedCallback: unknown
    const service = new CodexChatRuntimeService({
      cwd: '/repo',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      onAgentLifecycle,
      streamText: async (input) => {
        observedCallback = input.onAgentLifecycle
        return { toUIMessageStream: () => emptyUiMessageStream() }
      }
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test'
      },
      port
    )

    expect(observedCallback).toBe(onAgentLifecycle)
  })
})
