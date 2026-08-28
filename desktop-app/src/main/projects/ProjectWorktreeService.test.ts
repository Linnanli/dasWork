import { describe, expect, it, vi } from 'vitest'

import { ProjectWorktreeService } from './ProjectWorktreeService'

const source = { projectKind: 'path' as const, path: '/repo/main' }

describe('ProjectWorktreeService', () => {
  it('lists current, branch, and detached worktrees from Git porcelain output', async () => {
    const runGit = vi.fn().mockResolvedValue({
      success: true,
      code: 0,
      stderr: '',
      stdout: [
        'worktree /repo/main',
        'HEAD 0123456789abcdef',
        'branch refs/heads/main',
        '',
        'worktree /repo/feature',
        'HEAD fedcba9876543210',
        'branch refs/heads/feature/widget',
        '',
        'worktree /repo/detached',
        'HEAD abcdef0123456789',
        '',
        'worktree /repo/removed',
        'HEAD 9999999999999999',
        'prunable gitdir file points to non-existent location',
        '',
        'worktree /repo/bare',
        'bare',
        ''
      ].join('\n')
    })
    const service = createService(runGit)

    await expect(service.list(source)).resolves.toEqual([
      { path: '/repo/main', branch: 'main', isCurrent: true },
      { path: '/repo/feature', branch: 'feature/widget', isCurrent: false },
      { path: '/repo/detached', branch: null, isCurrent: false }
    ])
    expect(runGit).toHaveBeenCalledWith(['worktree', 'list', '--porcelain'], '/repo/main')
  })

  it('rejects sources that cannot be safe local Git worktrees', async () => {
    const service = createService(vi.fn())

    await expect(
      service.list({ projectKind: 'remote', projectId: 'remote', hostId: 'ssh-dev' })
    ).rejects.toThrow('远程项目')
    await expect(service.list({ projectKind: 'projectless' })).rejects.toThrow('本地 Git 项目')
  })

  it('revalidates selection against a freshly listed canonical worktree path', async () => {
    const runGit = vi.fn().mockResolvedValue({
      success: true,
      code: 0,
      stdout: 'worktree /repo/main\nbranch refs/heads/main\n\nworktree /repo/feature\n',
      stderr: ''
    })
    const service = createService(runGit, async (path) =>
      path === '/repo/feature-link' ? '/repo/feature' : path
    )

    await expect(service.resolve(source, '/repo/feature-link')).resolves.toEqual({
      path: '/repo/feature',
      branch: null,
      isCurrent: false
    })
    await expect(service.resolve(source, '/repo/not-listed')).rejects.toThrow(
      '不是当前项目的 Git worktree'
    )
  })

  it('does not expose a worktree whose path cannot be canonicalized', async () => {
    const runGit = vi.fn().mockResolvedValue({
      success: true,
      code: 0,
      stdout: 'worktree /repo/main\nbranch refs/heads/main\n\nworktree /repo/gone\n',
      stderr: ''
    })
    const service = createService(runGit, async (path) => {
      if (path === '/repo/gone') throw new Error('missing')
      return path
    })

    await expect(service.list(source)).resolves.toEqual([
      { path: '/repo/main', branch: 'main', isCurrent: true }
    ])
  })
})

function createService(
  runGit: ReturnType<typeof vi.fn>,
  canonicalize: (path: string) => Promise<string> = async (path) => path
): ProjectWorktreeService {
  return new ProjectWorktreeService({
    projectService: {
      resolveNewThreadTarget: async () => ({ hostId: 'local', cwd: '/repo/main' })
    },
    gitHost: { runGit },
    canonicalize
  })
}
