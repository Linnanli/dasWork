import type {
  FileWorkspaceEntry,
  FileWorkspaceDirectoryListing,
  FileWorkspaceSearchMatch
} from '../../../../../shared/fileWorkspaceApi'

export type WorkspaceFileTreeModel = {
  /** Paths consumed by @pierre/trees. Directories always end in `/`. */
  paths: readonly string[]
  /** The entry metadata keyed by its tree path. */
  entriesByTreePath: ReadonlyMap<string, FileWorkspaceEntry>
  /** Directory cache paths whose listing stopped at the service limit. */
  truncatedDirectoryPaths: ReadonlySet<string>
}

type DirectoryListing = Pick<FileWorkspaceDirectoryListing, 'entries' | 'path' | 'truncated'>

const naturalPathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
})

/**
 * Converts the directory cache owned by the workspace controller to the
 * path-first representation expected by the virtual tree. No absolute paths
 * cross this boundary.
 */
export function buildWorkspaceFileTreeModel(
  directories: Readonly<Record<string, DirectoryListing | undefined>>
): WorkspaceFileTreeModel {
  const entriesByWorkspacePath = new Map<string, FileWorkspaceEntry>()
  const truncatedDirectoryPaths = new Set<string>()

  for (const listing of Object.values(directories)) {
    if (!listing) continue
    const directoryPath = normalizeWorkspaceDirectoryPath(listing.path)
    if (directoryPath === undefined) continue
    if (listing.truncated) truncatedDirectoryPaths.add(directoryPath)

    for (const entry of listing.entries) {
      const path = normalizeWorkspacePath(entry.path)
      if (!path) continue
      const existing = entriesByWorkspacePath.get(path)
      // A malformed listing must never make a directory impossible to expand.
      if (!existing || entry.kind === 'directory') entriesByWorkspacePath.set(path, entry)
    }
  }

  const entriesByTreePath = new Map<string, FileWorkspaceEntry>()
  for (const [path, entry] of entriesByWorkspacePath) {
    entriesByTreePath.set(treePathForWorkspaceEntry(entry, path), entry)
  }

  return {
    paths: [...entriesByTreePath.keys()].sort(compareWorkspaceTreePaths),
    entriesByTreePath,
    truncatedDirectoryPaths
  }
}

/**
 * Builds the same path-first model used by the file browser from file-search
 * matches. Every matched file retains its workspace path and its missing
 * ancestor directories are materialized so the result can be rendered as a
 * navigable tree instead of a separate flat list.
 */
export function buildWorkspaceFileSearchTreeModel(
  matches: readonly FileWorkspaceSearchMatch[]
): WorkspaceFileTreeModel {
  const entriesByWorkspacePath = new Map<string, FileWorkspaceEntry>()

  for (const match of matches) {
    const path = normalizeWorkspacePath(match.path)
    if (!path) continue

    for (const ancestorPath of workspacePathAncestors(path)) {
      entriesByWorkspacePath.set(ancestorPath, directoryEntry(ancestorPath))
    }
    entriesByWorkspacePath.set(path, fileEntry(path))
  }

  const entriesByTreePath = new Map<string, FileWorkspaceEntry>()
  for (const [path, entry] of entriesByWorkspacePath) {
    entriesByTreePath.set(treePathForWorkspaceEntry(entry, path), entry)
  }

  return {
    paths: [...entriesByTreePath.keys()].sort(compareWorkspaceTreePaths),
    entriesByTreePath,
    truncatedDirectoryPaths: new Set()
  }
}

export function treePathForWorkspaceEntry(
  entry: Pick<FileWorkspaceEntry, 'kind' | 'path'>,
  normalizedPath = normalizeWorkspacePath(entry.path)
): string {
  if (!normalizedPath) throw new Error('A file tree entry must have a normalized relative path.')
  return entry.kind === 'directory' ? `${normalizedPath}/` : normalizedPath
}

export function workspacePathFromTreePath(treePath: string): string | undefined {
  if (treePath.endsWith('/')) return normalizeWorkspaceDirectoryPath(treePath)
  return normalizeWorkspacePath(treePath)
}

export function normalizeWorkspacePath(path: string): string | undefined {
  if (typeof path !== 'string') return undefined
  const normalized = path.trim()
  if (
    !normalized ||
    normalized.length > 4096 ||
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    return undefined
  }
  const segments = normalized.split('/')
  return segments.some((segment) => !segment || segment === '.' || segment === '..')
    ? undefined
    : normalized
}

export function normalizeWorkspaceDirectoryPath(path: string): string | undefined {
  if (typeof path !== 'string') return undefined
  const trimmed = path.trim().replace(/\/+$/u, '')
  if (!trimmed) return path.trim() === '' || /^\/+$/u.test(path.trim()) ? '' : undefined
  return normalizeWorkspacePath(trimmed)
}

function compareWorkspaceTreePaths(left: string, right: string): number {
  const leftParts = splitTreePath(left)
  const rightParts = splitTreePath(right)
  const segmentCount = Math.min(leftParts.segments.length, rightParts.segments.length)
  for (let index = 0; index < segmentCount; index += 1) {
    const result = naturalPathCollator.compare(
      leftParts.segments[index]!,
      rightParts.segments[index]!
    )
    if (result !== 0) return result
  }
  if (leftParts.segments.length !== rightParts.segments.length) {
    return leftParts.segments.length - rightParts.segments.length
  }
  if (leftParts.isDirectory !== rightParts.isDirectory) return leftParts.isDirectory ? -1 : 1
  return naturalPathCollator.compare(left, right)
}

function splitTreePath(path: string): { isDirectory: boolean; segments: string[] } {
  const isDirectory = path.endsWith('/')
  return {
    isDirectory,
    segments: (isDirectory ? path.slice(0, -1) : path).split('/')
  }
}

function workspacePathAncestors(path: string): string[] {
  const ancestors: string[] = []
  let separator = path.lastIndexOf('/')
  while (separator !== -1) {
    ancestors.unshift(path.slice(0, separator))
    separator = path.lastIndexOf('/', separator - 1)
  }
  return ancestors
}

function directoryEntry(path: string): FileWorkspaceEntry {
  return {
    kind: 'directory',
    mtimeMs: 0,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    size: 0
  }
}

function fileEntry(path: string): FileWorkspaceEntry {
  return {
    kind: 'file',
    mtimeMs: 0,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    size: 0
  }
}
