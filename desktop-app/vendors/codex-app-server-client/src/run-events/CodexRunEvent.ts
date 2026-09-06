/**
 * Protocol-neutral events emitted by a Codex App Server turn. This is the
 * only streaming event contract owned by the AI-free client; UI and AI SDK
 * representations are projected by desktop adapters.
 */
export type CodexRunMetadata = Record<string, unknown>

export type CodexRunUsage = {
  inputTokens: {
    total?: number | undefined
    noCache?: number | undefined
    cacheRead?: number | undefined
    cacheWrite?: number | undefined
  }
  outputTokens: {
    total?: number | undefined
    text?: number | undefined
    reasoning?: number | undefined
  }
}

export type CodexRunFinishReason = {
  unified: 'stop' | 'error' | 'other'
  raw?: string | undefined
}

type EventBase = { metadata?: CodexRunMetadata }

export type CodexRunEvent =
  | (EventBase & { type: 'stream-start'; warnings: unknown[] })
  | (EventBase & { type: 'text-start'; id: string })
  | (EventBase & { type: 'text-delta'; id: string; delta: string })
  | (EventBase & { type: 'text-end'; id: string })
  | (EventBase & { type: 'reasoning-start'; id: string })
  | (EventBase & { type: 'reasoning-delta'; id: string; delta: string })
  | (EventBase & { type: 'reasoning-end'; id: string })
  | (EventBase & {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: string
      providerExecuted?: boolean
      dynamic?: boolean
    })
  | (EventBase & {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      result: unknown
      isError?: boolean
      preliminary?: boolean
    })
  | (EventBase & { type: 'tool-input-start'; id: string; toolName: string; dynamic?: boolean })
  | (EventBase & { type: 'tool-input-delta'; id: string; delta: string })
  | (EventBase & { type: 'tool-input-end'; id: string })
  | (EventBase & { type: 'file'; mediaType: string; data: string })
  | (EventBase & { type: 'error'; error: unknown })
  | (EventBase & { type: 'finish'; finishReason: CodexRunFinishReason; usage: CodexRunUsage })
