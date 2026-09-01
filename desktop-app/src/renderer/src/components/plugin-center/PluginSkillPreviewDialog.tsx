import * as React from 'react'
import {
  CopyIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  Trash2Icon
} from 'lucide-react'
import { Streamdown } from 'streamdown'

import type {
  PluginCenterGetSkillContentsResult,
  PluginCenterPluginDetail,
  PluginCenterSkill
} from '../../../../shared/pluginCenterApi'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CapabilityPill, PluginCapabilityDialog } from './PluginCapabilityDialog'
import { PluginDetailSkillIcon } from './PluginDetailSkillIcon'
import { PluginImage } from './PluginImage'
import type { PluginCenterResourceSnapshot } from './pluginCenterDataResource'
import { cleanSkillMarkdown } from './pluginSkillPreviewMarkdown'

type PluginDetailSkill = PluginCenterPluginDetail['skills'][number]
type PluginSkillPreviewSkill = Pick<
  PluginCenterSkill,
  'id' | 'name' | 'displayName' | 'description' | 'enabled' | 'canToggle'
> & {
  icon?: PluginDetailSkill['icon']
  iconSmall?: PluginCenterSkill['iconSmall']
  iconLarge?: PluginCenterSkill['iconLarge']
}
export type PluginSkillPreviewContentsResult = PluginCenterGetSkillContentsResult

type PluginSkillPreviewDialogProps = {
  skill: PluginSkillPreviewSkill
  open: boolean
  state: PluginCenterResourceSnapshot<PluginSkillPreviewContentsResult>
  pending: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (enabled: boolean) => void
  onTrySkill: () => void
  onOpenLocalPath: (path: string) => void
  onRetry: () => void
  installAction?: {
    pending: boolean
    onInstall: () => void
  }
  uninstallAction?: {
    pending: boolean
    onUninstall: () => void
  }
}

export function PluginSkillPreviewDialog({
  skill,
  open,
  state,
  pending,
  onOpenChange,
  onToggle,
  onTrySkill,
  onOpenLocalPath,
  onRetry,
  installAction,
  uninstallAction
}: PluginSkillPreviewDialogProps): React.JSX.Element {
  const title = skill.displayName ?? skill.name
  const result = state.data
  const readyResult = result?.status === 'ready' ? result : null
  const trustedLocalPath = readyResult?.localPath
  const canTry = Boolean(trustedLocalPath) && skill.enabled && !pending
  const toggleDisabledReason = '请先安装并启用所属插件。'
  const tryDisabledReason = pending ? '正在处理技能状态。' : '请先启用此技能后再试用。'

  return (
    <PluginCapabilityDialog
      open={open}
      onOpenChange={onOpenChange}
      dataSlot="plugin-skill-preview-dialog"
      icon={
        <PluginImage
          icon={skill.iconLarge ?? skill.iconSmall ?? skill.icon}
          title={title}
          fallback={<PluginDetailSkillIcon />}
          className="size-12 shrink-0 rounded-xl border bg-transparent object-contain"
        />
      }
      title={title}
      description={skill.description ?? '此技能未提供简短说明。'}
      status={
        !skill.enabled ? <CapabilityPill className="text-amber-700">停用</CapabilityPill> : null
      }
      actions={
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <TooltipHint enabled={pending || !skill.canToggle} message={toggleDisabledReason}>
            <Switch
              checked={skill.enabled}
              disabled={pending || !skill.canToggle}
              aria-label={`${title} ${skill.enabled ? '停用' : '启用'}`}
              onCheckedChange={onToggle}
            />
          </TooltipHint>
          <SkillActionsMenu
            markdown={readyResult?.contents}
            localPath={readyResult?.localPath}
            onOpenLocalPath={onOpenLocalPath}
            uninstallAction={uninstallAction}
          />
        </div>
      }
      footer={
        <>
          <p className="text-xs text-muted-foreground">
            {footerDescription(
              canTry,
              Boolean(trustedLocalPath),
              tryDisabledReason,
              Boolean(installAction)
            )}
          </p>
          {installAction ? (
            <Button
              type="button"
              disabled={installAction.pending}
              onClick={installAction.onInstall}
            >
              安装所属插件
            </Button>
          ) : trustedLocalPath ? (
            <TooltipHint enabled={!canTry} message={tryDisabledReason}>
              <Button type="button" disabled={!canTry} onClick={onTrySkill}>
                立即试用
              </Button>
            </TooltipHint>
          ) : (
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          )}
        </>
      }
    >
      <SkillPreviewBody state={state} title={title} onRetry={onRetry} />
    </PluginCapabilityDialog>
  )
}

