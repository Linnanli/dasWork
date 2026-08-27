import type { ProjectStateController } from '../projects/useProjectState'
import { ScrollArea } from '../components/ui/scroll-area'
import { buildSidebarViewModel } from './sidebarModel'
import { SidebarChatsSection } from './SidebarChatsSection'
import { SidebarPrimaryActions } from './SidebarPrimaryActions'
import { SidebarProjectsSection } from './SidebarProjectsSection'
import type { ConversationStateController } from './useConversationState'

export function SidebarRoot({
  nativeBackdrop,
  projectState,
  conversationState,
  onNewChat,
  onOpenConversation,
  onOpenPlugins,
  pluginsActive = false
}: {
  nativeBackdrop: boolean
  projectState: ProjectStateController
  conversationState: ConversationStateController
  onNewChat: () => void
  onOpenConversation?: (conversationId: string) => void
  onOpenPlugins?: () => void
  pluginsActive?: boolean
}): React.JSX.Element {
  const startQuickChat = async (): Promise<void> => {
    await projectState.selectProject({ projectKind: 'projectless' })
    onNewChat()
  }

  const model = buildSidebarViewModel({
    projectState: projectState.state,
    conversations: conversationState.state.conversations,
    preferences: conversationState.preferences
  })

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      <SidebarPrimaryActions
        nativeBackdrop={nativeBackdrop}
        onNewChat={onNewChat}
        onOpenPlugins={onOpenPlugins}
        pluginsActive={pluginsActive}
      />
      <ScrollArea className="min-h-0 w-full min-w-0 flex-1" aria-label="Projects and quick chats">
        <div className="w-full min-w-0 space-y-3 px-3 pb-3 pt-0">
          <SidebarProjectsSection
            groups={model.projectGroups}
            nativeBackdrop={nativeBackdrop}
            projectState={projectState}
            conversationState={conversationState}
            onNewChat={onNewChat}
            onOpenConversation={onOpenConversation}
          />
          <SidebarChatsSection
            quickChats={model.quickChats}
            chronologicalChats={model.chronologicalChats}
            showChronological={model.preferences.organizeMode === 'chronological'}
            nativeBackdrop={nativeBackdrop}
            conversationState={conversationState}
            onNewQuickChat={() => void startQuickChat()}
            onOpenConversation={onOpenConversation}
          />
        </div>
      </ScrollArea>
    </div>
  )
}
