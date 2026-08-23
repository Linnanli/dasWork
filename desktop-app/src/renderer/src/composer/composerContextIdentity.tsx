/* eslint-disable react-refresh/only-export-components -- identity context and helpers share one boundary */

import type { Unstable_TriggerItem } from '@assistant-ui/react'
import { createContext, useContext, type PropsWithChildren, type ReactNode } from 'react'

import type { ComposerContextReference } from '../../../shared/composerContext'
import type { InlineReferenceSemanticTargets } from '@/lib/referenceInlineAction'
import type { ComposerContextCatalogSectionState } from './useComposerContextCatalog'

export type ComposerContextIdentity =
  | {
      type: 'app' | 'plugin'
      uri: string
      displayLabel: string
      mentionName?: string
    }
  | {
      type: 'live-agent'
      uri: string
      displayLabel: string
      threadId: string
      mentionName?: string
    }
  | {
      type: 'skill'
      uri: string
      displayLabel: string
      name: string
      path: string
      mentionName?: string
    }

export type ComposerContextIdentityIndex = ReadonlyMap<string, ComposerContextIdentity>

export const emptyComposerContextIdentityIndex: ComposerContextIdentityIndex = new Map()
const ComposerContextIdentityContext = createContext<ComposerContextIdentityIndex>(
  emptyComposerContextIdentityIndex
)

export function ComposerContextIdentityProvider({
  children,
  index
}: PropsWithChildren<{ index: ComposerContextIdentityIndex }>): ReactNode {
  return (
    <ComposerContextIdentityContext.Provider value={index}>
      {children}
    </ComposerContextIdentityContext.Provider>
  )
}

export function useComposerContextIdentityIndex(): ComposerContextIdentityIndex {
  return useContext(ComposerContextIdentityContext)
}

export function buildComposerContextIdentityIndex(
  sections: readonly ComposerContextCatalogSectionState[]
): ComposerContextIdentityIndex {
  const index = new Map<string, ComposerContextIdentity>()
  for (const section of sections) {
    for (const item of section.items) {
      const identity = composerContextIdentityFromTriggerItem(item)
      if (identity) index.set(identity.uri, identity)
    }
  }
  return index
}

export function composerContextIdentityFromTriggerItem(
  item: Unstable_TriggerItem
): ComposerContextIdentity | undefined {
  const reference = contextReference(item)
  if (reference?.kind === 'liveAgent') {
    return {
      type: 'live-agent',
      uri: reference.uri,
      displayLabel: item.label,
      threadId: reference.threadId
    }
  }
  if (reference?.kind === 'skill') {
    return {
      type: 'skill',
      uri: `skill://${reference.canonicalId}`,
      displayLabel: item.label,
      name: reference.name,
      path: reference.path
    }
  }
  if (item.type !== 'app' && item.type !== 'plugin') return undefined
  const scheme = item.type === 'app' ? 'app://' : 'plugin://'
  if (!item.id.startsWith(scheme) || item.id.length === scheme.length) return undefined
  const mentionName = stringMetadata(item, 'mentionName')
  return {
    type: item.type,
    uri: item.id,
    displayLabel: item.label,
    ...(mentionName ? { mentionName } : {})
  }
}

export function inlineReferenceSemanticTargetsFromIdentityIndex(
  index: ComposerContextIdentityIndex
): InlineReferenceSemanticTargets {
  const agentThreads = new Map<string, string>()
  const skillPaths = new Map<string, string>()
  for (const identity of index.values()) {
    if (identity.type === 'live-agent') {
      agentThreads.set(identity.uri, identity.threadId)
      continue
    }
    if (identity.type === 'skill') {
      skillPaths.set(identity.name, identity.path)
      skillPaths.set(`$${identity.name.replace(/^\$/u, '')}`, identity.path)
    }
  }
  return { agentThreads, skillPaths }
}

function stringMetadata(item: Unstable_TriggerItem, key: string): string | undefined {
  const metadata = item.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function contextReference(item: Unstable_TriggerItem): ComposerContextReference | undefined {
  const metadata = item.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const reference = (metadata as Record<string, unknown>).reference
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return undefined
  return reference as ComposerContextReference
}
