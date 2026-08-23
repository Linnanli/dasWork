import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  FILE_WORKSPACE_API_VERSION,
  isFileWorkspacePathUnavailableResult,
  type FileWorkspaceDirectoryListing,
  type FileWorkspacePathUnavailableReason,
  type FileWorkspaceSearchMatch
} from '../../../../../shared/fileWorkspaceApi'
import type { GitConversationTarget } from '../../../../../shared/localGitApi'
import {
  buildWorkspaceFileTreeModel,
  normalizeWorkspaceDirectoryPath,
  normalizeWorkspacePath
} from './workspaceFileTreeModel'

type DirectoryCache = Record<string, FileWorkspaceDirectoryListing | undefined>

type UseWorkspaceFileTreeOptions = {
  initialExpandedPaths: readonly string[]
  selectedPath: string
  selectedPathIsDirectory?: boolean
  target?: GitConversationTarget
  workspaceId: string
  onExpandedPathsChange?(paths: readonly string[]): void
}

type LoadDirectoryOptions = {
  force?: boolean
  generation?: number
  rootId?: string
}

type RevealPathOptions = {
  directory?: boolean
}

export type WorkspaceFileTreeController = {
  contentRefreshKey: number
  directories: DirectoryCache
  ensureDirectory(path: string): Promise<void>
  error?: string
  expandedPaths: ReadonlySet<string>
  loading: boolean
  loadingPaths: ReadonlySet<string>
  refresh(): Promise<void>
  retry(): void
  revealPath(path: string, options?: RevealPathOptions): Promise<boolean>
  rootId?: string
  rootLabel: string
  search: string
  searchResult?: { matches: FileWorkspaceSearchMatch[]; query: string }
  searching: boolean
  setSearch(search: string): void
  syncExpandedPaths(paths: readonly string[]): void
  treeModel: ReturnType<typeof buildWorkspaceFileTreeModel>
}

