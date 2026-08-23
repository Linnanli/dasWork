import {
  isAbsoluteLocalPath,
  isSafeRelativeReferencePath,
  type InlineReferenceDescriptor,
  type LocalInlineReference,
  type SemanticInlineReference
} from './referenceInlineTarget'
import { normalizeFileWorkspaceRelativePath } from '../../../shared/fileWorkspaceApi'

export type InlineReferenceAction =
  | {
      type: 'workspace-file'
      relativePath: string
      line?: number
      column?: number
      endLine?: number
      mode: 'preview' | 'pinned'
    }
  | { type: 'workspace-folder'; relativePath: string }
  | { type: 'workspace-browser'; url: string }
  | { type: 'conversation'; conversationId: string }
  | { type: 'system-file'; path: string; cwd?: string; line?: number }
  | { type: 'external-browser'; url: string }
  | { type: 'display-only'; reason: InlineReferenceDisplayOnlyReason }

export type InlineReferenceDisplayOnlyReason =
  | 'unsupported'
  | 'workspace-unavailable'
  | 'local-access-unavailable'
  | 'outside-workspace'
  | 'missing-conversation-target'
  | 'missing-live-agent-target'
  | 'missing-skill-target'
  | 'no-internal-route'

export type InlineReferenceSemanticTargets = {
  agentThreads?: ReadonlyMap<string, string>
  skillPaths?: ReadonlyMap<string, string>
}

export type ResolveInlineReferenceActionOptions = {
  canOpenLocalPaths: boolean
  canOpenWorkspace: boolean
  semanticTargets?: InlineReferenceSemanticTargets
  workspaceCwd?: string
}

/**
 * Resolves a classified inline reference to a serializable action.  This is
 * deliberately side-effect free so every reference surface uses the same
 * capability and containment rules.
 */
export function resolveInlineReferenceAction(
  descriptor: InlineReferenceDescriptor,
  options: ResolveInlineReferenceActionOptions
): InlineReferenceAction {
  if (descriptor.kind === 'unsupported') return displayOnly('unsupported')

  switch (descriptor.kind) {
    case 'external-url':
      return options.canOpenWorkspace
        ? { type: 'workspace-browser', url: descriptor.href }
        : { type: 'external-browser', url: descriptor.href }
    case 'conversation':
      return descriptor.targetId
        ? { type: 'conversation', conversationId: descriptor.targetId }
        : displayOnly('missing-conversation-target')
    case 'agent': {
      const conversationId = descriptor.targetId
        ? (options.semanticTargets?.agentThreads?.get(descriptor.href) ??
          options.semanticTargets?.agentThreads?.get(descriptor.targetId))
        : undefined
      return conversationId
        ? { type: 'conversation', conversationId }
        : displayOnly('missing-live-agent-target')
    }
    case 'skill': {
      const path = skillPathFor(descriptor, options.semanticTargets?.skillPaths)
      if (!path) return displayOnly('missing-skill-target')
      return resolveLocalReference(
        {
          href: descriptor.href,
          kind: 'local-file',
          label: descriptor.label,
          path,
          tooltip: descriptor.tooltip
        },
        options
      )
    }
    case 'local-file':
    case 'local-folder':
      return resolveLocalReference(descriptor, options)
    case 'app':
    case 'plugin':
    case 'mcp-resource':
    case 'sites-project':
      return displayOnly('no-internal-route')
  }
}

export function workspaceRelativePath(path: string, cwd: string | undefined): string | undefined {
  if (!cwd) return undefined
  if (!isAbsoluteLocalPath(path)) {
    return isSafeRelativeReferencePath(path) ? normalizeRelativePath(path) : undefined
  }

  const normalizedPath = normalizeAbsolutePath(path)
  const normalizedCwd = normalizeAbsolutePath(cwd)
  if (!normalizedPath || !normalizedCwd) return undefined
  const comparisonPath = comparableAbsolutePath(normalizedPath)
  const comparisonCwd = comparableAbsolutePath(normalizedCwd)
  if (comparisonPath === comparisonCwd) return ''
  const prefix = `${comparisonCwd}/`
  if (!comparisonPath.startsWith(prefix)) return undefined
  const relativePath = normalizedPath.slice(normalizedCwd.length + 1)
  return isSafeRelativeReferencePath(relativePath) ? relativePath : undefined
}

function resolveLocalReference(
  descriptor: LocalInlineReference,
  options: ResolveInlineReferenceActionOptions
): InlineReferenceAction {
  if (!options.canOpenLocalPaths) return displayOnly('local-access-unavailable')
  const relativePath = workspaceRelativePath(descriptor.path, options.workspaceCwd)
  if (relativePath !== undefined && options.canOpenWorkspace) {
    if (descriptor.kind === 'local-folder') return { type: 'workspace-folder', relativePath }
    return {
      type: 'workspace-file',
      relativePath,
      mode: 'preview',
      ...(descriptor.line ? { line: descriptor.line } : {}),
      ...(descriptor.column ? { column: descriptor.column } : {}),
      ...(descriptor.endLine ? { endLine: descriptor.endLine } : {})
    }
  }
  if (isAbsoluteLocalPath(descriptor.path)) {
    return {
      type: 'system-file',
      path: descriptor.path,
      ...(descriptor.line ? { line: descriptor.line } : {})
    }
  }
  if (options.workspaceCwd && isSafeRelativeReferencePath(descriptor.path)) {
    return {
      type: 'system-file',
      path: descriptor.path,
      cwd: options.workspaceCwd,
      ...(descriptor.line ? { line: descriptor.line } : {})
    }
  }
  return displayOnly(options.canOpenWorkspace ? 'outside-workspace' : 'workspace-unavailable')
}

function skillPathFor(
  descriptor: SemanticInlineReference,
  paths: ReadonlyMap<string, string> | undefined
): string | undefined {
  if (!paths) return undefined
  return paths.get(descriptor.href) ?? paths.get(descriptor.label)
}

function normalizeRelativePath(path: string): string {
  return normalizeFileWorkspaceRelativePath(path)
}

function normalizeAbsolutePath(path: string): string | undefined {
  if (!isAbsoluteLocalPath(path)) return undefined
  const normalized = path.replaceAll('\\', '/').replace(/\/+/gu, '/')
  const prefix = normalized.startsWith('/') ? '/' : ''
  const result = normalized
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/')
  return `${prefix}${result}` || prefix
}

function comparableAbsolutePath(path: string): string {
  return /^[A-Za-z]:\//u.test(path) ? path.toLowerCase() : path
}

function displayOnly(reason: InlineReferenceDisplayOnlyReason): InlineReferenceAction {
  return { type: 'display-only', reason }
}
