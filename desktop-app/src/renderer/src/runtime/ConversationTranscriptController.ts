import {
  readUIMessageStream,
  type ChatRequestOptions,
  type ChatStatus,
  type UIMessage,
  type UIMessageChunk
} from 'ai'

import type { CodexTurnLifecycleEvent } from '../../../shared/codexIpcApi'
import { selectUniqueLegacyCandidate } from '../../../shared/uniqueLegacyCandidate'
import type {
  CodexChatStreamError,
  ElectronIpcChatTransport
} from '../lib/ElectronIpcChatTransport'
import { markConversationStreamPublish } from './conversationStreamPerformance'

const CODEX_PROVIDER_ID = '@janole/ai-sdk-provider-codex-asp'
const DEFAULT_TURN_ERROR_MESSAGE = '模型响应未完成，请重试。'
const UNKNOWN_RECOVERY_ERROR_MESSAGE = '无法确认后台任务状态，请重试。'
const UNKNOWN_RECOVERY_ERROR_CODE = 'unknown-recovery'
const MAX_TURN_ERROR_MESSAGE_LENGTH = 2_000
const STREAM_RENDER_INTERVAL_MS = 33

export type CodexTurnMessageMetadata = {
  readonly turnId: string
  readonly status: 'failed' | 'interrupted'
  readonly error?: {
    readonly message: string
    readonly additionalDetails?: string | null
    readonly codexErrorInfo?: unknown
  }
}

export type SteeringMessageStatus = 'pending' | 'accepted'

export type ConversationTranscriptRegularMessage = UIMessage & {
  readonly kind: 'message'
  readonly renderId: string
  readonly sourceMessageId: string
  readonly clientUserMessageId?: string
  readonly turnId?: string
  readonly sourceItemIds?: readonly string[]
}

export type SteeringUserMessage = {
  readonly kind: 'steering-user-message'
  readonly renderId: string
  readonly clientUserMessageId: string
  readonly targetTurnId: string
  readonly targetTurnStartedAtMs: number
  readonly status: SteeringMessageStatus
  readonly content: UIMessage['parts']
  readonly compareKey: string
  readonly sourceItemId?: string
  readonly role: 'user'
  readonly parts: UIMessage['parts']
  readonly metadata?: unknown
}

export type ConversationTranscriptMessage =
  | ConversationTranscriptRegularMessage
  | SteeringUserMessage

export type ConversationTranscriptSnapshot = {
  readonly messages: readonly ConversationTranscriptMessage[]
  readonly status: ChatStatus
  readonly error?: Error
  readonly version: number
}

export type ConversationTranscriptControllerOptions = {
  id: string
  transport: ElectronIpcChatTransport
  createId?: () => string
}

type ActiveTurnLedger = {
  threadId?: string
  turnId: string
  turnStartedAtMs: number
  lastLifecycleSequence?: number
  outcome?: 'completed' | 'interrupted' | 'failed'
  assistantMessage?: UIMessage
  readonly retainedToolParts: Map<string, DynamicToolPart>
  readonly assistantIdentityScope: string
  readonly initialAssistantSourceMessageId: string
  readonly assistantSourceMessageIdsAfterSteer: Map<string, string>
  readonly sourceItemOrder: string[]
  readonly sourceItemIds: Set<string>
  readonly sourceItemSequence: Map<string, number>
  readonly startedPartKeys: Set<string>
  readonly partSourceItemIds: Array<string | undefined>
  /** Number of cumulative AI SDK parts that belong to earlier automatic turns. */
  readonly streamMessagePartOffset: number
  readonly steeringMessages: SteeringUserMessage[]
  readonly unmatchedSteeringItems: Extract<
    CodexTurnLifecycleEvent,
    { type: 'item-started' | 'item-completed' }
  >[]
}

export type SteeringMessageIdentity = {
  clientUserMessageId: string
  targetTurnId: string
}

export class ConversationTranscriptIntegrityError extends Error {
  override readonly name = 'ConversationTranscriptIntegrityError'
}

export class ConversationTranscriptController {
  readonly id: string

  private readonly transport: ElectronIpcChatTransport
  private readonly createId: () => string
  private readonly listeners = new Set<() => void>()
  private baseMessages: ConversationTranscriptMessage[] = []
  private activeTurn: ActiveTurnLedger | undefined
  private abortController: AbortController | undefined
  private status: ChatStatus = 'ready'
  private error: Error | undefined
  private recoveryError: Error | undefined
  private version = 0
  private snapshot: ConversationTranscriptSnapshot
  private turnSequence = 0
  private activeStreamAccepted = false
  private acceptedCurrentSend = false
  private streamRenderTimer: ReturnType<typeof setTimeout> | undefined
  private sendAcceptanceWaiter:
    | {
        resolve: () => void
        reject: (error: Error) => void
      }
    | undefined

