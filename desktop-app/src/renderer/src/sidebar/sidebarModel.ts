import type { SidebarPreferences } from '../../../shared/codexIpcApi'
import type {
  LocalProject,
  ProjectSelection,
  ProjectState,
  RemoteProject,
  WorkspaceRootOption
} from '../../../shared/projects/projectTypes'
import type { SidebarConversationView, SidebarProjectGroup, SidebarViewModel } from './sidebarTypes'

export function buildSidebarViewModel(input: {
  projectState: ProjectState | null
  conversations: SidebarConversationView[]
  preferences: SidebarPreferences
}): SidebarViewModel {
  const conversations = markPinnedConversations(input.conversations, input.preferences)
  const visibleConversations = conversations.filter((conversation) => !conversation.archived)
  const projectGroups = input.projectState
    ? buildProjectGroups(input.projectState, visibleConversations, input.preferences)
    : []

  return {
    preferences: input.preferences,
    projectGroups,
    quickChats: sortConversations(
      visibleConversations.filter(
        (conversation) => conversation.projectAssignment?.projectKind === 'projectless'
      ),
      input.preferences.sortKey
    ),
    chronologicalChats: sortConversations(visibleConversations, input.preferences.sortKey),
    archivedChats: sortConversations(
      conversations.filter((conversation) => conversation.archived),
      input.preferences.sortKey
    )
  }
}

function markPinnedConversations(
  conversations: SidebarConversationView[],
  preferences: SidebarPreferences
): SidebarConversationView[] {
  const pinnedConversationIds = new Set(preferences.pinnedConversationIds)
  return conversations.map((conversation) => ({
    ...conversation,
    pinned: !conversation.archived && pinnedConversationIds.has(conversation.id)
  }))
}

function buildProjectGroups(
  projectState: ProjectState,
  conversations: SidebarConversationView[],
  preferences: SidebarPreferences
): SidebarProjectGroup[] {
  const localGroups = projectState.projectOrder
    .map((projectId) => projectState.localProjects[projectId])
    .filter((project): project is LocalProject => Boolean(project))
    .map((project) => localProjectGroup(projectState, project, conversations, preferences))

  const remoteGroups = projectState.remoteProjects.map((project) =>
    remoteProjectGroup(projectState, project, conversations, preferences)
  )

  const pathGroups = projectState.workspaceRootOptions
    .filter((option) => option.hostId === 'local')
    .map((option) => pathProjectGroup(projectState, option, conversations, preferences))

  const groups = [...localGroups, ...remoteGroups, ...pathGroups]
  if (preferences.organizeMode === 'recent-projects') {
    return groups.sort((left, right) => latestActivity(right) - latestActivity(left))
  }
  return groups
}

function localProjectGroup(
  projectState: ProjectState,
  project: LocalProject,
  conversations: SidebarConversationView[],
  preferences: SidebarPreferences
): SidebarProjectGroup {
  const id = `local:${project.id}`
  const groupConversations = conversations.filter(
    (conversation) =>
      conversation.projectAssignment?.projectKind === 'local' &&
      conversation.projectAssignment.projectId === project.id
  )
  return {
    id,
    label: project.name,
    selection: { projectKind: 'local', projectId: project.id },
    conversations: sortConversations(groupConversations, preferences.sortKey),
    threadCount: groupConversations.length,
    warning: missingRoots(projectState, project.writableRoots),
    collapsed: preferences.collapsedGroupIds.includes(id),
    active: isActiveSelection(projectState.activeProjectSelection, {
      projectKind: 'local',
      projectId: project.id
    })
  }
}

function remoteProjectGroup(
  projectState: ProjectState,
  project: RemoteProject,
  conversations: SidebarConversationView[],
  preferences: SidebarPreferences
): SidebarProjectGroup {
  const id = `remote:${project.hostId}:${project.id}`
  const selection: ProjectSelection = {
    projectKind: 'remote',
    projectId: project.id,
    hostId: project.hostId
  }
  const groupConversations = conversations.filter(
    (conversation) =>
      conversation.projectAssignment?.projectKind === 'remote' &&
      conversation.projectAssignment.projectId === project.id &&
      conversation.projectAssignment.hostId === project.hostId
  )
  return {
    id,
    label: project.label,
    selection,
    conversations: sortConversations(groupConversations, preferences.sortKey),
    threadCount: groupConversations.length,
    collapsed: preferences.collapsedGroupIds.includes(id),
    active: isActiveSelection(projectState.activeProjectSelection, selection)
  }
}

function pathProjectGroup(
  projectState: ProjectState,
  option: WorkspaceRootOption,
  conversations: SidebarConversationView[],
  preferences: SidebarPreferences
): SidebarProjectGroup {
  const id = `path:${option.root}`
  const selection: ProjectSelection = { projectKind: 'path', path: option.root }
  const groupConversations = conversations.filter(
    (conversation) =>
      conversation.projectAssignment?.projectKind === 'local' &&
      (conversation.projectAssignment.path === option.root ||
        conversation.projectAssignment.cwd === option.root)
  )
  return {
    id,
    label: option.label ?? basename(option.root),
    selection,
    conversations: sortConversations(groupConversations, preferences.sortKey),
    threadCount: groupConversations.length,
    warning: option.missing ? 'This project folder was deleted or moved' : undefined,
    collapsed: preferences.collapsedGroupIds.includes(id),
    active: isActiveSelection(projectState.activeProjectSelection, selection)
  }
}

function sortConversations(
  conversations: SidebarConversationView[],
  sortKey: SidebarPreferences['sortKey']
): SidebarConversationView[] {
  const field = sortKey === 'created_at' ? 'createdAt' : 'updatedAt'
  return [...conversations].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return timestamp(right[field]) - timestamp(left[field])
  })
}

function latestActivity(group: SidebarProjectGroup): number {
  return Math.max(
    0,
    ...group.conversations.map((conversation) => timestamp(conversation.updatedAt))
  )
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0
}

function missingRoots(projectState: ProjectState, roots: string[]): string | undefined {
  const missing = roots.filter((root) =>
    projectState.workspaceRootOptions.some(
      (option) => option.hostId === 'local' && option.root === root && option.missing
    )
  )
  return missing.length > 0 ? `Missing roots: ${missing.join(', ')}` : undefined
}

function isActiveSelection(left: ProjectSelection | undefined, right: ProjectSelection): boolean {
  if (!left) return false
  if (left.projectKind !== right.projectKind) return false
  if (left.projectKind === 'local' && right.projectKind === 'local') {
    return left.projectId === right.projectId
  }
  if (left.projectKind === 'path' && right.projectKind === 'path') return left.path === right.path
  if (left.projectKind === 'projectless' && right.projectKind === 'projectless') return true
  if (left.projectKind === 'remote' && right.projectKind === 'remote') {
    return left.projectId === right.projectId && left.hostId === right.hostId
  }
  return false
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
