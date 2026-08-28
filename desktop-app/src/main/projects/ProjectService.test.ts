import { describe, expect, it, vi } from 'vitest'

import type { ResolvedExecutionTarget } from '../../shared/projects/projectTypes'
import {
  ProjectService,
  type ProjectServiceDependencies,
  type ThreadReader
} from './ProjectService'
import { ProjectStore, createDefaultProjectState, type ProjectState } from './ProjectStore'

const now = '2026-06-29T00:00:00.000Z'

type ProjectServiceFixture = {
  service: ProjectService
  readThread: ReturnType<typeof vi.fn<ThreadReader>>
  validateLocalRoot: ReturnType<typeof vi.fn<ProjectServiceDependencies['validateLocalRoot']>>
  validateRemoteRoot: ReturnType<typeof vi.fn<ProjectServiceDependencies['validateRemoteRoot']>>
  createProjectlessWorkspace: ReturnType<
    typeof vi.fn<ProjectServiceDependencies['createProjectlessWorkspace']>
  >
}

function makeProjectService(state: Partial<ProjectState> = {}): ProjectServiceFixture {
  const store = ProjectStore.inMemory({
    ...createDefaultProjectState(),
    ...state
  })
  const validateLocalRoot = vi.fn(async (path: string) => ({ realPath: path }))
  const validateRemoteRoot = vi.fn(async () => undefined)
  const createProjectlessWorkspace = vi.fn(async () => ({
    cwd: '/tmp/codex/projectless/work',
    workspaceRoot: '/tmp/codex/projectless',
    outputDirectory: '/tmp/codex/projectless/out'
  }))
  const readThread = vi.fn(async () => ({ thread: { cwd: '/thread/cwd' } }))

  return {
    service: new ProjectService({
      store,
      validateLocalRoot,
      validateRemoteRoot,
      createProjectlessWorkspace,
      readThread
    }),
    readThread,
    validateLocalRoot,
    validateRemoteRoot,
    createProjectlessWorkspace
  }
}

