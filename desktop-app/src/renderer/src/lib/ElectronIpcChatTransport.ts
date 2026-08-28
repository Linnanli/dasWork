import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

import type {
  ApprovalModeKind,
  ComposerModeKind,
  CodexChatStreamError,
  CodexTurnLifecycleEvent,
  DesktopCodexChatApi,
  Personality,
  ReasoningEffort,
  ThreadGoalSummary
} from '../../../shared/codexIpcApi'
import { isReasoningEffort } from '../../../shared/codexIpcApi'
import type { ProjectSelection } from '../../../shared/projects/projectTypes'

export type { CodexChatStreamError } from '../../../shared/codexIpcApi'

export type ActiveConversationContext = {
  conversationId: string
  threadId?: string
  title?: string | null
  projectSelection?: ProjectSelection
  cwd?: string | null
}

export type ElectronIpcChatTransportOptions = {
  chatBridge: DesktopCodexChatApi
  getActiveConversation?: () => ActiveConversationContext | undefined
  getProjectSelection?: () => ProjectSelection | undefined
  getComposerModeKind?: () => ComposerModeKind
  getApprovalModeKind?: () => ApprovalModeKind | string | undefined
  getPersonality?: () => Personality | string | undefined
  getReasoningEffort?: () => ReasoningEffort | string | undefined
  getGoalEditorActive?: () => boolean
  /** Current Goal editor text, used only for a typed existing-thread control stream. */
  getGoalEditorObjective?: () => string | undefined
  getConversationRevision?: () => number
  getSelectedModelId: () => string | undefined
  onStreamStarted?: () => void
  onThreadBound?: (context: StreamFinishedContext & { threadId: string }) => void
  onTurnLifecycle?: (event: CodexTurnLifecycleEvent) => void
  onModeApplied?: (threadId: string, modeKind: ComposerModeKind) => void
  onThreadGoal?: (threadId: string, goal: ThreadGoalSummary | null) => void
  onStreamAccepted?: () => void
  onStreamAborted?: () => void
  onStreamError?: (error: CodexChatStreamError) => void
  onStreamFinished?: (context: StreamFinishedContext) => void
}

export type StreamFinishedContext = {
  chatId: string
  threadId: string | undefined
  activeConversation: ActiveConversationContext | undefined
  projectSelection: ProjectSelection | undefined
  conversationRevision: number
  startsFreshTerminalRetry?: true
}

type TrustedRequestContext = {
  body: Record<string, unknown> | undefined
  activeConversation: ActiveConversationContext | undefined
  projectSelection: ProjectSelection | undefined
  conversationRevision: number
}

const APPROVAL_MODE_KINDS = ['request-approval', 'approve-for-me', 'full-access'] as const
const DEFAULT_APPROVAL_MODE_KIND = 'request-approval'
const PERSONALITIES = ['none', 'friendly', 'pragmatic'] as const
const DEFAULT_PERSONALITY = 'none'
export class ElectronIpcChatTransport implements ChatTransport<UIMessage> {
  private readonly chatBridge: DesktopCodexChatApi
  private readonly getActiveConversation: () => ActiveConversationContext | undefined
  private readonly getProjectSelection: () => ProjectSelection | undefined
  private readonly getComposerModeKind: () => ComposerModeKind
  private readonly getApprovalModeKind: () => ApprovalModeKind | string | undefined
  private readonly getPersonality: () => Personality | string | undefined
  private readonly getReasoningEffort: () => ReasoningEffort | string | undefined
  private readonly getGoalEditorActive: () => boolean
  private readonly getGoalEditorObjective: () => string | undefined
  private readonly getConversationRevision: () => number
  private readonly getSelectedModelId: () => string | undefined
  private readonly onStreamStarted: (() => void) | undefined
  private readonly onThreadBound:
    | ((context: StreamFinishedContext & { threadId: string }) => void)
    | undefined
  private readonly onTurnLifecycle: ((event: CodexTurnLifecycleEvent) => void) | undefined
  private readonly onModeApplied:
    | ((threadId: string, modeKind: ComposerModeKind) => void)
    | undefined
  private readonly onThreadGoal:
    | ((threadId: string, goal: ThreadGoalSummary | null) => void)
    | undefined
  private readonly onStreamAccepted: (() => void) | undefined
  private readonly onStreamAborted: (() => void) | undefined
  private readonly onStreamError: ((error: CodexChatStreamError) => void) | undefined
  private readonly onStreamFinished: ((context: StreamFinishedContext) => void) | undefined

