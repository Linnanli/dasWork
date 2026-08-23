import type { LocalGitReviewSource } from '../../../../shared/localGitApi'
import { RIGHT_WORKSPACE_MIN_WIDTH } from '../workspace-container/workspaceTypes'
import type { WorkspaceFileLocation } from '../workspace-container/workspaceOpenTargets'

export { RIGHT_WORKSPACE_MIN_WIDTH }

export const RIGHT_WORKSPACE_TAB_TYPES = ['review', 'file', 'terminal', 'browser'] as const
export type RightWorkspaceTabType = (typeof RIGHT_WORKSPACE_TAB_TYPES)[number]

export type RightWorkspaceTab =
  | {
      id: 'review'
      type: 'review'
      title: string
      label?: string
      source?: LocalGitReviewSource
    }
  | {
      id: string
      type: 'file'
      title: string
      label?: string
      relativePath: string
      revealPath?: string
      location?: WorkspaceFileLocation
    }
  | {
      id: string
      type: 'terminal'
      title: string
      label?: string
    }
  | {
      id: string
      type: 'browser'
      title: string
      label?: string
      browserViewId?: string
      initialUrl?: string
    }

export type PersistedRightWorkspaceTab =
  | { id: 'review'; type: 'review'; title: string; source?: LocalGitReviewSource }
  | { id: string; type: 'file'; title: string; relativePath: string }
  | { id: string; type: 'terminal'; title: string }
  | { id: string; type: 'browser'; title: string }

export type RightWorkspaceState = {
  isOpen: boolean
  isMaximized: boolean
  panelWidth: number
  tabs: RightWorkspaceTab[]
  activeTabId?: string
}

export const RIGHT_WORKSPACE_DEFAULT_WIDTH = 560
export const RIGHT_WORKSPACE_MAX_WIDTH_RATIO = 0.7

export const defaultRightWorkspaceState: RightWorkspaceState = {
  isOpen: false,
  isMaximized: false,
  panelWidth: RIGHT_WORKSPACE_DEFAULT_WIDTH,
  tabs: []
}

export type RightWorkspaceAction =
  | { type: 'open-tab'; tab: RightWorkspaceTab }
  | { type: 'open-review'; source?: LocalGitReviewSource }
  | { type: 'open-file'; relativePath: string; title?: string }
  | { type: 'activate-tab'; tabId: string }
  | { type: 'close-tab'; tabId: string }
  | { type: 'collapse' }
  | { type: 'restore' }
  | { type: 'toggle-maximized' }
  | { type: 'set-panel-width'; width: number }
  | {
      type: 'set-tab-runtime'
      tabId: string
      browserViewId?: string
      title?: string
    }
  | { type: 'reorder-tabs'; tabIds: string[] }

export type RightWorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type StoredRightWorkspaceState = {
  isOpen?: boolean
  isMaximized?: boolean
  panelWidth?: number
  activeTabId?: string
  tabs?: PersistedRightWorkspaceTab[]
}

export function createWorkspaceTab(
  type: Exclude<RightWorkspaceTabType, 'review' | 'file'>,
  id = crypto.randomUUID()
): RightWorkspaceTab {
  if (type === 'terminal') return { id, type, title: 'Terminal' }
  return { id, type, title: 'New tab' }
}

export function rightWorkspaceStorageKey(projectScope: string): string {
  return `right-workspace:${projectScope.trim() || 'default'}`
}

export function clampRightWorkspaceWidth(width: number, viewportWidth = windowWidth()): number {
  if (!Number.isFinite(width)) return RIGHT_WORKSPACE_DEFAULT_WIDTH
  const max = Math.floor(viewportWidth * RIGHT_WORKSPACE_MAX_WIDTH_RATIO)
  return Math.min(
    Math.max(RIGHT_WORKSPACE_MIN_WIDTH, max),
    Math.max(RIGHT_WORKSPACE_MIN_WIDTH, Math.round(width))
  )
}

