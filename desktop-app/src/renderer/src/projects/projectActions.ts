import type {
  ProjectActionScope,
  ProjectSelection,
  ProjectState
} from '../../../shared/projects/projectTypes'

export function projectActionScopeForTask(
  state: ProjectState,
  input: {
    conversationId: string
    threadId?: string
    projectSelection?: ProjectSelection
  }
): ProjectActionScope | undefined {
  const assignment =
    (input.threadId ? state.threadProjectAssignments[input.threadId] : undefined) ??
    state.threadProjectAssignments[input.conversationId]

  if (assignment?.projectKind === 'local') {
    if (state.localProjects[assignment.projectId]) {
      return { projectKind: 'local', projectId: assignment.projectId }
    }
    const path = assignment.path ?? assignment.cwd
    if (path && isRegisteredPath(state, path)) return { projectKind: 'path', path }
  }

  if (assignment?.projectKind === 'remote') {
    const project = state.remoteProjects.find((candidate) => candidate.id === assignment.projectId)
    if (project?.hostId === assignment.hostId) {
      return {
        projectKind: 'remote',
        projectId: assignment.projectId,
        hostId: assignment.hostId
      }
    }
  }

  return projectActionScopeForSelection(state, input.projectSelection)
}

export function projectActionScopeForSelection(
  state: ProjectState,
  selection: ProjectSelection | undefined
): ProjectActionScope | undefined {
  if (!selection || selection.projectKind === 'projectless') return undefined
  if (selection.projectKind === 'local') {
    return state.localProjects[selection.projectId] ? selection : undefined
  }
  if (selection.projectKind === 'remote') {
    return state.remoteProjects.some(
      (project) => project.id === selection.projectId && project.hostId === selection.hostId
    )
      ? selection
      : undefined
  }
  return isRegisteredPath(state, selection.path)
    ? { projectKind: 'path', path: selection.path }
    : undefined
}

function isRegisteredPath(state: ProjectState, path: string): boolean {
  return state.workspaceRootOptions.some(
    (option) => option.hostId === 'local' && option.root === path
  )
}
