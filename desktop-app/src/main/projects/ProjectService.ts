import type {
  ProjectSelection,
  RemoteExecutionEnvironment,
  ResolvedExecutionTarget,
  ThreadProjectAssignment
} from '../../shared/projects/projectTypes'
import type { ProjectStore, ProjectState, LocalProject, RemoteProject } from './ProjectStore'
import { normalizeRemoteExecServerUrl } from '../../shared/projects/remoteExecution'

type LocalRootValidation = {
  realPath: string
}

type ProjectlessWorkspace = {
  cwd: string
  workspaceRoot: string
  outputDirectory: string
}

type ThreadReadResult = {
  thread?: {
    cwd?: string | null
  }
}

export type ThreadReader = (threadId: string) => Promise<ThreadReadResult>

export type ProjectServiceDependencies = {
  store: ProjectStore
  validateLocalRoot: (path: string) => Promise<LocalRootValidation>
  validateLocalRoots?: (paths: string[]) => Promise<string[]>
  validateRemoteRoot: (hostId: string, path: string) => Promise<void>
  createProjectlessWorkspace: (input: { prompt: string }) => Promise<ProjectlessWorkspace>
  readThread?: ThreadReader
}

export type ResolveNewThreadTargetInput = {
  selection?: ProjectSelection | null
  prompt: string
}

export type ResolveExistingThreadTargetInput = {
  conversationId: string
  threadId?: string | null
  routeFallback?: ResolvedExecutionTarget | null
  allowActiveProjectFallback?: boolean
  /**
   * Workspace tools can opt in when they need a local root for the task that
   * is currently open. This remains separate from normal thread continuation:
   * sending another turn must never silently move a historical task to the
   * project selected elsewhere in the app.
   */
  allowActiveProjectFallbackForUnboundThread?: boolean
}

export class ProjectService {
  constructor(private readonly dependencies: ProjectServiceDependencies) {}

