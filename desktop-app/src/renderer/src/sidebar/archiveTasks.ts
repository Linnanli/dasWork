import type { ProjectState } from '../../../shared/projects/projectTypes'

import type { SidebarConversationView } from './sidebarTypes'

export type ArchivedTaskSort = 'updated-desc' | 'created-desc'
export type ArchivedTaskType = 'all' | 'automation' | 'standard'

export type ArchivedTaskProjectGroup = {
  id: string
  label: string
  conversations: readonly SidebarConversationView[]
}

export function archivedTaskProjectGroups(input: {
  chats: readonly SidebarConversationView[]
  projectState: ProjectState | null
  query: string
  projectId: string
  type: ArchivedTaskType
  sort: ArchivedTaskSort
}): readonly ArchivedTaskProjectGroup[] {
  const query = input.query.trim().toLocaleLowerCase()
  const groups = new Map<string, { label: string; conversations: SidebarConversationView[] }>()

  for (const chat of input.chats) {
    const project = archivedTaskProject(input.projectState, chat)
    if (input.projectId !== 'all' && project.id !== input.projectId) continue
    if (input.type !== 'all' && archivedTaskType(chat) !== input.type) continue
    if (query && !archivedChatSearchText(chat, project.label).includes(query)) continue
    const group = groups.get(project.id) ?? { label: project.label, conversations: [] }
    group.conversations.push(chat)
    groups.set(project.id, group)
  }

  return [...groups.entries()]
    .map(([id, group]) => ({
      id,
      label: group.label,
      conversations: sortArchivedChats(group.conversations, input.sort)
    }))
    .sort((left, right) => {
      const latestDifference =
        latestTimestamp(right.conversations) - latestTimestamp(left.conversations)
      return latestDifference || left.label.localeCompare(right.label, 'zh-Hans-CN')
  })
}

function archivedTaskType(chat: SidebarConversationView): Exclude<ArchivedTaskType, 'all'> {
  return chat.threadSource?.trim().toLocaleLowerCase() === 'automation'
    ? 'automation'
    : 'standard'
}

export function archivedTaskProjectOptions(
  chats: readonly SidebarConversationView[],
  projectState: ProjectState | null
): readonly { id: string; label: string }[] {
  const options = new Map<string, string>()
  for (const chat of chats) {
    const project = archivedTaskProject(projectState, chat)
    options.set(project.id, project.label)
  }
  return [...options.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((left, right) => {
      const rankDifference =
        archivedProjectOptionRank(left.id) - archivedProjectOptionRank(right.id)
      return rankDifference || left.label.localeCompare(right.label, 'zh-Hans-CN')
    })
}

export function archivedTaskProject(
  projectState: ProjectState | null,
  chat: SidebarConversationView
): { id: string; label: string } {
  const assignment = chat.projectAssignment
  if (!assignment) return { id: 'unassigned', label: '未分组任务' }
  if (assignment.projectKind === 'projectless') {
    return { id: 'projectless', label: '临时任务' }
  }
  if (assignment.projectKind === 'local') {
    const project = projectState?.localProjects[assignment.projectId]
    if (project) return { id: `local:${project.id}`, label: project.name }
    const path = assignment.path ?? assignment.cwd
    if (path) {
      const option = projectState?.workspaceRootOptions.find(
        (candidate) => candidate.hostId === 'local' && candidate.root === path
      )
      return { id: `path:${path}`, label: option?.label ?? basename(path) }
    }
    return { id: `local:${assignment.projectId}`, label: '本地项目' }
  }
  const project = projectState?.remoteProjects.find(
    (candidate) => candidate.id === assignment.projectId && candidate.hostId === assignment.hostId
  )
  return {
    id: `remote:${assignment.hostId}:${assignment.projectId}`,
    label: project?.label ?? assignment.cwd ?? '远程项目'
  }
}

function archivedChatSearchText(chat: SidebarConversationView, projectLabel: string): string {
  return [chat.title, chat.cwd, chat.threadId, chat.id, projectLabel]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLocaleLowerCase()
}

function archivedProjectOptionRank(projectId: string): number {
  if (projectId === 'projectless') return 1
  if (projectId === 'unassigned') return 2
  return 0
}

function sortArchivedChats(
  chats: readonly SidebarConversationView[],
  sort: ArchivedTaskSort
): SidebarConversationView[] {
  const field = sort === 'created-desc' ? 'createdAt' : 'updatedAt'
  return [...chats].sort((left, right) => timestamp(right[field]) - timestamp(left[field]))
}

function latestTimestamp(chats: readonly SidebarConversationView[]): number {
  return Math.max(0, ...chats.map((chat) => timestamp(chat.updatedAt)))
}

function timestamp(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
