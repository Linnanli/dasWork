import { useEffect, useMemo, useRef } from 'react'

import { ReviewFileBlock } from './ReviewFileBlock'
import type { ReviewFileGroup, ReviewWorkspaceController } from './reviewWorkspaceTypes'
import { useReviewDiffWindow } from './useReviewDiffWindow'

type Props = {
  controller: ReviewWorkspaceController
}

const scrollSettleDelayMs = 180

export function ReviewDiffStack({ controller }: Props): React.JSX.Element {
  const { loadState } = controller
  if (!('groups' in loadState) && loadState.status !== 'error') {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        Loading review...
      </div>
    )
  }
  if (!('groups' in loadState)) {
    return (
      <div
        role="alert"
        className="m-3 rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"
      >
        {loadState.message}
      </div>
    )
  }
  return (
    <ReadyReviewDiffStack
      controller={controller}
      groups={loadState.groups}
      largeDiff={loadState.largeDiff}
    />
  )
}

function ReadyReviewDiffStack({
  controller,
  groups,
  largeDiff
}: {
  controller: ReviewWorkspaceController
  groups: readonly ReviewFileGroup[]
  largeDiff: boolean
}): React.JSX.Element {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef(controller)
  const groupsByPathRef = useRef(new Map(groups.map((group) => [group.path, group])))

  useEffect(() => {
    controllerRef.current = controller
    groupsByPathRef.current = new Map(groups.map((group) => [group.path, group]))
  }, [controller, groups])

  const selectedPath = controller.selectedPath ?? groups[0]?.path
  const initialGroups = useMemo(
    () =>
      largeDiff
        ? groups.filter((group) => group.path === selectedPath)
        : [
            ...groups.filter((group) => group.path === selectedPath),
            ...groups.filter((group) => group.path !== selectedPath).slice(0, 3)
          ],
    [groups, largeDiff, selectedPath]
  )
  const { bottomSpacer, onItemHeight, renderedItems, topSpacer, totalHeight } = useReviewDiffWindow(
    {
      groups,
      scrollContainerRef,
      selectedPath
    }
  )

  useEffect(() => {
    initialGroups.forEach((group) => {
      group.sections.forEach((section) => {
        if (section.kind !== 'partial-error' && section.loadState.status === 'idle') {
          controllerRef.current.loadSectionDiff(section.key)
        }
      })
    })
  }, [initialGroups])

  const renderedPaths = useMemo(
    () => renderedItems.map((item) => item.group.path).join('\u0000'),
    [renderedItems]
  )
  useEffect(() => {
    const root = scrollContainerRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    let loadTimer: number | undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
        if (visible.length > 0) {
          if (loadTimer) window.clearTimeout(loadTimer)
          const visiblePaths = visible
            .map((entry) => entry.target.getAttribute('data-review-path'))
            .filter((path): path is string => path !== null)
          // Do not start work for every item that a fast scroll only crosses for one frame.
          // The selected item and nearby entries are loaded eagerly above; this batch covers
          // the viewport after scrolling has settled.
          loadTimer = window.setTimeout(() => {
            new Set(visiblePaths).forEach((path) => {
              const group = groupsByPathRef.current.get(path)
              group?.sections.forEach((section) => {
                if (section.kind !== 'partial-error' && section.loadState.status === 'idle') {
                  controllerRef.current.loadSectionDiff(section.key)
                }
              })
            })
          }, scrollSettleDelayMs)
        }
        const nearest = visible.find(
          (entry) => entry.boundingClientRect.bottom > root.getBoundingClientRect().top
        )
        const path = nearest?.target.getAttribute('data-review-path')
        if (path) controllerRef.current.setActivePath(path)
      },
      { root, rootMargin: '-8px 0px -70% 0px', threshold: [0, 0.01, 1] }
    )
    root
      .querySelectorAll<HTMLElement>('[data-review-path]')
      .forEach((element) => observer.observe(element))
    return () => {
      observer.disconnect()
      if (loadTimer) window.clearTimeout(loadTimer)
    }
  }, [renderedPaths])

  if (groups.length === 0) {
    return (
      <div
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground"
      >
        No changes to review.
      </div>
    )
  }

  return (
    <div
      ref={scrollContainerRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto [overflow-anchor:none]"
      data-review-diff-scroll-height={Math.ceil(totalHeight)}
    >
      <div className="flex flex-col">
        {topSpacer > 0 ? <div aria-hidden style={{ height: topSpacer }} /> : null}
        {renderedItems.map((item) => (
          <MeasuredReviewFileBlock
            key={item.group.path}
            controller={controller}
            group={item.group}
            onHeight={onItemHeight}
          />
        ))}
        {bottomSpacer > 0 ? <div aria-hidden style={{ height: bottomSpacer }} /> : null}
      </div>
    </div>
  )
}

function MeasuredReviewFileBlock({
  controller,
  group,
  onHeight
}: {
  controller: ReviewWorkspaceController
  group: ReviewFileGroup
  onHeight(path: string, height: number): void
}): React.JSX.Element {
  const elementRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    const reportHeight = (): void => onHeight(group.path, element.getBoundingClientRect().height)
    reportHeight()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reportHeight)
    observer.observe(element)
    return () => observer.disconnect()
  }, [group.path, onHeight])

  return (
    <div ref={elementRef} data-review-window-item={group.path} className="pb-3">
      <ReviewFileBlock controller={controller} group={group} />
    </div>
  )
}
