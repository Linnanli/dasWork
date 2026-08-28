import type { Menu as ElectronMenu, MenuItemConstructorOptions } from 'electron'

export type ApplicationMenuDependencies = {
  Menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): ElectronMenu
    setApplicationMenu(menu: ElectronMenu | null): void
  }
  isMac: boolean
  onNewTask: () => void
  onOpenCommandPalette: () => void
}

/** Installs the small native menu shell without giving native code direct renderer access. */
export function installApplicationMenu(dependencies: ApplicationMenuDependencies): void {
  dependencies.Menu.setApplicationMenu(
    dependencies.Menu.buildFromTemplate(applicationMenuTemplate(dependencies))
  )
}

export function applicationMenuTemplate({
  isMac,
  onNewTask,
  onOpenCommandPalette
}: Omit<ApplicationMenuDependencies, 'Menu'>): MenuItemConstructorOptions[] {
  return [
    ...(isMac
      ? [
          {
            label: 'dasCowork',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } satisfies MenuItemConstructorOptions
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: '新建任务', click: onNewTask },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: isMac ? [{ role: 'minimize' }, { role: 'zoom' }] : [{ role: 'minimize' }]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: '命令面板',
          click: onOpenCommandPalette
        }
      ]
    }
  ]
}
