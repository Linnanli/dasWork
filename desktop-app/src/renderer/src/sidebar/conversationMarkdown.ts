import type { UIMessage } from 'ai'

export function formatConversationMarkdown({
  title,
  messages
}: {
  title: string
  messages: readonly UIMessage[]
}): string {
  const sections = messages.flatMap((message) => {
    const text = message.parts
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join('\n')
      .trim()
    if (!text) return []
    return [`## ${roleLabel(message.role)}\n\n${text}`]
  })

  return [`# ${title}`, ...sections].join('\n\n').trimEnd() + '\n'
}

function roleLabel(role: UIMessage['role']): string {
  switch (role) {
    case 'user':
      return 'You'
    case 'assistant':
      return 'Codex'
    case 'system':
      return 'System'
  }
}
