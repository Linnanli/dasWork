import { useCallback } from 'react'
import { PencilIcon } from 'lucide-react'

import { Button } from '../components/ui/button'
import { ConversationRow } from './ConversationRow'
import type { SidebarConversationView } from './sidebarTypes'
import type { ConversationStateController } from './useConversationState'

export function SidebarChatsSection({
  quickChats,
  chronologicalChats,
  showChronological,
  nativeBackdrop,
  conversationState,
  onNewQuickChat,
  onOpenConversation
}: {
  quickChats: SidebarConversationView[]
  chronologicalChats: SidebarConversationView[]
  showChronological: boolean
  nativeBackdrop: boolean
  conversationState: ConversationStateController
  onNewQuickChat: () => void
  onOpenConversation?: (conversationId: string) => void
}): React.JSX.Element {
  const chats = showChronological ? chronologicalChats : quickChats
  const quickChatActionLabel = 'New quick chat'
  const { openConversation: openConversationInRuntime } = conversationState
  const openConversation = useCallback(
    (conversationId: string) => {
      if (onOpenConversation) {
        onOpenConversation(conversationId)
        return
      }
      void openConversationInRuntime({ conversationId })
    },
    [onOpenConversation, openConversationInRuntime]
  )
  return (
    <section
      className="min-w-0 space-y-1"
      aria-label={showChronological ? 'Recent chats' : 'Quick chats'}
    >
      <div className="group flex min-w-0 items-center justify-between pl-2 text-[11px] text-muted-foreground uppercase">
        <span className="min-w-0 truncate">
          {showChronological ? 'Recent chats' : 'Quick chats'}
        </span>
        {!showChronological ? (
          <Button
            aria-label={quickChatActionLabel}
            className="pointer-events-none shrink-0 text-muted-foreground opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100"
            size="icon-xs"
            title={quickChatActionLabel}
            type="button"
            variant="ghost"
            onClick={onNewQuickChat}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <div className="min-w-0 space-y-0.5">
        {chats.length === 0 ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            {showChronological ? 'No recent chats' : 'No quick chats'}
          </div>
        ) : (
          chats.map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              nativeBackdrop={nativeBackdrop}
              onOpenConversation={openConversation}
            />
          ))
        )}
      </div>
    </section>
  )
}
