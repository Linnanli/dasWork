import type { UIMessage } from 'ai'
import {
  agentLifecycleEvents,
  type AppServerClient,
  type CollaborationMode,
  type CodexExistingTurnRecoveryState,
  CodexRunEventNormalizer,
  type CodexRunEvent,
  type ServerRequest,
  type ThreadGoalSetResponse,
  TurnLifecycleNormalizer
} from '@dascowork/codex-app-server-client'

import type { AdminBackendClientModel } from '../adminBackendModelClient'
import type { CodexAppServerLaunchOptions } from '../codexAppServerLaunch'
import type { CodexTurnLifecycleEvent, ThreadGoalSummary } from '../../shared/codexIpcApi'
import { CodexRunInputAdapter } from './CodexRunInputAdapter'
import { HostCodexConnection } from './HostCodexConnection'

export type NativeApprovalKind =
  | 'command'
  | 'file-change'
  | 'tool-user-input'
  | 'mcp-elicitation'
  | 'permission-request'

export type NativeCodexRunDriverInput = {
  messages: readonly UIMessage[]
  modelId: string
  clientUserMessageId?: string
  clientModel?: AdminBackendClientModel
  cwd?: string
  runtimeWorkspaceRoots?: string[]
  approvalPolicy?: 'never' | 'on-request'
  approvalsReviewer?: 'user' | 'auto_review'
  sandbox?: 'workspace-write' | 'danger-full-access'
  sandboxPolicy?: Record<string, unknown>
  developerInstructions?: string
  collaborationMode?: CollaborationMode
  resumeThreadId?: string
  resumeActiveTurn?: boolean
  existingTurnRecoveryState?: CodexExistingTurnRecoveryState
  goalFirstTurnObjective?: string
  goalControl?: boolean
  goalContinuous?: boolean
  ephemeral?: boolean
  signal: AbortSignal
  onThreadStarted?(thread: { threadId: string; threadPath?: string }): void | Promise<void>
  onLifecycle?(event: CodexTurnLifecycleEvent): void | Promise<void>
  onAgentLifecycle?(event: unknown): void | Promise<void>
  onTurnDiffUpdated?(event: {
    threadId: string
    turnId: string
    diff: string
  }): void | Promise<void>
  onThreadSettingsUpdated?(event: {
    threadId: string
    modeKind: 'default' | 'plan'
  }): void | Promise<void>
  onThreadGoalUpdated?(event: {
    threadId: string
    goal: ThreadGoalSummary | null
  }): void | Promise<void>
  onSessionCreated?(session: NativeCodexRunSession): void | Promise<void>
  onExistingTurnRecoveryState?(state: CodexExistingTurnRecoveryState): void
  onApprovalRequest?(kind: NativeApprovalKind, params: unknown): Promise<unknown>
  onDynamicToolCall?(params: unknown): Promise<unknown>
}

export type NativeCodexRun = {
  events: AsyncIterable<CodexRunEvent>
  session: Promise<NativeCodexRunSession>
}

/** Direct app-server driver. It never imports AI SDK model/provider interfaces. */
export class NativeCodexRunDriver {
  private readonly host: HostCodexConnection

  constructor(launch: CodexAppServerLaunchOptions, host?: HostCodexConnection) {
    this.host = host ?? new HostCodexConnection(launch)
  }

  start(input: NativeCodexRunDriverInput): NativeCodexRun {
    const queue = new AsyncEventQueue<CodexRunEvent>()
    const session = deferred<NativeCodexRunSession>()
    void this.run(input, queue, session.resolve, session.reject)
    return { events: queue, session: session.promise }
  }

  shutdown(): Promise<void> {
    return this.host.shutdown()
  }