export function rightWorkspaceReducer(
  state: RightWorkspaceState,
  action: RightWorkspaceAction
): RightWorkspaceState {
  switch (action.type) {
    case 'open-tab':
      return insertAndActivate(state, action.tab)
    case 'open-review': {
      const existing = state.tabs.find((tab) => tab.type === 'review')
      if (existing?.type === 'review') {
        return {
          ...state,
          isOpen: true,
          activeTabId: existing.id,
          tabs: state.tabs.map((tab) =>
            tab.type === 'review' ? { ...tab, source: action.source ?? tab.source } : tab
          )
        }
      }
      return insertAndActivate(state, {
        id: 'review',
        type: 'review',
        title: 'Review',
        source: action.source
      })
    }
    case 'open-file': {
      const normalizedPath = normalizeRelativePath(action.relativePath)
      const existing = state.tabs.find(
        (tab) => tab.type === 'file' && tab.relativePath === normalizedPath
      )
      if (existing) return { ...state, isOpen: true, activeTabId: existing.id }
      return insertAndActivate(state, {
        id: `file:${normalizedPath}`,
        type: 'file',
        title: action.title ?? basename(normalizedPath),
        relativePath: normalizedPath
      })
    }
    case 'activate-tab':
      return state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, isOpen: true, activeTabId: action.tabId }
        : state
    case 'close-tab': {
      const closedIndex = state.tabs.findIndex((tab) => tab.id === action.tabId)
      if (closedIndex === -1) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId)
      const activeTabId =
        state.activeTabId === action.tabId
          ? tabs[Math.max(0, closedIndex - 1)]?.id
          : state.activeTabId
      return { ...state, tabs, activeTabId }
    }
    case 'collapse':
      return { ...state, isOpen: false, isMaximized: false }
    case 'restore':
      return { ...state, isOpen: true }
    case 'toggle-maximized':
      return { ...state, isOpen: true, isMaximized: !state.isMaximized }
    case 'set-panel-width':
      return { ...state, panelWidth: clampRightWorkspaceWidth(action.width) }
    case 'set-tab-runtime':
      return {
        ...state,
        tabs: state.tabs.map((tab) => {
          if (tab.id !== action.tabId) return tab
          if (tab.type === 'terminal') {
            return {
              ...tab,
              ...(action.title ? { title: action.title } : {})
            }
          }
          if (tab.type === 'browser') {
            return {
              ...tab,
              ...(action.browserViewId ? { browserViewId: action.browserViewId } : {}),
              ...(action.title ? { title: action.title } : {})
            }
          }
          return tab
        })
      }
    case 'reorder-tabs': {
      const ordered = action.tabIds
        .map((id) => state.tabs.find((tab) => tab.id === id))
        .filter((tab): tab is RightWorkspaceTab => Boolean(tab))
      return ordered.length === state.tabs.length ? { ...state, tabs: ordered } : state
    }
    default:
      return state
  }
}

export function loadRightWorkspaceState(
  storage: RightWorkspaceStorage | undefined,
  projectScope: string
): RightWorkspaceState {
  if (!storage) return defaultRightWorkspaceState
  try {
    const raw = storage.getItem(rightWorkspaceStorageKey(projectScope))
    if (!raw) return defaultRightWorkspaceState
    return normalizeStoredState(JSON.parse(raw) as StoredRightWorkspaceState)
  } catch {
    return defaultRightWorkspaceState
  }
}

export function persistRightWorkspaceState(
  storage: RightWorkspaceStorage | undefined,
  projectScope: string,
  state: RightWorkspaceState
): void {
  if (!storage) return
  try {
    const tabs = state.tabs.map(persistableTab)
    storage.setItem(
      rightWorkspaceStorageKey(projectScope),
      JSON.stringify({
        isOpen: state.isOpen,
        isMaximized: state.isMaximized,
        panelWidth: state.panelWidth,
        activeTabId: state.activeTabId,
        tabs
      } satisfies StoredRightWorkspaceState)
    )
  } catch {
    storage.removeItem(rightWorkspaceStorageKey(projectScope))
  }
}

function insertAndActivate(
  state: RightWorkspaceState,
  tab: RightWorkspaceTab
): RightWorkspaceState {
  const existing = state.tabs.find((candidate) => candidate.id === tab.id)
  if (existing) return { ...state, isOpen: true, activeTabId: existing.id }
  const activeIndex = state.tabs.findIndex((candidate) => candidate.id === state.activeTabId)
  const tabs = [...state.tabs]
  tabs.splice(activeIndex < 0 ? tabs.length : activeIndex + 1, 0, tab)
  return { ...state, isOpen: true, tabs, activeTabId: tab.id }
}

function persistableTab(tab: RightWorkspaceTab): PersistedRightWorkspaceTab {
  if (tab.type === 'review') return tab
  if (tab.type === 'file') return tab
  return { id: tab.id, type: tab.type, title: tab.title }
}

function normalizeStoredState(value: StoredRightWorkspaceState): RightWorkspaceState {
  const tabs = (value.tabs ?? []).filter(isPersistedTab)
  const activeTabId = tabs.some((tab) => tab.id === value.activeTabId)
    ? value.activeTabId
    : tabs.at(-1)?.id
  return {
    isOpen: value.isOpen === true,
    isMaximized: value.isMaximized === true,
    panelWidth: clampRightWorkspaceWidth(value.panelWidth ?? RIGHT_WORKSPACE_DEFAULT_WIDTH),
    tabs,
    activeTabId
  }
}

function isPersistedTab(tab: unknown): tab is PersistedRightWorkspaceTab {
  if (!tab || typeof tab !== 'object') return false
  const candidate = tab as Partial<PersistedRightWorkspaceTab>
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return false
  if (candidate.type === 'review') return candidate.id === 'review'
  if (candidate.type === 'file') return typeof candidate.relativePath === 'string'
  return candidate.type === 'terminal' || candidate.type === 'browser'
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+/gu, '/')
}

function basename(path: string): string {
  return path.split('/').at(-1) || path
}

function windowWidth(): number {
  return typeof window === 'undefined'
    ? Math.ceil(RIGHT_WORKSPACE_DEFAULT_WIDTH / RIGHT_WORKSPACE_MAX_WIDTH_RATIO)
    : window.innerWidth
}
