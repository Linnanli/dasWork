import type { SidebarConversationView } from './sidebarTypes'

export function searchSidebarTasks(
  conversations: readonly SidebarConversationView[],
  query: string
): readonly SidebarConversationView[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return conversations

  return conversations.filter((conversation) =>
    conversationSearchTerms(conversation).some((term) =>
      term.toLocaleLowerCase().includes(normalizedQuery)
    )
  )
}

function conversationSearchTerms(conversation: SidebarConversationView): string[] {
  const assignment = conversation.projectAssignment
  return [
    conversation.title,
    conversation.cwd,
    conversation.id,
    conversation.threadId,
    ...(assignment ? Object.values(assignment) : [])
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
}