  constructor(options: ElectronIpcChatTransportOptions) {
    this.chatBridge = options.chatBridge
    this.getActiveConversation = options.getActiveConversation ?? (() => undefined)
    this.getProjectSelection = options.getProjectSelection ?? (() => undefined)
    this.getComposerModeKind = options.getComposerModeKind ?? (() => 'default')
    this.getApprovalModeKind = options.getApprovalModeKind ?? (() => DEFAULT_APPROVAL_MODE_KIND)
    this.getPersonality = options.getPersonality ?? (() => DEFAULT_PERSONALITY)
    this.getReasoningEffort = options.getReasoningEffort ?? (() => undefined)
    this.getGoalEditorActive = options.getGoalEditorActive ?? (() => false)
    this.getGoalEditorObjective = options.getGoalEditorObjective ?? (() => undefined)
    this.getConversationRevision = options.getConversationRevision ?? (() => 0)
    this.getSelectedModelId = options.getSelectedModelId
    this.onStreamStarted = options.onStreamStarted
    this.onThreadBound = options.onThreadBound
    this.onTurnLifecycle = options.onTurnLifecycle
    this.onModeApplied = options.onModeApplied
    this.onThreadGoal = options.onThreadGoal
    this.onStreamAccepted = options.onStreamAccepted
    this.onStreamAborted = options.onStreamAborted
    this.onStreamError = options.onStreamError
    this.onStreamFinished = options.onStreamFinished
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
  ): Promise<ReadableStream<UIMessageChunk>> {
    let streamId: string | undefined
    let settled = false
    let accepted = false
    let detachAbortListener = (): void => undefined

    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        const trustedContext = this.createTrustedContext(
          options.body,
          options.messages,
          options.trigger
        )
        const startsFreshTerminalRetry = trustedContext.body?.retryTerminalTurn === true
        const abortSignal = options.abortSignal
        const streamContext = (threadId: string | undefined): StreamFinishedContext => ({
          chatId: options.chatId,
          threadId,
          activeConversation: trustedContext.activeConversation,
          projectSelection: trustedContext.projectSelection,
          conversationRevision: trustedContext.conversationRevision,
          ...(startsFreshTerminalRetry ? { startsFreshTerminalRetry: true } : {})
        })
        const markAccepted = (): void => {
          if (accepted) return
          accepted = true
          this.onStreamAccepted?.()
        }
        const handleAbortSignal = (): void => {
          if (streamId) this.chatBridge.abortChatStream(streamId)
        }
        const removeAbortListener = (): void => {
          abortSignal?.removeEventListener('abort', handleAbortSignal)
        }
        detachAbortListener = removeAbortListener
        const closeStream = (): void => {
          if (settled) return
          settled = true
          removeAbortListener()
          controller.close()
        }
        const errorStream = (error: CodexChatStreamError): void => {
          if (settled) return
          settled = true
          removeAbortListener()
          this.onStreamError?.(error)
          controller.error(new Error(streamErrorMessage(error)))
        }

        this.onStreamStarted?.()
        streamId = this.chatBridge.startChatStream(
          {
            chatId: options.chatId,
            trigger: options.trigger,
            messageId: options.messageId,
            messages: options.messages,
            modelId: this.getSelectedModelId(),
            metadata: options.metadata,
            body: trustedContext.body
          },
          {
            onTurnLifecycle: (event) => {
              if (settled) return
              markAccepted()
              this.onTurnLifecycle?.(event)
            },
            onModeApplied: (threadId, modeKind) => {
              if (settled) return
              markAccepted()
              this.onModeApplied?.(threadId, modeKind)
            },
            onThreadGoal: (threadId, goal) => {
              if (settled) return
              markAccepted()
              this.onThreadGoal?.(threadId, goal)
            },
            onThreadBound: (threadId) => {
              if (settled) return
              markAccepted()
              this.onThreadBound?.({ ...streamContext(threadId), threadId })
            },
            onChunk: (chunk) => {
              if (settled) return
              markAccepted()
              controller.enqueue(chunk)
            },
            onFinish: (threadId) => {
              if (settled) return
              markAccepted()
              this.onStreamFinished?.(streamContext(threadId))
              closeStream()
            },
            onAbort: () => {
              if (settled) return
              markAccepted()
              this.onStreamAborted?.()
              closeStream()
            },
            onError: errorStream
          }
        )
        abortSignal?.addEventListener('abort', handleAbortSignal, { once: true })
        if (abortSignal?.aborted) handleAbortSignal()
      },
      cancel: () => {
        settled = true
        detachAbortListener()
        // A ReadableStream consumer can disappear during a renderer reload or
        // navigation. That only detaches this renderer subscription; it is
        // not a user request to interrupt the authoritative app-server turn.
      }
    })
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0]
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const context = this.getActiveConversation()
    const conversationId = context?.threadId ?? context?.conversationId ?? options.chatId
    if (!this.chatBridge.attachChatStream) return null
    let settled = false
    let accepted = false
    const streamContext = (threadId: string | undefined): StreamFinishedContext => ({
      chatId: options.chatId,
      threadId,
      activeConversation: context,
      projectSelection: context?.projectSelection ?? this.getProjectSelection(),
      conversationRevision: this.getConversationRevision()
    })
    const markAccepted = (): void => {
      if (accepted) return
      accepted = true
      this.onStreamAccepted?.()
    }
    let streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined
    const close = (): void => {
      if (settled) return
      settled = true
      streamController?.close()
    }
    const fail = (error: CodexChatStreamError): void => {
      if (settled) return
      settled = true
      this.onStreamError?.(error)
      // Replay can enqueue historical chunks immediately before the terminal
      // error. Erroring a ReadableStream discards those queued chunks, so close
      // normally and let the transcript controller mark the recovered turn as
      // failed after it has consumed the replay.
      streamController?.close()
    }
    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        streamController = controller
      },
      cancel: () => {
        settled = true
        // Cancelling a resumed renderer stream only detaches its subscription.
      }
    })
    const failBeforeReturn = (error: unknown): ReadableStream<UIMessageChunk> => {
      const recoveryError = streamErrorFromUnknown(error)
      fail(recoveryError)
      return stream
    }
    try {
      const attachedStreamId = await this.chatBridge.attachChatStream!(conversationId, {
        onTurnLifecycle: (event) => {
          if (settled) return
          markAccepted()
          this.onTurnLifecycle?.(event)
        },
        onModeApplied: (threadId, modeKind) => {
          if (settled) return
          markAccepted()
          this.onModeApplied?.(threadId, modeKind)
        },
        onThreadGoal: (threadId, goal) => {
          if (settled) return
          markAccepted()
          this.onThreadGoal?.(threadId, goal)
        },
        onThreadBound: (threadId) => {
          if (settled) return
          markAccepted()
          this.onThreadBound?.({ ...streamContext(threadId), threadId })
        },
        onChunk: (chunk) => {
          if (settled) return
          markAccepted()
          streamController?.enqueue(chunk)
        },
        onFinish: (threadId) => {
          if (settled) return
          markAccepted()
          this.onStreamFinished?.(streamContext(threadId))
          close()
        },
        onAbort: () => {
          if (settled) return
          markAccepted()
          this.onStreamAborted?.()
          close()
        },
        onError: fail
      })
      if (!attachedStreamId) {
        close()
        return null
      }
      return stream
    } catch (error) {
      return failBeforeReturn(error)
    }
  }

  private createTrustedContext(
    body: unknown,
    messages: readonly UIMessage[],
    trigger: string | undefined
  ): TrustedRequestContext {
    const trustedBody = stripRendererExecutionHints(body)
    const activeConversation = this.getActiveConversation()
    const projectSelection = activeConversation?.projectSelection ?? this.getProjectSelection()
    trustedBody.composerModeKind = this.getComposerModeKind()
    trustedBody.approvalModeKind = normalizeApprovalModeKind(this.getApprovalModeKind())
    trustedBody.personality = normalizePersonality(this.getPersonality())
    const reasoningEffort = normalizeReasoningEffort(this.getReasoningEffort())
    if (reasoningEffort) trustedBody.reasoningEffort = reasoningEffort
    if (this.getGoalEditorActive()) {
      if (activeConversation?.threadId && trigger === 'goal-control') {
        const objective = this.getGoalEditorObjective()?.trim()
        if (objective) trustedBody.threadGoalControl = { objective }
      } else {
        const objective = latestUserMessageText(messages)
        if (objective) trustedBody.threadGoalDraft = { objective }
      }
    }
    if (projectSelection) trustedBody.projectSelection = projectSelection
    if (activeConversation) {
      trustedBody.conversationId = activeConversation.conversationId
      if (activeConversation.threadId) trustedBody.threadId = activeConversation.threadId
    }
    return {
      body: Object.keys(trustedBody).length > 0 ? trustedBody : undefined,
      activeConversation,
      projectSelection,
      conversationRevision: this.getConversationRevision()
    }
  }
}

