import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { type UIMessage, type UIMessageChunk } from 'ai'
import {
  type CollaborationModeMask,
  type CodexAgentLifecycleEvent,
  type CodexHistoryClient,
  type CodexExistingTurnRecoveryState,
  type CollaborationMode
} from '@dascowork/codex-app-server-client'

import { CodexApprovalBroker, type CodexApprovalRequestInput } from './codexApprovalBroker'
import {
  resolveCodexAppServerLaunchOptions,
  type CodexAppServerLaunchOptions
} from './codexAppServerLaunch'
import {
  createNativeCodexRunDriver,
  type CodexRunApprovalHandlers,
  type CodexRunApprovalSettings,
  type CodexRunDriver,
  type CodexRunDriverResult,
  type CodexRunSession
} from './codexRun/CodexRunDriver'
import { HostCodexConnection } from './codexRun/HostCodexConnection'
import type { ThreadTerminalReader } from './terminal/readThreadTerminalTool'
import type { ModelCatalogService } from './modelCatalogService'
import type { ProjectStoreLike, ProjectServiceLike } from './threads/startConversation'
import {
  persistProjectAssignmentForThread,
  startConversation,
  type ConversationExecutionTarget
} from './threads/startConversation'
import type {
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexChatRequest,
  CodexChatAttachResult,
  ApprovalModeKind,
  CodexChatRecoverySnapshot,
  CodexChatRunDescriptor,
  CodexChatStreamEnvelope,
  CodexChatStreamError,
  CodexChatStreamEvent,
  CodexChatTerminalEvent,
  ComposerModeKind,
  CodexTurnLifecycleEvent,
  CodexModel,
  CodexModelList,
  CodexStatus,
  ThreadGoalSummary
} from '../shared/codexIpcApi'
import type { ThreadProjectAssignment } from '../shared/projects/projectTypes'
import type { LocalGitTarget } from '../shared/localGitApi'
import { selectUniqueLegacyCandidate } from '../shared/uniqueLegacyCandidate'
import { extractVisibleUserRequest } from '../shared/userRequestEnvelope'
import { readCodexMessageMetadata } from '../shared/codexMessageMetadata'
import { restoreLocalMediaFileUrlsForModel } from './conversations/localMediaUrls'
import { composeCodexDesktopInstructions } from './developerInstructions/composeCodexDesktopInstructions'
import { DesktopHostCapabilityRuntime } from './appTools/DesktopHostCapabilityRuntime'
import type { TurnDiffStoreWriter } from './conversations/TurnDiffStore'
import { validateLocalAttachmentsInLatestUserMessage } from './composerContext/localAttachmentValidation'
import {
  ConversationFollowUpQueueService,
  type FollowUpClaim,
  type FollowUpClaimFailure
} from './followUps/ConversationFollowUpQueueService'

type McpElicitationResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content: unknown
  _meta: unknown
}

type CodexTurnDiffUpdatedEvent = {
  threadId: string
  turnId: string
  diff: string
}

type CodexThreadGoalUpdatedEvent = {
  threadId: string
  goal: ThreadGoalSummary | null
}

type CodexThreadSettingsUpdatedEvent = {
  threadId: string
  modeKind: 'default' | 'plan'
}

export type CodexSteerResult = { turnId: string }

type CodexSteerErrorCode =
  | 'session_inactive'
  | 'steer_result_unknown'
  | 'expected_turn_mismatch'
  | 'unsupported_active_turn_kind'
  | 'attachment_resolution_failed'
  | 'app_server_rejected'

export class CodexSteerError extends Error {
  constructor(
    readonly code: CodexSteerErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CodexSteerError'
  }
}

export type CodexPortLike = {
  postMessage(message: CodexChatStreamEnvelope | CodexChatStreamEvent): void
  on(event: 'message', handler: (event: { data: unknown }) => void): void
  start(): void
  close(): void
}

// A narrow test seam; production always binds the fully typed native driver.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Existing runtime tests deliberately substitute partial drivers.
type RunDriverLike = (input: any) => Promise<CodexRunDriverResult> | CodexRunDriverResult

type ActiveConversationRun = {
  runId: string
  conversationId: string
  baseMessages: readonly UIMessage[]
  runKind: 'single-turn' | 'goal'
  threadId?: string
  turnId?: string
  existingTurnRecoveryState?: CodexExistingTurnRecoveryState
  transportRecoveryAttempted: boolean
  turnOutcome?: Extract<CodexTurnLifecycleEvent, { type: 'turn-completed' }>['outcome']
  canonicalOutcomeSource?: 'notification' | 'history-reconciliation'
  session?: CodexRunSession
  initialThreadGoalApplied?: boolean
  goalReachedTerminalStatus?: boolean
  lastCompletedGoalOutcome?: Extract<CodexTurnLifecycleEvent, { type: 'turn-completed' }>['outcome']
  abortController: AbortController
  subscribers: Map<string, CodexPortLike>
  eventJournal: CodexChatStreamEnvelope[]
  eventJournalBytes: number
  journalReplayUnavailable: boolean
  lastEventSequence: number
  terminalDelivered: boolean
  stopRequested: boolean
  stopRequestedAt?: number
  interruptReason?: ConversationInterruptReason
  approvalSettlementPromise?: Promise<void>
  interruptPromise?: Promise<void>
  turnInactivityTimer?: ReturnType<typeof setTimeout>
  turnInactivityTurnId?: string
  canonicalOutcomeTimer?: ReturnType<typeof setTimeout>
  canonicalResolutionError?: string
  canonicalFailureMessage?: string
  followUpClaim?: FollowUpClaim
  followUpCompareKey?: string
  followUpAccepted: boolean
  followUpSettlement?: Promise<void>
  pendingSteerClaims: Map<string, PendingSteerClaim>
  approvalRequestIds: Set<string>
  lastLifecycleSequence?: number
  latestTurnDiff?: CodexTurnDiffUpdatedEvent
  lifecycleSettlement: Promise<void>
  streamSettled: Promise<void>
  resolveStreamSettled: () => void
  settlementBlockedEvent?: CodexChatStreamEvent
  handlePortControl?: (message: unknown) => void
  terminalRetentionTimer?: ReturnType<typeof setTimeout>
}

type ConversationInterruptReason = 'user-stop' | 'turn-inactivity-timeout'

type PendingSteerClaim = {
  claim: FollowUpClaim
  targetTurnId: string
  compareKey?: string
  requestSettled: boolean
  terminalSettled: boolean
  terminalEvent?: CodexChatStreamEvent
  accepted: boolean
  settlement?: Promise<void>
  confirmationTimer?: ReturnType<typeof setTimeout>
}

type PendingThreadBindingAcknowledgement = {
  threadId: string
  resolve: () => void
}

const threadBindingAcknowledgementTimeoutMs = 1_000
const maxReplayJournalEvents = 20_000
const maxReplayJournalBytes = 8 * 1024 * 1024
const terminalReplayRetentionMs = 5 * 60 * 1_000
const defaultSteerConfirmationTimeoutMs = 30_000
const defaultTurnInactivityTimeoutMs = 2 * 60 * 1_000
const defaultCanonicalOutcomeTimeoutMs = 10_000
const defaultShutdownTimeoutMs = 10_000
const unknownStopOutcomeError = '停止结果无法确认，请重新打开任务检查状态'
const canonicalFailureError = '模型响应未完成，请重试。'
const turnInactivityTimeoutError = '模型长时间没有活动，已停止本次请求。请重试或切换模型。'

type ApprovalSettings = CodexRunApprovalSettings

export type ModelCatalogLike = Pick<
  ModelCatalogService,
  'listModels' | 'setSelectedModel' | 'resolveClientModel'
>

export type CodexChatRuntimeServiceOptions = {
  cwd?: string
  defaultModel?: string
  launch?: CodexAppServerLaunchOptions
  hostConnection?: HostCodexConnection
  modelCatalog?: ModelCatalogLike
  projectService?: ProjectServiceLike
  projectStore?: ProjectStoreLike
  runDriver?: RunDriverLike
  onAgentLifecycle?: (event: CodexAgentLifecycleEvent) => void | Promise<void>
  onThreadBound?: (conversationId: string, threadId: string) => void | Promise<void>
  readThreadTerminal?: ThreadTerminalReader
  hostCapabilities?: DesktopHostCapabilityRuntime
  onTurnCompleted?: () => void
  followUpQueue?: ConversationFollowUpQueueService
  steerConfirmationTimeoutMs?: number
  turnInactivityTimeoutMs?: number
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>
  clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void
  canonicalOutcomeTimeoutMs?: number
  shutdownTimeoutMs?: number
  readCanonicalTurnOutcome?: (
    threadId: string,
    turnId: string
  ) => Promise<'completed' | 'interrupted' | 'failed' | undefined>
  collaborationModeClient?: Pick<CodexHistoryClient, 'listCollaborationModes'>
  turnDiffStore?: TurnDiffStoreWriter
  restoreArtifactAttachments?: (messages: readonly UIMessage[]) => Promise<UIMessage[]>
}

export type CodexChatRunResult = {
  threadId?: string
}

export type StartedConversationThread = {
  threadId: string
  originConversationId: string
  title?: string | null
  cwd?: string | null
  createdAt?: string
  updatedAt?: string
  projectAssignment?: ThreadProjectAssignment
}

export type StartChatStreamCallbacks = {
  onThreadIdAvailable?: (
    threadId: string,
    thread?: StartedConversationThread
  ) => void | Promise<void>
  onTerminal?: (terminal: CodexChatTerminalEvent) => void
}

export class CodexChatRuntimeService {
  private readonly approvalBroker = new CodexApprovalBroker()
  private readonly cwd: string
  private readonly launch: CodexAppServerLaunchOptions
  private readonly modelCatalog: ModelCatalogLike | undefined
  private readonly projectService: ProjectServiceLike | undefined
  private readonly projectStore: ProjectStoreLike | undefined
  private readonly runDriver: RunDriverLike
  private readonly nativeDriver: CodexRunDriver
  private readonly onAgentLifecycle:
    | ((event: CodexAgentLifecycleEvent) => void | Promise<void>)
    | undefined
  private readonly onThreadBound:
    | ((conversationId: string, threadId: string) => void | Promise<void>)
    | undefined
  private readonly onTurnCompleted: (() => void) | undefined
  private readonly followUpQueue: ConversationFollowUpQueueService | undefined
  private readonly steerConfirmationTimeoutMs: number
  private readonly turnInactivityTimeoutMs: number
  private readonly scheduleTimeout: (
    callback: () => void,
    timeoutMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearScheduledTimeout: (timer: ReturnType<typeof setTimeout>) => void
  private readonly canonicalOutcomeTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly readCanonicalTurnOutcome: (
    threadId: string,
    turnId: string
  ) => Promise<'completed' | 'interrupted' | 'failed' | undefined>
  private readonly turnDiffStore: TurnDiffStoreWriter | undefined
  private readonly restoreArtifactAttachments: (
    messages: readonly UIMessage[]
  ) => Promise<UIMessage[]>
  private readonly hostCapabilities: DesktopHostCapabilityRuntime
  private readonly collaborationModeClient:
    | Pick<CodexHistoryClient, 'listCollaborationModes'>
    | undefined
  private collaborationModeMasks: readonly CollaborationModeMask[] | undefined
  private collaborationModeMasksPromise:
    | Promise<readonly CollaborationModeMask[] | undefined>
    | undefined
  private readonly activeConversationRuns = new Map<string, ActiveConversationRun>()
  private readonly recentTerminalRuns = new Map<string, ActiveConversationRun>()
  private acceptingStartAdmissions = true
  private pendingStartAdmissions = 0
  private startAdmissionDrain: Promise<void> = Promise.resolve()
  private resolveStartAdmissionDrain: (() => void) | undefined
  private stopPromise: Promise<void> | undefined
  private selectedModelId: string | undefined
  private status: CodexStatus

  constructor(options: CodexChatRuntimeServiceOptions = {}) {
    this.cwd = options.cwd ?? app.getAppPath()
    this.launch = options.launch ?? resolveCodexAppServerLaunchOptions({ env: process.env })
    this.nativeDriver = createNativeCodexRunDriver(this.launch, options.hostConnection)
    this.runDriver = options.runDriver ?? this.nativeDriver.start.bind(this.nativeDriver)
    this.onAgentLifecycle = options.onAgentLifecycle
    this.onThreadBound = options.onThreadBound
    this.onTurnCompleted = options.onTurnCompleted
    this.followUpQueue = options.followUpQueue
    this.steerConfirmationTimeoutMs = Math.max(
      0,
      options.steerConfirmationTimeoutMs ?? defaultSteerConfirmationTimeoutMs
    )
    this.turnInactivityTimeoutMs = Math.max(
      0,
      options.turnInactivityTimeoutMs ?? defaultTurnInactivityTimeoutMs
    )
    this.scheduleTimeout = options.scheduleTimeout ?? setTimeout
    this.clearScheduledTimeout = options.clearScheduledTimeout ?? clearTimeout
    this.canonicalOutcomeTimeoutMs = Math.max(
      0,
      options.canonicalOutcomeTimeoutMs ?? defaultCanonicalOutcomeTimeoutMs
    )
    this.shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? defaultShutdownTimeoutMs)
    this.modelCatalog = options.modelCatalog
    this.projectService = options.projectService
    this.projectStore = options.projectStore
    this.turnDiffStore = options.turnDiffStore
    this.restoreArtifactAttachments =
      options.restoreArtifactAttachments ?? (async (messages) => [...messages])
    this.hostCapabilities =
      options.hostCapabilities ??
      new DesktopHostCapabilityRuntime({ readThreadTerminal: options.readThreadTerminal })
    this.collaborationModeClient = options.collaborationModeClient
    this.readCanonicalTurnOutcome =
      options.readCanonicalTurnOutcome ??
      ((threadId, turnId) =>
        options.hostConnection
          ? options.hostConnection.readTurnOutcome(threadId, turnId)
          : readTurnOutcomeFromHistory(undefined, threadId, turnId))
    this.status = {
      state: 'stopped',
      binary: this.launch.displayBinary
    }
  }

