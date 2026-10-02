import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi, type Mock } from 'vitest'

import { bindRightWorkspaceWindowLifecycle } from './bindRightWorkspaceWindowLifecycle'

function fixture(): {
  webContents: EventEmitter
  window: EventEmitter & { isDestroyed: Mock<() => boolean> }
  registration: Record<'attachWindow' | 'detachWindow' | 'disposeWindow', Mock>
} {
  const webContents = Object.assign(new EventEmitter(), { id: 42 })
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: vi.fn(() => false)
  })
  const registration = {
    attachWindow: vi.fn(),
    detachWindow: vi.fn(),
    disposeWindow: vi.fn()
  }
  bindRightWorkspaceWindowLifecycle(window as unknown as BrowserWindow, registration)
  return { window, webContents, registration }
}

describe('right workspace window lifecycle', () => {
  it('keeps the workspace available while preview child frames load and reload', () => {
    const { window, webContents, registration } = fixture()
    for (let count = 0; count < 2; count += 1) {
      webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      webContents.emit('did-start-loading')
      webContents.emit('did-frame-finish-load', {}, false)
    }
    expect(registration.attachWindow).toHaveBeenCalledExactlyOnceWith(window)
    expect(registration.detachWindow).not.toHaveBeenCalled()
    expect(registration.disposeWindow).not.toHaveBeenCalled()
  })

  it('preserves workspace roots during main-frame same-document navigation', () => {
    const { webContents, registration } = fixture()
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(registration.detachWindow).not.toHaveBeenCalled()
    expect(registration.attachWindow).toHaveBeenCalledTimes(1)
  })

  it('detaches on main-frame reload and reattaches only when that frame finishes', () => {
    const { window, webContents, registration } = fixture()
    webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(registration.detachWindow).toHaveBeenCalledExactlyOnceWith(42)
    webContents.emit('did-frame-finish-load', {}, false)
    expect(registration.attachWindow).toHaveBeenCalledTimes(1)
    webContents.emit('did-frame-finish-load', {}, true)
    expect(registration.attachWindow).toHaveBeenCalledTimes(2)
    expect(registration.attachWindow).toHaveBeenLastCalledWith(window)
  })

  it('does not recreate workspace services for a destroyed window', () => {
    const { window, webContents, registration } = fixture()
    window.isDestroyed.mockReturnValue(true)
    webContents.emit('did-frame-finish-load', {}, true)
    expect(registration.attachWindow).toHaveBeenCalledTimes(1)
  })

  it('disposes workspace services after renderer failure and window close', () => {
    const { window, webContents, registration } = fixture()
    webContents.emit('render-process-gone')
    window.emit('closed')
    expect(registration.disposeWindow.mock.calls).toEqual([[42], [42]])
  })
})
