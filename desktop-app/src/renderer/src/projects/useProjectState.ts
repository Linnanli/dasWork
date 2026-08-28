import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ProjectRenamePayload } from '../../../shared/codexIpcApi'
import type {
  LocalProject,
  ProjectSelection,
  ProjectState,
  ProjectWorktree,
  RemoteProject,
  WorkspaceRootOption
} from '../../../shared/projects/projectTypes'
import type { RemoteProjectInput } from './CreateRemoteProjectDialog'

export type ProjectStateController = {
  state: ProjectState | null
  hasSelection: boolean
  currentLabel: string
  currentDetail: string | null
  pickWorkspaceRoot: () => Promise<WorkspaceRootOption | null>
  createBlankProject: (name: string, operationId: string) => Promise<WorkspaceRootOption>
  createLocalProject: (input: { name?: string; sourceRoots: string[] }) => Promise<LocalProject>
  createRemoteProject: (input: RemoteProjectInput) => Promise<RemoteProject>
  listWorktrees: (source: ProjectSelection) => Promise<ProjectWorktree[]>
  selectWorktree: (input: { source: ProjectSelection; path: string }) => Promise<void>
  selectProject: (selection: ProjectSelection) => Promise<void>
  renameProject: (input: ProjectRenamePayload) => Promise<void>
  removeProject: (selection: ProjectSelection) => Promise<void>
}

export function useProjectState(): ProjectStateController {
  const [state, setState] = useState<ProjectState | null>(null)
  const stateRef = useRef<ProjectState | null>(null)
  const applyState = useCallback((nextState: ProjectState) => {
    stateRef.current = nextState
    setState(nextState)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.desktopApp.projects.getState().then((nextState) => {
      if (!cancelled) applyState(nextState)
    })
    const removeStateListener = window.desktopApp.projects.onStateChange((nextState) => {
      applyState(nextState)
    })

    return () => {
      cancelled = true
      removeStateListener()
    }
  }, [applyState])

  const pickWorkspaceRoot = useCallback(async () => {
    const option = await window.desktopApp.projects.pickWorkspaceRoot()
    if (!option) return null
    const nextState = await window.desktopApp.projects.getState()
    applyState(nextState)
    return option
  }, [applyState])

  const createBlankProject = useCallback(
    async (name: string, operationId: string) => {
      const result = await window.desktopApp.projects.createBlankProject({ name, operationId })
      applyState(result.state)
      return result.option
    },
    [applyState]
  )

  const createLocalProject = useCallback(
    async (input: { name?: string; sourceRoots: string[] }) => {
      const project = await window.desktopApp.projects.createLocalProject(input)
      const nextState = await window.desktopApp.projects.getState()
      applyState(nextState)
      return project
    },
    [applyState]
  )

  const createRemoteProject = useCallback(
    async (input: RemoteProjectInput) => {
      const project = await window.desktopApp.projects.createRemoteProject(input)
      const nextState = await window.desktopApp.projects.getState()
      applyState(nextState)
      return project
    },
    [applyState]
  )

  const listWorktrees = useCallback(async (source: ProjectSelection) => {
    return window.desktopApp.projects.listWorktrees({ source })
  }, [])

  const selectWorktree = useCallback(
    async (input: { source: ProjectSelection; path: string }) => {
      const nextState = await window.desktopApp.projects.selectWorktree(input)
      applyState(nextState)
    },
    [applyState]
  )

  const selectProject = useCallback(
    async (selection: ProjectSelection) => {
      const previousState = stateRef.current
      if (previousState) applyState(applyProjectSelection(previousState, selection))

      try {
        const nextState = await window.desktopApp.projects.selectProject(selection)
        applyState(nextState)
      } catch (error) {
        const currentState = stateRef.current
        if (
          previousState &&
          currentState &&
          sameProjectSelection(currentState.activeProjectSelection, selection)
        ) {
          applyState(restoreActiveProjectSelection(currentState, previousState))
        }
        throw error
      }
    },
    [applyState]
  )

  const renameProject = useCallback(
    async (input: ProjectRenamePayload) => {
      const nextState = await window.desktopApp.projects.renameProject(input)
      applyState(nextState)
    },
    [applyState]
  )

  const removeProject = useCallback(
    async (selection: ProjectSelection) => {
      const nextState = await window.desktopApp.projects.removeProject(selection)
      applyState(nextState)
    },
    [applyState]
  )

  const summary = useMemo(() => describeProjectState(state), [state])

  return useMemo(
    () => ({
      state,
      hasSelection: summary.hasSelection,
      currentLabel: summary.label,
      currentDetail: summary.detail,
      pickWorkspaceRoot,
      createBlankProject,
      createLocalProject,
      createRemoteProject,
      listWorktrees,
      selectProject,
      selectWorktree,
      renameProject,
      removeProject
    }),
    [
      createBlankProject,
      createLocalProject,
      createRemoteProject,
      listWorktrees,
      pickWorkspaceRoot,
      removeProject,
      renameProject,
      selectProject,
      selectWorktree,
      state,
      summary
    ]
  )
}

