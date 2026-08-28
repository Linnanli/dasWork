import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const messageSelector = '[data-role="user"], [data-role="assistant"]'
const activeMatchClassNames = ['ring-1', 'ring-primary/70', 'rounded-lg']

function formatResultLabel(matchCount: number, currentIndex: number, query: string): string {
  if (matchCount) return `${currentIndex + 1}/${matchCount}`
  if (query.trim()) return '无匹配'
  return '查找'
}

function canHandleConversationFindShortcut(activeElement: Element | null): boolean {
  return !(
    activeElement instanceof Element &&
    activeElement.closest(
      'input, textarea, [contenteditable="true"], [data-slot="right-workspace"]'
    )
  )
}

export function ConversationFindBar({
  viewportRef,
  onOpen
}: {
  viewportRef: RefObject<HTMLDivElement | null>
  onOpen?: () => void
}): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement>(null)
  const matchesRef = useRef<HTMLElement[]>([])
  const activeMatchRef = useRef<HTMLElement | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [matchCount, setMatchCount] = useState(0)

  const clearActiveMatch = useCallback((): void => {
    activeMatchRef.current?.classList.remove(...activeMatchClassNames)
    activeMatchRef.current = undefined
  }, [])

  const focusMatch = useCallback(
    (index: number): void => {
      const match = matchesRef.current[index]
      clearActiveMatch()
      if (!match) return
      match.classList.add(...activeMatchClassNames)
      match.scrollIntoView({ block: 'center', behavior: 'smooth' })
      activeMatchRef.current = match
      setCurrentIndex(index)
    },
    [clearActiveMatch]
  )

  const updateMatches = useCallback(
    (nextQuery: string): void => {
      const normalizedQuery = nextQuery.trim().toLocaleLowerCase()
      clearActiveMatch()
      if (!normalizedQuery) {
        matchesRef.current = []
        setMatchCount(0)
        setCurrentIndex(-1)
        return
      }
      const matches = [
        ...(viewportRef.current?.querySelectorAll<HTMLElement>(messageSelector) ?? [])
      ].filter((message) => message.textContent?.toLocaleLowerCase().includes(normalizedQuery))
      matchesRef.current = matches
      setMatchCount(matches.length)
      if (!matches.length) {
        setCurrentIndex(-1)
        return
      }
      focusMatch(0)
    },
    [clearActiveMatch, focusMatch, viewportRef]
  )

  const close = useCallback((): void => {
    clearActiveMatch()
    matchesRef.current = []
    setOpen(false)
    setQuery('')
    setMatchCount(0)
    setCurrentIndex(-1)
  }, [clearActiveMatch])

  const openFindBar = useCallback((): void => {
    if (!canHandleConversationFindShortcut(document.activeElement)) return
    onOpen?.()
    setOpen(true)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [onOpen])

  const moveMatch = useCallback(
    (direction: -1 | 1): void => {
      if (!matchesRef.current.length) return
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + direction + matchesRef.current.length) % matchesRef.current.length
      focusMatch(nextIndex)
    },
    [currentIndex, focusMatch]
  )

  useEffect(() => {
    window.addEventListener('dascowork:conversation-find', openFindBar)
    return () => window.removeEventListener('dascowork:conversation-find', openFindBar)
  }, [openFindBar])

  useEffect(() => {
    return window.desktopApp?.codex.onConversationFindRequested?.(openFindBar)
  }, [openFindBar])

  useEffect(() => clearActiveMatch, [clearActiveMatch])

  if (!open) return null

  const resultLabel = formatResultLabel(matchCount, currentIndex, query)
  return (
    <div
      data-slot="conversation-find-bar"
      role="search"
      aria-label="在当前对话中查找"
      className="absolute top-2 right-3 z-20 flex max-w-[min(32rem,calc(100%-1.5rem))] items-center gap-1 rounded-md border bg-popover p-1 shadow-sm"
    >
      <SearchIcon aria-hidden className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        autoFocus
        aria-label="在当前对话中查找"
        className="h-7 w-52 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
        value={query}
        onChange={(event) => {
          const nextQuery = event.currentTarget.value
          setQuery(nextQuery)
          updateMatches(nextQuery)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
          if (event.key === 'Enter') moveMatch(event.shiftKey ? -1 : 1)
        }}
      />
      <span
        className="min-w-12 text-center text-[11px] tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {resultLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="上一个对话匹配"
        disabled={matchCount === 0}
        onClick={() => moveMatch(-1)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="下一个对话匹配"
        disabled={matchCount === 0}
        onClick={() => moveMatch(1)}
      >
        <ChevronDownIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="关闭对话查找"
        onClick={close}
      >
        <XIcon />
      </Button>
    </div>
  )
}
