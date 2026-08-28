import { describe, expect, it } from 'vitest'

import { buildSidebarViewModel } from './sidebarModel'
import type { SidebarConversation, SidebarPreferences } from '../../../shared/codexIpcApi'
import type { ProjectState } from '../../../shared/projects/projectTypes'

const preferences: SidebarPreferences = {
  organizeMode: 'project',
  sortKey: 'updated_at',
  collapsedSectionIds: [],
  collapsedGroupIds: ['local:collapsed'],
  pinnedConversationIds: []
}

const projectState: ProjectState = {
  workspaceRootOptions: [
    {
      root: '/repo/path',
      label: 'Path Repo',
      hostId: 'local',
      addedAt: '2026-06-30T00:00:00.000Z',
      lastOpenedAt: '2026-06-30T00:00:00.000Z'
    },
    {
      root: '/repo/missing',
      label: 'Missing Repo',
      hostId: 'local',
      addedAt: '2026-06-30T00:00:00.000Z',
      lastOpenedAt: '2026-06-30T00:00:00.000Z',
      missing: true
    }
  ],
  localProjects: {
    local: {
      id: 'local',
      kind: 'local',
      name: 'Desktop App',
      hostId: 'local',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      writableRoots: ['/repo/local']
    },
    collapsed: {
      id: 'collapsed',
      kind: 'local',
      name: 'Collapsed App',
      hostId: 'local',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      writableRoots: ['/repo/collapsed']
    }
  },
  remoteProjects: [
    {
      id: 'remote',
      kind: 'remote',
      hostId: 'ssh-dev',
      label: 'Remote App',
      remotePath: '/srv/app',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z'
    }
  ],
  projectOrder: ['collapsed', 'local'],
  pinnedProjectIds: ['local'],
  projectWritableRoots: {},
  threadProjectAssignments: {},
  threadWritableRoots: {},
  threadWorkspaceRootHints: {},
  threadProjectlessOutputDirectories: {},
  projectlessThreadIds: [],
  projectlessHints: {},
  activeProjectSelection: { projectKind: 'local', projectId: 'local' },
  activeWorkspaceRoots: ['/repo/local']
}

const conversations: SidebarConversation[] = [
  {
    id: 'thread-local',
    title: 'Local thread',
    projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/repo/local' },
    updatedAt: '2026-06-30T03:00:00.000Z',
    createdAt: '2026-06-30T01:00:00.000Z',
    cwd: '/repo/local'
  },
  {
    id: 'thread-path',
    title: 'Path thread',
    projectAssignment: {
      projectKind: 'local',
      projectId: 'path:/repo/path',
      path: '/repo/path',
      cwd: '/repo/path'
    },
    updatedAt: '2026-06-30T02:00:00.000Z',
    createdAt: '2026-06-30T02:00:00.000Z',
    cwd: '/repo/path'
  },
  {
    id: 'thread-remote',
    title: 'Remote thread',
    projectAssignment: {
      projectKind: 'remote',
      projectId: 'remote',
      hostId: 'ssh-dev',
      cwd: '/srv/app'
    },
    updatedAt: '2026-06-30T02:30:00.000Z',
    createdAt: '2026-06-30T02:30:00.000Z',
    cwd: '/srv/app'
  },
  {
    id: 'thread-quick',
    title: 'Scratch',
    projectAssignment: {
      projectKind: 'projectless',
      cwd: '/tmp/thread-quick',
      workspaceRoot: '/tmp/thread-quick',
      outputDirectory: '/tmp/thread-quick/out'
    },
    updatedAt: '2026-06-30T04:00:00.000Z',
    createdAt: '2026-06-30T04:00:00.000Z',
    cwd: '/tmp/thread-quick'
  },
  {
    id: 'thread-archived',
    title: 'Archived',
    archived: true,
    projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/repo/local' }
  }
]

describe('buildSidebarViewModel', () => {
  it('builds local/remote/path project groups, quick chats, counts, active state, and missing warnings', () => {
    const model = buildSidebarViewModel({ projectState, conversations, preferences })

    expect(model.projectGroups.map((group) => group.id)).toEqual([
      'local:collapsed',
      'local:local',
      'remote:ssh-dev:remote',
      'path:/repo/path',
      'path:/repo/missing'
    ])
    expect(model.projectGroups.find((group) => group.id === 'local:local')).toMatchObject({
      label: 'Desktop App',
      threadCount: 1,
      active: true,
      collapsed: false
    })
    expect(model.projectGroups.find((group) => group.id === 'local:collapsed')).toMatchObject({
      collapsed: true
    })
    expect(model.projectGroups.find((group) => group.id === 'remote:ssh-dev:remote')).toMatchObject(
      {
        label: 'Remote App',
        threadCount: 1,
        selection: { projectKind: 'remote', projectId: 'remote', hostId: 'ssh-dev' }
      }
    )
    expect(model.projectGroups.find((group) => group.id === 'path:/repo/missing')).toMatchObject({
      label: 'Missing Repo',
      warning: 'This project folder was deleted or moved'
    })
    expect(model.quickChats.map((chat) => chat.id)).toEqual(['thread-quick'])
  })

  it('prioritizes pinned chats and keeps archived rows in their recoverable section', () => {
    const model = buildSidebarViewModel({
      projectState,
      conversations,
      preferences: {
        ...preferences,
        organizeMode: 'chronological',
        sortKey: 'created_at',
        pinnedConversationIds: ['thread-local']
      }
    })

    expect(model.chronologicalChats.map((chat) => chat.id)).toEqual([
      'thread-local',
      'thread-quick',
      'thread-remote',
      'thread-path'
    ])
    expect(model.chronologicalChats.map((chat) => chat.id)).not.toContain('thread-archived')
    expect(model.chronologicalChats[0]).toMatchObject({ id: 'thread-local', pinned: true })
    expect(model.archivedChats).toMatchObject([{ id: 'thread-archived', archived: true }])
  })

  it('orders recent projects by latest conversation activity', () => {
    const model = buildSidebarViewModel({
      projectState,
      conversations,
      preferences: { ...preferences, organizeMode: 'recent-projects' }
    })

    expect(model.projectGroups.map((group) => group.id).slice(0, 3)).toEqual([
      'local:local',
      'remote:ssh-dev:remote',
      'path:/repo/path'
    ])
  })
})
