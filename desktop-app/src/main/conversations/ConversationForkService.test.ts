import { describe, expect, it, vi } from 'vitest'

import { createDefaultProjectState, ProjectStore } from '../projects/ProjectStore'
import { ConversationForkService } from './ConversationForkService'

describe('ConversationForkService', () => {
  it('creates an independent temporary task and retains its workspace assignment', async () => {
    const state = createDefaultProjectState()
    state.threadProjectAssignments.source = {
      projectKind: 'local',
      projectId: '/repo',
      path: '/repo',
      cwd: '/repo'
    }
    state.threadWritableRoots.source = ['/repo', '/repo/shared']
    state.threadWorkspaceRootHints.source = ['/repo']
    const projectStore = ProjectStore.inMemory(state)
    const forkThread = vi.fn(async () => ({
      id: 'forked',
      title: 'Investigate',
      preview: 'Investigate',
      archived: false,
      running: false,
      cwd: '/repo'
    }))
    const service = new ConversationForkService({
      threadClient: { forkThread },
      projectStore
    })

    await expect(
      service.fork({
        conversationId: 'source',
        targetTurnId: 'turn-2',
        mode: 'side-task'
      })
    ).resolves.toMatchObject({
      thread: { id: 'forked' },
      projectAssignment: state.threadProjectAssignments.source
    })

    expect(forkThread).toHaveBeenCalledWith({
      threadId: 'source',
      targetTurnId: 'turn-2',
      ephemeral: false
    })
    await expect(projectStore.getState()).resolves.toMatchObject({
      threadProjectAssignments: {
        forked: state.threadProjectAssignments.source
      },
      threadWritableRoots: { forked: ['/repo', '/repo/shared'] },
      threadWorkspaceRootHints: { forked: ['/repo'] }
    })
  })

  it('does not write project state when the source task has no saved workspace metadata', async () => {
    const projectStore = ProjectStore.inMemory(createDefaultProjectState())
    const setState = vi.spyOn(projectStore, 'setState')
    const service = new ConversationForkService({
      threadClient: {
        forkThread: vi.fn(async () => ({
          id: 'forked',
          title: null,
          preview: '',
          archived: false,
          running: false,
          cwd: null
        }))
      },
      projectStore
    })

    await service.fork({
      conversationId: 'source',
      targetTurnId: 'turn-2',
      mode: 'new-task'
    })

    expect(setState).not.toHaveBeenCalled()
  })

  it('uses a managed worktree as the cloned task workspace', async () => {
    const projectStore = ProjectStore.inMemory(createDefaultProjectState())
    const projectAssignment = {
      projectKind: 'local' as const,
      projectId: '/repo',
      path: '/app-data/worktrees/fork-1',
      cwd: '/app-data/worktrees/fork-1',
      managedWorktree: {
        workspaceKind: 'managed-worktree' as const,
        managedByApp: true as const,
        repositoryRoot: '/repo',
        worktreePath: '/app-data/worktrees/fork-1',
        branch: 'codex/fork-1',
        ref: 'abc123',
        createdFrom: 'conversation-fork' as const,
        recoverable: true as const
      }
    }
    const forkThread = vi.fn(async () => ({
      id: 'forked',
      title: 'Forked',
      preview: '',
      archived: false,
      running: false,
      cwd: '/app-data/worktrees/fork-1'
    }))
    const createFork = vi.fn(async () => ({
      cwd: '/app-data/worktrees/fork-1',
      workspaceRoots: ['/app-data/worktrees/fork-1'],
      projectAssignment
    }))
    const removeFork = vi.fn(async () => undefined)
    const service = new ConversationForkService({
      threadClient: { forkThread },
      projectStore,
      managedWorktrees: { createFork, removeFork }
    })

    await service.fork({
      conversationId: 'source',
      targetTurnId: 'turn-2',
      mode: 'new-worktree'
    })

    expect(createFork).toHaveBeenCalledWith({ conversationId: 'source', threadId: 'source' })
    expect(forkThread).toHaveBeenCalledWith({
      threadId: 'source',
      targetTurnId: 'turn-2',
      ephemeral: false,
      cwd: '/app-data/worktrees/fork-1',
      runtimeWorkspaceRoots: ['/app-data/worktrees/fork-1']
    })
    await expect(projectStore.getState()).resolves.toMatchObject({
      threadProjectAssignments: { forked: projectAssignment },
      threadWritableRoots: { forked: ['/app-data/worktrees/fork-1'] },
      threadWorkspaceRootHints: { forked: ['/app-data/worktrees/fork-1'] }
    })
  })

  it('removes a newly created worktree when thread cloning fails', async () => {
    const worktree = {
      cwd: '/app-data/worktrees/fork-1',
      workspaceRoots: ['/app-data/worktrees/fork-1'],
      projectAssignment: {
        projectKind: 'local' as const,
        projectId: '/repo',
        cwd: '/app-data/worktrees/fork-1',
        managedWorktree: {
          workspaceKind: 'managed-worktree' as const,
          managedByApp: true as const,
          repositoryRoot: '/repo',
          worktreePath: '/app-data/worktrees/fork-1',
          branch: 'codex/fork-1',
          ref: 'abc123',
          createdFrom: 'conversation-fork' as const,
          recoverable: true as const
        }
      }
    }
    const createFork = vi.fn(async () => worktree)
    const removeFork = vi.fn(async () => undefined)
    const service = new ConversationForkService({
      threadClient: {
        forkThread: vi.fn(async () => {
          throw new Error('rollback unavailable')
        })
      },
      projectStore: ProjectStore.inMemory(createDefaultProjectState()),
      managedWorktrees: { createFork, removeFork }
    })

    await expect(
      service.fork({
        conversationId: 'source',
        targetTurnId: 'turn-2',
        mode: 'new-worktree'
      })
    ).rejects.toThrow('rollback unavailable')
    expect(removeFork).toHaveBeenCalledWith(worktree)
  })

  it('retains a cloned worktree when saving local project state fails', async () => {
    const worktree = {
      cwd: '/app-data/worktrees/fork-1',
      workspaceRoots: ['/app-data/worktrees/fork-1'],
      projectAssignment: {
        projectKind: 'local' as const,
        projectId: '/repo',
        cwd: '/app-data/worktrees/fork-1',
        managedWorktree: {
          workspaceKind: 'managed-worktree' as const,
          managedByApp: true as const,
          repositoryRoot: '/repo',
          worktreePath: '/app-data/worktrees/fork-1',
          branch: 'codex/fork-1',
          ref: 'abc123',
          createdFrom: 'conversation-fork' as const,
          recoverable: true as const
        }
      }
    }
    const removeFork = vi.fn(async () => undefined)
    const projectStore = {
      getState: vi.fn(async () => createDefaultProjectState()),
      setState: vi.fn(async () => {
        throw new Error('project state unavailable')
      })
    }
    const service = new ConversationForkService({
      threadClient: {
        forkThread: vi.fn(async () => ({
          id: 'forked',
          title: 'Forked',
          preview: '',
          archived: false,
          running: false,
          cwd: worktree.cwd
        }))
      },
      projectStore,
      managedWorktrees: {
        createFork: vi.fn(async () => worktree),
        removeFork
      }
    })

    await expect(
      service.fork({
        conversationId: 'source',
        targetTurnId: 'turn-2',
        mode: 'new-worktree'
      })
    ).rejects.toThrow('project state unavailable')

    expect(removeFork).not.toHaveBeenCalled()
  })
})
