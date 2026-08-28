import { CommandIcon, PlusIcon, PuzzleIcon } from 'lucide-react'

import { Button } from '../components/ui/button'
import { cn } from '../lib/utils'

export function SidebarPrimaryActions({
  nativeBackdrop,
  onNewChat,
  onOpenCommandPalette,
  onOpenPlugins,
  pluginsActive = false
}: {
  nativeBackdrop: boolean
  onNewChat: () => void
  onOpenCommandPalette?: () => void
  onOpenPlugins?: () => void
  pluginsActive?: boolean
}): React.JSX.Element {
  const hoverClass = nativeBackdrop
    ? 'hover:bg-background/40 dark:hover:bg-foreground/8'
    : 'hover:bg-muted'
  return (
    <div className="min-w-0 shrink-0 space-y-1 px-2">
      <Button
        aria-label="新对话"
        className={cn('w-full min-w-0 justify-start gap-2 font-normal text-foreground', hoverClass)}
        size="sm"
        title="新对话"
        type="button"
        variant="ghost"
        onClick={onNewChat}
      >
        <PlusIcon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">新对话</span>
      </Button>
      {onOpenCommandPalette ? (
        <Button
          aria-label="命令面板"
          className={cn(
            'w-full min-w-0 justify-start gap-2 font-normal text-foreground',
            hoverClass
          )}
          size="sm"
          title="命令面板（⌘K）"
          type="button"
          variant="ghost"
          onClick={onOpenCommandPalette}
        >
          <CommandIcon className="size-4 shrink-0" />
          <span className="min-w-0 truncate">命令面板</span>
        </Button>
      ) : null}
      {onOpenPlugins && (
        <Button
          aria-current={pluginsActive ? 'page' : undefined}
          aria-label="插件"
          className={cn(
            'w-full min-w-0 justify-start gap-2 font-normal text-foreground',
            pluginsActive ? 'bg-muted' : hoverClass
          )}
          size="sm"
          title="插件"
          type="button"
          variant="ghost"
          onClick={onOpenPlugins}
        >
          <PuzzleIcon className="size-4 shrink-0" />
          <span className="min-w-0 truncate">插件</span>
        </Button>
      )}
    </div>
  )
}
