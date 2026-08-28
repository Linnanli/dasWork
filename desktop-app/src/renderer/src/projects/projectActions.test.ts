import { describe, expect, it } from 'vitest'

import { projectActionScopeForTask } from './projectActions'
import type { ProjectState } from '../../../shared/projects/projectTypes'

const state: ProjectState = {
  workspaceRootOptions: [
    { root: '/workspace/path-project', hostId: 'local', addedAt: '', lastOpenedAt: '' }
  ],
  localProjects: {
    local: {
      id: 'local',
      kind: 'local',
      name: 'Local',
      hostId: 'local',
      createdAt: '',
      updatedAt: '',
      writableRoots: ['/workspace/local']
    }
  },
  remoteProjects: [
    {
      id: 'remote',
      kind: 'remote',
      hostId: 'ssh-dev',
      label: 'Remote',
      remotePath: '/srv/app',
      createdAt: '',
      updatedAt: ''
    }
  ],
  projectOrder: [],
  pinnedProjectIds: [],
  projectActions: {},
  projectWritableRoots: {},
  threadProjectAssignments: {},
  threadWritableRoots: {},
  threadWorkspaceRootHints: {},
  threadProjectlessOutputDirectories: {},
  projectlessThreadIds: [],
  projectlessHints: {}
}

describe('projectActionScopeForTask', () => {
  it('uses the task assignment over the currently selected project', () => {
    const result = projectActionScopeForTask(
      {
        ...state,
        threadProjectAssignments: {
          thread: { projectKind: 'local', projectId: 'local', cwd: '/workspace/local' }
        }
      },
      {
        conversationId: 'conversation',
        threadId: 'thread',
        projectSelection: { projectKind: 'remote', projectId: 'remote', hostId: 'ssh-dev' }
      }
    )

    expect(result).toEqual({ projectKind: 'local', projectId: 'local' })
  })

  it('uses a registered path assignment when no saved local project owns it', () => {
    const result = projectActionScopeForTask(
      {
        ...state,
        threadProjectAssignments: {
          thread: {
            projectKind: 'local',
            projectId: '/workspace/path-project',
            path: '/workspace/path-project',
            cwd: '/workspace/path-project'
          }
        }
      },
      { conversationId: 'conversation', threadId: 'thread' }
    )

    expect(result).toEqual({ projectKind: 'path', path: '/workspace/path-project' })
  })
})
