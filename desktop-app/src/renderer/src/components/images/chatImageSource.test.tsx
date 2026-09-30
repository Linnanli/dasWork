// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatImageSourceKey,
  isSafeDirectImageSource,
  useChatImageSource,
  type ChatImageDescriptor
} from './chatImageSource'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type SourceResult = ReturnType<typeof useChatImageSource>
const snapshots = new Map<string, SourceResult>()
function Probe({ image, name = 'default' }: { image: ChatImageDescriptor; name?: string }): null {
  snapshots.set(name, useChatImageSource(image))
  return null
}

describe('chat image sources', () => {
  let root: Root
  let container: HTMLDivElement
  let resolveImageSource: ReturnType<typeof vi.fn>
  let unique = 0
  const descriptor = (extra: Partial<ChatImageDescriptor> = {}): ChatImageDescriptor => ({
    id: `image-${++unique}`,
    source: `/tmp/image-${unique}.png`,
    sourceKind: 'native-path',
    ...extra
  })

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resolveImageSource = vi.fn(async ({ source }: { source: string }) => ({
      status: 'available',
      displaySrc: `app://fs/@fs${source}`
    }))
    window.desktopApp = { codex: { resolveImageSource } } as never
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
      await vi.runAllTimersAsync()
    })
    container.remove()
    snapshots.clear()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shares concurrent sources and ignores 50 text-only descriptor recreations', async () => {
    const image = descriptor({ threadId: 'stable-thread' })
    await act(async () =>
      root.render(
        <>
          <Probe image={image} />
          <Probe image={{ ...image, id: 'second' }} name="second" />
        </>
      )
    )
    expect(resolveImageSource).toHaveBeenCalledTimes(1)
    expect(snapshots.get('default')?.status).toBe('loading')
    for (let token = 0; token < 50; token++) {
      await act(async () =>
        root.render(
          <>
            <Probe image={{ ...image, alt: `token ${token}` }} />
            <Probe image={{ ...image, id: 'second' }} name="second" />
          </>
        )
      )
    }
    expect(resolveImageSource).toHaveBeenCalledTimes(1)
    act(() => snapshots.get('default')?.onLoad())
    expect(snapshots.get('second')?.status).toBe('ready')
  })

  it('releases entries created by a render that never subscribes', async () => {
    const image = descriptor()
    const timers = vi.getTimerCount()
    renderToString(<Probe image={image} />)
    expect(resolveImageSource).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(timers + 1)
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => root.render(<Probe image={image} />))
    expect(resolveImageSource).toHaveBeenCalledTimes(1)
  })

  it('keeps owners and source categories out of each other’s cache', async () => {
    const image = descriptor({ source: 'same.png', sourceKind: 'markdown-url', threadId: 'first' })
    await act(async () =>
      root.render(
        <>
          <Probe image={image} />
          <Probe image={{ ...image, threadId: 'second' }} name="second" />
          <Probe image={{ ...image, sourceKind: 'native-path' }} name="third" />
        </>
      )
    )
    expect(resolveImageSource).toHaveBeenCalledTimes(3)
    expect(chatImageSourceKey(image)).not.toBe(
      chatImageSourceKey({ ...image, conversationId: 'different' })
    )
  })

  it('prevents old async results from replacing a newly selected source', async () => {
    let settleOld!: (value: unknown) => void
    const old = descriptor()
    const next = descriptor()
    resolveImageSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleOld = resolve
        })
    )
    await act(async () => root.render(<Probe image={old} />))
    expect(snapshots.get('default')?.status).toBe('resolving')
    await act(async () => root.render(<Probe image={next} />))
    const current = snapshots.get('default')?.displaySrc
    await act(async () => settleOld({ status: 'available', displaySrc: 'app://fs/@fs/old.png' }))
    expect(snapshots.get('default')?.displaySrc).toBe(current)
  })

  it('does not retry failures on text changes but permits an explicit retry', async () => {
    const image = descriptor()
    resolveImageSource.mockResolvedValueOnce({ status: 'unavailable', reason: 'missing-file' })
    await act(async () => root.render(<Probe image={image} />))
    expect(snapshots.get('default')?.reason).toBe('missing-file')
    await act(async () => root.render(<Probe image={{ ...image, title: 'new token' }} />))
    expect(resolveImageSource).toHaveBeenCalledTimes(1)
    await act(async () => snapshots.get('default')?.retry())
    expect(resolveImageSource).toHaveBeenCalledTimes(2)
    expect(snapshots.get('default')?.status).toBe('loading')
    act(() => snapshots.get('default')?.onError())
    expect(snapshots.get('default')?.status).toBe('unavailable')
  })

  it('retains successful sources for 15 seconds after the last consumer leaves', async () => {
    const image = descriptor()
    await act(async () => root.render(<Probe image={image} />))
    act(() => root.render(null))
    await act(async () => vi.advanceTimersByTimeAsync(14_999))
    await act(async () => root.render(<Probe image={image} />))
    expect(resolveImageSource).toHaveBeenCalledTimes(1)
    act(() => root.render(null))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    await act(async () => root.render(<Probe image={image} />))
    expect(resolveImageSource).toHaveBeenCalledTimes(2)
  })

  it('creates and releases only its owned File URL without reading File bytes', async () => {
    const create = vi.fn(() => 'blob:owned-image')
    const revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    const image = descriptor({
      source: 'file-label',
      sourceKind: 'media-url',
      file: new File(['pixels'], 'photo.png', { type: 'image/png' })
    })
    await act(async () =>
      root.render(
        <>
          <Probe image={image} />
          <Probe image={image} name="second" />
        </>
      )
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(resolveImageSource).not.toHaveBeenCalled()
    expect(snapshots.get('default')?.displaySrc).toBe('blob:owned-image')
    act(() => root.render(<Probe image={image} />))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(revoke).not.toHaveBeenCalled()
    act(() => root.render(null))
    await act(async () => vi.advanceTimersByTimeAsync(15_000))
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-image')
  })

  it('rejects arbitrary blobs and unsafe Main-returned display sources', async () => {
    const blob = descriptor({ source: 'blob:unowned', sourceKind: 'media-url' })
    await act(async () => root.render(<Probe image={blob} />))
    expect(resolveImageSource).not.toHaveBeenCalled()
    expect(snapshots.get('default')?.status).toBe('unavailable')
    resolveImageSource.mockResolvedValueOnce({
      status: 'available',
      displaySrc: 'javascript:alert(1)'
    })
    await act(async () => root.render(<Probe image={descriptor()} />))
    expect(snapshots.get('default')?.status).toBe('unavailable')
  })

  it.each([
    ['https://example.test/picture.png', true],
    ['http://example.test/picture.png', true],
    ['https://user:password@example.test/picture.png', false],
    ['javascript:alert(1)', false],
    ['data:text/html;base64,PHNjcmlwdD4=', false],
    ['data:image/png;base64,aGVsbG8=', true],
    ['data:image/png;base64,@@@=', false],
    ['data:image/png,hello%20world', true],
    ['data:image/png,%89PNG%0D%0A', true],
    ['data:image/x-icon;base64,aGVsbG8=', true],
    ['data:image/png,invalid%ZZ', false],
    ['blob:unowned', false]
  ])('checks direct display source %s', (source, expected) => {
    expect(isSafeDirectImageSource(source)).toBe(expected)
  })
})
