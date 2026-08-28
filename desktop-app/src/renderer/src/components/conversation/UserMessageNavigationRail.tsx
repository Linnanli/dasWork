import { MessageSquareIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const userMessageSelector = '[data-role="user"]'
const minimumMessageCount = 3

type UserMessageTarget = {
  id: string
  element: HTMLElement
  label: string
}

export type UserMessageNavigationItem = {
  id: string
  label: string
}

export function UserMessageNavigationRail({
  viewportRef,
  items,
  onRevealItem
}: {
  viewportRef: RefObject<HTMLDivElement | null>
  items?: readonly UserMessageNavigationItem[]
  onRevealItem?: (id: string) => void
}): React.JSX.Element | null {
  const [targets, setTargets] = useState<readonly UserMessageTarget[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const pendingItemIdRef = useRef<string | undefined>(undefined)

  const refreshTargets = useCallback((): void => {
    const nextTargets = [
      ...(viewportRef.current?.querySelectorAll<HTMLElement>(userMessageSelector) ?? [])
    ]
      .map((element, index) => ({
        id: element.dataset.messageId ?? `dom:${index}`,
        element,
        label: messageLabel(element)
      }))
      .filter((target) => target.label.length > 0)
    setTargets((current) => (sameTargets(current, nextTargets) ? current : nextTargets))
  }, [viewportRef])

  useEffect(() => {
    refreshTargets()
    const viewport = viewportRef.current
    if (!viewport || typeof MutationObserver === 'undefined') return
    const observer = new MutationObserver(refreshTargets)
    observer.observe(viewport, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [refreshTargets, viewportRef])

  const navigationItems = items ?? targets.map(({ id, label }) => ({ id, label }))

  useEffect(() => {
    if (targets.length === 0) return
    const viewport = viewportRef.current
    if (!viewport || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const activeTarget = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]?.target
        const activeTargetId = targets.find((target) => target.element === activeTarget)?.id
        const nextIndex = navigationItems.findIndex((item) => item.id === activeTargetId)
        if (nextIndex >= 0) setActiveIndex(nextIndex)
      },
      { root: viewport, threshold: [0.25, 0.6] }
    )
    for (const target of targets) observer.observe(target.element)
    return () => observer.disconnect()
  }, [navigationItems, targets, viewportRef])

  useEffect(() => {
    const pendingItemId = pendingItemIdRef.current
    if (!pendingItemId) return
    const target = targets.find((candidate) => candidate.id === pendingItemId)
    if (!target) return
    target.element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    pendingItemIdRef.current = undefined
  }, [targets])

  if (navigationItems.length < minimumMessageCount) return null
  const visibleActiveIndex = Math.min(activeIndex, navigationItems.length - 1)

  return (
    <nav
      aria-label="用户消息导航"
      className="absolute top-14 z-20 hidden max-h-[calc(100%-7rem)] w-8 flex-col items-center gap-1 overflow-y-auto rounded-md border bg-popover/95 p-1 shadow-sm backdrop-blur lg:flex"
      data-slot="user-message-navigation-rail"
      style={{ right: 'calc((100% - 48rem) / 2 - 2.75rem)' }}
    >
      <MessageSquareIcon aria-hidden className="my-0.5 size-3.5 shrink-0 text-muted-foreground" />
      {navigationItems.map((item, index) => (
        <Button
          key={item.id}
          aria-current={visibleActiveIndex === index ? 'true' : undefined}
          aria-label={`跳转到消息 ${index + 1}：${item.label}`}
          className={cn(
            'size-5 shrink-0 rounded-full p-0 text-[9px] tabular-nums',
            visibleActiveIndex === index && 'bg-primary text-primary-foreground hover:bg-primary/90'
          )}
          size="icon-xs"
          title={item.label}
          type="button"
          variant={visibleActiveIndex === index ? 'default' : 'ghost'}
          onClick={() => {
            setActiveIndex(index)
            const target = targets.find((candidate) => candidate.id === item.id)
            if (target) {
              target.element.scrollIntoView({ block: 'center', behavior: 'smooth' })
              return
            }
            pendingItemIdRef.current = item.id
            onRevealItem?.(item.id)
          }}
        >
          {index + 1}
        </Button>
      ))}
    </nav>
  )
}

function messageLabel(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 80)
}

function sameTargets(
  left: readonly UserMessageTarget[],
  right: readonly UserMessageTarget[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.id === right[index]?.id &&
        target.element === right[index]?.element &&
        target.label === right[index]?.label
    )
  )
}
