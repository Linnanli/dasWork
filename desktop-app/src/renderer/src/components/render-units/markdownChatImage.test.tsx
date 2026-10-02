// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Streamdown } from 'streamdown'
import type { ChatImageProps } from '@/components/images'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChatImageConversationProvider,
  ChatImageMessageRootProvider
} from '@/components/conversation/chatImageConversationContext'
import { MarkdownChatImage, markdownImagesInMessage } from './markdownChatImage'
import { referenceUrlTransform } from '@/lib/referenceInlineTarget'
import { referenceInlineRehypePlugins } from '@/lib/referenceInlineMarkdown'

const preview = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }))
vi.mock('@/components/images', () => ({
  useImagePreview: () => preview,
  ChatImage: ({ image, onPreview }: ChatImageProps) => (
    <button
      data-chat-image-ready="true"
      data-source={image.source}
      onClick={(event) => onPreview?.(image, event.currentTarget)}
    >
      {image.alt}
    </button>
  )
}))

describe('Markdown chat image collection', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('uses real Markdown URL normalization and isolates galleries by message', async () => {
    const owner = { conversationId: 'old-conversation', threadId: 'old-thread' }
    const first = createRef<HTMLDivElement>()
    const second = createRef<HTMLDivElement>()
    await act(async () =>
      root.render(
        <ChatImageConversationProvider value={owner}>
          <ChatImageMessageRootProvider rootRef={first}>
            <div ref={first}>
              <Streamdown
                components={{ img: MarkdownChatImage }}
                urlTransform={referenceUrlTransform}
                rehypePlugins={referenceInlineRehypePlugins}
              >
                {
                  '![one](</tmp/中文 图.png>)\n\n![two](./literal%2520.png)\n\n![three](./hash%23mark.png)'
                }
              </Streamdown>
            </div>
          </ChatImageMessageRootProvider>
          <ChatImageMessageRootProvider rootRef={second}>
            <div ref={second}>
              <Streamdown
                components={{ img: MarkdownChatImage }}
                urlTransform={referenceUrlTransform}
                rehypePlugins={referenceInlineRehypePlugins}
              >
                {'![other](./other.png)'}
              </Streamdown>
            </div>
          </ChatImageMessageRootProvider>
        </ChatImageConversationProvider>
      )
    )
    const buttons = first.current!.querySelectorAll<HTMLButtonElement>('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]!.dataset.source).toBe('/tmp/%E4%B8%AD%E6%96%87%20%E5%9B%BE.png')
    expect(buttons[1]!.dataset.source).toBe('./literal%2520.png')
    act(() => buttons[1]!.click())
    const [images, index, trigger] = preview.open.mock.lastCall!
    expect(images.map((image) => image.alt)).toEqual(['one', 'two', 'three'])
    expect(
      images.every(
        (image) => image.threadId === 'old-thread' && image.sourceKind === 'markdown-url'
      )
    ).toBe(true)
    expect(index).toBe(1)
    expect(trigger).toBe(buttons[1])
    expect(images).toHaveLength(3)
  })

  it('collects only ready Markdown images in DOM order', () => {
    container.innerHTML = `
      <span data-markdown-image-preview-trigger data-chat-image-id="a" data-markdown-image-source="a.png"><button data-chat-image-ready="true"></button></span>
      <span data-markdown-image-preview-trigger data-chat-image-id="b" data-markdown-image-source="b.png"><button data-chat-image-ready="false"></button></span>
      <button data-chat-image-id="tool" data-chat-image-ready="true"></button>
      <span data-markdown-image-preview-trigger data-chat-image-id="c" data-markdown-image-source="c.png"><button data-chat-image-ready="true"></button></span>`
    expect(markdownImagesInMessage(container, { threadId: 't' }).map((image) => image.id)).toEqual([
      'a',
      'c'
    ])
  })

  it('preserves a Windows backslash path through the real Markdown URL pipeline', async () => {
    await act(async () =>
      root.render(
        <Streamdown
          components={{ img: MarkdownChatImage }}
          urlTransform={referenceUrlTransform}
          rehypePlugins={referenceInlineRehypePlugins}
        >
          {String.raw`![windows](<C:\images\a.png>)`}
        </Streamdown>
      )
    )
    expect(container.querySelector<HTMLButtonElement>('button')?.dataset.source).toBe(
      'C:%5Cimages%5Ca.png'
    )
  })
})
