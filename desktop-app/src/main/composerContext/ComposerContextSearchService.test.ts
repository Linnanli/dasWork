import { describe, expect, it, vi } from 'vitest'

import type { CodexTaskSearchResult } from '@dascowork/codex-app-server-client'
import type { SidebarConversationListState } from '../../shared/codexIpcApi'
import type { ProjectState, ResolvedExecutionTarget } from '../../shared/projects/projectTypes'
import { ComposerContextSearchService } from './ComposerContextSearchService'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function createHarness() {
  const events: unknown[] = []
  let fileCallbacks:
    | {
        onUpdated(files: never[], query: string): void
        onCompleted(query: string): void
      }
    | undefined
  const fileSession = {
    update: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  }
  const provider = {
    createFuzzyFileSearchSession: vi.fn(async (input) => {
      fileCallbacks = input
      return fileSession
    }),
    searchThreads: vi.fn<
      (input: { query: string; limit?: number }) => Promise<CodexTaskSearchResult[]>
    >(async () => [])
  }
  const projectService = {
    resolveExistingThreadTarget: vi.fn(
      async () =>
        ({
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo'],
          workspaceKind: 'project' as const
        }) as ResolvedExecutionTarget
    ),
    resolveNewThreadTarget: vi.fn(
      async () =>
        ({
          hostId: 'local',
          cwd: '/repo',
          workspaceRoots: ['/repo'],
          workspaceKind: 'project' as const
        }) as ResolvedExecutionTarget
    )
  }
  const projectStore = {
    getState: vi.fn<() => Promise<ProjectState>>(async () => ({
      workspaceRootOptions: [],
      localProjects: {},
      remoteProjects: [],
      projectOrder: [],
      pinnedProjectIds: [],
      projectWritableRoots: {},
      threadProjectAssignments: {},
      threadWritableRoots: {},
      threadWorkspaceRootHints: {},
      threadProjectlessOutputDirectories: {},
      projectlessThreadIds: [],
      projectlessHints: {},
      activeProjectSelection: { projectKind: 'path', path: '/repo' }
    }))
  }
  const conversations = {
    getConversationSnapshot: vi.fn<() => SidebarConversationListState>(() => ({
      conversations: [],
      archivedConversationIds: [],
      loaded: true
    }))
  }
  const service = new ComposerContextSearchService({
    provider,
    projectService,
    projectStore,
    conversations,
    publish: (_owner, event) => events.push(event)
  })
  return {
    service,
    events,
    provider,
    projectService,
    projectStore,
    conversations,
    fileSession,
    getFileCallbacks: () => fileCallbacks
  }
}

function completedFileEventCount(events: unknown[]): number {
  return events.filter((event) => {
    const searchEvent = event as { sectionId?: string; complete?: boolean }
    return searchEvent.sectionId === 'files' && searchEvent.complete === true
  }).length
}

