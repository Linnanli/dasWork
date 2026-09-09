/**
 * Hand-maintained subset of the Codex app-server protocol types.
 *
 * Only includes types this provider actively uses. When adding new types,
 * check the full generated set first:
 *
 *   npm run codex:generate-types
 *
 * The generated types land in src/protocol/app-server-protocol/ (gitignored)
 * and serve as the authoritative reference. V2 types (camelCase) are in the v2/ subdirectory.
 */
import type { CollaborationMode } from './app-server-protocol/CollaborationMode'
import type { JsonValue } from './app-server-protocol/serde_json/JsonValue'
import type { ApprovalsReviewer } from './app-server-protocol/v2/ApprovalsReviewer'
import type { AskForApproval } from './app-server-protocol/v2/AskForApproval'
import type { CollaborationModeListParams } from './app-server-protocol/v2/CollaborationModeListParams'
import type { CollaborationModeListResponse } from './app-server-protocol/v2/CollaborationModeListResponse'
import type { CollaborationModeMask } from './app-server-protocol/v2/CollaborationModeMask'
import type { CommandExecutionApprovalDecision } from './app-server-protocol/v2/CommandExecutionApprovalDecision'
import type { CommandExecutionRequestApprovalParams } from './app-server-protocol/v2/CommandExecutionRequestApprovalParams'
import type { CommandExecutionRequestApprovalResponse } from './app-server-protocol/v2/CommandExecutionRequestApprovalResponse'
import type { FileChangeApprovalDecision } from './app-server-protocol/v2/FileChangeApprovalDecision'
import type { FileChangeRequestApprovalParams } from './app-server-protocol/v2/FileChangeRequestApprovalParams'
import type { FileChangeRequestApprovalResponse } from './app-server-protocol/v2/FileChangeRequestApprovalResponse'
import type { McpServerElicitationRequestParams } from './app-server-protocol/v2/McpServerElicitationRequestParams'
import type { McpServerElicitationRequestResponse } from './app-server-protocol/v2/McpServerElicitationRequestResponse'
import type { PermissionsRequestApprovalParams } from './app-server-protocol/v2/PermissionsRequestApprovalParams'
import type { PermissionsRequestApprovalResponse } from './app-server-protocol/v2/PermissionsRequestApprovalResponse'
import type { SandboxMode } from './app-server-protocol/v2/SandboxMode'
import type { SandboxPolicy } from './app-server-protocol/v2/SandboxPolicy'
import type { Thread } from './app-server-protocol/v2/Thread'
import type { ThreadCompactStartParams } from './app-server-protocol/v2/ThreadCompactStartParams'
import type { ThreadCompactStartResponse } from './app-server-protocol/v2/ThreadCompactStartResponse'
import type { ThreadGoal } from './app-server-protocol/v2/ThreadGoal'
import type { ThreadGoalClearParams } from './app-server-protocol/v2/ThreadGoalClearParams'
import type { ThreadGoalClearResponse } from './app-server-protocol/v2/ThreadGoalClearResponse'
import type { ThreadGoalGetParams } from './app-server-protocol/v2/ThreadGoalGetParams'
import type { ThreadGoalGetResponse } from './app-server-protocol/v2/ThreadGoalGetResponse'
import type { ThreadGoalSetParams } from './app-server-protocol/v2/ThreadGoalSetParams'
import type { ThreadGoalSetResponse } from './app-server-protocol/v2/ThreadGoalSetResponse'
import type { ThreadGoalStatus } from './app-server-protocol/v2/ThreadGoalStatus'
import type { ThreadItem } from './app-server-protocol/v2/ThreadItem'
import type { ThreadResumeParams } from './app-server-protocol/v2/ThreadResumeParams'
import type { ThreadResumeResponse } from './app-server-protocol/v2/ThreadResumeResponse'
import type { ThreadSettings } from './app-server-protocol/v2/ThreadSettings'
import type { ThreadSettingsUpdatedNotification } from './app-server-protocol/v2/ThreadSettingsUpdatedNotification'
import type { ToolRequestUserInputParams } from './app-server-protocol/v2/ToolRequestUserInputParams'
import type { ToolRequestUserInputResponse } from './app-server-protocol/v2/ToolRequestUserInputResponse'
import type { Turn } from './app-server-protocol/v2/Turn'
import type { TurnInterruptParams } from './app-server-protocol/v2/TurnInterruptParams'
import type { TurnInterruptResponse } from './app-server-protocol/v2/TurnInterruptResponse'
import type { TurnStartParams } from './app-server-protocol/v2/TurnStartParams'
import type { UserInput } from './app-server-protocol/v2/UserInput'

