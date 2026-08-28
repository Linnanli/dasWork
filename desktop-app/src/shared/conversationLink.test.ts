import { describe, expect, it } from 'vitest'

import { createConversationLink, parseConversationLink } from './conversationLink'

describe('conversation links', () => {
  it('round-trips a task id and rejects malformed or unrelated URLs', () => {
    const link = createConversationLink('thread / with spaces')

    expect(link).toBe('dascowork://conversation/thread%20%2F%20with%20spaces')
    expect(parseConversationLink(link)).toEqual({ conversationId: 'thread / with spaces' })
    expect(parseConversationLink('https://example.test/conversation/thread-1')).toBeNull()
    expect(parseConversationLink('dascowork://conversation/thread-1?unsafe=true')).toBeNull()
    expect(parseConversationLink('dascowork://conversation/thread-1/extra')).toBeNull()
  })
})
