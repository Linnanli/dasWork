// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatImageDescriptor } from '@/components/images'
import type { AssistantRenderUnit } from '@/lib/assistantRenderUnits'
import { SpecialEntryRenderer, UnknownPartRenderer } from './renderUnitDetails'
import { ChatImageService } from '../../../../main/chatImages/ChatImageService'
import type { ChatImageRequest } from '../../../../shared/chatImageApi'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const fixture = vi.hoisted(() => ({
  open: vi.fn(),
  rendered: [] as ChatImageDescriptor[],
  realImages: false
}))

vi.mock('@/components/images', async () => {
  const actual = await vi.importActual<typeof import('@/components/images')>('@/components/images')
  return {
    useImagePreview: () => ({ open: fixture.open }),
    ChatImage: ({
      image,
      onPreview
    }: {
      image: ChatImageDescriptor
      onPreview: (image: ChatImageDescriptor, trigger: HTMLButtonElement) => void
    }) => {
      fixture.rendered.push(image)
      if (fixture.realImages) return <actual.ChatImage image={image} onPreview={onPreview} />
      return (
        <button
          type="button"
          aria-label={`预览 ${image.alt}`}
          onClick={(event) => onPreview(image, event.currentTarget)}
        >
          图片
        </button>
      )
    }
  }
})

vi.mock('@/components/conversation/chatImageConversationContext', () => ({
  useChatImageConversation: () => ({ conversationId: 'conversation', threadId: 'thread' })
}))

