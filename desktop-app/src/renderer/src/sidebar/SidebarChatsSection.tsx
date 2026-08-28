import { useCallback, useMemo, useState } from 'react'
import { PencilIcon } from 'lucide-react'

import { Button } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { ConversationRow, type ConversationRowActions } from './ConversationRow'
import {
  archivedTaskProject,
  archivedTaskProjectGroups,
  archivedTaskProjectOptions,
  type ArchivedTaskSort,
  type ArchivedTaskType
} from './archiveTasks'
import type { SidebarConversationView } from './sidebarTypes'
import type { ConversationStateController } from './useConversationState'
import type { ProjectState } from '../../../shared/projects/projectTypes'

type ArchivedProjectDelete = {
  id: string
  label: string
  count: number
}

const archivedTasksPageSize = 50

export function SidebarChatsSection({
  quickChats,
  chronologicalChats,
  archivedChats,
  projectState,
  showChronological,
  nativeBackdrop,
  conversationState,
  conversationActions,
  onDeleteArchivedConversations,
  onNewQuickChat,
  onOpenConversation
}: {
  quickChats: SidebarConversationView[]
  chronologicalChats: SidebarConversationView[]
  archivedChats: SidebarConversationView[]
  projectState: ProjectState | null
  showChronological: boolean
  nativeBackdrop: boolean
  conversationState: ConversationStateController
  conversationActions: ConversationRowActions
  onDeleteArchivedConversations?: (conversationIds: string[]) => Promise<void>
  onNewQuickChat: () => void
  onOpenConversation?: (conversationId: string) => void
}): React.JSX.Element {
  const chats = showChronological ? chronologicalChats : quickChats
  const quickChatActionLabel = 'New quick chat'
  const [archiveSearch, setArchiveSearch] = useState('')
  const [archiveProjectId, setArchiveProjectId] = useState('all')
  const [archiveType, setArchiveType] = useState<ArchivedTaskType>('all')
  const [archiveSort, setArchiveSort] = useState<ArchivedTaskSort>('updated-desc')
  const [archiveVisibleCounts, setArchiveVisibleCounts] = useState<Record<string, number>>({})
  const [archiveDeleteProject, setArchiveDeleteProject] = useState<ArchivedProjectDelete>()
  const [archiveDeleteError, setArchiveDeleteError] = useState<string>()
  const [archiveDeletePending, setArchiveDeletePending] = useState(false)
  const archiveProjectOptions = useMemo(
    () => archivedTaskProjectOptions(archivedChats, projectState),
    [archivedChats, projectState]
  )
  const archivedGroups = useMemo(
    () =>
      archivedTaskProjectGroups({
        chats: archivedChats,
        projectState,
        query: archiveSearch,
        projectId: archiveProjectId,
        type: archiveType,
        sort: archiveSort
      }),
    [archiveProjectId, archiveSearch, archiveSort, archiveType, archivedChats, projectState]
  )
  const { openConversation: openConversationInRuntime } = conversationState
  const openConversation = useCallback(
    (conversationId: string) => {
      if (onOpenConversation) {
        onOpenConversation(conversationId)
        return
      }
      void openConversationInRuntime({ conversationId })
    },
    [onOpenConversation, openConversationInRuntime]
  )
  const deleteArchivedProject = async (): Promise<void> => {
    if (!archiveDeleteProject || !onDeleteArchivedConversations) return
    const conversationIds = archivedConversationIdsForProject(
      archivedChats,
      projectState,
      archiveDeleteProject.id
    )
    if (conversationIds.length === 0) {
      setArchiveDeleteProject(undefined)
      return
    }

    setArchiveDeletePending(true)
    setArchiveDeleteError(undefined)
    try {
      await onDeleteArchivedConversations(conversationIds)
      setArchiveDeleteProject(undefined)
    } catch (error) {
      setArchiveDeleteError(errorMessage(error))
    } finally {
      setArchiveDeletePending(false)
    }
  }
  return (
    <section
      className="min-w-0 space-y-1"
      aria-label={showChronological ? 'Recent chats' : 'Quick chats'}
    >
      <div className="group flex min-w-0 items-center justify-between pl-2 text-[11px] text-muted-foreground uppercase">
        <span className="min-w-0 truncate">
          {showChronological ? 'Recent chats' : 'Quick chats'}
        </span>
        {!showChronological ? (
          <Button
            aria-label={quickChatActionLabel}
            className="pointer-events-none shrink-0 text-muted-foreground opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100"
            size="icon-xs"
            title={quickChatActionLabel}
            type="button"
            variant="ghost"
            onClick={onNewQuickChat}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-w-0 space-y-0.5">
        {chats.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {showChronological ? 'No recent chats' : 'No quick chats'}
          </div>
        ) : (
          chats.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              nativeBackdrop={nativeBackdrop}
              onOpenConversation={openConversation}
              actions={conversationActions}
            />
          ))
        )}
      </div>
      {archivedChats.length > 0 ? (
        <details className="min-w-0 pt-2" data-slot="archived-chats">
          <summary className="cursor-default px-2 py-1 text-[11px] text-muted-foreground uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            已归档任务 ({archivedChats.length})
          </summary>
          <div className="min-w-0 space-y-2 px-2 pt-2">
            <Input
              aria-label="搜索已归档任务"
              className="h-8 text-sm"
              placeholder="搜索已归档任务"
              type="search"
              value={archiveSearch}
              onChange={(event) => setArchiveSearch(event.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                项目
                <select
                  aria-label="筛选归档任务项目"
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={archiveProjectId}
                  onChange={(event) => setArchiveProjectId(event.target.value)}
                >
                  <option value="all">所有项目</option>
                  {archiveProjectOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                排序
                <select
                  aria-label="归档任务排序"
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={archiveSort}
                  onChange={(event) => setArchiveSort(event.target.value as ArchivedTaskSort)}
                >
                  <option value="updated-desc">最近更新</option>
                  <option value="created-desc">最近创建</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                类型
                <select
                  aria-label="筛选归档任务类型"
                  className="h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={archiveType}
                  onChange={(event) => setArchiveType(event.target.value as ArchivedTaskType)}
                >
                  <option value="all">全部类型</option>
                  <option value="standard">普通任务</option>
                  <option value="automation">自动化任务</option>
                </select>
              </label>
            </div>
            {archivedGroups.length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground">没有匹配的归档任务。</p>
            ) : (
              <div className="min-w-0 space-y-3">
                {archivedGroups.map((group) => {
                  const visibleCount = archiveVisibleCounts[group.id] ?? archivedTasksPageSize
                  const remainingCount = group.conversations.length - visibleCount
                  return (
                    <section key={group.id} data-slot="archived-chat-project-group">
                      <div className="flex items-center justify-between gap-2 px-1">
                        <h3 className="min-w-0 truncate text-[11px] text-muted-foreground uppercase">
                          {group.label} ({group.conversations.length})
                        </h3>
                        {onDeleteArchivedConversations && archiveType === 'all' ? (
                          <Button
                            className="h-auto px-0 py-0.5 text-[11px] text-destructive hover:bg-transparent hover:text-destructive"
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setArchiveDeleteError(undefined)
                              setArchiveDeleteProject({
                                id: group.id,
                                label: group.label,
                                count: archivedConversationIdsForProject(
                                  archivedChats,
                                  projectState,
                                  group.id
                                ).length
                              })
                            }}
                          >
                            清空项目归档
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-1 min-w-0 space-y-0.5">
                        {group.conversations.slice(0, visibleCount).map((conversation) => (
                          <ConversationRow
                            key={conversation.id}
                            actions={conversationActions}
                            conversation={conversation}
                            nativeBackdrop={nativeBackdrop}
                            onOpenConversation={openConversation}
                          />
                        ))}
                      </div>
                      {remainingCount > 0 ? (
                        <Button
                          aria-label={`显示更多归档任务：${group.label}`}
                          className="mt-1 h-7 w-full text-xs text-muted-foreground"
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            setArchiveVisibleCounts((counts) => ({
                              ...counts,
                              [group.id]:
                                (counts[group.id] ?? archivedTasksPageSize) + archivedTasksPageSize
                            }))
                          }}
                        >
                          显示更多（剩余 {remainingCount}）
                        </Button>
                      ) : null}
                    </section>
                  )
                })}
              </div>
            )}
          </div>
        </details>
      ) : null}
      <Dialog
        open={Boolean(archiveDeleteProject)}
        onOpenChange={(open) => {
          if (open || archiveDeletePending) return
          setArchiveDeleteError(undefined)
          setArchiveDeleteProject(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>永久删除项目归档任务？</DialogTitle>
            <DialogDescription>
              将永久删除“{archiveDeleteProject?.label}”中的 {archiveDeleteProject?.count ?? 0}{' '}
              项归档任务及其应用内元数据。此操作无法恢复，用户工作文件会保留。
            </DialogDescription>
          </DialogHeader>
          {archiveDeleteError ? <p role="alert" className="text-sm text-destructive">{archiveDeleteError}</p> : null}
          <DialogFooter>
            <Button
              disabled={archiveDeletePending}
              type="button"
              variant="outline"
              onClick={() => setArchiveDeleteProject(undefined)}
            >
              取消
            </Button>
            <Button
              disabled={archiveDeletePending}
              type="button"
              variant="destructive"
              onClick={() => void deleteArchivedProject()}
            >
              {archiveDeletePending ? '正在永久删除…' : '永久删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '永久删除归档任务失败。'
}

function archivedConversationIdsForProject(
  archivedChats: readonly SidebarConversationView[],
  projectState: ProjectState | null,
  projectId: string
): string[] {
  return archivedChats
    .filter((chat) => archivedTaskProject(projectState, chat).id === projectId)
    .map((chat) => chat.id)
}
