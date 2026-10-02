/* eslint-disable react-refresh/only-export-components -- the DOM collector belongs to this image renderer. */
import { useId, useMemo, type ComponentProps } from 'react'
import { ChatImage, useImagePreview, type ChatImageDescriptor } from '@/components/images'
import {
  useChatImageConversation,
  useChatImageMessageRoot,
  type ChatImageConversation
} from '@/components/conversation/chatImageConversationContext'

export function markdownImagesInMessage(
  root: HTMLElement,
  owner: ChatImageConversation
): ChatImageDescriptor[] {
  return [...root.querySelectorAll<HTMLElement>('[data-markdown-image-preview-trigger]')].flatMap(
    (element) => {
      if (!element.querySelector('[data-chat-image-ready="true"]')) return []
      const { chatImageId, markdownImageSource, markdownImageAlt, markdownImageTitle } =
        element.dataset
      if (!chatImageId || !markdownImageSource) return []
      return [
        {
          id: chatImageId,
          source: markdownImageSource,
          sourceKind: 'markdown-url' as const,
          ...owner,
          ...(markdownImageAlt ? { alt: markdownImageAlt } : {}),
          ...(markdownImageTitle ? { title: markdownImageTitle } : {})
        }
      ]
    }
  )
}

export function MarkdownChatImage(
  props: ComponentProps<'img'> | (Record<string, unknown> & { node?: unknown })
): React.JSX.Element {
  const src = typeof props.src === 'string' ? props.src : ''
  const alt = typeof props.alt === 'string' ? props.alt : undefined
  const title = typeof props.title === 'string' ? props.title : undefined
  const id = useId()
  const owner = useChatImageConversation()
  const rootRef = useChatImageMessageRoot()
  const preview = useImagePreview()
  const source = typeof src === 'string' ? src : ''
  const image = useMemo<ChatImageDescriptor>(
    () => ({ id, source, sourceKind: 'markdown-url', ...owner, alt, title }),
    [alt, id, owner, source, title]
  )

  return (
    <span
      data-markdown-image-preview-trigger=""
      data-chat-image-id={id}
      data-markdown-image-source={source}
      data-markdown-image-alt={alt}
      data-markdown-image-title={title}
      className="block"
    >
      <ChatImage
        image={image}
        variant="body"
        hideWhileResolving
        onPreview={(selected, trigger) => {
          const images = rootRef?.current ? markdownImagesInMessage(rootRef.current, owner) : []
          const index = images.findIndex((candidate) => candidate.id === selected.id)
          preview.open(index < 0 ? [selected] : images, index < 0 ? 0 : index, trigger)
        }}
      />
    </span>
  )
}
