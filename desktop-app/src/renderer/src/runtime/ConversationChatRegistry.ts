import type { ChatStatus, UIMessage } from 'ai'

import {
  LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
  LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE
} from '../../../shared/composerContext'
import type {
  DesktopCodexChatApi,
  SidebarConversation,
  SidebarConversationOpenResult,
  ThreadGoalLoadResult,
  ThreadGoalSummary
} from '../../../shared/codexIpcApi'
import type { ProjectSelection } from '../../../shared/projects/projectTypes'
import {
  ElectronIpcChatTransport,
  type ActiveConversationContext
} from '../lib/ElectronIpcChatTransport'
import {
  ConversationDraftStore,
  type ConversationApprovalModeKind,
  type ConversationComposerModeKind,
  type ConversationDraftAttachment
} from './ConversationDraftStore'
import {
  ConversationTranscriptController,
  type ConversationTranscriptMessage
} from './ConversationTranscriptController'
import { ConversationTranscriptRecoveryStore } from './ConversationTranscriptRecoveryStore'
import { classifyConversationRecoveryError } from './classifyConversationRecoveryError'

export type ConversationScrollSnapshot = {
  scrollTop: number
  followBottom: boolean
}

export type ConversationEntryStatus = 'loading' | ChatStatus
export type ConversationRecoveryPhase = 'attached' | 'needs_resume' | 'resuming' | 'resumed'
export type GoalCapabilityStatus = 'unknown' | 'available' | 'unsupported' | 'error'

export type ConversationChatEntry = {
  readonly localId: string
  readonly newConversation: boolean
  readonly controller: ConversationTranscriptController
  readonly transport: ElectronIpcChatTransport
  readonly messages: readonly ConversationTranscriptMessage[]
  context: ActiveConversationContext
  status: ConversationEntryStatus
  error?: Error
  recoveryError?: Error
  selectedModelId?: string
  modelSelectionError?: string
  unread: boolean
  draft: string
  draftAttachments: readonly ConversationDraftAttachment[]
  composerModeKind: ConversationComposerModeKind
  approvalModeKind: ConversationApprovalModeKind
  goalEditorActive: boolean
  threadGoal: ThreadGoalSummary | null | undefined
  goalCapabilityStatus: GoalCapabilityStatus
  goalOperation: 'idle' | 'setting' | 'clearing'
  goalError?: string
  scroll?: ConversationScrollSnapshot
  loaded: boolean
  recoveryPhase: ConversationRecoveryPhase
}

export type ConversationChatRegistrySnapshot = {
  activeEntry: ConversationChatEntry
  entries: readonly ConversationChatEntry[]
  version: number
}

export type ConversationChatRegistryOptions = {
  chatBridge: DesktopCodexChatApi
  selectedModelId?: string
  draftStore?: ConversationDraftStore
  transcriptRecoveryStore?: ConversationTranscriptRecoveryStore
  createId?: () => string
  onStreamStarted?: (conversationId: string) => void
  loadThreadGoal?: (threadId: string) => Promise<ThreadGoalLoadResult>
}

type InternalConversationChatEntry = ConversationChatEntry & {
  messages: readonly ConversationTranscriptMessage[]
  unsubscribeController: () => void
  historyRevision?: string | null
  recoveryAttempts: number
  recoveryRetryTimer?: ReturnType<typeof setTimeout>
}

export class ConversationChatRegistry {
  private readonly chatBridge: DesktopCodexChatApi
  private readonly draftStore: ConversationDraftStore
  private readonly transcriptRecoveryStore: ConversationTranscriptRecoveryStore
  private readonly createId: () => string
  private readonly onStreamStarted: ((conversationId: string) => void) | undefined
  private readonly loadThreadGoal: ((threadId: string) => Promise<ThreadGoalLoadResult>) | undefined
  private readonly entriesByLocalId = new Map<string, InternalConversationChatEntry>()
  private readonly aliases = new Map<string, InternalConversationChatEntry>()
  private readonly conversationMetadata = new Map<string, SidebarConversation>()
  private readonly inFlightHistoryLoads = new Map<string, Promise<ConversationChatEntry>>()
  private readonly listeners = new Set<() => void>()
  private readonly recoveryHydrations = new Set<InternalConversationChatEntry>()
  private activeEntry: InternalConversationChatEntry
  private navigationEpoch = 0
  private version = 0
  private snapshot: ConversationChatRegistrySnapshot
  private destroyed = false
  private defaultSelectedModelId: string | undefined

