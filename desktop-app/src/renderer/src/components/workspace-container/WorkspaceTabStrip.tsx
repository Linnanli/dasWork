import { useDroppable } from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable'
import {
  FileCode2Icon,
  FilesIcon,
  GitPullRequestIcon,
  GlobeIcon,
  PlusIcon,
  TerminalIcon,
  XIcon
} from 'lucide-react'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type MouseEvent,
  type RefCallback
} from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { WorkspaceOpenTarget } from './workspaceOpenTargets'
import {
  WorkspaceTabDragProvider,
  useOptionalWorkspaceTabDrag,
  useWorkspaceTabDrag,
  workspaceTabPreviewIds,
  type ActiveWorkspaceTabDrag,
  type WorkspaceTabDndData,
  type WorkspaceTabStripDndData
} from './WorkspaceTabDragProvider'
import type { WorkspacePanelId, WorkspaceTabRecord } from './workspaceTypes'

type IconComponent = ComponentType<{ className?: string }>

type WorkspaceTabStripProps = {
  panelId: WorkspacePanelId
  tabs: readonly WorkspaceTabRecord[]
  activeTabId?: string
  className?: string
  onActivate(tabId: string): void
  onClose(tabId: string): void
  onCloseOther?(tabId: string): void
  onCloseToRight?(tabId: string): void
  onPin?(tabId: string): void
  onOpen(target: WorkspaceOpenTarget): void
  onMove?(
    sourcePanelId: WorkspacePanelId,
    destinationPanelId: WorkspacePanelId,
    tabId: string,
    insertAfterTabId?: string
  ): void
  onMenuVisibilityChange?(visible: boolean): void
}

const TAB_ICONS: Record<string, IconComponent> = {
  review: GitPullRequestIcon,
  file: FileCode2Icon,
  terminal: TerminalIcon,
  browser: GlobeIcon
}

const NEW_TAB_OPTIONS: readonly {
  target: WorkspaceOpenTarget
  label: string
  icon: IconComponent
  shortcut?: string
}[] = [
  { target: { type: 'review' }, label: 'Review', icon: GitPullRequestIcon, shortcut: '⌘ R' },
  { target: { type: 'terminal' }, label: 'Terminal', icon: TerminalIcon, shortcut: '⌘ T' },
  { target: { type: 'browser' }, label: 'Browser', icon: GlobeIcon, shortcut: '⌘ B' },
  { target: { type: 'file', relativePath: '' }, label: 'Files', icon: FilesIcon }
]

export function WorkspaceTabStrip(props: WorkspaceTabStripProps): React.JSX.Element {
  const sharedDrag = useOptionalWorkspaceTabDrag()
  if (sharedDrag) return <WorkspaceTabStripContent {...props} />
  return (
    <WorkspaceTabDragProvider>
      <WorkspaceTabStripContent {...props} />
    </WorkspaceTabDragProvider>
  )
}

