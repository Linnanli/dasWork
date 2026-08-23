import { randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import type { Dirent, Stats } from 'node:fs'

import { mediaTypeForPath, toAppMediaUrl } from '../localMediaProtocol'

import {
  FILE_WORKSPACE_API_VERSION,
  FILE_WORKSPACE_DEFAULT_BINARY_BYTE_LIMIT,
  FILE_WORKSPACE_DEFAULT_TEXT_BYTE_LIMIT,
  FILE_WORKSPACE_MAX_DIRECTORY_ENTRIES,
  FILE_WORKSPACE_MAX_SEARCH_BYTES,
  FILE_WORKSPACE_MAX_SEARCH_RESULTS,
  fileWorkspaceListDirectoryResultSchema,
  fileWorkspaceMetadataResultSchema,
  fileWorkspacePathUnavailableResultSchema,
  fileWorkspaceRelativePathSchema,
  fileWorkspaceReadFileResultSchema,
  fileWorkspaceSearchSessionEventSchema,
  fileWorkspaceSearchSessionStartResultSchema,
  fileWorkspaceSearchResultSchema,
  type FileWorkspaceEntry,
  type FileWorkspaceEntryKind,
  type FileWorkspaceListDirectoryRequest,
  type FileWorkspaceListDirectoryResult,
  type FileWorkspaceMetadataRequest,
  type FileWorkspaceMetadataResult,
  type FileWorkspacePathUnavailableReason,
  type FileWorkspacePathUnavailableResult,
  type FileWorkspaceReadFileContent,
  type FileWorkspaceReadFileRequest,
  type FileWorkspaceReadFileResult,
  type FileWorkspaceRelativePath,
  type FileWorkspaceSearchMatch,
  type FileWorkspaceSearchRequest,
  type FileWorkspaceSearchResult,
  type FileWorkspaceSearchSessionEvent,
  type FileWorkspaceSearchSessionStartRequest,
  type FileWorkspaceSearchSessionStartResult,
  type FileWorkspaceSearchSessionStopRequest,
  type FileWorkspaceSearchSessionUpdateRequest
} from '../../shared/fileWorkspaceApi'

export type FileWorkspaceResolvedRoot = {
  rootId: string
  path: string
}

export type FileWorkspaceServiceOptions = {
  resolveRoot(rootId: string): Promise<string | FileWorkspaceResolvedRoot | null>
  pathSearch?: FileWorkspacePathSearchProviderLike
}

type FileWorkspaceFuzzyFile = {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
}

type FileWorkspacePathSearchSession = {
  update(query: string): Promise<void>
  stop(): Promise<void>
}

export type FileWorkspacePathSearchProviderLike = {
  createFuzzyFileSearchSession(input: {
    roots: string[]
    onUpdated(files: FileWorkspaceFuzzyFile[], query: string): void
    onCompleted(query: string): void
  }): Promise<FileWorkspacePathSearchSession>
}

type SafePath = {
  rootId: string
  rootPath: string
  absolutePath: string
  relativePath: FileWorkspaceRelativePath
}

type SearchPathStats = Pick<Stats, 'isDirectory' | 'isFile'> | Dirent

class WorkspaceRootUnavailableError extends Error {}

type ActiveSearchSession = {
  rootId: string
  rootPath: string
  query: string
  matches: FileWorkspaceSearchMatch[]
  publish(event: FileWorkspaceSearchSessionEvent): void
  providerSession?: FileWorkspacePathSearchSession
  stopped: boolean
}

export class FileWorkspaceService {
  private readonly searchSessions = new Map<string, ActiveSearchSession>()

  constructor(private readonly options: FileWorkspaceServiceOptions) {}

  async listDirectory(
    input: FileWorkspaceListDirectoryRequest
  ): Promise<FileWorkspaceListDirectoryResult> {
    try {
      const directoryPath = await this.resolveSafePath(input.rootId, input.path ?? '')
      const directoryStats = await stat(directoryPath.absolutePath)
      if (!directoryStats.isDirectory()) {
        return unavailablePath(input.rootId, input.path ?? '', 'not-directory')
      }

      const limit = input.limit ?? FILE_WORKSPACE_MAX_DIRECTORY_ENTRIES
      const dirents = await readdir(directoryPath.absolutePath, { withFileTypes: true })
      const entries: FileWorkspaceEntry[] = []

      for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
        const childRelativePath = joinRelative(directoryPath.relativePath, dirent.name)
        entries.push(
          await this.entryForDirectoryChild(directoryPath, childRelativePath, dirent.name)
        )
        if (entries.length >= limit) break
      }

      return fileWorkspaceListDirectoryResultSchema.parse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: directoryPath.rootId,
        path: directoryPath.relativePath,
        entries,
        truncated: dirents.length > entries.length
      })
    } catch (cause) {
      const unavailable = unavailableReason(cause)
      if (!unavailable) throw cause
      return unavailablePath(input.rootId, input.path ?? '', unavailable)
    }
  }

  async metadata(input: FileWorkspaceMetadataRequest): Promise<FileWorkspaceMetadataResult> {
    try {
      const path = await this.resolveSafePath(input.rootId, input.path)
      return fileWorkspaceMetadataResultSchema.parse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: path.rootId,
        entry: await this.entryForPath(path)
      })
    } catch (cause) {
      const unavailable = unavailableReason(cause)
      if (!unavailable) throw cause
      return unavailablePath(input.rootId, input.path, unavailable)
    }
  }

  async resolveFileForSystemOpen(input: FileWorkspaceMetadataRequest): Promise<string> {
    const path = await this.resolveSafePath(input.rootId, input.path)
    const entry = await this.entryForPath(path)
    if (entry.kind !== 'file') throw new Error('Workspace path is not a file.')
    return path.absolutePath
  }

  async readFile(input: FileWorkspaceReadFileRequest): Promise<FileWorkspaceReadFileResult> {
    try {
      const path = await this.resolveSafePath(input.rootId, input.path)
      const entry = await this.entryForPath(path)
      if (entry.kind !== 'file') {
        return unavailablePath(input.rootId, input.path, 'not-file')
      }

      const textLimit = input.textByteLimit ?? FILE_WORKSPACE_DEFAULT_TEXT_BYTE_LIMIT
      const binaryLimit = input.binaryByteLimit ?? FILE_WORKSPACE_DEFAULT_BINARY_BYTE_LIMIT
      const largestAllowedRead = Math.max(textLimit, binaryLimit)
      if (entry.size > largestAllowedRead) {
        return fileWorkspaceReadFileResultSchema.parse({
          version: FILE_WORKSPACE_API_VERSION,
          rootId: path.rootId,
          entry,
          // Do not read an oversized file just to determine whether it is binary.
          // The preview surface only needs the size and limit to render a safe fallback.
          content: { kind: 'too-large', binary: false, size: entry.size, limit: largestAllowedRead }
        })
      }

      const mediaUrl = toAppMediaUrl(path.absolutePath)
      const mediaType = mediaTypeForPath(path.absolutePath)
      if (
        mediaUrl &&
        mediaType &&
        (mediaType.startsWith('image/') || mediaType === 'application/pdf')
      ) {
        return fileWorkspaceReadFileResultSchema.parse({
          version: FILE_WORKSPACE_API_VERSION,
          rootId: path.rootId,
          entry,
          content: { kind: 'media', url: mediaUrl, mediaType }
        })
      }

      const bytes = await readFile(path.absolutePath)
      const text = decodeUtf8(bytes)
      const content =
        text === null ? binaryContent(bytes, binaryLimit) : textContent(bytes, text, textLimit)

      return fileWorkspaceReadFileResultSchema.parse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: path.rootId,
        entry,
        content
      })
    } catch (cause) {
      const unavailable = unavailableReason(cause)
      if (!unavailable) throw cause
      return unavailablePath(input.rootId, input.path, unavailable)
    }
  }

  async search(input: FileWorkspaceSearchRequest): Promise<FileWorkspaceSearchResult> {
    const startPath = await this.resolveSafePath(input.rootId, input.path ?? '')
    const startStats = await stat(startPath.absolutePath)
    const limit = input.limit ?? FILE_WORKSPACE_MAX_SEARCH_RESULTS
    const query = input.query.trim()
    const lowerQuery = query.toLocaleLowerCase()
    const matches: FileWorkspaceSearchMatch[] = []
    let truncated = false

    const visit = async (path: SafePath, pathStats: SearchPathStats): Promise<void> => {
      if (matches.length >= limit) {
        truncated = true
        return
      }

      const name = basename(path.absolutePath)
      if (pathStats.isFile() && name.toLocaleLowerCase().includes(lowerQuery)) {
        matches.push({ path: path.relativePath, kind: 'path', preview: name })
      }

      if (matches.length >= limit) {
        truncated = true
        return
      }

      if (pathStats.isDirectory()) {
        const resolvedDirectoryPath = await realpath(path.absolutePath)
        if (!isWithinRoot(path.rootPath, resolvedDirectoryPath)) {
          throw new Error('Workspace path escapes the project root.')
        }
        const dirents = await readdir(resolvedDirectoryPath, { withFileTypes: true })
        for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
          if (dirent.isDirectory() && DEFAULT_IGNORED_SEARCH_DIRECTORIES.has(dirent.name)) continue
          const childRelativePath = joinRelative(path.relativePath, dirent.name)
          const childAbsolutePath = resolve(path.rootPath, childRelativePath)
          if (!isWithinRoot(path.rootPath, childAbsolutePath)) {
            throw new Error('Workspace path escapes the project root.')
          }
          if (dirent.isSymbolicLink()) continue
          const childPath: SafePath = {
            rootId: path.rootId,
            rootPath: path.rootPath,
            absolutePath: childAbsolutePath,
            relativePath: childRelativePath
          }
          await visit(childPath, dirent)
          if (matches.length >= limit) {
            truncated = true
            return
          }
        }
        return
      }

      if (!input.includeContent || !pathStats.isFile()) return
      const fileStats = await lstat(path.absolutePath)
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) return
      if (fileStats.size > (input.maxFileBytes ?? FILE_WORKSPACE_MAX_SEARCH_BYTES)) return

      const bytes = await readFile(path.absolutePath)
      const text = decodeUtf8(bytes)
      if (text === null) return

      const contentMatch = findLineMatch(text, lowerQuery)
      if (contentMatch) {
        matches.push({ path: path.relativePath, kind: 'content', ...contentMatch })
      }
    }

    await visit(startPath, startStats)

    return fileWorkspaceSearchResultSchema.parse({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: startPath.rootId,
      query,
      matches,
      truncated
    })
  }

  async startSearchSession(
    input: FileWorkspaceSearchSessionStartRequest,
    publish: (event: FileWorkspaceSearchSessionEvent) => void
  ): Promise<FileWorkspaceSearchSessionStartResult> {
    const provider = this.options.pathSearch
    if (!provider) throw new Error('Workspace file search sessions are unavailable.')

    const root = await this.resolveSafePath(input.rootId, '')
    const sessionId = randomUUID()
    const active: ActiveSearchSession = {
      rootId: root.rootId,
      rootPath: root.rootPath,
      query: '',
      matches: [],
      publish,
      stopped: false
    }
    this.searchSessions.set(sessionId, active)

    try {
      const providerSession = await provider.createFuzzyFileSearchSession({
        roots: [root.rootPath],
        onUpdated: (files, query) => {
          if (!query.trim() || !this.isCurrentSearchSession(sessionId, active, query)) return
          active.matches = fuzzyFilesToWorkspaceMatches(root.rootPath, files)
          this.publishSearchSession(sessionId, active, false)
        },
        onCompleted: (query) => {
          if (!query.trim() || !this.isCurrentSearchSession(sessionId, active, query)) return
          this.publishSearchSession(sessionId, active, true)
        }
      })
      if (active.stopped || this.searchSessions.get(sessionId) !== active) {
        await providerSession.stop()
        throw new Error('Workspace file search session was stopped before it started.')
      }
      active.providerSession = providerSession
      return fileWorkspaceSearchSessionStartResultSchema.parse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: active.rootId,
        sessionId
      })
    } catch (error) {
      this.searchSessions.delete(sessionId)
      active.stopped = true
      throw error
    }
  }

  async updateSearchSession(input: FileWorkspaceSearchSessionUpdateRequest): Promise<void> {
    const active = this.requireSearchSession(input.sessionId)
    const query = input.query.trim()
    active.query = query
    if (!query) {
      active.matches = []
      this.publishSearchSession(input.sessionId, active, true)
      await active.providerSession?.update(query)
      return
    }

    try {
      await active.providerSession?.update(query)
    } catch (error) {
      if (this.isCurrentSearchSession(input.sessionId, active, query)) {
        this.publishSearchSession(input.sessionId, active, true, errorMessage(error))
      }
      throw error
    }
  }

  async stopSearchSession(input: FileWorkspaceSearchSessionStopRequest): Promise<void> {
    const active = this.searchSessions.get(input.sessionId)
    if (!active) return
    active.stopped = true
    this.searchSessions.delete(input.sessionId)
    await active.providerSession?.stop()
  }

  async stopSearchSessionsForRoot(rootId: string): Promise<void> {
    await Promise.all(
      [...this.searchSessions.entries()]
        .filter(([, session]) => session.rootId === rootId)
        .map(([sessionId]) =>
          this.stopSearchSession({ version: FILE_WORKSPACE_API_VERSION, sessionId })
        )
    )
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.searchSessions.keys()].map((sessionId) =>
        this.stopSearchSession({ version: FILE_WORKSPACE_API_VERSION, sessionId })
      )
    )
  }

  private requireSearchSession(sessionId: string): ActiveSearchSession {
    const active = this.searchSessions.get(sessionId)
    if (!active || active.stopped) {
      throw new Error('Workspace file search session is unavailable.')
    }
    return active
  }

  private isCurrentSearchSession(
    sessionId: string,
    active: ActiveSearchSession,
    query: string
  ): boolean {
    return (
      !active.stopped &&
      this.searchSessions.get(sessionId) === active &&
      active.query === query.trim()
    )
  }

  private publishSearchSession(
    sessionId: string,
    active: ActiveSearchSession,
    complete: boolean,
    error?: string
  ): void {
    if (active.stopped || this.searchSessions.get(sessionId) !== active) return
    active.publish(
      fileWorkspaceSearchSessionEventSchema.parse({
        version: FILE_WORKSPACE_API_VERSION,
        type: 'search-results',
        rootId: active.rootId,
        sessionId,
        query: active.query,
        matches: active.matches,
        complete,
        ...(error ? { error } : {})
      })
    )
  }

  private async resolveSafePath(rootId: string, relativePath: string): Promise<SafePath> {
    assertWorkspaceRelativePath(relativePath)

    const root = await this.options.resolveRoot(rootId)
    if (!root) throw new WorkspaceRootUnavailableError('Workspace root is not available.')

    const resolvedRoot = typeof root === 'string' ? { rootId, path: root } : root
    let rootPath: string
    try {
      rootPath = await realpath(resolvedRoot.path)
    } catch (cause) {
      if (isMissingPathError(cause)) {
        throw new WorkspaceRootUnavailableError('Workspace root is not available.')
      }
      throw cause
    }
    const requestedPath = resolve(rootPath, relativePath || '.')
    const realRequestedPath = await realpath(requestedPath)

    if (!isWithinRoot(rootPath, realRequestedPath)) {
      throw new Error('Workspace path escapes the project root.')
    }

    return {
      rootId: resolvedRoot.rootId,
      rootPath,
      absolutePath: realRequestedPath,
      relativePath: toWorkspaceRelativePath(rootPath, realRequestedPath)
    }
  }

  private async entryForPath(
    path: SafePath,
    name = basename(path.absolutePath)
  ): Promise<FileWorkspaceEntry> {
    const pathStats = await stat(path.absolutePath)
    return {
      name,
      path: path.relativePath,
      kind: entryKind(pathStats),
      size: pathStats.size,
      mtimeMs: pathStats.mtimeMs
    }
  }

  private async entryForDirectoryChild(
    parent: SafePath,
    childRelativePath: string,
    name: string
  ): Promise<FileWorkspaceEntry> {
    assertWorkspaceRelativePath(childRelativePath)
    const absolutePath = resolve(parent.rootPath, childRelativePath)
    if (!isWithinRoot(parent.rootPath, absolutePath)) {
      throw new Error('Workspace path escapes the project root.')
    }

    const pathStats = await lstat(absolutePath)
    return {
      name,
      path: toWorkspaceRelativePath(parent.rootPath, absolutePath),
      kind: entryKind(pathStats),
      size: pathStats.size,
      mtimeMs: pathStats.mtimeMs
    }
  }
}