  async listModels(): Promise<
    Array<{
      id: string
      model: string
      displayName: string
      description?: string
      inputModalities?: string[]
      isDefault?: boolean
    }>
  > {
    const client = await this.host.acquire()
    try {
      const models: Array<{
        id: string
        model: string
        displayName: string
        description: string
        inputModalities: string[]
        isDefault: boolean
      }> = []
      let cursor: string | null | undefined
      do {
        const page = await client.request<{
          data: typeof models
          nextCursor: string | null
        }>('model/list', { cursor, includeHidden: false })
        models.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      return models.map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        ...(model.description ? { description: model.description } : {}),
        inputModalities: model.inputModalities,
        isDefault: model.isDefault
      }))
    } finally {
      await client.disconnect()
    }
  }

  private async run(
    input: NativeCodexRunDriverInput,
    queue: AsyncEventQueue<CodexRunEvent>,
    resolveSession: (session: NativeCodexRunSession) => void,
    rejectSession: (error: unknown) => void
  ): Promise<void> {
    let client: AppServerClient | undefined
    let inputAdapter: CodexRunInputAdapter | undefined
    let nativeSession: NativeCodexRunSession | undefined
    let completed = false
    try {
      client = await this.host.acquire(input.resumeThreadId)
      const normalizer = new CodexRunEventNormalizer()
      normalizer.restoreExistingTurnRecoveryState(input.existingTurnRecoveryState)
      const lifecycleNormalizer = new TurnLifecycleNormalizer()
      let lifecycleSequence = 0
      let threadId = input.resumeThreadId
      let turnId: string | undefined

      const publishExistingTurnRecoveryState = (): void => {
        input.onExistingTurnRecoveryState?.(normalizer.snapshotExistingTurnRecoveryState())
      }

      const emit = (method: string, params: unknown): void => {
        for (const event of normalizer.map({ method, params })) queue.push(event)
        publishExistingTurnRecoveryState()
      }
      client.onAnyNotification(async (method, params) => {
        const lifecycle = lifecycleNormalizer.normalize(method, params)
        if (lifecycle) {
          lifecycleSequence += 1
          await input.onLifecycle?.({ ...lifecycle, sequence: lifecycleSequence })
          if (lifecycle.type === 'turn-started') {
            turnId = lifecycle.turnId
            normalizer.setTurnId(turnId)
            nativeSession?.setTurnId(turnId)
          }
          if (lifecycle.type === 'turn-completed' && !input.goalContinuous) completed = true
        }
        for (const event of agentLifecycleEvents(method, params))
          await input.onAgentLifecycle?.(event)
        if (method === 'turn/diff/updated' && isRecord(params)) {
          const diff = params.diff
          const eventThreadId = params.threadId
          const eventTurnId = params.turnId
          if (
            typeof diff === 'string' &&
            typeof eventThreadId === 'string' &&
            typeof eventTurnId === 'string'
          ) {
            await input.onTurnDiffUpdated?.({ threadId: eventThreadId, turnId: eventTurnId, diff })
          }
        }
        if (method === 'thread/settings/updated' && isRecord(params)) {
          const eventThreadId = params.threadId
          const settings = params.settings
          if (typeof eventThreadId === 'string' && isRecord(settings)) {
            const mode = isRecord(settings.collaborationMode)
              ? settings.collaborationMode.mode
              : undefined
            await input.onThreadSettingsUpdated?.({
              threadId: eventThreadId,
              modeKind: mode === 'plan' ? 'plan' : 'default'
            })
          }
        }
        if (
          (method === 'thread/goal/updated' || method === 'thread/goal/cleared') &&
          isRecord(params)
        ) {
          const eventThreadId = params.threadId
          if (typeof eventThreadId === 'string') {
            const goal =
              method === 'thread/goal/cleared' ? null : (params.goal as ThreadGoalSummary | null)
            await input.onThreadGoalUpdated?.({ threadId: eventThreadId, goal })
            if (input.goalContinuous && isTerminalGoal(goal)) completed = true
          }
        }
        emit(method, params)
        if (completed) {
          nativeSession?.complete()
          queue.end()
        }
      })
      this.registerServerRequestHandlers(client, input)
      client.onTransportTermination((error) => queue.fail(error))

      inputAdapter = new CodexRunInputAdapter({
        loadTask: async (referencedThreadId) =>
          client!.request('thread/read', { threadId: referencedThreadId, includeTurns: true })
      })

      if (input.resumeThreadId) {
        const resumed = await client.request<{
          thread: {
            id: string
            path?: string
            cwd?: string
            turns?: Array<Record<string, unknown>>
          }
          cwd?: string
        }>('thread/resume', threadResumeParams(input))
        threadId = resumed.thread.id
        normalizer.setThreadId(threadId)
        normalizer.setThreadPath(resumed.thread.path)
        normalizer.setThreadCwd(resumed.cwd ?? resumed.thread.cwd)
        if (input.resumeActiveTurn) {
          const activeTurns = (resumed.thread.turns ?? []).filter(
            (turn) => turn.status === 'inProgress'
          )
          const expectedTurnId = input.existingTurnRecoveryState?.turnId
          const activeTurn = expectedTurnId
            ? activeTurns.find((turn) => turn.id === expectedTurnId)
            : activeTurns.length === 1
              ? activeTurns[0]
              : undefined
          if (!activeTurn || typeof activeTurn.id !== 'string') {
            throw new Error('active_turn_unavailable')
          }
          turnId = activeTurn.id
          normalizer.setTurnId(turnId)
          for (const event of normalizer.mapExistingTurnSnapshot(activeTurn as never))
            queue.push(event)
          publishExistingTurnRecoveryState()
        }
      } else {
        const started = await client.request<{
          threadId?: string
          thread?: { id?: string; path?: string; cwd?: string }
          cwd?: string
        }>('thread/start', threadStartParams(input))
        threadId = started.threadId ?? started.thread?.id
        if (!threadId) throw new Error('thread/start response does not include a thread id')
        normalizer.setThreadId(threadId)
        normalizer.setThreadPath(started.thread?.path)
        normalizer.setThreadCwd(started.cwd ?? started.thread?.cwd ?? input.cwd)
        await input.onThreadStarted?.({
          threadId,
          ...(started.thread?.path ? { threadPath: started.thread.path } : {})
        })
      }

      nativeSession = new NativeCodexRunSession({
        client,
        threadId: threadId!,
        turnId,
        inputAdapter,
        runInput: input,
        onTurnId: (nextTurnId) => {
          turnId = nextTurnId
          normalizer.setTurnId(nextTurnId)
          publishExistingTurnRecoveryState()
        }
      })

      if (!input.resumeActiveTurn && !input.goalControl) {
        const resolved = await inputAdapter.resolve(input.messages, {
          developerInstructions: input.developerInstructions,
          activeThreadId: threadId,
          goalFirstTurnObjective: input.goalFirstTurnObjective
        })
        const startedTurn = await client.request<{ turnId?: string; turn?: { id?: string } }>(
          'turn/start',
          {
            threadId,
            clientUserMessageId: input.clientUserMessageId,
            input: resolved.input,
            cwd: input.cwd,
            runtimeWorkspaceRoots: input.runtimeWorkspaceRoots,
            approvalPolicy: input.approvalPolicy,
            approvalsReviewer: input.approvalsReviewer,
            sandboxPolicy: input.sandboxPolicy,
            model: input.modelId,
            summary: 'auto',
            collaborationMode: input.collaborationMode
          }
        )
        turnId = startedTurn.turnId ?? startedTurn.turn?.id
        if (turnId) normalizer.setTurnId(turnId)
        nativeSession.setTurnId(turnId)
        publishExistingTurnRecoveryState()
      }

      await input.onSessionCreated?.(nativeSession)
      resolveSession(nativeSession)

      if (input.signal.aborted) await nativeSession.interrupt()
      else
        input.signal.addEventListener('abort', () => void nativeSession?.interrupt(), {
          once: true
        })

      await queue.waitForEnd()
    } catch (error) {
      rejectSession(error)
      queue.fail(error)
    } finally {
      if (completed) queue.end()
      nativeSession?.complete()
      try {
        if (client) await client.disconnect()
      } finally {
        if (inputAdapter) await inputAdapter.cleanup()
      }
    }
  }

  private registerServerRequestHandlers(
    client: AppServerClient,
    input: NativeCodexRunDriverInput
  ): void {
    const fileChangeBatches = new Map<string, unknown[]>()
    client.onNotification('item/started', (params) => {
      const item = isRecord(params) ? params.item : undefined
      if (!isRecord(item) || item.type !== 'fileChange') return
      const key = fileChangeKey(params, item.id)
      const changes = arrayValue(item.changes)
      if (key && changes) fileChangeBatches.set(key, changes)
    })
    client.onNotification('item/fileChange/patchUpdated', (params) => {
      const itemId = isRecord(params) ? params.itemId : undefined
      const key = fileChangeKey(params, itemId)
      const changes = isRecord(params) ? arrayValue(params.changes) : undefined
      if (key && changes) fileChangeBatches.set(key, changes)
    })
    client.onNotification('item/completed', (params) => {
      const item = isRecord(params) ? params.item : undefined
      if (!isRecord(item)) return
      const key = fileChangeKey(params, item.id)
      if (key) fileChangeBatches.delete(key)
    })
    client.onNotification('turn/completed', (params) => {
      const threadId = isRecord(params) ? params.threadId : undefined
      const turn = isRecord(params) ? params.turn : undefined
      const turnId = isRecord(turn) ? turn.id : undefined
      if (typeof threadId !== 'string' || typeof turnId !== 'string') return
      const prefix = `${threadId}\0${turnId}\0`
      for (const key of fileChangeBatches.keys()) {
        if (key.startsWith(prefix)) fileChangeBatches.delete(key)
      }
    })
    for (const method of SERVER_REQUEST_METHODS) {
      client.onRequest(method, async (params, request) =>
        this.routeServerRequest(
          { method, id: request.id, params } as ServerRequest,
          input,
          fileChangeBatches
        )
      )
    }
  }

  private async routeServerRequest(
    request: ServerRequest,
    input: NativeCodexRunDriverInput,
    fileChangeBatches = new Map<string, unknown[]>()
  ): Promise<unknown> {
    if (input.ephemeral) {
      throw new NativeServerRequestUnsupportedError(`ephemeral/${request.method}`)
    }
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        return {
          decision: (await input.onApprovalRequest?.('command', request.params)) ?? 'cancel'
        }
      case 'item/fileChange/requestApproval': {
        const key = fileChangeKey(request.params, request.params.itemId)
        const changes = key ? fileChangeBatches.get(key) : undefined
        const requestRecord = request.params as Record<string, unknown>
        const requestedChanges = arrayValue(requestRecord.changes)
        return {
          decision:
            (await input.onApprovalRequest?.('file-change', {
              ...request.params,
              changes: changes ?? requestedChanges ?? []
            })) ?? 'cancel'
        }
      }
      case 'item/tool/requestUserInput':
        return input.onApprovalRequest?.('tool-user-input', request.params) ?? { answers: {} }
      case 'mcpServer/elicitation/request':
        return input.onApprovalRequest?.('mcp-elicitation', request.params) ?? { action: 'decline' }
      case 'item/permissions/requestApproval':
        return (
          input.onApprovalRequest?.('permission-request', request.params) ?? { decision: 'decline' }
        )
      case 'item/tool/call':
        return (
          input.onDynamicToolCall?.(request.params) ?? {
            success: false,
            contentItems: [{ type: 'inputText', text: 'This desktop tool is unavailable.' }]
          }
        )
      case 'account/chatgptAuthTokens/refresh':
      case 'attestation/generate':
      case 'currentTime/read':
      case 'applyPatchApproval':
      case 'execCommandApproval':
        throw new NativeServerRequestUnsupportedError(request.method)
      default:
        return assertNever(request)
    }
  }
}

