import * as React from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type PluginCapabilityDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  icon: React.ReactNode
  title: string
  typeLabel?: string
  description?: string
  status?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  dataSlot: string
}

export function PluginCapabilityDialog({
  open,
  onOpenChange,
  icon,
  title,
  typeLabel,
  description,
  status,
  actions,
  children,
  footer,
  dataSlot
}: PluginCapabilityDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot={dataSlot}
        className="flex max-h-[min(720px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5 pe-14">
          <div className="flex min-w-0 items-start gap-3">
            <div className="shrink-0">{icon}</div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-lg leading-6">{title}</DialogTitle>
                {typeLabel && <CapabilityPill>{typeLabel}</CapabilityPill>}
                {status}
              </div>
              <DialogDescription className="line-clamp-2 leading-5">
                {description ?? '未提供简短说明。'}
              </DialogDescription>
            </div>
            {actions && <div className="shrink-0 pt-0.5">{actions}</div>}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer && (
          <DialogFooter className="shrink-0 border-t px-6 py-4 sm:items-center sm:justify-between">
            {footer}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function CapabilityPill({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full border bg-muted/40 px-2 text-xs text-muted-foreground',
        className
      )}
    >
      {children}
    </span>
  )
}
