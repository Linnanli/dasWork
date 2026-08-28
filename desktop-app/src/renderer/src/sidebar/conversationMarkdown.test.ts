import { describe, expect, it } from 'vitest'

import { formatConversationMarkdown } from './conversationMarkdown'

describe('formatConversationMarkdown', () => {
  it('exports readable text turns without copying hidden non-text payloads', () => {
    expect(
      formatConversationMarkdown({
        title: 'Implement the menu',
        messages: [
          {
            id: 'user-1',
            role: 'user',
            parts: [{ type: 'text', text: 'Add a task menu.' }]
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            parts: [
              { type: 'text', text: 'I will add it.' },
              {
                type: 'dynamic-tool',
                toolName: 'shell',
                toolCallId: 'call-1',
                state: 'output-available',
                input: null,
                output: null
              }
            ]
          }
        ]
      })
    ).toBe('# Implement the menu\n\n## You\n\nAdd a task menu.\n\n## Codex\n\nI will add it.\n')
  })
})
