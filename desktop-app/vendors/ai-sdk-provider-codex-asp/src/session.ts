import type { LanguageModelV3Prompt } from '@ai-sdk/provider'
import type { ThreadReadResponse } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/ThreadReadResponse'
import type { TurnSteerParams } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/TurnSteerParams'
import type { TurnSteerResponse } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/TurnSteerResponse'
import type { UserInput } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/UserInput'

import { type AppServerClient, JsonRpcError } from './client/app-server-client'
import { CodexProviderError } from './errors'
import type {
  CodexTurnInterruptParams,
  CodexTurnInterruptResult,
  CodexTurnStartParams,
  CodexTurnStartResult,
  ThreadGoal,
  ThreadGoalClearResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse
} from './protocol/types'
import type { PromptFileResolver } from './utils/prompt-file-resolver'

export type CodexSteerErrorCode =
  | 'session_inactive'
  | 'steer_result_unknown'
  | 'expected_turn_mismatch'
  | 'unsupported_active_turn_kind'
  | 'app_server_rejected'
  | 'attachment_resolution_failed'

export interface CodexSteerResult {
  turnId: string
}

export class CodexSteerError extends CodexProviderError {
  override readonly code: CodexSteerErrorCode

  constructor(code: CodexSteerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CodexSteerError'
    this.code = code
  }
}

function inactiveSessionError(cause?: unknown): CodexSteerError {
  return new CodexSteerError(
    'session_inactive',
    'Cannot steer a session without an active turn.',
    cause === undefined ? undefined : { cause }
  )
}

function isExpectedTurnMismatch(error: unknown): error is JsonRpcError {
  return error instanceof JsonRpcError && error.message.startsWith('expected active turn id ')
}

function isUnsupportedActiveTurnKind(error: unknown): error is JsonRpcError {
  if (!(error instanceof JsonRpcError)) {
    return false
  }

  const data = error.data as
    | {
        codexErrorInfo?: { activeTurnNotSteerable?: unknown }
      }
    | undefined

  return (
    data?.codexErrorInfo?.activeTurnNotSteerable !== undefined ||
    error.message === 'cannot steer a review turn' ||
    error.message === 'cannot steer a compact turn'
  )
}

export interface CodexSession {
  readonly threadId: string
  readonly turnId: string | undefined
  isActive(): boolean
  injectMessage(input: string | UserInput[]): Promise<void>
  steerPrompt(
    prompt: LanguageModelV3Prompt,
    options: { clientUserMessageId: string }
  ): Promise<CodexSteerResult>
  getThreadGoal?(): Promise<ThreadGoal | null>
  setThreadGoal?(params: Omit<ThreadGoalSetParams, 'threadId'>): Promise<ThreadGoal>
  clearThreadGoal?(): Promise<boolean>
  interrupt(): Promise<void>
}

/**
 * Provider-owned conversation connection shared by normal and automatically
 * continuing Goal turns. Main only receives this safe session façade; it does
 * not implement app-server JSON-RPC itself.
 */
export class CodexConversationSession implements CodexSession {
  private readonly _threadId: string
  private _turnId: string | undefined
  private _active = true
  private readonly client: AppServerClient
  private readonly interruptTimeoutMs: number
  private readonly fileResolver: PromptFileResolver
  private readonly onPolicyChanged:
    ((policy: 'single-turn' | 'goal-continuous') => void) | undefined
  private _policy: 'single-turn' | 'goal-continuous'
  private readonly interruptPromises = new Map<string, Promise<void>>()

  constructor(opts: {
    client: AppServerClient
    threadId: string
    turnId: string | undefined
    interruptTimeoutMs: number
    fileResolver: PromptFileResolver
    policy?: 'single-turn' | 'goal-continuous'
    onPolicyChanged?: (policy: 'single-turn' | 'goal-continuous') => void
  }) {
    this.client = opts.client
    this._threadId = opts.threadId
    this._turnId = opts.turnId
    this.interruptTimeoutMs = opts.interruptTimeoutMs
    this.fileResolver = opts.fileResolver
    this._policy = opts.policy ?? 'single-turn'
    this.onPolicyChanged = opts.onPolicyChanged
  }

  get threadId(): string {
    return this._threadId
  }

  get turnId(): string | undefined {
    return this._turnId
  }

  get policy(): 'single-turn' | 'goal-continuous' {
    return this._policy
  }

  private setPolicy(policy: 'single-turn' | 'goal-continuous'): void {
    if (policy === this._policy) return
    this._policy = policy
    this.onPolicyChanged?.(policy)
  }

  /** @internal Called by the model when turn/started arrives with a turnId. */
  setTurnId(turnId: string): void {
    this._turnId = turnId
  }

  /** @internal Called by the model when the turn completes or the stream closes. */
  markInactive(): void {
    this._active = false
  }

  isActive(): boolean {
    return this._active
  }

