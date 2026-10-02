/* eslint-disable react-refresh/only-export-components -- providers and hooks share the message image scope. */
import { createContext, useContext, type ReactNode, type RefObject } from 'react'

export type ChatImageConversation = { conversationId?: string; threadId?: string }

const ChatImageConversationContext = createContext<ChatImageConversation>({})
const ChatImageMessageRootContext = createContext<RefObject<HTMLDivElement | null> | null>(null)

export function ChatImageConversationProvider({
  value,
  children
}: {
  value: ChatImageConversation
  children: ReactNode
}): React.JSX.Element {
  return (
    <ChatImageConversationContext.Provider value={value}>
      {children}
    </ChatImageConversationContext.Provider>
  )
}

export function useChatImageConversation(): ChatImageConversation {
  return useContext(ChatImageConversationContext)
}

export function ChatImageMessageRootProvider({
  rootRef,
  children
}: {
  rootRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}): React.JSX.Element {
  return (
    <ChatImageMessageRootContext.Provider value={rootRef}>
      {children}
    </ChatImageMessageRootContext.Provider>
  )
}

export function useChatImageMessageRoot(): RefObject<HTMLDivElement | null> | null {
  return useContext(ChatImageMessageRootContext)
}
