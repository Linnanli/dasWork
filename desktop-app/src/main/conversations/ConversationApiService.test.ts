import { describe, expect, it, vi } from 'vitest'

import { ConversationApiService, type ConversationThreadClientLike } from './ConversationApiService'
import type { AppServerThreadRow } from './AppServerThreadClient'
import type { ProjectState } from '../../shared/projects/projectTypes'

const baseProjectState: ProjectState = {
  workspaceRootOptions: [],
  localProjects: {
    local: {
      id: 'local',
      kind: 'local',
      name: 'Desktop App',
      hostId: 'local',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      writableRoots: ['/repo/desktop-app'],
      defaultCwd: '/repo/desktop-app'
    }
  },
  remoteProjects: [],
  projectOrder: ['local'],
  pinnedProjectIds: [],
  projectWritableRoots: { local: ['/repo/desktop-app'] },
  threadProjectAssignments: {
    'thread-local': { projectKind: 'local', projectId: 'local', cwd: '/repo/desktop-app' },
    'thread-path': {
      projectKind: 'local',
      projectId: 'path:/repo/cli',
      path: '/repo/cli',
      cwd: '/repo/cli'
    },
    'thread-quick': {
      projectKind: 'projectless',
      cwd: '/tmp/dascowork/thread-quick',
      workspaceRoot: '/tmp/dascowork/thread-quick',
      outputDirectory: '/tmp/dascowork/thread-quick/out'
    }
  },
  threadWritableRoots: {},
  threadWorkspaceRootHints: { 'thread-path': ['/repo/cli'] },
  threadProjectlessOutputDirectories: { 'thread-quick': '/tmp/dascowork/thread-quick' },
  projectlessThreadIds: ['thread-quick'],
  projectlessHints: {
    'thread-quick': { workspaceRoot: null, outputDirectory: '/tmp/dascowork/thread-quick' }
  }
}

function createClient(): ConversationThreadClientLike {
  return {
    listThreads: vi.fn(async ({ includeArchived }) =>
      includeArchived
        ? []
        : [
            {
              id: 'thread-local',
              title: 'Local project thread',
              preview: 'Local project thread',
              createdAt: '2026-06-30T01:00:00.000Z',
              updatedAt: '2026-06-30T01:05:00.000Z',
              archived: false,
              running: false,
              cwd: '/repo/desktop-app'
            },
            {
              id: 'thread-path',
              title: 'Path workspace thread',
              preview: 'Path workspace thread',
              createdAt: '2026-06-30T02:00:00.000Z',
              updatedAt: '2026-06-30T02:05:00.000Z',
              archived: false,
              running: true,
              cwd: '/repo/cli'
            },
            {
              id: 'thread-quick',
              title: null,
              preview: 'Scratch prompt',
              createdAt: '2026-06-30T03:00:00.000Z',
              updatedAt: '2026-06-30T03:05:00.000Z',
              archived: false,
              running: false,
              cwd: '/tmp/dascowork/thread-quick'
            }
          ]
    ),
    readThread: vi.fn(),
    readThreadWithFullTurns: vi.fn(),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => undefined),
    submitFeedback: vi.fn(async () => undefined)
  }
}