function applyProjectSelection(state: ProjectState, selection: ProjectSelection): ProjectState {
  if (selection.projectKind === 'local') {
    return {
      ...state,
      activeLocalProjectId: selection.projectId,
      activeRemoteProjectId: undefined,
      activeProjectSelection: selection,
      activeWorkspaceRoots: state.localProjects[selection.projectId]?.writableRoots ?? []
    }
  }

  if (selection.projectKind === 'remote') {
    const project = state.remoteProjects.find((candidate) => candidate.id === selection.projectId)
    return {
      ...state,
      activeLocalProjectId: undefined,
      activeRemoteProjectId: selection.projectId,
      activeProjectSelection: selection,
      activeWorkspaceRoots: project ? [project.remotePath] : []
    }
  }

  if (selection.projectKind === 'path') {
    return {
      ...state,
      activeLocalProjectId: undefined,
      activeRemoteProjectId: undefined,
      activeProjectSelection: selection,
      activeWorkspaceRoots: [selection.path]
    }
  }

  return {
    ...state,
    activeLocalProjectId: undefined,
    activeRemoteProjectId: undefined,
    activeProjectSelection: selection,
    activeWorkspaceRoots: []
  }
}

function restoreActiveProjectSelection(
  currentState: ProjectState,
  previousState: ProjectState
): ProjectState {
  return {
    ...currentState,
    activeLocalProjectId: previousState.activeLocalProjectId,
    activeRemoteProjectId: previousState.activeRemoteProjectId,
    activeProjectSelection: previousState.activeProjectSelection,
    activeWorkspaceRoots: previousState.activeWorkspaceRoots
  }
}

function sameProjectSelection(
  left: ProjectSelection | undefined,
  right: ProjectSelection | undefined
): boolean {
  if (!left || !right) return left === right
  if (left.projectKind !== right.projectKind) return false

  if (left.projectKind === 'local' && right.projectKind === 'local') {
    return left.projectId === right.projectId
  }
  if (left.projectKind === 'remote' && right.projectKind === 'remote') {
    return left.projectId === right.projectId && left.hostId === right.hostId
  }
  if (left.projectKind === 'path' && right.projectKind === 'path') {
    return left.path === right.path
  }
  return left.projectKind === 'projectless' && right.projectKind === 'projectless'
}

function describeProjectState(state: ProjectState | null): {
  hasSelection: boolean
  label: string
  detail: string | null
} {
  if (!state) return { hasSelection: false, label: 'Loading project', detail: null }

  const selection = state.activeProjectSelection
  if (selection?.projectKind === 'projectless') {
    return { hasSelection: true, label: 'Projectless', detail: 'Working without a project' }
  }

  if (selection?.projectKind === 'local') {
    const project = state.localProjects[selection.projectId]
    if (project) {
      return {
        hasSelection: true,
        label: project.name,
        detail:
          project.writableRoots.length === 1
            ? project.writableRoots[0]
            : `${project.writableRoots.length} roots`
      }
    }
  }

  if (selection?.projectKind === 'remote') {
    const project = state.remoteProjects.find((candidate) => candidate.id === selection.projectId)
    if (project) {
      return {
        hasSelection: true,
        label: project.label,
        detail: `${project.hostId}:${project.remotePath}`
      }
    }
  }

  if (selection?.projectKind === 'path') {
    return {
      hasSelection: true,
      label: selection.path.split(/[\\/]/).filter(Boolean).at(-1) ?? selection.path,
      detail: selection.path
    }
  }

  const activeRoots = state.activeWorkspaceRoots ?? []
  if (activeRoots.length > 0) {
    const root = activeRoots[0] ?? ''
    return {
      hasSelection: true,
      label: root.split(/[\\/]/).filter(Boolean).at(-1) ?? root,
      detail: activeRoots.length === 1 ? root : `${activeRoots.length} roots`
    }
  }

  return { hasSelection: false, label: 'Choose project', detail: null }
}