export function useWorkspaceFileTree({
  initialExpandedPaths,
  selectedPath,
  selectedPathIsDirectory = false,
  target,
  workspaceId,
  onExpandedPathsChange
}: UseWorkspaceFileTreeOptions): WorkspaceFileTreeController {
  const [rootId, setRootId] = useState<string>()
  const [rootLabel, setRootLabel] = useState('Files')
  const [directories, setDirectories] = useState<DirectoryCache>({})
  const [expandedPaths, setExpandedPathsState] = useState<Set<string>>(
    () => new Set(normalizeExpandedPaths(initialExpandedPaths))
  )
  const [search, setSearch] = useState('')
  const [searchResult, setSearchResult] = useState<{
    matches: FileWorkspaceSearchMatch[]
    query: string
  }>()
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string>()
  const [contentRefreshKey, setContentRefreshKey] = useState(0)
  const [rootRetryVersion, setRootRetryVersion] = useState(0)

  const generationRef = useRef(0)
  const rootIdRef = useRef<string | undefined>(undefined)
  const directoriesRef = useRef<DirectoryCache>({})
  const inFlightRef = useRef(new Map<string, Promise<FileWorkspaceDirectoryListing>>())
  const selectedPathRef = useRef(selectedPath)
  const fileEventTimerRef = useRef<number | undefined>(undefined)
  const queuedDirectoryRefreshesRef = useRef(new Set<string>())
  const searchRequestRef = useRef(0)
  const searchRef = useRef('')
  const searchSessionRef = useRef<{ rootId: string; sessionId: string } | undefined>(undefined)
  const initialExpandedPathsRef = useRef(initialExpandedPaths)
  const targetConversationId = target?.conversationId
  const targetThreadId = target?.threadId
  const stableTarget = useMemo(
    () =>
      targetConversationId
        ? {
            conversationId: targetConversationId,
            ...(targetThreadId ? { threadId: targetThreadId } : {})
          }
        : undefined,
    [targetConversationId, targetThreadId]
  )

  useEffect(() => {
    selectedPathRef.current = selectedPath
  }, [selectedPath])

  useEffect(() => {
    searchRef.current = search
  }, [search])

  useEffect(() => {
    initialExpandedPathsRef.current = initialExpandedPaths
  }, [initialExpandedPaths])

  const isCurrentRequest = useCallback((generation: number, requestRootId: string): boolean => {
    return generationRef.current === generation && rootIdRef.current === requestRootId
  }, [])

  const loadDirectory = useCallback(
    async (
      path: string,
      options: LoadDirectoryOptions = {}
    ): Promise<FileWorkspaceDirectoryListing> => {
      const normalizedPath = normalizeWorkspaceDirectoryPath(path)
      const requestRootId = options.rootId ?? rootIdRef.current
      const generation = options.generation ?? generationRef.current
      if (!requestRootId || normalizedPath === undefined) {
        throw new Error('无法读取无效的工作区目录。')
      }
      const requestKey = `${generation}\0${requestRootId}\0${normalizedPath}`
      const cached = directoriesRef.current[normalizedPath]
      if (!options.force && cached) return cached
      const inFlight = inFlightRef.current.get(requestKey)
      if (inFlight) return inFlight

      setLoadingPaths((current) => new Set(current).add(normalizedPath))
      const request = window.desktopApp.workspace.files
        .listDirectory({
          version: FILE_WORKSPACE_API_VERSION,
          rootId: requestRootId,
          path: normalizedPath
        })
        .then((result) => {
          if (isFileWorkspacePathUnavailableResult(result)) {
            if (isCurrentRequest(generation, requestRootId)) {
              directoriesRef.current = withoutDirectoryBranch(
                directoriesRef.current,
                normalizedPath
              )
              setDirectories(directoriesRef.current)
            }
            throw new Error(directoryUnavailableMessage(result.unavailable, normalizedPath))
          }
          if (isCurrentRequest(generation, requestRootId)) {
            directoriesRef.current = { ...directoriesRef.current, [normalizedPath]: result }
            setDirectories(directoriesRef.current)
          }
          return result
        })
        .finally(() => {
          inFlightRef.current.delete(requestKey)
          if (isCurrentRequest(generation, requestRootId)) {
            setLoadingPaths((current) => {
              if (!current.has(normalizedPath)) return current
              const next = new Set(current)
              next.delete(normalizedPath)
              return next
            })
          }
        })
      inFlightRef.current.set(requestKey, request)
      return request
    },
    [isCurrentRequest]
  )

  const revealPath = useCallback(
    async (path: string, options: RevealPathOptions = {}): Promise<boolean> => {
      const normalizedPath = options.directory
        ? normalizeWorkspaceDirectoryPath(path)
        : normalizeWorkspacePath(path)
      const requestRootId = rootIdRef.current
      const generation = generationRef.current
      if (!normalizedPath || !requestRootId) return false

      const directoryPaths = options.directory
        ? workspaceDirectoryAncestors(normalizedPath)
        : workspacePathAncestors(normalizedPath)
      try {
        for (const directoryPath of directoryPaths) {
          await loadDirectory(directoryPath, { generation, rootId: requestRootId })
        }
      } catch (cause) {
        if (options.directory && isCurrentRequest(generation, requestRootId)) {
          setError(cause instanceof Error ? cause.message : '无法读取目录。')
        }
        return false
      }
      if (!isCurrentRequest(generation, requestRootId)) return false
      if (options.directory) setError(undefined)
      setExpandedPathsState(
        (current) => new Set([...current, ...directoryPaths.filter(Boolean)])
      )
      return true
    },
    [isCurrentRequest, loadDirectory]
  )

  const ensureDirectory = useCallback(
    async (path: string): Promise<void> => {
      const normalizedPath = normalizeWorkspaceDirectoryPath(path)
      if (!normalizedPath) return
      setError(undefined)
      try {
        await loadDirectory(normalizedPath)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '无法读取目录。')
        throw cause
      }
    },
    [loadDirectory]
  )

  const refresh = useCallback(async (): Promise<void> => {
    const requestRootId = rootIdRef.current
    const generation = generationRef.current
    if (!requestRootId) return
    setLoading(true)
    setError(undefined)
    try {
      await Promise.all(
        Object.keys(directoriesRef.current).map((path) =>
          loadDirectory(path, { force: true, generation, rootId: requestRootId })
        )
      )
      if (isCurrentRequest(generation, requestRootId)) {
        setContentRefreshKey((current) => current + 1)
      }
    } catch (cause) {
      if (isCurrentRequest(generation, requestRootId)) {
        setError(cause instanceof Error ? cause.message : '无法刷新文件。')
      }
    } finally {
      if (isCurrentRequest(generation, requestRootId)) setLoading(false)
    }
  }, [isCurrentRequest, loadDirectory])

  const retry = useCallback((): void => {
    setRootRetryVersion((current) => current + 1)
  }, [])

  const syncExpandedPaths = useCallback((paths: readonly string[]): void => {
    const normalizedPaths = normalizeExpandedPaths(paths)
    setExpandedPathsState((current) => {
      if (
        current.size === normalizedPaths.length &&
        normalizedPaths.every((path) => current.has(path))
      ) {
        return current
      }
      return new Set(normalizedPaths)
    })
  }, [])

  useEffect(() => {
    const generation = ++generationRef.current
    rootIdRef.current = undefined
    directoriesRef.current = {}
    inFlightRef.current.clear()
    queuedDirectoryRefreshesRef.current.clear()
    if (fileEventTimerRef.current !== undefined) {
      window.clearTimeout(fileEventTimerRef.current)
      fileEventTimerRef.current = undefined
    }
    let active = true
    void Promise.resolve()
      .then(() => {
        if (!active || generation !== generationRef.current) return undefined
        setRootId(undefined)
        setRootLabel('Files')
        setDirectories({})
        setExpandedPathsState(new Set(normalizeExpandedPaths(initialExpandedPathsRef.current)))
        setSearch('')
        setSearchResult(undefined)
        setSearching(false)
        setLoadingPaths(new Set())
        setError(undefined)
        setContentRefreshKey((current) => current + 1)
        if (!stableTarget) return undefined
        setLoading(true)
        return window.desktopApp.workspace.files.prepareRoot({ workspaceId, target: stableTarget })
      })
      .then(async (root) => {
        if (!root || !active || generation !== generationRef.current) return
        rootIdRef.current = root.rootId
        setRootId(root.rootId)
        setRootLabel(root.label)
        await loadDirectory('', { force: true, generation, rootId: root.rootId })
        for (const expandedPath of normalizeExpandedPaths(initialExpandedPathsRef.current)) {
          for (const directoryPath of workspaceDirectoryAncestors(expandedPath)) {
            await loadDirectory(directoryPath, { generation, rootId: root.rootId })
          }
        }
      })
      .catch((cause) => {
        if (!active || generation !== generationRef.current) return
        setError(cause instanceof Error ? cause.message : '无法读取项目文件。')
      })
      .finally(() => {
        if (active && generation === generationRef.current) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [loadDirectory, rootRetryVersion, stableTarget, workspaceId])

  useEffect(() => {
    onExpandedPathsChange?.([...expandedPaths])
  }, [expandedPaths, onExpandedPathsChange])

  useEffect(() => {
    if (!rootId || !selectedPath) return
    void Promise.resolve().then(() =>
      revealPath(selectedPath, { directory: selectedPathIsDirectory })
    )
  }, [revealPath, rootId, selectedPath, selectedPathIsDirectory])

  useEffect(() => {
    if (!rootId) return
    const flushFileEvents = (): void => {
      fileEventTimerRef.current = undefined
      const paths = [...queuedDirectoryRefreshesRef.current]
      queuedDirectoryRefreshesRef.current.clear()
      if (paths.length === 0) return
      void Promise.all(paths.map((path) => loadDirectory(path, { force: true }))).catch(
        () => undefined
      )
    }
    return window.desktopApp.workspace.files.onEvent((event) => {
      if (event.rootId !== rootId) return
      if (!event.path || event.path === selectedPathRef.current) {
        setContentRefreshKey((current) => current + 1)
      }
      const changedDirectory = event.path ? parentWorkspacePath(event.path) : undefined
      const loadedPaths = Object.keys(directoriesRef.current)
      const pathsToRefresh = changedDirectory
        ? loadedPaths.filter((path) => path === changedDirectory)
        : loadedPaths
      for (const path of pathsToRefresh) queuedDirectoryRefreshesRef.current.add(path)
      if (fileEventTimerRef.current === undefined) {
        fileEventTimerRef.current = window.setTimeout(flushFileEvents, 100)
      }
    })
  }, [loadDirectory, rootId])

  useEffect(
    () => () => {
      if (fileEventTimerRef.current !== undefined) window.clearTimeout(fileEventTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!rootId) return undefined
    const requestRootId = rootId
    const generation = generationRef.current
    let active = true
    let sessionId: string | undefined
    const removeListener = window.desktopApp.workspace.files.onSearchEvent((event) => {
      if (
        !active ||
        !sessionId ||
        event.sessionId !== sessionId ||
        event.rootId !== requestRootId ||
        event.query !== searchRef.current.trim() ||
        !isCurrentRequest(generation, requestRootId)
      ) {
        return
      }
      setSearchResult({ query: event.query, matches: event.matches })
      setSearching(!event.complete)
    })

    void window.desktopApp.workspace.files
      .startSearch({ version: FILE_WORKSPACE_API_VERSION, rootId: requestRootId })
      .then((result) => {
        if (!active || !isCurrentRequest(generation, requestRootId)) {
          void window.desktopApp.workspace.files.stopSearch({
            version: FILE_WORKSPACE_API_VERSION,
            sessionId: result.sessionId
          })
          return
        }
        sessionId = result.sessionId
        searchSessionRef.current = { rootId: requestRootId, sessionId }
        const query = searchRef.current.trim()
        if (!query) return
        setSearching(true)
        void updateWorkspaceFileSearch(sessionId, query, requestRootId, generation)
      })
      .catch(() => {
        if (active && isCurrentRequest(generation, requestRootId)) setSearching(false)
      })

    return () => {
      active = false
      removeListener()
      if (searchSessionRef.current?.sessionId === sessionId) {
        searchSessionRef.current = undefined
      }
      if (sessionId) {
        void window.desktopApp.workspace.files.stopSearch({
          version: FILE_WORKSPACE_API_VERSION,
          sessionId
        })
      }
    }

    async function updateWorkspaceFileSearch(
      activeSessionId: string,
      query: string,
      activeRootId: string,
      activeGeneration: number
    ): Promise<void> {
      try {
        await window.desktopApp.workspace.files.updateSearch({
          version: FILE_WORKSPACE_API_VERSION,
          sessionId: activeSessionId,
          query
        })
      } catch {
        if (
          active &&
          searchRef.current.trim() === query &&
          isCurrentRequest(activeGeneration, activeRootId)
        ) {
          setSearching(false)
        }
      }
    }
  }, [isCurrentRequest, rootId])

  useEffect(() => {
    const query = search.trim()
    const requestId = ++searchRequestRef.current
    const session = searchSessionRef.current
    if (!query) {
      if (session && session.rootId === rootId) {
        void window.desktopApp.workspace.files
          .updateSearch({
            version: FILE_WORKSPACE_API_VERSION,
            sessionId: session.sessionId,
            query
          })
          .catch(() => undefined)
      }
      void Promise.resolve().then(() => {
        if (requestId !== searchRequestRef.current) return
        setSearchResult(undefined)
        setSearching(false)
      })
      return
    }

    if (!session || session.rootId !== rootId) {
      void Promise.resolve().then(() => {
        if (requestId === searchRequestRef.current) setSearching(true)
      })
      return
    }

    setSearching(true)
    void window.desktopApp.workspace.files
      .updateSearch({
        version: FILE_WORKSPACE_API_VERSION,
        sessionId: session.sessionId,
        query
      })
      .catch(() => {
        if (requestId !== searchRequestRef.current || searchRef.current.trim() !== query) return
        setSearching(false)
      })
  }, [rootId, search])

  const treeModel = useMemo(() => buildWorkspaceFileTreeModel(directories), [directories])

  return {
    contentRefreshKey,
    directories,
    ensureDirectory,
    error,
    expandedPaths,
    loading,
    loadingPaths,
    refresh,
    retry,
    revealPath,
    rootId,
    rootLabel,
    search,
    searchResult,
    searching,
    setSearch,
    syncExpandedPaths,
    treeModel
  }
}

function normalizeExpandedPaths(paths: readonly string[]): string[] {
  const normalizedPaths = new Set<string>()
  for (const path of paths) {
    const normalized = normalizeWorkspaceDirectoryPath(path)
    if (normalized) normalizedPaths.add(normalized)
  }
  return [...normalizedPaths]
}

function parentWorkspacePath(path: string): string {
  const separator = path.lastIndexOf('/')
  return separator === -1 ? '' : path.slice(0, separator)
}

function workspacePathAncestors(path: string): string[] {
  const ancestors: string[] = []
  let current = parentWorkspacePath(path)
  while (current) {
    ancestors.unshift(current)
    current = parentWorkspacePath(current)
  }
  return ['', ...ancestors]
}
function workspaceDirectoryAncestors(path: string): string[] {
  return workspacePathAncestors(`${path}/placeholder`)
}

function withoutDirectoryBranch(cache: DirectoryCache, path: string): DirectoryCache {
  if (!path) return {}
  const prefix = `${path}/`
  return Object.fromEntries(
    Object.entries(cache).filter(
      ([cachedPath]) => cachedPath !== path && !cachedPath.startsWith(prefix)
    )
  )
}

function directoryUnavailableMessage(
  reason: FileWorkspacePathUnavailableReason,
  path: string
): string {
  if (reason === 'workspace-unavailable') return '当前任务的项目目录已不可用。'
  if (reason === 'not-directory') return `“${path || '项目根目录'}”不是文件夹。`
  return `当前任务的项目中不存在“${path || '项目根目录'}”。`
}
