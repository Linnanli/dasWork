import type { SidebarConversationForkPayload } from '../../shared/codexIpcApi'
import type { ProjectState, ThreadProjectAssignment } from '../../shared/projects/projectTypes'
import type { ProjectStore } from '../projects/ProjectStore'
import type { AppServerThreadClient, AppServerThreadRow } from './AppServerThreadClient'
import type { ManagedWorktreeFork, ManagedWorktreeService } from './ManagedWorktreeService'

type ConversationForkThreadClient = Pick<AppServerThreadClient, 'forkThread'>
type ConversationForkProjectStore = Pick<ProjectStore, 'getState' | 'setState'>

export type ForkedConversation = {
  thread: AppServerThreadRow
  projectAssignment?: ThreadProjectAssignment
}

export class ConversationForkService {
  constructor(
    private readonly dependencies: {
      threadClient: ConversationForkThreadClient
      projectStore: ConversationForkProjectStore
      managedWorktrees?: Pick<ManagedWorktreeService, 'createFork' | 'removeFork'>
    }
  ) {}

  async fork(input: SidebarConversationForkPayload): Promise<ForkedConversation> {
    const worktree =
      input.mode === 'new-worktree' ? await this.createWorktree(input.conversationId) : undefined
    let thread: AppServerThreadRow
    try {
      thread = await this.dependencies.threadClient.forkThread({
        threadId: input.conversationId,
        targetTurnId: input.targetTurnId,
        // app-server currently needs a persisted cloned rollout to roll back
        // later turns. The Side task remains independent, but it cannot use
        // protocol-level ephemeral storage until that protocol gains a safe
        // turn-targeted fork operation.
        ephemeral: false,
        cwd: worktree?.cwd,
        runtimeWorkspaceRoots: worktree?.workspaceRoots
      })
    } catch (error) {
      if (worktree) await this.removeWorktreeAfterForkFailure(worktree)
      throw error
    }

    const projectAssignment = await this.copyWorkspaceAssignments({
      sourceThreadId: input.conversationId,
      forkedThreadId: thread.id,
      worktree
    })

    return { thread, projectAssignment }
  }

  private async createWorktree(conversationId: string): Promise<ManagedWorktreeFork> {
    const managedWorktrees = this.dependencies.managedWorktrees
    if (!managedWorktrees) {
      throw new Error('当前应用不支持创建新的 Git worktree。')
    }
    return managedWorktrees.createFork({ conversationId, threadId: conversationId })
  }

  private async removeWorktreeAfterForkFailure(worktree: ManagedWorktreeFork): Promise<void> {
    const managedWorktrees = this.dependencies.managedWorktrees
    if (!managedWorktrees) return
    await managedWorktrees.removeFork(worktree).catch(() => undefined)
  }

  private async copyWorkspaceAssignments(input: {
    sourceThreadId: string
    forkedThreadId: string
    worktree?: ManagedWorktreeFork
  }): Promise<ThreadProjectAssignment | undefined> {
    const state = await this.dependencies.projectStore.getState()
    const projectAssignment =
      input.worktree?.projectAssignment ?? state.threadProjectAssignments[input.sourceThreadId]
    const writableRoots =
      input.worktree?.workspaceRoots ?? state.threadWritableRoots[input.sourceThreadId]
    const workspaceRootHints =
      input.worktree?.workspaceRoots ?? state.threadWorkspaceRootHints[input.sourceThreadId]

    if (!projectAssignment && !writableRoots && !workspaceRootHints) {
      return undefined
    }

    await this.dependencies.projectStore.setState(
      copyThreadWorkspaceState({
        state,
        forkedThreadId: input.forkedThreadId,
        projectAssignment,
        writableRoots,
        workspaceRootHints
      })
    )
    return projectAssignment
  }
}

function copyThreadWorkspaceState(input: {
  state: ProjectState
  forkedThreadId: string
  projectAssignment?: ThreadProjectAssignment
  writableRoots?: string[]
  workspaceRootHints?: string[]
}): ProjectState {
  const { state, forkedThreadId, projectAssignment, writableRoots, workspaceRootHints } = input

  return {
    ...state,
    threadProjectAssignments: projectAssignment
      ? {
          ...state.threadProjectAssignments,
          [forkedThreadId]: projectAssignment
        }
      : state.threadProjectAssignments,
    threadWritableRoots: writableRoots
      ? {
          ...state.threadWritableRoots,
          [forkedThreadId]: writableRoots
        }
      : state.threadWritableRoots,
    threadWorkspaceRootHints: workspaceRootHints
      ? {
          ...state.threadWorkspaceRootHints,
          [forkedThreadId]: workspaceRootHints
        }
      : state.threadWorkspaceRootHints
  }
}
