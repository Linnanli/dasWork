import type { LocalGitReviewSource } from '../../../../shared/localGitApi'
import { normalizeFileWorkspaceRelativePath } from '../../../../shared/fileWorkspaceApi'

import type { WorkspaceJsonValue, WorkspacePanelId, WorkspaceTabRecord } from './workspaceTypes'

export type WorkspaceOpenMode = 'preview' | 'pinned'

export type WorkspaceFileLocation = {
  line?: number
  column?: number
  endLine?: number
}

/**
 * A renderer-safe reference to the bytes shown in an Artifact tab.  Workspace
 * files are resolved against the tab's current owned workspace in main; local
 * files are represented by an opaque capability id and never by a path.
 */
export type ArtifactPreviewSource =
  | { kind: 'workspace-file'; relativePath: string }
  | { kind: 'authorized-local'; sourceId: string }

export type ArtifactNavigationTarget = {
  requestId: string
  artifactKind: 'presentation'
  slideNumber?: number
  slideId?: string
  objectId?: string
}

export type ArtifactOriginatingTurn = {
  threadId?: string
  turnId?: string
  messageId?: string
  inputMessageId?: string
}

export type ArtifactOpenSource =
  | 'generated-resource'
  | 'file-workspace'
  | 'inline-link'
  | 'composer-attachment'
  | 'message-attachment'

export type ArtifactOpenTarget = {
  type: 'artifact'
  artifactType: 'slides'
  importKind: 'pptx'
  source: ArtifactPreviewSource
  title: string
  openSource: ArtifactOpenSource
  originatingTurn?: ArtifactOriginatingTurn
  attachmentPreview?: { origin: 'composer' | 'sent-message'; requestId: string }
  navigation?: ArtifactNavigationTarget
}

export type WorkspaceOpenTarget =
  | {
      type: 'file'
      relativePath: string
      title?: string
      location?: WorkspaceFileLocation
      /** Select and expand a directory while keeping the Files explorer open. */
      revealPath?: string
    }
  | { type: 'review'; source?: LocalGitReviewSource }
  | { type: 'terminal'; id?: string; title?: string }
  | { type: 'browser'; id?: string; title?: string; url?: string }
  | ArtifactOpenTarget

export type WorkspaceOpenOptions = {
  panelId?: WorkspacePanelId
  mode?: WorkspaceOpenMode
  /** Replaces the initially empty Files workspace with the selected file. */
  replaceTabId?: string
  insertAfterTabId?: string
  insertAtStart?: boolean
}

