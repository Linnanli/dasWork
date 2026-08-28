// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProjectState } from '../../../shared/projects/projectTypes'
import { ComposerProjectCard } from './ComposerProjectCard'
import type { ProjectStateController } from './useProjectState'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const projectState: ProjectState = {
  workspaceRootOptions: [
    {
      root: '/repos/alpha',
      label: 'Alpha',
      hostId: 'local',
      addedAt: '2026-07-17T00:00:00.000Z',
      lastOpenedAt: '2026-07-17T00:00:00.000Z'
    }
  ],
  localProjects: {
    beta: {
      id: 'beta',
      kind: 'local',
      name: 'Beta App',
      hostId: 'local',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      writableRoots: ['/repos/beta']
    }
  },
  remoteProjects: [
    {
      id: 'remote',
      kind: 'remote',
      hostId: 'ssh-dev',
      label: 'Remote App',
      remotePath: '/srv/app',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z'
    }
  ],
  projectOrder: ['beta'],
  pinnedProjectIds: [],
  projectWritableRoots: {},
  threadProjectAssignments: {},
  threadWritableRoots: {},
  threadWorkspaceRootHints: {},
  threadProjectlessOutputDirectories: {},
  projectlessThreadIds: [],
  projectlessHints: {}
}

describe('ComposerProjectCard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('shows only the choose-project label for Projectless', () => {
    act(() => {
      root.render(
        <ComposerProjectCard
          activeSelection={{ projectKind: 'projectless' }}
          projectState={controller()}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="composer-project-card"]'
    )
    expect(trigger?.textContent).toBe('选择项目')
    expect(trigger?.textContent).not.toContain('Projectless')
    expect(trigger?.disabled).toBe(false)
    expect(trigger?.dataset.variant).toBe('ghost')
    expect(trigger?.dataset.size).toBe('sm')
    expect(trigger?.className.split(/\s+/)).not.toContain('w-full')
    expect(trigger?.className.split(/\s+/)).toContain('rounded-full')
    expect(trigger?.className.split(/\s+/)).toContain('!font-normal')
    expect(trigger?.querySelector('svg')?.getAttribute('class')).toContain('size-3')

    const shell = container.querySelector<HTMLElement>('[data-slot="composer-project-card-shell"]')
    expect(shell?.className).toContain('h-10')
    expect(shell?.className).toContain('bg-muted/70')
    expect(shell?.className).not.toContain('bg-[#151515]')
    expect(shell?.className.split(/\s+/)).not.toContain('border')
    expect(shell?.contains(trigger ?? null)).toBe(true)
  })

  it('uses a close icon for the projectless action', async () => {
    act(() => {
      root.render(
        <ComposerProjectCard
          activeSelection={{ projectKind: 'path', path: '/repos/alpha' }}
          projectState={controller()}
        />
      )
    })
    await openPicker(container)

    const projectlessAction = itemWithText('不在项目中工作')
    expect(projectlessAction?.querySelector('svg')?.getAttribute('class')).toContain('lucide-x')
  })

  it('searches project labels, paths and remote hosts', async () => {
    act(() => {
      root.render(<ComposerProjectCard activeSelection={undefined} projectState={controller()} />)
    })
    await openPicker(container)

    const panel = document.querySelector<HTMLElement>('.aui-composer-project-panel')
    expect(panel?.className).toContain('rounded-2xl')
    expect(panel?.className).toContain('bg-popover/90')
    expect(panel?.className).toContain('p-1')
    expect(panel?.className).toContain('shadow-lg')
    expect(panel?.className).toContain('backdrop-blur-md')

    const firstItem = document.querySelector<HTMLElement>('[data-slot="command-item"]')
    expect(firstItem?.className).toContain('rounded-lg')
    expect(firstItem?.className).toContain('px-2.5')
    expect(firstItem?.className).toContain('py-2')
    expect(firstItem?.className).toContain('text-popover-foreground/75')
    expect(document.body.textContent).toContain('项目')
    expect(document.body.textContent).toContain('操作')
    expect(document.body.textContent).not.toContain('/repos/beta')
    expect(document.body.textContent).not.toContain('/repos/alpha')
    expect(document.body.textContent).not.toContain('/srv/app')

    const input = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')
    act(() => {
      if (input) setInputValue(input, 'ssh-dev')
    })

    expect(document.body.textContent).toContain('Remote App')
    expect(document.body.textContent).not.toContain('Beta App')
    expect(document.body.textContent).not.toContain('Alpha')
  })

  it('selects a project in place for an unbound draft', async () => {
    const projectController = controller()

    act(() => {
      root.render(
        <ComposerProjectCard activeSelection={undefined} projectState={projectController} />
      )
    })
    await openPicker(container)
    await act(async () => {
      itemWithText('Beta App')?.click()
      await Promise.resolve()
    })

    expect(projectController.selectProject).toHaveBeenCalledWith({
      projectKind: 'local',
      projectId: 'beta'
    })
  })

  it('does not change the project when the existing-folder picker is cancelled', async () => {
    const projectController = controller()

    act(() => {
      root.render(
        <ComposerProjectCard
          activeSelection={{ projectKind: 'path', path: '/repos/alpha' }}
          projectState={projectController}
        />
      )
    })
    await openPicker(container)
    act(() => itemWithText('新建项目')?.click())
    await act(async () => {
      itemWithText('使用现有文件夹')?.click()
      await Promise.resolve()
    })

    expect(projectController.pickWorkspaceRoot).toHaveBeenCalledOnce()
  })

  it('selects a verified Git worktree through the project controller', async () => {
    const projectController = controller({
      listWorktrees: vi
        .fn()
        .mockResolvedValue([
          { path: '/repos/alpha-feature', branch: 'feature/widget', isCurrent: false }
        ])
    })
    const activeSelection = { projectKind: 'path' as const, path: '/repos/alpha' }

    act(() => {
      root.render(
        <ComposerProjectCard activeSelection={activeSelection} projectState={projectController} />
      )
    })
    await openPicker(container)
    await act(async () => {
      itemWithText('选择 Git worktree')?.click()
      await Promise.resolve()
    })

    expect(projectController.listWorktrees).toHaveBeenCalledWith(activeSelection)
    expect(document.body.textContent).toContain('feature/widget')
    expect(document.body.textContent).toContain('/repos/alpha-feature')

    await act(async () => {
      itemWithText('feature/widget')?.click()
      await Promise.resolve()
    })

    expect(projectController.selectWorktree).toHaveBeenCalledWith({
      source: activeSelection,
      path: '/repos/alpha-feature'
    })
  })

  it('creates a blank project for an unbound draft', async () => {
    const projectController = controller({
      createBlankProject: vi.fn().mockResolvedValue({
        root: '/documents/New App',
        label: 'New App',
        hostId: 'local',
        addedAt: '2026-07-17T00:00:00.000Z',
        lastOpenedAt: '2026-07-17T00:00:00.000Z'
      })
    })

    act(() => {
      root.render(
        <ComposerProjectCard
          activeSelection={{ projectKind: 'path', path: '/repos/alpha' }}
          projectState={projectController}
        />
      )
    })
    await openPicker(container)
    act(() => itemWithText('新建项目')?.click())
    act(() => itemWithText('新建空白项目')?.click())

    const input = document.querySelector<HTMLInputElement>('[data-slot="blank-project-name-input"]')
    act(() => {
      if (input) setInputValue(input, '  New App  ')
    })
    await act(async () => {
      buttonWithText('保存')?.click()
      await Promise.resolve()
    })

    expect(projectController.createBlankProject).toHaveBeenCalledWith('New App', expect.any(String))
  })

  it('connects a remote project with its execution server', async () => {
    const projectController = controller({
      createRemoteProject: vi.fn().mockResolvedValue({ id: 'remote-created' })
    })

    act(() => {
      root.render(
        <ComposerProjectCard
          activeSelection={{ projectKind: 'path', path: '/repos/alpha' }}
          projectState={projectController}
        />
      )
    })
    await openPicker(container)
    act(() => itemWithText('新建项目')?.click())
    act(() => itemWithText('连接远程项目')?.click())

    const values: Array<[string, string]> = [
      ['remote-project-host-input', 'ssh-devbox'],
      ['remote-project-label-input', 'Staging API'],
      ['remote-project-path-input', '/srv/staging-api'],
      ['remote-project-exec-server-input', 'wss://exec.example.test/codex']
    ]
    act(() => {
      for (const [slot, value] of values) {
        const input = document.querySelector<HTMLInputElement>(`[data-slot="${slot}"]`)
        if (input) setInputValue(input, value)
      }
    })
    await act(async () => {
      buttonWithText('连接项目')?.click()
      await Promise.resolve()
    })

    expect(projectController.createRemoteProject).toHaveBeenCalledWith({
      hostId: 'ssh-devbox',
      label: 'Staging API',
      remotePath: '/srv/staging-api',
      execServerUrl: 'wss://exec.example.test/codex'
    })
  })
})

function controller(overrides: Partial<ProjectStateController> = {}): ProjectStateController {
  return {
    state: projectState,
    hasSelection: false,
    currentLabel: 'Choose project',
    currentDetail: null,
    pickWorkspaceRoot: vi.fn().mockResolvedValue(null),
    createBlankProject: vi.fn(),
    createLocalProject: vi.fn(),
    createRemoteProject: vi.fn(),
    listWorktrees: vi.fn().mockResolvedValue([]),
    selectWorktree: vi.fn().mockResolvedValue(undefined),
    selectProject: vi.fn().mockResolvedValue(undefined),
    renameProject: vi.fn(),
    removeProject: vi.fn(),
    ...overrides
  }
}

async function openPicker(container: HTMLDivElement): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-slot="composer-project-card"]')?.click()
    await Promise.resolve()
  })
}

function itemWithText(text: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="command-item"]')).find(
    (item) => item.textContent?.includes(text)
  )
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => button.textContent?.trim() === text
  )
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  valueSetter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

class TestResizeObserver implements ResizeObserver {
  observe(): void {
    return undefined
  }
  unobserve(): void {
    return undefined
  }
  disconnect(): void {
    return undefined
  }
}