export type { AskForApproval }
export type { ApprovalsReviewer }
export type { CollaborationMode }
export type { CollaborationModeListParams }
export type { CollaborationModeListResponse }
export type { CollaborationModeMask }
export type { CommandExecutionApprovalDecision }
export type { CommandExecutionRequestApprovalParams }
export type { CommandExecutionRequestApprovalResponse }
export type { FileChangeApprovalDecision }
export type { FileChangeRequestApprovalParams }
export type { FileChangeRequestApprovalResponse }
export type { SandboxMode }
export type { SandboxPolicy }
export type { ThreadCompactStartParams }
export type { ThreadCompactStartResponse }
export type { ThreadGoal }
export type { ThreadGoalClearParams }
export type { ThreadGoalClearResponse }
export type { ThreadGoalGetParams }
export type { ThreadGoalGetResponse }
export type { ThreadGoalSetParams }
export type { ThreadGoalSetResponse }
export type { ThreadGoalStatus }
export type { ThreadItem }
export type { Thread }
export type { ThreadSettings }
export type { ThreadSettingsUpdatedNotification }
export type { McpServerElicitationRequestParams }
export type { McpServerElicitationRequestResponse }
export type { PermissionsRequestApprovalParams }
export type { PermissionsRequestApprovalResponse }
export type { ToolRequestUserInputParams }
export type { ToolRequestUserInputResponse }
export type { TurnInterruptParams }
export type { TurnInterruptResponse }
export type { Turn }

// Re-export official v2 notification types used by the event mapper
export type { ServerRequest } from './app-server-protocol/ServerRequest'
export type { AgentMessageDeltaNotification } from './app-server-protocol/v2/AgentMessageDeltaNotification'
export type { ItemCompletedNotification } from './app-server-protocol/v2/ItemCompletedNotification'
export type { ItemStartedNotification } from './app-server-protocol/v2/ItemStartedNotification'
export type { ThreadTokenUsageUpdatedNotification } from './app-server-protocol/v2/ThreadTokenUsageUpdatedNotification'
export type { TurnCompletedNotification } from './app-server-protocol/v2/TurnCompletedNotification'
export type { TurnStartedNotification } from './app-server-protocol/v2/TurnStartedNotification'

export interface JsonRpcMessageBase {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface CodexInitializeParams {
  clientInfo: {
    name: string
    version: string
    title?: string
  }
  capabilities?: {
    experimentalApi?: boolean
  }
}

export interface CodexInitializeResult {
  serverInfo?: {
    name: string
    version: string
  }
}

export interface CodexInitializedNotification {
  method: 'initialized'
  params?: Record<string, never>
}

export interface CodexDynamicToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface CodexThreadStartParams {
  model?: string
  modelProvider?: string
  cwd?: string
  approvalPolicy?: AskForApproval
  approvalsReviewer?: ApprovalsReviewer
  sandbox?: SandboxMode
  ephemeral?: boolean
  config?: Record<string, JsonValue | undefined>
  dynamicTools?: CodexDynamicToolDefinition[]
  developerInstructions?: string
}

export interface CodexThreadStartResult {
  threadId: string
  tools?: CodexDynamicToolDefinition[]
}

export type CodexThreadCompactStartParams = ThreadCompactStartParams
export type CodexThreadCompactStartResult = ThreadCompactStartResponse

export type CodexThreadResumeParams = ThreadResumeParams

export type CodexThreadResumeResult = ThreadResumeResponse
export type CodexTurnInterruptParams = TurnInterruptParams
export type CodexTurnInterruptResult = TurnInterruptResponse

export type CodexTurnInputItem = UserInput
export type CodexTurnInputText = Extract<UserInput, { type: 'text' }>
export type CodexTurnInputImage = Extract<UserInput, { type: 'image' }>
export type CodexTurnInputLocalImage = Extract<UserInput, { type: 'localImage' }>
export type CodexTurnInputSkill = Extract<UserInput, { type: 'skill' }>
export type CodexTurnInputMention = Extract<UserInput, { type: 'mention' }>

export type CodexTurnStartParams = TurnStartParams
export type CodexDynamicToolCallItem = Extract<ThreadItem, { type: 'dynamicToolCall' }>

export interface CodexTurnStartResult {
  turnId: string
}

export interface CodexToolCallStartedNotification {
  method: 'item/tool/callStarted'
  params: {
    callId: string
    tool: string
  }
}

export interface CodexToolCallDeltaNotification {
  method: 'item/tool/callDelta'
  params: {
    callId: string
    delta: string
  }
}

export interface CodexToolCallFinishedNotification {
  method: 'item/tool/callFinished'
  params: {
    callId: string
  }
}

export interface CodexToolCallRequestParams {
  threadId?: string
  turnId?: string
  callId?: string
  namespace?: string | null
  tool?: string
  toolName?: string
  arguments?: unknown
  input?: unknown
}

export type CodexToolResultContentItem =
  { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }

export interface CodexToolCallResult {
  success: boolean
  contentItems: CodexToolResultContentItem[]
}

export type CodexNotification =
  | CodexInitializedNotification
  | CodexToolCallStartedNotification
  | CodexToolCallDeltaNotification
  | CodexToolCallFinishedNotification