  constructor(options: ConversationChatRegistryOptions) {
    this.chatBridge = options.chatBridge
    this.defaultSelectedModelId = options.selectedModelId
    this.draftStore = options.draftStore ?? new ConversationDraftStore()
    this.transcriptRecoveryStore =
      options.transcriptRecoveryStore ?? new ConversationTranscriptRecoveryStore()
    this.createId = options.createId ?? createLocalConversationId
    this.onStreamStarted = options.onStreamStarted
    this.loadThreadGoal = options.loadThreadGoal
    this.activeEntry = this.createEntry({
      localId: this.createId(),
      projectSelection: undefined,
      loaded: true,
      newConversation: true
    })
    this.snapshot = this.buildSnapshot()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ConversationChatRegistrySnapshot => this.snapshot

  startNewConversation(projectSelection?: ProjectSelection): ConversationChatEntry {
    this.assertUsable()
    const entry = this.prepareNewConversation(projectSelection)
    this.navigationEpoch += 1
    this.activate(this.internalEntry(entry))
    return entry
  }

  prepareNewConversation(projectSelection?: ProjectSelection): ConversationChatEntry {
    this.assertUsable()
    return this.createEntry({
      localId: this.createId(),
      projectSelection,
      loaded: true,
      newConversation: true
    })
  }

  activateConversation(entry: ConversationChatEntry): void {
    this.assertUsable()
    this.navigationEpoch += 1
    this.activate(this.internalEntry(entry))
  }

  /**
   * Restores a renderer-local conversation before app-server has assigned its
   * durable thread id. The main process owns that short-lived identity, so it
   * is safe to use it to attach the replacement renderer without starting a
   * second turn.
   */
  async restoreActiveConversation(conversationId: string): Promise<boolean> {
    this.assertUsable()
    const recoverySnapshot = await this.chatBridge.getActiveSnapshot?.(conversationId)
    const activeRun =
      recoverySnapshot?.run ?? (await this.chatBridge.getActiveRun?.(conversationId))
    if (!activeRun) return false
    // The app-server history is already authoritative after a terminal turn.
    // Terminal journal replay remains available for a detached MessagePort, but
    // must not replace that complete history during application startup.
    if (activeRun.state === 'terminal') return false

    let entry =
      this.resolveInternal(conversationId) ??
      this.resolveInternal(activeRun.conversationId) ??
      this.resolveInternal(activeRun.threadId)
    const createdEntry = !entry
    if (!entry) {
      entry = this.createEntry({
        localId: conversationId,
        projectSelection: undefined,
        loaded: true,
        newConversation: false
      })
    }
    if (activeRun.threadId) {
      const boundEntry = this.bindThread(entry, activeRun.threadId) as InternalConversationChatEntry
      if (boundEntry !== entry) {
        // A thread-id restore can arrive before its renderer-local identity.
        // Keep one controller and retain both lookup aliases for the run.
        if (createdEntry) this.removeEntry(entry, boundEntry)
        entry = boundEntry
      }
    }
    this.bindAlias(entry, activeRun.conversationId)
    this.bindAlias(entry, conversationId)
    if (createdEntry && entry.localId === conversationId && recoverySnapshot?.baseMessages.length) {
      entry.controller.replaceMessages(recoverySnapshot.baseMessages)
    }
    entry.context = {
      ...entry.context,
      conversationId,
      threadId: activeRun.threadId ?? entry.context.threadId
    }
    entry.loaded = true
    this.activate(entry)
    // A startup recovery probe can overlap with a stream that this renderer
    // has just started. That entry already owns its MessagePort; attaching a
    // second replay stream would reset the shared transcript ledger and let an
    // empty replay snapshot overwrite live text.
    if (!isRunningStatus(entry.status) && entry.recoveryPhase !== 'resuming') {
      this.resumeEntry(entry)
    }
    return true
  }

  async restoreSingleActiveConversation(): Promise<boolean> {
    const activeRuns = await this.chatBridge.getActiveRuns?.()
    if (!activeRuns || activeRuns.length !== 1) return false
    return this.restoreActiveConversation(activeRuns[0].conversationId)
  }

  async openConversation(
    conversationId: string,
    load: () => Promise<SidebarConversationOpenResult>
  ): Promise<ConversationChatEntry> {
    this.assertUsable()
    const knownEntry = this.resolveInternal(conversationId)
    if (knownEntry?.loaded) {
      this.activate(knownEntry)
      return knownEntry
    }

    const inFlightLoad =
      this.inFlightHistoryLoads.get(conversationId) ??
      (knownEntry ? this.inFlightHistoryLoads.get(knownEntry.localId) : undefined)
    if (inFlightLoad) {
      if (knownEntry) this.activate(knownEntry)
      return inFlightLoad
    }

    const navigationEpoch = ++this.navigationEpoch

    const metadata = this.conversationMetadata.get(conversationId)
    const metadataProjectSelection = projectSelectionFromAssignment(metadata?.projectAssignment)
    const entry =
      knownEntry ??
      this.createEntry({
        localId: conversationId,
        projectSelection: metadataProjectSelection,
        loaded: false,
        status: 'loading',
        newConversation: false
      })
    if (metadata) {
      entry.context = {
        ...entry.context,
        conversationId: metadata.id,
        title: metadata.title,
        projectSelection: metadataProjectSelection ?? entry.context.projectSelection,
        cwd: metadata.cwd ?? entry.context.cwd
      }
    }
    entry.status = 'loading'
    entry.error = undefined
    this.activate(entry)

    const historyLoad = this.loadConversationHistory(entry, navigationEpoch, load)
    this.inFlightHistoryLoads.set(conversationId, historyLoad)
    this.inFlightHistoryLoads.set(entry.localId, historyLoad)

    try {
      return await historyLoad
    } finally {
      for (const [identity, pendingLoad] of this.inFlightHistoryLoads) {
        if (pendingLoad === historyLoad) this.inFlightHistoryLoads.delete(identity)
      }
    }
  }

  bindThread(
    entryOrIdentity: ConversationChatEntry | string,
    threadId: string,
    allowFreshTerminalRetry = false
  ): ConversationChatEntry {
    const entry = this.internalEntry(entryOrIdentity)
    if (entry.context.threadId && entry.context.threadId !== threadId) {
      if (!allowFreshTerminalRetry) {
        entry.status = 'error'
        entry.error = new Error(
          `Conversation ${entry.localId} is already bound to thread ${entry.context.threadId}`
        )
        this.emit()
        return entry
      }
      this.releaseSupersededThreadAliases(entry)
    }

    const existingEntry = this.resolveInternal(threadId)
    if (existingEntry && existingEntry !== entry) {
      if (isRunningStatus(entry.status) && !isRunningStatus(existingEntry.status)) {
        return this.mergePlaceholderIntoLiveEntry(entry, existingEntry, threadId)
      }
      return existingEntry
    }

    const previousDraftIdentity = entry.context.threadId ?? entry.localId
    this.bindAlias(entry, threadId)
    entry.context = {
      ...entry.context,
      ...(allowFreshTerminalRetry ? { conversationId: threadId } : {}),
      threadId
    }
    entry.draft = this.draftStore.migrate(previousDraftIdentity, threadId)
    entry.draftAttachments = this.draftStore.getAttachments(threadId)
    entry.composerModeKind = this.draftStore.getComposerModeKind(threadId)
    entry.approvalModeKind = this.draftStore.getApprovalModeKind(threadId)
    this.transcriptRecoveryStore.migrate(previousDraftIdentity, threadId)
    entry.loaded = true
    this.emit()
    return entry
  }

  applyConversationMetadata(conversations: readonly SidebarConversation[]): void {
    this.conversationMetadata.clear()
    let changed = false
    for (const conversation of conversations) {
      this.conversationMetadata.set(conversation.id, conversation)
      const threadIdentity = conversation.threadId ?? conversation.id
      const originEntry = this.resolveInternal(conversation.originConversationId)
      const existingThreadEntry = this.resolveInternal(threadIdentity)
      let entry = originEntry ?? existingThreadEntry
      if (!entry) continue
      if (originEntry && existingThreadEntry && originEntry !== existingThreadEntry) {
        entry = this.mergePlaceholderIntoLiveEntry(originEntry, existingThreadEntry, threadIdentity)
      } else if (originEntry && originEntry.context.threadId !== threadIdentity) {
        entry = this.bindThread(originEntry, threadIdentity, true) as InternalConversationChatEntry
      }
      const projectSelection = projectSelectionFromAssignment(conversation.projectAssignment)
      const context: ActiveConversationContext = {
        ...entry.context,
        conversationId: conversation.id,
        threadId: conversation.threadId ?? entry.context.threadId,
        title: conversation.title,
        projectSelection: projectSelection ?? entry.context.projectSelection,
        cwd: conversation.cwd ?? entry.context.cwd
      }
      if (sameConversationContext(entry.context, context)) continue
      entry.context = context
      changed = true
    }
    if (changed) this.emit()
  }

  resolve(identity: string | undefined): ConversationChatEntry | undefined {
    return this.resolveInternal(identity)
  }

  updateActiveProjectSelection(projectSelection: ProjectSelection | undefined): void {
    const entry = this.activeEntry
    if (entry.context.threadId || entry.messages.length > 0 || entry.status !== 'ready') return
    if (sameProjectSelection(entry.context.projectSelection, projectSelection)) return
    entry.context = { ...entry.context, projectSelection }
    this.emit()
  }

  setDraft(entryOrIdentity: ConversationChatEntry | string, draft: string): void {
    const entry = this.internalEntry(entryOrIdentity)
    if (entry.draft === draft) return
    entry.draft = draft
    this.draftStore.set(entry.context.threadId ?? entry.localId, draft)
    this.emit()
  }

  setDraftAttachments(
    entryOrIdentity: ConversationChatEntry | string,
    attachments: readonly ConversationDraftAttachment[]
  ): void {
    const entry = this.internalEntry(entryOrIdentity)
    if (JSON.stringify(entry.draftAttachments) === JSON.stringify(attachments)) return
    entry.draftAttachments = attachments.map((attachment) => ({ ...attachment }))
    this.draftStore.setAttachments(entry.context.threadId ?? entry.localId, entry.draftAttachments)
    this.emit()
  }

  setComposerModeKind(
    entryOrIdentity: ConversationChatEntry | string,
    composerModeKind: ConversationComposerModeKind
  ): void {
    const entry = this.internalEntry(entryOrIdentity)
    if (entry.composerModeKind === composerModeKind) return
    entry.composerModeKind = composerModeKind
    if (composerModeKind !== 'default') entry.goalEditorActive = false
    this.draftStore.setComposerModeKind(entry.context.threadId ?? entry.localId, composerModeKind)
    this.emit()
  }

  setApprovalModeKind(
    entryOrIdentity: ConversationChatEntry | string,
    approvalModeKind: ConversationApprovalModeKind
  ): void {
    const entry = this.internalEntry(entryOrIdentity)
    if (entry.approvalModeKind === approvalModeKind) return
    entry.approvalModeKind = approvalModeKind
    this.draftStore.setApprovalModeKind(entry.context.threadId ?? entry.localId, approvalModeKind)
    this.emit()
  }

  setGoalEditorActive(
    entryOrIdentity: ConversationChatEntry | string,
    goalEditorActive: boolean
  ): void {
    const entry = this.internalEntry(entryOrIdentity)
    if (goalEditorActive && entry.composerModeKind !== 'default') {
      this.setComposerModeKind(entry, 'default')
    }
    if (entry.goalEditorActive === goalEditorActive) return
    entry.goalEditorActive = goalEditorActive
    this.emit()
  }

  setThreadGoal(
    entryOrIdentity: ConversationChatEntry | string,
    threadGoal: ThreadGoalSummary | null | undefined
  ): void {
    const entry = this.internalEntry(entryOrIdentity)
    entry.threadGoal = threadGoal
    entry.goalOperation = 'idle'
    entry.goalError = undefined
    this.emit()
  }

  setGoalOperation(
    entryOrIdentity: ConversationChatEntry | string,
    goalOperation: ConversationChatEntry['goalOperation'],
    goalError?: string
  ): void {
    const entry = this.internalEntry(entryOrIdentity)
    entry.goalOperation = goalOperation
    entry.goalError = goalError
    this.emit()
  }

  applyDefaultModel(modelId: string | undefined): void {
    this.defaultSelectedModelId = modelId
    let changed = false
    for (const entry of this.entriesByLocalId.values()) {
      if (entry.selectedModelId) continue
      entry.selectedModelId = modelId
      changed = true
    }
    if (changed) this.emit()
  }

  setSelectedModel(entryOrIdentity: ConversationChatEntry | string, modelId: string): void {
    const entry = this.internalEntry(entryOrIdentity)
    entry.selectedModelId = modelId
    entry.modelSelectionError = undefined
    this.emit()
  }

  setModelSelectionError(entryOrIdentity: ConversationChatEntry | string, error: string): void {
    const entry = this.internalEntry(entryOrIdentity)
    entry.modelSelectionError = error
    this.emit()
  }

  setScroll(
    entryOrIdentity: ConversationChatEntry | string,
    scroll: ConversationScrollSnapshot
  ): void {
    const entry = this.findInternalEntry(entryOrIdentity)
    if (!entry) return
    entry.scroll = scroll
  }

  markRead(entryOrIdentity: ConversationChatEntry | string): void {
    const entry = this.internalEntry(entryOrIdentity)
    if (!entry.unread) return
    entry.unread = false
    this.emit()
  }

  markUnreadByThread(threadId: string | undefined): void {
    const entry = this.resolve(threadId) as InternalConversationChatEntry | undefined
    if (!entry || entry === this.activeEntry || entry.unread) return
    entry.unread = true
    this.emit()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const entry of this.entriesByLocalId.values()) {
      if (entry.recoveryRetryTimer !== undefined) clearTimeout(entry.recoveryRetryTimer)
      entry.unsubscribeController()
    }
    this.entriesByLocalId.clear()
    this.aliases.clear()
    this.conversationMetadata.clear()
    this.inFlightHistoryLoads.clear()
    this.listeners.clear()
    this.transcriptRecoveryStore.flushPendingActiveTextFallbacks()
  }