describe('ProjectService', () => {
  it('resolves local project to cwd and workspace roots', async () => {
    const { service } = makeProjectService({
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/repo', '/repo/packages/api']
        }
      }
    })

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'local', projectId: 'p1' },
        prompt: 'fix tests'
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/repo',
      workspaceRoots: ['/repo', '/repo/packages/api'],
      workspaceKind: 'project',
      projectAssignment: { projectKind: 'local', projectId: 'p1', cwd: '/repo' }
    })
  })

  it('uses local project defaultCwd when provided', async () => {
    const { service } = makeProjectService({
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/repo', '/repo/packages/api'],
          defaultCwd: '/repo/packages/api'
        }
      }
    })

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'local', projectId: 'p1' },
        prompt: 'fix api'
      })
    ).resolves.toMatchObject({
      cwd: '/repo/packages/api',
      workspaceRoots: ['/repo', '/repo/packages/api'],
      projectAssignment: { projectKind: 'local', projectId: 'p1', cwd: '/repo/packages/api' }
    })
  })

  it('uses normalized local project defaultCwd when it matches a writable root', async () => {
    const { service, validateLocalRoot } = makeProjectService({
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/repo', '/repo/packages/api'],
          defaultCwd: '/repo/link-api'
        }
      }
    })
    validateLocalRoot.mockImplementation(async (path: string) => ({
      realPath: path === '/repo/link-api' ? '/repo/packages/api' : path
    }))

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'local', projectId: 'p1' },
        prompt: 'fix api'
      })
    ).resolves.toMatchObject({
      cwd: '/repo/packages/api',
      workspaceRoots: ['/repo', '/repo/packages/api'],
      projectAssignment: { projectKind: 'local', projectId: 'p1', cwd: '/repo/packages/api' }
    })
  })

  it('rejects local project defaultCwd outside writable roots after normalization', async () => {
    const { service, validateLocalRoot } = makeProjectService({
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/repo'],
          defaultCwd: '/outside-link'
        }
      }
    })
    validateLocalRoot.mockImplementation(async (path: string) => ({
      realPath: path === '/outside-link' ? '/outside' : path
    }))

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'local', projectId: 'p1' },
        prompt: 'fix api'
      })
    ).rejects.toThrow('Default cwd is not in writable roots')
  })

  it('resolves remote project to host and remote root', async () => {
    const { service, validateRemoteRoot } = makeProjectService({
      remoteProjects: [
        {
          id: 'r1',
          kind: 'remote',
          hostId: 'ssh-prod',
          label: 'Prod',
          remotePath: '/srv/app',
          execServerUrl: 'wss://exec.example.test/codex',
          createdAt: now,
          updatedAt: now
        }
      ]
    })

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'remote', projectId: 'r1', hostId: 'ssh-prod' },
        prompt: 'inspect logs'
      })
    ).resolves.toEqual({
      hostId: 'ssh-prod',
      cwd: '/srv/app',
      remoteEnvironment: {
        environmentId: 'ssh-prod',
        cwd: '/srv/app',
        execServerUrl: 'wss://exec.example.test/codex'
      },
      workspaceRoots: ['/srv/app'],
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'remote',
        projectId: 'r1',
        hostId: 'ssh-prod',
        cwd: '/srv/app'
      }
    })
    expect(validateRemoteRoot).toHaveBeenCalledWith('ssh-prod', '/srv/app')
  })

  it('normalizes path selections through local validation', async () => {
    const { service, validateLocalRoot } = makeProjectService({
      activeProjectSelection: { projectKind: 'path', path: '/real/repo' },
      workspaceRootOptions: [
        {
          root: '/real/repo',
          hostId: 'local',
          addedAt: now,
          lastOpenedAt: now
        }
      ]
    })
    validateLocalRoot.mockResolvedValueOnce({ realPath: '/real/repo' })

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'path', path: '~/repo' },
        prompt: 'start here'
      })
    ).resolves.toEqual({
      hostId: 'local',
      cwd: '/real/repo',
      workspaceRoots: ['/real/repo'],
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'local',
        projectId: '/real/repo',
        path: '/real/repo',
        cwd: '/real/repo'
      }
    })
    expect(validateLocalRoot).toHaveBeenCalledWith('~/repo')
  })

  it('rejects new thread path selections that are not a registered root', async () => {
    const { service } = makeProjectService({
      activeProjectSelection: { projectKind: 'path', path: '/safe/repo' },
      workspaceRootOptions: [
        {
          root: '/safe/repo',
          hostId: 'local',
          addedAt: now,
          lastOpenedAt: now
        }
      ]
    })

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'path', path: '/malicious' },
        prompt: 'start here'
      })
    ).rejects.toThrow('Workspace root is not a registered project')
  })

  it('creates projectless workspace when no project is selected', async () => {
    const { service, createProjectlessWorkspace } = makeProjectService()

    await expect(
      service.resolveNewThreadTarget({
        prompt: 'scratch work'
      })
    ).resolves.toEqual({
      hostId: 'local',
      cwd: '/tmp/codex/projectless/work',
      workspaceRoots: ['/tmp/codex/projectless'],
      workspaceKind: 'projectless',
      projectAssignment: {
        projectKind: 'projectless',
        cwd: '/tmp/codex/projectless/work',
        workspaceRoot: '/tmp/codex/projectless',
        outputDirectory: '/tmp/codex/projectless/out'
      }
    })
    expect(createProjectlessWorkspace).toHaveBeenCalledWith({ prompt: 'scratch work' })
  })

  it('resolves existing thread from stored assignment before app-server cwd', async () => {
    const { service, readThread, validateLocalRoot } = makeProjectService({
      threadProjectAssignments: {
        c1: {
          projectKind: 'local',
          projectId: 'p1',
          cwd: '/assigned/cwd'
        }
      },
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/assigned/cwd']
        }
      }
    })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1'
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/assigned/cwd',
      workspaceRoots: ['/assigned/cwd'],
      workspaceKind: 'project'
    })
    expect(readThread).not.toHaveBeenCalled()
    expect(validateLocalRoot).toHaveBeenCalledWith('/assigned/cwd')
  })

  it('uses only its own directory for an app-managed worktree assignment', async () => {
    const { service, validateLocalRoot } = makeProjectService({
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/repo']
        }
      },
      threadProjectAssignments: {
        forked: {
          projectKind: 'local',
          projectId: 'p1',
          cwd: '/app-data/worktrees/fork-1',
          path: '/app-data/worktrees/fork-1',
          managedWorktree: {
            workspaceKind: 'managed-worktree',
            managedByApp: true,
            repositoryRoot: '/repo',
            worktreePath: '/app-data/worktrees/fork-1',
            branch: 'codex/fork-1',
            ref: 'abc123',
            createdFrom: 'conversation-fork',
            recoverable: true
          }
        }
      }
    })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'forked',
        threadId: 'forked'
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/app-data/worktrees/fork-1',
      workspaceRoots: ['/app-data/worktrees/fork-1']
    })
    expect(validateLocalRoot).toHaveBeenCalledWith('/app-data/worktrees/fork-1')
  })

  it('prefers stored assignment keyed by app-server thread id over conversation id', async () => {
    const { service, readThread } = makeProjectService({
      threadProjectAssignments: {
        'conversation-temp': {
          projectKind: 'local',
          projectId: 'old',
          cwd: '/old/cwd'
        },
        'thread-real': {
          projectKind: 'local',
          projectId: 'current',
          cwd: '/current/cwd'
        }
      },
      localProjects: {
        old: {
          id: 'old',
          kind: 'local',
          name: 'Old',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/old/cwd']
        },
        current: {
          id: 'current',
          kind: 'local',
          name: 'Current',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/current/cwd']
        }
      }
    })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'conversation-temp',
        threadId: 'thread-real'
      })
    ).resolves.toMatchObject({
      cwd: '/current/cwd',
      workspaceRoots: ['/current/cwd'],
      projectAssignment: {
        projectKind: 'local',
        projectId: 'current',
        cwd: '/current/cwd'
      }
    })
    expect(readThread).not.toHaveBeenCalled()
  })

  it('validates and canonicalizes local assignments for existing threads', async () => {
    const { service, validateLocalRoot } = makeProjectService({
      threadProjectAssignments: {
        c1: {
          projectKind: 'local',
          projectId: 'p1',
          cwd: '/repo/link-api'
        }
      },
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/repo', '/repo/packages/api']
        }
      }
    })
    validateLocalRoot.mockImplementation(async (path: string) => ({
      realPath: path === '/repo/link-api' ? '/repo/packages/api' : path
    }))

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1'
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/repo/packages/api',
      workspaceRoots: ['/repo', '/repo/packages/api'],
      workspaceKind: 'project',
      projectAssignment: { projectKind: 'local', projectId: 'p1', cwd: '/repo/packages/api' }
    })
  })

  it('validates local assignment path when assigned project no longer exists', async () => {
    const { service, validateLocalRoot } = makeProjectService({
      threadProjectAssignments: {
        c1: {
          projectKind: 'local',
          projectId: '/stale/link',
          path: '/stale/link',
          cwd: null
        }
      }
    })
    validateLocalRoot.mockResolvedValueOnce({ realPath: '/real/stale' })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1'
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/real/stale',
      workspaceRoots: ['/real/stale'],
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'local',
        projectId: '/stale/link',
        path: '/real/stale',
        cwd: '/real/stale'
      }
    })
    expect(validateLocalRoot).toHaveBeenCalledWith('/stale/link')
  })

  it('validates remote assignments for existing threads', async () => {
    const { service, validateRemoteRoot } = makeProjectService({
      remoteProjects: [
        {
          id: 'r1',
          kind: 'remote',
          hostId: 'ssh-prod',
          label: 'Prod',
          remotePath: '/srv/app',
          execServerUrl: 'wss://exec.example.test/codex',
          createdAt: now,
          updatedAt: now
        }
      ],
      threadProjectAssignments: {
        c1: {
          projectKind: 'remote',
          projectId: 'r1',
          hostId: 'ssh-prod',
          cwd: '/srv/app'
        }
      }
    })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1'
      })
    ).resolves.toMatchObject({
      hostId: 'ssh-prod',
      cwd: '/srv/app',
      remoteEnvironment: {
        environmentId: 'ssh-prod',
        cwd: '/srv/app',
        execServerUrl: 'wss://exec.example.test/codex'
      },
      workspaceRoots: ['/srv/app'],
      workspaceKind: 'project'
    })
    expect(validateRemoteRoot).toHaveBeenCalledWith('ssh-prod', '/srv/app')
  })

  it('blocks legacy remote projects that have no execution server configuration', async () => {
    const { service } = makeProjectService({
      remoteProjects: [
        {
          id: 'r1',
          kind: 'remote',
          hostId: 'ssh-prod',
          label: 'Prod',
          remotePath: '/srv/app',
          createdAt: now,
          updatedAt: now
        }
      ]
    })

    await expect(
      service.resolveNewThreadTarget({
        selection: { projectKind: 'remote', projectId: 'r1', hostId: 'ssh-prod' },
        prompt: 'inspect logs'
      })
    ).rejects.toThrow('no Codex execution server')
  })

  it('reconnects an existing remote assignment through a replacement project at the same host and path', async () => {
    const { service } = makeProjectService({
      remoteProjects: [
        {
          id: 'r2',
          kind: 'remote',
          hostId: 'ssh-prod',
          label: 'Reconnected Prod',
          remotePath: '/srv/app',
          execServerUrl: 'wss://exec.example.test/codex',
          createdAt: now,
          updatedAt: now
        }
      ],
      threadProjectAssignments: {
        c1: {
          projectKind: 'remote',
          projectId: 'r1',
          hostId: 'ssh-prod',
          cwd: '/srv/app'
        }
      }
    })

    await expect(
      service.resolveExistingThreadTarget({ conversationId: 'c1', threadId: 't1' })
    ).resolves.toMatchObject({
      remoteEnvironment: {
        environmentId: 'ssh-prod',
        cwd: '/srv/app',
        execServerUrl: 'wss://exec.example.test/codex'
      }
    })
  })

  it('falls back to app-server thread cwd for existing threads', async () => {
    const { service, readThread } = makeProjectService()

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1'
      })
    ).resolves.toEqual({
      hostId: 'local',
      cwd: '/thread/cwd',
      workspaceRoots: ['/thread/cwd'],
      workspaceKind: 'project'
    } satisfies ResolvedExecutionTarget)
    expect(readThread).toHaveBeenCalledWith('t1')
  })

  it('returns route fallback before active project fallback', async () => {
    const routeFallback = {
      hostId: 'local',
      cwd: '/route/cwd',
      workspaceRoots: ['/route/cwd'],
      workspaceKind: 'project'
    } satisfies ResolvedExecutionTarget
    const { service, readThread } = makeProjectService({
      activeLocalProjectId: 'p1',
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/active/repo']
        }
      }
    })
    readThread.mockResolvedValueOnce({ thread: { cwd: null } })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1',
        routeFallback,
        allowActiveProjectFallback: true
      })
    ).resolves.toBe(routeFallback)
  })

  it('does not use active project for existing thread continuation by default', async () => {
    const { service, readThread } = makeProjectService({
      activeLocalProjectId: 'p1',
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/active/repo']
        }
      }
    })
    readThread.mockResolvedValueOnce({ thread: { cwd: null } })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1'
      })
    ).resolves.toBeNull()
  })

  it('does not use active project for existing thread continuation even when fallback is allowed', async () => {
    const { service, readThread } = makeProjectService({
      activeLocalProjectId: 'p1',
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/active/repo']
        }
      }
    })
    readThread.mockResolvedValueOnce({ thread: { cwd: null } })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1',
        allowActiveProjectFallback: true
      })
    ).resolves.toBeNull()
  })

  it('uses the registered active project only when a workspace tool explicitly requests it for an unbound thread', async () => {
    const { service, readThread } = makeProjectService({
      activeLocalProjectId: 'p1',
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/active/repo']
        }
      }
    })
    readThread.mockResolvedValueOnce({ thread: { cwd: null } })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        threadId: 't1',
        allowActiveProjectFallback: true,
        allowActiveProjectFallbackForUnboundThread: true
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/active/repo',
      workspaceRoots: ['/active/repo'],
      workspaceKind: 'project'
    })
    expect(readThread).toHaveBeenCalledWith('t1')
  })

  it('uses active project fallback for brand-new home composer state', async () => {
    const { service, readThread } = makeProjectService({
      activeLocalProjectId: 'p1',
      localProjects: {
        p1: {
          id: 'p1',
          kind: 'local',
          name: 'App',
          hostId: 'local',
          createdAt: now,
          updatedAt: now,
          writableRoots: ['/active/repo']
        }
      }
    })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        allowActiveProjectFallback: true
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/active/repo',
      workspaceRoots: ['/active/repo'],
      workspaceKind: 'project'
    })
    expect(readThread).not.toHaveBeenCalled()
  })

  it('uses the active path selection for a brand-new home composer state', async () => {
    const { service } = makeProjectService({
      activeProjectSelection: { projectKind: 'path', path: '/active/repo' },
      workspaceRootOptions: [
        {
          root: '/active/repo',
          hostId: 'local',
          addedAt: now,
          lastOpenedAt: now
        }
      ]
    })

    await expect(
      service.resolveExistingThreadTarget({
        conversationId: 'c1',
        allowActiveProjectFallback: true
      })
    ).resolves.toMatchObject({
      hostId: 'local',
      cwd: '/active/repo',
      workspaceRoots: ['/active/repo'],
      workspaceKind: 'project'
    })
  })
})
