import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, SaveDialogReturnValue } from 'electron'
import {
  chatImageIpcChannels,
  chatImageRequestSchema,
  chatImageSaveRequestSchema
} from '../../shared/chatImageApi'
import { APP_RENDERER_ORIGIN, frameOriginFromUrl } from '../localMediaProtocol'
import type { ProjectService } from '../projects/ProjectService'
import { ChatImageDownloads } from './ChatImageDownloads'
import { ChatImageService } from './ChatImageService'

export function registerChatImageIpc(options: {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  projectService: Pick<ProjectService, 'resolveExistingThreadTarget'>
  windowForSender(event: IpcMainInvokeEvent): BrowserWindow | null
  showSaveDialog(window: BrowserWindow, fileName: string): Promise<SaveDialogReturnValue>
  devRendererUrl?: string
}): { service: ChatImageService; dispose(): void } {
  const service = new ChatImageService({ projectService: options.projectService })
  const downloads = new ChatImageDownloads()
  const devOrigin = frameOriginFromUrl(options.devRendererUrl)
  const requireWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = options.windowForSender(event)
    const origin = frameOriginFromUrl(event.senderFrame?.url)
    if (
      !window ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      window.webContents !== event.sender ||
      event.senderFrame !== event.sender.mainFrame ||
      (origin !== APP_RENDERER_ORIGIN && (!devOrigin || origin !== devOrigin))
    ) {
      throw new Error('图片操作仅允许桌面聊天窗口')
    }
    return window
  }
  options.ipcMain.handle(chatImageIpcChannels.resolveSource, (event, payload: unknown) => {
    requireWindow(event)
    return service.resolveImageSource(chatImageRequestSchema.parse(payload))
  })
  options.ipcMain.handle(chatImageIpcChannels.save, (event, payload: unknown) => {
    const window = requireWindow(event)
    return service.saveImage(chatImageSaveRequestSchema.parse(payload), {
      isDestroyed: () => window.isDestroyed() || event.sender.isDestroyed(),
      chooseSavePath: async (fileName) => {
        const result = await options.showSaveDialog(window, fileName)
        return result.canceled ? null : (result.filePath ?? null)
      },
      downloadImage: (url, fileName) => downloads.save(event.sender, url, fileName)
    })
  })
  return {
    service,
    dispose: () => {
      options.ipcMain.removeHandler(chatImageIpcChannels.resolveSource)
      options.ipcMain.removeHandler(chatImageIpcChannels.save)
    }
  }
}
