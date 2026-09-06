/**
 * Renderer-safe metadata written onto UI message parts that originate from
 * Codex App Server. The legacy provider key remains readable while persisted
 * conversation history migrates. New producers write only the stable key.
 */
export const CODEX_MESSAGE_METADATA_KEY = 'dascowork.codex'
export const LEGACY_CODEX_MESSAGE_METADATA_KEY = '@janole/ai-sdk-provider-codex-asp'

export const CODEX_MESSAGE_METADATA_KEYS = [
  CODEX_MESSAGE_METADATA_KEY,
  LEGACY_CODEX_MESSAGE_METADATA_KEY
] as const

export function codexMessageProviderMetadata(metadata: Record<string, unknown>): ProviderMetadata {
  return {
    [CODEX_MESSAGE_METADATA_KEY]: metadata as JSONObject
  }
}

export function readCodexMessageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const providerMetadata = value as Record<string, unknown>
  for (const key of CODEX_MESSAGE_METADATA_KEYS) {
    const candidate = providerMetadata[key]
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>
    }
  }
  return undefined
}
import type { JSONObject } from '@ai-sdk/provider'
import type { ProviderMetadata } from 'ai'