  constructor(options: ConversationTranscriptControllerOptions) {
    this.id = options.id
    this.transport = options.transport
    this.createId = options.createId ?? createMessageId
    this.snapshot = this.buildSnapshot()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ConversationTranscriptSnapshot => this.snapshot

  getRecoveryError(): Error | undefined {
    return this.recoveryError
  }

  replaceMessages(messages: readonly UIMessage[]): void {
    this.baseMessages = messages.map((message) => toRegularTranscriptMessage(message))
    this.turnSequence = Math.max(this.turnSequence, localTurnSequenceIn(this.baseMessages))
    this.activeTurn = undefined
    this.abortController = undefined
    this.activeStreamAccepted = false
    this.status = 'ready'
    this.error = undefined
    this.emit()
  }

  clearError(): void {
    if (this.status !== 'error' && !this.error) return
    this.status = 'ready'
    this.error = undefined
    this.emit()
  }

  async sendMessage(message: UIMessage, options: ChatRequestOptions = {}): Promise<void> {
    this.assertReady()
    const userMessage: UIMessage = {
      ...message,
      id: message.id || this.createId(),
      role: message.role ?? 'user'
    }
    this.baseMessages = [...this.currentMessages(), toRegularTranscriptMessage(userMessage)]
    await this.startRequest('submit-message', userMessage.id, options)
  }

  /**
   * Starts a message request and resolves once Main has accepted its stream.
   * The transcript continues consuming the response after this method resolves.
   */
  async sendMessageUntilAccepted(
    message: UIMessage,
    options: ChatRequestOptions = {}
  ): Promise<void> {
    this.assertReady()
    const accepted = new Promise<void>((resolve, reject) => {
      this.sendAcceptanceWaiter = { resolve, reject }
    })

    void this.sendMessage(message, options).catch((error: unknown) => {
      this.rejectSendAcceptance(toError(error))
    })

    await accepted
  }

  /**
   * Resume a persisted thread and set its Goal without appending an empty or
   * synthetic user message to the visible transcript.
   */
  async startGoalControlUntilAccepted(): Promise<void> {
    this.assertReady()
    const accepted = new Promise<void>((resolve, reject) => {
      this.sendAcceptanceWaiter = { resolve, reject }
    })

    void this.startRequest('goal-control', undefined, {}).catch((error: unknown) => {
      this.rejectSendAcceptance(toError(error))
    })

    await accepted
  }

  async editMessage(
    parentId: string | null,
    message: UIMessage,
    options: ChatRequestOptions = {}
  ): Promise<void> {
    this.assertReady()
    const current = this.currentMessages()
    const parentIndex =
      parentId === null ? -1 : current.findIndex((candidate) => candidate.renderId === parentId)
    if (parentId !== null && parentIndex < 0) throw new Error(`Message ${parentId} was not found`)
    this.baseMessages = current.slice(0, parentIndex + 1)
    await this.sendMessage(message, options)
  }

  async regenerate(parentId: string | null, options: ChatRequestOptions = {}): Promise<void> {
    this.assertReady()
    const current = this.currentMessages()
    const parentIndex =
      parentId === null
        ? current.length - 1
        : current.findIndex((message) => message.renderId === parentId)
    if (parentIndex < 0) throw new Error(`Message ${parentId ?? '(latest)'} was not found`)

    const target = current[parentIndex]
    const keepThrough = target.role === 'assistant' ? parentIndex : parentIndex + 1
    this.baseMessages = current.slice(0, keepThrough)
    const terminalRetryTarget = target.role === 'assistant' ? target : current[parentIndex + 1]
    const retryOptions =
      terminalRetryTarget && hasTerminalFailure(terminalRetryTarget)
        ? {
            ...options,
            body: {
              ...(isRecord(options.body) ? options.body : {}),
              retryTerminalTurn: true
            }
          }
        : options
    await this.startRequest(
      'regenerate-message',
      target.role === 'assistant' && target.kind === 'message' ? target.sourceMessageId : undefined,
      retryOptions
    )
  }

  async stop(): Promise<void> {
    if (!isRunningStatus(this.status)) return
    // AbortSignal is only the renderer's stop intent.  The bridge keeps the
    // stream alive for lifecycle + terminal delivery, so do not persist an
    // interrupted turn until Main reports the canonical terminal outcome.
    this.status = 'submitted'
    this.emit()
    this.abortController?.abort()
  }

  /** Rehydrate a main-process turn without creating another provider request. */
  async resumeStream(): Promise<boolean> {
    if (isRunningStatus(this.status)) return false
    this.recoveryError = undefined
    const localTurnId = `recovered-turn-${++this.turnSequence}`
    this.activeTurn = {
      turnId: localTurnId,
      turnStartedAtMs: Date.now(),
      streamMessagePartOffset: 0,
      retainedToolParts: new Map(),
      assistantIdentityScope: localTurnId,
      initialAssistantSourceMessageId: assistantSourceMessageId(localTurnId, 'initial'),
      assistantSourceMessageIdsAfterSteer: new Map(),
      sourceItemOrder: [],
      sourceItemIds: new Set(),
      sourceItemSequence: new Map(),
      startedPartKeys: new Set(),
      partSourceItemIds: [],
      steeringMessages: [],
      unmatchedSteeringItems: []
    }
    this.status = 'submitted'
    this.error = undefined
    this.activeStreamAccepted = false
    this.acceptedCurrentSend = false
    this.emit()
    try {
      const stream = await this.transport.reconnectToStream({ chatId: this.id })
      if (!stream) {
        this.settleActiveTurn('ready')
        return false
      }
      await this.consumeStream(stream)
      if (!this.activeTurn) return this.activeStreamAccepted && !this.recoveryError
      if (this.recoveryError) {
        this.settleActiveTurn('error', this.recoveryError, 'failed')
        return false
      }
      if (!this.activeStreamAccepted) {
        const unknownError = recoveryErrorFromStreamError({
          code: UNKNOWN_RECOVERY_ERROR_CODE,
          message: UNKNOWN_RECOVERY_ERROR_MESSAGE
        })
        this.recoveryError = unknownError
        this.settleActiveTurn('error', unknownError, 'failed')
        return false
      }
      if (this.activeTurn.outcome === 'interrupted') {
        this.settleActiveTurn('ready', undefined, 'interrupted')
        return true
      } else if (this.activeTurn.outcome === 'failed') {
        const terminalError = this.recoveryError ?? new Error(DEFAULT_TURN_ERROR_MESSAGE)
        this.settleActiveTurn('error', terminalError, 'failed')
        return false
      } else if (this.activeTurn.outcome === 'completed') {
        this.settleActiveTurn('ready')
        return true
      } else {
        const unknownError = recoveryErrorFromStreamError({
          code: UNKNOWN_RECOVERY_ERROR_CODE,
          message: UNKNOWN_RECOVERY_ERROR_MESSAGE
        })
        this.recoveryError = unknownError
        this.settleActiveTurn('error', unknownError, 'failed')
        return false
      }
    } catch (error) {
      const safeError = recoveryErrorFromStreamError(error)
      this.recoveryError = safeError
      if (this.activeTurn) this.settleActiveTurn('error', safeError, 'failed')
      return false
    }
  }

  stageSteeringMessage(
    message: UIMessage,
    identity: SteeringMessageIdentity
  ): SteeringUserMessage | undefined {
    if (!this.activeTurn || !isRunningStatus(this.status)) return undefined

    const existing = this.activeTurn.steeringMessages.find(
      (candidate) => candidate.clientUserMessageId === identity.clientUserMessageId
    )
    if (existing) return existing

    const content = structuredClone(message.parts)
    const steeringMessage: SteeringUserMessage = {
      kind: 'steering-user-message',
      renderId: `steer:${identity.clientUserMessageId}`,
      clientUserMessageId: identity.clientUserMessageId,
      targetTurnId: identity.targetTurnId,
      targetTurnStartedAtMs: this.activeTurn.turnStartedAtMs,
      status: 'pending',
      content,
      compareKey: steeringCompareKey(content),
      role: 'user',
      parts: content,
      ...(message.metadata === undefined ? {} : { metadata: message.metadata })
    }
    this.activeTurn.steeringMessages.push(steeringMessage)
    this.activeTurn.assistantSourceMessageIdsAfterSteer.set(
      identity.clientUserMessageId,
      assistantSourceMessageId(
        this.activeTurn.assistantIdentityScope,
        `after-${identity.clientUserMessageId}`
      )
    )
    this.reconcileUnmatchedSteeringItems()
    this.emit()
    return steeringMessage
  }

  rejectSteeringMessage(clientUserMessageId: string): void {
    const ledger = this.activeTurn
    if (!ledger) return
    const index = ledger.steeringMessages.findIndex(
      (message) => message.clientUserMessageId === clientUserMessageId
    )
    if (index < 0) return
    ledger.steeringMessages.splice(index, 1)
    ledger.assistantSourceMessageIdsAfterSteer.delete(clientUserMessageId)
    this.emit()
  }

  getActiveTurnId(): string | undefined {
    return this.activeTurn?.turnId
  }

  retargetSteeringMessage(clientUserMessageId: string, targetTurnId: string): void {
    this.updateSteeringMessage(clientUserMessageId, (message) => ({
      ...message,
      targetTurnId
    }))
  }

  handleStreamStarted(): void {
    this.activeStreamAccepted = false
    this.acceptedCurrentSend = false
    this.status = 'submitted'
    this.error = undefined
    this.emit()
  }

  handleStreamAccepted(): void {
    this.activeStreamAccepted = true
    this.acceptedCurrentSend = true
    this.status = 'streaming'
    this.resolveSendAcceptance()
    this.emit()
  }

  handleStreamAborted(): void {
    // A terminal abort received from main is authoritative for a replay even
    // if its lifecycle companion was trimmed from the terminal journal.
    if (this.activeTurn) this.activeTurn.outcome = 'interrupted'
    this.emit()
  }

  /**
   * A replayed terminal error is delivered out-of-band so the stream can close
   * without discarding chunks that were queued just before the error.
   */
  handleStreamError(error: CodexChatStreamError): void {
    this.recoveryError = recoveryErrorFromStreamError(error)
    if (this.activeTurn) this.activeTurn.outcome = 'failed'
    this.emit()
  }

  handleTurnLifecycle(event: CodexTurnLifecycleEvent): void {
    const ledger = this.activeTurn
    if (!ledger) return
    const isLocalTurn =
      ledger.turnId.startsWith('local-turn-') || ledger.turnId.startsWith('recovered-turn-')
    if (isLocalTurn) {
      if (event.type !== 'turn-started') return
      if (ledger.threadId && ledger.threadId !== event.threadId) return
      const previousTurnId = ledger.turnId
      ledger.turnId = event.turnId
      ledger.threadId = event.threadId
      for (let index = 0; index < ledger.steeringMessages.length; index += 1) {
        const steering = ledger.steeringMessages[index]
        if (steering.targetTurnId !== previousTurnId) continue
        ledger.steeringMessages[index] = { ...steering, targetTurnId: event.turnId }
      }
    } else if (event.threadId !== ledger.threadId || event.turnId !== ledger.turnId) {
      // A Goal owner can start another automatic turn without ending its
      // stream. Seal the completed turn before accepting the next one so
      // each automatic response has an independent assistant transcript.
      if (
        event.type !== 'turn-started' ||
        event.threadId !== ledger.threadId ||
        ledger.outcome !== 'completed'
      ) {
        return
      }
      this.sealCompletedTurnForContinuation(ledger)
      this.activeTurn = newActiveTurnLedger(
        event.threadId,
        event.turnId,
        ledger.assistantMessage?.parts.length ?? 0
      )
      this.emit()
      return
    }
    if (
      ledger.lastLifecycleSequence !== undefined &&
      event.sequence <= ledger.lastLifecycleSequence
    ) {
      return
    }
    ledger.lastLifecycleSequence = event.sequence
    if (event.type === 'turn-started') {
      ledger.turnStartedAtMs = Date.now()
      this.emit()
      return
    }
    if (event.type === 'turn-completed') {
      ledger.outcome = event.outcome
      const acceptedSteeringMessages = ledger.steeringMessages.filter(
        (message) => message.status === 'accepted'
      )
      ledger.steeringMessages.splice(0, ledger.steeringMessages.length, ...acceptedSteeringMessages)
      this.emit()
      return
    }

    if (!ledger.sourceItemIds.has(event.itemId)) {
      ledger.sourceItemIds.add(event.itemId)
      ledger.sourceItemOrder.push(event.itemId)
    }
    ledger.sourceItemSequence.set(event.itemId, event.sequence)
    if (event.itemType === 'userMessage') {
      if (!this.applySteeringLifecycleItem(event)) ledger.unmatchedSteeringItems.push(event)
    }
    this.emit()
  }

  takeCurrentSendAcceptance(): boolean {
    const accepted = this.acceptedCurrentSend
    this.acceptedCurrentSend = false
    return accepted
  }

  private resolveSendAcceptance(): void {
    const waiter = this.sendAcceptanceWaiter
    this.sendAcceptanceWaiter = undefined
    waiter?.resolve()
  }

  private rejectSendAcceptance(error: Error): void {
    const waiter = this.sendAcceptanceWaiter
    this.sendAcceptanceWaiter = undefined
    waiter?.reject(error)
  }

  private async startRequest(
    trigger: 'submit-message' | 'regenerate-message' | 'goal-control',
    messageId: string | undefined,
    options: ChatRequestOptions
  ): Promise<void> {
    const localTurnId = `local-turn-${++this.turnSequence}`
    this.activeTurn = {
      turnId: localTurnId,
      turnStartedAtMs: Date.now(),
      streamMessagePartOffset: 0,
      retainedToolParts: new Map(),
      assistantIdentityScope: localTurnId,
      initialAssistantSourceMessageId: assistantSourceMessageId(localTurnId, 'initial'),
      assistantSourceMessageIdsAfterSteer: new Map(),
      sourceItemOrder: [],
      sourceItemIds: new Set(),
      sourceItemSequence: new Map(),
      startedPartKeys: new Set(),
      partSourceItemIds: [],
      steeringMessages: [],
      unmatchedSteeringItems: []
    }
    const abortController = new AbortController()
    this.abortController = abortController
    this.status = 'submitted'
    this.error = undefined
    this.activeStreamAccepted = false
    this.emit()

    try {
      const stream = await this.transport.sendMessages({
        chatId: this.id,
        // AI SDK's public ChatTransport union only names message submission
        // and regeneration. The Electron bridge additionally owns this
        // non-message control trigger and validates it again in Main.
        trigger: trigger as Parameters<typeof this.transport.sendMessages>[0]['trigger'],
        messageId,
        messages: this.transportMessages(),
        abortSignal: abortController.signal,
        ...options
      })
      await this.consumeStream(stream)
      if (this.activeTurn) {
        if (this.activeTurn.outcome === 'interrupted') {
          this.settleActiveTurn('ready', undefined, 'interrupted')
        } else if (this.activeTurn.outcome === 'failed') {
          this.settleActiveTurn('error', new Error(DEFAULT_TURN_ERROR_MESSAGE), 'failed')
        } else if (this.activeTurn.outcome === 'completed') {
          this.settleActiveTurn('ready')
        } else {
          this.settleActiveTurn('error', new Error(DEFAULT_TURN_ERROR_MESSAGE), 'failed')
        }
      }
    } catch (error) {
      const safeError = new Error(safeTurnErrorMessage(toError(error).message))
      if (this.activeTurn) this.settleActiveTurn('error', safeError, 'failed')
      throw safeError
    } finally {
      if (this.abortController === abortController) this.abortController = undefined
    }
  }

  private async consumeStream(stream: ReadableStream<UIMessageChunk>): Promise<void> {
    const observedStream = stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform: (chunk, controller) => {
          this.observeChunk(chunk)
          controller.enqueue(chunk)
        }
      })
    )

    for await (const message of readUIMessageStream<UIMessage>({
      stream: observedStream,
      terminateOnError: true
    })) {
      if (!this.activeTurn) continue
      this.activeTurn.assistantMessage = mergeRetainedToolParts(
        messageForActiveTurn(message, this.activeTurn),
        this.activeTurn.retainedToolParts
      )
      this.alignPartSourceItemIds(this.activeTurn.assistantMessage.parts.length)
      this.scheduleStreamRender()
    }
  }

  private observeChunk(chunk: UIMessageChunk): void {
    const ledger = this.activeTurn
    if (!ledger) return

    const turnId = turnIdFromChunk(chunk)
    if (turnId && turnId !== ledger.turnId) {
      const previousTurnId = ledger.turnId
      ledger.turnId = turnId
      for (let index = 0; index < ledger.steeringMessages.length; index += 1) {
        const steering = ledger.steeringMessages[index]
        if (steering.targetTurnId !== previousTurnId) continue
        ledger.steeringMessages[index] = { ...steering, targetTurnId: turnId }
      }
    }

    this.captureToolPart(ledger, chunk)

    const sourceItemId = sourceItemIdFromChunk(chunk)
    if (sourceItemId && !ledger.sourceItemIds.has(sourceItemId)) {
      ledger.sourceItemIds.add(sourceItemId)
      ledger.sourceItemOrder.push(sourceItemId)
    }
    if (chunkStartsMessagePart(chunk)) {
      const partKey = messagePartKeyFromChunk(chunk)
      if (partKey && ledger.startedPartKeys.has(partKey)) return
      if (partKey) ledger.startedPartKeys.add(partKey)
      ledger.partSourceItemIds.push(sourceItemId ?? ledger.sourceItemOrder.at(-1))
    }
  }

  private captureToolPart(ledger: ActiveTurnLedger, chunk: UIMessageChunk): void {
    if (chunk.type === 'tool-input-available') {
      ledger.retainedToolParts.set(chunk.toolCallId, {
        type: 'dynamic-tool',
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: 'input-available',
        input: chunk.input,
        ...(chunk.providerExecuted === undefined
          ? {}
          : { providerExecuted: chunk.providerExecuted }),
        ...(chunk.title === undefined ? {} : { title: chunk.title }),
        ...(chunk.toolMetadata === undefined ? {} : { toolMetadata: chunk.toolMetadata }),
        ...(chunk.providerMetadata === undefined
          ? {}
          : { callProviderMetadata: chunk.providerMetadata })
      })
      return
    }

    if (!isToolOutputChunk(chunk)) {
      return
    }
    const existing = ledger.retainedToolParts.get(chunk.toolCallId)
    if (!existing) return

    const input = existing.input
    if (chunk.type === 'tool-output-available') {
      ledger.retainedToolParts.set(chunk.toolCallId, {
        ...toolPartIdentity(existing),
        state: 'output-available',
        input,
        output: chunk.output,
        ...(chunk.preliminary === undefined ? {} : { preliminary: chunk.preliminary }),
        ...(chunk.providerMetadata === undefined
          ? {}
          : { resultProviderMetadata: chunk.providerMetadata })
      })
      return
    }

    if (chunk.type === 'tool-output-error') {
      ledger.retainedToolParts.set(chunk.toolCallId, {
        ...toolPartIdentity(existing),
        state: 'output-error',
        input,
        errorText: chunk.errorText,
        ...(chunk.providerMetadata === undefined
          ? {}
          : { resultProviderMetadata: chunk.providerMetadata })
      })
      return
    }

    ledger.retainedToolParts.set(chunk.toolCallId, {
      ...toolPartIdentity(existing),
      state: 'output-denied',
      input,
      approval: { id: chunk.toolCallId, approved: false }
    })
  }

  private applySteeringLifecycleItem(
    event: Extract<CodexTurnLifecycleEvent, { type: 'item-started' | 'item-completed' }>
  ): boolean {
    const ledger = this.activeTurn
    if (!ledger) return false
    let steeringIndex = event.clientUserMessageId
      ? ledger.steeringMessages.findIndex(
          (message) => message.clientUserMessageId === event.clientUserMessageId
        )
      : -1
    if (!event.clientUserMessageId && event.compareKey !== undefined) {
      const selection = selectUniqueLegacyCandidate(
        ledger.steeringMessages.map((message, index) => ({ message, index })),
        ({ message }) => message.status === 'pending' && message.compareKey === event.compareKey
      )
      steeringIndex = selection.candidate?.index ?? -1
      if (selection.matchingCandidates.length > 1) {
        console.warn('ambiguous legacy steer acknowledgement ignored', {
          turnId: ledger.turnId,
          candidateCount: selection.matchingCandidates.length,
          messageIds: selection.matchingCandidates.map(({ message }) => message.clientUserMessageId)
        })
      }
    }
    if (steeringIndex < 0) return false

    const steering = ledger.steeringMessages[steeringIndex]
    ledger.steeringMessages[steeringIndex] = {
      ...steering,
      sourceItemId: event.itemId,
      ...(event.type === 'item-completed' ? { status: 'accepted' as const } : {})
    }
    return true
  }

  private reconcileUnmatchedSteeringItems(): void {
    const ledger = this.activeTurn
    if (!ledger) return
    const remaining = ledger.unmatchedSteeringItems.filter(
      (event) => !this.applySteeringLifecycleItem(event)
    )
    ledger.unmatchedSteeringItems.splice(0, ledger.unmatchedSteeringItems.length, ...remaining)
  }

  private alignPartSourceItemIds(partCount: number): void {
    const ledger = this.activeTurn
    if (!ledger) return
    while (ledger.partSourceItemIds.length < partCount) {
      ledger.partSourceItemIds.push(ledger.sourceItemOrder.at(-1))
    }
    if (ledger.partSourceItemIds.length > partCount) {
      ledger.partSourceItemIds.length = partCount
    }
  }

  private updateSteeringMessage(
    clientUserMessageId: string,
    update: (message: SteeringUserMessage) => SteeringUserMessage
  ): void {
    const ledger = this.activeTurn
    if (!ledger) return
    const index = ledger.steeringMessages.findIndex(
      (message) => message.clientUserMessageId === clientUserMessageId
    )
    if (index < 0) return
    ledger.steeringMessages[index] = update(ledger.steeringMessages[index])
    this.emit()
  }

  private settleActiveTurn(
    status: Extract<ChatStatus, 'ready' | 'error'>,
    error?: Error,
    outcome?: 'failed' | 'interrupted'
  ): void {
    if (this.activeTurn) {
      const turnId = this.activeTurn.turnId
      const acceptedSteeringMessages = this.activeTurn.steeringMessages.filter(
        (message) => message.status === 'accepted'
      )
      this.activeTurn.steeringMessages.splice(
        0,
        this.activeTurn.steeringMessages.length,
        ...acceptedSteeringMessages
      )
      const currentMessages = this.currentMessages()
      const settledMessages = outcome
        ? removeRedundantTerminalAssistantPlaceholders(currentMessages, turnId)
        : removeEmptyAssistantPlaceholders(currentMessages, turnId)
      this.baseMessages = markTurnOutcome(settledMessages, {
        turnId,
        outcome,
        error
      })
      this.activeTurn = undefined
    }
    this.status = status
    this.error = error
    this.emit()
  }

  private sealCompletedTurnForContinuation(ledger: ActiveTurnLedger): void {
    const acceptedSteeringMessages = ledger.steeringMessages.filter(
      (message) => message.status === 'accepted'
    )
    ledger.steeringMessages.splice(0, ledger.steeringMessages.length, ...acceptedSteeringMessages)
    this.baseMessages = removeEmptyAssistantPlaceholders(this.currentMessages(), ledger.turnId)
    this.activeTurn = undefined
  }

  private currentMessages(): ConversationTranscriptMessage[] {
    const ledger = this.activeTurn
    if (!ledger) return this.baseMessages

    const assistant = ledger.assistantMessage
    const insertionOrder = new Map(
      ledger.sourceItemOrder.map((sourceItemId, index) => [sourceItemId, index] as const)
    )
    const orderedSourceItemIds = [...ledger.sourceItemOrder].sort((left, right) => {
      const leftSequence = ledger.sourceItemSequence.get(left)
      const rightSequence = ledger.sourceItemSequence.get(right)
      if (leftSequence !== undefined && rightSequence !== undefined) {
        return leftSequence - rightSequence
      }
      return (insertionOrder.get(left) ?? 0) - (insertionOrder.get(right) ?? 0)
    })
    const sourceOrder = new Map(
      orderedSourceItemIds.map((sourceItemId, index) => [sourceItemId, index] as const)
    )
    const steers = [...ledger.steeringMessages].sort((left, right) => {
      const leftOrder =
        left.sourceItemId === undefined
          ? Number.POSITIVE_INFINITY
          : (sourceOrder.get(left.sourceItemId) ?? Number.POSITIVE_INFINITY)
      const rightOrder =
        right.sourceItemId === undefined
          ? Number.POSITIVE_INFINITY
          : (sourceOrder.get(right.sourceItemId) ?? Number.POSITIVE_INFINITY)
      return leftOrder - rightOrder
    })
    if (!assistant) {
      return [
        ...this.baseMessages,
        ...steers,
        emptyAssistantTranscriptMessage(ledger.initialAssistantSourceMessageId, ledger.turnId)
      ]
    }

    const boundaries = steers.map((message) =>
      message.sourceItemId === undefined
        ? Number.POSITIVE_INFINITY
        : (sourceOrder.get(message.sourceItemId) ?? Number.POSITIVE_INFINITY)
    )
    const segments = Array.from({ length: steers.length + 1 }, () => ({
      parts: [] as UIMessage['parts'],
      sourceItemIds: [] as string[]
    }))

    assistant.parts.forEach((part, index) => {
      const sourceItemId = ledger.partSourceItemIds[index]
      const sourceIndex =
        sourceItemId === undefined
          ? Number.NEGATIVE_INFINITY
          : (sourceOrder.get(sourceItemId) ?? Number.NEGATIVE_INFINITY)
      const segmentIndex = boundaries.filter((boundary) => sourceIndex >= boundary).length
      const segment = segments[segmentIndex]
      segment.parts.push(part)
      if (sourceItemId && !segment.sourceItemIds.includes(sourceItemId)) {
        segment.sourceItemIds.push(sourceItemId)
      }
    })

    const messages = [...this.baseMessages]
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segment = segments[segmentIndex]
      const hasRenderablePart = segment.parts.some((part) => part.type !== 'step-start')
      const isTrailingSegment = segmentIndex === segments.length - 1
      if (segment.sourceItemIds.length > 0 || hasRenderablePart || isTrailingSegment) {
        const previousSteeringMessage = steers[segmentIndex - 1]
        const sourceMessageId =
          segment.sourceItemIds[0] === undefined
            ? segmentIndex === 0
              ? ledger.initialAssistantSourceMessageId
              : ledger.assistantSourceMessageIdsAfterSteer.get(
                  previousSteeringMessage.clientUserMessageId
                )
            : assistantSourceMessageId(ledger.turnId, segment.sourceItemIds[0])
        if (!sourceMessageId) {
          throw this.integrityError('Assistant segment has no stable render identity')
        }
        messages.push(
          toRegularTranscriptMessage(
            {
              ...assistant,
              id: sourceMessageId,
              parts: segment.parts
            },
            {
              sourceMessageId,
              turnId: ledger.turnId,
              sourceItemIds: segment.sourceItemIds
            }
          )
        )
      }
      const steering = steers[segmentIndex]
      if (steering) messages.push(steering)
    }
    return removeSupersededTerminalFallback(messages, ledger.turnId)
  }

  private transportMessages(): UIMessage[] {
    return this.currentMessages().map((message) => {
      if (message.kind === 'steering-user-message') {
        return {
          id: message.clientUserMessageId,
          role: 'user',
          parts: message.content,
          ...(message.metadata === undefined ? {} : { metadata: message.metadata })
        }
      }
      return {
        id: message.sourceMessageId,
        role: message.role,
        parts: message.parts,
        ...(message.metadata === undefined ? {} : { metadata: message.metadata })
      }
    })
  }

  private assertReady(): void {
    if (isRunningStatus(this.status)) {
      throw new Error('Conversation already has a running turn')
    }
  }

  private integrityError(message: string): ConversationTranscriptIntegrityError {
    const ledger = this.activeTurn
    return new ConversationTranscriptIntegrityError(
      [
        message,
        `conversation=${this.id}`,
        `turn=${ledger?.turnId ?? 'history'}`,
        `sourceItems=${ledger?.sourceItemOrder.join(',') || 'none'}`
      ].join('; ')
    )
  }

  private emit(): void {
    if (this.streamRenderTimer !== undefined) {
      clearTimeout(this.streamRenderTimer)
      this.streamRenderTimer = undefined
    }
    this.version += 1
    this.snapshot = this.buildSnapshot()
    markConversationStreamPublish(this.id, this.version)
    for (const listener of this.listeners) listener()
  }

  private scheduleStreamRender(): void {
    if (this.streamRenderTimer !== undefined) return
    this.streamRenderTimer = setTimeout(() => {
      this.streamRenderTimer = undefined
      this.emit()
    }, STREAM_RENDER_INTERVAL_MS)
  }

  private buildSnapshot(): ConversationTranscriptSnapshot {
    const messages = this.currentMessages()
    assertUniqueRenderIds(messages, {
      conversationId: this.id,
      turnId: this.activeTurn?.turnId,
      sourceItemIds: this.activeTurn?.sourceItemOrder
    })
    return {
      messages,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      version: this.version
    }
  }
}

