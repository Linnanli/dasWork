// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatImageConversationProvider } from '@/components/conversation/chatImageConversationContext'
import { buildAssistantRenderUnits, type AssistantRenderUnit } from '@/lib/assistantRenderUnits'
import { ImageViewActivity } from './imageViewActivity'
import type { ChatImageProps } from '@/components/images'

const state = vi.hoisted(() => ({ images: vi.fn(), open: vi.fn() }))
vi.mock('@assistant-ui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useScrollLock: () => () => {}
}))
vi.mock('@/components/images', () => ({
  useImagePreview: () => ({ open: state.open }),
  ChatImage: ({ image, variant, onPreview }: ChatImageProps) => {
    state.images(image, variant)
    return (
      <button data-image-id={image.id} onClick={(event) => onPreview?.(image, event.currentTarget)}>
        {image.alt}
      </button>
    )
  }
}))

function imageGroup(): Extract<AssistantRenderUnit, { type: 'tool-group' }> {
  const model = buildAssistantRenderUnits({
    content: [],
    parts: ['one', 'two'].map((id) => ({
      type: 'tool-codex_image_view',
      toolCallId: id,
      state: 'output-available',
      input: { path: '/tmp/literal%20.png' },
      output: { type: 'imageView', id, path: '/tmp/literal%20.png' }
    })),
    status: { type: 'complete' }
  })
  const group = model.units
    .flatMap((unit) => (unit.type === 'reasoning-group' ? unit.children : [unit]))
    .find((unit) => unit.type === 'tool-group')
  if (!group || group.type !== 'tool-group') throw new Error('fixture missing image group')
  return group
}

describe('Agent image view record', () => {
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

  it('reads only after expansion and keeps same-path calls in the ordered gallery', () => {
    act(() =>
      root.render(
        <ChatImageConversationProvider value={{ conversationId: 'c', threadId: 't' }}>
          <ImageViewActivity unit={imageGroup()} />
        </ChatImageConversationProvider>
      )
    )
    expect(container.textContent).toContain('已查看 2 张图片')
    expect(state.images).not.toHaveBeenCalled()
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="tool-group-trigger"]')!
    act(() => trigger.click())
    expect(state.images).toHaveBeenCalledTimes(2)
    expect(
      state.images.mock.calls.every(
        ([image, variant]) =>
          image.sourceKind === 'native-path' &&
          image.source === '/tmp/literal%20.png' &&
          image.threadId === 't' &&
          variant === 'thumbnail'
      )
    ).toBe(true)
    const images = container.querySelectorAll<HTMLButtonElement>('[data-image-id]')
    act(() => images[1]!.click())
    expect(state.open.mock.lastCall![0]).toHaveLength(2)
    expect(state.open.mock.lastCall![1]).toBe(1)
    expect(state.open.mock.lastCall![0][0].id).not.toBe(state.open.mock.lastCall![0][1].id)
    act(() => trigger.click())
    expect(container.querySelector('[data-slot="image-view-images"]')).toBeNull()
    expect(container.textContent).toContain('已查看 2 张图片')
  })
})
