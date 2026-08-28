import type { LocalGitReviewSource } from '../../../../shared/localGitApi'
import { normalizeFileWorkspaceRelativePath } from '../../../../shared/fileWorkspaceApi'

import type { WorkspaceJsonValue, WorkspacePanelId, WorkspaceTabRecord } from './workspaceTypes'

export type WorkspaceOpenMode = 'preview' | 'pinned'

export type WorkspaceFileLocation = {
  line?: number
  column?: number
  endLine?: number
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
  | { type: 'task-summary' }
  | { type: 'timeline' }
  | { type: 'outputs' }
  | { type: 'sources' }
  | { type: 'pull-request' }
  | {
      type: 'mcp-app'
      threadId: string
      server: string
      resourceUri: string
      title?: string
    }
  | { type: 'processes' }
  | { type: 'terminal'; id?: string; title?: string }
  | { type: 'browser'; id?: string; title?: string; url?: string }

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
    case 'task-summary':
      return {
        id: 'task-summary',
        kind: 'task-summary',
        title: '任务',
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'timeline':
      return {
        id: 'timeline',
        kind: 'timeline',
        title: '时间线',
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'outputs':
      return {
        id: 'outputs',
        kind: 'outputs',
        title: 'Outputs',
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'sources':
      return {
        id: 'sources',
        kind: 'sources',
        title: 'Sources',
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'pull-request':
      return {
        id: 'pull-request',
        kind: 'pull-request',
        title: 'Pull Request',
        props: {},
        isPreview: false,
        isClosable: true
      }
    case 'mcp-app':
      return {
        id: `mcp-app:${encodeURIComponent(target.threadId)}:${encodeURIComponent(target.server)}:${encodeURIComponent(target.resourceUri)}`,
        kind: 'mcp-app',
        title: target.title ?? 'MCP App',
        props: {
          threadId: target.threadId,
          server: target.server,
          resourceUri: target.resourceUri
        },
        isPreview: false,
        isClosable: true
      }
    case 'processes':
      return {
        id: 'processes',
        kind: 'processes',
        title: '进程',
        props: {},
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
  }
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