  getStatus(): CodexStatus {
    return { ...this.status }
  }

  onApprovalRequest(listener: (request: CodexApprovalRequest) => void): () => void {
    return this.approvalBroker.onRequest(listener)
  }

  onApprovalSettled(listener: (requestId: string) => void): () => void {
    return this.approvalBroker.onSettled(listener)
  }

  listPendingApprovals(): CodexApprovalRequest[] {
    return this.approvalBroker.listPendingApprovals()
  }

  respondApproval(requestId: string, response: CodexApprovalResponse): Promise<void> {
    return this.approvalBroker.respond(requestId, response)
  }

  snoozeApprovalAutoResolution(requestId: string): boolean {
    return this.approvalBroker.snoozeAutoResolution(requestId)
  }

  async listModels(): Promise<CodexModelList> {
    if (this.modelCatalog) {
      try {
        const list = await this.modelCatalog.listModels()
        if (list.models.length > 0) {
          this.selectedModelId = list.selectedModelId
        }
        return list
      } catch (error) {
        return { models: [], unavailableReason: errorMessage(error) }
      }
    }

    return this.listNativeModels()
  }

  private async listNativeModels(unavailableReason?: string): Promise<CodexModelList> {
    try {
      const models = await this.nativeDriver.listModels()
      const mapped = models.map<CodexModel>((model) => ({
        id: model.id,
        displayName: model.displayName || model.model || model.id,
        description: model.description || undefined,
        inputModalities: model.inputModalities ?? [],
        isDefault: Boolean(model.isDefault)
      }))
      const selectedModelId =
        this.selectedModelId ?? mapped.find((model) => model.isDefault)?.id ?? mapped[0]?.id
      this.selectedModelId = selectedModelId
      return { models: mapped, selectedModelId }
    } catch (error) {
      return { models: [], unavailableReason: unavailableReason ?? errorMessage(error) }
    }
  }

  async setSelectedModel(modelId: string): Promise<{ selectedModelId: string }> {
    if (!modelId.trim()) throw new Error('modelId is required')
    if (this.modelCatalog) {
      const response = await this.modelCatalog.setSelectedModel(modelId)
      this.selectedModelId = response.selectedModelId
      return response
    }

    this.selectedModelId = modelId
    return { selectedModelId: modelId }
  }

  private async resolveCollaborationMode(
    mode: ComposerModeKind,
    model: string
  ): Promise<CollaborationMode> {
    const masks = await this.loadCollaborationModeMasks()
    const preset = masks?.find((candidate) => candidate.mode === mode)
    if (mode === 'plan' && masks && !preset) {
      throw new Error('当前 Codex 服务不支持计划模式')
    }
    return collaborationModeForComposerMode(
      mode,
      preset?.model ?? model,
      preset?.reasoning_effort ?? null
    )
  }

  private async loadCollaborationModeMasks(): Promise<
    readonly CollaborationModeMask[] | undefined
  > {
    if (this.collaborationModeMasks) return this.collaborationModeMasks
    if (!this.collaborationModeClient) return undefined
    this.collaborationModeMasksPromise ??= this.collaborationModeClient
      .listCollaborationModes()
      .then((masks) => {
        this.collaborationModeMasks = masks
        return masks
      })
      .catch((error) => {
        // Older app-server builds may not expose the catalog. Keep the
        // explicit Default/Plan packet fallback for compatibility, while a
        // successful catalog response remains authoritative when available.
        console.warn('failed to load collaboration mode presets', error)
        return undefined
      })
    return this.collaborationModeMasksPromise
  }

  async generateCommitMessage(input: {
    target: LocalGitTarget
    changeSummary: string
  }): Promise<string> {
    const modelList = await this.listModels()
    const modelId = this.selectedModelId ?? modelList.selectedModelId
    if (!modelId) throw new Error('No Codex model selected for commit message generation.')

    const clientModel = this.modelCatalog
      ? await this.modelCatalog.resolveClientModel(modelId)
      : undefined
    const executionTarget = await this.resolveCommitMessageExecutionTarget(input.target)
    const messageId = `commit-message:${randomUUID()}`
    const request: CodexChatRequest = {
      chatId: messageId,
      trigger: 'submit-message',
      messageId,
      messages: [
        {
          id: messageId,
          role: 'user',
          parts: [
            {
              type: 'text',
              text: [
                'Generate one concise Git commit subject for the following local changes.',
                'Return only the subject line: no markdown, quotes, explanations, or tool calls.',
                'Use imperative wording and keep it under 72 characters.',
                '',
                input.changeSummary
              ].join('\n')
            }
          ]
        }
      ],
      body: {
        system:
          'You generate a single Git commit subject from supplied change summaries. Do not use tools. Output only the subject line.'
      }
    }
    const result = await this.runDriver({
      request,
      modelId: clientModel?.model_id ?? modelId,
      abortSignal: new AbortController().signal,
      clientModel,
      executionTarget,
      ephemeral: true,
      approvalSettings: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        sandboxPolicy: {}
      }
    })
    let text = ''
    let streamError: string | undefined

    for await (const chunk of result.toUIMessageStream()) {
      if (chunk.type === 'text-delta') text += chunk.delta
      if (chunk.type === 'error') streamError = chunk.errorText
    }

