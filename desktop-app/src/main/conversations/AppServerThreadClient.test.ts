import { describe, expect, it, vi } from 'vitest'

import type { ThreadItem } from '@janole/ai-sdk-provider-codex-asp'

import { AppServerThreadClient, type AppServerHistoryClientLike } from './AppServerThreadClient'

type HistoryThread = Awaited<ReturnType<AppServerHistoryClientLike['readThread']>>

function createHistoryClient(threads: HistoryThread[] = []): AppServerHistoryClientLike {
  return {
    listAllThreads: vi.fn(async () => threads),
    readThread: vi.fn(async (threadId: string) => {
      const thread = threads.find((candidate) => candidate.id === threadId)
      if (!thread) throw new Error(`unexpected thread ${threadId}`)
      return thread
    }),
    listTurns: vi.fn(async (threadId: string) => {
      const thread = threads.find((candidate) => candidate.id === threadId)
      if (!thread) throw new Error(`unexpected thread ${threadId}`)
      return { data: thread.turns, nextCursor: null, backwardsCursor: null }
    }),
    archiveThread: vi.fn(async () => undefined),
    unarchiveThread: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    renameThread: vi.fn(async () => undefined),
    forkThread: vi.fn(async () => {
      throw new Error('unexpected fork')
    }),
    rollbackThread: vi.fn(async () => {
      throw new Error('unexpected rollback')
    }),
    submitFeedback: vi.fn(async () => undefined)
  }
}