function streamErrorFromUnknown(error: unknown): CodexChatStreamError {
  if (isRecoveryFailure(error)) return error
  // Errors thrown while establishing an IPC recovery stream are not an
  // app-server terminal and can include Electron's raw remote error text.
  // Do not surface that untrusted detail to the renderer.
  return {
    code: 'unknown-recovery',
    message: '任务连接已中断，无法自动恢复。'
  }
}

function streamErrorMessage(error: CodexChatStreamError): string {
  if (typeof error === 'string') return error
  return typeof error.message === 'string' && error.message.length > 0
    ? error.message
    : '模型响应未完成，请重试。'
}

function isRecoveryFailure(error: unknown): error is Exclude<CodexChatStreamError, string> {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error &&
    (error as { code?: unknown }).code !== undefined &&
    [
      'transport-unavailable',
      'run-unavailable',
      'run-mismatch',
      'journal-unavailable',
      'unknown-recovery'
    ].includes(
      (error as { code: string }).code
    ) &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}

function stripRendererExecutionHints(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const {
    approvalMode: _approvalMode,
    approvalModeKind: _approvalModeKind,
    personality: _personality,
    approvalPolicy: _approvalPolicy,
    approvalsReviewer: _approvalsReviewer,
    cwd: _cwd,
    runtimeWorkspaceRoots: _runtimeWorkspaceRoots,
    sandbox: _sandbox,
    sandboxPolicy: _sandboxPolicy,
    conversationId: _conversationId,
    threadId: _threadId,
    projectSelection: _projectSelection,
    composerModeKind: _composerModeKind,
    reasoningEffort: _reasoningEffort,
    threadGoalDraft: _threadGoalDraft,
    threadGoalControl: _threadGoalControl,
    collaborationMode: _collaborationMode,
    ...trustedBody
  } = body as Record<string, unknown>
  void _approvalMode
  void _approvalModeKind
  void _personality
  void _approvalPolicy
  void _approvalsReviewer
  void _cwd
  void _runtimeWorkspaceRoots
  void _sandbox
  void _sandboxPolicy
  void _conversationId
  void _threadId
  void _projectSelection
  void _composerModeKind
  void _reasoningEffort
  void _threadGoalDraft
  void _threadGoalControl
  void _collaborationMode
  return trustedBody
}

function normalizeApprovalModeKind(value: string | undefined): ApprovalModeKind {
  const modeKind = APPROVAL_MODE_KINDS.find((candidate) => candidate === value)
  if (modeKind) return modeKind
  return DEFAULT_APPROVAL_MODE_KIND
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined
}

function normalizePersonality(value: string | undefined): Personality {
  const personality = PERSONALITIES.find((candidate) => candidate === value)
  return personality ?? DEFAULT_PERSONALITY
}

function latestUserMessageText(messages: readonly UIMessage[]): string | undefined {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'user')
  if (!message) return undefined
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')
    .trim()
  return text.length > 0 ? text : undefined
}