  async resolveNewThreadTarget(
    input: ResolveNewThreadTargetInput
  ): Promise<ResolvedExecutionTarget> {
    const selection = input.selection

    if (!selection || selection.projectKind === 'projectless') {
      return this.resolveProjectlessTarget(input.prompt)
    }

    if (selection.projectKind === 'local') {
      const state = await this.dependencies.store.getState()
      const project = state.localProjects[selection.projectId]

      if (!project) {
        throw new Error(`Local project not found: ${selection.projectId}`)
      }

      return this.resolveLocalProject(project)
    }

    if (selection.projectKind === 'remote') {
      const state = await this.dependencies.store.getState()
      const project = state.remoteProjects.find((candidate) => candidate.id === selection.projectId)

      if (!project) {
        throw new Error(`Remote project not found: ${selection.projectId}`)
      }

      if (project.hostId !== selection.hostId) {
        throw new Error(
          `Remote project host mismatch: ${selection.projectId} is on ${project.hostId}, not ${selection.hostId}`
        )
      }

      return this.resolveRemoteProject(project)
    }

    const state = await this.dependencies.store.getState()
    const { realPath } = await this.dependencies.validateLocalRoot(selection.path)

    if (
      !state.workspaceRootOptions.some(
        (option) => option.hostId === 'local' && option.root === realPath
      )
    ) {
      throw new Error(`Workspace root is not a registered project: ${selection.path}`)
    }

    return {
      hostId: 'local',
      cwd: realPath,
      workspaceRoots: [realPath],
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'local',
        projectId: realPath,
        path: realPath,
        cwd: realPath
      }
    }
  }

  async resolveExistingThreadTarget(
    input: ResolveExistingThreadTargetInput
  ): Promise<ResolvedExecutionTarget | null> {
    const state = await this.dependencies.store.getState()
    const assignment =
      (input.threadId ? state.threadProjectAssignments[input.threadId] : undefined) ??
      state.threadProjectAssignments[input.conversationId]

    if (assignment) {
      return this.resolveAssignmentTarget(assignment, state)
    }

    const threadCwd = await this.readThreadCwd(input.threadId)
    if (threadCwd) {
      return {
        hostId: 'local',
        cwd: threadCwd,
        workspaceRoots: [threadCwd],
        workspaceKind: 'project'
      }
    }

    if (input.routeFallback) {
      return input.routeFallback
    }

    if (
      input.allowActiveProjectFallback &&
      (!input.threadId || input.allowActiveProjectFallbackForUnboundThread)
    ) {
      return this.resolveActiveProjectFallback(state)
    }

    return null
  }

  private async resolveProjectlessTarget(prompt: string): Promise<ResolvedExecutionTarget> {
    const generated = await this.dependencies.createProjectlessWorkspace({ prompt })

    return {
      hostId: 'local',
      cwd: generated.cwd,
      workspaceRoots: [generated.workspaceRoot],
      workspaceKind: 'projectless',
      projectAssignment: {
        projectKind: 'projectless',
        cwd: generated.cwd,
        workspaceRoot: generated.workspaceRoot,
        outputDirectory: generated.outputDirectory
      }
    }
  }

  private async resolveLocalProject(project: LocalProject): Promise<ResolvedExecutionTarget> {
    const roots = await this.validateLocalRoots(project.writableRoots)
    const cwd = await this.resolveLocalProjectCwd(project, roots)

    return {
      hostId: 'local',
      cwd,
      workspaceRoots: roots,
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'local',
        projectId: project.id,
        cwd
      }
    }
  }

  private async resolveLocalProjectCwd(
    project: LocalProject,
    roots: string[]
  ): Promise<string | null> {
    if (!project.defaultCwd) {
      return roots[0] ?? null
    }

    const { realPath } = await this.dependencies.validateLocalRoot(project.defaultCwd)

    if (!roots.includes(realPath)) {
      throw new Error(`Default cwd is not in writable roots: ${project.defaultCwd}`)
    }

    return realPath
  }

  private async resolveRemoteProject(project: RemoteProject): Promise<ResolvedExecutionTarget> {
    await this.dependencies.validateRemoteRoot(project.hostId, project.remotePath)

    return {
      hostId: project.hostId,
      cwd: project.remotePath,
      remoteEnvironment: remoteExecutionEnvironmentForProject(project),
      ...(project.terminalCommand ? { terminalCommand: project.terminalCommand } : {}),
      workspaceRoots: [project.remotePath],
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'remote',
        projectId: project.id,
        hostId: project.hostId,
        cwd: project.remotePath
      }
    }
  }

  private async validateLocalRoots(paths: string[]): Promise<string[]> {
    if (this.dependencies.validateLocalRoots) {
      return this.dependencies.validateLocalRoots(paths)
    }

    const roots: string[] = []

    for (const path of paths) {
      const { realPath } = await this.dependencies.validateLocalRoot(path)
      roots.push(realPath)
    }

    return roots
  }

  private async readThreadCwd(threadId?: string | null): Promise<string | null> {
    if (!threadId || !this.dependencies.readThread) {
      return null
    }

    const result = await this.dependencies.readThread(threadId)

    return result.thread?.cwd ?? null
  }

  private async resolveAssignmentTarget(
    assignment: ThreadProjectAssignment,
    state: ProjectState
  ): Promise<ResolvedExecutionTarget> {
    if (assignment.projectKind === 'remote') {
      const project =
        state.remoteProjects.find(
          (candidate) =>
            candidate.id === assignment.projectId && candidate.hostId === assignment.hostId
        ) ??
        state.remoteProjects.find(
          (candidate) =>
            candidate.hostId === assignment.hostId && candidate.remotePath === assignment.cwd
        )
      if (!project) {
        throw new Error(
          'The remote project for this conversation is no longer configured. Reconnect the project before continuing.'
        )
      }
      const cwd = assignment.cwd ?? project.remotePath
      await this.dependencies.validateRemoteRoot(assignment.hostId, cwd)

      return {
        hostId: assignment.hostId,
        cwd,
        remoteEnvironment: remoteExecutionEnvironmentForProject(project, cwd),
        workspaceRoots: [cwd],
        workspaceKind: 'project',
        projectAssignment: { ...assignment, cwd }
      }
    }

    if (assignment.projectKind === 'projectless') {
      return {
        hostId: 'local',
        cwd: assignment.cwd,
        workspaceRoots: assignment.workspaceRoot ? [assignment.workspaceRoot] : [],
        workspaceKind: 'projectless',
        projectAssignment: assignment
      }
    }

    return this.resolveLocalAssignmentTarget(assignment, state)
  }

  private async resolveLocalAssignmentTarget(
    assignment: Extract<ThreadProjectAssignment, { projectKind: 'local' }>,
    state: ProjectState
  ): Promise<ResolvedExecutionTarget> {
    if (assignment.managedWorktree) {
      return this.resolveManagedWorktreeTarget(assignment)
    }

    const project = state.localProjects[assignment.projectId]

    if (project) {
      const workspaceRoots = await this.validateLocalRoots(project.writableRoots)
      const cwd = assignment.cwd
        ? (await this.dependencies.validateLocalRoot(assignment.cwd)).realPath
        : null

      if (cwd && !workspaceRoots.includes(cwd)) {
        throw new Error(`Assigned cwd is not in writable roots: ${assignment.cwd}`)
      }

      return {
        hostId: 'local',
        cwd,
        workspaceRoots,
        workspaceKind: 'project',
        projectAssignment: {
          ...assignment,
          cwd
        }
      }
    }

    const localRoot = assignment.path ?? assignment.cwd
    const resolvedRoot = localRoot
      ? (await this.dependencies.validateLocalRoot(localRoot)).realPath
      : null
    const projectAssignment = {
      ...assignment,
      cwd: resolvedRoot
    }

    if (assignment.path && resolvedRoot) {
      projectAssignment.path = resolvedRoot
    }

    return {
      hostId: 'local',
      cwd: resolvedRoot,
      workspaceRoots: resolvedRoot ? [resolvedRoot] : [],
      workspaceKind: 'project',
      projectAssignment
    }
  }

  private async resolveManagedWorktreeTarget(
    assignment: Extract<ThreadProjectAssignment, { projectKind: 'local' }>
  ): Promise<ResolvedExecutionTarget> {
    const metadata = assignment.managedWorktree
    if (
      !metadata ||
      metadata.workspaceKind !== 'managed-worktree' ||
      metadata.managedByApp !== true ||
      metadata.recoverable !== true ||
      !assignment.cwd ||
      assignment.cwd !== metadata.worktreePath ||
      !isSafeManagedWorktreePath(metadata.worktreePath) ||
      !isSafeManagedWorktreePath(metadata.repositoryRoot)
    ) {
      throw new Error('Managed worktree assignment is invalid')
    }

    const cwd = (await this.dependencies.validateLocalRoot(metadata.worktreePath)).realPath
    if (cwd !== metadata.worktreePath) {
      throw new Error('Managed worktree path no longer matches its saved location')
    }

    return {
      hostId: 'local',
      cwd,
      workspaceRoots: [cwd],
      workspaceKind: 'project',
      projectAssignment: {
        ...assignment,
        cwd,
        path: cwd
      }
    }
  }

  private async resolveActiveProjectFallback(
    state: ProjectState
  ): Promise<ResolvedExecutionTarget | null> {
    const selection = state.activeProjectSelection
    if (selection && selection.projectKind !== 'projectless') {
      return this.resolveNewThreadTarget({ selection, prompt: '' })
    }

    // Retain the legacy IDs as a fallback for persisted states created before
    // activeProjectSelection became the source of truth.
    if (state.activeLocalProjectId) {
      const project = state.localProjects[state.activeLocalProjectId]

      if (!project) {
        throw new Error(`Active local project not found: ${state.activeLocalProjectId}`)
      }

      return this.resolveLocalProject(project)
    }

    if (state.activeRemoteProjectId) {
      const project = state.remoteProjects.find(
        (candidate) => candidate.id === state.activeRemoteProjectId
      )

      if (!project) {
        throw new Error(`Active remote project not found: ${state.activeRemoteProjectId}`)
      }

      return this.resolveRemoteProject(project)
    }

    return null
  }
}

function remoteExecutionEnvironmentForProject(
  project: RemoteProject,
  cwd = project.remotePath
): RemoteExecutionEnvironment {
  if (!project.execServerUrl) {
    throw new Error(
      'This remote project has no Codex execution server. Reconnect it with a ws:// or wss:// execution server URL before starting a task.'
    )
  }

  return {
    environmentId: project.hostId,
    cwd,
    execServerUrl: normalizeRemoteExecServerUrl(project.execServerUrl)
  }
}

function isSafeManagedWorktreePath(path: string): boolean {
  return path.startsWith('/') && !path.includes('\0') && !path.split('/').includes('..')
}