describe('ConversationApiService', () => {
  it('preserves the automation thread source for sidebar rendering', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([
      {
        id: 'automation-thread',
        title: 'Daily status',
        preview: 'Daily status',
        createdAt: '2026-06-30T01:00:00.000Z',
        updatedAt: '2026-06-30T01:05:00.000Z',
        archived: false,
        running: false,
        cwd: '/repo/desktop-app',
        threadSource: 'automation'
      }
    ])
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    const snapshot = await service.getConversationList()

    expect(snapshot.conversations).toEqual([
      expect.objectContaining({ id: 'automation-thread', threadSource: 'automation' })
    ])
  })

  it('forwards inline feedback to the persisted task', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await service.submitConversationFeedback({
      conversationId: 'thread-local',
      classification: 'positive',
      targetTurnId: 'turn-local'
    })

    expect(threadClient.submitFeedback).toHaveBeenCalledWith(
      'thread-local',
      'positive',
      'turn-local'
    )
  })

  it('deduplicates the initial load and then serves the snapshot without another list request', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    expect(service.getConversationSnapshot().loaded).toBe(false)
    const first = service.ensureConversationListLoaded()
    const second = service.ensureConversationListLoaded()
    const sidebarLoad = service.getConversationList()

    expect(first).toBe(second)
    await Promise.all([first, second, sidebarLoad])
    expect(service.getConversationSnapshot().loaded).toBe(true)
    await service.ensureConversationListLoaded()
    expect(threadClient.listThreads).toHaveBeenCalledTimes(2)
  })

  it('reprojects the loaded snapshot for project-state changes without listing threads again', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })
    await service.refreshConversationList()
    vi.mocked(threadClient.listThreads).mockClear()

    const state = service.applyProjectState({
      ...baseProjectState,
      threadProjectAssignments: {
        ...baseProjectState.threadProjectAssignments,
        'thread-local': {
          projectKind: 'projectless',
          cwd: null,
          workspaceRoot: null,
          outputDirectory: null
        }
      }
    })

    expect(state.conversations.find(({ id }) => id === 'thread-local')?.projectAssignment).toEqual({
      projectKind: 'projectless',
      cwd: null,
      workspaceRoot: null,
      outputDirectory: null
    })
    expect(threadClient.listThreads).not.toHaveBeenCalled()
  })

  it('joins app-server thread rows with project assignments', async () => {
    const service = new ConversationApiService({
      threadClient: createClient(),
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(service.getConversationList()).resolves.toMatchObject({
      loaded: true,
      error: undefined,
      archivedConversationIds: [],
      conversations: [
        {
          id: 'thread-local',
          threadId: 'thread-local',
          title: 'Local project thread',
          projectAssignment: { projectKind: 'local', projectId: 'local' },
          cwd: '/repo/desktop-app'
        },
        {
          id: 'thread-path',
          threadId: 'thread-path',
          title: 'Path workspace thread',
          projectAssignment: {
            projectKind: 'local',
            projectId: 'path:/repo/cli',
            path: '/repo/cli'
          },
          running: true
        },
        {
          id: 'thread-quick',
          threadId: 'thread-quick',
          title: null,
          projectAssignment: { projectKind: 'projectless' },
          cwd: '/tmp/dascowork/thread-quick'
        }
      ]
    })
  })

  it('keeps archived threads in the sidebar state so they can be restored', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockImplementation(async ({ includeArchived }) =>
      includeArchived
        ? [
            {
              id: 'thread-archived',
              title: 'Archived thread',
              preview: 'Archived thread',
              createdAt: '2026-06-30T01:00:00.000Z',
              updatedAt: '2026-06-30T01:05:00.000Z',
              archived: true,
              running: false,
              cwd: '/repo/desktop-app'
            }
          ]
        : []
    )
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(service.getConversationList()).resolves.toMatchObject({
      archivedConversationIds: ['thread-archived'],
      conversations: [{ id: 'thread-archived', archived: true }]
    })
    expect(threadClient.listThreads).toHaveBeenCalledWith({
      includeArchived: true,
      sortKey: 'updated_at'
    })
  })

  it('keeps the active sidebar usable when archived thread queries are unsupported', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockImplementation(async ({ includeArchived }) => {
      if (includeArchived) throw new Error('archived threads are unsupported')
      return [
        {
          id: 'thread-active',
          title: 'Active thread',
          preview: 'Active thread',
          createdAt: '2026-06-30T01:00:00.000Z',
          updatedAt: '2026-06-30T01:05:00.000Z',
          archived: false,
          running: false,
          cwd: '/repo/desktop-app'
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(service.getConversationList()).resolves.toMatchObject({
      archivedConversationIds: [],
      conversations: [{ id: 'thread-active', archived: false }]
    })
  })

  it('refreshes after archive, unarchive, and rename actions', async () => {
    const threadClient = createClient()
    const onConversationArchived = vi.fn()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState },
      onConversationArchived
    })

    await service.archiveConversation({ conversationId: 'thread-local' })
    await service.unarchiveConversation({ conversationId: 'thread-local' })
    await service.renameConversation({ conversationId: 'thread-local', title: 'New name' })

    expect(threadClient.archiveThread).toHaveBeenCalledWith('thread-local')
    expect(onConversationArchived).toHaveBeenCalledWith('thread-local')
    expect(threadClient.unarchiveThread).toHaveBeenCalledWith('thread-local')
    expect(threadClient.renameThread).toHaveBeenCalledWith('thread-local', 'New name')
    expect(threadClient.listThreads).toHaveBeenCalledTimes(6)
  })

  it('permanently deletes only an archived task and clears its local task metadata', async () => {
    const threadClient = createClient()
    let deleted = false
    let projectState = structuredClone(baseProjectState)
    const setProjectState = vi.fn(async (nextState: ProjectState) => {
      projectState = nextState
    })
    vi.mocked(threadClient.listThreads).mockImplementation(async ({ includeArchived }) => {
      if (!includeArchived || deleted) return []
      return [
        {
          id: 'thread-quick',
          title: 'Scratch prompt',
          preview: 'Scratch prompt',
          createdAt: '2026-06-30T03:00:00.000Z',
          updatedAt: '2026-06-30T03:05:00.000Z',
          archived: true,
          running: false,
          cwd: '/tmp/dascowork/thread-quick'
        }
      ]
    })
    if (!threadClient.deleteThread) throw new Error('expected delete thread client')
    vi.mocked(threadClient.deleteThread).mockImplementation(async () => {
      deleted = true
    })
    const onConversationDeleted = vi.fn()
    const service = new ConversationApiService({
      threadClient,
      projectStore: {
        getState: async () => projectState,
        setState: setProjectState
      },
      onConversationDeleted
    })

    await expect(
      service.deleteConversation({ conversationId: 'thread-quick' })
    ).resolves.toMatchObject({
      conversations: [],
      archivedConversationIds: []
    })

    expect(threadClient.deleteThread).toHaveBeenCalledWith('thread-quick')
    expect(onConversationDeleted).toHaveBeenCalledWith('thread-quick')
    expect(setProjectState).toHaveBeenCalledOnce()
    expect(projectState.threadProjectAssignments['thread-quick']).toBeUndefined()
    expect(projectState.threadProjectlessOutputDirectories['thread-quick']).toBeUndefined()
    expect(projectState.projectlessThreadIds).not.toContain('thread-quick')
  })

  it('preflights and permanently deletes an archived project group', async () => {
    const threadClient = createClient()
    const deletedConversationIds = new Set<string>()
    vi.mocked(threadClient.listThreads).mockImplementation(async ({ includeArchived }) => {
      if (!includeArchived) return []
      return ['thread-archive-a', 'thread-archive-b']
        .filter((conversationId) => !deletedConversationIds.has(conversationId))
        .map((id) => ({
          id,
          title: id,
          preview: id,
          createdAt: '2026-06-30T03:00:00.000Z',
          updatedAt: '2026-06-30T03:05:00.000Z',
          archived: true,
          running: false,
          cwd: '/repo'
        }))
    })
    if (!threadClient.deleteThread) throw new Error('expected delete thread client')
    vi.mocked(threadClient.deleteThread).mockImplementation(async (conversationId) => {
      deletedConversationIds.add(conversationId)
    })
    const onConversationDeleted = vi.fn()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => structuredClone(baseProjectState) },
      onConversationDeleted
    })

    await expect(
      service.deleteArchivedConversations({
        conversationIds: ['thread-archive-a', 'thread-archive-b']
      })
    ).resolves.toMatchObject({ conversations: [], archivedConversationIds: [] })

    expect(threadClient.deleteThread).toHaveBeenNthCalledWith(1, 'thread-archive-a')
    expect(threadClient.deleteThread).toHaveBeenNthCalledWith(2, 'thread-archive-b')
    expect(onConversationDeleted).toHaveBeenNthCalledWith(1, 'thread-archive-a')
    expect(onConversationDeleted).toHaveBeenNthCalledWith(2, 'thread-archive-b')
  })

  it('does not partially delete a project group when one task is no longer archived', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockImplementation(async ({ includeArchived }) => {
      if (!includeArchived) return []
      return [
        {
          id: 'thread-archive-a',
          title: 'Archived',
          preview: 'Archived',
          createdAt: '2026-06-30T03:00:00.000Z',
          updatedAt: '2026-06-30T03:05:00.000Z',
          archived: true,
          running: false,
          cwd: '/repo'
        },
        {
          id: 'thread-running',
          title: 'Running',
          preview: 'Running',
          createdAt: '2026-06-30T03:00:00.000Z',
          updatedAt: '2026-06-30T03:05:00.000Z',
          archived: false,
          running: true,
          cwd: '/repo'
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(
      service.deleteArchivedConversations({
        conversationIds: ['thread-archive-a', 'thread-running']
      })
    ).rejects.toThrow('只能永久删除已归档任务。')

    expect(threadClient.deleteThread).not.toHaveBeenCalled()
  })

  it('refuses to permanently delete a task that is not archived', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(service.deleteConversation({ conversationId: 'thread-local' })).rejects.toThrow(
      '只能永久删除已归档任务'
    )
    expect(threadClient.deleteThread).not.toHaveBeenCalled()
  })

  it('ensures a just-finished app-server thread is visible when thread/list lags', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-fresh',
      title: null,
      preview: '',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      turns: [
        {
          id: 'turn-fresh',
          items: [
            {
              id: 'user-fresh',
              type: 'userMessage',
              clientId: null,
              content: [{ type: 'text', text: 'Fresh sidebar prompt', text_elements: [] }]
            }
          ],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(
      service.refreshConversationList({ ensureThreadIds: ['thread-fresh'] })
    ).resolves.toMatchObject({
      loaded: true,
      conversations: [
        {
          id: 'thread-fresh',
          threadId: 'thread-fresh',
          title: 'Fresh sidebar prompt',
          cwd: '/repo/desktop-app'
        }
      ]
    })
    expect(threadClient.readThreadWithFullTurns).toHaveBeenCalledWith('thread-fresh')
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('publishes an observed started thread without waiting for thread/list', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: {
        getState: async () => ({
          ...baseProjectState,
          threadProjectAssignments: {
            ...baseProjectState.threadProjectAssignments,
            'thread-prestarted': {
              projectKind: 'local',
              projectId: 'local',
              cwd: '/repo/desktop-app'
            }
          }
        })
      }
    })

    await expect(
      service.observeStartedThread({
        threadId: 'thread-prestarted',
        title: '你好,你是什么模型?',
        cwd: '/repo/desktop-app',
        createdAt: '2026-06-30T04:00:00.000Z',
        updatedAt: '2026-06-30T04:00:00.000Z'
      })
    ).resolves.toMatchObject({
      loaded: true,
      error: undefined,
      conversations: [
        {
          id: 'thread-prestarted',
          threadId: 'thread-prestarted',
          title: '你好,你是什么模型?',
          projectAssignment: { projectKind: 'local', projectId: 'local' },
          cwd: '/repo/desktop-app',
          running: true
        }
      ]
    })
    expect(threadClient.listThreads).not.toHaveBeenCalled()
    expect(threadClient.readThreadWithFullTurns).not.toHaveBeenCalled()
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('publishes an immediate observed started snapshot without reading stores', () => {
    const threadClient = createClient()
    const projectStore = { getState: vi.fn(async () => baseProjectState) }
    const service = new ConversationApiService({
      threadClient,
      projectStore
    })

    expect(
      service.observeStartedThreadSnapshot({
        threadId: 'thread-prestarted',
        originConversationId: 'local-chat-1',
        title: '你好,你是什么模型?',
        cwd: '/repo/desktop-app',
        createdAt: '2026-06-30T04:00:00.000Z',
        updatedAt: '2026-06-30T04:00:00.000Z',
        projectAssignment: {
          projectKind: 'local',
          projectId: 'local',
          cwd: '/repo/desktop-app'
        }
      })
    ).toMatchObject({
      loaded: true,
      error: undefined,
      conversations: [
        {
          id: 'thread-prestarted',
          threadId: 'thread-prestarted',
          originConversationId: 'local-chat-1',
          title: '你好,你是什么模型?',
          cwd: '/repo/desktop-app',
          projectAssignment: { projectKind: 'local', projectId: 'local' },
          running: true
        }
      ]
    })
    expect(projectStore.getState).not.toHaveBeenCalled()
    expect(threadClient.listThreads).not.toHaveBeenCalled()
    expect(threadClient.readThreadWithFullTurns).not.toHaveBeenCalled()
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('publishes the origin once when the authoritative list arrives before the started snapshot', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([
      {
        id: 'thread-prestarted',
        title: 'Authoritative title',
        preview: 'Authoritative title',
        createdAt: '2026-06-30T04:00:00.000Z',
        updatedAt: '2026-06-30T04:00:00.000Z',
        archived: false,
        running: true,
        cwd: '/repo/desktop-app'
      }
    ])
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await service.refreshConversationList()

    expect(
      service.observeStartedThreadSnapshot({
        threadId: 'thread-prestarted',
        originConversationId: 'local-chat-1',
        projectAssignment: {
          projectKind: 'local',
          projectId: 'local',
          cwd: '/repo/desktop-app'
        }
      })
    ).toMatchObject({
      conversations: [
        {
          id: 'thread-prestarted',
          originConversationId: 'local-chat-1',
          projectAssignment: { projectKind: 'local', projectId: 'local' }
        }
      ]
    })

    const refreshedState = await service.refreshConversationList()
    expect(refreshedState.conversations[0]).not.toHaveProperty('originConversationId')
  })

  it('surfaces an observed started thread before thread/read history is available', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])
    vi.mocked(threadClient.readThreadWithFullTurns).mockRejectedValue(
      new Error('history not ready')
    )
    const service = new ConversationApiService({
      threadClient,
      projectStore: {
        getState: async () => ({
          ...baseProjectState,
          threadProjectAssignments: {
            ...baseProjectState.threadProjectAssignments,
            'thread-prestarted': {
              projectKind: 'local',
              projectId: 'local',
              cwd: '/repo/desktop-app'
            }
          }
        })
      }
    })

    await service.observeStartedThread({
      threadId: 'thread-prestarted',
      title: '你好,你是什么模型?',
      cwd: '/repo/desktop-app',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:00:00.000Z'
    })

    await expect(
      service.refreshConversationList({ ensureThreadIds: ['thread-prestarted'] })
    ).resolves.toMatchObject({
      loaded: true,
      error: undefined,
      conversations: [
        {
          id: 'thread-prestarted',
          threadId: 'thread-prestarted',
          title: '你好,你是什么模型?',
          projectAssignment: { projectKind: 'local', projectId: 'local' },
          cwd: '/repo/desktop-app',
          running: true
        }
      ]
    })
    expect(threadClient.readThreadWithFullTurns).toHaveBeenCalledWith('thread-prestarted')
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('reconciles an observed started thread with authoritative thread/read data', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-prestarted',
      title: null,
      preview: '',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      turns: [
        {
          id: 'turn-prestarted',
          items: [
            {
              id: 'user-prestarted',
              type: 'userMessage',
              clientId: null,
              content: [{ type: 'text', text: 'Authoritative prompt', text_elements: [] }]
            }
          ],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await service.observeStartedThread({
      threadId: 'thread-prestarted',
      title: 'Optimistic prompt',
      cwd: '/repo/desktop-app',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:00:00.000Z'
    })

    await expect(
      service.refreshConversationList({ ensureThreadIds: ['thread-prestarted'] })
    ).resolves.toMatchObject({
      loaded: true,
      error: undefined,
      conversations: [
        {
          id: 'thread-prestarted',
          threadId: 'thread-prestarted',
          title: 'Authoritative prompt',
          running: false,
          cwd: '/repo/desktop-app'
        }
      ]
    })
    expect(threadClient.readThreadWithFullTurns).toHaveBeenCalledWith('thread-prestarted')
  })

  it('can discard an unconfirmed observed started thread', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await service.observeStartedThread({
      threadId: 'thread-prestarted',
      title: 'Optimistic prompt',
      cwd: '/repo/desktop-app',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:00:00.000Z'
    })

    await expect(
      service.discardStartedThreadObservation('thread-prestarted')
    ).resolves.toMatchObject({
      loaded: true,
      error: undefined,
      conversations: []
    })
    expect(threadClient.listThreads).not.toHaveBeenCalled()
    expect(threadClient.readThreadWithFullTurns).not.toHaveBeenCalled()
  })

  it('uses provider user input formatting for skill and mention sidebar titles', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-skill',
      title: null,
      preview: '',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      turns: [
        {
          id: 'turn-skill',
          items: [
            {
              id: 'user-skill',
              type: 'userMessage',
              clientId: null,
              content: [
                { type: 'skill', name: 'review', path: '/repo/.codex/skills/review/SKILL.md' },
                { type: 'mention', name: 'thread-123', path: 'codex://thread/thread-123' }
              ]
            }
          ],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(
      service.refreshConversationList({ ensureThreadIds: ['thread-skill'] })
    ).resolves.toMatchObject({
      loaded: true,
      conversations: [
        {
          id: 'thread-skill',
          title: '$review\n@thread-123'
        }
      ]
    })
  })

  it('keeps getConversationList authoritative after an ensured sidebar broadcast', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-fresh',
      title: null,
      preview: '',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      turns: [
        {
          id: 'turn-fresh',
          items: [
            {
              id: 'user-fresh',
              type: 'userMessage',
              clientId: null,
              content: [{ type: 'text', text: 'Fresh sidebar prompt', text_elements: [] }]
            }
          ],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await service.refreshConversationList({ ensureThreadIds: ['thread-fresh'] })
    vi.mocked(threadClient.readThreadWithFullTurns).mockClear()

    const state = await service.getConversationList()
    expect(state.conversations).toEqual([])
    expect(threadClient.readThreadWithFullTurns).not.toHaveBeenCalled()
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('propagates thread/list failures during convergence checks', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockRejectedValueOnce(new Error('thread/list failed'))
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(service.hasThreadInList('thread-local')).rejects.toThrow('thread/list failed')
  })

  it('does not reinsert a stale row after archive when thread/read can still return it', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockImplementation(async ({ includeArchived }) =>
      includeArchived
        ? []
        : [
            {
              id: 'thread-local',
              title: 'Initial sidebar prompt',
              preview: 'Initial sidebar prompt',
              createdAt: '2026-06-30T04:00:00.000Z',
              updatedAt: '2026-06-30T04:05:00.000Z',
              archived: false,
              running: false,
              cwd: '/repo/desktop-app'
            }
          ]
    )
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-local',
      title: null,
      preview: '',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: true,
      running: false,
      cwd: '/repo/desktop-app',
      turns: [
        {
          id: 'turn-local',
          items: [
            {
              id: 'user-local',
              type: 'userMessage',
              clientId: null,
              content: [{ type: 'text', text: 'Reloaded sidebar prompt', text_elements: [] }]
            }
          ],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await service.refreshConversationList()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])

    await expect(service.archiveConversation({ conversationId: 'thread-local' })).resolves.toEqual({
      loaded: true,
      conversations: [],
      archivedConversationIds: [],
      error: undefined
    })
    expect(threadClient.archiveThread).toHaveBeenCalledWith('thread-local')
    expect(threadClient.readThreadWithFullTurns).not.toHaveBeenCalled()
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('opens historical conversations with provider-rendered tool parts intact', async () => {
    const threadClient = createClient()
    const messages: NonNullable<AppServerThreadRow['messages']> = [
      {
        id: 'turn-1:assistant',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'codex_sub_agent_activity',
            toolCallId: 'subagent-1',
            state: 'output-available',
            input: {
              kind: 'started',
              agentThreadId: 'agent-thread',
              agentPath: '/repo/desktop-app'
            },
            output: { item: { id: 'subagent-1', type: 'subAgentActivity' } },
            providerExecuted: true
          }
        ]
      }
    ]
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-local',
      title: 'History with tools',
      preview: 'History with tools',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      messages
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(
      service.openConversation({ conversationId: 'thread-local' })
    ).resolves.toMatchObject({
      conversationId: 'thread-local',
      threadId: 'thread-local',
      title: 'History with tools',
      historyRevision: '2026-06-30T04:05:00.000Z',
      messages
    })
    expect(threadClient.readThreadWithFullTurns).toHaveBeenCalledWith('thread-local')
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('returns local history images as app media URLs without embedding file bytes', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-local',
      title: 'History with image',
      preview: 'History with image',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      messages: [
        {
          id: 'user-image',
          role: 'user',
          parts: [
            {
              type: 'file',
              mediaType: 'image/png',
              url: 'file:///tmp/codex-clipboard.png'
            }
          ]
        }
      ]
    })
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    const opened = await service.openConversation({ conversationId: 'thread-local' })

    expect(opened.messages[0]!.parts[0]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      url: 'app://fs/@fs/tmp/codex-clipboard.png'
    })
    expect(JSON.stringify(opened.messages)).not.toContain('file:')
    expect(JSON.stringify(opened.messages)).not.toContain('base64')
  })

  it('reads history immediately while a renderer can reattach to the live turn', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-local',
      title: 'Completed after reconnect',
      preview: 'Completed after reconnect',
      createdAt: '2026-06-30T04:00:00.000Z',
      updatedAt: '2026-06-30T04:05:00.000Z',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      messages: []
    })
    const waitForConversationSettlement = vi.fn(() => Promise.resolve())
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState },
      waitForConversationSettlement
    })

    const opened = await service.openConversation({ conversationId: 'thread-local' })

    expect(waitForConversationSettlement).not.toHaveBeenCalled()
    expect(threadClient.readThreadWithFullTurns).toHaveBeenCalledWith('thread-local')
    expect(opened.title).toBe('Completed after reconnect')
  })

  it('uses only the full app-server history when opening a settled conversation', async () => {
    const threadClient = createClient()
    const appServerThread: AppServerThreadRow = {
      id: 'thread-local',
      title: 'App-server history',
      preview: 'App-server history',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      messages: [
        {
          id: 'app-server-message',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Returned by app-server.' }]
        }
      ]
    }
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue(appServerThread)
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(
      service.openConversation({ conversationId: 'thread-local' })
    ).resolves.toMatchObject({
      messages: appServerThread.messages
    })
  })

  it('keeps normal conversation hydration available when Goals are disabled', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.readThreadWithFullTurns).mockResolvedValue({
      id: 'thread-local',
      title: 'Goal capability',
      preview: 'Goal capability',
      archived: false,
      running: false,
      cwd: '/repo/desktop-app',
      messages: []
    })
    threadClient.listExperimentalFeatures = vi.fn(async () => [{ name: 'goals', enabled: false }])
    threadClient.getThreadGoal = vi.fn()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    await expect(
      service.openConversation({ conversationId: 'thread-local' })
    ).resolves.toMatchObject({
      threadGoalResult: { status: 'unsupported', message: '当前 Codex 服务未启用任务目标' },
      messages: []
    })
    expect(threadClient.getThreadGoal).not.toHaveBeenCalled()
  })

  it('does not preserve missing known threads without an explicit ensure request', async () => {
    const threadClient = createClient()
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    // First refresh populates lastState with thread-local
    await service.refreshConversationList()

    // Second refresh: thread/list is authoritative unless a caller explicitly awaits a thread.
    vi.mocked(threadClient.listThreads).mockResolvedValue([])

    const state = await service.refreshConversationList()
    expect(state.conversations).toEqual([])
    expect(threadClient.readThreadWithFullTurns).not.toHaveBeenCalled()
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('surfaces read failures for explicitly ensured threads', async () => {
    const threadClient = createClient()
    vi.mocked(threadClient.listThreads).mockResolvedValue([])
    vi.mocked(threadClient.readThreadWithFullTurns).mockRejectedValue(
      new Error('thread read failed')
    )
    const service = new ConversationApiService({
      threadClient,
      projectStore: { getState: async () => baseProjectState }
    })

    const state = await service.refreshConversationList({ ensureThreadIds: ['thread-fresh'] })
    expect(state.conversations).toEqual([])
    expect(state.loaded).toBe(false)
    expect(state.error).toBe('thread read failed')
    expect(threadClient.readThreadWithFullTurns).toHaveBeenCalledWith('thread-fresh')
    expect(threadClient.readThread).not.toHaveBeenCalled()
  })

  it('merges sidebar preferences with defaults', async () => {
    const service = new ConversationApiService({
      threadClient: createClient(),
      projectStore: { getState: async () => baseProjectState }
    })

    expect(
      await service.setPreferences({
        organizeMode: 'chronological',
        collapsedGroupIds: ['local:local']
      })
    ).toEqual({
      organizeMode: 'chronological',
      sortKey: 'updated_at',
      collapsedSectionIds: [],
      collapsedGroupIds: ['local:local'],
      pinnedConversationIds: []
    })
  })
})
