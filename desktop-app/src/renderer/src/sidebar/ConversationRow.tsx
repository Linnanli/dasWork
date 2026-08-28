import { memo, useCallback, useState } from 'react'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  AppWindowIcon,
  CalendarClockIcon,
  CopyIcon,
  EllipsisIcon,
  LoaderIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon
} from 'lucide-react'
import { toast } from 'sonner'

import { createConversationLink } from '../../../shared/conversationLink'
import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '../components/ui/dropdown-menu'
import { Input } from '../components/ui/input'
import { cn } from '../lib/utils'
import type { ConversationRuntimeIndicator } from '../runtime/ConversationRuntimeIndicatorStore'
import { formatConversationMarkdown } from './conversationMarkdown'
import type { SidebarConversationView } from './sidebarTypes'
import { useConversationRuntimeIndicator } from './useConversationRuntimeIndicator'
import { AutomationDialog } from './AutomationDialog'

export type ConversationRowActions = {
  archiveConversation: (conversationId: string, active: boolean) => Promise<void>
  openConversationInNewWindow?: (conversationId: string) => Promise<void>
  unarchiveConversation: (conversationId: string) => Promise<void>
  deleteConversation?: (conversationId: string) => Promise<void>
  renameConversation: (conversationId: string, title: string) => Promise<void>
  togglePinnedConversation: (conversationId: string, pinned: boolean) => Promise<void>
}

type PendingAction =
  | 'archive'
  | 'copy-markdown'
  | 'delete'
  | 'open-in-new-window'
  | 'pin'
  | 'rename'
  | 'unarchive'
  | undefined

