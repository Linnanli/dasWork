/* eslint-disable react-refresh/only-export-components -- the workspace context and hook form one state boundary. */
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import type { LocalGitReviewSource } from '../../../../shared/localGitApi'
import {
  createWorkspaceDescriptor,
  WorkspaceContainerProvider,
  useWorkspaceContainer,
  type WorkspaceFileLocation,
  type WorkspaceOpenMode,
  type WorkspaceTabRecord
} from '../workspace-container'
import {
  clampRightWorkspaceWidth,
  type RightWorkspaceState,
  type RightWorkspaceTab,
  type RightWorkspaceTabType
} from './workspaceState'

type RightWorkspaceContextValue = {
  state: RightWorkspaceState
  openTab(type: Exclude<RightWorkspaceTabType, 'review' | 'file'>): void
  openBrowser(url?: string, title?: string): void
  openReview(source?: LocalGitReviewSource): void
  openFile(
    relativePath: string,
    title?: string,
    options?: { location?: WorkspaceFileLocation; mode?: WorkspaceOpenMode; revealPath?: string }
  ): void
  activateTab(tabId: string): void
  closeTab(tabId: string): void
  collapse(): void
  restore(): void
  toggleMaximized(): void
  setPanelWidth(width: number): void
  reorderTabs(tabIds: string[]): void
  setTabRuntime(tabId: string, runtime: { browserViewId?: string; title?: string }): void
  activeTab?: RightWorkspaceTab
}

const RightWorkspaceContext = createContext<RightWorkspaceContextValue | null>(null)

export function RightWorkspaceProvider({
  children,
  fallbackProjectScopes,
  projectScope
}: {
  children: ReactNode
  fallbackProjectScopes?: readonly string[]
  projectScope: string
}): React.JSX.Element {
  return (
    <WorkspaceContainerProvider
      projectScope={projectScope}
      fallbackProjectScopes={fallbackProjectScopes}
    >
      <RightWorkspaceBridge>{children}</RightWorkspaceBridge>
    </WorkspaceContainerProvider>
  )
}

function RightWorkspaceBridge({ children }: { children: ReactNode }): React.JSX.Element {
  const container = useWorkspaceContainer()
  const panel = container.state.panels.right
  const tabs = container.panelTabs('right').flatMap((tab) => {
    const converted = toRightWorkspaceTab(tab, container.tabRuntime(tab.id))
    return converted ? [converted] : []
  })
  const state = useMemo<RightWorkspaceState>(
    () => ({
      isOpen: panel.isOpen,
      isMaximized: panel.isMaximized,
      panelWidth: clampRightWorkspaceWidth(panel.size),
      tabs,
      activeTabId: panel.activeTabId
    }),
    [panel.isMaximized, panel.isOpen, panel.size, panel.activeTabId, tabs]
  )

  const activeTab = tabs.find((tab) => tab.id === state.activeTabId)
  const value = useMemo<RightWorkspaceContextValue>(
    () => ({
      state,
      activeTab,
      openTab: (type) =>
        container.dispatch({
          type: 'open-tab',
          panelId: 'right',
          tab: createWorkspaceDescriptor({ type })
        }),
      openBrowser: (url, title) =>
        container.dispatch({
          type: 'open-tab',
          panelId: 'right',
          tab: createWorkspaceDescriptor({ type: 'browser', url, title })
        }),
      openReview: (source) =>
        container.dispatch({
          type: 'open-tab',
          panelId: 'right',
          tab: createWorkspaceDescriptor({ type: 'review', source })
        }),
      openFile: (relativePath, title, options) =>
        container.dispatch({
          type: 'open-tab',
          panelId: 'right',
          tab: createWorkspaceDescriptor(
            {
              type: 'file',
              relativePath,
              title,
              ...(options?.location ? { location: options.location } : {}),
              ...(options?.revealPath ? { revealPath: options.revealPath } : {})
            },
            { mode: options?.mode }
          )
        }),
      activateTab: (tabId) => container.dispatch({ type: 'activate-tab', panelId: 'right', tabId }),
      closeTab: (tabId) => container.dispatch({ type: 'close-tab', panelId: 'right', tabId }),
      collapse: () =>
        container.dispatch({ type: 'set-panel-open', panelId: 'right', isOpen: false }),
      restore: () => container.dispatch({ type: 'set-panel-open', panelId: 'right', isOpen: true }),
      toggleMaximized: () =>
        container.dispatch({ type: 'toggle-panel-maximized', panelId: 'right' }),
      setPanelWidth: (width) =>
        container.dispatch({
          type: 'set-panel-size',
          panelId: 'right',
          size: clampRightWorkspaceWidth(width)
        }),
      reorderTabs: (tabIds) =>
        container.dispatch({ type: 'reorder-tabs', panelId: 'right', tabIds }),
      setTabRuntime: (tabId, runtime) =>
        container.dispatch({ type: 'set-tab-runtime', tabId, runtime })
    }),
    [activeTab, container, state]
  )

  return <RightWorkspaceContext.Provider value={value}>{children}</RightWorkspaceContext.Provider>
}

export function useRightWorkspace(): RightWorkspaceContextValue {
  const context = useContext(RightWorkspaceContext)
  if (!context) throw new Error('useRightWorkspace must be used within RightWorkspaceProvider')
  return context
}

export function useOptionalRightWorkspace(): RightWorkspaceContextValue | null {
  return useContext(RightWorkspaceContext)
}

export function useOpenReview(): (source?: LocalGitReviewSource) => void {
  return useRightWorkspace().openReview
}

function toRightWorkspaceTab(
  tab: WorkspaceTabRecord,
  runtime: Readonly<Record<string, unknown>> | undefined
): RightWorkspaceTab | undefined {
  switch (tab.kind) {
    case 'review':
      return {
        id: 'review',
        type: 'review',
        title: tab.title,
        source: tab.props.source as LocalGitReviewSource | undefined
      }
    case 'file':
      return {
        id: tab.id,
        type: 'file',
        title: tab.title,
        relativePath: typeof tab.props.relativePath === 'string' ? tab.props.relativePath : '',
        revealPath: typeof tab.props.revealPath === 'string' ? tab.props.revealPath : undefined,
        location: fileLocationFromProps(tab.props)
      }
    case 'terminal':
      return {
        id: tab.id,
        type: 'terminal',
        title: tab.title
      }
    case 'browser':
      return {
        id: tab.id,
        type: 'browser',
        title: tab.title,
        initialUrl: typeof tab.props.url === 'string' ? tab.props.url : undefined,
        browserViewId:
          typeof runtime?.browserViewId === 'string' ? runtime.browserViewId : undefined
      }
    default:
      return undefined
  }
}

function fileLocationFromProps(
  props: WorkspaceTabRecord['props']
): WorkspaceFileLocation | undefined {
  const line = positiveInteger(props.line)
  const column = positiveInteger(props.column)
  const endLine = positiveInteger(props.endLine)
  return line || column || endLine
    ? { ...(line ? { line } : {}), ...(column ? { column } : {}), ...(endLine ? { endLine } : {}) }
    : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
