import { BotIcon, Clock3Icon, MessageSquareIcon, WrenchIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

import type { WorkspaceTimelineEvent } from './taskWorkspaceTypes'

export function TimelineWorkspace({
  events
}: {
  events: readonly WorkspaceTimelineEvent[]
}): React.JSX.Element {
  return (
    <section data-slot="workspace-timeline" className="h-full overflow-y-auto p-4">
      <header className="flex items-center gap-2 text-sm font-medium">
        <Clock3Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2>时间线</h2>
      </header>
      {events.length ? (
        <ol className="mt-4 space-y-3">
          {events.map((event) => {
            const Icon = eventIcon(event.type)
            return (
              <li
                key={event.id}
                data-slot="workspace-timeline-event"
                data-event-type={event.type}
                className="relative flex gap-3 before:absolute before:top-7 before:bottom-[-16px] before:left-3 before:w-px before:bg-border last:before:hidden"
              >
                <span
                  className={cn(
                    'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background',
                    event.type === 'user' && 'text-blue-600 dark:text-blue-400',
                    event.type === 'assistant' && 'text-foreground',
                    event.type === 'activity' && 'text-muted-foreground',
                    event.type === 'subagent' && 'text-violet-600 dark:text-violet-400'
                  )}
                >
                  <Icon aria-hidden className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1 pt-0.5 pb-1">
                  <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
                    {event.label}
                  </p>
                  {event.status ? (
                    <p className="mt-1 text-xs text-muted-foreground">{event.status}</p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">这个任务还没有可显示的记录。</p>
      )}
    </section>
  )
}

function eventIcon(type: WorkspaceTimelineEvent['type']): typeof MessageSquareIcon {
  if (type === 'user') return MessageSquareIcon
  if (type === 'assistant' || type === 'subagent') return BotIcon
  return WrenchIcon
}