    if (streamError) throw new Error(streamError)
    const subject = text.replace(/\s+/gu, ' ').trim().slice(0, 72)
    if (!subject) throw new Error('Commit message generation returned an empty response.')
    return subject
  }

  async startChatStream(
    request: CodexChatRequest,
    port: CodexPortLike,
    callbacks?: StartChatStreamCallbacks,
    streamId?: string
  ): Promise<CodexChatRunResult> {
    const releaseAdmission = this.acquireStartAdmission()
    if (!releaseAdmission) {
      const terminalEvent: CodexChatTerminalEvent = {
        type: 'error',
        error: 'Codex runtime is stopping'
      }
      port.start()
      port.postMessage(terminalEvent)
      callbacks?.onTerminal?.(terminalEvent)
      port.close()
      return { threadId: request.body?.threadId }
    }

    let effectiveRequest = request
    let claimedFollowUp: FollowUpClaim | undefined
    try {
      await this.recoverBlockedConversationRun(request)
      const prepared = await this.prepareClaimedFollowUp(request)
      effectiveRequest = prepared.request
      claimedFollowUp = prepared.claim
    } catch (error) {
      const terminalEvent: CodexChatTerminalEvent = { type: 'error', error: errorMessage(error) }
      port.start()
      port.postMessage(terminalEvent)
      callbacks?.onTerminal?.(terminalEvent)
      port.close()
      releaseAdmission()
      return { threadId: request.body?.threadId }
    }

    let activeRun: ActiveConversationRun
    let terminalEvent: CodexChatTerminalEvent | undefined
    try {
      activeRun = this.registerActiveConversationRun(effectiveRequest, claimedFollowUp)
      this.attachStreamPort(activeRun, streamId ?? `initial:${activeRun.conversationId}`, port)
    } catch (error) {
      await this.failPreparedFollowUp(claimedFollowUp, error)
      const terminalEvent: CodexChatTerminalEvent = { type: 'error', error: errorMessage(error) }
      port.start()
      port.postMessage(terminalEvent)
      callbacks?.onTerminal?.(terminalEvent)
      port.close()
      releaseAdmission()
      return { threadId: request.body?.threadId }
    }
    releaseAdmission()
    let pendingThreadBindingAcknowledgement: PendingThreadBindingAcknowledgement | undefined
    const waitForThreadBindingAcknowledgement = (threadId: string): Promise<void> =>
      new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (pendingThreadBindingAcknowledgement?.threadId === threadId) {
            pendingThreadBindingAcknowledgement = undefined
          }
          resolve()
        }, threadBindingAcknowledgementTimeoutMs)
        pendingThreadBindingAcknowledgement = {
          threadId,
          resolve: () => {
            clearTimeout(timeout)
            pendingThreadBindingAcknowledgement = undefined
            resolve()
          }
        }
      })
    activeRun.handlePortControl = (message) => {
      if (isAbortMessage(message) && (!message.runId || message.runId === activeRun.runId)) {
        void this.requestConversationInterrupt(activeRun)
        pendingThreadBindingAcknowledgement?.resolve()
        return
      }
      if (
        isThreadBoundAcknowledgement(message) &&
        message.threadId === pendingThreadBindingAcknowledgement?.threadId
      ) {
        pendingThreadBindingAcknowledgement.resolve()
      }
    }
    const bindStreamPortControls = (streamPort: CodexPortLike): void => {
      streamPort.on('message', (event) => activeRun.handlePortControl?.(event.data))
    }
    bindStreamPortControls(port)
    port.start()

    try {
      if (this.status.state === 'stopped') {
        this.status = {
          state: 'starting',
          binary: this.launch.displayBinary
        }
      }
      const modelId = effectiveRequest.modelId ?? this.selectedModelId
      if (!modelId) throw new Error('No Codex model selected')
      const clientModel = this.modelCatalog
        ? await this.modelCatalog.resolveClientModel(modelId)
        : undefined
      const streamModelId = clientModel?.model_id ?? modelId
      const threadGoalDraft = threadGoalDraftFromRequest(effectiveRequest)
      const threadGoalControl = threadGoalControlFromRequest(effectiveRequest)
      const collaborationMode = await this.resolveCollaborationMode(
        effectiveRequest.body?.composerModeKind ?? 'default',
        streamModelId
      )
      const messagesWithResolvedArtifactAttachments = await this.restoreArtifactAttachments(
        effectiveRequest.messages
      )
      const localAttachmentCount = threadGoalControl
        ? 0
        : await validateLocalAttachmentsInLatestUserMessage(messagesWithResolvedArtifactAttachments)
      const conversation = await startConversation({
        request: effectiveRequest,
        projectService: this.projectService
      })
      const approvalSettings = approvalSettingsForMode(
        effectiveRequest.body?.approvalModeKind ?? 'request-approval',
        conversation.executionTarget,
        this.cwd
      )
      if (localAttachmentCount > 0 && conversation.projectAssignment?.projectKind === 'remote') {
        throw new Error('Local attachments are not available for remote execution')
      }
      const projectAssignmentKey = effectiveRequest.body?.conversationId ?? effectiveRequest.chatId
      let normalizedProjectAssignmentThreadId: string | undefined
      let projectAssignmentQueue = Promise.resolve()
      const enqueueProjectAssignmentOperation = (
        label: string,
        operation: () => Promise<void>
      ): Promise<void> => {
        const runOperation = async (): Promise<void> => {
          try {
            await operation()
          } catch (error) {
            console.error(`failed to ${label}`, error)
          }
        }
        projectAssignmentQueue = projectAssignmentQueue.then(runOperation, runOperation)
        return projectAssignmentQueue
      }
      const persistStartedProjectAssignment = (threadId: string): Promise<void> => {
        normalizedProjectAssignmentThreadId = threadId
        return enqueueProjectAssignmentOperation(`persist project assignment for ${threadId}`, () =>
          persistProjectAssignmentForThread({
            projectStore: this.projectStore,
            threadId,
            projectAssignment: conversation.projectAssignment
          })
        )
      }
      const persistOrNormalizeProjectAssignment = (threadId: string): void => {
        const fromId = normalizedProjectAssignmentThreadId ?? projectAssignmentKey
        normalizedProjectAssignmentThreadId = threadId
        enqueueProjectAssignmentOperation(
          `normalize project assignment for ${threadId}`,
          async () => {
            await normalizeProjectAssignmentThreadId({
              projectStore: this.projectStore,
              fromId,
              toId: threadId
            })
            await persistProjectAssignmentForThread({
              projectStore: this.projectStore,
              threadId,
              projectAssignment: conversation.projectAssignment
            })
          }
        )
      }
      const startsFreshTerminalRetry = shouldStartFreshTerminalRetry(effectiveRequest)
      const onThreadStarted =
        effectiveRequest.body?.threadId && !startsFreshTerminalRetry
          ? undefined
          : async (thread: { threadId: string; threadPath?: string }) => {
              const startedAt = new Date().toISOString()
              const startedThread: StartedConversationThread = {
                threadId: thread.threadId,
                originConversationId: activeRun.conversationId,
                title: conversationTitleFromRequest(effectiveRequest),
                cwd: conversation.executionTarget?.cwd ?? null,
                createdAt: startedAt,
                updatedAt: startedAt,
                projectAssignment: conversation.projectAssignment
              }
              const threadIdChanged = this.bindActiveConversationRunAlias(
                activeRun,
                thread.threadId,
                startsFreshTerminalRetry
              )
              if (startsFreshTerminalRetry) persistOrNormalizeProjectAssignment(thread.threadId)
              else await persistStartedProjectAssignment(thread.threadId)
              await this.onThreadBound?.(activeRun.conversationId, thread.threadId)
              await callbacks?.onThreadIdAvailable?.(thread.threadId, startedThread)
              this.migrateActiveFollowUpClaims(activeRun, thread.threadId)
              if (threadIdChanged) {
                if (
                  this.postStreamEvent(activeRun, port, {
                    type: 'thread-bound',
                    threadId: thread.threadId
                  })
                ) {
                  await waitForThreadBindingAcknowledgement(thread.threadId)
                }
              }
            }
      const capabilitySnapshot = await this.hostCapabilities.snapshot({ hostId: 'local' })
      const desktopInstructions = composeCodexDesktopInstructions({
        system: effectiveRequest.body?.system,
        projectAssignment: conversation.projectAssignment,
        capabilities: {
          workspaceDependencies: capabilitySnapshot.availableToolNames.includes(
            'load_workspace_dependencies'
          )
        },
        availableToolNames: capabilitySnapshot.availableToolNames
      })
      const modelInputRequest = {
        ...effectiveRequest,
        ...(desktopInstructions.instructions
          ? {
              body: {
                ...effectiveRequest.body,
                system: desktopInstructions.instructions
              }
            }
          : {}),
        messages: restoreLocalMediaFileUrlsForModel(messagesWithResolvedArtifactAttachments)
      }
      const onTurnLifecycle = (event: CodexTurnLifecycleEvent): Promise<void> => {
        if (activeRun.terminalDelivered) return Promise.resolve()
        activeRun.lifecycleSettlement = activeRun.lifecycleSettlement
          .then(async () => {
            // A resumed app-server connection starts its local lifecycle
            // counter from one again. Preserve ordering across that boundary
            // so the canonical terminal outcome is still accepted.
            const lifecycleEvent =
              activeRun.transportRecoveryAttempted &&
              activeRun.lastLifecycleSequence !== undefined &&
              event.sequence <= activeRun.lastLifecycleSequence
                ? { ...event, sequence: activeRun.lastLifecycleSequence + 1 }
                : event
            if (!this.acceptTurnLifecycle(activeRun, lifecycleEvent)) return
            this.postStreamEvent(activeRun, port, {
              type: 'turn-lifecycle',
              // Failure details remain main-process-only until sanitized for the
              // terminal error; lifecycle notifications only carry state.
              event: turnLifecycleEventForRenderer(lifecycleEvent)
            })
            await this.observeAcceptedTurnLifecycle(activeRun, lifecycleEvent)
          })
          .catch((error) => {
            console.warn('failed to settle turn lifecycle event', error)
          })
        return activeRun.lifecycleSettlement
      }
      const onTurnDiffUpdated = (event: CodexTurnDiffUpdatedEvent): void => {
        if (activeRun.terminalDelivered) return
        if (activeRun.threadId && activeRun.threadId !== event.threadId) return
        if (activeRun.turnId && activeRun.turnId !== event.turnId) return
        activeRun.latestTurnDiff = event
      }
      const onThreadGoalUpdated = (event: CodexThreadGoalUpdatedEvent): void => {
        if (activeRun.terminalDelivered) return
        if (activeRun.threadId && activeRun.threadId !== event.threadId) return
        if (activeRun.runKind === 'goal' && isTerminalGoal(event.goal)) {
          activeRun.goalReachedTerminalStatus = true
          if (activeRun.lastCompletedGoalOutcome) {
            this.setCanonicalOutcome(activeRun, activeRun.lastCompletedGoalOutcome, 'notification')
          }
        }
        this.postStreamEvent(activeRun, port, {
          type: 'thread-goal',
          threadId: event.threadId,
          goal: event.goal as ThreadGoalSummary | null
        })
      }
      const onThreadSettingsUpdated = (event: CodexThreadSettingsUpdatedEvent): void => {
        if (activeRun.terminalDelivered) return
        if (activeRun.threadId && activeRun.threadId !== event.threadId) return
        this.postStreamEvent(activeRun, port, {
          type: 'mode-applied',
          threadId: event.threadId,
          modeKind: event.modeKind
        })
      }
      const startRun = (
        resumeActiveTurn = false
      ): CodexRunDriverResult | Promise<CodexRunDriverResult> =>
        this.runDriver({
          request: modelInputRequest,
          modelId: streamModelId,
          abortSignal: activeRun.abortController.signal,
          clientModel,
          executionTarget: conversation.executionTarget,
          resumeThreadId: startsFreshTerminalRetry ? undefined : activeRun.threadId,
          ...(resumeActiveTurn
            ? {
                resumeActiveTurn: true,
                existingTurnRecoveryState: activeRun.existingTurnRecoveryState
              }
            : {}),
          startFreshTerminalRetry: startsFreshTerminalRetry,
          onThreadStarted,
          onAgentLifecycle: this.onAgentLifecycle,
          onTurnLifecycle,
          onTurnActivity: (event) => this.observeTurnActivity(activeRun, event),
          onTurnDiffUpdated,
          onThreadSettingsUpdated,
          onThreadGoalUpdated,
          collaborationMode,
          approvalSettings,
          ...(threadGoalDraft ? { goalFirstTurnObjective: threadGoalDraft.objective } : {}),
          ...(threadGoalControl ? { goalControlObjective: threadGoalControl.objective } : {}),
          ...(threadGoalDraft || threadGoalControl ? { goalContinuous: true } : {}),
          onExistingTurnRecoveryState: (state) => {
            activeRun.existingTurnRecoveryState = state
          },
          dynamicTools: capabilitySnapshot.dynamicTools,
          threadConfig: capabilitySnapshot.threadConfig,
          onDynamicToolCall: (params) =>
            this.hostCapabilities.dispatch(
              withDynamicToolCallThread(params, activeRun.threadId),
              activeRun.abortController.signal
            ),
          approvals: this.createRunApprovalHandlers(activeRun),
          onSessionCreated: async (session) => {
            if (activeRun.terminalDelivered) return
            activeRun.session = session
            activeRun.turnId = session.turnId ?? activeRun.turnId
            this.bindActiveConversationRunAlias(activeRun, session.threadId)
            const goalObjective = threadGoalDraft?.objective ?? threadGoalControl?.objective
            if (goalObjective && !activeRun.initialThreadGoalApplied) {
              const goal = await session.setThreadGoal({
                objective: goalObjective,
                status: 'active'
              })
              activeRun.initialThreadGoalApplied = true
              onThreadGoalUpdated({ threadId: session.threadId, goal })
            }
            if (activeRun.interruptReason) {
              void this.requestRunInterrupt(activeRun, activeRun.interruptReason)
            }
          }
        })
      let result = await startRun()
      if (this.status.state !== 'stopping') {
        this.status = {
          state: 'ready',
          binary: this.launch.displayBinary,
          startedAt: this.status.startedAt ?? new Date().toISOString()
        }
      }
      let streamFailed = false
      let shouldResumeActiveTurn = false
      do {
        shouldResumeActiveTurn = false
        let runErrorCode: CodexRunRecoveryErrorCode | undefined
        for await (const chunk of result.toUIMessageStream({
          originalMessages: effectiveRequest.messages,
          messageMetadata: ({ part }) =>
            codexTurnDurationMessageMetadata(isRecord(part) ? part['providerMetadata'] : undefined),
          onError: (error) => {
            runErrorCode = codexRunRecoveryErrorCode(error)
            return errorMessage(error)
          }
        })) {
          const threadId = extractCodexThreadId(chunk)
          const turnId = extractCodexTurnId(chunk)
          if (chunk.type === 'error') {
            runErrorCode ??= codexRunRecoveryErrorCode(chunk.errorText)
            if (
              activeRun.transportRecoveryAttempted &&
              runErrorCode === 'active_turn_unavailable'
            ) {
              this.setCanonicalOutcome(activeRun, 'interrupted', 'history-reconciliation')
              break
            }
            if (canResumeActiveTurnAfterTransportError(activeRun, runErrorCode)) {
              activeRun.transportRecoveryAttempted = true
              shouldResumeActiveTurn = true
              break
            }
            this.clearTurnInactivityWatchdog(activeRun)
            streamFailed = true
            terminalEvent = { type: 'error', error: chunk.errorText }
            break
          }
          if (activeRun.interruptReason === 'turn-inactivity-timeout') continue
          let threadIdChanged = false
          if (threadId || turnId) {
            if (activeRun.threadId && threadId && activeRun.threadId !== threadId) {
              throw new Error(
                `Active conversation thread changed from ${activeRun.threadId} to ${threadId}`
              )
            }
            if (
              activeRun.runKind !== 'goal' &&
              activeRun.turnId &&
              turnId &&
              activeRun.turnId !== turnId
            ) {
              continue
            }
            threadIdChanged = Boolean(
              threadId && this.bindActiveConversationRunAlias(activeRun, threadId)
            )
            activeRun.turnId = turnId ?? activeRun.turnId
          }
          if (threadId && normalizedProjectAssignmentThreadId !== threadId) {
            persistOrNormalizeProjectAssignment(threadId)
          }
          if (threadIdChanged) {
            await this.onThreadBound?.(activeRun.conversationId, threadId!)
            await callbacks?.onThreadIdAvailable?.(threadId!)
            if (
              this.postStreamEvent(activeRun, port, { type: 'thread-bound', threadId: threadId! })
            ) {
              await waitForThreadBindingAcknowledgement(threadId!)
            }
          }
          this.postStreamEvent(activeRun, port, { type: 'chunk', chunk })
        }
        if (!shouldResumeActiveTurn) break
        try {
          result = await startRun(true)
        } catch (error) {
          if (codexRunRecoveryErrorCode(error) === 'active_turn_unavailable') {
            this.setCanonicalOutcome(activeRun, 'interrupted', 'history-reconciliation')
          } else {
            streamFailed = true
            terminalEvent = { type: 'error', error: errorMessage(error) }
          }
          shouldResumeActiveTurn = false
        }
      } while (shouldResumeActiveTurn && !streamFailed)
      await projectAssignmentQueue
      await activeRun.lifecycleSettlement
      terminalEvent = this.canonicalTerminalForRun(
        activeRun,
        streamFailed ? terminalEvent : undefined
      )
    } catch (error) {
      this.restoreStatusAfterTurnFailure(activeRun)
      await activeRun.lifecycleSettlement
      terminalEvent = this.canonicalTerminalForRun(activeRun, {
        type: 'error',
        error: errorMessage(error)
      })
    } finally {
      this.clearTurnInactivityWatchdog(activeRun)
      this.clearCanonicalOutcomeTimer(activeRun)
      if (terminalEvent?.type !== 'finish') {
        this.rejectRunApprovals(activeRun, 'The task ended before approval was completed.')
      }
      await activeRun.lifecycleSettlement
      try {
        await this.settleRunFollowUps(activeRun, terminalEvent)
      } catch (error) {
        console.error('failed to durably settle follow-up state before terminal event', error)
        activeRun.settlementBlockedEvent = terminalEvent
        terminalEvent = {
          type: 'error',
          error:
            'The task ended, but follow-up state could not be saved. Retry this conversation to recover it.'
        }
      }
      try {
        if (terminalEvent && !activeRun.terminalDelivered) {
          activeRun.terminalDelivered = true
          this.postStreamEvent(activeRun, port, terminalEvent)
          callbacks?.onTerminal?.(terminalEvent)
        }
      } finally {
        try {
          port.close()
        } finally {
          activeRun.resolveStreamSettled()
          if (!activeRun.settlementBlockedEvent) {
            this.retainTerminalRun(activeRun)
            this.clearActiveConversationRun(activeRun)
          }
        }
      }
    }
    return { threadId: activeRun.threadId }
  }

  private acquireStartAdmission(): (() => void) | undefined {
    if (!this.acceptingStartAdmissions) return undefined

    if (this.pendingStartAdmissions === 0) {
      this.startAdmissionDrain = new Promise((resolve) => {
        this.resolveStartAdmissionDrain = resolve
      })
    }
    this.pendingStartAdmissions += 1

    let released = false
    return () => {
      if (released) return
      released = true
      this.pendingStartAdmissions -= 1
      if (this.pendingStartAdmissions === 0) {
        this.resolveStartAdmissionDrain?.()
        this.resolveStartAdmissionDrain = undefined
      }
    }
  }

  private closeStartAdmissions(): Promise<void> {
    this.acceptingStartAdmissions = false
    return this.pendingStartAdmissions === 0 ? Promise.resolve() : this.startAdmissionDrain
  }

  interruptConversation(conversationId: string): void {
    const run = this.activeRunForConversation(conversationId)
    if (!run) return
    void this.requestConversationInterrupt(run)
  }

  /** The MessagePort is a detachable subscription, not the authoritative turn. */
  handleChatStreamPortClosed(conversationId: string, streamId?: string): void {
    const run = this.activeRunForConversation(conversationId)
    if (!run || run.terminalDelivered) return
    if (streamId) run.subscribers.delete(streamId)
    else run.subscribers.clear()
  }

  attachChatStream(
    conversationId: string,
    streamId: string,
    port: CodexPortLike,
    expectedRunId?: string,
    afterSequence = 0
  ): CodexChatAttachResult {
    const run =
      this.activeRunForConversation(conversationId) ??
      this.recentTerminalRunForConversation(conversationId)
    if (!run) return { status: 'run-unavailable' }
    if (expectedRunId && expectedRunId !== run.runId) return { status: 'run-mismatch' }
    if (run.journalReplayUnavailable) return { status: 'journal-unavailable' }
    this.attachStreamPort(run, streamId, port, afterSequence)
    return { status: 'attached' }
  }

  getActiveChatRun(conversationId: string): CodexChatRunDescriptor | undefined {
    const activeRun = this.activeRunForConversation(conversationId)
    if (activeRun) return this.chatRunDescriptor(activeRun, 'active')

    const terminalRun = this.recentTerminalRunForConversation(conversationId)
    return terminalRun ? this.chatRunDescriptor(terminalRun, 'terminal') : undefined
  }

  getActiveChatRuns(): CodexChatRunDescriptor[] {
    return [...new Set(this.activeConversationRuns.values())].map((run) =>
      this.chatRunDescriptor(run, 'active')
    )
  }

  getActiveChatSnapshot(conversationId: string): CodexChatRecoverySnapshot | undefined {
    const activeRun = this.activeRunForConversation(conversationId)
    const run = activeRun ?? this.recentTerminalRunForConversation(conversationId)
    if (!run) return undefined
    return {
      run: this.chatRunDescriptor(run, activeRun ? 'active' : 'terminal'),
      baseMessages: cloneRecoveryMessages(run.baseMessages)
    }
  }

  private chatRunDescriptor(
    run: ActiveConversationRun,
    state: CodexChatRunDescriptor['state']
  ): CodexChatRunDescriptor {
    return {
      runId: run.runId,
      conversationId: run.conversationId,
      state,
      runKind: run.runKind,
      ...(run.threadId ? { threadId: run.threadId } : {}),
      lastSequence: run.lastEventSequence
    }
  }

  private attachStreamPort(
    run: ActiveConversationRun,
    streamId: string,
    port: CodexPortLike,
    afterSequence = 0
  ): void {
    run.subscribers.set(streamId, port)
    if (run.handlePortControl) {
      port.on('message', (event) => run.handlePortControl?.(event.data))
    }
    port.start()
    for (const envelope of run.eventJournal) {
      if (envelope.sequence <= afterSequence) continue
      try {
        port.postMessage(envelope)
      } catch (error) {
        run.subscribers.delete(streamId)
        console.warn('chat stream MessagePort detached during replay', error)
        return
      }
    }
  }

  private postStreamEvent(
    run: ActiveConversationRun,
    _port: CodexPortLike,
    event: CodexChatStreamEvent
  ): boolean {
    const sequence = ++run.lastEventSequence
    const envelope: CodexChatStreamEnvelope = { runId: run.runId, sequence, event }
    this.appendJournalEvent(run, envelope)
    let delivered = false
    for (const [streamId, port] of run.subscribers) {
      try {
        port.postMessage(envelope)
        delivered = true
      } catch (error) {
        run.subscribers.delete(streamId)
        console.warn('chat stream MessagePort detached before event delivery', error)
      }
    }
    return delivered
  }

  private appendJournalEvent(run: ActiveConversationRun, envelope: CodexChatStreamEnvelope): void {
    if (run.journalReplayUnavailable) return
    const size = JSON.stringify(envelope).length * 2
    if (
      run.eventJournal.length >= maxReplayJournalEvents ||
      run.eventJournalBytes + size > maxReplayJournalBytes
    ) {
      run.eventJournal = []
      run.eventJournalBytes = 0
      run.journalReplayUnavailable = true
      return
    }
    run.eventJournal.push(envelope)
    run.eventJournalBytes += size
  }

  private requestConversationInterrupt(run: ActiveConversationRun): Promise<void> {
    return this.requestRunInterrupt(run, 'user-stop')
  }

  private requestRunInterrupt(
    run: ActiveConversationRun,
    reason: ConversationInterruptReason
  ): Promise<void> {
    if (run.interruptReason && run.interruptReason !== reason) {
      return run.interruptPromise ?? Promise.resolve()
    }
    if (!run.interruptReason) {
      run.interruptReason = reason
      this.clearTurnInactivityWatchdog(run)
      if (reason === 'user-stop') {
        run.stopRequested = true
        run.stopRequestedAt = Date.now()
      }
      run.approvalSettlementPromise = this.settleRunApprovalsForInterrupt(
        run,
        reason === 'user-stop'
          ? 'The task was stopped before approval was completed.'
          : 'The model response timed out before approval was completed.'
      )
    }
    if (run.interruptPromise) return run.interruptPromise
    if (!run.session || !run.threadId || !run.turnId) return Promise.resolve()

    run.interruptPromise = (async () => {
      await run.approvalSettlementPromise
      this.scheduleCanonicalReconciliation(run)
      try {
        await run.session?.interrupt()
      } catch (error) {
        console.warn('turn/interrupt did not settle cleanly; reconciling terminal outcome', error)
      } finally {
        this.scheduleCanonicalReconciliation(run)
      }
    })()
    return run.interruptPromise
  }

  private startTurnInactivityWatchdog(run: ActiveConversationRun, turnId: string): void {
    if (run.turnInactivityTimer !== undefined && run.turnInactivityTurnId === turnId) return
    this.armTurnInactivityWatchdog(run, turnId)
  }

  private refreshTurnInactivityWatchdog(run: ActiveConversationRun, turnId: string): void {
    if (run.threadId === undefined || run.turnId !== turnId) return
    this.armTurnInactivityWatchdog(run, turnId)
  }

  private armTurnInactivityWatchdog(run: ActiveConversationRun, turnId: string): void {
    this.clearTurnInactivityWatchdog(run)
    if (
      this.turnInactivityTimeoutMs === 0 ||
      run.terminalDelivered ||
      run.interruptReason ||
      run.turnOutcome ||
      run.approvalRequestIds.size > 0
    ) {
      return
    }

    run.turnInactivityTurnId = turnId
    const timer = this.scheduleTimeout(() => {
      if (run.turnInactivityTimer !== timer) return
      run.turnInactivityTimer = undefined
      run.turnInactivityTurnId = undefined
      if (run.terminalDelivered || run.turnOutcome || run.turnId !== turnId) return
      console.warn('turn produced no model or tool activity before the inactivity deadline', {
        conversationId: run.conversationId,
        threadId: run.threadId,
        turnId,
        timeoutMs: this.turnInactivityTimeoutMs
      })
      void this.requestRunInterrupt(run, 'turn-inactivity-timeout')
    }, this.turnInactivityTimeoutMs)
    run.turnInactivityTimer = timer
  }

  private clearTurnInactivityWatchdog(run: ActiveConversationRun, turnId?: string): void {
    if (turnId && run.turnInactivityTurnId && run.turnInactivityTurnId !== turnId) {
      return
    }
    if (run.turnInactivityTimer !== undefined) {
      this.clearScheduledTimeout(run.turnInactivityTimer)
      run.turnInactivityTimer = undefined
    }
    run.turnInactivityTurnId = undefined
  }

  private scheduleCanonicalReconciliation(run: ActiveConversationRun): void {
    if (
      run.turnOutcome ||
      run.terminalDelivered ||
      run.canonicalOutcomeTimer !== undefined ||
      !run.threadId ||
      !run.turnId
    ) {
      return
    }
    run.canonicalOutcomeTimer = this.scheduleTimeout(() => {
      run.canonicalOutcomeTimer = undefined
      void this.reconcileCanonicalOutcome(run)
    }, this.canonicalOutcomeTimeoutMs)
  }

  private clearCanonicalOutcomeTimer(run: ActiveConversationRun): void {
    if (run.canonicalOutcomeTimer === undefined) return
    this.clearScheduledTimeout(run.canonicalOutcomeTimer)
    run.canonicalOutcomeTimer = undefined
  }

  private async reconcileCanonicalOutcome(run: ActiveConversationRun): Promise<void> {
    if (run.turnOutcome || run.terminalDelivered || !run.threadId || !run.turnId) return

    let outcome: ActiveConversationRun['turnOutcome']
    try {
      outcome = await this.readCanonicalTurnOutcome(run.threadId, run.turnId)
    } catch (error) {
      console.warn('failed to reconcile stopped turn outcome', error)
    }

    if (outcome) {
      this.setCanonicalOutcome(run, outcome, 'history-reconciliation')
    } else if (!run.canonicalResolutionError) {
      run.canonicalResolutionError =
        run.interruptReason === 'turn-inactivity-timeout'
          ? turnInactivityTimeoutError
          : unknownStopOutcomeError
    }

    // The UI/control-plane decision has been made from authoritative history
    // (or an explicit unknown error). Abort only now to release a provider
    // stream whose matching notification was lost.
    run.abortController.abort()
  }

  private setCanonicalOutcome(
    run: ActiveConversationRun,
    outcome: NonNullable<ActiveConversationRun['turnOutcome']>,
    source: NonNullable<ActiveConversationRun['canonicalOutcomeSource']>
  ): void {
    if (run.turnOutcome) return
    this.clearTurnInactivityWatchdog(run)
    run.turnOutcome = outcome
    run.canonicalOutcomeSource = source
    this.clearCanonicalOutcomeTimer(run)
  }

  private canonicalTerminalForRun(
    run: ActiveConversationRun,
    fallback: CodexChatTerminalEvent | undefined
  ): CodexChatTerminalEvent {
    switch (run.turnOutcome) {
      case 'completed':
        return { type: 'finish', threadId: run.threadId }
      case 'interrupted':
        return run.interruptReason === 'turn-inactivity-timeout'
          ? { type: 'error', error: turnInactivityTimeoutError }
          : { type: 'aborted' }
      case 'failed':
        // The app-server's canonical outcome decides that this is a failure,
        // while the provider stream may carry the safe, user-facing upstream
        // failure detail (for example a model quota response). Keep that
        // detail without allowing the local stream to classify the outcome.
        if (run.canonicalFailureMessage) {
          return { type: 'error', error: run.canonicalFailureMessage }
        }
        if (fallback?.type === 'error') return fallback
        return { type: 'error', error: canonicalFailureError }
      default:
        break
    }
    if (run.canonicalResolutionError) {
      return { type: 'error', error: run.canonicalResolutionError }
    }
    if (run.stopRequested) {
      return { type: 'error', error: unknownStopOutcomeError }
    }
    if (run.interruptReason === 'turn-inactivity-timeout') {
      return { type: 'error', error: turnInactivityTimeoutError }
    }
    if (fallback?.type === 'error') return fallback
    return { type: 'error', error: canonicalFailureError }
  }

  async steerConversation(
    conversationId: string,
    message: CodexChatRequest['messages'][number],
    clientUserMessageId: string
  ): Promise<CodexSteerResult> {
    const run = this.activeRunForConversation(conversationId)
    if (!run?.session?.isActive() || run.terminalDelivered) {
      throw new CodexSteerError(
        'session_inactive',
        'Conversation does not have a steerable active turn'
      )
    }

    const resolvedMessage = (await this.restoreArtifactAttachments([message]))[0] ?? message
    const messageForRun = restoreLocalMediaFileUrlsForModel([resolvedMessage])[0] ?? resolvedMessage
    return run.session.steerMessage(messageForRun, clientUserMessageId)
  }

  /**
   * Goal mutations share an existing app-server session when a thread is still
   * running. This keeps the mutation on the thread's current app-server
   * connection instead of racing it with a short-lived history connection.
   */
  async setThreadGoalOnActiveSession(
    conversationId: string,
    objective: string
  ): Promise<ThreadGoalSummary | undefined> {
    const run = this.activeRunForConversation(conversationId)
    if (!run?.session?.isActive() || run.terminalDelivered || run.threadId !== conversationId) {
      return undefined
    }

    const goal = await run.session.setThreadGoal({ objective, status: 'active' })
    return goal as ThreadGoalSummary
  }

  async clearThreadGoalOnActiveSession(conversationId: string): Promise<boolean | undefined> {
    const run = this.activeRunForConversation(conversationId)
    if (!run?.session?.isActive() || run.terminalDelivered || run.threadId !== conversationId) {
      return undefined
    }

    return run.session.clearThreadGoal()
  }

  async steerClaimedFollowUp(
    claim: FollowUpClaim,
    message: CodexChatRequest['messages'][number]
  ): Promise<CodexSteerResult> {
    const run = this.activeRunForConversation(claim.conversationKey)
    if (!run?.session?.isActive() || !run.turnId || run.terminalDelivered) {
      const error = new CodexSteerError(
        'session_inactive',
        'Conversation does not have a steerable active turn'
      )
      await this.followUpQueue?.failClaim(
        claim.conversationKey,
        claim.item.id,
        claim.leaseToken,
        steerFailureDisposition(error)
      )
      throw error
    }
    const existingPending = run.pendingSteerClaims.get(message.id)
    if (existingPending) {
      const error = new Error(`Follow-up steer is already pending acknowledgement: ${message.id}`)
      if (existingPending.claim.leaseToken !== claim.leaseToken) {
        await this.followUpQueue?.failClaim(
          claim.conversationKey,
          claim.item.id,
          claim.leaseToken,
          steerFailureDisposition(error)
        )
      }
      throw error
    }

    const pending: PendingSteerClaim = {
      claim,
      targetTurnId: run.turnId,
      requestSettled: false,
      terminalSettled: false,
      accepted: false
    }
    run.pendingSteerClaims.set(message.id, pending)

    try {
      pending.compareKey = steeringCompareKey(
        restoreLocalMediaFileUrlsForModel([message])[0] ?? message
      )
      const result = await this.steerConversation(claim.conversationKey, message, message.id)
      pending.targetTurnId = result.turnId
      pending.requestSettled = true
      if (pending.terminalSettled) {
        throw new CodexSteerError(
          'steer_result_unknown',
          'The task ended before the steer result could be confirmed'
        )
      }
      this.scheduleSteerConfirmation(run, pending)
      return result
    } catch (error) {
      pending.requestSettled = true
      await run.lifecycleSettlement
      if (pending.terminalSettled) {
        if (!pending.accepted) {
          await this.failPendingSteerClaim(
            run,
            pending,
            isCodexSteerError(error) && error.code === 'steer_result_unknown'
              ? terminalSteerFailureDisposition(pending.terminalEvent, true)
              : steerFailureDisposition(error)
          )
        } else {
          await pending.settlement
        }
        throw error
      }
      if (pending.accepted) return { turnId: pending.targetTurnId }
      if (isCodexSteerError(error) && error.code === 'steer_result_unknown') {
        return { turnId: pending.targetTurnId }
      }
      await this.failPendingSteerClaim(run, pending, steerFailureDisposition(error))
      throw error
    }
  }

  isConversationRunning(conversationId: string): boolean {
    const run = this.activeRunForConversation(conversationId)
    return Boolean(run && (!run.terminalDelivered || run.settlementBlockedEvent))
  }

  hasActiveChatStream(conversationId: string): boolean {
    const run = this.activeRunForConversation(conversationId)
    return Boolean(run && !run.terminalDelivered)
  }

  /**
   * Wait for the currently active turn for this conversation (or any of its
   * local/thread aliases) to reach a terminal state.  A renderer reconnecting
   * after a reload must read history only after this resolves; otherwise it
   * can permanently hydrate an incomplete in-flight transcript.
   */
  waitForConversationSettlement(conversationId: string): Promise<void> {
    return this.activeRunForConversation(conversationId)?.streamSettled ?? Promise.resolve()
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopInternal()
    return this.stopPromise
  }

  private async stopInternal(): Promise<void> {
    this.status = { state: 'stopping', binary: this.launch.displayBinary }
    await this.closeStartAdmissions()
    const activeRuns = [...new Set(this.activeConversationRuns.values())]
    await Promise.all(activeRuns.map((run) => this.settleRunForShutdown(run)))
    this.approvalBroker.rejectAll(new Error('Codex runtime is stopping'))
    await this.nativeDriver.shutdown()
    this.status = { state: 'stopped', binary: this.launch.displayBinary }
  }

  private async settleRunForShutdown(run: ActiveConversationRun): Promise<void> {
    const interrupt = this.requestConversationInterrupt(run)
    void interrupt.then(
      () => void this.reconcileCanonicalOutcome(run),
      () => undefined
    )

    if (await this.waitForRunSettlement(run)) return

    this.clearCanonicalOutcomeTimer(run)
    run.abortController.abort()
    this.rejectRunApprovals(run, 'Codex runtime shutdown timed out before approval was completed.')
    await this.forceReleaseFollowUpStateAfterShutdownTimeout(run)
    run.terminalDelivered = true
    this.clearActiveConversationRun(run)
    run.resolveStreamSettled()
  }

  /**
   * A local shutdown timeout cannot leave a delivery lease live.  We no longer
   * know whether an in-flight steer reached the server, so preserve it as a
   * paused recovery-uncertain item instead of retrying it or silently dropping
   * it.  This is deliberately separate from normal terminal settlement: the
   * latter can still wait for canonical lifecycle evidence.
   */
  private async forceReleaseFollowUpStateAfterShutdownTimeout(
    run: ActiveConversationRun
  ): Promise<void> {
    const terminalEvent: CodexChatStreamEvent = {
      type: 'error',
      error: 'Codex runtime shutdown timed out before delivery could be confirmed.'
    }

    try {
      const claim = run.followUpClaim
      if (claim && this.followUpQueue) {
        if (run.followUpAccepted) {
          await this.settleAcceptedFollowUp(run)
        } else {
          await this.followUpQueue.failClaim(
            claim.conversationKey,
            claim.item.id,
            claim.leaseToken,
            {
              status: 'paused-recovery-uncertain',
              kind: 'recovery-uncertain',
              userMessage: chatStreamErrorMessage(terminalEvent.error)
            }
          )
        }
      }
      await Promise.all(
        [...run.pendingSteerClaims.values()].map(async (pending) => {
          pending.terminalSettled = true
          pending.terminalEvent = terminalEvent
          if (pending.accepted) {
            await this.settleAcceptedPendingSteerClaim(run, pending)
            return
          }
          await this.failPendingSteerClaim(run, pending, {
            status: 'paused-recovery-uncertain',
            kind: 'recovery-uncertain',
            userMessage: 'The application closed before the steer delivery could be confirmed.'
          })
        })
      )
    } catch (error) {
      // The durable store can be unavailable while Electron is exiting.  Clear
      // all local leases and timers anyway; the persisted item remains for the
      // queue store's normal recovery path rather than being sent again here.
      console.warn('failed to settle follow-up state before forced runtime shutdown', error)
    } finally {
      for (const pending of run.pendingSteerClaims.values()) {
        this.clearSteerConfirmation(pending)
      }
      run.pendingSteerClaims.clear()
      run.followUpClaim = undefined
      run.followUpSettlement = undefined
    }
  }

  private waitForRunSettlement(run: ActiveConversationRun): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const timer = this.scheduleTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, this.shutdownTimeoutMs)
      void run.streamSettled.then(() => {
        if (settled) return
        settled = true
        this.clearScheduledTimeout(timer)
        resolve(true)
      })
    })
  }

  private clearActiveConversationRun(run: ActiveConversationRun): void {
    for (const [key, value] of this.activeConversationRuns.entries()) {
      if (value === run) this.activeConversationRuns.delete(key)
    }
  }

  private retainTerminalRun(run: ActiveConversationRun): void {
    this.discardRetainedTerminalRun(run)
    for (const alias of this.aliasesForRun(run)) this.recentTerminalRuns.set(alias, run)
    run.terminalRetentionTimer = setTimeout(() => {
      this.discardRetainedTerminalRun(run)
    }, terminalReplayRetentionMs)
    run.terminalRetentionTimer.unref?.()
  }

  private discardRetainedTerminalRun(run: ActiveConversationRun): void {
    for (const [key, value] of this.recentTerminalRuns.entries()) {
      if (value === run) this.recentTerminalRuns.delete(key)
    }
    if (run.terminalRetentionTimer !== undefined) {
      clearTimeout(run.terminalRetentionTimer)
      run.terminalRetentionTimer = undefined
    }
  }

  private aliasesForRun(run: ActiveConversationRun): string[] {
    return [
      ...new Set(
        [run.conversationId, run.threadId].filter((value): value is string => Boolean(value))
      )
    ]
  }

  /**
   * Renderer reloads address a conversation by the thread id returned from
   * history. The alias map is an index, while the run itself owns the
   * canonical identities; consult both before allowing history to hydrate.
   */
  private activeRunForConversation(conversationId: string): ActiveConversationRun | undefined {
    const indexed = this.activeConversationRuns.get(conversationId)
    if (indexed) return indexed

    return [...new Set(this.activeConversationRuns.values())].find(
      (run) => run.conversationId === conversationId || run.threadId === conversationId
    )
  }

  private recentTerminalRunForConversation(
    conversationId: string
  ): ActiveConversationRun | undefined {
    const indexed = this.recentTerminalRuns.get(conversationId)
    if (indexed) return indexed
    return [...new Set(this.recentTerminalRuns.values())].find(
      (run) => run.conversationId === conversationId || run.threadId === conversationId
    )
  }

  private async recoverBlockedConversationRun(request: CodexChatRequest): Promise<void> {
    const aliases = [request.chatId, request.body?.conversationId, request.body?.threadId].filter(
      (value): value is string => Boolean(value)
    )
    const blockedRuns = new Set(
      aliases
        .map((alias) => this.activeConversationRuns.get(alias))
        .filter((run): run is ActiveConversationRun => Boolean(run?.settlementBlockedEvent))
    )

    for (const run of blockedRuns) {
      const terminalEvent = run.settlementBlockedEvent
      if (!terminalEvent) continue
      try {
        await this.settleRunFollowUps(run, terminalEvent)
      } catch (error) {
        throw new Error(
          `Follow-up state for ${run.conversationId} is still recovering: ${errorMessage(error)}`
        )
      }
      run.settlementBlockedEvent = undefined
      this.clearActiveConversationRun(run)
    }
  }

  private registerActiveConversationRun(
    request: CodexChatRequest,
    followUpClaim?: FollowUpClaim
  ): ActiveConversationRun {
    const conversationId = request.body?.conversationId ?? request.body?.threadId ?? request.chatId
    const aliases = new Set(
      [request.chatId, request.body?.conversationId, request.body?.threadId].filter(
        (value): value is string => Boolean(value)
      )
    )
    for (const alias of aliases) {
      const retainedTerminal = this.recentTerminalRuns.get(alias)
      if (retainedTerminal) this.discardRetainedTerminalRun(retainedTerminal)
    }
    for (const alias of aliases) {
      const existing = this.activeConversationRuns.get(alias)
      if (existing?.terminalDelivered && !existing.settlementBlockedEvent) {
        this.clearActiveConversationRun(existing)
      }
    }
    const duplicateAlias = [...aliases].find((alias) => this.activeConversationRuns.has(alias))
    if (duplicateAlias) {
      throw new Error(`Conversation already has an active turn: ${duplicateAlias}`)
    }

    let resolveStreamSettled!: () => void
    const streamSettled = new Promise<void>((resolve) => {
      resolveStreamSettled = resolve
    })
    const run: ActiveConversationRun = {
      runId: randomUUID(),
      conversationId,
      baseMessages: cloneRecoveryMessages(request.messages),
      runKind:
        request.body?.threadGoalDraft || request.body?.threadGoalControl ? 'goal' : 'single-turn',
      threadId: request.body?.threadId,
      abortController: new AbortController(),
      subscribers: new Map(),
      eventJournal: [],
      eventJournalBytes: 0,
      journalReplayUnavailable: false,
      lastEventSequence: 0,
      terminalDelivered: false,
      stopRequested: false,
      followUpClaim,
      followUpCompareKey: followUpClaim
        ? compareKeyForClaimedMessage(request, followUpClaim.item.id)
        : undefined,
      followUpAccepted: false,
      pendingSteerClaims: new Map(),
      approvalRequestIds: new Set(),
      transportRecoveryAttempted: false,
      lifecycleSettlement: Promise.resolve(),
      streamSettled,
      resolveStreamSettled
    }
    for (const alias of aliases) this.activeConversationRuns.set(alias, run)
    return run
  }

  private async resolveCommitMessageExecutionTarget(
    target: LocalGitTarget
  ): Promise<ConversationExecutionTarget> {
    if (!this.projectService) {
      throw new Error('Local project execution is unavailable for commit message generation.')
    }
    const resolved = await this.projectService.resolveExistingThreadTarget({
      conversationId: target.conversationId,
      threadId: target.threadId,
      allowActiveProjectFallback: false
    })
    if (!resolved || resolved.hostId !== 'local' || !resolved.cwd) {
      throw new Error('Local project execution is unavailable for this conversation.')
    }
    return {
      cwd: resolved.cwd,
      runtimeWorkspaceRoots: resolved.workspaceRoots
    }
  }

  private async prepareClaimedFollowUp(request: CodexChatRequest): Promise<{
    request: CodexChatRequest
    claim?: FollowUpClaim
  }> {
    const followUpRequest = request.body?.followUpRequest
    if (!followUpRequest) return { request }
    if (!this.followUpQueue) throw new Error('Follow-up queue is not available')

    const activeConversationKey =
      request.body?.threadId ?? request.body?.conversationId ?? request.chatId
    if (followUpRequest.conversationKey !== activeConversationKey) {
      throw new Error('Follow-up request does not belong to the active conversation')
    }

    const claim = await this.followUpQueue.claimHead(
      followUpRequest.conversationKey,
      'turn-start',
      followUpRequest.itemId,
      'runtime'
    )
    let message: Awaited<ReturnType<ConversationFollowUpQueueService['materializeClaimMessage']>>
    try {
      message = await this.followUpQueue.materializeClaimMessage(claim)
    } catch (error) {
      await this.followUpQueue
        .failClaim(claim.conversationKey, claim.item.id, claim.leaseToken, {
          kind: 'attachment-unavailable',
          userMessage: errorMessage(error)
        })
        .catch((settlementError) =>
          console.warn('failed to release invalid follow-up delivery lease', settlementError)
        )
      throw error
    }
    const userMessage: CodexChatRequest['messages'][number] = {
      id: message.id,
      role: 'user',
      parts: message.parts
    }
    const previousMessages = request.messages.filter((candidate) => candidate.id !== message.id)

    return {
      claim,
      request: {
        ...request,
        messageId: message.id,
        messages: [...previousMessages, userMessage],
        body: {
          ...request.body,
          followUpRequest
        }
      }
    }
  }

  private acceptClaimedFollowUp(run: ActiveConversationRun): void {
    const claim = run.followUpClaim
    if (!claim || run.followUpAccepted || !this.followUpQueue) return
    run.followUpAccepted = true
    void this.settleAcceptedFollowUp(run).catch(() => undefined)
  }

  private settleAcceptedFollowUp(run: ActiveConversationRun): Promise<void> {
    if (run.followUpSettlement) return run.followUpSettlement
    const claim = run.followUpClaim
    if (!claim || !this.followUpQueue) return Promise.resolve()

    const settlementTask = (async (): Promise<void> => {
      try {
        await this.followUpQueue?.commitClaim(
          claim.conversationKey,
          claim.item.id,
          claim.leaseToken
        )
      } catch (commitError) {
        console.warn('failed to commit accepted follow-up delivery', commitError)
        try {
          await this.followUpQueue?.failClaim(
            claim.conversationKey,
            claim.item.id,
            claim.leaseToken,
            {
              status: 'paused-recovery-uncertain',
              kind: 'recovery-uncertain',
              userMessage:
                'The follow-up was accepted, but its local queue record could not be finalized.'
            }
          )
        } catch (fallbackError) {
          throw new AggregateError(
            [commitError, fallbackError],
            'Accepted follow-up queue settlement failed'
          )
        }
      }
    })()
    const trackedSettlement = settlementTask.catch((error) => {
      if (run.followUpSettlement === trackedSettlement) {
        run.followUpSettlement = undefined
      }
      throw error
    })
    run.followUpSettlement = trackedSettlement
    void trackedSettlement.catch(() => undefined)
    return trackedSettlement
  }

  private acceptTurnLifecycle(run: ActiveConversationRun, event: CodexTurnLifecycleEvent): boolean {
    if (run.terminalDelivered) return false
    if (run.threadId && run.threadId !== event.threadId) return false

    if (event.type === 'turn-started') {
      if (run.turnId && run.turnId !== event.turnId && run.runKind !== 'goal') return false
      if (run.lastLifecycleSequence !== undefined && event.sequence <= run.lastLifecycleSequence) {
        if (run.runKind === 'goal' && run.turnId !== event.turnId) {
          run.lastLifecycleSequence = undefined
        } else {
          return false
        }
      }
      if (run.runKind === 'goal' && run.turnId !== event.turnId) {
        run.lastLifecycleSequence = undefined
      }
      if (run.lastLifecycleSequence !== undefined && event.sequence <= run.lastLifecycleSequence) {
        return false
      }
      if (!run.threadId) this.bindActiveConversationRunAlias(run, event.threadId)
      run.turnId = event.turnId
      run.lastLifecycleSequence = event.sequence
      return true
    }

    if (!run.threadId || !run.turnId || run.turnId !== event.turnId) return false
    if (run.lastLifecycleSequence !== undefined && event.sequence <= run.lastLifecycleSequence) {
      return false
    }
    run.lastLifecycleSequence = event.sequence
    return true
  }

  private async observeAcceptedTurnLifecycle(
    run: ActiveConversationRun,
    event: CodexTurnLifecycleEvent
  ): Promise<void> {
    if (event.type === 'turn-started') {
      this.startTurnInactivityWatchdog(run, event.turnId)
      if (run.interruptReason) void this.requestRunInterrupt(run, run.interruptReason)
      return
    }

    if (
      event.type === 'item-completed' &&
      event.itemType === 'userMessage' &&
      (event.clientUserMessageId || event.compareKey)
    ) {
      const followUpIdentityMatches = event.clientUserMessageId
        ? run.followUpClaim?.item.id === event.clientUserMessageId
        : Boolean(event.compareKey && run.followUpCompareKey === event.compareKey)
      if (followUpIdentityMatches) {
        this.acceptClaimedFollowUp(run)
      }
      this.acceptPendingSteerClaim(run, event.clientUserMessageId, event.compareKey)
      return
    }

    if (event.type === 'turn-completed') {
      this.clearTurnInactivityWatchdog(run, event.turnId)
      await this.persistFinalTurnDiff(run, event)
      this.onTurnCompleted?.()
      const providerFailureDetail = turnFailureDetail(event)
      if (event.outcome === 'failed' && providerFailureDetail) {
        run.canonicalFailureMessage = sanitizeUserFacingError(providerFailureDetail)
      }
      if (run.runKind === 'goal') {
        run.lastCompletedGoalOutcome = event.outcome
        if (run.goalReachedTerminalStatus || run.interruptReason) {
          this.setCanonicalOutcome(run, event.outcome, 'notification')
        }
      } else {
        this.setCanonicalOutcome(run, event.outcome, 'notification')
      }
      await this.rejectUnacceptedSteerClaims(run, event.turnId, event.outcome)
    }
  }

  private observeTurnActivity(
    run: ActiveConversationRun,
    event: { threadId: string; turnId: string }
  ): void {
    if (
      run.terminalDelivered ||
      run.interruptReason ||
      run.turnOutcome ||
      run.threadId !== event.threadId ||
      run.turnId !== event.turnId
    ) {
      return
    }
    this.refreshTurnInactivityWatchdog(run, event.turnId)
  }

  private async persistFinalTurnDiff(
    run: ActiveConversationRun,
    event: Extract<CodexTurnLifecycleEvent, { type: 'turn-completed' }>
  ): Promise<void> {
    const turnDiff = run.latestTurnDiff
    run.latestTurnDiff = undefined
    if (
      !this.turnDiffStore ||
      !turnDiff ||
      turnDiff.threadId !== event.threadId ||
      turnDiff.turnId !== event.turnId
    ) {
      return
    }

    try {
      await this.turnDiffStore.save(turnDiff)
    } catch (error) {
      console.warn('failed to persist final turn diff', error)
    }
  }

  private acceptPendingSteerClaim(
    run: ActiveConversationRun,
    clientUserMessageId: string | undefined,
    compareKey: string | undefined
  ): void {
    let pending = clientUserMessageId ? run.pendingSteerClaims.get(clientUserMessageId) : undefined
    if (!clientUserMessageId && compareKey !== undefined) {
      const selection = selectUniqueLegacyCandidate(
        [...run.pendingSteerClaims.values()],
        (candidate) =>
          !candidate.accepted && !candidate.settlement && candidate.compareKey === compareKey
      )
      pending = selection.candidate
      if (selection.matchingCandidates.length > 1) {
        console.warn('ambiguous legacy steer acknowledgement ignored', {
          turnId: run.turnId,
          candidateCount: selection.matchingCandidates.length,
          messageIds: selection.matchingCandidates.map((candidate) => candidate.claim.item.id)
        })
      }
    }
    if (!pending || pending.accepted || pending.settlement || !this.followUpQueue) return
    pending.accepted = true
    this.clearSteerConfirmation(pending)
    void this.settleAcceptedPendingSteerClaim(run, pending).catch(() => undefined)
  }

  private scheduleSteerConfirmation(run: ActiveConversationRun, pending: PendingSteerClaim): void {
    if (pending.accepted || pending.settlement || pending.confirmationTimer !== undefined) return
    pending.confirmationTimer = this.scheduleTimeout(() => {
      pending.confirmationTimer = undefined
      run.lifecycleSettlement = run.lifecycleSettlement
        .then(async () => {
          if (pending.accepted || pending.settlement || !pending.requestSettled) return
          await this.failPendingSteerClaim(run, pending, {
            status: 'paused-recovery-uncertain',
            kind: 'recovery-uncertain',
            userMessage: 'The steer result was not confirmed and was not sent again.'
          })
        })
        .catch((error) => {
          console.warn('failed to settle unconfirmed steer delivery', error)
        })
    }, this.steerConfirmationTimeoutMs)
  }

  private clearSteerConfirmation(pending: PendingSteerClaim): void {
    if (pending.confirmationTimer === undefined) return
    this.clearScheduledTimeout(pending.confirmationTimer)
    pending.confirmationTimer = undefined
  }

  private settleAcceptedPendingSteerClaim(
    run: ActiveConversationRun,
    pending: PendingSteerClaim
  ): Promise<void> {
    if (pending.settlement) return pending.settlement
    if (!this.followUpQueue) return Promise.resolve()
    this.clearSteerConfirmation(pending)

    const settlementTask = (async (): Promise<void> => {
      try {
        await this.followUpQueue?.acknowledgeClaim?.(
          pending.claim.conversationKey,
          pending.claim.item.id,
          pending.claim.leaseToken
        )
        await this.followUpQueue?.commitClaim(
          pending.claim.conversationKey,
          pending.claim.item.id,
          pending.claim.leaseToken
        )
      } catch (commitError) {
        console.warn('failed to commit acknowledged steer delivery', commitError)
        try {
          await this.followUpQueue?.failClaim(
            pending.claim.conversationKey,
            pending.claim.item.id,
            pending.claim.leaseToken,
            {
              status: 'paused-recovery-uncertain',
              kind: 'recovery-uncertain',
              userMessage:
                'The steer was acknowledged, but its local queue record could not be finalized.'
            }
          )
        } catch (fallbackError) {
          throw new AggregateError(
            [commitError, fallbackError],
            'Acknowledged steer queue settlement failed'
          )
        }
      }
      run.pendingSteerClaims.delete(pending.claim.item.id)
    })()
    const trackedSettlement = settlementTask.catch((error) => {
      if (pending.settlement === trackedSettlement) {
        pending.settlement = undefined
      }
      throw error
    })
    pending.settlement = trackedSettlement
    void trackedSettlement.catch(() => undefined)
    return trackedSettlement
  }

  private async rejectUnacceptedSteerClaims(
    run: ActiveConversationRun,
    turnId: string,
    outcome: Extract<CodexTurnLifecycleEvent, { type: 'turn-completed' }>['outcome']
  ): Promise<void> {
    const pendingClaims = [...run.pendingSteerClaims.values()].filter(
      (pending) => pending.requestSettled && pending.targetTurnId === turnId && !pending.accepted
    )
    if (pendingClaims.length === 0 || !this.followUpQueue) return

    await Promise.all(
      pendingClaims.map((pending) =>
        this.failPendingSteerClaim(run, pending, {
          status: 'paused-recovery-uncertain',
          kind: 'recovery-uncertain',
          userMessage:
            outcome === 'interrupted'
              ? 'The task stopped before the steer result could be confirmed.'
              : 'The task ended before the steer result could be confirmed.'
        })
      )
    )
  }

  private async settlePendingSteerClaims(
    run: ActiveConversationRun,
    terminalEvent: CodexChatStreamEvent | undefined
  ): Promise<void> {
    const claims = [...run.pendingSteerClaims.values()]
    if (claims.length === 0) return

    await Promise.all(
      claims.map(async (pending) => {
        if (pending.accepted) {
          await this.settleAcceptedPendingSteerClaim(run, pending)
          return
        }
        if (!pending.requestSettled) {
          if (!pending.terminalSettled) {
            pending.terminalSettled = true
            pending.terminalEvent = terminalEvent
          }
          return
        }
        await this.failPendingSteerClaim(
          run,
          pending,
          terminalSteerFailureDisposition(terminalEvent, pending.terminalSettled)
        )
      })
    )
  }

  private async failPendingSteerClaim(
    run: ActiveConversationRun,
    pending: PendingSteerClaim,
    disposition: FollowUpClaimFailure
  ): Promise<void> {
    if (pending.accepted) {
      await this.settleAcceptedPendingSteerClaim(run, pending)
      return
    }
    if (pending.settlement) {
      await pending.settlement
      return
    }

    if (!this.followUpQueue) return
    this.clearSteerConfirmation(pending)
    pending.settlement = this.followUpQueue
      .failClaim(
        pending.claim.conversationKey,
        pending.claim.item.id,
        pending.claim.leaseToken,
        disposition
      )
      .then(() => {
        run.pendingSteerClaims.delete(pending.claim.item.id)
      })
      .catch((error) => {
        pending.settlement = undefined
        throw error
      })
    await pending.settlement
  }

  private async settleClaimedFollowUp(
    run: ActiveConversationRun,
    terminalEvent: CodexChatStreamEvent | undefined
  ): Promise<void> {
    const claim = run.followUpClaim
    if (!claim || !this.followUpQueue) return
    if (run.followUpAccepted) {
      await this.settleAcceptedFollowUp(run)
      return
    }

    let disposition: FollowUpClaimFailure = {
      status: 'paused-failed',
      kind: 'send-failed',
      userMessage: 'The queued follow-up could not be confirmed.'
    }
    if (terminalEvent?.type === 'aborted') {
      disposition = {
        status: 'paused-recovery-uncertain',
        kind: 'recovery-uncertain',
        userMessage: 'The task stopped before queued delivery acceptance could be confirmed.'
      }
    } else if (terminalEvent?.type === 'error') {
      disposition = {
        status: 'paused-failed',
        kind: 'send-failed',
        userMessage: chatStreamErrorMessage(terminalEvent.error)
      }
    }
    await this.followUpQueue.failClaim(
      claim.conversationKey,
      claim.item.id,
      claim.leaseToken,
      disposition
    )
  }

  private async settleRunFollowUps(
    run: ActiveConversationRun,
    terminalEvent: CodexChatStreamEvent | undefined
  ): Promise<void> {
    const settlements = [
      this.settlePendingSteerClaims(run, terminalEvent),
      this.settleClaimedFollowUp(run, terminalEvent)
    ]
    if (run.stopRequested && run.turnOutcome === 'interrupted') {
      settlements.push(this.pauseFollowUpsAfterInterrupt(run))
    }

    const results = await Promise.allSettled(settlements)
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Follow-up queue settlement failed')
    }
  }

  private async failPreparedFollowUp(
    claim: FollowUpClaim | undefined,
    error: unknown
  ): Promise<void> {
    if (!claim || !this.followUpQueue) return
    await this.followUpQueue
      .failClaim(claim.conversationKey, claim.item.id, claim.leaseToken, {
        kind: 'send-failed',
        userMessage: errorMessage(error)
      })
      .catch((settlementError) =>
        console.warn('failed to release rejected follow-up delivery lease', settlementError)
      )
  }

  private async pauseFollowUpsAfterInterrupt(run: ActiveConversationRun): Promise<void> {
    if (!this.followUpQueue) return
    const conversationKey = run.followUpClaim?.conversationKey ?? run.threadId ?? run.conversationId
    await this.followUpQueue.interrupt(conversationKey)
  }

  private bindActiveConversationRunAlias(
    run: ActiveConversationRun,
    alias: string,
    allowThreadReplacement = false
  ): boolean {
    if (run.threadId && run.threadId !== alias && !allowThreadReplacement) {
      throw new Error(`Active conversation thread changed from ${run.threadId} to ${alias}`)
    }
    const existingRun = this.activeConversationRuns.get(alias)
    if (existingRun?.terminalDelivered && !existingRun.settlementBlockedEvent) {
      this.clearActiveConversationRun(existingRun)
    }
    const currentRun = this.activeConversationRuns.get(alias)
    if (currentRun && currentRun !== run) {
      throw new Error(`Conversation already has an active turn: ${alias}`)
    }
    if (currentRun === run) {
      const changed = run.threadId !== alias
      run.threadId = alias
      return changed
    }
    const changed = run.threadId !== alias
    run.threadId = alias
    this.activeConversationRuns.set(alias, run)
    return changed
  }

  private migrateActiveFollowUpClaims(run: ActiveConversationRun, conversationKey: string): void {
    const migrateClaim = (claim: FollowUpClaim): FollowUpClaim => ({
      ...claim,
      conversationKey,
      item: {
        ...claim.item,
        conversationKey,
        message: {
          ...claim.item.message,
          trustedContext: {
            ...claim.item.message.trustedContext,
            threadId: conversationKey
          }
        }
      }
    })

    if (run.followUpClaim && run.followUpClaim.conversationKey !== conversationKey) {
      run.followUpClaim = migrateClaim(run.followUpClaim)
    }
    for (const pending of run.pendingSteerClaims.values()) {
      if (pending.claim.conversationKey !== conversationKey) {
        pending.claim = migrateClaim(pending.claim)
      }
    }
  }

  private restoreStatusAfterTurnFailure(run: ActiveConversationRun): void {
    if (this.status.state !== 'starting') return
    const hasOtherActiveRun = [...this.activeConversationRuns.values()].some(
      (activeRun) => activeRun !== run
    )
    if (!hasOtherActiveRun) {
      this.status = { state: 'stopped', binary: this.launch.displayBinary }
    }
  }

  private createRunApprovalHandlers(run: ActiveConversationRun): CodexRunApprovalHandlers {
    const request = async (input: CodexApprovalRequestInput): Promise<CodexApprovalResponse> => {
      let requestId: string | undefined
      try {
        return await this.approvalBroker.request(
          {
            ...input,
            context: {
              threadId: run.threadId,
              turnId: run.turnId
            }
          },
          (registeredRequestId) => {
            requestId = registeredRequestId
            run.approvalRequestIds.add(registeredRequestId)
            this.clearTurnInactivityWatchdog(run)
          }
        )
      } finally {
        if (requestId) run.approvalRequestIds.delete(requestId)
        if (run.approvalRequestIds.size === 0 && run.turnId) {
          this.refreshTurnInactivityWatchdog(run, run.turnId)
        }
      }
    }

    return {
      command: async (params) => {
        const response = await request({ kind: 'command', params })
        return commandApprovalDecisionFromResponse(params, response)
      },
      fileChange: async (params) => {
        const response = await request({ kind: 'file-change', params })
        if (response.action === 'approveForSession') return 'acceptForSession'
        if (response.action === 'approve') return 'accept'
        if (response.action === 'decline') return 'decline'
        return 'cancel'
      },
      toolUserInput: async (params) => {
        const response = await request({ kind: 'tool-user-input', params })
        return response.action === 'answer'
          ? { answers: toToolUserInputAnswers(response.answers) }
          : { answers: {} }
      },
      permissions: async (params) => {
        const response = await request({ kind: 'permission-request', params })
        return permissionsApprovalResponseFromApprovalResponse(params, response)
      },
      elicitation: async (params) => {
        const response = await request({ kind: 'mcp-elicitation', params })
        return mcpElicitationResponseFromApprovalResponse(response)
      }
    }
  }

  private rejectRunApprovals(run: ActiveConversationRun, reason: string): void {
    for (const requestId of run.approvalRequestIds) {
      this.approvalBroker.reject(requestId, new Error(reason))
    }
    run.approvalRequestIds.clear()
  }

  private async settleRunApprovalsForInterrupt(
    run: ActiveConversationRun,
    reason: string
  ): Promise<void> {
    const pendingRequests = new Map(
      this.approvalBroker.listPendingApprovals().map((request) => [request.id, request])
    )
    const responses: Promise<void>[] = []
    for (const requestId of run.approvalRequestIds) {
      try {
        const request = pendingRequests.get(requestId)
        const response: CodexApprovalResponse =
          request?.kind === 'command' ||
          request?.kind === 'file-change' ||
          request?.kind === 'mcp-elicitation'
            ? { action: 'cancel' }
            : { action: 'decline', reason }
        responses.push(this.approvalBroker.respond(requestId, response))
      } catch {
        // The approval may have settled concurrently; the matching server
        // request already has a response in that case.
      }
    }
    run.approvalRequestIds.clear()
    await Promise.allSettled(responses)
  }
}

