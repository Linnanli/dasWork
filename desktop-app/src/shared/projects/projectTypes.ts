export type WorkspaceKind = 'project' | 'projectless'

/**
 * Persisted only for a worktree that this desktop app created and owns.  The
 * renderer never supplies these values when asking main to inspect or restore
 * a workspace.
 */
export type ManagedWorktreeMetadata = {
  workspaceKind: 'managed-worktree'
  managedByApp: true
  repositoryRoot: string
  worktreePath: string
  branch: string
  ref: string
  createdFrom: 'conversation-fork' | 'new-task'
  recoverable: true
}

export type WorkspaceRecoveryState =
  | 'available'
  | 'checking-failed'
  | 'restorable'
  | 'restoring'
  | 'gone'
  | 'init-failed'
  | 'restore-failed'
  | 'remote-unavailable'
  | 'not-applicable'

export type WorkspaceRecoveryStatus = {
  state: WorkspaceRecoveryState
  message?: string
}

export type ProjectSelection =
  | { projectKind: 'local'; projectId: string }
  | { projectKind: 'remote'; projectId: string; hostId: string }
  | { projectKind: 'path'; path: string; hostId?: 'local' }
  | { projectKind: 'projectless' }

export type ThreadProjectAssignment =
  | {
      projectKind: 'local'
      projectId: string
      cwd: string | null
      path?: string
      pendingCoreUpdate?: boolean
      managedWorktree?: ManagedWorktreeMetadata
    }
  | {
      projectKind: 'remote'
      projectId: string
      hostId: string
      cwd: string | null
      pendingCoreUpdate?: boolean
    }
  | {
      projectKind: 'projectless'
      cwd: string | null
      workspaceRoot: string | null
      outputDirectory: string | null
      pendingCoreUpdate?: boolean
    }

export type ResolvedExecutionTarget = {
  hostId: string
  cwd: string | null
  /** Main-owned app-server remote execution selection for a configured remote project. */
  remoteEnvironment?: RemoteExecutionEnvironment
  /** Main-validated project/host shell override; never supplied by a terminal renderer request. */
  terminalCommand?: string
  workspaceRoots: string[]
  workspaceKind: WorkspaceKind
  projectAssignment?: ThreadProjectAssignment
}

export type RemoteExecutionEnvironment = {
  environmentId: string
  cwd: string
  execServerUrl: string
}

export type WorkspaceRootOption = {
  root: string
  label?: string
  hostId: string
  addedAt: string
  lastOpenedAt: string
  missing?: boolean
}

/** A locally verified Git worktree that can become the execution directory for a new task. */
export type ProjectWorktree = {
  path: string
  branch: string | null
  isCurrent: boolean
}

/** A named shell command saved for one concrete project or registered path. */
export type ProjectAction = {
  id: string
  title: string
  command: string
  createdAt: string
  updatedAt: string
}

/** Project kinds that have a stable location in which an action may run. */
export type ProjectActionScope = Exclude<ProjectSelection, { projectKind: 'projectless' }>

export function projectActionScopeKey(scope: ProjectActionScope): string {
  if (scope.projectKind === 'local') return `local:${scope.projectId}`
  if (scope.projectKind === 'remote') return `remote:${scope.hostId}:${scope.projectId}`
  return `path:${scope.path}`
}

export type LocalProject = {
  id: string
  kind: 'local'
  name: string
  hostId: 'local'
  createdAt: string
  updatedAt: string
  writableRoots: string[]
  defaultCwd?: string
}

export type RemoteProject = {
  id: string
  kind: 'remote'
  hostId: string
  label: string
  remotePath: string
  /** Optional only for projects persisted before remote execution was supported. */
  execServerUrl?: string
  terminalCommand?: string
  createdAt: string
  updatedAt: string
}

export type ProjectState = {
  activeWorkspaceRoots?: string[]
  activeProjectSelection?: ProjectSelection
  workspaceRootOptions: WorkspaceRootOption[]
  localProjects: Record<string, LocalProject>
  remoteProjects: RemoteProject[]
  activeLocalProjectId?: string
  activeRemoteProjectId?: string
  projectOrder: string[]
  pinnedProjectIds: string[]
  /** Commands are keyed by a canonical project-action scope; see projectActionScopeKey. */
  projectActions?: Record<string, ProjectAction[]>
  projectWritableRoots: Record<string, string[]>
  threadProjectAssignments: Record<string, ThreadProjectAssignment>
  threadWritableRoots: Record<string, string[]>
  threadWorkspaceRootHints: Record<string, string[]>
  threadProjectlessOutputDirectories: Record<string, string | null>
  projectlessThreadIds: string[]
  projectlessHints: Record<string, { workspaceRoot: string | null; outputDirectory: string | null }>
}