  /**
   * Inject follow-up input into the current thread.
   *
   * Uses turn/start which the app-server routes through steer_input when a
   * turn is already active, or starts a new turn otherwise. This avoids the
   * strict timing requirements of turn/steer (which needs codex/event/task_started
   * before it accepts input). We may revisit turn/steer in the future.
   */
  async injectMessage(input: string | UserInput[]): Promise<void> {
    if (!this._active) {
      throw new Error('Session is no longer active.')
    }

    const userInput: UserInput[] =
      typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input

    const turnStartParams: CodexTurnStartParams = {
      threadId: this._threadId,
      input: userInput
    }

    const result = await this.client.request<CodexTurnStartResult & { turn?: { id?: string } }>(
      'turn/start',
      turnStartParams
    )

    // Update turnId if the server started a new turn
    const newTurnId = result.turnId ?? result.turn?.id
    if (newTurnId) {
      this._turnId = newTurnId
    }
  }

  async steerPrompt(
    prompt: LanguageModelV3Prompt,
    options: { clientUserMessageId: string }
  ): Promise<CodexSteerResult> {
    if (!this._active || !this._turnId) {
      throw inactiveSessionError()
    }

    let input: UserInput[]
    try {
      input = await this.fileResolver.resolve(prompt, true, {
        activeThreadId: this._threadId,
        loadTask: (threadId) =>
          this.client.request<ThreadReadResponse>('thread/read', {
            threadId,
            includeTurns: true
          })
      })
    } catch (error) {
      throw new CodexSteerError(
        'attachment_resolution_failed',
        'Failed to resolve steer prompt attachments.',
        { cause: error }
      )
    }

    if (!this._active || !this._turnId) {
      await this.fileResolver.cleanup()
      throw inactiveSessionError()
    }

    let expectedTurnId = this._turnId

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this._active) {
        throw inactiveSessionError()
      }

      const params: TurnSteerParams = {
        threadId: this._threadId,
        input,
        expectedTurnId,
        clientUserMessageId: options.clientUserMessageId
      }

      try {
        const result = await this.client.request<TurnSteerResponse>('turn/steer', params)
        return { turnId: result.turnId }
      } catch (error) {
        // A closed session means a transport failure cannot be
        // confirmed, but a JSON-RPC error is an explicit app-server
        // response. Preserve that distinction even when the matching
        // turn/completed notification reached us before its steer
        // response, otherwise a known rejection becomes an
        // unnecessary recovery-uncertain queue state.
        if (!this._active && !(error instanceof JsonRpcError)) {
          throw new CodexSteerError(
            'steer_result_unknown',
            'The session ended before the steer result could be confirmed.',
            { cause: error }
          )
        }

        const latestTurnId = this._turnId
        const shouldRetry =
          attempt === 0 &&
          isExpectedTurnMismatch(error) &&
          latestTurnId !== undefined &&
          latestTurnId !== expectedTurnId

        if (shouldRetry) {
          expectedTurnId = latestTurnId
          continue
        }

        if (isExpectedTurnMismatch(error)) {
          throw new CodexSteerError('expected_turn_mismatch', error.message, { cause: error })
        }

        if (isUnsupportedActiveTurnKind(error)) {
          throw new CodexSteerError('unsupported_active_turn_kind', error.message, { cause: error })
        }

        if (!(error instanceof JsonRpcError)) {
          throw new CodexSteerError(
            'steer_result_unknown',
            'The steer request result could not be confirmed.',
            { cause: error }
          )
        }

        throw new CodexSteerError(
          'app_server_rejected',
          error instanceof Error ? error.message : 'App server rejected the steer request.',
          { cause: error }
        )
      }
    }

    throw new CodexSteerError('expected_turn_mismatch', 'The active turn changed while steering.')
  }

  async getThreadGoal(): Promise<ThreadGoal | null> {
    const response = await this.client.request<ThreadGoalGetResponse>('thread/goal/get', {
      threadId: this._threadId
    })
    return response.goal
  }

  async setThreadGoal(params: Omit<ThreadGoalSetParams, 'threadId'>): Promise<ThreadGoal> {
    const previousPolicy = this._policy
    if (params.status === 'active') {
      this.setPolicy('goal-continuous')
    }

    try {
      const response = await this.client.request<ThreadGoalSetResponse>('thread/goal/set', {
        threadId: this._threadId,
        ...params
      })
      if (response.goal.status !== 'active') {
        this.setPolicy(previousPolicy)
      }
      return response.goal
    } catch (error) {
      this.setPolicy(previousPolicy)
      throw error
    }
  }

  async clearThreadGoal(): Promise<boolean> {
    const response = await this.client.request<ThreadGoalClearResponse>('thread/goal/clear', {
      threadId: this._threadId
    })
    return response.cleared
  }

  async interrupt(): Promise<void> {
    if (!this._active || !this._turnId) {
      return
    }

    const interruptKey = `${this._threadId}:${this._turnId}`
    const existing = this.interruptPromises.get(interruptKey)
    if (existing) {
      return existing
    }

    const interruptParams: CodexTurnInterruptParams = {
      threadId: this._threadId,
      turnId: this._turnId
    }

    const interrupt = this.client
      .request<CodexTurnInterruptResult>('turn/interrupt', interruptParams, this.interruptTimeoutMs)
      .then(() => undefined)
    this.interruptPromises.set(interruptKey, interrupt)
    return interrupt
  }
}

/** @deprecated Use {@link CodexConversationSession}. */
export class CodexSessionImpl extends CodexConversationSession {}