function codexTurnDurationMessageMetadata(
  metadata: unknown
): { codexTurnDurationMs: number } | undefined {
  const durationMs = readCodexMessageMetadata(metadata)?.turnDurationMs
  return typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? { codexTurnDurationMs: durationMs }
    : undefined
}

/**
 * The renderer is intentionally limited to a small mode enum. The main
 * process owns the complete app-server value so UI code cannot inject a model
 * override or developer instructions into a turn request.
 */
function collaborationModeForComposerMode(
  mode: ComposerModeKind,
  model: string,
  reasoningEffort: CollaborationMode['settings']['reasoning_effort'] = null
): CollaborationMode {
  return {
    mode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: null
    }
  }
}

export function approvalSettingsForMode(
  approvalModeKind: ApprovalModeKind,
  executionTarget: ConversationExecutionTarget | undefined,
  fallbackCwd: string
): ApprovalSettings {
  if (approvalModeKind === 'full-access') {
    return {
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    }
  }

  return {
    approvalPolicy: 'on-request',
    approvalsReviewer: approvalModeKind === 'approve-for-me' ? 'auto_review' : 'user',
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: writableRootsForApproval(executionTarget, fallbackCwd),
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  }
}

function writableRootsForApproval(
  executionTarget: ConversationExecutionTarget | undefined,
  fallbackCwd: string
): string[] {
  if (executionTarget?.runtimeWorkspaceRoots?.length) return executionTarget.runtimeWorkspaceRoots
  return [executionTarget?.cwd ?? fallbackCwd]
}

