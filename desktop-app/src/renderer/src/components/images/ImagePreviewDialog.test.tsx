// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatImage } from './ChatImage'
import { ImagePreviewProvider } from './ImagePreviewProvider'
import { useImagePreview } from './imagePreviewContext'
import type { ChatImageDescriptor } from './chatImageSource'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Gallery({
  images,
  hidden = false
}: {
  images: ChatImageDescriptor[]
  hidden?: boolean
}): React.JSX.Element {
  const preview = useImagePreview()
  return (
    <div>
      {!hidden &&
        images.map((image, index) => (
          <ChatImage
            key={image.id}
            image={image}
            onPreview={(_, trigger) => preview.open(images, index, trigger)}
          />
        ))}
    </div>
  )
}

function dispatchLoad(image: HTMLImageElement, width = 2000, height = 1000): void {
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true }
  })
  image.dispatchEvent(new Event('load'))
}

function pointer(element: HTMLElement, type: string, id: number, x: number, y: number): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0
  })
  Object.defineProperty(event, 'pointerId', { value: id })
  element.dispatchEvent(event)
}

describe('shared image preview', () => {
  let root: Root
  let container: HTMLDivElement
  let saveImage: ReturnType<typeof vi.fn>
  let sequence = 0
  const descriptor = (extra: Partial<ChatImageDescriptor> = {}): ChatImageDescriptor => ({
    id: `dialog-${++sequence}`,
    source: `/tmp/dialog-${sequence}.png`,
    sourceKind: 'native-path',
    alt: `图片 ${sequence}`,
    threadId: 'preview-thread',
    ...extra
  })
  const button = (label: string): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  const image = (): HTMLImageElement =>
    document.querySelector<HTMLImageElement>('[data-slot="image-preview-image"]')!
  const viewport = (): HTMLDivElement =>
    document.querySelector<HTMLDivElement>('[data-slot="image-preview-viewport"]')!
  const percent = (): number =>
    parseInt(document.querySelector('[data-slot="image-preview-zoom-percent"]')!.textContent!)

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 768, configurable: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    saveImage = vi.fn(async () => ({ status: 'saved', path: '/tmp/saved.png' }))
    window.desktopApp = {
      codex: {
        resolveImageSource: vi.fn(async ({ source }: { source: string }) => ({
          status: 'available',
          displaySrc: `app://fs/@fs${source}`
        })),
        saveImage
      }
    } as never
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const open = async (images: ChatImageDescriptor[], index = 0): Promise<HTMLButtonElement> => {
    await act(async () =>
      root.render(
        <ImagePreviewProvider>
          <Gallery images={images} />
        </ImagePreviewProvider>
      )
    )
    await act(async () => container.querySelectorAll('img').forEach((entry) => dispatchLoad(entry)))
    const trigger = container.querySelectorAll<HTMLButtonElement>('[data-chat-image-ready="true"]')[
      index
    ]
    trigger.focus()
    await act(async () => trigger.click())
    await act(async () => dispatchLoad(image()))
    return trigger
  }

  it('keeps loading images disabled and removes broken browser images on failure', async () => {
    const entry = descriptor()
    await act(async () =>
      root.render(
        <ImagePreviewProvider>
          <Gallery images={[entry]} />
        </ImagePreviewProvider>
      )
    )
    const trigger = container.querySelector<HTMLButtonElement>('button')!
    expect(trigger.disabled).toBe(true)
    expect(trigger.dataset.chatImageState).toBe('loading')
    act(() => container.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(container.querySelector('img')).toBeNull()
    expect(
      container.querySelector('[data-chat-image-state="unavailable"]')?.getAttribute('aria-label')
    ).toContain(entry.alt)
  })

  it('hides unresolved body images while keeping a fixed tool thumbnail position', async () => {
    let finish!: (value: unknown) => void
    const entry = descriptor()
    const resolve = vi.fn(
      () =>
        new Promise((next) => {
          finish = next
        })
    )
    window.desktopApp = { codex: { resolveImageSource: resolve, saveImage } } as never
    await act(async () =>
      root.render(
        <ImagePreviewProvider>
          <ChatImage image={entry} />
          <ChatImage image={entry} variant="thumbnail" />
        </ImagePreviewProvider>
      )
    )
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(container.querySelector('button')?.dataset.chatImageState).toBe('resolving')
    expect(container.querySelector('button')?.className).toContain('size-20')
    await act(async () =>
      finish({ status: 'available', displaySrc: `app://fs/@fs${entry.source}` })
    )
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('starts at the clicked gallery position, fits without upscaling and respects zoom boundaries', async () => {
    const images = [descriptor(), descriptor(), descriptor()]
    await open(images, 1)
    expect(image().src).toContain(images[1].source)
    expect(percent()).toBe(51)
    expect(button('上一张图片').disabled).toBe(false)
    await act(async () => button('放大图片').click())
    expect(percent()).toBe(67)
    for (let count = 0; count < 20; count++) act(() => button('放大图片').click())
    expect(percent()).toBe(500)
    expect(button('放大图片').disabled).toBe(true)
    act(() => button('适应窗口').click())
    expect(percent()).toBe(51)
    await act(async () => button('下一张图片').click())
    await act(async () => dispatchLoad(image(), 200, 100))
    expect(percent()).toBe(100)
    expect(button('下一张图片').disabled).toBe(true)
  })

  it('scopes navigation to the open dialog and leaves editable controls alone', async () => {
    const images = [descriptor(), descriptor()]
    await open(images)
    const dialog = document.querySelector<HTMLElement>('[data-slot="image-preview-dialog"]')!
    expect(button('上一张图片').disabled).toBe(true)
    const input = document.createElement('input')
    dialog.appendChild(input)
    act(() =>
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    expect(image().src).toContain(images[0].source)
    act(() =>
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    expect(image().src).toContain(images[1].source)
    await act(async () => dispatchLoad(image()))
    act(() =>
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    )
    expect(image().src).toContain(images[1].source)
  })

  it('closes with Escape and restores focus to the trigger', async () => {
    const trigger = await open([descriptor()])
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    )
    // Radix restores focus after its focus scope has unmounted.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    expect(document.querySelector('[data-slot="image-preview-dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('preserves a Ctrl-wheel pointer anchor and leaves ordinary wheel scrolling native', async () => {
    await open([descriptor()])
    act(() => button('适应窗口').click())
    const area = viewport()
    Object.defineProperties(area, {
      clientHeight: { value: 656, configurable: true },
      scrollHeight: { value: 2000, configurable: true }
    })
    const normal = new WheelEvent('wheel', {
      deltaY: 40,
      clientX: 400,
      clientY: 300,
      bubbles: true,
      cancelable: true
    })
    act(() => area.dispatchEvent(normal))
    // Modal scroll locking also observes this event; ordinary wheel must not change image zoom.
    expect(percent()).toBe(51)
    const ctrl = new WheelEvent('wheel', {
      deltaY: -200,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
      bubbles: true,
      cancelable: true
    })
    act(() => area.dispatchEvent(ctrl))
    expect(ctrl.defaultPrevented).toBe(true)
    expect(percent()).toBe(139)
    const before = 51.2
    const after = before * Math.E
    expect(area.scrollLeft).toBeCloseTo((400 * after) / before - 400)
  })

  it('supports one-pointer panning and two-pointer pinch zoom', async () => {
    await open([descriptor()])
    for (let count = 0; count < 5; count++) act(() => button('放大图片').click())
    const area = viewport()
    const oldScroll = area.scrollLeft
    act(() => {
      pointer(area, 'pointerdown', 1, 400, 300)
      pointer(area, 'pointermove', 1, 300, 250)
    })
    expect(area.scrollLeft).toBe(oldScroll + 100)
    const before = percent()
    act(() => {
      pointer(area, 'pointerdown', 2, 500, 250)
      pointer(area, 'pointermove', 2, 600, 250)
    })
    expect(percent()).toBeCloseTo(before * 1.5, 0)
    act(() => {
      pointer(area, 'pointerup', 1, 300, 250)
      pointer(area, 'pointerup', 2, 600, 250)
    })
  })

  it('refits on resize until the user chooses a zoom level', async () => {
    await open([descriptor()])
    Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true })
    act(() => window.dispatchEvent(new Event('resize')))
    expect(percent()).toBe(30)
    act(() => button('放大图片').click())
    expect(percent()).toBe(33)
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true })
    act(() => window.dispatchEvent(new Event('resize')))
    expect(percent()).toBe(33)
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true })
  })

  it('keeps an owned File alive after its trigger unmounts until preview closes', async () => {
    vi.useFakeTimers()
    const create = vi.fn(() => 'blob:preview-owned')
    const revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const images = [
      descriptor({ file: new File(['bytes'], 'owned.png', { type: 'image/png' }), source: 'owned' })
    ]
    await open(images)
    await act(async () =>
      root.render(
        <ImagePreviewProvider>
          <Gallery images={images} hidden />
        </ImagePreviewProvider>
      )
    )
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(document.querySelector('[data-slot="image-preview-dialog"]')).not.toBeNull()
    expect(image().src).toBe('blob:preview-owned')
    expect(revoke).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledTimes(1)
    await act(async () => button('关闭图片预览').click())
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:preview-owned')
  })

  it('saves the original source and category, reports failures and treats cancel as neutral', async () => {
    const entry = descriptor({ source: '/tmp/literal%20.png', sourceKind: 'native-path' })
    await open([entry])
    await act(async () => button('保存图片').click())
    expect(saveImage).toHaveBeenCalledWith({
      source: entry.source,
      sourceKind: 'native-path',
      threadId: 'preview-thread',
      conversationId: undefined,
      fileName: undefined
    })
    expect(document.querySelector('[role="status"]')?.textContent).toBe('图片已保存')
    saveImage.mockResolvedValueOnce({ status: 'failed', message: '连接中断' })
    await act(async () => button('保存图片').click())
    expect(document.querySelector('[role="status"]')?.textContent).toBe('连接中断')
    saveImage.mockResolvedValueOnce({ status: 'cancelled' })
    await act(async () => button('保存图片').click())
    expect(document.querySelector('[role="status"]')).toBeNull()
  })

  it('converts an owned File to its original MIME data only when save is clicked', async () => {
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => 'blob:save-owned'),
        revokeObjectURL: vi.fn()
      })
    )
    const read = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    const file = new File(['original pixels'], 'original.png', { type: 'image/png' })
    await open([descriptor({ source: 'owned file', file })])
    expect(read).not.toHaveBeenCalled()
    await act(async () => {
      button('保存图片').click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(read).toHaveBeenCalledExactlyOnceWith(file)
    expect(saveImage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'data:image/png;base64,b3JpZ2luYWwgcGl4ZWxz',
        sourceKind: 'media-url',
        fileName: 'original.png'
      })
    )
  })

  it('preserves close and gallery navigation when one image fails to decode', async () => {
    await open([descriptor(), descriptor()])
    act(() => image().dispatchEvent(new Event('error')))
    expect(document.querySelector('[data-slot="image-preview-image"]')).toBeNull()
    expect(button('保存图片').disabled).toBe(true)
    expect(button('下一张图片').disabled).toBe(false)
    await act(async () => button('下一张图片').click())
    await act(async () => dispatchLoad(image()))
    expect(button('保存图片').disabled).toBe(false)
  })
})