export function createWorkspaceDescriptor(
  target: WorkspaceOpenTarget,
  options: Pick<WorkspaceOpenOptions, 'mode'> = {}
): WorkspaceTabRecord {
  switch (target.type) {
    case 'file': {
      const relativePath = normalizeRelativePath(target.relativePath)
      const isExplorer = !relativePath
      const revealPath = target.revealPath ? normalizeRelativePath(target.revealPath) : undefined
      return {
        id: isExplorer ? 'files:explorer' : `file:${relativePath}`,
        kind: 'file',
        title: target.title ?? (isExplorer ? 'Files' : basename(relativePath)),
        props: {
          relativePath,
          ...(revealPath ? { revealPath } : {}),
          ...(target.location ? sanitizedFileLocation(target.location) : {})
        },
        isPreview: !isExplorer && options.mode !== 'pinned',
        isClosable: true
      }
    }
    case 'review':
      return {
        id: 'review',
        kind: 'review',
        title: 'Review',
        props: target.source ? { source: target.source as unknown as WorkspaceJsonValue } : {},
        isPreview: false,
        isClosable: true
      }
    case 'terminal':
      return {
        id: target.id ?? `terminal:${randomId()}`,
        kind: 'terminal',
        title: target.title ?? 'Terminal',
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'browser':
      return {
        id: target.id ?? `browser:${randomId()}`,
        kind: 'browser',
        title: target.title ?? 'New tab',
        props: target.url ? { url: target.url } : {},
        isPreview: false,
        isClosable: true
      }
    case 'artifact': {
      const source = sanitizeArtifactSource(target.source)
      const title = sanitizedTitle(
        target.title,
        source.kind === 'workspace-file' ? basename(source.relativePath) : '演示文稿'
      )
      const navigation = sanitizeArtifactNavigation(target.navigation)
      const originatingTurn = sanitizeOriginatingTurn(target.originatingTurn)
      const attachmentPreview = sanitizeAttachmentPreview(target.attachmentPreview)
      return {
        id: artifactTabId(source),
        kind: 'artifact',
        title,
        props: {
          artifactType: 'slides',
          importKind: 'pptx',
          source: source as unknown as WorkspaceJsonValue,
          openSource: target.openSource,
          ...(originatingTurn
            ? { originatingTurn: originatingTurn as unknown as WorkspaceJsonValue }
            : {}),
          ...(attachmentPreview
            ? { attachmentPreview: attachmentPreview as unknown as WorkspaceJsonValue }
            : {}),
          ...(navigation ? { navigation: navigation as unknown as WorkspaceJsonValue } : {})
        },
        isPreview: options.mode !== 'pinned',
        isClosable: true
      }
    }
  }
}

/** Only modern OpenXML PPTX files have an Artifact presentation implementation. */
export function isPptxArtifactPath(path: string): boolean {
  const normalized = path.trim().replaceAll('\\', '/')
  const name = normalized.split('/').at(-1) ?? ''
  return name.length > '.pptx'.length && name.toLocaleLowerCase().endsWith('.pptx')
}

export function artifactTabId(source: ArtifactPreviewSource): string {
  return source.kind === 'workspace-file'
    ? `artifact:workspace:${normalizeRelativePath(source.relativePath)}`
    : `artifact:local:${source.sourceId}`
}

function sanitizeArtifactSource(source: ArtifactPreviewSource): ArtifactPreviewSource {
  if (source.kind === 'workspace-file') {
    const relativePath = normalizeRelativePath(source.relativePath)
    if (!relativePath || !isPptxArtifactPath(relativePath)) {
      throw new Error('Artifact source must be a workspace-relative PPTX path.')
    }
    return { kind: 'workspace-file', relativePath }
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/u.test(source.sourceId)) {
    throw new Error('Artifact source id is invalid.')
  }
  return { kind: 'authorized-local', sourceId: source.sourceId }
}

function sanitizeArtifactNavigation(
  navigation: ArtifactNavigationTarget | undefined
): ArtifactNavigationTarget | undefined {
  if (!navigation) return undefined
  const requestId = navigation.requestId.trim()
  if (!requestId || requestId.length > 256 || navigation.artifactKind !== 'presentation')
    return undefined
  const slideNumber = positiveInteger(navigation.slideNumber)
  const slideId = boundedIdentifier(navigation.slideId)
  const objectId = boundedIdentifier(navigation.objectId)
  if (!slideNumber && !slideId && !objectId) return undefined
  return {
    requestId,
    artifactKind: 'presentation',
    ...(slideNumber ? { slideNumber } : {}),
    ...(slideId ? { slideId } : {}),
    ...(objectId ? { objectId } : {})
  }
}

function sanitizeOriginatingTurn(
  originatingTurn: ArtifactOriginatingTurn | undefined
): ArtifactOriginatingTurn | undefined {
  if (!originatingTurn) return undefined
  const result = Object.fromEntries(
    Object.entries(originatingTurn).flatMap(([key, value]) => {
      const identifier = boundedIdentifier(value)
      return identifier ? [[key, identifier]] : []
    })
  ) as ArtifactOriginatingTurn
  return Object.keys(result).length ? result : undefined
}

function sanitizeAttachmentPreview(
  attachmentPreview: ArtifactOpenTarget['attachmentPreview']
): ArtifactOpenTarget['attachmentPreview'] {
  if (!attachmentPreview || !['composer', 'sent-message'].includes(attachmentPreview.origin)) {
    return undefined
  }
  const requestId = boundedIdentifier(attachmentPreview.requestId)
  return requestId ? { origin: attachmentPreview.origin, requestId } : undefined
}

function boundedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 256
    ? value.trim()
    : undefined
}

function sanitizedTitle(value: string, fallback: string): string {
  const title = value.trim().replace(/[\r\n\t]+/gu, ' ')
  return (title || fallback).slice(0, 512)
}

function sanitizedFileLocation(location: WorkspaceFileLocation): WorkspaceFileLocation {
  const line = positiveInteger(location.line)
  const column = positiveInteger(location.column)
  const endLine = positiveInteger(location.endLine)
  return {
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(endLine && line && endLine >= line ? { endLine } : {})
  }
}

function positiveInteger(value: number | undefined): number | undefined {
  return value && Number.isInteger(value) && value > 0 ? value : undefined
}

export function normalizeRelativePath(path: string): string {
  return normalizeFileWorkspaceRelativePath(path)
}

function basename(path: string): string {
  return path.split('/').at(-1) || path
}

function randomId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
}