  private async loadConversationHistory(
    entry: InternalConversationChatEntry,
    navigationEpoch: number,
    load: () => Promise<SidebarConversationOpenResult>
  ): Promise<ConversationChatEntry> {
    try {
      const result = await load()
      if (this.destroyed) return entry

      const canonicalEntry =
        this.resolveInternal(result.threadId) ?? this.resolveInternal(result.conversationId)
      if (canonicalEntry && canonicalEntry !== entry) {
        this.removeEntry(entry, canonicalEntry)
        if (this.navigationEpoch === navigationEpoch) this.activate(canonicalEntry)
        else this.emit()
        return canonicalEntry
      }

      this.bindAlias(entry, result.conversationId)
      const boundEntry = this.bindThread(entry, result.threadId) as InternalConversationChatEntry
      if (boundEntry !== entry) {
        this.removeEntry(entry, boundEntry)
        if (this.navigationEpoch === navigationEpoch) this.activate(boundEntry)
        else this.emit()
        return boundEntry
      }

      entry.context = {
        conversationId: result.conversationId,
        threadId: result.threadId,
        title: result.title,
        projectSelection: projectSelectionFromOpenResult(result),
        cwd: result.cwd
      }
      entry.historyRevision = result.historyRevision
      if (result.threadGoalResult?.status === 'loaded') {
        entry.threadGoal = result.threadGoalResult.goal
        entry.goalCapabilityStatus = 'available'
        entry.goalError = undefined
      } else if (result.threadGoalResult?.status === 'unsupported') {
        entry.threadGoal = undefined
        entry.goalCapabilityStatus = 'unsupported'
        entry.goalError = result.threadGoalResult.message
      } else if (result.threadGoalResult?.status === 'error') {
        entry.threadGoal = undefined
        entry.goalCapabilityStatus = 'error'
        entry.goalError = result.threadGoalResult.message
      }
      this.recoveryHydrations.add(entry)
      try {
        entry.controller.replaceMessages(
          mergeRecoveryHistory(
            this.transcriptRecoveryStore,
            [result.threadId, result.conversationId, entry.localId],
            result.messages,
            result.historyRevision
          )
        )
      } finally {
        this.recoveryHydrations.delete(entry)
      }
      entry.messages = entry.controller.getSnapshot().messages
      entry.status = 'ready'
      entry.error = undefined
      entry.loaded = true
      if (this.navigationEpoch === navigationEpoch) this.activate(entry)
      else this.emit()
      // The history response is a point-in-time snapshot. A live run is
      // reattached after hydration so replayed chunks merge into this entry.
      entry.recoveryAttempts = 0
      this.resumeEntry(entry)
      return entry
    } catch (error) {
      entry.status = 'error'
      entry.error = toError(error)
      if (entry !== this.activeEntry) entry.unread = true
      this.emit()
      return entry
    }
  }

