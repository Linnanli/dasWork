import * as React from 'react'

import { cn } from '@/lib/utils'

export function PluginImage({
  icon,
  title,
  fallback,
  className
}: {
  icon?: { kind: string; value: string }
  title: string
  fallback: React.ReactNode
  className?: string
}): React.JSX.Element {
  const iconKey = icon ? `${icon.kind}:${icon.value}` : 'fallback'
  return (
    <PluginImageContent
      key={iconKey}
      icon={icon}
      title={title}
      fallback={fallback}
      className={className}
    />
  )
}

function PluginImageContent({
  icon,
  title,
  fallback,
  className
}: {
  icon?: { kind: string; value: string }
  title: string
  fallback: React.ReactNode
  className?: string
}): React.JSX.Element {
  const [failed, setFailed] = React.useState(false)

  if (!failed && isAllowedPluginImageSource(icon)) {
    return (
      <img
        src={icon.value}
        alt=""
        className={cn('size-9 rounded-md border bg-muted object-cover', className)}
        draggable={false}
        onError={() => setFailed(true)}
      />
    )
  }
  if (icon?.kind === 'initials') {
    return (
      <div
        className={cn(
          'flex size-9 items-center justify-center rounded-md border bg-muted text-xs',
          className
        )}
      >
        {icon.value}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground',
        className
      )}
    >
      {fallback}
      <span className="sr-only">{title}</span>
    </div>
  )
}

function isAllowedPluginImageSource(
  icon: { kind: string; value: string } | undefined
): icon is { kind: 'url' | 'data'; value: string } {
  if (icon?.kind !== 'url' && icon?.kind !== 'data') return false
  try {
    const url = new URL(icon.value, window.location.href)
    return (
      url.protocol === 'app:' ||
      url.protocol === 'blob:' ||
      url.protocol === 'data:' ||
      url.protocol === 'https:' ||
      url.origin === window.location.origin
    )
  } catch {
    return false
  }
}
