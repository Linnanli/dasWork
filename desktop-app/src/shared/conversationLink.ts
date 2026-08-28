export type ConversationLink = {
  conversationId: string
}

const protocol = 'dascowork:'
const conversationHost = 'conversation'

export function createConversationLink(conversationId: string): string {
  return `dascowork://${conversationHost}/${encodeURIComponent(conversationId)}`
}

export function parseConversationLink(value: string): ConversationLink | null {
  try {
    const url = new URL(value)
    if (url.protocol !== protocol || url.hostname !== conversationHost) return null
    if (url.search || url.hash) return null

    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 1) return null

    const conversationId = decodeURIComponent(segments[0]!)
    if (!conversationId || conversationId.length > 512 || hasControlCharacter(conversationId)) {
      return null
    }
    return { conversationId }
  } catch {
    return null
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
