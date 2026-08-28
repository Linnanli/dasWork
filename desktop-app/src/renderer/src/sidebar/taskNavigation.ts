import type { SidebarConversation, SidebarPreferences } from '../../../shared/codexIpcApi'
import { buildSidebarViewModel } from './sidebarModel'

export type TaskNavigation = {
  previousConversationId?: string
  nextConversationId?: string
}

export function taskNavigationForConversation({
  conversationId,
  conversations,
  preferences
}: {
  conversationId: string | undefined
  conversations: readonly SidebarConversation[]
  preferences: SidebarPreferences
}): TaskNavigation {
  if (!conversationId) return {}
  const orderedConversations = buildSidebarViewModel({
    projectState: null,
    conversations: [...conversations],
    preferences
  }).chronologicalChats
  const currentIndex = orderedConversations.findIndex(
    (conversation) => conversation.id === conversationId || conversation.threadId === conversationId
  )
  if (currentIndex < 0) return {}

  return {
    ...(orderedConversations[currentIndex - 1]
      ? { previousConversationId: orderedConversations[currentIndex - 1].id }
      : {}),
    ...(orderedConversations[currentIndex + 1]
      ? { nextConversationId: orderedConversations[currentIndex + 1].id }
      : {})
  }
}
