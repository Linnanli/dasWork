// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProcessesWorkspace } from './ProcessesWorkspace'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

describe('ProcessesWorkspace', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('lists every terminal owned by the current app window and opens its output', async () => {
    const first = terminalSession({ id: 'build', title: 'Build', status: 'running' })
    const second = terminalSession({ id: 'lint', title: 'Lint', status: 'exited' })
    const terminal = {
      list: vi.fn().mockResolvedValue({ version: 2, sessions: [first, second] }),
      close: vi.fn(),
      onEvent: vi.fn(() => () => undefined)
    }
    vi.stubGlobal('desktopApp', { workspace: { terminal } })
    const onOpenTerminal = vi.fn()

    await render(<ProcessesWorkspace onOpenTerminal={onOpenTerminal} />)

    expect(terminal.list).toHaveBeenCalledWith({ version: 2 })
    expect(container.querySelectorAll('[data-slot="workspace-process"]')).toHaveLength(2)
    expect(container.textContent).toContain('仅显示并管理当前应用窗口创建的后台进程')

    await act(async () => buttonWithText('打开输出')?.click())
    expect(onOpenTerminal).toHaveBeenCalledWith(first)
  })

  it('asks before stopping every active process and retains a partial-failure error', async () => {
    const running = terminalSession({ id: 'build', title: 'Build', status: 'running' })
    const starting = terminalSession({ id: 'watch', title: 'Watch', status: 'starting' })
    const stopped = { ...running, status: 'exited' as const, updatedAt: '2026-01-02T00:00:00.000Z' }
    const terminal = {
      list: vi.fn().mockResolvedValue({ version: 2, sessions: [running, starting] }),
      close: vi
        .fn()
        .mockResolvedValueOnce(stopped)
        .mockRejectedValueOnce(new Error('process unavailable')),
      onEvent: vi.fn(() => () => undefined)
    }
    vi.stubGlobal('desktopApp', { workspace: { terminal } })

    await render(<ProcessesWorkspace />)

    await act(async () => buttonWithText('停止全部运行进程')?.click())
    expect(document.body.textContent).toContain('停止全部运行进程？')

    await act(async () => {
      buttonWithText('停止全部')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(terminal.close).toHaveBeenNthCalledWith(1, { version: 2, sessionId: 'build' })
    expect(terminal.close).toHaveBeenNthCalledWith(2, { version: 2, sessionId: 'watch' })
    expect(container.textContent).toContain('1 个后台进程未能停止')
    expect(container.querySelector('[data-process-status="exited"]')?.textContent).toContain(
      'Build'
    )
  })
})

async function render(element: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text
  )
}

function terminalSession({
  id,
  title,
  status
}: {
  id: string
  title: string
  status: 'starting' | 'running' | 'exited'
}): Record<string, unknown> {
  return {
    sessionId: id,
    workspaceId: 'workspace:one',
    conversationId: 'conversation:one',
    threadId: 'thread-one',
    hostId: 'local',
    backendKind: 'local-pty',
    purpose: 'action',
    cwd: '/workspace',
    shell: '/bin/zsh',
    shellKind: 'posix',
    title,
    cols: 120,
    rows: 30,
    status,
    exitCode: status === 'exited' ? 0 : null,
    signal: null,
    truncated: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(status === 'exited' ? { exitedAt: '2026-01-01T00:00:00.000Z' } : {})
  }
}
