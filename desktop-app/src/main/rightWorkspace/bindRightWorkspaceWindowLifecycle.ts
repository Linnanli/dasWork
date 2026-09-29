import type { BrowserWindow } from 'electron'

import type { RightWorkspaceIpcRegistration } from './registerRightWorkspaceIpc'

export function bindRightWorkspaceWindowLifecycle(
  window: BrowserWindow,
  registration: Pick<
    RightWorkspaceIpcRegistration,
    'attachWindow' | 'detachWindow' | 'disposeWindow'
  >
): void {
  const ownerId = window.webContents.id
  registration.attachWindow(window)

  // Child preview frames and same-document navigation keep the owner's workspace alive.
  window.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) registration.detachWindow(ownerId)
  })
  window.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
    if (isMainFrame && !window.isDestroyed()) registration.attachWindow(window)
  })
  window.webContents.on('render-process-gone', () => registration.disposeWindow(ownerId))
  window.on('closed', () => registration.disposeWindow(ownerId))
}
