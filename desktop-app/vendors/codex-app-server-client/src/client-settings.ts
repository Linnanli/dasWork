import type { CodexTransport } from './client/transport'
import type { StdioTransportSettings } from './client/transport-stdio'
import type { WebSocketTransportSettings } from './client/transport-websocket'
import type { CodexRenderableThreadItem } from './protocol/shared-item-extractors'

/** Context for a host-owned logical connection lease. */
export type TransportContext = {
  signal?: AbortSignal
  threadId?: string
}

/**
 * Host-neutral connection settings used by catalog, history, command, and
 * process-session clients. They intentionally contain no AI SDK call or UI
 * message types.
 */
export interface CodexAppServerClientSettings {
  clientInfo?: { name: string; version: string; title?: string }
  experimentalApi?: boolean
  transport?: {
    type?: 'stdio' | 'websocket'
    stdio?: StdioTransportSettings
    websocket?: WebSocketTransportSettings
  }
  transportFactory?: (context: TransportContext) => CodexTransport
  debug?: {
    logPackets?: boolean
    logger?: (packet: { direction: 'inbound' | 'outbound'; message: unknown }) => void
  }
}

export type CodexAgentLifecycleKind = 'started' | 'updated' | 'completed' | 'closed'

export type CodexAgentLifecycleEvent = {
  kind: CodexAgentLifecycleKind
  threadId: string
  turnId: string
  agentThreadId: string
  agentPath?: string
  status?: string
  toolCallId: string
  timestampMs?: number
}

export type CodexTurnLifecycleEvent =
  | { type: 'turn-started'; sequence: number; threadId: string; turnId: string }
  | {
      type: 'item-started' | 'item-completed'
      sequence: number
      threadId: string
      turnId: string
      itemId: string
      itemType: string
      item?: CodexRenderableThreadItem
      clientUserMessageId?: string
      compareKey?: string
    }
  | {
      type: 'turn-completed'
      sequence: number
      threadId: string
      turnId: string
      outcome: 'completed' | 'interrupted' | 'failed'
      error?: string
    }
