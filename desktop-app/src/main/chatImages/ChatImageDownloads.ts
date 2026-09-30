import type { DownloadItem, Event, WebContents } from 'electron'
import { isChatImageMimeType, type ChatImageSaveResult } from '../../shared/chatImageApi'

export class ChatImageDownloads {
  private readonly queues = new WeakMap<WebContents, Map<string, Promise<ChatImageSaveResult>>>()

  constructor(private readonly startTimeoutMs = 30_000) {}

  save(webContents: WebContents, url: string, fileName?: string): Promise<ChatImageSaveResult> {
    const downloadUrl = new URL(url)
    downloadUrl.hash = ''
    url = downloadUrl.href
    let queues = this.queues.get(webContents)
    if (!queues) {
      queues = new Map()
      this.queues.set(webContents, queues)
    }
    // DownloadItem has no caller token. Serializing identical requests prevents
    // one will-download event from resolving two saves of the same source.
    const previous = queues.get(url)
    const next = (previous ? previous.then(() => undefined) : Promise.resolve())
      .then(() => this.start(webContents, url, fileName))
      .catch((): ChatImageSaveResult => ({ status: 'failed', message: '无法开始图片下载' }))
    queues.set(url, next)
    void next.finally(() => {
      if (queues.get(url) === next) queues.delete(url)
    })
    return next
  }

  private start(
    webContents: WebContents,
    url: string,
    fileName?: string
  ): Promise<ChatImageSaveResult> {
    if (webContents.isDestroyed()) {
      return Promise.resolve({ status: 'failed', message: '图片窗口已关闭' })
    }
    return new Promise((resolve) => {
      const session = webContents.session
      let activeItem: DownloadItem | undefined
      let finished = false
      const finish = (result: ChatImageSaveResult): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        session.removeListener('will-download', onDownload)
        webContents.removeListener('destroyed', onDestroyed)
        activeItem?.removeListener('done', onDone)
        activeItem?.removeListener('updated', onUpdated)
        resolve(result)
      }
      const onDestroyed = (): void => {
        const item = activeItem
        finish({ status: 'failed', message: '图片窗口已关闭' })
        item?.cancel()
      }
      const onDone = (_event: Event, state: 'completed' | 'cancelled' | 'interrupted'): void => {
        if (state === 'cancelled') finish({ status: 'cancelled' })
        else if (state === 'completed' && activeItem?.getSavePath()) {
          finish({ status: 'saved', path: activeItem.getSavePath() })
        } else finish({ status: 'failed', message: '图片下载中断，请重试' })
      }
      const onUpdated = (_event: Event, state: 'progressing' | 'interrupted'): void => {
        if (state !== 'interrupted') return
        const item = activeItem
        // A resumable interruption may never emit done. Detach listeners before
        // cancel() so its cancelled event cannot replace the failure result.
        finish({ status: 'failed', message: '图片下载中断，请重试' })
        item?.cancel()
      }
      const onDownload = (event: Event, item: DownloadItem, owner: WebContents): void => {
        // Later entries belong to redirects, and may also be another pending
        // request's source. Only the originating URL identifies this download.
        if (owner?.id !== webContents.id || item.getURLChain()[0] !== url) return
        if (event.defaultPrevented) {
          finish({ status: 'failed', message: '图片下载已被阻止' })
          return
        }
        activeItem = item
        clearTimeout(timer)
        session.removeListener('will-download', onDownload)
        if (!isChatImageMimeType(item.getMimeType())) {
          finish({ status: 'failed', message: '下载来源不是受支持的图片' })
          item.cancel()
          return
        }
        try {
          item.setSaveDialogOptions({
            title: '保存图片',
            ...(fileName ? { defaultPath: fileName } : {})
          })
          item.once('done', onDone)
          item.on('updated', onUpdated)
        } catch {
          finish({ status: 'failed', message: '无法保存图片' })
          item.cancel()
        }
      }
      const timer = setTimeout(
        () => finish({ status: 'failed', message: '图片下载未能开始，请重试' }),
        this.startTimeoutMs
      )
      session.on('will-download', onDownload)
      webContents.once('destroyed', onDestroyed)
      try {
        webContents.downloadURL(url)
      } catch {
        finish({ status: 'failed', message: '无法开始图片下载' })
      }
    })
  }
}