export class NativeCodexRunSession {
  private active = true
  private currentTurnId: string | undefined

  constructor(
    private readonly options: {
      client: AppServerClient
      threadId: string
      turnId?: string
      inputAdapter: CodexRunInputAdapter
      runInput: NativeCodexRunDriverInput
      onTurnId(turnId: string): void
    }
  ) {
    this.currentTurnId = options.turnId
  }

  get threadId(): string {
    return this.options.threadId
  }

  get turnId(): string | undefined {
    return this.currentTurnId
  }

  isActive(): boolean {
    return this.active
  }

  setTurnId(turnId: string | undefined): void {
    this.currentTurnId = turnId
  }

  complete(): void {
    this.active = false
  }

  async steerMessage(message: UIMessage, clientUserMessageId: string): Promise<{ turnId: string }> {
    if (!this.active) throw new Error('session_inactive')
    const expectedTurnId = this.currentTurnId
    if (!expectedTurnId) throw new Error('steer_requires_active_turn')
    const resolved = await this.options.inputAdapter.resolve([message], {
      activeThreadId: this.threadId
    })
    const result = await this.options.client.request<{ turnId: string }>('turn/steer', {
      threadId: this.threadId,
      clientUserMessageId,
      input: resolved.input,
      expectedTurnId
    })
    const turnId = result.turnId
    this.currentTurnId = turnId
    this.options.onTurnId(turnId)
    return { turnId }
  }