describe('AppServerThreadClient', () => {
  it('lists threads through the provider history client', async () => {
    const historyClient = createHistoryClient([
      historyThread({
        id: 'thread-1',
        name: 'Provider work',
        preview: 'Investigate provider',
        createdAt: 1782777600,
        updatedAt: 1782777900,
        status: { type: 'idle' },
        cwd: '/repo/app',
        threadSource: 'automation'
      })
    ])
    const client = new AppServerThreadClient({ historyClient })

    await expect(client.listThreads({ includeArchived: false })).resolves.toEqual([
      {
        id: 'thread-1',
        title: 'Provider work',
        preview: 'Investigate provider',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:05:00.000Z',
        archived: false,
        running: false,
        cwd: '/repo/app',
        threadSource: 'automation'
      }
    ])

    expect(historyClient.listAllThreads).toHaveBeenCalledWith({
      modelProviders: [],
      sortKey: 'updated_at',
      sortDirection: 'desc'
    })
  })

  it('falls back from empty names to previews and forwards archive filters', async () => {
    const historyClient = createHistoryClient([
      historyThread({
        id: 'thread-1',
        name: null,
        preview: 'First prompt',
        createdAt: 1782777600,
        updatedAt: 1782777800,
        status: { type: 'active' },
        cwd: '/repo/a'
      }),
      historyThread({
        id: 'thread-2',
        name: '',
        preview: '',
        createdAt: 1782777900,
        updatedAt: 1782777900,
        status: { type: 'idle' },
        cwd: null
      })
    ])
    const client = new AppServerThreadClient({ historyClient })

    await expect(
      client.listThreads({ includeArchived: true, sortKey: 'created_at' })
    ).resolves.toEqual([
      {
        id: 'thread-1',
        title: 'First prompt',
        preview: 'First prompt',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:03:20.000Z',
        archived: true,
        running: true,
        cwd: '/repo/a'
      },
      {
        id: 'thread-2',
        title: null,
        preview: '',
        createdAt: '2026-06-30T00:05:00.000Z',
        updatedAt: '2026-06-30T00:05:00.000Z',
        archived: true,
        running: false,
        cwd: null
      }
    ])

    expect(historyClient.listAllThreads).toHaveBeenCalledWith({
      modelProviders: [],
      sortKey: 'created_at',
      sortDirection: 'desc',
      archived: true
    })
  })

  it('hydrates read threads from full turn pages for provider-generated UI messages', async () => {
    const commandItem = {
      id: 'cmd_1',
      type: 'commandExecution',
      pluginId: null,
      scriptPath: null,
      command: 'npm test',
      cwd: '/repo/app',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'ok',
      exitCode: 0,
      durationMs: 1200
    } satisfies Extract<ThreadItem, { type: 'commandExecution' }>
    const fileChangeItem = {
      id: 'file_1',
      type: 'fileChange',
      status: 'completed',
      changes: [
        {
          path: 'src/history.ts',
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1 @@\n-before\n+after\n'
        }
      ]
    } satisfies Extract<ThreadItem, { type: 'fileChange' }>
    const historyClient = createHistoryClient([
      historyThread({
        id: 'thread-1',
        name: 'History',
        preview: 'Run tests',
        cwd: '/repo/app',
        turns: [
          {
            id: 'turn_1',
            items: [
              {
                id: 'user_1',
                type: 'userMessage',
                clientId: 'client_1',
                content: [{ type: 'text', text: 'Run tests', text_elements: [] }]
              },
              commandItem,
              fileChangeItem
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
    ])
    const client = new AppServerThreadClient({ historyClient })

    await expect(client.readThreadWithFullTurns('thread-1')).resolves.toMatchObject({
      id: 'thread-1',
      title: 'History',
      turns: expect.any(Array),
      messages: [
        {
          id: 'client_1',
          role: 'user',
          parts: [{ type: 'text', text: 'Run tests', state: 'done' }]
        },
        {
          id: 'assistant:turn_1:cmd_1',
          role: 'assistant',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'codex_command_execution',
              toolCallId: 'cmd_1',
              input: { command: 'npm test', cwd: '/repo/app' },
              state: 'output-available',
              providerExecuted: true
            },
            {
              type: 'dynamic-tool',
              toolName: 'codex_file_change',
              toolCallId: 'file_1',
              input: { changes: fileChangeItem.changes, status: 'completed' },
              output: { item: fileChangeItem },
              state: 'output-available',
              providerExecuted: true
            },
            {
              type: 'dynamic-tool',
              toolName: 'codex_turn_diff',
              toolCallId: 'turn-diff:turn_1',
              input: { turnId: 'turn_1' },
              output: {
                item: {
                  type: 'turnDiff',
                  status: 'completed',
                  cwd: '/repo/app',
                  diff: [
                    'diff --git a/src/history.ts b/src/history.ts',
                    '--- a/src/history.ts',
                    '+++ b/src/history.ts',
                    '@@ -1 +1 @@',
                    '-before',
                    '+after',
                    ''
                  ].join('\n'),
                  truncated: false
                }
              },
              state: 'output-available',
              providerExecuted: true
            }
          ]
        }
      ]
    })
    expect(historyClient.readThread).toHaveBeenCalledWith('thread-1', { includeTurns: false })
    expect(historyClient.listTurns).toHaveBeenCalledWith('thread-1', {
      limit: 100,
      sortDirection: 'desc',
      itemsView: 'full'
    })
  })

  it('hydrates historical messages with the persisted final turn diff', async () => {
    const historyClient = createHistoryClient([
      historyThread({
        id: 'thread-1',
        cwd: '/repo',
        turns: [
          {
            id: 'turn-1',
            items: [
              {
                id: 'file-1',
                type: 'fileChange',
                status: 'completed',
                changes: [
                  {
                    path: 'restored.ts',
                    kind: { type: 'update', move_path: null },
                    diff: '@@ -1 +1 @@\n-original\n+temporary\n'
                  }
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
    ])
    const turnDiffStore = {
      readMany: vi.fn(async () => new Map([['turn-1', '']]))
    }
    const client = new AppServerThreadClient({ historyClient, turnDiffStore })

    const result = await client.readThreadWithFullTurns('thread-1')

    expect(turnDiffStore.readMany).toHaveBeenCalledWith('thread-1', ['turn-1'])
    expect(result.messages).toEqual([
      {
        id: 'assistant:turn-1:file-1',
        role: 'assistant',
        metadata: { codexSource: { turnId: 'turn-1' } },
        parts: [expect.objectContaining({ toolName: 'codex_file_change' })]
      }
    ])
  })

  it('forks a clone and rolls back only the clone after the selected turn', async () => {
    const turns = ['turn-1', 'turn-2', 'turn-3'].map((id) => ({
      id,
      items: [],
      itemsView: 'full' as const,
      status: 'completed' as const,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null
    }))
    const historyClient = createHistoryClient([historyThread({ id: 'source', turns })])
    const forked = historyThread({ id: 'forked', turns })
    const rolledBack = historyThread({ id: 'forked', turns: turns.slice(0, 2) })
    vi.mocked(historyClient.forkThread).mockResolvedValue(forked)
    vi.mocked(historyClient.rollbackThread).mockResolvedValue(rolledBack)
    const client = new AppServerThreadClient({ historyClient })

    await expect(
      client.forkThread({
        threadId: 'source',
        targetTurnId: 'turn-2',
        ephemeral: false
      })
    ).resolves.toMatchObject({
      id: 'forked',
      turns: [{ id: 'turn-1' }, { id: 'turn-2' }]
    })

    expect(historyClient.forkThread).toHaveBeenCalledWith('source', {
      ephemeral: false,
      cwd: undefined,
      runtimeWorkspaceRoots: undefined
    })
    expect(historyClient.rollbackThread).toHaveBeenCalledWith('forked', 1)
  })

  it('rejects turn pages that are not full item views', async () => {
    const historyClient = createHistoryClient([historyThread({ id: 'thread-1' })])
    vi.mocked(historyClient.listTurns).mockResolvedValue({
      data: [
        {
          id: 'turn_1',
          items: [],
          itemsView: 'summary',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ],
      nextCursor: null,
      backwardsCursor: null
    })
    const client = new AppServerThreadClient({ historyClient })

    await expect(client.readThreadWithFullTurns('thread-1')).rejects.toThrow(
      'expected full turn items'
    )
  })

  it('forwards archive, unarchive, delete, rename, and read requests', async () => {
    const historyClient = createHistoryClient([historyThread({ id: 'thread-1', name: 'Renamed' })])
    const client = new AppServerThreadClient({ historyClient })

    await client.archiveThread('thread-1')
    await client.unarchiveThread('thread-1')
    await client.deleteThread('thread-1')
    await client.renameThread('thread-1', 'Renamed')
    await client.readThread('thread-1')

    expect(historyClient.archiveThread).toHaveBeenCalledWith('thread-1')
    expect(historyClient.unarchiveThread).toHaveBeenCalledWith('thread-1')
    expect(historyClient.deleteThread).toHaveBeenCalledWith('thread-1')
    expect(historyClient.renameThread).toHaveBeenCalledWith('thread-1', 'Renamed')
    expect(historyClient.readThread).toHaveBeenCalledWith('thread-1', { includeTurns: false })
  })

  it('forwards inline feedback through the provider history client', async () => {
    const historyClient = createHistoryClient([historyThread({ id: 'thread-1' })])
    const client = new AppServerThreadClient({ historyClient })

    await client.submitFeedback('thread-1', 'negative', 'turn-1')

    expect(historyClient.submitFeedback).toHaveBeenCalledWith('thread-1', 'negative', 'turn-1')
  })
})

function historyThread(overrides: Partial<HistoryThread> = {}): HistoryThread {
  return {
    id: 'thread',
    name: null,
    preview: 'Prompt',
    createdAt: 1782777600,
    updatedAt: 1782777900,
    status: { type: 'idle' },
    cwd: '/repo',
    turns: [],
    ...overrides
  }
}