function WorkspaceTabStripContent({
  panelId,
  tabs,
  activeTabId,
  className,
  onActivate,
  onClose,
  onCloseOther,
  onCloseToRight,
  onPin,
  onOpen,
  onMove,
  onMenuVisibilityChange
}: WorkspaceTabStripProps): React.JSX.Element {
  const drag = useWorkspaceTabDrag()
  const tabButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const suppressClickForTabId = useRef<string | undefined>(undefined)
  const { activeDrag } = drag
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const panelTabIds = tabs.map((tab) => tab.id)
  const displayedTabs = workspaceTabPreviewTabs(panelId, tabs, activeDrag)
  const displayedTabIds = displayedTabs.map((tab) => tab.id)
  const stripDndData: WorkspaceTabStripDndData = {
    kind: 'workspace-tab-strip',
    panelId,
    panelTabIds
  }
  const { setNodeRef: setStripNodeRef } = useDroppable({
    id: `workspace-tab-strip:${panelId}`,
    data: stripDndData,
    disabled: !onMove
  })

  useEffect(() => {
    const activeButton = activeTabId ? tabButtonRefs.current.get(activeTabId) : undefined
    activeButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  function focusTabAt(index: number): void {
    if (!tabs.length) return
    const target = tabs[(index + tabs.length) % tabs.length]
    onActivate(target.id)
    requestAnimationFrame(() => tabButtonRefs.current.get(target.id)?.focus())
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const targetIndex = keyTargetIndex(event.key, index, tabs.length)
    if (targetIndex === undefined) return
    event.preventDefault()
    focusTabAt(targetIndex)
  }

  function setTabButtonRef(tabId: string, element: HTMLButtonElement | null): void {
    if (element) tabButtonRefs.current.set(tabId, element)
    else tabButtonRefs.current.delete(tabId)
  }

  function shouldSuppressTabClick(tabId: string): boolean {
    if (suppressClickForTabId.current !== tabId) return false
    suppressClickForTabId.current = undefined
    return true
  }

  return (
    <div className={cn('flex h-14 min-h-14 items-center gap-2 px-2', className)}>
      <div
        ref={setStripNodeRef}
        role="tablist"
        data-workspace-tab-strip="true"
        data-workspace-panel-id={panelId}
        aria-label={panelId === 'right' ? 'Workspace tabs' : 'Bottom workspace tabs'}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        <SortableContext items={displayedTabIds} strategy={horizontalListSortingStrategy}>
          {displayedTabs.map((tab, index) => (
            <WorkspaceTabButton
              key={tab.id}
              panelId={panelId}
              panelTabIds={panelTabIds}
              active={activeTab?.id === tab.id}
              tab={tab}
              dragActive={Boolean(activeDrag)}
              hasTabsToRight={index < displayedTabs.length - 1}
              hasOtherTabs={displayedTabs.length > 1}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onClose(tab.id)}
              onCloseOther={onCloseOther ? () => onCloseOther(tab.id) : undefined}
              onCloseToRight={onCloseToRight ? () => onCloseToRight(tab.id) : undefined}
              onPin={tab.isPreview && onPin ? () => onPin(tab.id) : undefined}
              onMove={onMove}
              onDragComplete={(tabId) => {
                suppressClickForTabId.current = tabId
              }}
              shouldSuppressClick={() => shouldSuppressTabClick(tab.id)}
              buttonRef={(element) => setTabButtonRef(tab.id, element)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            />
          ))}
        </SortableContext>
        <NewTabMenu
          hasReviewTab={tabs.some((tab) => tab.kind === 'review')}
          onSelect={onOpen}
          onVisibilityChange={onMenuVisibilityChange}
        />
      </div>
    </div>
  )
}

function WorkspaceTabDragOverlay({ tab }: { tab: WorkspaceTabRecord }): React.JSX.Element {
  const Icon = TAB_ICONS[tab.kind] ?? FileCode2Icon

  return (
    <div
      aria-hidden="true"
      data-workspace-drag-overlay="true"
      className="flex size-full items-center rounded-md bg-muted px-1 text-sm shadow-lg ring-1 ring-border/70"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className={cn('min-w-0 flex-1 truncate', tab.isPreview && 'italic')}>
          {tab.title}
        </span>
      </div>
      {tab.isClosable ? (
        <span className="flex size-7 shrink-0 items-center justify-center opacity-100">
          <XIcon className="size-3.5" />
        </span>
      ) : null}
    </div>
  )
}

function WorkspaceTabButton({
  panelId,
  panelTabIds,
  active,
  tab,
  dragActive,
  hasTabsToRight,
  hasOtherTabs,
  onActivate,
  onClose,
  onCloseOther,
  onCloseToRight,
  onPin,
  onMove,
  onDragComplete,
  shouldSuppressClick,
  buttonRef,
  onKeyDown
}: {
  panelId: WorkspacePanelId
  panelTabIds: readonly string[]
  active: boolean
  tab: WorkspaceTabRecord
  dragActive: boolean
  hasTabsToRight: boolean
  hasOtherTabs: boolean
  onActivate(): void
  onClose(): void
  onCloseOther?(): void
  onCloseToRight?(): void
  onPin?(): void
  onMove?: WorkspaceTabStripProps['onMove']
  onDragComplete(tabId: string): void
  shouldSuppressClick(): boolean
  buttonRef: RefCallback<HTMLButtonElement>
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void
}): React.JSX.Element {
  const Icon = TAB_ICONS[tab.kind] ?? FileCode2Icon
  const { hasOverflow, titleRef } = useTabTitleOverflow(tab.title)
  let dndData: WorkspaceTabDndData | undefined
  if (onMove) {
    dndData = {
      kind: 'workspace-tab',
      panelId,
      panelTabIds,
      tab,
      overlay: <WorkspaceTabDragOverlay tab={tab} />,
      onMove,
      onDragComplete
    }
  }
  const {
    active: activeDndItem,
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition
  } = useSortable({
    id: tab.id,
    data: dndData,
    disabled: !onMove,
    strategy: horizontalListSortingStrategy,
    transition: { duration: 200, easing: 'ease' }
  })

  async function openNativeContextMenu(): Promise<void> {
    const items = [
      ...(onPin ? [{ type: 'action' as const, id: 'keep-open', label: '保持打开' }] : []),
      ...(tab.isClosable ? [{ type: 'action' as const, id: 'close', label: '关闭' }] : []),
      ...(hasOtherTabs && onCloseOther
        ? [{ type: 'action' as const, id: 'close-others', label: '关闭其他标签页' }]
        : []),
      ...(hasTabsToRight && onCloseToRight
        ? [{ type: 'action' as const, id: 'close-to-right', label: '关闭右侧标签页' }]
        : [])
    ]
    if (items.length === 0) return
    const action = await window.desktopApp.nativeContextMenu.show(items)
    switch (action) {
      case 'keep-open':
        onPin?.()
        return
      case 'close':
        onClose()
        return
      case 'close-others':
        onCloseOther?.()
        return
      case 'close-to-right':
        onCloseToRight?.()
    }
  }

  return (
    <div
      ref={setNodeRef}
      data-workspace-tab="true"
      data-workspace-tab-container="true"
      data-workspace-panel-id={panelId}
      data-workspace-tab-id={tab.id}
      data-active={active}
      data-preview={tab.isPreview}
      className={cn(
        'group flex min-w-[90px] max-w-40 shrink-0 items-center rounded-md px-1 transition-colors motion-reduce:transition-none',
        active ? 'bg-muted' : 'hover:bg-muted/70',
        dragActive ? 'cursor-grabbing' : onMove && 'cursor-grab',
        isDragging && 'z-10 opacity-0'
      )}
      style={{
        transform: transform
          ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
          : undefined,
        transition
      }}
      onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
        event.preventDefault()
        void openNativeContextMenu().catch(() => undefined)
      }}
    >
      <Button
        {...attributes}
        {...listeners}
        type="button"
        variant="ghost"
        size="xs"
        role="tab"
        id={`${panelId === 'right' ? 'right-workspace' : 'bottom-workspace'}-tab-${tab.id}`}
        data-workspace-tab="true"
        data-workspace-panel-id={panelId}
        data-workspace-tab-id={tab.id}
        aria-controls={`${panelId === 'right' ? 'right-workspace' : 'bottom-workspace'}-tab-panel`}
        aria-selected={active}
        aria-label={tab.title}
        aria-description={tab.isPreview ? 'Preview tab' : undefined}
        tabIndex={active ? 0 : -1}
        ref={(element) => {
          buttonRef(element)
          setActivatorNodeRef(element)
        }}
        className="min-w-0 flex-1 shrink touch-none justify-start gap-2 rounded-lg px-2 text-left text-sm font-normal hover:bg-transparent"
        onClick={(event) => {
          if (shouldSuppressClick()) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          onActivate()
        }}
        onAuxClick={(event) => {
          if (event.button === 1 && tab.isClosable) onClose()
        }}
        onDoubleClick={() => {
          if (!activeDndItem) onPin?.()
        }}
        onKeyDown={onKeyDown}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="relative min-w-0 flex-1 overflow-hidden">
          <span
            ref={titleRef}
            data-slot="right-workspace-tab-title"
            className={cn(
              'block w-full min-w-0 whitespace-nowrap text-start',
              tab.isPreview && 'italic'
            )}
          >
            {tab.title}
          </span>
          {hasOverflow ? (
            <span
              aria-hidden="true"
              data-slot="right-workspace-tab-title-fade"
              className={cn(
                'pointer-events-none absolute inset-y-0 right-0 z-10 w-7 bg-linear-to-r from-transparent to-[85%]',
                active ? 'to-muted' : 'to-background group-hover:to-muted/70'
              )}
            />
          ) : null}
        </span>
      </Button>
      {tab.isClosable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7 shrink-0 opacity-60 transition-opacity group-hover:opacity-100 data-[active=true]:opacity-100"
          data-active={active}
          aria-label={`关闭${tab.title}标签页`}
          onAuxClick={(event) => {
            if (event.button === 1) onClose()
          }}
          onClick={onClose}
        >
          <XIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}

function workspaceTabPreviewTabs(
  panelId: WorkspacePanelId,
  tabs: readonly WorkspaceTabRecord[],
  drag: ActiveWorkspaceTabDrag | undefined
): readonly WorkspaceTabRecord[] {
  if (!drag) return tabs
  if (drag.sourcePanelId !== drag.destinationPanelId && panelId === drag.sourcePanelId) {
    return tabs.filter((tab) => tab.id !== drag.tab.id)
  }
  if (panelId !== drag.destinationPanelId) return tabs

  const previewTabIds = workspaceTabPreviewIds(
    tabs.map((tab) => tab.id),
    drag.tab.id,
    drag.overTabId,
    drag.insertionPlacement
  )
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
  tabsById.set(drag.tab.id, drag.tab)
  return previewTabIds
    .map((tabId) => tabsById.get(tabId))
    .filter((tab): tab is WorkspaceTabRecord => Boolean(tab))
}

function NewTabMenu({
  hasReviewTab,
  onSelect,
  onVisibilityChange
}: {
  hasReviewTab: boolean
  onSelect(target: WorkspaceOpenTarget): void
  onVisibilityChange?(visible: boolean): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const firstMenuItemRef = useRef<HTMLButtonElement>(null)
  const menuContentRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement>(null)
  const availableOptions = NEW_TAB_OPTIONS.filter(
    (option) => option.target.type !== 'review' || !hasReviewTab
  )

  useEffect(() => onVisibilityChange?.(open), [open, onVisibilityChange])
  useEffect(() => () => onVisibilityChange?.(false), [onVisibilityChange])
  useEffect(() => {
    if (!open) return

    const closeOnExternalPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        !(target instanceof Node) ||
        menuContentRef.current?.contains(target) ||
        menuTriggerRef.current?.contains(target)
      ) {
        return
      }
      setOpen(false)
    }

    document.addEventListener('pointerdown', closeOnExternalPointerDown)
    return () => document.removeEventListener('pointerdown', closeOnExternalPointerDown)
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          ref={menuTriggerRef}
          className="size-7 shrink-0 rounded-md"
          aria-label="Open workspace tab"
          aria-haspopup="menu"
        >
          <PlusIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={menuContentRef}
        role="menu"
        aria-label="New workspace tab"
        align="start"
        side="bottom"
        sideOffset={8}
        collisionPadding={12}
        className="w-75 rounded-xl border-border bg-popover/95 p-2 text-popover-foreground shadow-lg backdrop-blur-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          firstMenuItemRef.current?.focus()
        }}
      >
        {availableOptions.map((option, index) => {
          const Icon = option.icon
          return (
            <button
              key={option.label}
              ref={index === 0 ? firstMenuItemRef : undefined}
              type="button"
              role="menuitem"
              className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm hover:bg-muted focus:bg-muted focus:outline-none"
              onClick={() => {
                onSelect(option.target)
                setOpen(false)
              }}
            >
              <Icon className="size-4 text-muted-foreground" />
              <span className="flex-1 text-left">{option.label}</span>
              {option.shortcut ? (
                <kbd className="text-xs text-muted-foreground">{option.shortcut}</kbd>
              ) : null}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

function useTabTitleOverflow(title: string): {
  titleRef: React.RefObject<HTMLSpanElement | null>
  hasOverflow: boolean
} {
  const titleRef = useRef<HTMLSpanElement>(null)
  const [hasOverflow, setHasOverflow] = useState(false)
  useLayoutEffect(() => {
    const element = titleRef.current
    if (!element) return
    const update = (): void => setHasOverflow(element.scrollWidth > element.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [title])
  return { titleRef, hasOverflow }
}

function keyTargetIndex(key: string, index: number, count: number): number | undefined {
  if (!count) return undefined
  switch (key) {
    case 'ArrowLeft':
      return index - 1
    case 'ArrowRight':
      return index + 1
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}
