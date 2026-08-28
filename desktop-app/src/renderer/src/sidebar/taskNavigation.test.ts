import { describe, expect, it } from 'vitest'

import { taskNavigationForConversation } from './taskNavigation'

const preferences = {
  organizeMode: 'project' as const,
  sortKey: 'updated_at' as const,
  collapsedSectionIds: [],
  collapsedGroupIds: [],
  pinnedConversationIds: ['pinned']
}

const conversations = [
  { id: 'oldest', title: 'Oldest', updatedAt: '2026-08-01T00:00:00.000Z' },
  {
    id: 'middle',
    threadId: 'thread-middle',
    title: 'Middle',
    updatedAt: '2026-08-02T00:00:00.000Z'
  },
  { id: 'pinned', title: 'Pinned', updatedAt: '2026-08-01T12:00:00.000Z' },
  { id: 'archived', title: 'Archived', archived: true, updatedAt: '2026-08-04T00:00:00.000Z' }
]

describe('taskNavigationForConversation', () => {
  it('uses the sidebar order, skips archived tasks, and stops at each boundary', () => {
    expect(
      taskNavigationForConversation({ conversationId: 'pinned', conversations, preferences })
    ).toEqual({ nextConversationId: 'middle' })
    expect(
      taskNavigationForConversation({ conversationId: 'middle', conversations, preferences })
    ).toEqual({ previousConversationId: 'pinned', nextConversationId: 'oldest' })
    expect(
      taskNavigationForConversation({ conversationId: 'oldest', conversations, preferences })
    ).toEqual({ previousConversationId: 'middle' })
    expect(
      taskNavigationForConversation({ conversationId: 'archived', conversations, preferences })
    ).toEqual({})
  })

  it('can resolve an active app-server thread id back to its sidebar task', () => {
    expect(
      taskNavigationForConversation({
        conversationId: 'thread-middle',
        conversations,
        preferences
      })
    ).toEqual({ previousConversationId: 'pinned', nextConversationId: 'oldest' })
  })
})
