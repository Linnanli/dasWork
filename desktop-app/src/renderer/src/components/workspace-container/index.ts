export {
  createWorkspaceContainerState,
  defaultWorkspaceContainerState,
  panelTabs,
  previewReplacementCandidate,
  tabPanelId,
  workspaceContainerReducer
} from './workspaceReducer'
export {
  legacyRightWorkspaceStorageKey,
  loadWorkspaceContainerState,
  persistWorkspaceContainerState,
  workspaceContainerStorageKey
} from './workspacePersistence'
export {
  WorkspaceContainerProvider,
  useOptionalWorkspaceContainer,
  useWorkspaceContainer,
  useWorkspacePanel
} from './WorkspaceContainerProvider'
export {
  createWorkspaceDescriptor,
  normalizeRelativePath,
  type WorkspaceFileLocation,
  type WorkspaceOpenMode,
  type WorkspaceOpenOptions,
  type WorkspaceOpenTarget
} from './workspaceOpenTargets'
export {
  createWorkspaceContentRegistry,
  WorkspaceContentRegistry,
  WorkspaceRestoreFailure,
  type WorkspaceContentAdapter,
  type WorkspaceContentLifecycleContext,
  type WorkspaceContentRenderContext
} from './WorkspaceContentRegistry'
export { WorkspacePanelController } from './WorkspacePanelController'
export { WorkspacePanelShell } from './WorkspacePanelShell'
export { WorkspaceTabStrip } from './WorkspaceTabStrip'
export {
  hasCrossedWorkspaceDragThreshold,
  reorderTabAfter,
  WORKSPACE_DRAG_THRESHOLD_PX
} from './workspaceDragGeometry'
export {
  adjacentWorkspaceTabId,
  isWorkspaceEditableTarget,
  workspacePanelFromData
} from './workspaceFocusManager'
export type {
  WorkspaceContainerAction,
  WorkspaceContainerState,
  WorkspaceContentKind,
  WorkspaceJsonValue,
  WorkspacePanelId,
  WorkspacePanelState,
  WorkspaceTabRecord,
  WorkspaceTabRuntime
} from './workspaceTypes'
