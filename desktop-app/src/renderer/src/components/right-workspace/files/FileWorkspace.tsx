import { FolderTreeIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon } from 'lucide-react'
import {
  getFiletypeFromFileName,
  getHighlighterOptions,
  preloadHighlighter,
  type FileOptions
} from '@pierre/diffs'
import { File } from '@pierre/diffs/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  FILE_WORKSPACE_API_VERSION,
  isFileWorkspacePathUnavailableResult,
  type FileWorkspacePathUnavailableReason,
  type FileWorkspaceReadFileContent
} from '../../../../../shared/fileWorkspaceApi'
import type { GitStatusEntry } from '@pierre/trees'
import type { GitConversationTarget, LocalGitReviewFile } from '../../../../../shared/localGitApi'
import { useGitRepository } from '../../local-git-review/GitRepositoryProvider'
import { buildWorkspaceFileTreeGitStatus } from './workspaceFileTreeGit'
import { buildWorkspaceFileSearchTreeModel } from './workspaceFileTreeModel'
import type { RightWorkspaceTab } from '../workspaceState'
import type { WorkspaceFileLocation } from '../../workspace-container/workspaceOpenTargets'
import { WorkspaceFileTree } from './WorkspaceFileTree'
import { useWorkspaceFileTree } from './useWorkspaceFileTree'
import { codePreviewSelectionForLocation } from './workspaceFileLocation'
import {
  FILE_TREE_MIN_WIDTH,
  loadFileTreePreferences,
  persistFileTreePreferences,
  type FileTreePreferences
} from './workspaceFileTreePersistence'

const FILE_TREE_MAX_WIDTH_RATIO = 0.6

const WORKSPACE_CODE_LINE_HEIGHT = 20

const workspaceFilePreviewUnsafeCss = `
:host {
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-light: var(--foreground);
  --diffs-dark: var(--foreground);
  --diffs-fg-number-override: var(--muted-foreground);
  --diffs-bg-context-override: var(--muted);
  --diffs-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --diffs-font-size: 13px;
  --diffs-line-height: ${WORKSPACE_CODE_LINE_HEIGHT}px;
}
`

const workspaceFilePreviewOptions: FileOptions<undefined> = {
  disableFileHeader: true,
  enableLineSelection: true,
  overflow: 'scroll',
  themeType: 'system',
  unsafeCSS: workspaceFilePreviewUnsafeCss
}

type Props = {
  tab: Extract<RightWorkspaceTab, { type: 'file' }>
  workspaceId: string
  target?: GitConversationTarget
  onOpenFile(path: string, title?: string, mode?: 'preview' | 'pinned'): void
}

export function FileWorkspace(props: Props): React.JSX.Element {
  return <FileWorkspaceInstance key={props.workspaceId} {...props} />
}

