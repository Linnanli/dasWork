import * as React from 'react'
import { ChevronDownIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react'

import type {
  PluginCenterGetAppToolsResult,
  PluginCenterPluginDetail
} from '../../../../shared/pluginCenterApi'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { PluginImage } from './PluginImage'
import type { PluginCenterResourceSnapshot } from './pluginCenterDataResource'

type PluginDetailApp = PluginCenterPluginDetail['apps'][number]
type AppTool = Extract<PluginCenterGetAppToolsResult, { status: 'ready' }>['tools'][number]

export function PluginAppToolsDialog({
  app,
  open,
  state,
  pending,
  onOpenChange,
  onToggle,
  onTryApp,
  onRetry
}: {
  app: PluginDetailApp
  open: boolean
  state: PluginCenterResourceSnapshot<PluginCenterGetAppToolsResult>
  pending: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (enabled: boolean) => void
  onTryApp: () => void
  onRetry: () => void
}): React.JSX.Element {
  const result = state.data
  const isLoading = state.status === 'idle' || state.status === 'loading'
  const canTry = app.accessible && app.enabled && !pending
  const toolCount = result?.status === 'ready' ? result.tools.length : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(720px,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex min-w-0 items-center gap-3 pe-6">
            <PluginImage
              icon={app.icon}
              title={app.name}
              fallback={<span className="text-sm">{app.name.slice(0, 1)}</span>}
              className="size-10 shrink-0 rounded-lg border bg-transparent object-contain"
            />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">{app.name}</DialogTitle>
              <DialogDescription className="mt-1">
                {app.description ?? '此应用未提供简短说明。'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <section className="flex items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium">启用应用</div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {app.restriction?.message ?? '启用后，此应用的工具可以在对话中使用。'}
            </p>
          </div>
          <Switch
            checked={app.enabled}
            disabled={pending || !app.canToggle}
            aria-label={`${app.name} ${app.enabled ? '停用' : '启用'}`}
            title={app.restriction?.message}
            onCheckedChange={onToggle}
          />
        </section>

        <section aria-label="应用工具" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">工具 {toolCount}</h3>
            {state.isRefreshing && (
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            )}
          </div>
          {isLoading && <ToolsLoading />}
          {!isLoading && state.error && <ToolsError message={state.error} onRetry={onRetry} />}
          {!isLoading && !state.error && result?.status === 'missing' && (
            <ToolsEmpty message="此应用当前不可用，暂时无法读取工具说明。" />
          )}
          {!isLoading &&
            !state.error &&
            result?.status === 'ready' &&
            result.tools.length === 0 && <ToolsEmpty message="此应用未提供可展示的工具。" />}
          {!isLoading && !state.error && result?.status === 'ready' && result.tools.length > 0 && (
            <ToolGroups tools={result.tools} />
          )}
        </section>

        <DialogFooter className="gap-2 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {canTry ? '会新建对话并预填应用引用，不会自动发送。' : '请先连接并启用此应用后再试用。'}
          </p>
          <Button type="button" disabled={!canTry} onClick={onTryApp}>
            立即试用
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ToolsLoading(): React.JSX.Element {
  return (
    <div
      data-slot="plugin-app-tools-loading"
      className="flex items-center gap-2 rounded-lg border px-3 py-6 text-sm text-muted-foreground"
    >
      <Loader2Icon className="size-4 animate-spin" />
      正在读取工具说明…
    </div>
  )
}

function ToolsEmpty({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      data-slot="plugin-app-tools-empty"
      className="rounded-lg border px-3 py-6 text-sm text-muted-foreground"
    >
      {message}
    </div>
  )
}

function ToolsError({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      data-slot="plugin-app-tools-error"
      className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive"
    >
      <span>{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        <RefreshCwIcon className="size-3.5" />
        重试
      </Button>
    </div>
  )
}

function ToolGroups({ tools }: { tools: AppTool[] }): React.JSX.Element {
  const writeTools = tools.filter((tool) => !tool.readOnly)
  const readTools = tools.filter((tool) => tool.readOnly)
  return (
    <div className="space-y-2">
      <ToolGroup title="会更改数据" tools={writeTools} />
      <ToolGroup title="只读" tools={readTools} />
    </div>
  )
}

function ToolGroup({
  title,
  tools
}: {
  title: string
  tools: AppTool[]
}): React.JSX.Element | null {
  const [expanded, setExpanded] = React.useState(true)
  if (tools.length === 0) return null
  return (
    <section className="overflow-hidden rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 bg-muted/30 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <span>
          {title} {tools.length}
        </span>
        <ChevronDownIcon className={cn('size-4 transition-transform', !expanded && '-rotate-90')} />
      </button>
      {expanded && (
        <div className="divide-y">
          {tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </div>
      )}
    </section>
  )
}

function ToolRow({ tool }: { tool: AppTool }): React.JSX.Element {
  const unavailableReason = tool.restriction?.message ?? disabledReasonLabel(tool.disabledReason)
  return (
    <article className="px-3 py-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-medium">{tool.title ?? tool.name}</h4>
          {tool.title && tool.title !== tool.name && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{tool.name}</p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 text-xs',
            tool.enabled ? 'text-emerald-600' : 'text-muted-foreground'
          )}
        >
          {tool.enabled ? '可用' : '不可用'}
        </span>
      </div>
      {tool.description && (
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{tool.description}</p>
      )}
      {unavailableReason && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{unavailableReason}</p>
      )}
    </article>
  )
}

function disabledReasonLabel(reason?: string): string | undefined {
  if (!reason) return undefined
  if (reason === 'disabled_by_admin') return '此工具已被管理员禁用。'
  return '此工具当前不可用。'
}
