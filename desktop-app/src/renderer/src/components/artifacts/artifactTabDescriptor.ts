import type { WorkspaceTabRecord } from '../workspace-container/workspaceTypes'
import type {
  ArtifactNavigationTarget,
  ArtifactOpenSource,
  ArtifactOriginatingTurn,
  ArtifactPreviewSource
} from '../workspace-container/workspaceOpenTargets'

export type ArtifactTabDescriptor = {
  id: string
  title: string
  source: ArtifactPreviewSource
  openSource: ArtifactOpenSource
  originatingTurn?: ArtifactOriginatingTurn
  attachmentPreview?: { origin: 'composer' | 'sent-message'; requestId: string }
  navigation?: ArtifactNavigationTarget
}

export function artifactTabDescriptor(tab: WorkspaceTabRecord): ArtifactTabDescriptor | undefined {
  if (
    tab.kind !== 'artifact' ||
    tab.props.artifactType !== 'slides' ||
    tab.props.importKind !== 'pptx'
  ) {
    return undefined
  }
  const source = artifactSource(tab.props.source)
  const openSource = artifactOpenSource(tab.props.openSource)
  if (!source || !openSource) return undefined
  return {
    id: tab.id,
    title: tab.title,
    source,
    openSource,
    ...(originatingTurn(tab.props.originatingTurn)
      ? { originatingTurn: originatingTurn(tab.props.originatingTurn) }
      : {}),
    ...(attachmentPreview(tab.props.attachmentPreview)
      ? { attachmentPreview: attachmentPreview(tab.props.attachmentPreview) }
      : {}),
    ...(navigationTarget(tab.props.navigation)
      ? { navigation: navigationTarget(tab.props.navigation) }
      : {})
  }
}

function artifactSource(value: unknown): ArtifactPreviewSource | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (
    value.kind === 'workspace-file' &&
    typeof value.relativePath === 'string' &&
    value.relativePath
  ) {
    return { kind: 'workspace-file', relativePath: value.relativePath }
  }
  if (value.kind === 'authorized-local' && typeof value.sourceId === 'string' && value.sourceId) {
    return { kind: 'authorized-local', sourceId: value.sourceId }
  }
  return undefined
}

function artifactOpenSource(value: unknown): ArtifactOpenSource | undefined {
  return typeof value === 'string' &&
    [
      'generated-resource',
      'file-workspace',
      'inline-link',
      'composer-attachment',
      'message-attachment'
    ].includes(value)
    ? (value as ArtifactOpenSource)
    : undefined
}

function originatingTurn(value: unknown): ArtifactOriginatingTurn | undefined {
  if (!isRecord(value)) return undefined
  const result = Object.fromEntries(
    Object.entries(value).filter(([, item]) => typeof item === 'string')
  ) as ArtifactOriginatingTurn
  return Object.keys(result).length ? result : undefined
}

function attachmentPreview(value: unknown): ArtifactTabDescriptor['attachmentPreview'] {
  return isRecord(value) &&
    (value.origin === 'composer' || value.origin === 'sent-message') &&
    typeof value.requestId === 'string'
    ? { origin: value.origin, requestId: value.requestId }
    : undefined
}

function navigationTarget(value: unknown): ArtifactNavigationTarget | undefined {
  if (
    !isRecord(value) ||
    value.artifactKind !== 'presentation' ||
    typeof value.requestId !== 'string'
  )
    return undefined
  const slideNumber = positiveInteger(value.slideNumber)
  const slideId = stringValue(value.slideId)
  const objectId = stringValue(value.objectId)
  if (!slideNumber && !slideId && !objectId) return undefined
  return {
    requestId: value.requestId,
    artifactKind: 'presentation',
    ...(slideNumber ? { slideNumber } : {}),
    ...(slideId ? { slideId } : {}),
    ...(objectId ? { objectId } : {})
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