function FileWorkspaceInstance({ tab, workspaceId, target, onOpenFile }: Props): React.JSX.Element {
  const { status: gitRepositoryStatus, target: gitRepositoryTarget } = useGitRepository()
  const [gitFiles, setGitFiles] = useState<readonly LocalGitReviewFile[]>([])
  const [gitStatusError, setGitStatusError] = useState<string>()
  const [treePreferences, setTreePreferences] = useState<FileTreePreferences>(() =>
    loadFileTreePreferences(workspaceId)
  )
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string>()
  const [content, setContent] = useState<FileWorkspaceReadFileContent>()
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentWidth, setContentWidth] = useState(0)
  const [resizingTree, setResizingTree] = useState(false)
  const treeResizeStartX = useRef(0)
  const treeResizeStartWidth = useRef(treePreferences.width)

  useEffect(() => {
    persistFileTreePreferences(workspaceId, treePreferences)
  }, [treePreferences, workspaceId])

  const updateExpandedPaths = useCallback((paths: readonly string[]): void => {
    setTreePreferences((current) => {
      const nextPaths = [...paths]
      return equalPaths(current.expandedPaths, nextPaths)
        ? current
        : { ...current, expandedPaths: nextPaths }
    })
  }, [])

  const updateScrollTop = useCallback((scrollTop: number): void => {
    setTreePreferences((current) =>
      current.scrollTop === scrollTop ? current : { ...current, scrollTop }
    )
  }, [])

  const tree = useWorkspaceFileTree({
    initialExpandedPaths: treePreferences.expandedPaths,
    selectedPath: tab.revealPath ?? tab.relativePath,
    selectedPathIsDirectory: tab.revealPath !== undefined,
    target,
    workspaceId,
    onExpandedPathsChange: updateExpandedPaths
  })
  const gitStatus = useMemo<readonly GitStatusEntry[]>(
    () => buildWorkspaceFileTreeGitStatus(gitFiles, new Set(tree.treeModel.paths)),
    [gitFiles, tree.treeModel.paths]
  )
  const searchQuery = tree.search.trim()
  const searchMatches = tree.searchResult?.matches
  const searchTreeModel = useMemo(
    () => buildWorkspaceFileSearchTreeModel(searchMatches ?? []),
    [searchMatches]
  )
  const searchExpandedPaths = useMemo(
    () =>
      new Set(
        [...searchTreeModel.entriesByTreePath.entries()].flatMap(([treePath, entry]) =>
          entry.kind === 'directory' ? [treePath.slice(0, -1)] : []
        )
      ),
    [searchTreeModel.entriesByTreePath]
  )

  useEffect(() => {
    if (gitRepositoryStatus !== 'ready' || !gitRepositoryTarget) {
      let active = true
      void Promise.resolve().then(() => {
        if (!active) return
        setGitFiles([])
        setGitStatusError(undefined)
      })
      return () => {
        active = false
      }
    }
    let active = true
    const refreshGitStatus = (): void => {
      void window.desktopApp.git
        .getReviewSnapshot({ target: gitRepositoryTarget, source: { type: 'unstaged' } })
        .then((snapshot) => {
          if (active) setGitFiles(snapshot.files)
          if (active) setGitStatusError(undefined)
        })
        .catch((cause) => {
          if (active)
            setGitStatusError(cause instanceof Error ? cause.message : '无法读取 Git 状态。')
        })
    }
    refreshGitStatus()
    const unsubscribe = window.desktopApp.git.subscribe((event) => {
      if (
        event.target.hostId !== gitRepositoryTarget.hostId ||
        event.target.cwd !== gitRepositoryTarget.cwd
      )
        return
      refreshGitStatus()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [gitRepositoryStatus, gitRepositoryTarget])

  useEffect(() => {
    const container = contentRef.current
    if (!container) return
    const updateWidth = (): void => setContentWidth(container.getBoundingClientRect().width)
    updateWidth()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContentWidth(entry.contentRect.width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (contentWidth <= 0) return
    const frame = window.requestAnimationFrame(() => {
      setTreePreferences((current) => {
        const width = clampFileTreeWidth(current.width, contentWidth)
        return width === current.width ? current : { ...current, width }
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [contentWidth])

  useEffect(() => {
    if (!resizingTree) return
    const handlePointerMove = (event: PointerEvent): void => {
      setTreePreferences((current) => ({
        ...current,
        width: clampFileTreeWidth(
          treeResizeStartWidth.current + treeResizeStartX.current - event.clientX,
          contentWidth || window.innerWidth
        )
      }))
    }
    const handlePointerUp = (): void => setResizingTree(false)
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [contentWidth, resizingTree])

  useEffect(() => {
    let active = true
    const rootId = tree.rootId
    if (!rootId || !tab.relativePath) {
      void Promise.resolve().then(() => {
        if (!active) return
        setContent(undefined)
        setPreviewError(undefined)
        setPreviewLoading(false)
      })
      return () => {
        active = false
      }
    }
    void Promise.resolve()
      .then(() => {
        if (!active) return undefined
        setPreviewLoading(true)
        setPreviewError(undefined)
        return window.desktopApp.workspace.files.readFile({
          version: FILE_WORKSPACE_API_VERSION,
          rootId,
          path: tab.relativePath
        })
      })
      .then((result) => {
        if (!active || !result) return
        if (isFileWorkspacePathUnavailableResult(result)) {
          setContent(undefined)
          setPreviewError(fileUnavailableMessage(result.unavailable, tab.relativePath))
          return
        }
        setContent(result.content)
      })
      .catch((cause) => {
        if (active) setPreviewError(cause instanceof Error ? cause.message : '无法读取文件。')
      })
      .finally(() => {
        if (active) setPreviewLoading(false)
      })
    return () => {
      active = false
    }
  }, [tab.relativePath, tree.contentRefreshKey, tree.rootId])

  const beginTreeResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    treeResizeStartX.current = event.clientX
    treeResizeStartWidth.current = treePreferences.width
    event.currentTarget.setPointerCapture(event.pointerId)
    setResizingTree(true)
  }

  const treeRootId = tree.rootId

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4">
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          <span className="text-foreground">{tree.rootLabel}</span>
          {tab.relativePath ? <span> › {tab.relativePath}</span> : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">只读预览</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8"
            aria-label="刷新文件"
            disabled={!tree.rootId || tree.loading}
            onClick={() => void tree.refresh()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-xs"
            aria-pressed={treePreferences.visible}
            onClick={() =>
              setTreePreferences((current) => ({ ...current, visible: !current.visible }))
            }
          >
            <FolderTreeIcon className="size-3.5" />
            文件树
          </Button>
        </div>
      </div>
      <div ref={contentRef} className="flex min-h-0 flex-1">
        <FilePreview
          content={treeRootId && tab.relativePath ? content : undefined}
          error={target ? (previewError ?? tree.error) : '当前任务没有可用的本地项目。'}
          loading={previewLoading || tree.loading}
          path={tab.relativePath}
          location={tab.location}
          onOpenWithSystem={
            treeRootId && tab.relativePath
              ? () => {
                  void window.desktopApp.workspace.files
                    .openWithSystem({
                      version: FILE_WORKSPACE_API_VERSION,
                      rootId: treeRootId,
                      path: tab.relativePath
                    })
                    .catch((cause) =>
                      setPreviewError(
                        cause instanceof Error ? cause.message : '无法使用系统应用打开文件。'
                      )
                    )
                }
              : undefined
          }
        />
        {treePreferences.visible ? (
          <aside
            className="relative flex min-w-0 shrink-0 flex-col border-l border-border/70"
            style={{ width: treePreferences.width }}
          >
            <button
              type="button"
              aria-label="调整文件树宽度"
              className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              onPointerDown={beginTreeResize}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/70 transition-colors group-hover:bg-foreground/40',
                  resizingTree && 'bg-foreground/60'
                )}
              />
            </button>
            <div className="border-b border-border/70 p-3">
              <label className="relative block">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={tree.search}
                  onChange={(event) => tree.setSearch(event.target.value)}
                  className="h-9 pl-9 text-sm"
                  placeholder="筛选文件…"
                />
              </label>
              {gitStatusError ? (
                <p
                  className="mt-2 text-xs text-muted-foreground"
                  role="status"
                  title={gitStatusError}
                >
                  Git 状态暂不可用，保留上次标记。
                </p>
              ) : null}
            </div>
            <div className="flex min-h-0 flex-1 overflow-hidden p-2">
              {searchQuery ? (
                searchMatches === undefined || (tree.searching && searchMatches.length === 0) ? (
                  <FileSearchStatus>正在搜索文件…</FileSearchStatus>
                ) : !searchMatches?.length ? (
                  <FileSearchStatus>未找到匹配文件。</FileSearchStatus>
                ) : (
                  <WorkspaceFileTree
                    key="search-results"
                    autoExpandedPaths={searchExpandedPaths}
                    expandedPaths={tree.expandedPaths}
                    model={searchTreeModel}
                    persistExpansion={false}
                    rootId={tree.rootId}
                    scrollTop={0}
                    selectedPath={tab.revealPath ?? tab.relativePath}
                    workspaceId={workspaceId}
                    onEnsureDirectory={async () => undefined}
                    onError={setPreviewError}
                    onExpandedPathsChange={tree.syncExpandedPaths}
                    onOpenFile={onOpenFile}
                    onOpenWithSystem={async (path) => {
                      const rootId = tree.rootId
                      if (!rootId) return
                      await window.desktopApp.workspace.files.openWithSystem({
                        version: FILE_WORKSPACE_API_VERSION,
                        rootId,
                        path
                      })
                    }}
                    onScrollTopChange={() => undefined}
                  />
                )
              ) : tree.error ? (
                <FileTreeStatus
                  description={tree.error}
                  onRetry={tree.retry}
                  title="无法显示文件树"
                />
              ) : tree.loading && tree.treeModel.paths.length === 0 ? (
                <FileTreeStatus description="正在读取项目文件…" loading title="正在加载文件树" />
              ) : !target ? (
                <FileTreeStatus
                  description="当前任务没有可用的本地项目。"
                  title="没有可显示的文件"
                />
              ) : tree.treeModel.paths.length === 0 ? (
                <FileTreeStatus description="此项目目前没有可显示的文件。" title="文件夹为空" />
              ) : (
                <WorkspaceFileTree
                  key="workspace-browser"
                  expandedPaths={tree.expandedPaths}
                  gitStatus={gitStatus}
                  model={tree.treeModel}
                  rootId={tree.rootId}
                  scrollTop={treePreferences.scrollTop}
                  selectedPath={tab.revealPath ?? tab.relativePath}
                  workspaceId={workspaceId}
                  onEnsureDirectory={tree.ensureDirectory}
                  onError={setPreviewError}
                  onExpandedPathsChange={tree.syncExpandedPaths}
                  onOpenFile={onOpenFile}
                  onOpenWithSystem={async (path) => {
                    const rootId = tree.rootId
                    if (!rootId) return
                    await window.desktopApp.workspace.files.openWithSystem({
                      version: FILE_WORKSPACE_API_VERSION,
                      rootId,
                      path
                    })
                  }}
                  onScrollTopChange={updateScrollTop}
                />
              )}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

function FileSearchStatus({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="w-full self-start px-2 py-2 text-left text-sm text-muted-foreground"
      role="status"
    >
      {children}
    </div>
  )
}

function FileTreeStatus({
  description,
  loading = false,
  onRetry,
  title
}: {
  description: string
  loading?: boolean
  onRetry?(): void
  title: string
}): React.JSX.Element {
  return (
    <div
      className="flex min-h-0 flex-1 self-stretch flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground"
      role="status"
    >
      {loading ? (
        <LoaderCircleIcon className="size-5 animate-spin" />
      ) : (
        <FolderTreeIcon className="size-5" />
      )}
      <p className="font-medium text-foreground">{title}</p>
      <p className="max-w-64 text-xs leading-5">{description}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          重新尝试读取文件
        </Button>
      ) : null}
    </div>
  )
}

function FilePreview({
  content,
  error,
  loading,
  location,
  path,
  onOpenWithSystem
}: {
  content: FileWorkspaceReadFileContent | undefined
  error?: string
  loading: boolean
  location?: WorkspaceFileLocation
  path: string
  onOpenWithSystem?(): void
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        正在读取文件
      </div>
    )
  }
  if (error)
    return (
      <div role="alert" className="m-4 text-sm text-destructive">
        {error}
      </div>
    )
  if (!path)
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        从右侧文件树选择一个文件。
      </div>
    )
  if (!content)
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        文件不可用。
      </div>
    )
  if (content.kind === 'text') {
    if (/\.mdx?$/iu.test(path) && !location?.line) {
      return (
        <div className="min-w-0 flex-1 overflow-auto p-4">
          <Streamdown>{content.text}</Streamdown>
        </div>
      )
    }
    return <CodePreview key={path} location={location} path={path} text={content.text} />
  }
  if (content.kind === 'media') {
    if (content.mediaType === 'application/pdf') {
      return <iframe className="min-w-0 flex-1 border-0" title={path} src={content.url} />
    }
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto p-4">
        <img className="max-h-full max-w-full object-contain" alt={path} src={content.url} />
      </div>
    )
  }
  if (content.kind === 'too-large') {
    return (
      <UnsupportedPreview
        message={`文件过大（${formatBytes(content.size)}），为保护性能未加载预览。`}
        onOpenWithSystem={onOpenWithSystem}
      />
    )
  }
  return (
    <UnsupportedPreview message="此文件暂不支持内嵌预览。" onOpenWithSystem={onOpenWithSystem} />
  )
}

function fileUnavailableMessage(reason: FileWorkspacePathUnavailableReason, path: string): string {
  if (reason === 'workspace-unavailable') return '当前任务的项目目录已不可用。'
  if (reason === 'not-file') return `“${path}”不是可预览的文件。`
  return `当前任务的项目中不存在“${path}”。`
}

function CodePreview({
  location,
  path,
  text
}: {
  location?: WorkspaceFileLocation
  path: string
  text: string
}): React.JSX.Element {
  const [highlighterStatus, setHighlighterStatus] = useState<'loading' | 'ready' | 'failed'>(
    'loading'
  )
  const file = useMemo(() => ({ name: path, contents: text }), [path, text])
  const previewRef = useRef<HTMLDivElement>(null)
  const fallbackRef = useRef<HTMLPreElement>(null)
  const scrollFrameRef = useRef<number | undefined>(undefined)
  const selectedLines = useMemo(
    () => codePreviewSelectionForLocation(location, text),
    [location, text]
  )

  const scheduleLocationScroll = useCallback(() => {
    if (!selectedLines) return
    if (scrollFrameRef.current !== undefined) {
      window.cancelAnimationFrame(scrollFrameRef.current)
    }
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined
      const preview = previewRef.current
      if (!preview) return
      preview.scrollTo({
        behavior: 'instant',
        top: Math.max(
          0,
          (selectedLines.start - 0.5) * WORKSPACE_CODE_LINE_HEIGHT - preview.clientHeight / 2
        )
      })
    })
  }, [selectedLines])

  const codePreviewOptions = useMemo<FileOptions<undefined>>(
    () => ({
      ...workspaceFilePreviewOptions,
      // The file renderer calls this only after it has produced the code DOM.
      // This mirrors Codex Electron's selection-and-scroll ordering, avoiding
      // a scroll request against an unmounted preview.
      onPostRender: (_node, _instance, phase) => {
        if (phase !== 'unmount') scheduleLocationScroll()
      }
    }),
    [scheduleLocationScroll]
  )

  useEffect(() => {
    let active = true
    const highlighterOptions = getHighlighterOptions(
      getFiletypeFromFileName(path),
      workspaceFilePreviewOptions
    )
    void preloadHighlighter(highlighterOptions).then(
      () => {
        if (active) setHighlighterStatus('ready')
      },
      () => {
        if (active) setHighlighterStatus('failed')
      }
    )
    return () => {
      active = false
    }
  }, [path])

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== undefined) {
        window.cancelAnimationFrame(scrollFrameRef.current)
      }
    },
    []
  )

  useEffect(() => {
    if (highlighterStatus !== 'failed' || !selectedLines) return
    const frame = window.requestAnimationFrame(() => {
      fallbackRef.current
        ?.querySelector<HTMLElement>(`[data-workspace-code-line="${selectedLines.start}"]`)
        ?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [highlighterStatus, selectedLines])

  if (highlighterStatus === 'loading') {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        正在准备代码预览
      </div>
    )
  }

  if (highlighterStatus === 'failed') {
    return (
      <pre
        ref={fallbackRef}
        className="min-w-0 flex-1 overflow-auto bg-background p-4 font-mono text-xs leading-5 whitespace-pre"
        data-workspace-code-location={location?.line}
      >
        <code>{numberedFallbackCode(text, selectedLines)}</code>
      </pre>
    )
  }

  return (
    <div
      ref={previewRef}
      className="min-w-0 flex-1 overflow-auto bg-background"
      data-workspace-code-preview="pierre"
    >
      <File
        file={file}
        options={codePreviewOptions}
        className="min-h-full"
        disableWorkerPool
        selectedLines={selectedLines ?? null}
      />
    </div>
  )
}

function numberedFallbackCode(
  text: string,
  selection: { start: number; end: number } | undefined
): React.JSX.Element[] {
  return text.split('\n').map((line, index) => {
    const lineNumber = index + 1
    const selected = Boolean(
      selection && lineNumber >= selection.start && lineNumber <= selection.end
    )
    return (
      <span
        key={lineNumber}
        id={`workspace-line-${lineNumber}`}
        data-workspace-code-line={lineNumber}
        data-selected={selected || undefined}
        className={selected ? 'block bg-sky-500/15' : 'block'}
      >
        {line}
        {'\n'}
      </span>
    )
  })
}

function UnsupportedPreview({
  message,
  onOpenWithSystem
}: {
  message: string
  onOpenWithSystem?(): void
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted-foreground">
      <p>{message}</p>
      {onOpenWithSystem ? (
        <Button type="button" variant="secondary" size="sm" onClick={onOpenWithSystem}>
          使用系统应用打开
        </Button>
      ) : null}
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function clampFileTreeWidth(width: number, containerWidth: number): number {
  const maximumWidth = Math.max(
    FILE_TREE_MIN_WIDTH,
    Math.floor(containerWidth * FILE_TREE_MAX_WIDTH_RATIO)
  )
  return Math.min(Math.max(Math.round(width), FILE_TREE_MIN_WIDTH), maximumWidth)
}

function equalPaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}
