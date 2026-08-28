import { describe, expect, it } from 'vitest'

import { searchSidebarTasks } from './taskSearch'
import type { SidebarConversationView } from './sidebarTypes'

const conversations: SidebarConversationView[] = [
  {
    id: 'local-task',
    threadId: 'thread-local',
    title: 'Refactor the renderer',
    cwd: '/workspace/desktop-app',
    projectAssignment: { projectKind: 'local', projectId: 'desktop', cwd: '/workspace/desktop-app' }
  },
  {
    id: 'archived-task',
    title: 'Investigate release notes',
    archived: true,
    projectAssignment: {
      projectKind: 'projectless',
      cwd: '/tmp/release-notes',
      workspaceRoot: '/tmp/release-notes',
      outputDirectory: '/tmp/release-notes/out'
    }
  }
]

describe('searchSidebarTasks', () => {
  it('searches every task instead of only the active project, including archived tasks', () => {
    expect(searchSidebarTasks(conversations, 'release')).toEqual([conversations[1]])
    expect(searchSidebarTasks(conversations, 'thread-local')).toEqual([conversations[0]])
    expect(searchSidebarTasks(conversations, '/workspace/desktop')).toEqual([conversations[0]])
  })

  it('keeps every task visible until a query is entered', () => {
    expect(searchSidebarTasks(conversations, '   ')).toBe(conversations)
  })
})
