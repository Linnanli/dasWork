/* eslint-disable react-refresh/only-export-components -- context and hooks are one state boundary. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  type ReactNode
} from 'react'

import {
  createWorkspaceContainerState,
  panelTabs,
  workspaceContainerReducer
} from './workspaceReducer'
import { loadWorkspaceContainerState, persistWorkspaceContainerState } from './workspacePersistence'
import { WorkspaceTabDragProvider } from './WorkspaceTabDragProvider'
import type {
  WorkspaceContainerAction,
  WorkspaceContainerState,
  WorkspacePanelId,
  WorkspaceTabRecord,
  WorkspaceTabRuntime
} from './workspaceTypes'

type WorkspaceContainerContextValue = {
  state: WorkspaceContainerState
  dispatch(action: WorkspaceContainerAction): void
  panelTabs(panelId: WorkspacePanelId): readonly WorkspaceTabRecord[]
  activeTab(panelId: WorkspacePanelId): WorkspaceTabRecord | undefined
  tabRuntime(tabId: string): WorkspaceTabRuntime | undefined
}

const WorkspaceContainerContext = createContext<WorkspaceContainerContextValue | null>(null)

type ScopedWorkspaceState = {
  projectScope: string
  workspace: WorkspaceContainerState
}

type ScopedWorkspaceAction =
  | { type: 'dispatch'; action: WorkspaceContainerAction }
  | { type: 'switch-scope'; projectScope: string; workspace: WorkspaceContainerState }

function scopedWorkspaceReducer(
  state: ScopedWorkspaceState,
  action: ScopedWorkspaceAction
): ScopedWorkspaceState {
  if (action.type === 'switch-scope') {
    return { projectScope: action.projectScope, workspace: action.workspace }
  }
  return { ...state, workspace: workspaceContainerReducer(state.workspace, action.action) }
}

export function WorkspaceContainerProvider({
  children,
  fallbackProjectScopes = [],
  projectScope
}: {
  children: ReactNode
  fallbackProjectScopes?: readonly string[]
  projectScope: string
}): React.JSX.Element {
  const [scopedState, dispatchScoped] = useReducer(
    scopedWorkspaceReducer,
    { projectScope, fallbackProjectScopes },
    ({
      projectScope: initialProjectScope,
      fallbackProjectScopes: initialFallbackProjectScopes
    }): ScopedWorkspaceState => ({
      projectScope: initialProjectScope,
      workspace: loadWorkspaceContainerState(
        browserStorage(),
        initialProjectScope,
        initialFallbackProjectScopes
      )
    })
  )
  const state = scopedState.workspace
  const dispatch = useCallback(
    (action: WorkspaceContainerAction): void => dispatchScoped({ type: 'dispatch', action }),
    []
  )

  useLayoutEffect(() => {
    if (scopedState.projectScope === projectScope) return
    dispatchScoped({
      type: 'switch-scope',
      projectScope,
      workspace: loadWorkspaceContainerState(browserStorage(), projectScope, fallbackProjectScopes)
    })
  }, [fallbackProjectScopes, projectScope, scopedState.projectScope])

  useEffect(() => {
    persistWorkspaceContainerState(browserStorage(), scopedState.projectScope, state)
  }, [scopedState.projectScope, state])

  const value = useMemo<WorkspaceContainerContextValue>(
    () => ({
      state,
      dispatch,
      panelTabs: (panelId) => panelTabs(state, panelId),
      activeTab: (panelId) => {
        const activeTabId = state.panels[panelId].activeTabId
        return activeTabId ? state.tabs[activeTabId] : undefined
      },
      tabRuntime: (tabId) => state.runtime[tabId]
    }),
    [dispatch, state]
  )

  return (
    <WorkspaceTabDragProvider>
      <WorkspaceContainerContext.Provider value={value}>
        {children}
      </WorkspaceContainerContext.Provider>
    </WorkspaceTabDragProvider>
  )
}

export function useWorkspaceContainer(): WorkspaceContainerContextValue {
  const context = useContext(WorkspaceContainerContext)
  if (!context) {
    throw new Error('useWorkspaceContainer must be used within WorkspaceContainerProvider')
  }
  return context
}

export function useOptionalWorkspaceContainer(): WorkspaceContainerContextValue | null {
  return useContext(WorkspaceContainerContext)
}

export function useWorkspacePanel(panelId: WorkspacePanelId): {
  panel: WorkspaceContainerState['panels'][WorkspacePanelId]
  tabs: readonly WorkspaceTabRecord[]
  activeTab: WorkspaceTabRecord | undefined
} {
  const container = useWorkspaceContainer()
  return {
    panel: container.state.panels[panelId],
    tabs: container.panelTabs(panelId),
    activeTab: container.activeTab(panelId)
  }
}

function browserStorage(): Storage | undefined {
  return typeof window === 'undefined' ? undefined : window.localStorage
}

/** Exported for provider test harnesses that need a non-persistent initial state. */
export { createWorkspaceContainerState }