function threadGoalDraftFromRequest(
  request: CodexChatRequest
): NonNullable<CodexChatRequest['body']>['threadGoalDraft'] {
  const draft = request.body?.threadGoalDraft
  if (!draft) return undefined

  const latestUserMessage = request.messages.findLast((message) => message.role === 'user')
  const visibleText = latestUserMessage
    ? extractVisibleUserRequest(
        latestUserMessage.parts
          .map((part) => (part.type === 'text' ? part.text : ''))
          .filter((part): part is string => typeof part === 'string')
          .join('\n')
      ).trim()
    : ''
  if (visibleText !== draft.objective) {
    throw new Error('The submitted goal must match the visible user request')
  }
  return draft
}

function threadGoalControlFromRequest(
  request: CodexChatRequest
): NonNullable<CodexChatRequest['body']>['threadGoalControl'] {
  const control = request.body?.threadGoalControl
  if (!control) return undefined
  if (request.trigger !== 'goal-control' || !request.body?.threadId) {
    throw new Error('Existing-thread Goal control requires a persisted conversation')
  }
  if (request.body.threadGoalDraft) {
    throw new Error('Goal control cannot also create a new conversation Goal')
  }
  return control
}

function isTerminalGoal(goal: ThreadGoalSummary | null): boolean {
  if (goal === null) return true
  return (
    goal.status === 'paused' ||
    goal.status === 'blocked' ||
    goal.status === 'usageLimited' ||
    goal.status === 'budgetLimited' ||
    goal.status === 'complete'
  )
}

