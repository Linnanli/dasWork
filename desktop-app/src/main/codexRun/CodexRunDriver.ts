import type { UIMessage, UIMessageChunk } from 'ai'
import type {
  CollaborationMode,
  CodexExistingTurnRecoveryState
} from '@dascowork/codex-app-server-client'

import type { AdminBackendClientModel } from '../adminBackendModelClient'
import type { CodexAppServerLaunchOptions } from '../codexAppServerLaunch'
import type { ConversationExecutionTarget } from '../threads/startConversation'
import type {
  CodexChatRequest,
  CodexTurnLifecycleEvent,
  ThreadGoalSummary
} from '../../shared/codexIpcApi'
import { CodexUiMessageAdapter } from './CodexUiMessageAdapter'
import { NativeCodexRunDriver } from './NativeCodexRunDriver'
import { HostCodexConnection } from './HostCodexConnection'

export type CodexRunApprovalHandlers = {
  command?(params: unknown): Promise<unknown>
  fileChange?(params: unknown): Promise<unknown>
  toolUserInput?(params: unknown): Promise<unknown>
  elicitation?(params: unknown): Promise<unknown>
  permissions?(params: unknown): Promise<unknown>
}

export type CodexRunApprovalSettings = {
  approvalPolicy: 'never' | 'on-request'
  approvalsReviewer: 'user' | 'auto_review'
  sandbox: 'workspace-write' | 'danger-full-access'
  sandboxPolicy: Record<string, unknown>
}

export type CodexRunDriverInput = {
  request: CodexChatRequest
  modelId: string
  abortSignal: AbortSignal
  clientModel?: AdminBackendClientModel
  executionTarget?: ConversationExecutionTarget
  resumeThreadId?: string
  resumeActiveTurn?: boolean
  existingTurnRecoveryState?: CodexExistingTurnRecoveryState
  startFreshTerminalRetry?: boolean
  onThreadStarted?(thread: { threadId: string; threadPath?: string }): void | Promise<void>
  onAgentLifecycle?(event: unknown): void | Promise<void>
  onTurnLifecycle?(event: CodexTurnLifecycleEvent | Record<string, unknown>): void | Promise<void>
  onTurnDiffUpdated?(event: {
    threadId: string
    turnId: string
    diff: string
  }): void | Promise<void>
  onThreadSettingsUpdated?(event: {
    threadId: string
    modeKind: 'default' | 'plan'
    [key: string]: unknown
  }): void | Promise<void>
  onThreadGoalUpdated?(event: {
    threadId: string
    goal: ThreadGoalSummary | null
  }): void | Promise<void>
  onSessionCreated?(session: CodexRunSession): void | Promise<void>
  onDynamicToolCall?(params: unknown): Promise<unknown>
  onExistingTurnRecoveryState?(state: CodexExistingTurnRecoveryState): void
  collaborationMode?: CollaborationMode
  approvalSettings?: CodexRunApprovalSettings
  /** Creates an unpersisted, isolated app-server thread for utility work. */
  ephemeral?: boolean
  goalFirstTurnObjective?: string
  goalControlObjective?: string
  goalContinuous?: boolean
  approvals?: CodexRunApprovalHandlers
}

/** The only controls the chat service needs from an active native run. */
export type CodexRunSession = {
  readonly threadId: string
  readonly turnId: string | undefined
  isActive(): boolean
  steerMessage(message: UIMessage, clientUserMessageId: string): Promise<{ turnId: string }>
  setThreadGoal(params: { objective: string; status: 'active' }): Promise<ThreadGoalSummary>
  clearThreadGoal(): Promise<boolean>
  interrupt(): Promise<void>
}

export type CodexRunDriverResult = {
  toUIMessageStream(options?: {
    originalMessages?: readonly UIMessage[]
    onError?(error: unknown): string
    messageMetadata?(input: { part: unknown }): unknown
  }): AsyncIterable<UIMessageChunk>
}