export const ConversationRow = memo(function ConversationRow({
  conversation,
  projectLabel,
  nativeBackdrop,
  onOpenConversation,
  actions
}: {
  conversation: SidebarConversationView
  projectLabel?: string
  nativeBackdrop: boolean
  onOpenConversation: (conversationId: string) => void
  actions?: ConversationRowActions
}): React.JSX.Element {
  const { active, attention, running, unread } = useConversationRuntimeIndicator(conversation)
  const [pendingAction, setPendingAction] = useState<PendingAction>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [automationOpen, setAutomationOpen] = useState(false)
  const [renameTitle, setRenameTitle] = useState(conversation.title ?? '')
  const onOpen = useCallback(
    () => onOpenConversation(conversation.id),
    [conversation.id, onOpenConversation]
  )
  const title = conversation.title ?? 'New Chat'
  const automated = isAutomationConversation(conversation)

  const perform = useCallback(
    async (
      action: Exclude<PendingAction, undefined>,
      work: () => Promise<void>,
      success: string
    ) => {
      setPendingAction(action)
      try {
        await work()
        toast.success(success)
        return true
      } catch (error) {
        toast.error(errorMessage(error))
        return false
      } finally {
        setPendingAction(undefined)
      }
    },
    []
  )

  const copyText = useCallback(async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label}已复制`)
    } catch {
      toast.error(`无法复制${label}`)
    }
  }, [])

  const copyMarkdown = useCallback(async () => {
    await perform(
      'copy-markdown',
      async () => {
        const snapshot = await window.desktopApp.conversations.openConversation({
          conversationId: conversation.id
        })
        await navigator.clipboard.writeText(
          formatConversationMarkdown({
            title: snapshot.title ?? title,
            messages: snapshot.messages
          })
        )
      },
      '对话 Markdown 已复制'
    )
  }, [conversation.id, perform, title])

  const openRename = useCallback(() => {
    setRenameTitle(conversation.title ?? '')
    setRenameOpen(true)
  }, [conversation.title])

  const submitRename = useCallback(async () => {
    if (!actions) return
    const nextTitle = renameTitle.trim()
    if (!nextTitle) {
      toast.error('任务名称不能为空')
      return
    }
    const renamed = await perform(
      'rename',
      () => actions.renameConversation(conversation.id, nextTitle),
      '任务已重命名'
    )
    if (renamed) setRenameOpen(false)
  }, [actions, conversation.id, perform, renameTitle])

  const submitDelete = useCallback(async () => {
    const deleteConversation = actions?.deleteConversation
    if (!deleteConversation) return
    const deleted = await perform(
      'delete',
      () => deleteConversation(conversation.id),
      '任务已永久删除'
    )
    if (deleted) setDeleteOpen(false)
  }, [actions?.deleteConversation, conversation.id, perform])

  return (
    <div className="group flex min-h-8 min-w-0 items-center gap-1">
      <button
        aria-current={active ? 'page' : undefined}
        aria-label={conversationAriaLabel(title, { attention, running, unread }, automated)}
        className={cn(
          'flex min-h-8 w-full min-w-0 flex-1 cursor-default items-center gap-1 rounded-md transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          nativeBackdrop
            ? 'hover:bg-background/40 focus-within:bg-background/40 dark:hover:bg-foreground/8'
            : 'hover:bg-muted focus-within:bg-muted'
        )}
        type="button"
        onClick={onOpen}
      >
        <div className="flex min-w-0 flex-1 flex-col px-3 py-1 text-left text-sm text-foreground">
          <span className="flex w-full min-w-0 items-center gap-1 truncate">
            {conversation.pinned ? (
              <PinIcon aria-label="已置顶" className="size-3 shrink-0" />
            ) : null}
            <span className="min-w-0 truncate">{title}</span>
            {automated ? (
              <span
                data-slot="conversation-automation-badge"
                className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                自动化
              </span>
            ) : null}
          </span>
          <span className="block w-full min-w-0 truncate text-[11px] font-normal text-muted-foreground">
            {projectLabel ?? formatConversationMeta(conversation, { attention, running })}
          </span>
        </div>
        {running ? (
          <span
            className="grid size-6 shrink-0 place-items-center text-muted-foreground"
            aria-hidden="true"
            title={`${title} is running`}
          >
            <LoaderIcon className="size-3.5 animate-spin [animation-duration:1.4s]" />
          </span>
        ) : null}
        {attention ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-amber-500"
            title={`${title} needs attention`}
          />
        ) : null}
        {unread ? (
          <span
            aria-hidden="true"
            className="mr-2 size-2 shrink-0 rounded-full bg-primary"
            title={`${title} has unread updates`}
          />
        ) : null}
      </button>
      {actions ? (
        <ConversationOverflowMenu
          conversation={conversation}
          title={title}
          pendingAction={pendingAction}
          onArchive={() =>
            perform(
              'archive',
              () => actions.archiveConversation(conversation.id, active),
              '任务已归档'
            )
          }
          onOpenInNewWindow={
            actions.openConversationInNewWindow
              ? () =>
                  perform(
                    'open-in-new-window',
                    () => actions.openConversationInNewWindow!(conversation.id),
                    '已在新窗口打开任务'
                  )
              : undefined
          }
          onCopyMarkdown={copyMarkdown}
          onCopySessionId={() => void copyText('会话 ID', conversation.threadId ?? conversation.id)}
          onCopyTaskLink={() => void copyText('任务链接', createConversationLink(conversation.id))}
          onCopyWorkingDirectory={() => void copyText('工作目录', conversation.cwd!)}
          onOpenDelete={actions.deleteConversation ? () => setDeleteOpen(true) : undefined}
          onOpenAutomation={() => setAutomationOpen(true)}
          onOpenRename={openRename}
          onTogglePin={() =>
            perform(
              'pin',
              () => actions.togglePinnedConversation(conversation.id, Boolean(conversation.pinned)),
              conversation.pinned ? '已取消置顶' : '已置顶'
            )
          }
          onUnarchive={() =>
            perform('unarchive', () => actions.unarchiveConversation(conversation.id), '任务已恢复')
          }
        />
      ) : null}
      {actions?.deleteConversation ? (
        <DeleteConversationDialog
          open={deleteOpen}
          pending={pendingAction === 'delete'}
          title={title}
          onOpenChange={setDeleteOpen}
          onSubmit={() => void submitDelete()}
        />
      ) : null}
      {actions ? (
        <RenameConversationDialog
          open={renameOpen}
          pending={pendingAction === 'rename'}
          title={renameTitle}
          onOpenChange={setRenameOpen}
          onSubmit={() => void submitRename()}
          onTitleChange={setRenameTitle}
        />
      ) : null}
      {automationOpen ? (
        <AutomationDialog
          open={automationOpen}
          sourceConversationId={conversation.id}
          sourceThreadId={conversation.threadId}
          sourceTitle={title}
          onOpenChange={setAutomationOpen}
        />
      ) : null}
    </div>
  )
})

function ConversationOverflowMenu({
  conversation,
  title,
  pendingAction,
  onArchive,
  onOpenInNewWindow,
  onUnarchive,
  onOpenDelete,
  onOpenAutomation,
  onOpenRename,
  onTogglePin,
  onCopyWorkingDirectory,
  onCopySessionId,
  onCopyTaskLink,
  onCopyMarkdown
}: {
  conversation: SidebarConversationView
  title: string
  pendingAction: PendingAction
  onArchive: () => Promise<boolean>
  onOpenInNewWindow?: () => Promise<boolean>
  onUnarchive: () => Promise<boolean>
  onOpenDelete?: () => void
  onOpenAutomation: () => void
  onOpenRename: () => void
  onTogglePin: () => Promise<boolean>
  onCopyWorkingDirectory: () => void
  onCopySessionId: () => void
  onCopyTaskLink: () => void
  onCopyMarkdown: () => Promise<void>
}): React.JSX.Element {
  const pending = Boolean(pendingAction)
  const isArchived = Boolean(conversation.archived)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`更多操作：${title}`}
          className="pointer-events-none shrink-0 text-muted-foreground opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          size="icon-xs"
          title="更多操作"
          type="button"
          variant="ghost"
        >
          {pending ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <EllipsisIcon className="size-3.5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onOpenInNewWindow ? (
          <DropdownMenuItem disabled={pending} onSelect={() => void onOpenInNewWindow()}>
            <AppWindowIcon /> 在新窗口打开
          </DropdownMenuItem>
        ) : null}
        {isArchived ? (
          <DropdownMenuItem disabled={pending} onSelect={() => void onUnarchive()}>
            <ArchiveRestoreIcon /> 恢复任务
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem disabled={pending} onSelect={onOpenRename}>
              <PencilIcon /> 重命名
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => void onTogglePin()}>
              {conversation.pinned ? <PinOffIcon /> : <PinIcon />}
              {conversation.pinned ? '取消置顶' : '置顶'}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={onOpenAutomation}>
              <CalendarClockIcon /> 创建或管理定时任务
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => void onArchive()}>
              <ArchiveIcon /> 归档任务
            </DropdownMenuItem>
          </>
        )}
        {isArchived && onOpenDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              disabled={pending}
              onSelect={onOpenDelete}
            >
              <Trash2Icon /> 永久删除
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <CopyIcon /> 复制
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem disabled={!conversation.cwd} onSelect={onCopyWorkingDirectory}>
              <CopyIcon /> 复制工作目录
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopySessionId}>
              <CopyIcon /> 复制会话 ID
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopyTaskLink}>
              <CopyIcon /> 复制任务链接
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => void onCopyMarkdown()}>
              <CopyIcon /> 复制对话 Markdown
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RenameConversationDialog({
  open,
  pending,
  title,
  onOpenChange,
  onTitleChange,
  onSubmit
}: {
  open: boolean
  pending: boolean
  title: string
  onOpenChange: (open: boolean) => void
  onTitleChange: (value: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <DialogHeader>
            <DialogTitle>重命名任务</DialogTitle>
            <DialogDescription>为这项任务设置一个容易识别的名称。</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="任务名称"
            autoFocus
            className="mt-4"
            disabled={pending}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? <LoaderIcon className="animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteConversationDialog({
  open,
  pending,
  title,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  pending: boolean
  title: string
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>永久删除任务？</DialogTitle>
          <DialogDescription>
            将永久删除“{title}
            ”的任务记录、排队消息和本地差异缓存。此操作无法撤销，已创建的工作文件不会被删除。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-6">
          <Button
            disabled={pending}
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button disabled={pending} type="button" variant="destructive" onClick={onSubmit}>
            {pending ? <LoaderIcon className="animate-spin" /> : <Trash2Icon />}
            永久删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatConversationMeta(
  conversation: SidebarConversationView,
  indicator: Pick<ConversationRuntimeIndicator, 'attention' | 'running'>
): string {
  if (conversation.archived) return '已归档'
  if (indicator.attention) return 'Needs attention'
  if (indicator.running) return 'Running'
  if (conversation.updatedAt) return new Date(conversation.updatedAt).toLocaleString()
  return conversation.cwd ?? 'Conversation'
}

function conversationAriaLabel(
  title: string,
  indicator: Pick<ConversationRuntimeIndicator, 'attention' | 'running' | 'unread'>,
  automated: boolean
): string {
  const states = [
    automated ? 'automation' : '',
    indicator.running ? 'running' : '',
    indicator.unread ? 'unread' : '',
    indicator.attention ? 'needs attention' : ''
  ].filter(Boolean)
  return states.length > 0 ? `${title}, ${states.join(', ')}` : title
}

function isAutomationConversation(conversation: SidebarConversationView): boolean {
  return conversation.threadSource?.trim().toLowerCase() === 'automation'
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '操作失败，请重试'
}