function shouldStartFreshTerminalRetry(request: CodexChatRequest): boolean {
  return request.trigger === 'regenerate-message' && request.body?.retryTerminalTurn === true
}

function conversationTitleFromRequest(request: CodexChatRequest): string | null {
  const latestUserMessage = request.messages.findLast((message) => message.role === 'user')
  if (!latestUserMessage) return null

  const fullText = latestUserMessage.parts
    .map((part) => {
      if (part.type !== 'text') return ''
      return typeof part.text === 'string' ? part.text : ''
    })
    .filter(Boolean)
    .join('\n')
  const title = extractVisibleUserRequest(fullText).trim()

  return title ? title : null
}

function steeringCompareKey(message: CodexChatRequest['messages'][number]): string {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
  const attachments = message.parts.flatMap<
    { type: 'image'; url: string } | { type: 'localImage'; path: string }
  >((part) => {
    if (part.type !== 'file' || !part.mediaType.startsWith('image/')) return []
    try {
      const url = new URL(part.url)
      if (url.protocol === 'file:') {
        return [{ type: 'localImage' as const, path: fileURLToPath(url) }]
      }
      return [{ type: 'image' as const, url: url.href }]
    } catch {
      return [{ type: 'image' as const, url: part.url }]
    }
  })
  return JSON.stringify({ text, attachments })
}

