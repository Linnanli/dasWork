import { describe, expect, it, vi } from 'vitest'

import { applicationMenuTemplate, installApplicationMenu } from './applicationMenu'

describe('application menu', () => {
  it('installs File, View, and Help menus and routes actions through callbacks', () => {
    const onNewTask = vi.fn()
    const onOpenCommandPalette = vi.fn()
    const template = applicationMenuTemplate({
      isMac: false,
      onNewTask,
      onOpenCommandPalette
    })
    const menu = { id: 'native-menu' } as never
    const buildFromTemplate = vi.fn(() => menu)
    const setApplicationMenu = vi.fn()

    installApplicationMenu({
      Menu: { buildFromTemplate, setApplicationMenu },
      isMac: false,
      onNewTask,
      onOpenCommandPalette
    })

    expect(template.map((item) => item.label)).toEqual(['File', 'View', 'Window', 'Help'])
    expect(buildFromTemplate).toHaveBeenCalledWith(template)
    expect(setApplicationMenu).toHaveBeenCalledWith(menu)

    const fileMenu = template[0]?.submenu
    const helpMenu = template.at(-1)?.submenu
    if (!Array.isArray(fileMenu) || !Array.isArray(helpMenu)) throw new Error('Expected submenus')

    const newTask = fileMenu.find((item) => item.label === '新建任务')
    const commandPalette = helpMenu.find((item) => item.label === '命令面板')
    if (!newTask || !commandPalette) throw new Error('Expected native menu actions')

    newTask.click?.({} as never, {} as never, {} as never)
    commandPalette.click?.({} as never, {} as never, {} as never)
    expect(onNewTask).toHaveBeenCalledOnce()
    expect(onOpenCommandPalette).toHaveBeenCalledOnce()
  })

  it('adds the macOS application menu without changing the shared task actions', () => {
    const template = applicationMenuTemplate({
      isMac: true,
      onNewTask: vi.fn(),
      onOpenCommandPalette: vi.fn()
    })

    expect(template[0]?.label).toBe('dasCowork')
    expect(template.map((item) => item.label)).toContain('File')
    expect(template.map((item) => item.label)).toContain('Help')
  })
})