function newActiveTurnLedger(
  threadId: string,
  turnId: string,
  streamMessagePartOffset = 0
): ActiveTurnLedger {
  return {
    threadId,
    turnId,
    turnStartedAtMs: Date.now(),
    retainedToolParts: new Map(),
    assistantIdentityScope: turnId,
    initialAssistantSourceMessageId: assistantSourceMessageId(turnId, 'initial'),
    assistantSourceMessageIdsAfterSteer: new Map(),
    sourceItemOrder: [],
    sourceItemIds: new Set(),
    sourceItemSequence: new Map(),
    startedPartKeys: new Set(),
    partSourceItemIds: [],
    streamMessagePartOffset,
    steeringMessages: [],
    unmatchedSteeringItems: []
  }
}

function messageForActiveTurn(message: UIMessage, ledger: ActiveTurnLedger): UIMessage {
  // `readUIMessageStream` keeps a cumulative message while a stream stays
  // open. Goal-continuous mode intentionally spans several turns, so after a
  // lifecycle boundary retain only the trailing parts observed by the new
  // ledger instead of leaking the previous turn into its assistant message.
  const currentTurnParts = message.parts.slice(ledger.streamMessagePartOffset)
  const activePartCount = ledger.partSourceItemIds.length
  if (activePartCount === 0 || currentTurnParts.length <= activePartCount) {
    return { ...message, parts: currentTurnParts }
  }
  return { ...message, parts: currentTurnParts.slice(-activePartCount) }
}

