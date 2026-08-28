import { describe, expect, it, vi } from 'vitest'

import { ProjectApiService } from './ProjectApiService'
import { ProjectStore, createDefaultProjectState } from './ProjectStore'

describe('ProjectApiService', () => {
  it('persists, updates, and removes actions for a registered path project', async () => {
    const store = ProjectStore.inMemory({
      ...createDefaultProjectState(),
      workspaceRootOptions: [
        {
          root: '/workspace/app',
          hostId: 'local',
          addedAt: '2026-08-27T00:00:00.000Z',
          lastOpenedAt: '2026-08-27T00:00:00.000Z'
        }
      ]
    })
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn()
    })

    const created = await service.upsertProjectAction({
      scope: { projectKind: 'path', path: '/workspace/app' },
      action: { title: 'Test', command: 'npm test' }
    })
    const [action] = created.projectActions?.['path:/workspace/app'] ?? []
    expect(action).toMatchObject({ title: 'Test', command: 'npm test' })

    const updated = await service.upsertProjectAction({
      scope: { projectKind: 'path', path: '/workspace/app' },
      action: { id: action?.id, title: 'Unit tests', command: 'npm run test:unit' }
    })
    expect(updated.projectActions?.['path:/workspace/app']).toMatchObject([
      { id: action?.id, title: 'Unit tests', command: 'npm run test:unit' }
    ])

    await service.removeProjectAction({
      scope: { projectKind: 'path', path: '/workspace/app' },
      actionId: action?.id ?? ''
    })
    await expect(store.getState()).resolves.toMatchObject({ projectActions: {} })
  })

  it('creates, registers, and activates a blank project root', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const createBlankProjectRoot = vi.fn(async () => '/documents/New App')
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn(),
      createBlankProjectRoot
    })

    const result = await service.createBlankProject(
      'New App',
      '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b'
    )

    expect(createBlankProjectRoot).toHaveBeenCalledWith(
      'New App',
      '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b'
    )
    expect(result.option).toMatchObject({
      root: '/documents/New App',
      label: 'New App',
      hostId: 'local'
    })
    expect(result.state).toMatchObject({
      activeProjectSelection: {
        projectKind: 'path',
        path: '/documents/New App'
      }
    })
    await expect(store.getState()).resolves.toMatchObject({
      activeProjectSelection: {
        projectKind: 'path',
        path: '/documents/New App'
      },
      activeWorkspaceRoots: ['/documents/New App'],
      workspaceRootOptions: [
        {
          root: '/documents/New App',
          label: 'New App',
          hostId: 'local'
        }
      ]
    })
  })

  it('keeps the requested project name when only the directory name conflicts', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn(),
      createBlankProjectRoot: async () => '/documents/New App 2'
    })

    const result = await service.createBlankProject(
      'New App',
      '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b'
    )

    expect(result.option).toMatchObject({
      root: '/documents/New App 2',
      label: 'New App'
    })
  })

  it('uses the suffixed directory name when both path and project name conflict', async () => {
    const store = ProjectStore.inMemory({
      ...createDefaultProjectState(),
      workspaceRootOptions: [
        {
          root: '/documents/New App',
          label: 'New App',
          hostId: 'local',
          addedAt: '2026-07-17T00:00:00.000Z',
          lastOpenedAt: '2026-07-17T00:00:00.000Z'
        }
      ]
    })
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn(),
      createBlankProjectRoot: async () => '/documents/New App 2'
    })

    const result = await service.createBlankProject(
      'New App',
      '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b'
    )

    expect(result.option).toMatchObject({
      root: '/documents/New App 2',
      label: 'New App 2'
    })
  })

  it('reports the created path when registration fails', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    vi.spyOn(store, 'setState').mockRejectedValue(new Error('write failed'))
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn(),
      createBlankProjectRoot: async () => '/documents/Recover Me'
    })

    await expect(
      service.createBlankProject('Recover Me', '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b')
    ).rejects.toThrow('/documents/Recover Me')
  })

  it('reuses a completed blank-project operation instead of creating another root', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const createBlankProjectRoot = vi.fn(async () => '/documents/New App')
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn(),
      createBlankProjectRoot
    })
    const operationId = '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b'

    const first = await service.createBlankProject('New App', operationId)
    const retry = await service.createBlankProject('New App', operationId)

    expect(retry).toEqual(first)
    expect(createBlankProjectRoot).toHaveBeenCalledOnce()
  })

  it('leaves state unchanged when the folder picker is cancelled', async () => {
    const initialState = createDefaultProjectState()
    const store = ProjectStore.inMemory(initialState)
    const service = new ProjectApiService({
      store,
      validateLocalRoot: vi.fn(),
      pickWorkspaceRoot: async () => null
    })

    await expect(service.pickWorkspaceRoot()).resolves.toBeNull()
    await expect(store.getState()).resolves.toEqual(initialState)
  })

  it('creates and activates a local project from validated roots', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: `/real${path}` }),
      pickWorkspaceRoot: vi.fn()
    })

    const project = await service.createLocalProject({
      name: 'Desktop App',
      sourceRoots: ['/repo', '/repo/packages/api']
    })

    expect(project).toMatchObject({
      kind: 'local',
      name: 'Desktop App',
      writableRoots: ['/real/repo', '/real/repo/packages/api'],
      defaultCwd: '/real/repo'
    })
    await expect(store.getState()).resolves.toMatchObject({
      activeLocalProjectId: project.id,
      activeProjectSelection: { projectKind: 'local', projectId: project.id },
      activeWorkspaceRoots: ['/real/repo', '/real/repo/packages/api'],
      projectWritableRoots: {
        [project.id]: ['/real/repo', '/real/repo/packages/api']
      }
    })
  })

  it('allows UUID-backed local projects to share both name and source root', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn()
    })

    const first = await service.createLocalProject({
      name: 'Desktop App',
      sourceRoots: ['/repo']
    })
    const second = await service.createLocalProject({
      name: 'Desktop App',
      sourceRoots: ['/repo']
    })

    expect(second.id).not.toBe(first.id)
    expect(first).toMatchObject({ name: 'Desktop App', writableRoots: ['/repo'] })
    expect(second).toMatchObject({ name: 'Desktop App', writableRoots: ['/repo'] })
    await expect(store.getState()).resolves.toMatchObject({
      localProjects: {
        [first.id]: { name: 'Desktop App', writableRoots: ['/repo'] },
        [second.id]: { name: 'Desktop App', writableRoots: ['/repo'] }
      }
    })
  })

  it('rejects local project creation without source roots', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: `/real${path}` }),
      pickWorkspaceRoot: vi.fn()
    })

    await expect(
      service.createLocalProject({
        name: 'Empty',
        sourceRoots: []
      })
    ).rejects.toThrow('Local project requires at least one source root')
  })

  it('selects a registered path root through validation before storing it as active', async () => {
    const store = ProjectStore.inMemory({
      ...createDefaultProjectState(),
      workspaceRootOptions: [
        {
          root: '/real/repo',
          label: 'Repo',
          hostId: 'local',
          addedAt: '2026-06-29T00:00:00.000Z',
          lastOpenedAt: '2026-06-29T00:00:00.000Z'
        }
      ]
    })
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: `/real${path}` }),
      pickWorkspaceRoot: vi.fn()
    })

    await service.selectProject({ projectKind: 'path', path: '/repo' })

    await expect(store.getState()).resolves.toMatchObject({
      activeProjectSelection: { projectKind: 'path', path: '/real/repo' },
      activeWorkspaceRoots: ['/real/repo'],
      workspaceRootOptions: [
        {
          root: '/real/repo',
          hostId: 'local',
          label: 'Repo'
        }
      ]
    })
  })

  it('registers and activates a main-verified worktree', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const validateLocalRoot = vi.fn(async (path: string) => ({ realPath: `/real${path}` }))
    const service = new ProjectApiService({
      store,
      validateLocalRoot,
      pickWorkspaceRoot: vi.fn()
    })

    const state = await service.activateVerifiedWorktree({
      path: '/repo/feature-worktree',
      branch: 'feature/widget',
      isCurrent: false
    })

    expect(validateLocalRoot).toHaveBeenCalledWith('/repo/feature-worktree')
    expect(state).toMatchObject({
      activeProjectSelection: { projectKind: 'path', path: '/real/repo/feature-worktree' },
      activeWorkspaceRoots: ['/real/repo/feature-worktree'],
      workspaceRootOptions: [
        {
          root: '/real/repo/feature-worktree',
          label: 'feature-worktree (feature/widget)',
          hostId: 'local'
        }
      ]
    })
  })

  it('rejects unregistered path selections from renderer-owned calls', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: `/real${path}` }),
      pickWorkspaceRoot: vi.fn()
    })

    await expect(service.selectProject({ projectKind: 'path', path: '/repo' })).rejects.toThrow(
      'Workspace root is not registered'
    )
  })

  it('creates and activates a remote project', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const validateRemoteRoot = vi.fn(async () => undefined)
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      validateRemoteRoot,
      pickWorkspaceRoot: vi.fn()
    })

    const project = await service.createRemoteProject({
      hostId: 'ssh-devbox',
      label: 'Staging API',
      remotePath: '/srv/staging-api',
      execServerUrl: 'wss://exec.example.test/codex'
    })

    expect(validateRemoteRoot).toHaveBeenCalledWith('ssh-devbox', '/srv/staging-api')
    expect(project).toMatchObject({
      kind: 'remote',
      hostId: 'ssh-devbox',
      label: 'Staging API',
      remotePath: '/srv/staging-api',
      execServerUrl: 'wss://exec.example.test/codex'
    })
    await expect(store.getState()).resolves.toMatchObject({
      activeRemoteProjectId: project.id,
      activeProjectSelection: {
        projectKind: 'remote',
        projectId: project.id,
        hostId: 'ssh-devbox'
      },
      activeWorkspaceRoots: ['/srv/staging-api']
    })
  })

  it('rejects relative remote project paths before host validation', async () => {
    const store = ProjectStore.inMemory(createDefaultProjectState())
    const validateRemoteRoot = vi.fn(async () => undefined)
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      validateRemoteRoot,
      pickWorkspaceRoot: vi.fn()
    })

    await expect(
      service.createRemoteProject({
        hostId: 'ssh-devbox',
        label: 'Staging API',
        remotePath: '../srv/staging-api',
        execServerUrl: 'wss://exec.example.test/codex'
      })
    ).rejects.toThrow('must be an absolute POSIX path')
    expect(validateRemoteRoot).not.toHaveBeenCalled()
  })

  it('renames local, remote, and path project entries', async () => {
    const store = ProjectStore.inMemory({
      ...createDefaultProjectState(),
      localProjects: {
        local1: {
          id: 'local1',
          kind: 'local',
          name: 'Old Local',
          hostId: 'local',
          createdAt: '2026-06-29T00:00:00.000Z',
          updatedAt: '2026-06-29T00:00:00.000Z',
          writableRoots: ['/repo']
        }
      },
      remoteProjects: [
        {
          id: 'remote1',
          kind: 'remote',
          hostId: 'ssh-devbox',
          label: 'Old Remote',
          remotePath: '/srv/app',
          createdAt: '2026-06-29T00:00:00.000Z',
          updatedAt: '2026-06-29T00:00:00.000Z'
        }
      ],
      workspaceRootOptions: [
        {
          root: '/repo',
          label: 'Old Path',
          hostId: 'local',
          addedAt: '2026-06-29T00:00:00.000Z',
          lastOpenedAt: '2026-06-29T00:00:00.000Z'
        }
      ]
    })
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn()
    })

    await service.renameProject({ projectKind: 'local', projectId: 'local1', label: 'New Local' })
    await service.renameProject({
      projectKind: 'remote',
      projectId: 'remote1',
      label: 'New Remote'
    })
    await service.renameProject({ projectKind: 'path', path: '/repo', label: 'New Path' })

    await expect(store.getState()).resolves.toMatchObject({
      localProjects: {
        local1: { name: 'New Local' }
      },
      remoteProjects: [{ id: 'remote1', label: 'New Remote' }],
      workspaceRootOptions: [{ root: '/repo', label: 'New Path' }]
    })
  })

  it('removes selected projects and clears active selection', async () => {
    const store = ProjectStore.inMemory({
      ...createDefaultProjectState(),
      activeLocalProjectId: 'local1',
      activeProjectSelection: { projectKind: 'local', projectId: 'local1' },
      activeWorkspaceRoots: ['/repo'],
      localProjects: {
        local1: {
          id: 'local1',
          kind: 'local',
          name: 'Local',
          hostId: 'local',
          createdAt: '2026-06-29T00:00:00.000Z',
          updatedAt: '2026-06-29T00:00:00.000Z',
          writableRoots: ['/repo']
        }
      },
      projectOrder: ['local1'],
      pinnedProjectIds: ['local1'],
      projectWritableRoots: { local1: ['/repo'] }
    })
    const service = new ProjectApiService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      pickWorkspaceRoot: vi.fn()
    })

    const state = await service.removeProject({ projectKind: 'local', projectId: 'local1' })

    expect(state.localProjects).toEqual({})
    expect(state.projectOrder).toEqual([])
    expect(state.pinnedProjectIds).toEqual([])
    expect(state.projectWritableRoots).toEqual({})
    expect(state.activeLocalProjectId).toBeUndefined()
    expect(state.activeProjectSelection).toBeUndefined()
    expect(state.activeWorkspaceRoots).toEqual([])
  })
})
