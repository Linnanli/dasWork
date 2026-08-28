import { describe, expect, it, vi } from 'vitest'

import { ManagedWorktreeService } from './ManagedWorktreeService'

describe('ManagedWorktreeService', () => {
  it('creates an app-owned local worktree with a fresh branch', async () => {
    const runGit = vi.fn(async (args: readonly string[]) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        return { success: true, code: 0, stdout: '/repo\n', stderr: '' }
      }
      if (args.join(' ') === 'rev-parse --verify HEAD^{commit}') {
        return { success: true, code: 0, stdout: 'abc123\n', stderr: '' }
      }
      return { success: true, code: 0, stdout: '', stderr: '' }
    })
    const gitHost = { id: 'local', isLocal: true, runGit }
    const invalidateStableMetadata = vi.fn()
    const invalidateGitReadCachesForMutation = vi.fn(async () => undefined)
    const mkdir = vi.fn(async () => undefined)
    const realpath = vi.fn(async () => '/canonical/worktrees')
    const service = new ManagedWorktreeService({
      projectService: {
        resolveExistingThreadTarget: vi.fn(async () => ({
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo'],
          workspaceKind: 'project' as const,
          projectAssignment: {
            projectKind: 'local' as const,
            projectId: '/repo',
            cwd: '/repo'
          }
        }))
      },
      gitHost,
      gitManager: { invalidateStableMetadata, invalidateGitReadCachesForMutation },
      worktreeRoot: '/app-data/worktrees',
      mkdir,
      realpath,
      createId: () => '12345678-90ab-cdef-1234-567890abcdef'
    })

    await expect(
      service.createFork({ conversationId: 'source', threadId: 'source' })
    ).resolves.toMatchObject({
      cwd: '/canonical/worktrees/fork-1234567890abcdef1234567890abcdef',
      workspaceRoots: ['/canonical/worktrees/fork-1234567890abcdef1234567890abcdef'],
      projectAssignment: {
        projectKind: 'local',
        projectId: '/repo',
        managedWorktree: {
          repositoryRoot: '/repo',
          branch: 'codex/fork-1234567890ab',
          ref: 'abc123'
        }
      }
    })

    expect(mkdir).toHaveBeenCalledWith('/app-data/worktrees', { recursive: true })
    expect(realpath).toHaveBeenCalledWith('/app-data/worktrees')
    expect(runGit).toHaveBeenLastCalledWith(
      [
        'worktree',
        'add',
        '-b',
        'codex/fork-1234567890ab',
        '/canonical/worktrees/fork-1234567890abcdef1234567890abcdef',
        'abc123'
      ],
      '/repo'
    )
    expect(invalidateStableMetadata).toHaveBeenCalledOnce()
    expect(invalidateGitReadCachesForMutation).toHaveBeenCalledWith('/repo', gitHost)
  })

  it('explains why a remote or projectless task cannot use a local worktree', async () => {
    const service = new ManagedWorktreeService({
      projectService: {
        resolveExistingThreadTarget: vi.fn(async () => ({
          hostId: 'remote-host',
          cwd: '/remote/repo',
          workspaceRoots: ['/remote/repo'],
          workspaceKind: 'project' as const
        }))
      },
      gitHost: {
        id: 'local',
        isLocal: true,
        runGit: vi.fn()
      },
      gitManager: {
        invalidateStableMetadata: vi.fn(),
        invalidateGitReadCachesForMutation: vi.fn(async () => undefined)
      },
      worktreeRoot: '/app-data/worktrees'
    })

    await expect(
      service.createFork({ conversationId: 'source', threadId: 'source' })
    ).rejects.toThrow('当前任务不在本地 Git 工作区中')
  })
})