function assertUniqueRenderIds(
  messages: readonly ConversationTranscriptMessage[],
  context: {
    conversationId: string
    turnId?: string
    sourceItemIds?: readonly string[]
  }
): void {
  const seen = new Set<string>()
  for (const message of messages) {
    if (message.renderId.length === 0) {
      throw new ConversationTranscriptIntegrityError(
        [
          'Conversation transcript contains an empty renderId',
          `conversation=${context.conversationId}`,
          `turn=${context.turnId ?? 'history'}`,
          `sourceItems=${context.sourceItemIds?.join(',') || 'none'}`
        ].join('; ')
      )
    }
    if (!seen.has(message.renderId)) {
      seen.add(message.renderId)
      continue
    }
    throw new ConversationTranscriptIntegrityError(
      [
        `Conversation transcript contains duplicate renderId "${message.renderId}"`,
        `conversation=${context.conversationId}`,
        `turn=${context.turnId ?? 'history'}`,
        `sourceItems=${context.sourceItemIds?.join(',') || 'none'}`
      ].join('; ')
    )
  }
}

function toRegularTranscriptMessage(
  message: UIMessage,
  identity: {
    sourceMessageId?: string
    turnId?: string
    sourceItemIds?: readonly string[]
  } = {}
): ConversationTranscriptRegularMessage {
  const sourceMessageId = identity.sourceMessageId ?? message.id
  const renderId = regularMessageRenderId(sourceMessageId)
  const metadata = identity.turnId
    ? {
        ...(isRecord(message.metadata) ? message.metadata : {}),
        codexSource: { turnId: identity.turnId }
      }
    : message.metadata
  return {
    ...message,
    ...(metadata === undefined ? {} : { metadata }),
    id: renderId,
    kind: 'message',
    renderId,
    sourceMessageId,
    ...(message.role === 'user' ? { clientUserMessageId: sourceMessageId } : {}),
    ...(identity.turnId ? { turnId: identity.turnId } : {}),
    ...(identity.sourceItemIds ? { sourceItemIds: identity.sourceItemIds } : {})
  }
}