  private createEntry(input: {
    localId: string
    projectSelection: ProjectSelection | undefined
    loaded: boolean
    status?: ConversationEntryStatus
    newConversation: boolean
  }): InternalConversationChatEntry {
    const existing = this.entriesByLocalId.get(input.localId)
    if (existing) return existing

    const entry = {} as InternalConversationChatEntry
    const transport = new ElectronIpcChatTransport({
      chatBridge: this.chatBridge,
      getActiveConversation: () => entry.context,
      getProjectSelection: () => entry.context.projectSelection,
      getComposerModeKind: () => entry.composerModeKind,
      getApprovalModeKind: () => entry.approvalModeKind,
      getGoalEditorActive: () => entry.goalEditorActive,
      getGoalEditorObjective: () => entry.draft,
      getSelectedModelId: () => entry.selectedModelId ?? this.defaultSelectedModelId,
      onStreamStarted: () => {
        this.onStreamStarted?.(entry.context.threadId ?? entry.localId)
        entry.controller.handleStreamStarted()
      },
      onThreadBound: ({ threadId, startsFreshTerminalRetry }) => {
        const boundEntry = this.bindThread(entry, threadId, startsFreshTerminalRetry === true)
        if (boundEntry !== entry) {
          entry.status = 'error'
          entry.error = new Error(`Thread ${threadId} is already owned by another conversation`)
          this.emit()
        }
      },
      onTurnLifecycle: (event) => entry.controller.handleTurnLifecycle(event),
      onModeApplied: (threadId, modeKind) => {
        if (entry.context.threadId && entry.context.threadId !== threadId) return
        this.setComposerModeKind(entry, modeKind)
      },
      onThreadGoal: (threadId, goal) => {
        if (entry.context.threadId && entry.context.threadId !== threadId) return
        entry.threadGoal = goal
        entry.goalCapabilityStatus = 'available'
        const shouldClearGoalDraft = entry.goalEditorActive && goal !== null
        entry.goalEditorActive = false
        entry.goalOperation = 'idle'
        entry.goalError = undefined
        if (shouldClearGoalDraft) this.clearDraft(entry)
        this.emit()
      },
      onStreamAccepted: () => entry.controller.handleStreamAccepted(),
      onStreamAborted: () => entry.controller.handleStreamAborted(),
      onStreamError: (error) => entry.controller.handleStreamError(error),
      onStreamFinished: ({ threadId }) => {
        if (!threadId) return
        this.bindThread(entry, threadId)
        if (entry.goalEditorActive) void this.refreshThreadGoalAfterFirstTurn(entry, threadId)
      }
    })
    const context: ActiveConversationContext = {
      conversationId: input.localId,
      projectSelection: input.projectSelection
    }
    const stableDraftIdentity = context.threadId ?? input.localId
    const controller = new ConversationTranscriptController({ id: input.localId, transport })
    Object.assign(entry, {
      localId: input.localId,
      newConversation: input.newConversation,
      controller,
      transport,
      messages: controller.getSnapshot().messages,
      context,
      status: input.status ?? 'ready',
      selectedModelId: this.defaultSelectedModelId,
      unread: false,
      draft: this.draftStore.get(stableDraftIdentity),
      draftAttachments: this.draftStore.getAttachments(stableDraftIdentity),
      composerModeKind: this.draftStore.getComposerModeKind(stableDraftIdentity),
      approvalModeKind: this.draftStore.getApprovalModeKind(stableDraftIdentity),
      goalEditorActive: false,
      threadGoal: undefined,
      goalCapabilityStatus: 'unknown',
      goalOperation: 'idle',
      loaded: input.loaded,
      recoveryPhase: 'attached',
      recoveryAttempts: 0,
      unsubscribeController: () => undefined
    } satisfies InternalConversationChatEntry)
    let previousControllerStatus = controller.getSnapshot().status
    let previousControllerError = controller.getSnapshot().error
    entry.unsubscribeController = controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      const previousEntryDraft = entry.draft
      const previousEntryDraftAttachments = entry.draftAttachments
      const completedSuccessfulTurn =
        isRunningStatus(previousControllerStatus) && snapshot.status === 'ready' && !snapshot.error
      const semanticStatusChanged =
        previousControllerStatus !== snapshot.status || previousControllerError !== snapshot.error
      previousControllerStatus = snapshot.status
      previousControllerError = snapshot.error
      entry.messages = snapshot.messages
      entry.status = snapshot.status
      entry.error = snapshot.error
      const recoveryIdentity =
        entry.context.threadId ?? entry.context.conversationId ?? entry.localId
      if (!this.recoveryHydrations.has(entry) && hasLocalPathAttachments(snapshot.messages)) {
        this.transcriptRecoveryStore.saveLocalAttachmentOverlay(
          recoveryIdentity,
          attachmentOverlaySourceFromTranscript(snapshot.messages),
          entry.historyRevision
        )
      }
      if (!this.recoveryHydrations.has(entry)) {
        if (completedSuccessfulTurn) {
          this.transcriptRecoveryStore.clearTerminalFallback(recoveryIdentity)
          this.transcriptRecoveryStore.clearActiveTextFallback(recoveryIdentity)
        } else {
          this.transcriptRecoveryStore.saveTerminalFallback(
            recoveryIdentity,
            terminalRecoverySourceFromTranscript(snapshot.messages),
            entry.historyRevision
          )
          if (isRunningStatus(snapshot.status)) {
            this.transcriptRecoveryStore.saveActiveTextFallbackDeferred(
              recoveryIdentity,
              terminalRecoverySourceFromTranscript(snapshot.messages),
              entry.historyRevision
            )
          }
        }
      }
      // A new Goal is only accepted after the provider has persisted it on
      // the freshly-created thread. Keep its objective recoverable when the
      // first turn succeeds but thread/goal/set fails.
      if (controller.takeCurrentSendAcceptance() && !entry.goalEditorActive) this.clearDraft(entry)
      const unreadChanged =
        entry !== this.activeEntry && isRunningStatus(entry.status) && !entry.unread
      if (unreadChanged) entry.unread = true
      if (
        semanticStatusChanged ||
        unreadChanged ||
        previousEntryDraft !== entry.draft ||
        previousEntryDraftAttachments !== entry.draftAttachments
      ) {
        this.emit()
      }
    })
    this.entriesByLocalId.set(entry.localId, entry)
    this.aliases.set(entry.localId, entry)
    return entry
  }

  private async refreshThreadGoalAfterFirstTurn(
    entry: InternalConversationChatEntry,
    threadId: string
  ): Promise<void> {
    if (!this.loadThreadGoal || this.destroyed) return
    try {
      const result = await this.loadThreadGoal(threadId)
      if (this.destroyed || entry.context.threadId !== threadId || result.status !== 'loaded')
        return
      entry.threadGoal = result.goal
      entry.goalEditorActive = false
      entry.goalOperation = 'idle'
      entry.goalError = undefined
      this.clearDraft(entry)
      this.emit()
    } catch {
      // The completed turn remains valid if Goal metadata cannot be refreshed.
      // Leave the editor open so the user can retry rather than hiding an
      // unconfirmed objective.
    }
  }

  private clearDraft(entry: InternalConversationChatEntry): void {
    if (!entry.draft && entry.draftAttachments.length === 0) return
    entry.draft = ''
    entry.draftAttachments = []
    const identity = entry.context.threadId ?? entry.localId
    this.draftStore.set(identity, '')
    this.draftStore.setAttachments(identity, [])
  }

  private resumeEntry(entry: InternalConversationChatEntry): void {
    if (this.destroyed) return
    if (entry.recoveryPhase === 'resuming') return
    entry.recoveryPhase = 'resuming'
    entry.recoveryError = undefined
    this.emit()
    this.recoveryHydrations.add(entry)
    void this.resumeEntryFromActiveRun(entry)
  }

  private async resumeEntryFromActiveRun(entry: InternalConversationChatEntry): Promise<void> {
    try {
      const conversationId = entry.context.threadId ?? entry.context.conversationId ?? entry.localId
      const run = await this.chatBridge.getActiveRun?.(conversationId)
      if (this.destroyed) return
      if (run?.state === 'terminal') {
        entry.recoveryPhase = 'attached'
        this.emit()
        return
      }

      const resumed = await entry.controller.resumeStream()
      if (this.destroyed) return
      entry.recoveryError = entry.controller.getRecoveryError()
      if (
        !resumed &&
        entry.recoveryError &&
        !hasVisibleAssistantContent(entry.controller.getSnapshot().messages)
      ) {
        this.restoreRenderedActiveText(entry)
      }
      entry.recoveryPhase = resumed ? 'resumed' : entry.recoveryError ? 'needs_resume' : 'attached'
      this.emit()
      const diagnostic = classifyConversationRecoveryError(entry.recoveryError)
      if (
        !resumed &&
        diagnostic?.kind === 'transient-runtime' &&
        entry.recoveryAttempts === 0 &&
        entry === this.activeEntry
      ) {
        entry.recoveryAttempts = 1
        entry.recoveryRetryTimer = setTimeout(() => {
          entry.recoveryRetryTimer = undefined
          if (!this.destroyed && entry === this.activeEntry) this.resumeEntry(entry)
        }, 750)
      }
    } finally {
      this.recoveryHydrations.delete(entry)
    }
  }

  private restoreRenderedActiveText(entry: InternalConversationChatEntry): void {
    const recoveryIdentity = entry.context.threadId ?? entry.context.conversationId ?? entry.localId
    const restored = this.transcriptRecoveryStore.mergeActiveTextFallback(
      recoveryIdentity,
      terminalRecoverySourceFromTranscript(entry.controller.getSnapshot().messages)
    )
    this.recoveryHydrations.add(entry)
    try {
      entry.controller.replaceMessages(restored)
      entry.messages = entry.controller.getSnapshot().messages
    } finally {
      this.recoveryHydrations.delete(entry)
    }
  }

  private activate(entry: InternalConversationChatEntry): void {
    this.activeEntry = entry
    entry.unread = false
    this.emit()
  }

  private bindAlias(entry: InternalConversationChatEntry, identity: string): void {
    const existing = this.aliases.get(identity)
    if (existing && existing !== entry) return
    this.aliases.set(identity, entry)
  }

  private releaseSupersededThreadAliases(entry: InternalConversationChatEntry): void {
    const staleIdentities = new Set(
      [entry.context.threadId, entry.context.conversationId].filter(
        (identity): identity is string => Boolean(identity && identity !== entry.localId)
      )
    )
    for (const identity of staleIdentities) {
      if (this.aliases.get(identity) === entry) this.aliases.delete(identity)
    }
  }

  private mergePlaceholderIntoLiveEntry(
    liveEntry: InternalConversationChatEntry,
    placeholder: InternalConversationChatEntry,
    threadId: string
  ): InternalConversationChatEntry {
    const previousDraftIdentity = liveEntry.context.threadId ?? liveEntry.localId
    const placeholderWasActive = this.activeEntry === placeholder

    for (const [identity, entry] of this.aliases.entries()) {
      if (entry === placeholder) this.aliases.set(identity, liveEntry)
    }
    placeholder.unsubscribeController()
    this.entriesByLocalId.delete(placeholder.localId)
    this.aliases.set(threadId, liveEntry)

    liveEntry.context = {
      ...liveEntry.context,
      conversationId: placeholder.context.conversationId,
      threadId,
      title: placeholder.context.title ?? liveEntry.context.title,
      projectSelection: placeholder.context.projectSelection ?? liveEntry.context.projectSelection,
      cwd: placeholder.context.cwd ?? liveEntry.context.cwd
    }
    liveEntry.draft = this.draftStore.migrate(previousDraftIdentity, threadId)
    liveEntry.draftAttachments = this.draftStore.getAttachments(threadId)
    liveEntry.composerModeKind = this.draftStore.getComposerModeKind(threadId)
    liveEntry.approvalModeKind = this.draftStore.getApprovalModeKind(threadId)
    this.transcriptRecoveryStore.migrate(previousDraftIdentity, threadId)
    liveEntry.scroll ??= placeholder.scroll
    liveEntry.loaded = true
    liveEntry.unread ||= placeholder.unread

    if (placeholderWasActive) {
      this.activeEntry = liveEntry
      liveEntry.unread = false
    }
    this.emit()
    return liveEntry
  }

  private removeEntry(
    entry: InternalConversationChatEntry,
    replacement?: InternalConversationChatEntry
  ): void {
    entry.unsubscribeController()
    this.entriesByLocalId.delete(entry.localId)
    for (const [identity, value] of this.aliases.entries()) {
      if (value !== entry) continue
      if (replacement) this.aliases.set(identity, replacement)
      else this.aliases.delete(identity)
    }
  }

  private internalEntry(
    entryOrIdentity: ConversationChatEntry | string
  ): InternalConversationChatEntry {
    const entry = this.findInternalEntry(entryOrIdentity)
    if (entry) return entry
    throw new Error('Conversation entry is not registered')
  }

  private findInternalEntry(
    entryOrIdentity: ConversationChatEntry | string
  ): InternalConversationChatEntry | undefined {
    if (typeof entryOrIdentity !== 'string') {
      const entry = this.entriesByLocalId.get(entryOrIdentity.localId)
      if (entry === entryOrIdentity) return entry
      const canonicalEntry = this.aliases.get(entryOrIdentity.localId)
      if (canonicalEntry) return canonicalEntry
    } else {
      const entry = this.aliases.get(entryOrIdentity)
      if (entry) return entry
    }
    return undefined
  }

  private resolveInternal(identity: string | undefined): InternalConversationChatEntry | undefined {
    if (!identity) return undefined
    return this.aliases.get(identity)
  }

  private assertUsable(): void {
    if (this.destroyed) throw new Error('Conversation chat registry is destroyed')
  }

  private emit(): void {
    if (this.destroyed) return
    this.version += 1
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  private buildSnapshot(): ConversationChatRegistrySnapshot {
    return {
      activeEntry: this.activeEntry,
      entries: [...this.entriesByLocalId.values()],
      version: this.version
    }
  }
}