function compareKeyForClaimedMessage(
  request: CodexChatRequest,
  messageId: string
): string | undefined {
  const message = request.messages.find((candidate) => candidate.id === messageId)
  if (!message) return undefined
  const normalized = restoreLocalMediaFileUrlsForModel([message])[0] ?? message
  return steeringCompareKey(normalized)
}

async function normalizeProjectAssignmentThreadId({
  projectStore,
  fromId,
  toId
}: {
  projectStore?: ProjectStoreLike
  fromId: string
  toId: string
}): Promise<void> {
  if (!projectStore || fromId === toId) return

  const state = await projectStore.getState()
  const assignment = state.threadProjectAssignments[fromId]
  if (!assignment) return

  const threadProjectAssignments = { ...state.threadProjectAssignments }
  delete threadProjectAssignments[fromId]
  threadProjectAssignments[toId] = threadProjectAssignments[toId] ?? assignment

  await projectStore.setState({
    ...state,
    threadProjectAssignments
  })
}

function extractCodexThreadId(chunk: UIMessageChunk): string | undefined {
  if (!isRecord(chunk)) return undefined
  const threadId = readCodexMessageMetadata(chunk['providerMetadata'])?.threadId
  return typeof threadId === 'string' && threadId.length > 0 ? threadId : undefined
}