function emptyAssistantTranscriptMessage(
  sourceMessageId: string,
  turnId: string
): ConversationTranscriptRegularMessage {
  return toRegularTranscriptMessage(
    {
      id: sourceMessageId,
      role: 'assistant',
      parts: []
    },
    {
      sourceMessageId,
      turnId,
      sourceItemIds: []
    }
  )
}

function removeEmptyAssistantPlaceholders(
  messages: readonly ConversationTranscriptMessage[],
  turnId: string
): ConversationTranscriptMessage[] {
  return messages.filter(
    (message) =>
      message.kind !== 'message' ||
      message.role !== 'assistant' ||
      message.turnId !== turnId ||
      message.parts.length > 0
  )
}

function removeRedundantTerminalAssistantPlaceholders(
  messages: readonly ConversationTranscriptMessage[],
  turnId: string
): ConversationTranscriptMessage[] {
  const hasVisibleAssistantContent = messages.some(
    (message) =>
      message.kind === 'message' &&
      message.role === 'assistant' &&
      message.turnId === turnId &&
      message.parts.some((part) => part.type !== 'step-start')
  )
  if (!hasVisibleAssistantContent) return [...messages]
  return messages.filter(
    (message) =>
      message.kind !== 'message' ||
      message.role !== 'assistant' ||
      message.turnId !== turnId ||
      message.parts.some((part) => part.type !== 'step-start')
  )
}

