import type { ThreadGoalSummary } from '../../../../shared/codexIpcApi'
import type { ProjectSelection } from '../../../../shared/projects/projectTypes'
import type { SubagentActivityDisplayStatus } from '@/lib/assistantRenderUnits'

export type WorkspaceTaskAgent = {
  eventId: string
  threadId?: string
  agentPath: string
  displayName: string
  displayStatus: SubagentActivityDisplayStatus
  model?: string
}

export type WorkspaceTimelineEvent = {
  id: string
  type: 'user' | 'assistant' | 'activity' | 'subagent'
  label: string
  status?: string
}

export type WorkspaceOutputResource = {
  id: string
  type: 'file' | 'website' | 'google-drive' | 'appgen-app'
  title: string
  path?: string
  url?: string
  line?: number
  cwd?: string
}

export type WorkspaceOutputCreationKind = 'document' | 'presentation' | 'spreadsheet' | 'website'

/** A normalized source or task activity observed anywhere in the current conversation. */
export type WorkspaceSource = {
  id: string
  sourceType: 'url' | 'document' | 'file' | 'web-search' | 'mcp' | 'app'
  title: string
  url?: string
  mediaType?: string
  filename?: string
  /** Context that is safe to display but intentionally not treated as a navigable URL. */
  detail?: string
  /** Present only for an MCP App resource observed in the app-server transcript. */
  mcpServer?: string
  resourceUri?: string
  usageCount: number
}

/** Live, renderer-only information about the conversation currently in view. */
export type WorkspaceTaskSummary = {
  conversationId: string
  threadId?: string
  title?: string | null
  projectSelection?: ProjectSelection
  cwd?: string
  status: string
  messageCount: number
  canOpenLocalPaths: boolean
  goal?: ThreadGoalSummary | null
  agents: readonly WorkspaceTaskAgent[]
  timeline: readonly WorkspaceTimelineEvent[]
  outputs: readonly WorkspaceOutputResource[]
  sources: readonly WorkspaceSource[]
}
