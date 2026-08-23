import { FileTree, useFileTree } from '@pierre/trees/react'
import { SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { useOptionalRightWorkspace } from '@/components/right-workspace'
import { cn } from '@/lib/utils'
import {
  FILE_WORKSPACE_API_VERSION,
  isFileWorkspacePathUnavailableResult
} from '../../../../../shared/fileWorkspaceApi'
import { buildReviewFileTreeModel } from './reviewFileTreeModel'
import { measureReviewPerformance } from './reviewPerformance'
import type { ReviewWorkspaceController } from './reviewWorkspaceTypes'

const reviewFileTreeUnsafeCss = `
:host {
  --tree-bg: transparent;
  --tree-fg: var(--foreground);
  --tree-muted-fg: var(--muted-foreground);
  --tree-hover-bg: var(--accent);
  --tree-selected-bg: color-mix(in srgb, var(--accent) 70%, transparent);
  --tree-font-size: 12px;
}
`

type Props = {
  controller: ReviewWorkspaceController
}

export function ReviewFileTree({ controller }: Props): React.JSX.Element | null {
  const setTreeFilterRef = useRef(controller.setTreeFilter)
  const controllerTreeFilterRef = useRef(controller.preferences.treeFilter)
  const [treeFilterInput, setTreeFilterInput] = useState(controller.preferences.treeFilter)

  useEffect(() => {
    setTreeFilterRef.current = controller.setTreeFilter
  }, [controller.setTreeFilter])

  useEffect(() => {
    if (controller.preferences.treeFilter === treeFilterInput) return
    // Keep the filter outside the conditionally visible tree so hiding the panel does not
    // cancel the pending persistence or discard what the user typed.
    const timer = window.setTimeout(() => setTreeFilterRef.current(treeFilterInput), 400)
    return () => window.clearTimeout(timer)
  }, [controller.preferences.treeFilter, treeFilterInput])

  useEffect(() => {
    if (controllerTreeFilterRef.current === controller.preferences.treeFilter) return
    controllerTreeFilterRef.current = controller.preferences.treeFilter
    setTreeFilterInput(controller.preferences.treeFilter)
  }, [controller.preferences.treeFilter])

  return controller.treeVisible ? (
    <VisibleReviewFileTree
      controller={controller}
      treeFilterInput={treeFilterInput}
      setTreeFilterInput={setTreeFilterInput}
    />
  ) : null
}

function VisibleReviewFileTree({
  controller,
  treeFilterInput,
  setTreeFilterInput
}: Props & {
  treeFilterInput: string
  setTreeFilterInput(value: string): void
}): React.JSX.Element {
  const workspace = useOptionalRightWorkspace()
  const callbacksRef = useRef({ controller })
  const treeModel = useMemo(
    () =>
      buildReviewFileTreeModel(
        controller.loadState.status === 'ready' ? controller.loadState.groups : []
      ),
    [controller.loadState]
  )
  const initialExpandedPaths = useMemo(
    () => treeModel.paths.filter((path) => path.endsWith('/')),
    [treeModel.paths]
  )
  const initialSelectedPaths = useMemo(
    () => (controller.selectedPath ? [controller.selectedPath] : []),
    // Selection is synchronized after construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )
  const canOpenWorktreeFile =
    controller.displaySource.type === 'uncommitted' ||
    controller.displaySource.type === 'unstaged' ||
    controller.displaySource.type === 'staged'
  const treeOptions = useMemo(
    () => ({
      composition: {
        contextMenu: {
          enabled: true,
          onOpen: (
            item: { kind: 'directory' | 'file'; name: string; path: string },
            context: { close(): void }
          ) => {
            context.close()
            if (item.kind !== 'file') return
            const group = treeModel.entriesByTreePath.get(item.path)?.group
            const reviewController = callbacksRef.current.controller
            void showNativeReviewFileMenu({
              path: item.path,
              name: item.name,
              target: controller.target,
              canOpenWorktreeFile,
              openFile: workspace?.openFile,
              toggleViewed:
                group && reviewController.displaySource.type === 'branch'
                  ? () => reviewController.setViewed(group, !reviewController.isViewed(group))
                  : undefined,
              viewed: group ? reviewController.isViewed(group) : false
            })
          },
          triggerMode: 'right-click' as const
        }
      },
      fileTreeSearchMode: 'hide-non-matches' as const,
      flattenEmptyDirectories: true,
      gitStatus: treeModel.gitStatus,
      icons: { colored: true, set: 'complete' as const },
      id: 'review-file-tree',
      initialExpandedPaths,
      initialSelectedPaths,
      itemHeight: 29,
      onSelectionChange: (paths: readonly string[]) => {
        const selected = paths.at(-1)
        if (!selected || selected.endsWith('/')) return
        callbacksRef.current.controller.setSelectedPath(selected)
      },
      paths: treeModel.paths,
      renderRowDecoration: ({ item }) => {
        const group = treeModel.entriesByTreePath.get(item.path)?.group
        return group && callbacksRef.current.controller.isViewed(group)
          ? { text: '已查看', title: '此文件已标记为查看' }
          : null
      },
      renaming: false,
      search: false,
      stickyFolders: true,
      unsafeCSS: reviewFileTreeUnsafeCss
    }),
    [
      canOpenWorktreeFile,
      controller.target,
      initialExpandedPaths,
      initialSelectedPaths,
      treeModel,
      workspace?.openFile
    ]
  )
  const { model } = useFileTree({
    ...treeOptions
  })

  useEffect(() => {
    callbacksRef.current = { controller }
  }, [controller])

  useEffect(() => {
    model.resetPaths(treeModel.paths, { initialExpandedPaths })
    model.setGitStatus(treeModel.gitStatus)
  }, [initialExpandedPaths, model, treeModel.gitStatus, treeModel.paths])

  useEffect(() => {
    model.setSearch(treeFilterInput || null)
  }, [model, treeFilterInput])

  useEffect(() => {
    const selectedPath = controller.activePath
    if (!selectedPath) return
    const frame = window.requestAnimationFrame(() => {
      const item = model.getItem(selectedPath)
      if (item) {
        item.select()
        model.scrollToPath(selectedPath, { focus: false, offset: 'nearest' })
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [controller.activePath, model, treeModel.paths])

  return (
    <aside
      aria-label="Review file tree"
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-background"
      style={{ width: controller.preferences.treeWidth }}
    >
      <div
        role="separator"
        aria-label="调整文件树宽度"
        aria-orientation="vertical"
        className="absolute -left-1 z-10 h-full w-2 cursor-col-resize touch-none"
        onPointerDown={(event) => startResize(event, controller)}
      />
      <div className="border-b p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="筛选文件"
            className="h-7 pl-7 text-xs"
            placeholder="筛选文件..."
            value={treeFilterInput}
            onChange={(event) => {
              const value = event.currentTarget.value
              measureReviewPerformance('tree-filter-visible', () => {
                // setSearch synchronously updates the tree projection and emits its render.
                model.setSearch(value || null)
              })
              setTreeFilterInput(value)
            }}
          />
        </div>
      </div>
      <FileTree
        model={model}
        className={cn('min-h-0 flex-1 text-xs')}
        data-review-file-tree="true"
      />
    </aside>
  )
}

async function showNativeReviewFileMenu({
  path,
  name,
  target,
  canOpenWorktreeFile,
  openFile,
  toggleViewed,
  viewed
}: {
  path: string
  name: string
  target: ReviewWorkspaceController['target']
  canOpenWorktreeFile: boolean
  openFile?: (relativePath: string, title?: string) => void
  toggleViewed?: () => void
  viewed: boolean
}): Promise<void> {
  const capability =
    canOpenWorktreeFile && target ? await verifyCurrentWorktreeFile(target, path) : undefined
  const enabled = Boolean(capability && openFile)
  const action = await window.desktopApp.nativeContextMenu.show([
    { id: 'preview', label: '预览', type: 'action', enabled },
    { id: 'open-pinned', label: '固定打开', type: 'action', enabled },
    { type: 'separator' },
    { id: 'copy-relative-path', label: '复制相对路径', type: 'action' },
    { id: 'open-with-system', label: '使用系统应用打开', type: 'action', enabled },
    ...(toggleViewed
      ? [
          { type: 'separator' as const },
          {
            id: 'toggle-viewed',
            label: viewed ? '标为未查看' : '标为已查看',
            type: 'action' as const
          }
        ]
      : [])
  ])
  if (action === 'copy-relative-path') {
    await navigator.clipboard.writeText(path).catch(() => undefined)
    return
  }
  if (action === 'preview' || action === 'open-pinned') {
    openFile?.(path, name)
    return
  }
  if (action === 'open-with-system' && capability) {
    await window.desktopApp.workspace.files.openWithSystem({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: capability.rootId,
      path
    })
    return
  }
  if (action === 'toggle-viewed') toggleViewed?.()
}

async function verifyCurrentWorktreeFile(
  target: NonNullable<ReviewWorkspaceController['target']>,
  path: string
): Promise<{ rootId: string } | undefined> {
  try {
    const root = await window.desktopApp.workspace.files.prepareRoot({
      workspaceId: 'review-context-menu',
      target: {
        conversationId: target.conversationId,
        ...(target.threadId ? { threadId: target.threadId } : {})
      }
    })
    const metadata = await window.desktopApp.workspace.files.metadata({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: root.rootId,
      path
    })
    if (isFileWorkspacePathUnavailableResult(metadata)) return undefined
    return metadata.entry.kind === 'file' ? { rootId: root.rootId } : undefined
  } catch {
    return undefined
  }
}

function startResize(
  event: React.PointerEvent<HTMLDivElement>,
  controller: ReviewWorkspaceController
): void {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = controller.preferences.treeWidth
  const pointerId = event.pointerId
  const element = event.currentTarget
  let frame = 0
  let pendingWidth: number | undefined
  element.setPointerCapture(pointerId)
  const onPointerMove = (moveEvent: PointerEvent): void => {
    pendingWidth = startWidth - (moveEvent.clientX - startX)
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (pendingWidth !== undefined) controller.setTreeWidth(pendingWidth)
    })
  }
  const stop = (): void => {
    if (frame) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    if (pendingWidth !== undefined) controller.setTreeWidth(pendingWidth)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stop, { once: true })
  window.addEventListener('pointercancel', stop, { once: true })
}
