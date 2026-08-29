import * as React from 'react'
import { ChevronDownIcon, Loader2Icon, RefreshCwIcon } from 'lucide-react'

import type {
  PluginCenterGetAppToolsResult,
  PluginCenterPluginDetail
} from '../../../../shared/pluginCenterApi'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { CapabilityPill, PluginCapabilityDialog } from './PluginCapabilityDialog'
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
  const tools = result?.status === 'ready' ? result.tools : []
  const toolCount = tools.length
  const readCount = tools.filter((tool) => tool.readOnly).length
  const writeCount = toolCount - readCount
  const canTry = app.accessible && app.enabled && !pending
  const tryDisabledReason = pending ? '正在处理应用状态。' : '请先连接并启用此应用后再试用。'
  const toggleDisabledReason = app.restriction?.message ?? '此应用当前不能切换启用状态。'

  return (
    <PluginCapabilityDialog
      open={open}
      onOpenChange={onOpenChange}
      dataSlot="plugin-app-tools-dialog"
      icon={
        <PluginImage
          icon={app.icon}
          title={app.name}
          fallback={<span className="text-sm">{app.name.slice(0, 1)}</span>}
          className="size-12 shrink-0 rounded-xl border bg-transparent object-contain"
        />
      }
      title={app.name}
      typeLabel="应用"
      description={app.description ?? '此应用未提供简短说明。'}
      status={
        !app.enabled ? <CapabilityPill className="text-amber-700">停用</CapabilityPill> : null
      }
      actions={
        <TooltipHint enabled={pending || !app.canToggle} message={toggleDisabledReason}>
          <Switch
            checked={app.enabled}
            disabled={pending || !app.canToggle}
            aria-label={`${app.name} ${app.enabled ? '停用' : '启用'}`}
            onCheckedChange={onToggle}
          />
        </TooltipHint>
      }
      footer={
        <>
          <p className="text-xs text-muted-foreground">
            {canTry ? '会新建对话并预填应用引用，不会自动发送。' : tryDisabledReason}
          </p>
          <TooltipHint enabled={!canTry} message={tryDisabledReason}>
            <Button type="button" disabled={!canTry} onClick={onTryApp}>
              立即试用
            </Button>
          </TooltipHint>
        </>
      }
    >
      <section aria-label="应用工具" className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">工具摘要</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              该应用包含 {toolCount} 个操作（写入 {writeCount}、读取 {readCount}）。
            </p>
          </div>
          {state.isRefreshing && (
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="space-y-3">
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
        </div>
      </section>
    </PluginCapabilityDialog>
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
        className="sticky top-0 z-10 flex w-full items-center justify-between gap-3 bg-muted/60 px-3 py-2 text-left text-sm font-medium backdrop-blur hover:bg-muted/80"
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
    <article
      className={cn(
        'grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,14rem)_1fr]',
        !tool.enabled && 'opacity-60'
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="truncate text-sm font-medium">{tool.title ?? tool.name}</h4>
          {tool.title && tool.title !== tool.name && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{tool.name}</p>
          )}
          {unavailableReason && (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{unavailableReason}</p>
          )}
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs',
            tool.enabled ? 'text-emerald-600' : 'text-muted-foreground'
          )}
        >
          {tool.enabled ? '可用' : '不可用'}
        </span>
      </div>
      <p className="text-sm leading-5 text-muted-foreground">
        {tool.description ?? '此工具未提供说明。'}
      </p>
    </article>
  )
}

function disabledReasonLabel(reason?: string): string | undefined {
  if (!reason) return undefined
  if (reason === 'disabled_by_admin') return '此工具已被管理员禁用。'
  return '此工具当前不可用。'
}

function TooltipHint({
  enabled,
  message,
  children
}: {
  enabled: boolean
  message: string
  children: React.ReactElement
}): React.JSX.Element {
  if (!enabled) return children
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent>{message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