function fuzzyFilesToWorkspaceMatches(
  rootPath: string,
  files: readonly FileWorkspaceFuzzyFile[]
): FileWorkspaceSearchMatch[] {
  const matches: FileWorkspaceSearchMatch[] = []
  const seen = new Set<string>()

  for (const file of files) {
    if (file.match_type !== 'file') continue
    const resultRoot = resolve(file.root)
    if (resultRoot !== rootPath) continue
    const absolutePath = isAbsolute(file.path) ? resolve(file.path) : resolve(resultRoot, file.path)
    if (!isWithinRoot(rootPath, absolutePath)) continue
    const path = toWorkspaceRelativePath(rootPath, absolutePath)
    if (!path || hasIgnoredSearchSegment(path) || seen.has(path)) continue
    if (!fileWorkspaceRelativePathSchema.safeParse(path).success) continue
    seen.add(path)
    matches.push({
      path,
      kind: 'path',
      preview: file.file_name || basename(absolutePath)
    })
    if (matches.length >= FILE_WORKSPACE_MAX_SEARCH_RESULTS) break
  }

  return matches
}

function hasIgnoredSearchSegment(path: string): boolean {
  return path.split('/').some((segment) => DEFAULT_IGNORED_SEARCH_DIRECTORIES.has(segment))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertWorkspaceRelativePath(path: string): void {
  const result = fileWorkspaceRelativePathSchema.safeParse(path)
  if (!result.success) {
    throw new Error('Workspace path must be a normalized relative path.')
  }
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  return (
    candidatePath === rootPath ||
    candidatePath.startsWith(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`)
  )
}

function toWorkspaceRelativePath(
  rootPath: string,
  absolutePath: string
): FileWorkspaceRelativePath {
  const path = relative(rootPath, absolutePath).split(sep).join('/')
  return path === '.' ? '' : path
}

function joinRelative(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child
}

function entryKind(pathStats: Stats): FileWorkspaceEntryKind {
  if (pathStats.isFile()) return 'file'
  if (pathStats.isDirectory()) return 'directory'
  if (pathStats.isSymbolicLink()) return 'symlink'
  return 'other'
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

const DEFAULT_IGNORED_SEARCH_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.next',
  '.pnpm-store',
  '.svn',
  '.turbo',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target'
])

function textContent(bytes: Buffer, text: string, limit: number): FileWorkspaceReadFileContent {
  if (bytes.byteLength > limit) {
    return { kind: 'too-large', binary: false, size: bytes.byteLength, limit }
  }
  return { kind: 'text', encoding: 'utf8', text }
}

function binaryContent(bytes: Buffer, limit: number): FileWorkspaceReadFileContent {
  if (bytes.byteLength > limit) {
    return { kind: 'too-large', binary: true, size: bytes.byteLength, limit }
  }
  return { kind: 'binary', encoding: 'base64', base64: bytes.toString('base64') }
}

function unavailablePath(
  rootId: string,
  path: string,
  unavailable: FileWorkspacePathUnavailableReason
): FileWorkspacePathUnavailableResult {
  return fileWorkspacePathUnavailableResultSchema.parse({
    version: FILE_WORKSPACE_API_VERSION,
    rootId,
    path,
    unavailable
  })
}

function unavailableReason(cause: unknown): FileWorkspacePathUnavailableReason | undefined {
  if (cause instanceof WorkspaceRootUnavailableError) return 'workspace-unavailable'
  return isMissingPathError(cause) ? 'not-found' : undefined
}

function isMissingPathError(cause: unknown): cause is NodeJS.ErrnoException {
  if (!cause || typeof cause !== 'object' || !('code' in cause)) return false
  return cause.code === 'ENOENT' || cause.code === 'ENOTDIR'
}

function findLineMatch(text: string, lowerQuery: string): { line: number; preview: string } | null {
  const lines = text.split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    if (line.toLocaleLowerCase().includes(lowerQuery)) {
      return { line: index + 1, preview: line.slice(0, 1000) }
    }
  }
  return null
}