describe('generated image shared preview integration', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    fixture.open.mockClear()
    fixture.rendered = []
    fixture.realImages = false
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('retains four visible thumbnails, full image count and all images in the shared gallery', () => {
    const images = Array.from({ length: 5 }, (_, index) => ({
      src: `data:image/png;base64,${index}A==`,
      alt: `方案 ${index + 1}`
    }))
    act(() => root.render(<SpecialEntryRenderer unit={generationUnit({ images })} />))
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="预览 方案 3"]')!
    act(() => trigger.click())

    expect(container.textContent).toContain('已生成 5 张图片')
    expect(container.querySelectorAll('[data-slot="generated-image-gallery"] button')).toHaveLength(
      4
    )
    expect(container.textContent).toContain('+1')
    const descriptors = fixture.open.mock.calls[0][0] as ChatImageDescriptor[]
    expect(descriptors.map((image) => image.alt)).toEqual([
      '方案 1',
      '方案 2',
      '方案 3',
      '方案 4',
      '方案 5'
    ])
    expect(descriptors[2]).toMatchObject({
      conversationId: 'conversation',
      threadId: 'thread',
      sourceKind: 'media-url'
    })
    expect(fixture.open.mock.calls[0].slice(1)).toEqual([2, trigger])
    expect(container.querySelector('[data-slot="generated-image-preview"]')).toBeNull()
  })

  it('keeps pending generation text and does not open a preview without a source', () => {
    act(() => root.render(<SpecialEntryRenderer unit={generationUnit({ images: [] })} />))

    expect(container.textContent).toContain('正在生成图片')
    expect(container.textContent).toContain('等待图片')
    expect(fixture.rendered).toHaveLength(0)
    expect(fixture.open).not.toHaveBeenCalled()
  })

  it('sends local paths and media URLs to the typed resolver instead of assigning raw DOM sources', () => {
    act(() =>
      root.render(
        <SpecialEntryRenderer
          unit={generationUnit({
            images: [
              { savedPath: '/repo/generated output.png', alt: '本地图片' },
              { url: 'app://fs/@fs/repo/image.png', alt: '媒体图片' },
              { url: 'https://example.test/image.png', alt: '远程图片' },
              { src: 'AA==', alt: '旧 base64 图片' }
            ]
          })}
        />
      )
    )

    expect(fixture.rendered.map(({ source, sourceKind }) => ({ source, sourceKind }))).toEqual([
      { source: '/repo/generated output.png', sourceKind: 'native-path' },
      { source: 'app://fs/@fs/repo/image.png', sourceKind: 'media-url' },
      { source: 'https://example.test/image.png', sourceKind: 'media-url' },
      { source: 'data:image/png;base64,AA==', sourceKind: 'media-url' }
    ])
    expect(container.querySelector('img')).toBeNull()
  })

  it('does not promote unowned blob or non-image data into directly renderable image sources', () => {
    act(() =>
      root.render(
        <SpecialEntryRenderer
          unit={generationUnit({
            images: [
              { src: 'blob:foreign-owner', alt: 'Blob' },
              { src: 'data:text/html;base64,PGgxPg==', alt: 'HTML' }
            ]
          })}
        />
      )
    )

    expect(fixture.rendered.map((image) => image.source)).toEqual([
      'blob:foreign-owner',
      'data:text/html;base64,PGgxPg=='
    ])
    expect(fixture.rendered.every((image) => image.sourceKind === 'media-url' && !image.file)).toBe(
      true
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('classifies file and sandbox URLs for one decode through the real shared source hook and Main resolver', async () => {
    fixture.realImages = true
    const statFile = vi.fn(async (path: string) => ({
      isFile: () =>
        [
          '/repo/file%20.png',
          '/repo/sandbox image.png',
          '/repo/native%20.png',
          '/repo/media.png'
        ].includes(path)
    }))
    const service = new ChatImageService({
      platform: 'darwin',
      statFile,
      projectService: {
        resolveExistingThreadTarget: vi.fn(async () => ({
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo'],
          workspaceKind: 'project' as const
        }))
      }
    })
    service.bindThread('conversation', 'thread')
    const resolveImageSource = vi.fn((request: ChatImageRequest) =>
      service.resolveImageSource(request)
    )
    window.desktopApp = { codex: { resolveImageSource } } as never
    const images = [
      { url: 'file:///repo/file%2520.png', alt: 'file URL' },
      { src: 'sandbox:/repo/sandbox%20image.png', alt: 'sandbox URL' },
      { savedPath: '/repo/native%20.png', alt: 'native path' },
      { src: 'app://fs/@fs/repo/media.png', alt: 'media URL' }
    ]
    await act(async () => {
      root.render(<SpecialEntryRenderer unit={generationUnit({ images })} />)
      await Promise.resolve()
    })

    expect(
      resolveImageSource.mock.calls.map(([request]) => ({
        source: request.source,
        sourceKind: request.sourceKind
      }))
    ).toEqual([
      { source: 'file:///repo/file%2520.png', sourceKind: 'markdown-url' },
      { source: 'sandbox:/repo/sandbox%20image.png', sourceKind: 'markdown-url' },
      { source: '/repo/native%20.png', sourceKind: 'native-path' },
      { source: 'app://fs/@fs/repo/media.png', sourceKind: 'media-url' }
    ])
    expect(statFile.mock.calls.map(([path]) => path)).toEqual([
      '/repo/file%20.png',
      '/repo/sandbox image.png',
      '/repo/native%20.png',
      '/repo/media.png'
    ])
    expect(
      [...container.querySelectorAll('img')].map((image) => image.getAttribute('src'))
    ).toEqual([
      'app://fs/@fs/repo/file%2520.png',
      'app://fs/@fs/repo/sandbox%20image.png',
      'app://fs/@fs/repo/native%2520.png',
      'app://fs/@fs/repo/media.png'
    ])
  })

  it('uses the same gallery for generated file parts with original image MIME', () => {
    const part = { type: 'file', mediaType: 'image/webp', data: 'AA==', name: 'output.webp' }
    const unit: Extract<AssistantRenderUnit, { type: 'unknown' }> = {
      type: 'unknown',
      key: 'generated-file',
      target: { id: 'generated-file', itemIds: ['generated-file'] },
      partIndex: 0,
      partIndices: [0],
      part
    }
    act(() => root.render(<UnknownPartRenderer part={part} unit={unit} />))

    expect(container.textContent).toContain('已生成图片')
    expect(fixture.rendered[0]).toMatchObject({
      source: 'data:image/webp;base64,AA==',
      alt: 'output.webp',
      sourceKind: 'media-url'
    })
  })
})

function generationUnit(
  item: Record<string, unknown>
): Extract<AssistantRenderUnit, { type: 'entry' }> {
  return {
    type: 'entry',
    key: 'generation',
    target: { id: 'generation', itemIds: ['generation'] },
    partIndex: 0,
    partIndices: [0],
    part: { type: 'imageGeneration' },
    itemType: 'imageGeneration',
    renderMode: 'custom',
    item: { id: 'generation', ...item }
  }
}
