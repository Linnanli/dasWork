import type { SharedV3ProviderMetadata } from '@ai-sdk/provider'
import type { UIMessageChunk } from 'ai'

import { type CodexRunEvent, type CodexRunMetadata } from '@dascowork/codex-app-server-client'
import { codexMessageProviderMetadata } from '../../shared/codexMessageMetadata'

/** Converts neutral app-server events to the existing assistant-ui wire format. */
export class CodexUiMessageAdapter {
  private streamStarted = false

  map(event: CodexRunEvent): UIMessageChunk[] {
    const providerMetadata = providerMetadataFor(event.metadata)
    switch (event.type) {
      case 'stream-start':
        if (this.streamStarted) return []
        this.streamStarted = true
        return [{ type: 'start', ...(providerMetadata ? { messageMetadata: event.metadata } : {}) }]
      case 'text-start':
      case 'text-delta':
      case 'text-end':
      case 'reasoning-start':
      case 'reasoning-delta':
      case 'reasoning-end':
        return [{ ...event, ...(providerMetadata ? { providerMetadata } : {}) } as UIMessageChunk]
      case 'tool-call':
        return [
          {
            type: 'tool-input-available',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: parseToolInput(event.input),
            providerExecuted: event.providerExecuted,
            dynamic: event.dynamic,
            ...(providerMetadata ? { providerMetadata } : {})
          }
        ]
      case 'tool-result':
        return [
          event.isError
            ? {
                type: 'tool-output-error',
                toolCallId: event.toolCallId,
                errorText: toolErrorText(event.result),
                providerExecuted: true,
                dynamic: true,
                ...(providerMetadata ? { providerMetadata } : {})
              }
            : {
                type: 'tool-output-available',
                toolCallId: event.toolCallId,
                output: event.result,
                providerExecuted: true,
                dynamic: true,
                preliminary: event.preliminary,
                ...(providerMetadata ? { providerMetadata } : {})
              }
        ]
      case 'tool-input-start':
        return [
          {
            type: 'tool-input-start',
            toolCallId: event.id,
            toolName: event.toolName,
            dynamic: event.dynamic,
            ...(providerMetadata ? { providerMetadata } : {})
          }
        ]
      case 'tool-input-delta':
        return [{ type: 'tool-input-delta', toolCallId: event.id, inputTextDelta: event.delta }]
      case 'tool-input-end':
        return []
      case 'file':
        return [
          {
            type: 'file',
            mediaType: event.mediaType,
            url: asDataUrl(event.mediaType, event.data),
            ...(providerMetadata ? { providerMetadata } : {})
          }
        ]
      case 'error':
        return [{ type: 'error', errorText: errorText(event.error) }]
      case 'finish':
        return [
          {
            type: 'finish',
            finishReason: event.finishReason.unified,
            ...(providerMetadata ? { messageMetadata: event.metadata } : {})
          }
        ]
    }
  }
}

function providerMetadataFor(
  metadata: CodexRunMetadata | undefined
): SharedV3ProviderMetadata | undefined {
  if (!metadata || Object.keys(metadata).length === 0) return undefined
  return codexMessageProviderMetadata(metadata) as SharedV3ProviderMetadata
}

function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input) as unknown
  } catch {
    return input
  }
}

function asDataUrl(mediaType: string, data: string): string {
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`
}

function toolErrorText(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: unknown }).error
    if (typeof error === 'string') return error
  }
  return errorText(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
