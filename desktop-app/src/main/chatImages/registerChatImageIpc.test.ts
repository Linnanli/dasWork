import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { chatImageIpcChannels } from '../../shared/chatImageApi'
import { registerChatImageIpc } from './registerChatImageIpc'

function setup(url = 'app://-/index.html'): {
  handlers: Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>
  event: IpcMainInvokeEvent
  registration: ReturnType<typeof registerChatImageIpc>
  removeHandler: ReturnType<typeof vi.fn>
} {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, payload: unknown) => unknown>()
  const handle = vi.fn((channel, handler) => {
    handlers.set(channel, handler)
  })
  const removeHandler = vi.fn((channel) => {
    handlers.delete(channel)
  })
  const frame = { url }
  const sender = { isDestroyed: () => false, mainFrame: frame }
  const window = { isDestroyed: () => false, webContents: sender }
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const registration = registerChatImageIpc({
    ipcMain: { handle, removeHandler } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>,
    projectService: { resolveExistingThreadTarget: vi.fn().mockResolvedValue(null) },
    windowForSender: () => window as unknown as BrowserWindow,
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true })
  })
  return { handlers, event, registration, removeHandler }
}

describe('chat image IPC boundary', () => {
  it('registers only the two business channels and resolves validated image data', async () => {
    const { handlers, event, registration, removeHandler } = setup()
    expect([...handlers.keys()]).toEqual([
      chatImageIpcChannels.resolveSource,
      chatImageIpcChannels.save
    ])
    const source = 'data:image/png;base64,YWJj'
    expect(
      await handlers.get(chatImageIpcChannels.resolveSource)!(event, {
        source,
        sourceKind: 'media-url'
      })
    ).toEqual({ status: 'available', displaySrc: source })
    registration.dispose()
    expect(removeHandler).toHaveBeenCalledTimes(2)
  })
  it('rejects unknown renderer fields including arbitrary output paths/cwd', () => {
    const { handlers, event } = setup()
    expect(() =>
      handlers.get(chatImageIpcChannels.save)!(event, {
        source: 'data:image/png;base64,YWJj',
        sourceKind: 'media-url',
        path: '/write-anywhere.png'
      })
    ).toThrow()
    expect(() =>
      handlers.get(chatImageIpcChannels.resolveSource)!(event, {
        source: 'relative.png',
        sourceKind: 'native-path',
        cwd: '/renderer-cwd'
      })
    ).toThrow()
  })
  it('rejects external content and subframes before resolving any source', () => {
    const external = setup('https://example.com/')
    expect(() =>
      external.handlers.get(chatImageIpcChannels.resolveSource)!(external.event, {
        source: '/private.png',
        sourceKind: 'native-path'
      })
    ).toThrow('桌面聊天窗口')
    const own = setup()
    const frame = { url: 'app://-/index.html' }
    expect(() =>
      own.handlers.get(chatImageIpcChannels.resolveSource)!(
        { ...own.event, senderFrame: frame } as IpcMainInvokeEvent,
        { source: '/private.png', sourceKind: 'native-path' }
      )
    ).toThrow('桌面聊天窗口')
  })
  it('returns native save dialog cancellation without writing data', async () => {
    const { handlers, event } = setup()
    expect(
      await handlers.get(chatImageIpcChannels.save)!(event, {
        source: 'data:image/png;base64,YWJj',
        sourceKind: 'media-url'
      })
    ).toEqual({ status: 'cancelled' })
  })
})
