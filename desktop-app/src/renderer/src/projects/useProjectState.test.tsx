// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopProjectsApi } from '../../../shared/codexIpcApi'
import type { ProjectState } from '../../../shared/projects/projectTypes'
import { useProjectState, type ProjectStateController } from './useProjectState'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const emptyState: ProjectState = {
  workspaceRootOptions: [],
  localProjects: {},
  remoteProjects: [],
  projectOrder: [],
  pinnedProjectIds: [],
  projectWritableRoots: {},
  threadProjectAssignments: {},
  threadWritableRoots: {},
  threadWorkspaceRootHints: {},
  threadProjectlessOutputDirectories: {},
  projectlessThreadIds: [],
  projectlessHints: {}
}

describe('useProjectState', () => {
  let container: HTMLDivElement
  let root: Root
  let controller: ProjectStateController | null
  let stateChange: ((state: ProjectState) => void) | null

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    controller = null
    stateChange = null
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.unstubAllGlobals()
  })

  it('loads project state and updates from subscriptions', async () => {
    const selectedState: ProjectState = {
      ...emptyState,
      activeProjectSelection: { projectKind: 'projectless' },
      activeWorkspaceRoots: []
    }
    installDesktopProjects({
      getState: vi.fn().mockResolvedValue(emptyState),
      onStateChange: (callback) => {
        stateChange = callback
        return vi.fn()
      },
      selectProject: vi.fn().mockResolvedValue(selectedState)
    })

    await act(async () => {
      root.render(<Probe onController={(nextController) => (controller = nextController)} />)
    })

    expect(controller?.hasSelection).toBe(false)

    await act(async () => {
      stateChange?.(selectedState)
    })

    expect(controller?.hasSelection).toBe(true)
    expect(controller?.currentLabel).toBe('Projectless')
  })

  it('selects projectless mode through the desktop project bridge', async () => {
    const selectProject = vi.fn().mockResolvedValue({
      ...emptyState,
      activeProjectSelection: { projectKind: 'projectless' },
      activeWorkspaceRoots: []
    } satisfies ProjectState)
    installDesktopProjects({
      getState: vi.fn().mockResolvedValue(emptyState),
      onStateChange: vi.fn(() => vi.fn()),
      selectProject
    })

    await act(async () => {
      root.render(<Probe onController={(nextController) => (controller = nextController)} />)
    })
    await act(async () => {
      await controller?.selectProject({ projectKind: 'projectless' })
    })

    expect(selectProject).toHaveBeenCalledWith({ projectKind: 'projectless' })
    expect(controller?.currentLabel).toBe('Projectless')
  })

  it('loads and selects worktrees through the desktop project bridge', async () => {
    const selectedState: ProjectState = {
      ...emptyState,
      activeProjectSelection: { projectKind: 'path', path: '/repo/feature' },
      activeWorkspaceRoots: ['/repo/feature']
    }
    const listWorktrees = vi
      .fn()
      .mockResolvedValue([{ path: '/repo/feature', branch: 'feature/widget', isCurrent: false }])
    const selectWorktree = vi.fn().mockResolvedValue(selectedState)
    installDesktopProjects({ listWorktrees, selectWorktree })

    await act(async () => {
      root.render(<Probe onController={(nextController) => (controller = nextController)} />)
    })

    await expect(
      controller?.listWorktrees({ projectKind: 'path', path: '/repo/main' })
    ).resolves.toEqual([{ path: '/repo/feature', branch: 'feature/widget', isCurrent: false }])
    await act(async () => {
      await controller?.selectWorktree({
        source: { projectKind: 'path', path: '/repo/main' },
        path: '/repo/feature'
      })
    })

    expect(listWorktrees).toHaveBeenCalledWith({
      source: { projectKind: 'path', path: '/repo/main' }
    })
    expect(selectWorktree).toHaveBeenCalledWith({
      source: { projectKind: 'path', path: '/repo/main' },
      path: '/repo/feature'
    })
    expect(controller?.currentDetail).toBe('/repo/feature')
  })

  it('creates a blank project and refreshes the selected workspace root', async () => {
    const option = {
      root: '/Documents/Demo',
      label: 'Demo',
      hostId: 'local',
      addedAt: '2026-07-17T00:00:00.000Z',
      lastOpenedAt: '2026-07-17T00:00:00.000Z'
    }
    const selectedState: ProjectState = {
      ...emptyState,
      workspaceRootOptions: [option],
      activeProjectSelection: { projectKind: 'path', path: option.root },
      activeWorkspaceRoots: [option.root]
    }
    const getState = vi.fn().mockResolvedValue(emptyState)
    const createBlankProject = vi.fn().mockResolvedValue({ option, state: selectedState })
    installDesktopProjects({
      getState,
      createBlankProject,
      onStateChange: vi.fn(() => vi.fn())
    })

    await act(async () => {
      root.render(<Probe onController={(nextController) => (controller = nextController)} />)
    })
    let result: unknown
    await act(async () => {
      result = await controller?.createBlankProject('Demo', '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b')
    })

    expect(createBlankProject).toHaveBeenCalledWith({
      name: 'Demo',
      operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b'
    })
    expect(getState).toHaveBeenCalledOnce()
    expect(result).toEqual(option)
    expect(controller?.currentLabel).toBe('Demo')
    expect(controller?.currentDetail).toBe(option.root)
  })

  it('updates the selected project before persistence resolves and rolls back failures', async () => {
    let rejectSelection: ((error: Error) => void) | undefined
    const selectProject = vi.fn(
      () =>
        new Promise<ProjectState>((_resolve, reject) => {
          rejectSelection = reject
        })
    )
    installDesktopProjects({
      getState: vi.fn().mockResolvedValue(emptyState),
      onStateChange: vi.fn(() => vi.fn()),
      selectProject
    })

    await act(async () => {
      root.render(<Probe onController={(nextController) => (controller = nextController)} />)
    })

    let selectionPromise: Promise<void> | undefined
    act(() => {
      selectionPromise = controller?.selectProject({ projectKind: 'projectless' })
    })
    expect(controller?.currentLabel).toBe('Projectless')

    await act(async () => {
      rejectSelection?.(new Error('write failed'))
      await expect(selectionPromise).rejects.toThrow('write failed')
    })
    expect(controller?.hasSelection).toBe(false)
    expect(controller?.currentLabel).toBe('Choose project')
  })

  it('renames and removes projects through the desktop project bridge', async () => {
    const renamedState: ProjectState = {
      ...emptyState,
      localProjects: {
        local: {
          id: 'local',
          kind: 'local',
          name: 'Renamed Desktop App',
          hostId: 'local',
          createdAt: '2026-06-30T00:00:00.000Z',
          updatedAt: '2026-06-30T00:00:00.000Z',
          writableRoots: ['/repo']
        }
      },
      projectOrder: ['local']
    }
    const renameProject = vi.fn().mockResolvedValue(renamedState)
    const removeProject = vi.fn().mockResolvedValue(emptyState)
    installDesktopProjects({
      getState: vi.fn().mockResolvedValue(emptyState),
      onStateChange: vi.fn(() => vi.fn()),
      renameProject,
      removeProject
    })

    await act(async () => {
      root.render(<Probe onController={(nextController) => (controller = nextController)} />)
    })
    await act(async () => {
      await controller?.renameProject({
        projectKind: 'local',
        projectId: 'local',
        label: 'Renamed Desktop App'
      })
    })
    await act(async () => {
      await controller?.removeProject({ projectKind: 'local', projectId: 'local' })
    })

    expect(renameProject).toHaveBeenCalledWith({
      projectKind: 'local',
      projectId: 'local',
      label: 'Renamed Desktop App'
    })
    expect(removeProject).toHaveBeenCalledWith({ projectKind: 'local', projectId: 'local' })
  })
})

function Probe({
  onController
}: {
  onController: (controller: ProjectStateController) => void
}): null {
  const projectState = useProjectState()

  useEffect(() => {
    onController(projectState)
  }, [onController, projectState])

  return null
}

function installDesktopProjects(overrides: Partial<DesktopProjectsApi>): void {
  vi.stubGlobal('desktopApp', {
    projects: {
      getState: vi.fn().mockResolvedValue(emptyState),
      pickWorkspaceRoot: vi.fn().mockResolvedValue(null),
      createBlankProject: vi.fn(),
      createLocalProject: vi.fn(),
      createRemoteProject: vi.fn(),
      listWorktrees: vi.fn().mockResolvedValue([]),
      selectWorktree: vi.fn().mockResolvedValue(emptyState),
      selectProject: vi.fn(),
      removeProject: vi.fn(),
      renameProject: vi.fn(),
      getWorkspaceRecovery: vi.fn(async () => ({ state: 'not-applicable' as const })),
      restoreWorkspace: vi.fn(async () => ({ state: 'not-applicable' as const })),
      onStateChange: vi.fn(() => vi.fn()),
      ...overrides
    } satisfies DesktopProjectsApi
  })
}
