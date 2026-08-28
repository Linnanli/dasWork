import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ProjectStateController } from '../projects/useProjectState'
import { Input } from '../components/ui/input'
import { ScrollArea } from '../components/ui/scroll-area'
import { buildSidebarViewModel } from './sidebarModel'
import { SidebarChatsSection } from './SidebarChatsSection'
import { SidebarPrimaryActions } from './SidebarPrimaryActions'
import { SidebarProjectsSection } from './SidebarProjectsSection'
import { SidebarTaskSearchResults } from './SidebarTaskSearchResults'
import type { ConversationRowActions } from './ConversationRow'
import type { ConversationStateController } from './useConversationState'

export function SidebarRoot({
  nativeBackdrop,
  projectState,
  conversationState,
  onNewChat,
  onOpenCommandPalette,
  onOpenConversation,
  onOpenPlugins,
  pluginsActive = false
}: {
  nativeBackdrop: boolean
  projectState: ProjectStateController
  conversationState: ConversationStateController
  onNewChat: () => void
  onOpenCommandPalette?: () => void
  onOpenConversation?: (conversationId: string) => void
  onOpenPlugins?: () => void
  pluginsActive?: boolean
}): React.JSX.Element {
  const [taskSearch, setTaskSearch] = useState('')
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const focusTaskSearch = (): void => taskSearchInputRef.current?.focus()
    window.addEventListener('dascowork:focus-task-search', focusTaskSearch)
    return () => window.removeEventListener('dascowork:focus-task-search', focusTaskSearch)
  }, [])
  const openConversation = useCallback(
    (conversationId: string) => {
      if (onOpenConversation) {
        onOpenConversation(conversationId)
        return
      }
      void conversationState.openConversation({ conversationId })
    },
    [conversationState, onOpenConversation]
  )
  const startQuickChat = async (): Promise<void> => {
    await projectState.selectProject({ projectKind: 'projectless' })
    onNewChat()
  }

  const model = buildSidebarViewModel({
    projectState: projectState.state,
    conversations: conversationState.state.conversations,
    preferences: conversationState.preferences
  })
  const archiveConversation = useCallback(
    async (conversationId: string, active: boolean) => {
      await conversationState.archiveConversation({ conversationId })
      if (active) onNewChat()
    },
    [conversationState, onNewChat]
  )
  const openConversationInNewWindow = useCallback(
    (conversationId: string) =>
      window.desktopApp.conversations.openConversationInNewWindow({ conversationId }),
    []
  )
  const unarchiveConversation = useCallback(
    (conversationId: string) => conversationState.unarchiveConversation({ conversationId }),
    [conversationState]
  )
  const deleteConversation = useCallback(
    (conversationId: string) => conversationState.deleteConversation({ conversationId }),
    [conversationState]
  )
  const renameConversation = useCallback(
    (conversationId: string, title: string) =>
      conversationState.renameConversation({ conversationId, title }),
    [conversationState]
  )
  const togglePinnedConversation = useCallback(
    (conversationId: string, pinned: boolean) => {
      const pinnedConversationIds = pinned
        ? conversationState.preferences.pinnedConversationIds.filter((id) => id !== conversationId)
        : [...conversationState.preferences.pinnedConversationIds, conversationId]
      return conversationState.setPreferences({ pinnedConversationIds })
    },
    [conversationState]
  )
  const conversationActions = useMemo<ConversationRowActions>(
    () => ({
      archiveConversation,
      openConversationInNewWindow,
      unarchiveConversation,
      deleteConversation,
      renameConversation,
      togglePinnedConversation
    }),
    [
      archiveConversation,
      deleteConversation,
      openConversationInNewWindow,
      renameConversation,
      togglePinnedConversation,
      unarchiveConversation
    ]
  )

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      <SidebarPrimaryActions
        nativeBackdrop={nativeBackdrop}
        onNewChat={onNewChat}
        onOpenCommandPalette={onOpenCommandPalette}
        onOpenPlugins={onOpenPlugins}
        pluginsActive={pluginsActive}
      />
      <div className="px-3">
        <Input
          ref={taskSearchInputRef}
          aria-label="搜索所有任务"
          className="h-8 text-sm"
          placeholder="搜索所有任务"
          type="search"
          value={taskSearch}
          onChange={(event) => setTaskSearch(event.target.value)}
        />
      </div>
      <ScrollArea className="min-h-0 w-full min-w-0 flex-1" aria-label="Projects and quick chats">
        <div className="w-full min-w-0 space-y-3 px-3 pb-3 pt-0">
          {taskSearch.trim() ? (
            <SidebarTaskSearchResults
              conversationActions={conversationActions}
              conversations={conversationState.state.conversations}
              nativeBackdrop={nativeBackdrop}
              onOpenConversation={openConversation}
              projectState={projectState.state}
              query={taskSearch}
            />
          ) : (
            <>
              <SidebarProjectsSection
                groups={model.projectGroups}
                nativeBackdrop={nativeBackdrop}
                projectState={projectState}
                conversationState={conversationState}
                conversationActions={conversationActions}
                onNewChat={onNewChat}
                onOpenConversation={onOpenConversation}
              />
              <SidebarChatsSection
                quickChats={model.quickChats}
                chronologicalChats={model.chronologicalChats}
                archivedChats={model.archivedChats}
                projectState={projectState.state}
                showChronological={model.preferences.organizeMode === 'chronological'}
                nativeBackdrop={nativeBackdrop}
                conversationState={conversationState}
                conversationActions={conversationActions}
                onDeleteArchivedConversations={(conversationIds) =>
                  conversationState.deleteArchivedConversations({ conversationIds })
                }
                onNewQuickChat={() => void startQuickChat()}
                onOpenConversation={onOpenConversation}
              />
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