function extractCodexTurnId(chunk: UIMessageChunk): string | undefined {
  if (!isRecord(chunk)) return undefined
  const turnId = readCodexMessageMetadata(chunk['providerMetadata'])?.turnId
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toToolUserInputAnswers(
  answers: Record<string, string[]>
): Record<string, { answers: string[] }> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, questionAnswers]) => [
      questionId,
      { answers: questionAnswers }
    ])
  )
}

export function commandApprovalDecisionFromResponse(
  params: unknown,
  response: CodexApprovalResponse
): unknown {
  if (response.action === 'approve') return 'accept'
  if (response.action === 'approveForSession') return 'acceptForSession'
  if (response.action === 'approveWithExecpolicyAmendment') {
    return findAvailableCommandDecision(params, 'acceptWithExecpolicyAmendment') ?? 'cancel'
  }
  if (response.action === 'applyNetworkPolicyAmendment') {
    return findAvailableCommandDecision(params, 'applyNetworkPolicyAmendment') ?? 'cancel'
  }
  if (response.action === 'decline') return 'decline'
  return 'cancel'
}

export function mcpElicitationResponseFromApprovalResponse(
  response: CodexApprovalResponse
): McpElicitationResponse {
  if (response.action === 'submitMcpForm') {
    return { action: 'accept' as const, content: response.values, _meta: null }
  }
  if (response.action === 'approve') {
    return { action: 'accept' as const, content: null, _meta: null }
  }
  if (response.action === 'cancel') {
    return { action: 'cancel' as const, content: null, _meta: null }
  }
  return {
    action: 'decline' as const,
    content: null,
    _meta: response.action === 'decline' ? { reason: response.reason ?? null } : null
  }
}

export function permissionsApprovalResponseFromApprovalResponse(
  params: unknown,
  response: CodexApprovalResponse
): { permissions: Record<string, unknown>; scope: 'turn' | 'session' } {
  if (response.action !== 'approvePermissions') return { permissions: {}, scope: 'turn' }
  const permissions = asRecord(params)?.permissions
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return { permissions: {}, scope: 'turn' }
  }
  return {
    permissions: permissions as Record<string, unknown>,
    scope: response.scope
  }
}

function findAvailableCommandDecision(
  params: unknown,
  key: 'acceptWithExecpolicyAmendment' | 'applyNetworkPolicyAmendment'
): unknown {
  const record = asRecord(params)
  const decisions = Array.isArray(record?.availableDecisions) ? record.availableDecisions : []
  return decisions.find((decision) => Boolean(asRecord(decision)?.[key]))
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function withDynamicToolCallThread(
  params: unknown,
  threadId: string | undefined
): Record<string, unknown> {
  const call = { ...(asRecord(params) ?? {}) }
  delete call.threadId
  return {
    ...call,
    ...(threadId ? { threadId } : {})
  }
}

function isAbortMessage(value: unknown): value is { type: 'abort'; runId?: string } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'abort' &&
    (!('runId' in value) ||
      typeof (value as { runId?: unknown }).runId === 'undefined' ||
      typeof (value as { runId?: unknown }).runId === 'string')
  )
}

function isThreadBoundAcknowledgement(
  value: unknown
): value is { type: 'thread-bound-ack'; threadId: string } {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'thread-bound-ack' &&
    typeof (value as { threadId?: unknown }).threadId === 'string'
  )
}

function turnLifecycleEventForRenderer(event: CodexTurnLifecycleEvent): CodexTurnLifecycleEvent {
  switch (event.type) {
    case 'turn-started':
      return event
    case 'item-started':
    case 'item-completed':
      return {
        type: event.type,
        sequence: event.sequence,
        threadId: event.threadId,
        turnId: event.turnId,
        itemId: event.itemId,
        itemType: event.itemType,
        ...(event.clientUserMessageId ? { clientUserMessageId: event.clientUserMessageId } : {}),
        ...(event.compareKey ? { compareKey: event.compareKey } : {})
      }
    case 'turn-completed':
      return {
        type: event.type,
        sequence: event.sequence,
        threadId: event.threadId,
        turnId: event.turnId,
        outcome: event.outcome
      }
    default:
      throw new Error('Unsupported turn lifecycle event')
  }
}

function turnFailureDetail(event: CodexTurnLifecycleEvent): string | undefined {
  if (event.type !== 'turn-completed') return undefined
  const detail = (event as { error?: unknown }).error
  return typeof detail === 'string' && detail.trim() ? detail : undefined
}

function errorMessage(error: unknown): string {
  if (isMissingCodexCliError(error)) {
    return '未找到 Codex CLI。请安装 Codex CLI、将 codex 加入 PATH 并完成登录后重试。'
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('thread_reference_limit_exceeded')) {
    return '每条消息最多引用 3 个任务'
  }
  if (message.includes('thread_reference_read_failed')) {
    return '无法加载引用的任务'
  }
  return sanitizeUserFacingError(message)
}

function isMissingCodexCliError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' && /\bcodex(?:\.exe)?\b/iu.test(error.message)) return true
  return /\bspawn\s+codex(?:\.exe)?\s+enoent\b/iu.test(error.message)
}

function canResumeActiveTurnAfterTransportError(
  run: ActiveConversationRun,
  code: CodexRunRecoveryErrorCode | undefined
): boolean {
  if (
    run.interruptReason ||
    run.transportRecoveryAttempted ||
    !run.threadId ||
    !run.turnId ||
    run.existingTurnRecoveryState?.turnId !== run.turnId
  ) {
    return false
  }
  return code === 'app_server_transport_closed' || code === 'app_server_transport_terminated'
}

type CodexRunRecoveryErrorCode =
  | 'app_server_transport_closed'
  | 'app_server_transport_terminated'
  | 'active_turn_unavailable'

function codexRunRecoveryErrorCode(error: unknown): CodexRunRecoveryErrorCode | undefined {
  const code = isRecord(error) ? error.code : error instanceof Error ? error.message : error
  switch (code) {
    case 'app_server_transport_closed':
    case 'app_server_transport_terminated':
    case 'active_turn_unavailable':
      return code
    default:
      return undefined
  }
}

function cloneRecoveryMessages(messages: readonly UIMessage[]): UIMessage[] {
  return [...structuredClone(messages)]
}

function chatStreamErrorMessage(error: CodexChatStreamError): string {
  return typeof error === 'string' ? error : error.message
}

function sanitizeUserFacingError(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return '模型响应未完成，请重试。'

  const redacted = trimmed
    .replace(/(\bauthorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/(\bapi[_-]?key\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[REDACTED]')
    .replace(/\bsk-[a-z0-9_-]{6,}\b/giu, 'sk-[REDACTED]')

  if (redacted.length <= 2_000) return redacted
  return `${redacted.slice(0, 1_999)}…`
}

function steerFailureDisposition(error: unknown): {
  status: 'queued' | 'paused-failed' | 'paused-recovery-uncertain'
  kind: 'steer-rejected' | 'turn-race' | 'attachment-unavailable' | 'recovery-uncertain'
  userMessage: string
} {
  const code = isCodexSteerError(error) ? error.code : undefined
  const userMessage = followUpErrorMessage(error)
  switch (code) {
    case 'expected_turn_mismatch':
    case 'session_inactive':
    case 'unsupported_active_turn_kind':
      return { status: 'queued', kind: 'turn-race', userMessage }
    case 'attachment_resolution_failed':
      return { status: 'paused-failed', kind: 'attachment-unavailable', userMessage }
    default:
      return { status: 'paused-failed', kind: 'steer-rejected', userMessage }
  }
}

function isCodexSteerError(error: unknown): error is { code: CodexSteerErrorCode } {
  return error instanceof CodexSteerError
}

function terminalSteerFailureDisposition(
  terminalEvent: CodexChatStreamEvent | undefined,
  resultUncertain: boolean
): FollowUpClaimFailure {
  if (resultUncertain) {
    return {
      status: 'paused-recovery-uncertain',
      kind: 'recovery-uncertain',
      userMessage: 'The task ended before the steer result could be confirmed.'
    }
  }
  if (terminalEvent?.type === 'aborted') {
    return {
      status: 'paused-recovery-uncertain',
      kind: 'recovery-uncertain',
      userMessage: 'The task stopped before the steer was acknowledged.'
    }
  }
  if (terminalEvent?.type === 'error') {
    return {
      status: 'paused-failed',
      kind: 'steer-rejected',
      userMessage: chatStreamErrorMessage(terminalEvent.error)
    }
  }
  return {
    status: 'paused-failed',
    kind: 'steer-rejected',
    userMessage: 'The task ended before the steer was acknowledged.'
  }
}

async function readTurnOutcomeFromHistory(
  historyClient: CodexHistoryClient | undefined,
  threadId: string,
  turnId: string
): Promise<'completed' | 'interrupted' | 'failed' | undefined> {
  if (!historyClient) return undefined
  const thread = await historyClient.readThread(threadId, { includeTurns: true })
  const status = thread.turns.find((turn) => turn.id === turnId)?.status
  return status === 'completed' || status === 'interrupted' || status === 'failed'
    ? status
    : undefined
}

function followUpErrorMessage(error: unknown): string {
  const message = errorMessage(error).trim()
  if (!message) return 'The steer operation failed.'
  if (message.length <= 2_000) return message
  return `${message.slice(0, 1_999)}…`
}
