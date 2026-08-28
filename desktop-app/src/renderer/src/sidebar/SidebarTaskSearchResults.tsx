import type { ProjectState } from '../../../shared/projects/projectTypes'
import { ConversationRow, type ConversationRowActions } from './ConversationRow'
import { searchSidebarTasks } from './taskSearch'
import type { SidebarConversationView } from './sidebarTypes'

export function SidebarTaskSearchResults({
  query,
  conversations,
  projectState,
  nativeBackdrop,
  conversationActions,
  onOpenConversation
}: {
  query: string
  conversations: readonly SidebarConversationView[]
  projectState: ProjectState | null
  nativeBackdrop: boolean
  conversationActions: ConversationRowActions
  onOpenConversation: (conversationId: string) => void
}): React.JSX.Element {
  const results = searchSidebarTasks(conversations, query)
  return (
    <section className="min-w-0 space-y-1" data-slot="sidebar-task-search-results">
      <h2 className="px-2 text-[11px] text-muted-foreground uppercase">任务搜索</h2>
      {results.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">没有匹配的任务。</p>
      ) : (
        <div className="min-w-0 space-y-0.5">
          {results.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              actions={conversationActions}
              conversation={conversation}
              nativeBackdrop={nativeBackdrop}
              onOpenConversation={onOpenConversation}
              projectLabel={projectLabel(projectState, conversation)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function projectLabel(
  projectState: ProjectState | null,
  conversation: SidebarConversationView
): string {
  const assignment = conversation.projectAssignment
  if (!assignment) return conversation.archived ? '已归档任务' : '未分组任务'
  if (assignment.projectKind === 'projectless') {
    return conversation.archived ? '已归档临时任务' : '临时任务'
  }
  if (assignment.projectKind === 'local') {
    return projectState?.localProjects[assignment.projectId]?.name ?? assignment.cwd ?? '本地项目'
  }
  if (assignment.projectKind === 'remote') {
    return (
      projectState?.remoteProjects.find(
        (project) => project.id === assignment.projectId && project.hostId === assignment.hostId
      )?.label ??
      assignment.cwd ??
      '远程项目'
    )
  }
  return conversation.archived ? '已归档任务' : '未分组任务'
}
