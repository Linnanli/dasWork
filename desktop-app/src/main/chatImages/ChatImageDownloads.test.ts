import { EventEmitter } from 'node:events'
import type { DownloadItem, Event, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatImageDownloads } from './ChatImageDownloads'

afterEach(() => vi.useRealTimers())

class Item extends EventEmitter {
  options = vi.fn()
  cancel = vi.fn()
  constructor(
    readonly chain: string[],
    readonly path = '/saved/image.png',
    readonly mime = 'image/png'
  ) {
    super()
  }
  getURLChain(): string[] {
    return this.chain
  }
  getMimeType(): string {
    return this.mime
  }
  getSavePath(): string {
    return this.path
  }
  setSaveDialogOptions = this.options
  asElectron(): DownloadItem {
    return this as unknown as DownloadItem
  }
  done(state: 'completed' | 'cancelled' | 'interrupted'): void {
    this.emit('done', {} as Event, state)
  }
  updated(state: 'progressing' | 'interrupted'): void {
    this.emit('updated', {} as Event, state)
  }
}
function owner(id = 1): {
  webContents: WebContents
  session: EventEmitter
  downloadURL: ReturnType<typeof vi.fn>
  destroy(): void
} {
  const emitter = new EventEmitter()
  const session = new EventEmitter()
  let destroyed = false
  const downloadURL = vi.fn()
  const webContents = Object.assign(emitter, {
    id,
    session,
    downloadURL,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
      emitter.emit('destroyed')
    }
  })
  return {
    webContents: webContents as unknown as WebContents,
    session,
    downloadURL,
    destroy: webContents.destroy
  }
}
const event = { defaultPrevented: false } as Event
async function started(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('chat image HTTP download ownership', () => {
  it('follows redirect URL chains, waits for actual completion and removes listeners', async () => {
    const o = owner()
    const promise = new ChatImageDownloads().save(
      o.webContents,
      'https://example.com/original',
      'chosen.png'
    )
    await started()
    const item = new Item(['https://example.com/original', 'https://cdn.example.com/final'])
    o.session.emit('will-download', event, item.asElectron(), o.webContents)
    expect(item.options).toHaveBeenCalledWith({ title: '保存图片', defaultPath: 'chosen.png' })
    expect(o.session.listenerCount('will-download')).toBe(0)
    item.done('completed')
    expect(await promise).toEqual({ status: 'saved', path: '/saved/image.png' })
    expect(o.webContents.listenerCount('destroyed')).toBe(0)
    expect(item.listenerCount('done')).toBe(0)
    expect(item.listenerCount('updated')).toBe(0)
    expect(o.downloadURL).toHaveBeenCalledWith('https://example.com/original')
  })
  it('ignores another window and an unrelated source on a shared session', async () => {
    const o = owner()
    const other = owner(2)
    const promise = new ChatImageDownloads().save(o.webContents, 'https://example.com/one.png')
    await started()
    const foreign = new Item(['https://example.com/one.png'])
    o.session.emit('will-download', event, foreign.asElectron(), other.webContents)
    const unrelated = new Item(['https://example.com/two.png'])
    o.session.emit('will-download', event, unrelated.asElectron(), o.webContents)
    expect(foreign.options).not.toHaveBeenCalled()
    expect(unrelated.options).not.toHaveBeenCalled()
    const own = new Item(['https://example.com/one.png'])
    o.session.emit('will-download', event, own.asElectron(), o.webContents)
    own.done('completed')
    expect((await promise).status).toBe('saved')
  })
  it('normalizes a source fragment for the actual HTTP request association', async () => {
    const o = owner()
    const promise = new ChatImageDownloads().save(
      o.webContents,
      'https://EXAMPLE.com/image.png#preview'
    )
    await started()
    expect(o.downloadURL).toHaveBeenCalledWith('https://example.com/image.png')
    const item = new Item(['https://example.com/image.png'])
    o.session.emit('will-download', event, item.asElectron(), o.webContents)
    item.done('completed')
    expect((await promise).status).toBe('saved')
  })
  it('serializes identical sources and keeps concurrent distinct sources associated', async () => {
    const o = owner()
    const downloads = new ChatImageDownloads()
    const one = downloads.save(o.webContents, 'https://example.com/one.png')
    const same = downloads.save(o.webContents, 'https://example.com/one.png')
    const two = downloads.save(o.webContents, 'https://example.com/two.png')
    await started()
    expect(o.downloadURL.mock.calls).toEqual([
      ['https://example.com/one.png'],
      ['https://example.com/two.png']
    ])
    const secondItem = new Item(['https://example.com/two.png'], '/two.png')
    const firstItem = new Item(['https://example.com/one.png'], '/one.png')
    o.session.emit('will-download', event, secondItem.asElectron(), o.webContents)
    o.session.emit('will-download', event, firstItem.asElectron(), o.webContents)
    secondItem.done('completed')
    firstItem.done('completed')
    expect(await two).toEqual({ status: 'saved', path: '/two.png' })
    expect(await one).toEqual({ status: 'saved', path: '/one.png' })
    await started()
    expect(o.downloadURL).toHaveBeenCalledTimes(3)
    const next = new Item(['https://example.com/one.png'], '/one-again.png')
    o.session.emit('will-download', event, next.asElectron(), o.webContents)
    next.done('completed')
    expect(await same).toEqual({ status: 'saved', path: '/one-again.png' })
    expect(o.session.listenerCount('will-download')).toBe(0)
  })
  it('keeps a redirected A download separate from a concurrent direct request for B', async () => {
    const o = owner()
    const downloads = new ChatImageDownloads()
    const sourceA = 'https://example.com/redirect.png'
    const sourceB = 'https://example.com/direct.png'
    const saveA = downloads.save(o.webContents, sourceA, 'a.png')
    const saveB = downloads.save(o.webContents, sourceB, 'b.png')
    let savedB = false
    void saveB.then(() => {
      savedB = true
    })
    await started()

    const itemA = new Item([sourceA, sourceB], '/saved/a.png')
    o.session.emit('will-download', event, itemA.asElectron(), o.webContents)
    expect(itemA.options).toHaveBeenCalledOnce()
    expect(itemA.options).toHaveBeenCalledWith({ title: '保存图片', defaultPath: 'a.png' })
    expect(o.session.listenerCount('will-download')).toBe(1)
    itemA.done('completed')
    expect(await saveA).toEqual({ status: 'saved', path: '/saved/a.png' })
    await started()
    expect(savedB).toBe(false)

    const itemB = new Item([sourceB], '/saved/b.png')
    o.session.emit('will-download', event, itemB.asElectron(), o.webContents)
    expect(itemB.options).toHaveBeenCalledOnce()
    expect(itemB.options).toHaveBeenCalledWith({ title: '保存图片', defaultPath: 'b.png' })
    itemB.done('completed')
    expect(await saveB).toEqual({ status: 'saved', path: '/saved/b.png' })
    expect(o.session.listenerCount('will-download')).toBe(0)
    expect(o.webContents.listenerCount('destroyed')).toBe(0)
  })
  it.each(['cancelled', 'interrupted'] as const)(
    'reports terminal %s distinctly',
    async (state) => {
      const o = owner()
      const promise = new ChatImageDownloads().save(o.webContents, 'https://example.com/image.png')
      await started()
      const item = new Item(['https://example.com/image.png'])
      o.session.emit('will-download', event, item.asElectron(), o.webContents)
      item.done(state)
      expect((await promise).status).toBe(state === 'cancelled' ? 'cancelled' : 'failed')
      expect(o.webContents.listenerCount('destroyed')).toBe(0)
      expect(item.listenerCount('done')).toBe(0)
      expect(item.listenerCount('updated')).toBe(0)
      expect(item.cancel).not.toHaveBeenCalled()
    }
  )
  it('fails an interrupted update without waiting for done or reporting its cleanup as cancellation', async () => {
    const o = owner()
    const promise = new ChatImageDownloads().save(o.webContents, 'https://example.com/image.png')
    let settled = false
    void promise.then(() => {
      settled = true
    })
    await started()
    const item = new Item(['https://example.com/image.png'])
    item.cancel.mockImplementation(() => {
      expect(item.listenerCount('done')).toBe(0)
      expect(item.listenerCount('updated')).toBe(0)
      item.done('cancelled')
    })
    o.session.emit('will-download', event, item.asElectron(), o.webContents)
    item.updated('progressing')
    await started()
    expect(settled).toBe(false)
    expect(item.cancel).not.toHaveBeenCalled()

    item.updated('interrupted')
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(await promise).toEqual({ status: 'failed', message: '图片下载中断，请重试' })
    expect(o.session.listenerCount('will-download')).toBe(0)
    expect(o.webContents.listenerCount('destroyed')).toBe(0)
  })
  it('releases an identical queued request after an interrupted update and ignores the old item', async () => {
    const o = owner()
    const downloads = new ChatImageDownloads()
    const source = 'https://example.com/image.png'
    const first = downloads.save(o.webContents, source)
    const retry = downloads.save(o.webContents, source)
    let retrySettled = false
    void retry.then(() => {
      retrySettled = true
    })
    await started()
    const interrupted = new Item([source], '/partial.png')
    o.session.emit('will-download', event, interrupted.asElectron(), o.webContents)
    interrupted.updated('interrupted')
    expect(interrupted.cancel).toHaveBeenCalledOnce()
    expect((await first).status).toBe('failed')
    await started()
    expect(o.downloadURL).toHaveBeenCalledTimes(2)

    const next = new Item([source], '/complete.png')
    o.session.emit('will-download', event, next.asElectron(), o.webContents)
    interrupted.done('completed')
    interrupted.updated('interrupted')
    await started()
    expect(retrySettled).toBe(false)
    next.done('completed')
    expect(await retry).toEqual({ status: 'saved', path: '/complete.png' })
    expect(interrupted.cancel).toHaveBeenCalledOnce()
    expect(next.listenerCount('done')).toBe(0)
    expect(next.listenerCount('updated')).toBe(0)
    expect(o.session.listenerCount('will-download')).toBe(0)
    expect(o.webContents.listenerCount('destroyed')).toBe(0)
  })
  it('rejects non-image HTTP results without reporting a saved file', async () => {
    const o = owner()
    const promise = new ChatImageDownloads().save(o.webContents, 'https://example.com/404.png')
    await started()
    const item = new Item(['https://example.com/404.png'], '/404.png', 'text/html')
    o.session.emit('will-download', event, item.asElectron(), o.webContents)
    expect(await promise).toEqual({ status: 'failed', message: '下载来源不是受支持的图片' })
    expect(item.cancel).toHaveBeenCalledOnce()
  })
  it('fails missing download startup and removes pending listeners', async () => {
    vi.useFakeTimers()
    const o = owner()
    const promise = new ChatImageDownloads(20).save(
      o.webContents,
      'https://example.com/no-download'
    )
    await started()
    await vi.advanceTimersByTimeAsync(21)
    expect((await promise).status).toBe('failed')
    expect(o.session.listenerCount('will-download')).toBe(0)
    expect(o.webContents.listenerCount('destroyed')).toBe(0)
  })
  it('cancels active items and queued requests when the owning window closes', async () => {
    const o = owner()
    const downloads = new ChatImageDownloads()
    const first = downloads.save(o.webContents, 'https://example.com/image.png')
    const queued = downloads.save(o.webContents, 'https://example.com/image.png')
    await started()
    const item = new Item(['https://example.com/image.png'])
    o.session.emit('will-download', event, item.asElectron(), o.webContents)
    o.destroy()
    expect((await first).status).toBe('failed')
    expect((await queued).status).toBe('failed')
    expect(item.cancel).toHaveBeenCalledOnce()
    expect(item.listenerCount('done')).toBe(0)
    expect(item.listenerCount('updated')).toBe(0)
    expect(o.session.listenerCount('will-download')).toBe(0)
    expect(o.downloadURL).toHaveBeenCalledOnce()
  })
})
