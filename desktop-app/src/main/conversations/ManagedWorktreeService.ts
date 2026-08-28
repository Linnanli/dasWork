import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  ManagedWorktreeMetadata,
  ThreadProjectAssignment
} from '../../shared/projects/projectTypes'
import type { GitHost } from '../localGit/GitManager'
import type { GitManager } from '../localGit/GitManager'
import type { ProjectService } from '../projects/ProjectService'

export type ManagedWorktreeFork = {
  cwd: string
  workspaceRoots: string[]
  projectAssignment: Extract<ThreadProjectAssignment, { projectKind: 'local' }>
}

type CanonicalPathResolver = (path: string) => Promise<string>

export class ManagedWorktreeService {
  constructor(
    private readonly dependencies: {
      projectService: Pick<ProjectService, 'resolveExistingThreadTarget'>
      gitHost: GitHost
      gitManager: Pick<
        GitManager,
        'invalidateStableMetadata' | 'invalidateGitReadCachesForMutation'
      >
      worktreeRoot: string
      mkdir?: typeof mkdir
      realpath?: CanonicalPathResolver
      createId?: () => string
    }
  ) {}

  async createFork(input: {
    conversationId: string
    threadId: string
  }): Promise<ManagedWorktreeFork> {
    const executionTarget = await this.dependencies.projectService.resolveExistingThreadTarget({
      conversationId: input.conversationId,
      threadId: input.threadId
    })
    if (!executionTarget?.cwd || executionTarget.hostId !== 'local') {
      throw new Error('当前任务不在本地 Git 工作区中，无法创建新的 worktree。')
    }

    const repositoryRoot = await this.gitOutput(
      executionTarget.cwd,
      ['rev-parse', '--show-toplevel'],
      '当前工作区不是可用的 Git 仓库。'
    )
    const ref = await this.gitOutput(
      repositoryRoot,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      '当前 Git 仓库没有可用于创建 worktree 的提交。'
    )
    const id = (this.dependencies.createId ?? randomUUID)().replaceAll('-', '')
    const branch = `codex/fork-${id.slice(0, 12)}`
    await (this.dependencies.mkdir ?? mkdir)(this.dependencies.worktreeRoot, { recursive: true })
    const worktreeRoot = await (this.dependencies.realpath ?? realpath)(
      this.dependencies.worktreeRoot
    )
    const worktreePath = join(worktreeRoot, `fork-${id}`)

    const created = await this.dependencies.gitHost.runGit(
      ['worktree', 'add', '-b', branch, worktreePath, ref],
      repositoryRoot
    )
    if (!created.success) {
      throw new Error('无法创建新的 Git worktree。请确认仓库可写后重试。')
    }

    await this.refreshGitMetadata(repositoryRoot)

    return {
      cwd: worktreePath,
      workspaceRoots: [worktreePath],
      projectAssignment: managedWorktreeAssignment({
        sourceAssignment: executionTarget.projectAssignment,
        repositoryRoot,
        worktreePath,
        branch,
        ref
      })
    }
  }

  async removeFork(worktree: ManagedWorktreeFork): Promise<void> {
    const metadata = worktree.projectAssignment.managedWorktree
    if (!metadata || metadata.managedByApp !== true || metadata.recoverable !== true) {
      return
    }

    const removed = await this.dependencies.gitHost.runGit(
      ['worktree', 'remove', '--force', metadata.worktreePath],
      metadata.repositoryRoot
    )
    if (!removed.success) return
    await this.refreshGitMetadata(metadata.repositoryRoot)
  }

  private async refreshGitMetadata(repositoryRoot: string): Promise<void> {
    this.dependencies.gitManager.invalidateStableMetadata()
    await this.dependencies.gitManager.invalidateGitReadCachesForMutation(
      repositoryRoot,
      this.dependencies.gitHost
    )
  }

  private async gitOutput(
    cwd: string,
    args: readonly string[],
    unavailableMessage: string
  ): Promise<string> {
    const result = await this.dependencies.gitHost.runGit(args, cwd)
    const output = result.stdout.trim()
    if (!result.success || !output) throw new Error(unavailableMessage)
    return output
  }
}

function managedWorktreeAssignment(input: {
  sourceAssignment?: ThreadProjectAssignment
  repositoryRoot: string
  worktreePath: string
  branch: string
  ref: string
}): Extract<ThreadProjectAssignment, { projectKind: 'local' }> {
  const metadata: ManagedWorktreeMetadata = {
    workspaceKind: 'managed-worktree',
    managedByApp: true,
    repositoryRoot: input.repositoryRoot,
    worktreePath: input.worktreePath,
    branch: input.branch,
    ref: input.ref,
    createdFrom: 'conversation-fork',
    recoverable: true
  }
  const source = input.sourceAssignment
  const projectId = source?.projectKind === 'local' ? source.projectId : input.repositoryRoot

  return {
    projectKind: 'local',
    projectId,
    path: input.worktreePath,
    cwd: input.worktreePath,
    managedWorktree: metadata
  }
}
