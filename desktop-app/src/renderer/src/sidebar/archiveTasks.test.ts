import { describe, expect, it } from 'vitest'

import { archivedTaskProjectGroups, archivedTaskProjectOptions } from './archiveTasks'
import type { ProjectState } from '../../../shared/projects/projectTypes'
import type { SidebarConversationView } from './sidebarTypes'

const projectState: ProjectState = {
  workspaceRootOptions: [],
  localProjects: {
    local: {
      id: 'local',
      kind: 'local',
      name: 'Desktop App',
      hostId: 'local',
      createdAt: '',
      updatedAt: '',
      writableRoots: ['/workspace/desktop']
    }
  },
  remoteProjects: [],
  projectOrder: ['local'],
  pinnedProjectIds: [],
  projectWritableRoots: {},
  threadProjectAssignments: {},
  threadWritableRoots: {},
  threadWorkspaceRootHints: {},
  threadProjectlessOutputDirectories: {},
  projectlessThreadIds: [],
  projectlessHints: {}
}

const archivedChats: SidebarConversationView[] = [
  {
    id: 'local-old',
    archived: true,
    title: 'Old local task',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/workspace/desktop' }
  },
  {
    id: 'local-new',
    archived: true,
    title: 'New local task',
    threadSource: 'automation',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/workspace/desktop' }
  },
  {
    id: 'scratch',
    archived: true,
    title: 'Archived note',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    projectAssignment: {
      projectKind: 'projectless',
      cwd: '/tmp/note',
      workspaceRoot: '/tmp/note',
      outputDirectory: '/tmp/note/out'
    }
  }
]

describe('archived task groups', () => {
  it('filters by project and keeps the drawer sort independent from the sidebar preference', () => {
    const groups = archivedTaskProjectGroups({
      chats: archivedChats,
      projectState,
      query: '',
      projectId: 'local:local',
      type: 'all',
      sort: 'created-desc'
    })

    expect(groups).toEqual([
      expect.objectContaining({
        id: 'local:local',
        label: 'Desktop App',
        conversations: [
          expect.objectContaining({ id: 'local-new' }),
          expect.objectContaining({ id: 'local-old' })
        ]
      })
    ])
  })

  it('searches both task and project labels, and builds available project filters', () => {
    expect(
      archivedTaskProjectGroups({
        chats: archivedChats,
        projectState,
        query: 'desktop app',
        projectId: 'all',
        type: 'all',
        sort: 'updated-desc'
      }).map((group) => group.id)
    ).toEqual(['local:local'])
    expect(archivedTaskProjectOptions(archivedChats, projectState)).toEqual([
      { id: 'local:local', label: 'Desktop App' },
      { id: 'projectless', label: '临时任务' }
    ])
  })

  it('filters explicit automation sources without treating unknown sources as automation', () => {
    expect(
      archivedTaskProjectGroups({
        chats: archivedChats,
        projectState,
        query: '',
        projectId: 'all',
        type: 'automation',
        sort: 'updated-desc'
      })
        .flatMap((group) => group.conversations)
        .map((chat) => chat.id)
    ).toEqual(['local-new'])

    expect(
      archivedTaskProjectGroups({
        chats: archivedChats,
        projectState,
        query: '',
        projectId: 'all',
        type: 'standard',
        sort: 'updated-desc'
      })
        .flatMap((group) => group.conversations)
        .map((chat) => chat.id)
    ).toEqual(['scratch', 'local-old'])
  })
})
