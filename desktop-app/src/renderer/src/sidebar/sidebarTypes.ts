import type { SidebarConversation, SidebarPreferences } from '../../../shared/codexIpcApi'
import type { ProjectSelection } from '../../../shared/projects/projectTypes'

export type SidebarProjectGroup = {
  id: string
  label: string
  selection: ProjectSelection
  conversations: SidebarConversationView[]
  threadCount: number
  warning?: string
  collapsed: boolean
  active: boolean
}

export type SidebarConversationView = SidebarConversation & {
  active?: boolean
  attention?: boolean
  pinned?: boolean
}

export type SidebarViewModel = {
  preferences: SidebarPreferences
  projectGroups: SidebarProjectGroup[]
  quickChats: SidebarConversationView[]
  chronologicalChats: SidebarConversationView[]
  archivedChats: SidebarConversationView[]
}