function removeSupersededTerminalFallback(
  messages: readonly ConversationTranscriptMessage[],
  turnId: string
): ConversationTranscriptMessage[] {
  const terminalFallbackId = assistantSourceMessageId(turnId, 'terminal')
  const hasRecoveredAssistantContent = messages.some(
    (message) =>
      message.kind === 'message' &&
      message.role === 'assistant' &&
      message.turnId === turnId &&
      message.sourceMessageId !== terminalFallbackId &&
      message.parts.some((part) => part.type !== 'step-start')
  )
  if (!hasRecoveredAssistantContent) return [...messages]
  return messages.filter(
    (message) =>
      message.kind !== 'message' ||
      message.role !== 'assistant' ||
      message.sourceMessageId !== terminalFallbackId
  )
}

function markTurnOutcome(
  messages: readonly ConversationTranscriptMessage[],
  terminal: {
    turnId: string
    outcome?: 'failed' | 'interrupted'
    error?: Error
  }
): ConversationTranscriptMessage[] {
  if (!terminal.outcome) return [...messages]

  const next = [...messages]
  const assistantIndex = next.findLastIndex(
    (message) =>
      message.kind === 'message' &&
      message.role === 'assistant' &&
      message.turnId === terminal.turnId
  )
  const codexTurn: CodexTurnMessageMetadata = {
    turnId: terminal.turnId,
    status: terminal.outcome,
    ...(terminal.outcome === 'failed'
      ? {
          error: {
            message: safeTurnErrorMessage(terminal.error?.message)
          }
        }
      : {})
  }

  if (assistantIndex >= 0) {
    const assistant = next[assistantIndex] as ConversationTranscriptRegularMessage
    next[assistantIndex] = {
      ...assistant,
      metadata: mergeCodexTurnMetadata(assistant.metadata, codexTurn)
    }
    return next
  }

  const sourceMessageId = assistantSourceMessageId(terminal.turnId, 'terminal')
  next.push(
    toRegularTranscriptMessage(
      {
        id: sourceMessageId,
        role: 'assistant',
        parts: [],
        metadata: { codexTurn }
      },
      {
        sourceMessageId,
        turnId: terminal.turnId,
        sourceItemIds: []
      }
    )
  )
  return next
}

