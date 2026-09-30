// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@assistant-ui/react'
import { ImagePreviewProvider, type ChatImageDescriptor } from '@/components/images'
import { ComposerAttachments, UserMessageAttachments } from './attachment'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fixture = vi.hoisted(() => ({
  composer: [] as Attachment[],
  message: [] as Attachment[],
  source: 'composer' as 'composer' | 'message',
  openPreview: vi.fn(),
  remove: vi.fn(),
  realImages: false
}))

vi.mock('@assistant-ui/react', async () => {
  const React = await import('react')
  const AttachmentContext = React.createContext<Attachment | undefined>(undefined)
  const currentState = (attachment?: Attachment): unknown => ({
    attachment,
    composer: { attachments: fixture.composer },
    get message() {
      if (fixture.source === 'composer') throw new Error('Composer has no message scope')
      return { role: 'user', attachments: fixture.message }
    }
  })
  const Attachments = ({ children }: { children: () => React.ReactNode }): React.ReactNode =>
    (fixture.source === 'composer' ? fixture.composer : fixture.message).map((attachment) => (
      <AttachmentContext.Provider value={attachment} key={attachment.id}>
        {children()}
      </AttachmentContext.Provider>
    ))
  return {
    useAui: () => ({ attachment: { source: fixture.source } }),
    useAuiState: (selector: (state: unknown) => unknown) =>
      selector(currentState(React.useContext(AttachmentContext))),
    AttachmentPrimitive: {
      Root: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
        <div {...props}>{children}</div>
      ),
      unstable_Thumb: ({ className }: { className?: string }) => (
        <span className={className}>文件</span>
      ),
      Name: () => <span>{React.useContext(AttachmentContext)?.name}</span>,
      Remove: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) => {
        const attachment = React.useContext(AttachmentContext)
        return React.cloneElement(children, { onClick: () => fixture.remove(attachment?.id) })
      }
    },
    ComposerPrimitive: { Attachments },
    MessagePrimitive: { Attachments }
  }
})

vi.mock('@/components/images', async () => {
  const actual = await vi.importActual<typeof import('@/components/images')>('@/components/images')
  return {
    ...actual,
    useImagePreview: () =>
      fixture.realImages ? actual.useImagePreview() : { open: fixture.openPreview },
    ChatImage: (props: {
      image: ChatImageDescriptor
      onPreview: (image: ChatImageDescriptor, trigger: HTMLButtonElement) => void
    }) =>
      fixture.realImages ? (
        <actual.ChatImage {...props} />
      ) : (
        <button
          type="button"
          aria-label={`预览 ${props.image.alt}`}
          onClick={(event) => props.onPreview(props.image, event.currentTarget)}
        >
          <img src={props.image.file ? undefined : props.image.source} alt={props.image.alt} />
        </button>
      )
  }
})

vi.mock('@/components/conversation/chatImageConversationContext', () => ({
  useChatImageConversation: () => ({ conversationId: 'conversation-a', threadId: 'thread-a' })
}))

function image(
  id: string,
  source: string,
  status: Attachment['status'] = { type: 'complete' }
): Attachment {
  return {
    id,
    type: 'image',
    name: `${id}.png`,
    contentType: 'image/png',
    status,
    content: [{ type: 'image', image: source }]
  } as Attachment
}

