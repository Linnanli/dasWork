import { useCallback } from 'react'
import { PlusIcon } from 'lucide-react'

import { Button } from '../components/ui/button'
import type { ProjectStateController } from '../projects/useProjectState'
import type { ConversationRowActions } from './ConversationRow'
import { ProjectGroupRow } from './ProjectGroupRow'
import type { SidebarProjectGroup } from './sidebarTypes'
import type { ConversationStateController } from './useConversationState'

export function SidebarProjectsSection({
  groups,
  nativeBackdrop,
  projectState,
  conversationState,
  conversationActions,
  onNewChat,
  onOpenConversation
}: {
  groups: SidebarProjectGroup[]
  nativeBackdrop: boolean
  projectState: ProjectStateController
  conversationState: ConversationStateController
  conversationActions: ConversationRowActions
  onNewChat: () => void
  onOpenConversation?: (conversationId: string) => void
}): React.JSX.Element {
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
  const startProjectConversation = async (group: SidebarProjectGroup): Promise<void> => {
    await projectState.selectProject(group.selection)
    onNewChat()
  }

  const toggleGroupCollapsed = (group: SidebarProjectGroup): void => {
    const collapsedGroupIds = group.collapsed
      ? conversationState.preferences.collapsedGroupIds.filter((groupId) => groupId !== group.id)
      : [...conversationState.preferences.collapsedGroupIds, group.id]

    void conversationState.setPreferences({ collapsedGroupIds })
  }

  return (
    <section className="min-w-0 space-y-1" aria-label="Projects">
      <div className="flex min-w-0 items-center justify-between pl-2 text-[11px] text-muted-foreground uppercase">
        <span className="min-w-0 truncate">Projects</span>
        <Button
          aria-label="Open folder"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          size="icon-xs"
          title="Open folder"
          type="button"
          variant="ghost"
          onClick={() => void projectState.pickWorkspaceRoot()}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <div className="min-w-0 space-y-0.5">
        {groups.length === 0 ? (
          <Button
            className="h-auto w-full min-w-0 justify-start px-2 py-1 text-left text-xs font-normal text-muted-foreground"
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => void projectState.pickWorkspaceRoot()}
          >
            Open a local project folder
          </Button>
        ) : (
          groups.map((group) => (
            <ProjectGroupRow
              key={group.id}
              group={group}
              nativeBackdrop={nativeBackdrop}
              conversationActions={conversationActions}
              onSelectProject={() => void startProjectConversation(group)}
              onToggleCollapsed={() => toggleGroupCollapsed(group)}
              onNewChat={() => void startProjectConversation(group)}
              onRemoveProject={() => void projectState.removeProject(group.selection)}
              onOpenConversation={openConversation}
            />
          ))
        )}
      </div>
    </section>
  )
}