  async setThreadGoal(params: { objective: string; status: 'active' }): Promise<ThreadGoalSummary> {
    const response = await this.options.client.request<ThreadGoalSetResponse>('thread/goal/set', {
      threadId: this.threadId,
      ...params
    })
    return response.goal
  }

  async clearThreadGoal(): Promise<boolean> {
    const result = await this.options.client.request<{ cleared?: boolean }>('thread/goal/clear', {
      threadId: this.threadId
    })
    return result.cleared ?? true
  }

  async interrupt(): Promise<void> {
    if (!this.active) return
    const turnId = this.currentTurnId
    if (!turnId) return
    await this.options.client.request('turn/interrupt', { threadId: this.threadId, turnId })
    this.active = false
    await this.options.inputAdapter.cleanup()
  }
}

class NativeServerRequestUnsupportedError extends Error {
  constructor(method: string) {
    super(`Unsupported Codex server request: ${method}`)
    this.name = 'NativeServerRequestUnsupportedError'
  }
}

const SERVER_REQUEST_METHODS: ServerRequest['method'][] = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval'
]

function threadStartParams(input: NativeCodexRunDriverInput): Record<string, unknown> {
  const customModel = customModelConfig(input.clientModel)
  return omitUndefined({
    model: input.modelId,
    modelProvider: customModel.modelProvider,
    cwd: input.cwd,
    runtimeWorkspaceRoots: input.runtimeWorkspaceRoots,
    approvalPolicy: input.approvalPolicy,
    approvalsReviewer: input.approvalsReviewer,
    sandbox: input.sandbox,
    config: customModel.config,
    developerInstructions: input.developerInstructions,
    ephemeral: input.ephemeral,
    dynamicTools: input.ephemeral ? [] : undefined
  })
}

