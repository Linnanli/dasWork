import { realpath } from 'node:fs/promises'

import type { ProjectSelection, ProjectWorktree } from '../../shared/projects/projectTypes'
import type { GitHost } from '../localGit/GitManager'
import type { ProjectService } from './ProjectService'

type CanonicalPathResolver = (path: string) => Promise<string>

/**
 * Lists only worktrees that Git reports for an already configured local
 * project.  The renderer never chooses an arbitrary local directory: a later
 * selection is rechecked against this freshly resolved list.
 */
export class ProjectWorktreeService {
  constructor(
    private readonly dependencies: {
      projectService: Pick<ProjectService, 'resolveNewThreadTarget'>
      gitHost: Pick<GitHost, 'runGit'>
      canonicalize?: CanonicalPathResolver
    }
  ) {}

  async list(source: ProjectSelection): Promise<ProjectWorktree[]> {
    if (source.projectKind === 'remote') {
      throw new Error('远程项目暂不支持选择本地 Git worktree。')
    }
    if (source.projectKind === 'projectless') {
      throw new Error('请先选择本地 Git 项目，再选择 worktree。')
    }

    const target = await this.dependencies.projectService.resolveNewThreadTarget({
      selection: source,
      prompt: ''
    })
    if (target.hostId !== 'local' || !target.cwd) {
      throw new Error('当前项目不是可用的本地 Git 工作区。')
    }

    const result = await this.dependencies.gitHost.runGit(
      ['worktree', 'list', '--porcelain'],
      target.cwd
    )
    if (!result.success) {
      throw new Error('当前项目不是可用的 Git 工作区，无法选择 worktree。')
    }

    const canonicalize = this.dependencies.canonicalize ?? realpath
    const currentPath = await canonicalize(target.cwd)
    const records = parseWorktreeRecords(result.stdout)
    const worktrees = await Promise.all(
      records.map(async (record) => {
        try {
          const path = await canonicalize(record.path)
          if (!isSafeAbsoluteLocalPath(path)) return null
          return {
            path,
            branch: record.branch,
            isCurrent: path === currentPath
          } satisfies ProjectWorktree
        } catch {
          // A removed worktree can appear briefly until Git prunes it.  Do not
          // expose an unusable path to the renderer.
          return null
        }
      })
    )

    return [
      ...new Map(worktrees.filter(isProjectWorktree).map((item) => [item.path, item])).values()
    ]
  }

  async resolve(source: ProjectSelection, requestedPath: string): Promise<ProjectWorktree> {
    const worktrees = await this.list(source)
    const canonicalize = this.dependencies.canonicalize ?? realpath
    let path: string
    try {
      path = await canonicalize(requestedPath)
    } catch {
      throw new Error('所选 Git worktree 已不可用。')
    }
    const selected = worktrees.find((worktree) => worktree.path === path)
    if (!selected) throw new Error('所选目录不是当前项目的 Git worktree。')
    return selected
  }
}

function parseWorktreeRecords(output: string): Array<{ path: string; branch: string | null }> {
  const records: Array<{ path: string; branch: string | null }> = []
  let current: { path?: string; branch: string | null; bare: boolean; prunable: boolean } = {
    branch: null,
    bare: false,
    prunable: false
  }

  const commit = (): void => {
    if (current.path && !current.bare && !current.prunable) {
      records.push({ path: current.path, branch: current.branch })
    }
    current = { branch: null, bare: false, prunable: false }
  }

  for (const line of output.split(/\r?\n/u)) {
    if (!line) {
      commit()
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current.path) commit()
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length) || null
    } else if (line === 'bare') {
      current.bare = true
    } else if (line.startsWith('prunable')) {
      current.prunable = true
    }
  }
  commit()
  return records
}

function isProjectWorktree(value: ProjectWorktree | null): value is ProjectWorktree {
  return value !== null
}

function isSafeAbsoluteLocalPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 32_768 &&
    !path.includes('\0') &&
    !/[\r\n]/u.test(path) &&
    !path.startsWith('//') &&
    !path.startsWith('\\\\') &&
    (path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path))
  )
}