export interface CodexRunDriver {
  start(input: CodexRunDriverInput): Promise<CodexRunDriverResult> | CodexRunDriverResult
  listModels(): Promise<
    Array<{
      id: string
      displayName: string
      model?: string
      description?: string
      inputModalities?: string[]
      isDefault?: boolean
    }>
  >
  shutdown(): Promise<void>
}

export function createNativeCodexRunDriver(
  launch: CodexAppServerLaunchOptions,
  host?: HostCodexConnection
): CodexRunDriver {
  const native = new NativeCodexRunDriver(launch, host)
  return {
    async start(input) {
      const nativeRun = native.start({
        messages: input.request.messages,
        modelId: input.modelId,
        clientUserMessageId: input.request.messageId,
        clientModel: input.clientModel,
        cwd: input.executionTarget?.cwd,
        runtimeWorkspaceRoots: input.executionTarget?.runtimeWorkspaceRoots,
        approvalPolicy: input.approvalSettings?.approvalPolicy,
        approvalsReviewer: input.approvalSettings?.approvalsReviewer,
        sandbox: input.approvalSettings?.sandbox,
        sandboxPolicy: input.approvalSettings?.sandboxPolicy,
        developerInstructions: input.request.body?.system,
        collaborationMode: input.collaborationMode,
        resumeThreadId: input.startFreshTerminalRetry ? undefined : input.resumeThreadId,
        resumeActiveTurn: input.resumeActiveTurn,
        existingTurnRecoveryState: input.existingTurnRecoveryState,
        goalFirstTurnObjective: input.goalFirstTurnObjective,
        goalControl: Boolean(input.goalControlObjective),
        goalContinuous: input.goalContinuous,
        ephemeral: input.ephemeral,
        signal: input.abortSignal,
        onThreadStarted: input.onThreadStarted,
        onLifecycle: input.onTurnLifecycle,
        onAgentLifecycle: input.onAgentLifecycle,
        onTurnDiffUpdated: input.onTurnDiffUpdated,
        onThreadSettingsUpdated: input.onThreadSettingsUpdated,
        onThreadGoalUpdated: input.onThreadGoalUpdated,
        onSessionCreated: input.onSessionCreated,
        onExistingTurnRecoveryState: input.onExistingTurnRecoveryState,
        onDynamicToolCall: input.onDynamicToolCall,
        onApprovalRequest: (kind, params) => {
          switch (kind) {
            case 'command':
              return input.approvals?.command?.(params) ?? Promise.resolve('cancel')
            case 'file-change':
              return input.approvals?.fileChange?.(params) ?? Promise.resolve('cancel')
            case 'tool-user-input':
              return input.approvals?.toolUserInput?.(params) ?? Promise.resolve({ answers: {} })
            case 'mcp-elicitation':
              return (
                input.approvals?.elicitation?.(params) ?? Promise.resolve({ action: 'decline' })
              )
            case 'permission-request':
              return (
                input.approvals?.permissions?.(params) ??
                Promise.resolve({ permissions: {}, scope: 'turn' })
              )
          }
        }
      })
      void nativeRun.session.catch(() => undefined)
      return {
        toUIMessageStream: (options) => mapNativeEventsToUiChunks(nativeRun.events, options)
      }
    },
    listModels: () => native.listModels(),
    shutdown: () => native.shutdown()
  }
}

async function* mapNativeEventsToUiChunks(
  events: AsyncIterable<Parameters<CodexUiMessageAdapter['map']>[0]>,
  options?: Parameters<CodexRunDriverResult['toUIMessageStream']>[0]
): AsyncGenerator<UIMessageChunk> {
  const adapter = new CodexUiMessageAdapter()
  try {
    for await (const event of events) {
      for (const chunk of adapter.map(event)) yield chunk
    }
  } catch (error) {
    yield {
      type: 'error',
      errorText:
        options?.onError?.(error) ?? (error instanceof Error ? error.message : String(error))
    }
  }
}