function footerDescription(
  canTry: boolean,
  hasTrustedLocalPath: boolean,
  disabledReason: string,
  canInstallOwningPlugin: boolean
): string {
  if (canTry) return '会新建对话并预填技能引用，不会自动发送。'
  if (canInstallOwningPlugin) return '安装所属插件后，即可启用并试用此技能。'
  if (!hasTrustedLocalPath) return '远程或未安装技能只能预览说明，安装到本地后才能试用。'
  return disabledReason
}

function SkillPreviewBody({
  state,
  title,
  onRetry
}: {
  state: PluginCenterResourceSnapshot<PluginSkillPreviewContentsResult>
  title: string
  onRetry: () => void
}): React.JSX.Element {
  const result = state.data
  const isLoading = state.status === 'idle' || state.status === 'loading'
  if (isLoading) return <SkillLoading />
  if (state.error) return <SkillError message={state.error} onRetry={onRetry} />
  if (result?.status === 'missing')
    return <SkillEmpty message="此技能当前不可用，暂时无法读取说明。" />
  if (result?.status !== 'ready') return <SkillEmpty message="此技能未提供可预览的说明。" />

  const markdown = cleanSkillMarkdown(result.contents, title)
  if (!markdown.trim()) return <SkillEmpty message="此技能未提供可预览的说明。" />
  return (
    <div
      data-slot="plugin-skill-preview-markdown"
      className="prose prose-sm max-w-none dark:prose-invert"
    >
      <Streamdown>{markdown}</Streamdown>
    </div>
  )
}

function SkillActionsMenu({
  markdown,
  localPath,
  onOpenLocalPath,
  uninstallAction
}: {
  markdown?: string
  localPath?: string
  onOpenLocalPath: (path: string) => void
  uninstallAction?: {
    pending: boolean
    onUninstall: () => void
  }
}): React.JSX.Element {
  async function copyMarkdown(): Promise<void> {
    if (!markdown || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(markdown)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="打开技能操作菜单">
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!markdown} onSelect={() => void copyMarkdown()}>
          <CopyIcon className="size-4" />
          复制 Markdown
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!localPath}
          onSelect={() => {
            if (localPath) onOpenLocalPath(localPath)
          }}
        >
          <FolderOpenIcon className="size-4" />
          打开本地文件
        </DropdownMenuItem>
        {uninstallAction && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              disabled={uninstallAction.pending}
              onSelect={uninstallAction.onUninstall}
            >
              <Trash2Icon className="size-4" />
              卸载技能
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SkillLoading(): React.JSX.Element {
  return (
    <div
      data-slot="plugin-skill-preview-loading"
      className="flex items-center gap-2 rounded-lg border px-3 py-6 text-sm text-muted-foreground"
    >
      <Loader2Icon className="size-4 animate-spin" />
      正在读取技能说明…
    </div>
  )
}

function SkillEmpty({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      data-slot="plugin-skill-preview-empty"
      className="rounded-lg border px-3 py-6 text-sm text-muted-foreground"
    >
      {message}
    </div>
  )
}

function SkillError({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      data-slot="plugin-skill-preview-error"
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