function mergeCodexTurnMetadata(
  metadata: UIMessage['metadata'],
  codexTurn: CodexTurnMessageMetadata
): Record<string, unknown> {
  return {
    ...(isRecord(metadata) ? metadata : {}),
    codexTurn
  }
}

function hasTerminalFailure(message: ConversationTranscriptMessage): boolean {
  if (message.kind !== 'message' || message.role !== 'assistant' || !isRecord(message.metadata)) {
    return false
  }
  const codexTurn = message.metadata.codexTurn
  return (
    isRecord(codexTurn) && (codexTurn.status === 'failed' || codexTurn.status === 'interrupted')
  )
}

function regularMessageRenderId(sourceMessageId: string): string {
  return sourceMessageId.length > 0 ? `message:${sourceMessageId}` : ''
}

function assistantSourceMessageId(turnId: string, sourceItemId: string): string {
  return `assistant:${turnId}:${sourceItemId}`
}

function localTurnSequenceIn(messages: readonly ConversationTranscriptMessage[]): number {
  return messages.reduce((highest, message) => {
    if (message.kind !== 'message') return highest
    const match = /^assistant:local-turn-(\d+):/u.exec(message.sourceMessageId)
    if (!match) return highest
    return Math.max(highest, Number(match[1]))
  }, 0)
}