describe('ComposerContextSearchService', () => {
  it('keeps one file session, publishes partial results, and stops with the owner', async () => {
    const harness = createHarness()
    const started = await harness.service.start(7, { version: 1, cwd: '/repo' })

    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'needle'
    })
    await vi.waitFor(() => expect(harness.fileSession.update).toHaveBeenCalledWith('needle'))
    harness.getFileCallbacks()?.onUpdated(
      [
        {
          root: '/repo',
          path: 'src/needle.ts',
          match_type: 'file',
          file_name: 'needle.ts',
          score: 10,
          indices: null
        }
      ] as never[],
      'needle'
    )
    harness.getFileCallbacks()?.onCompleted('needle')
    await harness.service.stop(7, started.sessionId)
    await harness.service.stop(7, started.sessionId)

    expect(harness.provider.createFuzzyFileSearchSession).toHaveBeenCalledOnce()
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        sectionId: 'files',
        complete: false,
        items: [expect.objectContaining({ path: '/repo/src/needle.ts' })]
      })
    )
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        sectionId: 'files',
        complete: true,
        items: [expect.objectContaining({ path: '/repo/src/needle.ts' })]
      })
    )
    expect(harness.fileSession.stop).toHaveBeenCalledOnce()
  })

  it('starts the persistent file session only once when query updates race', async () => {
    const harness = createHarness()
    let resolveSession!: (session: typeof harness.fileSession) => void
    harness.provider.createFuzzyFileSearchSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve
        })
    )
    const started = await harness.service.start(7, { version: 1, cwd: '/repo' })

    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'first'
    })
    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'second'
    })
    resolveSession(harness.fileSession)

    await vi.waitFor(() => expect(harness.fileSession.update).toHaveBeenCalledWith('second'))
    expect(harness.provider.createFuzzyFileSearchSession).toHaveBeenCalledOnce()
    expect(harness.fileSession.update).not.toHaveBeenCalledWith('first')
  })

  it('rejects a different window and ignores stale task results', async () => {
    const harness = createHarness()
    let resolveFirst: ((value: CodexTaskSearchResult[]) => void) | undefined
    harness.provider.searchThreads
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce([
        {
          threadId: 'thread-new',
          name: 'new result',
          updatedAt: '2026-01-02T00:00:00.000Z',
          source: 'appServer',
          archived: false
        }
      ])
    const started = await harness.service.start(7, { version: 1, threadId: 'current' })

    await expect(
      harness.service.update(8, {
        version: 1,
        sessionId: started.sessionId,
        query: 'wrong owner'
      })
    ).rejects.toThrow('owner mismatch')
    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'old'
    })
    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'new'
    })
    resolveFirst?.([
      {
        threadId: 'thread-old',
        name: 'old result',
        updatedAt: '2026-01-01T00:00:00.000Z',
        source: 'appServer',
        archived: false
      }
    ])
    await vi.waitFor(() =>
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          query: 'new',
          sectionId: 'tasks',
          items: [expect.objectContaining({ threadId: 'thread-new' })]
        })
      )
    )
    expect(JSON.stringify(harness.events)).not.toContain('thread-old')
  })

  it('ignores stale file notifications from the previous query', async () => {
    const harness = createHarness()
    const started = await harness.service.start(7, { version: 1, cwd: '/repo' })

    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'old'
    })
    await vi.waitFor(() => expect(harness.fileSession.update).toHaveBeenCalledWith('old'))
    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'new'
    })
    harness.getFileCallbacks()?.onUpdated(
      [
        {
          root: '/repo',
          path: 'old.ts',
          match_type: 'file',
          file_name: 'old.ts',
          score: 10,
          indices: null
        }
      ] as never[],
      'old'
    )
    const completedBefore = completedFileEventCount(harness.events)
    harness.getFileCallbacks()?.onCompleted('old')

    expect(JSON.stringify(harness.events)).not.toContain('/repo/old.ts')
    expect(completedFileEventCount(harness.events)).toBe(completedBefore)
  })

  it('filters current, selected, archived, and subagent tasks before project grouping', async () => {
    const harness = createHarness()
    harness.provider.searchThreads.mockResolvedValueOnce([
      {
        threadId: 'current',
        name: 'needle current',
        updatedAt: '2026-01-06T00:00:00.000Z',
        source: 'appServer',
        archived: false
      },
      {
        threadId: 'selected',
        name: 'needle selected',
        updatedAt: '2026-01-05T00:00:00.000Z',
        source: 'appServer',
        archived: false
      },
      {
        threadId: 'subagent',
        name: 'needle subagent',
        updatedAt: '2026-01-04T00:00:00.000Z',
        source: 'appServer',
        parentThreadId: 'current',
        archived: false
      },
      {
        threadId: 'thread-source-subagent',
        name: 'needle thread source subagent',
        updatedAt: '2026-01-04T00:00:00.000Z',
        source: 'appServer',
        threadSource: 'subagent',
        archived: false
      },
      {
        threadId: 'archived',
        name: 'needle archived',
        updatedAt: '2026-01-03T00:00:00.000Z',
        source: 'appServer',
        archived: true
      },
      {
        threadId: 'other-project',
        name: 'needle other',
        cwd: '/other',
        updatedAt: '2026-01-03T00:00:00.000Z',
        source: 'appServer',
        archived: false
      },
      {
        threadId: 'projectless',
        name: 'needle projectless',
        updatedAt: '2026-01-02T00:00:00.000Z',
        source: 'appServer',
        archived: false
      },
      {
        threadId: 'assigned-current-project',
        name: 'needle assigned project',
        cwd: '/outside-current-root',
        updatedAt: '2026-01-07T00:00:00.000Z',
        source: 'appServer',
        archived: false
      },
      {
        threadId: 'current-project',
        name: 'needle server title',
        snippet: 'needle history match',
        cwd: '/repo/packages/ui',
        updatedAt: '2026-01-01T00:00:00.000Z',
        source: 'appServer',
        archived: false
      }
    ])
    harness.projectStore.getState.mockResolvedValue({
      workspaceRootOptions: [],
      localProjects: {},
      remoteProjects: [],
      projectOrder: [],
      pinnedProjectIds: [],
      projectWritableRoots: {},
      threadProjectAssignments: {
        'assigned-current-project': {
          projectKind: 'local',
          projectId: 'project-a',
          cwd: '/outside-current-root'
        },
        projectless: {
          projectKind: 'projectless',
          cwd: null,
          workspaceRoot: null,
          outputDirectory: null
        }
      },
      threadWritableRoots: {},
      threadWorkspaceRootHints: {},
      threadProjectlessOutputDirectories: {},
      projectlessThreadIds: ['projectless'],
      projectlessHints: {},
      activeProjectSelection: { projectKind: 'path', path: '/repo' }
    })
    harness.conversations.getConversationSnapshot.mockReturnValue({
      conversations: [
        {
          id: 'current-project',
          threadId: 'current-project',
          title: 'needle local title',
          cwd: '/repo/packages/ui',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ],
      archivedConversationIds: [],
      loaded: true
    })
    harness.projectService.resolveExistingThreadTarget.mockResolvedValueOnce({
      hostId: 'local',
      cwd: '/repo',
      workspaceRoots: ['/repo'],
      workspaceKind: 'project',
      projectAssignment: {
        projectKind: 'local',
        projectId: 'project-a',
        cwd: '/repo'
      }
    })
    const started = await harness.service.start(7, {
      version: 1,
      threadId: 'current',
      excludedThreadIds: ['selected']
    })

    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'needle'
    })

    await vi.waitFor(() =>
      expect(harness.events).toContainEqual(
        expect.objectContaining({
          sectionId: 'tasks',
          status: 'ready',
          items: [
            expect.objectContaining({ threadId: 'assigned-current-project' }),
            expect.objectContaining({
              threadId: 'current-project',
              label: 'needle local title',
              snippet: 'needle history match'
            }),
            expect.objectContaining({ threadId: 'projectless' }),
            expect.objectContaining({ threadId: 'other-project' })
          ]
        })
      )
    )
  })

  it('reports remote dynamic search as unavailable without using the local provider', async () => {
    const harness = createHarness()
    harness.projectService.resolveExistingThreadTarget.mockResolvedValueOnce({
      hostId: 'ssh-dev',
      cwd: '/srv/repo',
      workspaceRoots: ['/srv/repo'],
      workspaceKind: 'project'
    })
    const started = await harness.service.start(7, { version: 1, threadId: 'remote-thread' })

    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'needle'
    })

    expect(started).toMatchObject({
      hostId: 'ssh-dev',
      filesAvailable: false,
      tasksAvailable: false
    })
    expect(harness.provider.createFuzzyFileSearchSession).not.toHaveBeenCalled()
    expect(harness.provider.searchThreads).not.toHaveBeenCalled()
    expect(harness.events).toEqual([
      expect.objectContaining({
        sectionId: 'files',
        status: 'error',
        error: '该主机暂不支持文件搜索'
      }),
      expect.objectContaining({
        sectionId: 'tasks',
        status: 'error',
        error: '该主机暂不支持任务搜索'
      })
    ])
  })

  it('stops every session owned by a destroyed window', async () => {
    const harness = createHarness()
    const started = await harness.service.start(7, { version: 1, cwd: '/repo' })
    await harness.service.update(7, {
      version: 1,
      sessionId: started.sessionId,
      query: 'needle'
    })
    await vi.waitFor(() => expect(harness.provider.createFuzzyFileSearchSession).toHaveBeenCalled())

    await harness.service.stopOwnedBy(7)

    expect(harness.fileSession.stop).toHaveBeenCalledOnce()
    await expect(
      harness.service.update(7, {
        version: 1,
        sessionId: started.sessionId,
        query: 'later'
      })
    ).rejects.toThrow('session not found')
  })

  it('does not create a projectless workspace just by opening search', async () => {
    const harness = createHarness()
    harness.projectStore.getState.mockResolvedValueOnce({
      workspaceRootOptions: [],
      localProjects: {},
      remoteProjects: [],
      projectOrder: [],
      pinnedProjectIds: [],
      projectWritableRoots: {},
      threadProjectAssignments: {},
      threadWritableRoots: {},
      threadWorkspaceRootHints: {},
      threadProjectlessOutputDirectories: {},
      projectlessThreadIds: [],
      projectlessHints: {},
      activeProjectSelection: { projectKind: 'projectless' }
    })

    const result = await harness.service.start(7, {
      version: 1,
      cwd: '/stale-project-root',
      projectSelection: { projectKind: 'projectless' }
    })

    expect(result).toMatchObject({ filesAvailable: false, tasksAvailable: true })
    expect(harness.projectService.resolveNewThreadTarget).not.toHaveBeenCalled()
    await harness.service.update(7, {
      version: 1,
      sessionId: result.sessionId,
      query: 'needle'
    })
    expect(harness.provider.createFuzzyFileSearchSession).not.toHaveBeenCalled()
  })
})