describe('attachment shared image preview integration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    fixture.composer = []
    fixture.message = []
    fixture.source = 'composer'
    fixture.openPreview.mockClear()
    fixture.remove.mockClear()
    fixture.realImages = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('previews only current composer images with the selected index and thread owner', () => {
    fixture.composer = [
      image('first', 'app://fs/@fs/first.png'),
      {
        id: 'document',
        type: 'file',
        name: 'notes.txt',
        status: { type: 'complete' },
        content: []
      },
      image('second', 'data:image/png;base64,AA==')
    ]
    fixture.message = [image('other-message', 'data:image/png;base64,AA==')]
    act(() => root.render(<ComposerAttachments />))

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="预览 second.png"]'
    )!
    act(() => trigger.click())

    expect(fixture.openPreview).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          id: 'first',
          sourceKind: 'media-url',
          conversationId: 'conversation-a',
          threadId: 'thread-a'
        }),
        expect.objectContaining({ id: 'second', sourceKind: 'media-url' })
      ],
      1,
      trigger
    )
    expect(container.querySelectorAll('.aui-attachment-tile')).toHaveLength(3)
    expect(container.querySelectorAll('.aui-attachment-tile-remove')).toHaveLength(3)
    expect(container.querySelector('button button')).toBeNull()
  })

  it('uses current sent-message images and keeps remove controls composer-only', () => {
    fixture.source = 'message'
    fixture.composer = [image('composer-only', 'data:image/png;base64,AA==')]
    fixture.message = [image('sent-a', 'app://fs/@fs/a.png'), image('sent-b', 'app://fs/@fs/b.png')]
    act(() => root.render(<UserMessageAttachments />))

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="预览 sent-a.png"]'
    )!
    act(() => trigger.click())

    expect(
      fixture.openPreview.mock.calls[0][0].map((entry: ChatImageDescriptor) => entry.id)
    ).toEqual(['sent-a', 'sent-b'])
    expect(container.querySelectorAll('.aui-attachment-tile-remove')).toHaveLength(0)
  })

  it('passes the original File into the preview snapshot when the composer attachment is removed', () => {
    const file = new File(['original image bytes'], 'clipboard.png', { type: 'image/png' })
    fixture.composer = [
      {
        ...image('clipboard', ''),
        file,
        status: { type: 'requires-action', reason: 'composer-send' }
      }
    ]
    act(() => root.render(<ComposerAttachments />))
    act(() =>
      container.querySelector<HTMLButtonElement>('button[aria-label="预览 clipboard.png"]')!.click()
    )
    const descriptors = fixture.openPreview.mock.calls[0][0] as ChatImageDescriptor[]

    act(() => container.querySelector<HTMLButtonElement>('.aui-attachment-tile-remove')!.click())
    expect(fixture.remove).toHaveBeenCalledWith('clipboard')
    fixture.composer = []
    act(() => root.render(<ComposerAttachments />))

    expect(descriptors[0].file).toBe(file)
    expect(descriptors[0].file?.type).toBe('image/png')
    expect(container.querySelector('.aui-attachment-tile')).toBeNull()
  })

  it('retains the File URL in the real shared preview after the attachment unmounts and releases it after close', () => {
    fixture.realImages = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const createObjectURL = vi.fn(() => 'blob:preview-lifetime')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    const file = new File(['original pixels'], 'owned-preview.png', { type: 'image/png' })
    fixture.composer = [{ ...image('owned-preview', ''), name: file.name, file }]
    act(() =>
      root.render(
        <ImagePreviewProvider>
          <ComposerAttachments />
        </ImagePreviewProvider>
      )
    )
    act(() => container.querySelector<HTMLImageElement>('img')!.dispatchEvent(new Event('load')))
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="预览owned-preview.png"]')!
        .click()
    )

    fixture.composer = []
    act(() =>
      root.render(
        <ImagePreviewProvider>
          <ComposerAttachments />
        </ImagePreviewProvider>
      )
    )
    act(() => vi.advanceTimersByTime(20_000))

    const dialog = document.querySelector<HTMLElement>('[data-slot="image-preview-dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:preview-lifetime')
    expect(createObjectURL).toHaveBeenCalledExactlyOnceWith(file)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭图片预览"]')!.click())
    act(() => vi.advanceTimersByTime(16_000))
    expect(document.querySelector('[data-slot="image-preview-dialog"]')).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:preview-lifetime')
  })

  it('keeps attachment checking and send errors separate from image rendering', () => {
    fixture.composer = [
      image('checking', 'app://fs/@fs/a.png', {
        type: 'running',
        reason: 'uploading',
        progress: 0
      }),
      image('failed', 'app://fs/@fs/b.png', { type: 'incomplete', reason: 'error' })
    ]
    act(() => root.render(<ComposerAttachments />))

    expect(container.querySelectorAll('.aui-attachment-tile-uploading')).toHaveLength(1)
    expect(container.querySelectorAll('.aui-attachment-tile-error')).toHaveLength(1)
    expect(
      container.querySelector('[data-attachment-name="checking.png"]')?.getAttribute('aria-label')
    ).toContain('正在检查')
    expect(
      container.querySelector('[data-attachment-name="failed.png"]')?.getAttribute('aria-label')
    ).toContain('附件不可用')
    expect(container.querySelectorAll('.aui-attachment-tile-remove')).toHaveLength(2)
  })
})
