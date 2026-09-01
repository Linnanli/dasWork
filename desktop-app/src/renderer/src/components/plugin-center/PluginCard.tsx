import * as React from 'react'

import { cn } from '@/lib/utils'

export type PluginCardProps = {
  title: string
  description: string
  icon: React.ReactNode
  actions?: React.ReactNode
  children?: React.ReactNode
  onClick?: () => void
  ariaLabel?: string
  dataSlot?: string
  className?: string
}

/**
 * Shared compact card layout for plugin-center catalog items.
 *
 * The content can be interactive (for plugin details) or static (for items
 * such as skills that expose their own inline controls).
 */
export function PluginCard({
  title,
  description,
  icon,
  actions,
  children,
  onClick,
  ariaLabel,
  dataSlot = 'plugin-card',
  className
}: PluginCardProps): React.JSX.Element {
  const content = (
    <>
      <span className="shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-medium text-foreground">{title}</h3>
        <p className="truncate text-[12px] leading-relaxed font-normal text-muted-foreground">
          {description}
        </p>
        {children}
      </div>
    </>
  )

  return (
    <article
      data-slot={dataSlot}
      className={cn(
        'group flex rounded-2xl p-2 transition-colors hover:bg-foreground/5',
        className
      )}
    >
      {onClick ? (
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={ariaLabel}
          onClick={onClick}
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-3">{content}</div>
      )}
      {actions && <div className="ml-3 flex shrink-0 items-center">{actions}</div>}
    </article>
  )
}