function projectSelectionFromOpenResult(
  result: SidebarConversationOpenResult
): ProjectSelection | undefined {
  return projectSelectionFromAssignment(result.projectAssignment)
}

function projectSelectionFromAssignment(
  assignment: SidebarConversationOpenResult['projectAssignment']
): ProjectSelection | undefined {
  if (!assignment) return undefined
  if (assignment.projectKind === 'local') {
    return assignment.path
      ? { projectKind: 'path', path: assignment.path }
      : { projectKind: 'local', projectId: assignment.projectId }
  }
  if (assignment.projectKind === 'remote') {
    return {
      projectKind: 'remote',
      projectId: assignment.projectId,
      hostId: assignment.hostId
    }
  }
  return { projectKind: 'projectless' }
}

function sameConversationContext(
  left: ActiveConversationContext,
  right: ActiveConversationContext
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRunningStatus(status: ConversationEntryStatus): boolean {
  return status === 'submitted' || status === 'streaming'
}

function sameProjectSelection(
  left: ProjectSelection | undefined,
  right: ProjectSelection | undefined
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function createLocalConversationId(): string {
  return `local-${crypto.randomUUID()}`
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function attachmentOverlaySourceFromTranscript(
  messages: readonly ConversationTranscriptMessage[]
): Array<Pick<UIMessage, 'id' | 'parts'>> {
  return messages.map((message) => {
    if (message.kind === 'steering-user-message') {
      return {
        id: message.clientUserMessageId,
        parts: message.content
      }
    }
    return {
      id: message.sourceMessageId,
      parts: message.parts
    }
  })
}

function terminalRecoverySourceFromTranscript(
  messages: readonly ConversationTranscriptMessage[]
): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.kind !== 'message') return []
    return [
      {
        id: message.sourceMessageId,
        role: message.role,
        parts: message.parts,
        ...(message.metadata === undefined ? {} : { metadata: message.metadata })
      }
    ]
  })
}

function hasLocalPathAttachments(messages: readonly ConversationTranscriptMessage[]): boolean {
  return messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === 'file' &&
        (part.mediaType === LOCAL_FILE_ATTACHMENT_MEDIA_TYPE ||
          part.mediaType === LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE)
    )
  )
}

function hasVisibleAssistantContent(messages: readonly ConversationTranscriptMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' && message.parts.some((part) => part.type !== 'step-start')
  )
}

function mergeRecoveryHistory(
  store: ConversationTranscriptRecoveryStore,
  identities: readonly string[],
  history: readonly UIMessage[],
  historyRevision?: string | null
): UIMessage[] {
  return identities.reduce<UIMessage[]>(
    (selected, identity) => store.mergeWithHistory(identity, selected, historyRevision),
    [...history]
  )
}