function threadResumeParams(input: NativeCodexRunDriverInput): Record<string, unknown> {
  const customModel = customModelConfig(input.clientModel)
  return omitUndefined({
    threadId: input.resumeThreadId,
    model: input.modelId,
    modelProvider: customModel.modelProvider,
    cwd: input.cwd,
    runtimeWorkspaceRoots: input.runtimeWorkspaceRoots,
    approvalPolicy: input.approvalPolicy,
    approvalsReviewer: input.approvalsReviewer,
    sandbox: input.sandbox,
    config: customModel.config,
    developerInstructions: input.developerInstructions,
    initialTurnsPage: { limit: 5, itemsView: 'full', sortDirection: 'desc' }
  })
}

function customModelConfig(model: AdminBackendClientModel | undefined): {
  modelProvider?: string
  config?: Record<string, unknown>
} {
  if (!model) return {}
  if (model.api_format.trim().toLowerCase() !== 'openai' || !model.api_base_url?.trim()) {
    throw new Error(`Unsupported admin backend model configuration: ${model.model_id}`)
  }
  return {
    modelProvider: model.provider,
    config: {
      model_provider: model.provider,
      model_providers: {
        [model.provider]: omitUndefined({
          name: model.provider,
          base_url: model.api_base_url.trim(),
          experimental_bearer_token: model.api_key?.trim(),
          wire_api: 'responses',
          requires_openai_auth: false,
          supports_websockets: false,
          request_max_retries: 0,
          stream_max_retries: 0
        })
      }
    }
  }
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function fileChangeKey(params: unknown, itemId: unknown): string | undefined {
  if (!isRecord(params)) return undefined
  const threadId = params.threadId
  const turnId = params.turnId
  if (typeof threadId !== 'string' || typeof turnId !== 'string' || typeof itemId !== 'string') {
    return undefined
  }
  return `${threadId}\0${turnId}\0${itemId}`
}

function isTerminalGoal(goal: ThreadGoalSummary | null): boolean {
  return (
    goal === null ||
    ['paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goal.status)
  )
}

function assertNever(value: never): never {
  throw new NativeServerRequestUnsupportedError(String(value))
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private done = false
  private failure: unknown
  private resolveCompletion!: () => void
  private readonly completion = new Promise<void>((resolve) => {
    this.resolveCompletion = resolve
  })

  push(value: T): void {
    if (this.done) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.done) return
    this.done = true
    this.resolveCompletion()
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined as never, done: true })
  }

  fail(error: unknown): void {
    this.failure = error
    this.end()
  }

  waitForEnd(): Promise<void> {
    return this.completion
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length > 0) yield this.values.shift()!
      else if (this.done) {
        if (this.failure) throw this.failure
        return
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
        if (result.done) {
          if (this.failure) throw this.failure
          return
        }
        yield result.value
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}