function sourceItemIdFromChunk(chunk: UIMessageChunk): string | undefined {
  if ('providerMetadata' in chunk) {
    const providerMetadata = chunk.providerMetadata
    if (providerMetadata && typeof providerMetadata === 'object') {
      const codexMetadata = providerMetadata[CODEX_PROVIDER_ID]
      if (codexMetadata && typeof codexMetadata === 'object') {
        const sourceItemId = (codexMetadata as Record<string, unknown>).sourceItemId
        if (typeof sourceItemId === 'string' && sourceItemId.length > 0) return sourceItemId
      }
    }
  }
  if ('id' in chunk && typeof chunk.id === 'string') return chunk.id
  if ('toolCallId' in chunk && typeof chunk.toolCallId === 'string') return chunk.toolCallId
  if ('sourceId' in chunk && typeof chunk.sourceId === 'string') return chunk.sourceId
  return undefined
}

type DynamicToolPart = Extract<UIMessage['parts'][number], { type: 'dynamic-tool' }>

function isToolOutputChunk(
  chunk: UIMessageChunk
): chunk is Extract<
  UIMessageChunk,
  { type: 'tool-output-available' | 'tool-output-error' | 'tool-output-denied' }
> {
  return (
    chunk.type === 'tool-output-available' ||
    chunk.type === 'tool-output-error' ||
    chunk.type === 'tool-output-denied'
  )
}

function toolPartIdentity(
  part: DynamicToolPart
): Pick<
  DynamicToolPart,
  'type' | 'toolCallId' | 'toolName' | 'title' | 'toolMetadata' | 'providerExecuted'
> {
  return {
    type: 'dynamic-tool',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    ...(part.title === undefined ? {} : { title: part.title }),
    ...(part.toolMetadata === undefined ? {} : { toolMetadata: part.toolMetadata }),
    ...(part.providerExecuted === undefined ? {} : { providerExecuted: part.providerExecuted })
  }
}

function mergeRetainedToolParts(
  message: UIMessage,
  retainedToolParts: ReadonlyMap<string, DynamicToolPart>
): UIMessage {
  const observedToolCallIds = new Set(
    message.parts.flatMap((part) => ('toolCallId' in part ? [part.toolCallId] : []))
  )
  const missingParts = [...retainedToolParts.values()].filter(
    (part) => !observedToolCallIds.has(part.toolCallId)
  )
  if (missingParts.length === 0) return message
  return { ...message, parts: [...missingParts, ...message.parts] }
}

function turnIdFromChunk(chunk: UIMessageChunk): string | undefined {
  if (!('providerMetadata' in chunk)) return undefined
  const providerMetadata = chunk.providerMetadata
  if (!providerMetadata || typeof providerMetadata !== 'object') return undefined
  const codexMetadata = providerMetadata[CODEX_PROVIDER_ID]
  if (!codexMetadata || typeof codexMetadata !== 'object') return undefined
  const turnId = (codexMetadata as Record<string, unknown>).turnId
  return typeof turnId === 'string' && turnId.length > 0 ? turnId : undefined
}

function chunkStartsMessagePart(chunk: UIMessageChunk): boolean {
  if (
    chunk.type === 'text-start' ||
    chunk.type === 'reasoning-start' ||
    chunk.type === 'tool-input-start' ||
    chunk.type === 'source-url' ||
    chunk.type === 'source-document' ||
    chunk.type === 'file' ||
    chunk.type === 'start-step'
  ) {
    return true
  }
  if (chunk.type.startsWith('data-')) return !('transient' in chunk) || chunk.transient !== true
  if (chunk.type === 'tool-input-available' || chunk.type === 'tool-input-error') return true
  return false
}

function messagePartKeyFromChunk(chunk: UIMessageChunk): string | undefined {
  switch (chunk.type) {
    case 'text-start':
      return `text:${chunk.id}`
    case 'reasoning-start':
      return `reasoning:${chunk.id}`
    case 'tool-input-start':
    case 'tool-input-available':
    case 'tool-input-error':
      return `tool:${chunk.toolCallId}`
    case 'source-url':
    case 'source-document':
      return `source:${chunk.sourceId}`
    default:
      if (chunk.type.startsWith('data-') && 'id' in chunk && typeof chunk.id === 'string') {
        return `${chunk.type}:${chunk.id}`
      }
      return undefined
  }
}

function steeringCompareKey(parts: UIMessage['parts']): string {
  const text = parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    .trim()
  const attachments = parts.flatMap<
    { type: 'image'; url: string } | { type: 'localImage'; path: string }
  >((part) => {
    if (part.type !== 'file' || !part.mediaType.startsWith('image/')) return []
    const localPath = localImagePath(part.url)
    if (localPath) return [{ type: 'localImage' as const, path: localPath }]
    return [{ type: 'image' as const, url: part.url }]
  })
  return JSON.stringify({ text, attachments })
}

function localImagePath(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'file:' ? decodeURIComponent(parsed.pathname) : undefined
  } catch {
    return undefined
  }
}

function isRunningStatus(status: ChatStatus): boolean {
  return status === 'submitted' || status === 'streaming'
}

function createMessageId(): string {
  return crypto.randomUUID()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function safeTurnErrorMessage(message: string | undefined): string {
  const trimmed = message?.trim()
  if (!trimmed) return DEFAULT_TURN_ERROR_MESSAGE

  const redacted = trimmed
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key)=)[^&#\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]')
    .replace(/(\bapi[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(\bauthorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')

  return redacted.length <= MAX_TURN_ERROR_MESSAGE_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_TURN_ERROR_MESSAGE_LENGTH)}…`
}

function recoveryErrorFromStreamError(error: unknown): Error {
  const message = safeTurnErrorMessage(recoveryErrorMessage(error))
  const safeError = new Error(message) as Error & { code?: string }
  const code = recoveryErrorCode(error)
  if (code) safeError.code = code
  return safeError
}

function recoveryErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return toError(error).message
}

function recoveryErrorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === 'string') return error.code
  return undefined
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
