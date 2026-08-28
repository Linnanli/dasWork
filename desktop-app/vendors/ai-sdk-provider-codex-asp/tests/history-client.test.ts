import { describe, expect, it, vi } from 'vitest'

import { type CodexHistoryJsonRpcClientLike, createCodexHistoryClient } from '../src'
import type { Thread } from '../src/protocol/app-server-protocol/v2/Thread'
import type { ThreadGoal } from '../src/protocol/types'

type RequestRecord = { method: string; params?: unknown }
type MockHistoryJsonRpcClient = CodexHistoryJsonRpcClientLike & {
  requests: RequestRecord[]
  connectMock: ReturnType<typeof vi.fn>
  disconnectMock: ReturnType<typeof vi.fn>
  notificationMock: ReturnType<typeof vi.fn>
}

function createMockClient(responses: unknown[]): MockHistoryJsonRpcClient {
  const queue = [...responses]
  const requests: RequestRecord[] = []
  const connectMock = vi.fn(() => Promise.resolve())
  const disconnectMock = vi.fn(() => Promise.resolve())
  const notificationMock = vi.fn(() => Promise.resolve())

  return {
    requests,
    connectMock,
    disconnectMock,
    notificationMock,
    connect: connectMock,
    disconnect: disconnectMock,
    notification: notificationMock,
    request: vi.fn((method: string, params?: unknown) => {
      requests.push({ method, params })
      if (method === 'initialize') {
        return Promise.resolve({})
      }

      if (queue.length === 0) {
        return Promise.reject(new Error(`unexpected method ${method}`))
      }
      return Promise.resolve(queue.shift())
    }) as CodexHistoryJsonRpcClientLike['request']
  }
}

describe('CodexHistoryClient', () => {
  it('lists all thread pages with default thread/list params', async () => {
    const first = thread({ id: 'thread_1' })
    const second = thread({ id: 'thread_2' })
    const mock = createMockClient([
      { data: [first], nextCursor: 'cursor_1' },
      { data: [second], nextCursor: null }
    ])
    const client = createCodexHistoryClient({
      clientInfo: { name: 'test', version: '1.0.0' },
      createClient: () => mock
    })

    await expect(client.listAllThreads({ archived: true })).resolves.toEqual([first, second])

    expect(mock.connectMock).toHaveBeenCalledTimes(1)
    expect(mock.disconnectMock).toHaveBeenCalledTimes(1)
    expect(mock.notificationMock).toHaveBeenCalledWith('initialized')
    expect(mock.requests).toEqual([
      {
        method: 'initialize',
        params: {
          clientInfo: { name: 'test', version: '1.0.0' },
          capabilities: { experimentalApi: true }
        }
      },
      {
        method: 'thread/list',
        params: {
          limit: 100,
          modelProviders: [],
          sortKey: 'updated_at',
          sortDirection: 'desc',
          archived: true
        }
      },
      {
        method: 'thread/list',
        params: {
          cursor: 'cursor_1',
          limit: 100,
          modelProviders: [],
          sortKey: 'updated_at',
          sortDirection: 'desc',
          archived: true
        }
      }
    ])
  })

  it('disconnects the logical client when connecting fails', async () => {
    const mock = createMockClient([])
    mock.connectMock.mockRejectedValueOnce(new Error('connection failed'))
    const client = createCodexHistoryClient({ createClient: () => mock })

    await expect(client.listThreads()).rejects.toThrow('connection failed')

    expect(mock.disconnectMock).toHaveBeenCalledTimes(1)
  })

  it('reads threads and lists full turn items by default', async () => {
    const item = thread({ id: 'thread_1' })
    const mock = createMockClient([
      { thread: item },
      {
        data: [
          {
            id: 'turn_1',
            items: [],
            itemsView: 'full',
            status: 'completed',
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null
          }
        ],
        nextCursor: null
      }
    ])
    const client = createCodexHistoryClient({ createClient: () => mock })

    await expect(client.readThread('thread_1', { includeTurns: true })).resolves.toBe(item)
    await expect(client.listTurns('thread_1')).resolves.toEqual({
      data: [
        {
          id: 'turn_1',
          items: [],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        }
      ],
      nextCursor: null
    })

    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/read', params: { threadId: 'thread_1', includeTurns: true } },
      expect.objectContaining({ method: 'initialize' }),
      {
        method: 'thread/turns/list',
        params: {
          threadId: 'thread_1',
          limit: 100,
          sortDirection: 'desc',
          itemsView: 'full'
        }
      }
    ])
  })

  it('reads an MCP resource through the fixed app-server request', async () => {
    const response = {
      contents: [
        {
          uri: 'ui://calendar/app.html',
          mimeType: 'text/html;profile=mcp-app',
          text: '<main>Calendar</main>'
        }
      ]
    }
    const mock = createMockClient([response])
    const client = createCodexHistoryClient({ createClient: () => mock })

    await expect(
      client.readMcpResource({
        threadId: 'thread_1',
        server: 'calendar',
        uri: 'ui://calendar/app.html'
      })
    ).resolves.toEqual(response)

    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      {
        method: 'mcpServer/resource/read',
        params: {
          threadId: 'thread_1',
          server: 'calendar',
          uri: 'ui://calendar/app.html'
        }
      }
    ])
  })

  it('forwards thread mutations, fork, rollback, and metadata-only feedback through app-server methods', async () => {
    const forked = thread({ id: 'thread_fork' })
    const rolledBack = thread({ id: 'thread_fork' })
    const mock = createMockClient([{}, {}, {}, {}, { thread: forked }, { thread: rolledBack }, {}])
    const client = createCodexHistoryClient({ createClient: () => mock })

    await client.renameThread('thread_1', 'Renamed')
    await client.archiveThread('thread_1')
    await client.unarchiveThread('thread_1')
    await client.deleteThread('thread_1')
    await expect(
      client.forkThread('thread_1', {
        ephemeral: true,
        cwd: '/repo/branch',
        runtimeWorkspaceRoots: ['/repo/branch']
      })
    ).resolves.toBe(forked)
    await expect(client.rollbackThread('thread_fork', 2)).resolves.toBe(rolledBack)
    await client.submitFeedback('thread_1', 'positive', 'turn_1')

    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/name/set', params: { threadId: 'thread_1', name: 'Renamed' } },
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/archive', params: { threadId: 'thread_1' } },
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/unarchive', params: { threadId: 'thread_1' } },
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/delete', params: { threadId: 'thread_1' } },
      expect.objectContaining({ method: 'initialize' }),
      {
        method: 'thread/fork',
        params: {
          threadId: 'thread_1',
          ephemeral: true,
          cwd: '/repo/branch',
          runtimeWorkspaceRoots: ['/repo/branch']
        }
      },
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/rollback', params: { threadId: 'thread_fork', numTurns: 2 } },
      expect.objectContaining({ method: 'initialize' }),
      {
        method: 'feedback/upload',
        params: {
          classification: 'positive',
          threadId: 'thread_1',
          includeLogs: false,
          tags: {
            surface: 'dascowork-assistant-message',
            target_turn_id: 'turn_1'
          }
        }
      }
    ])
  })

  it('lists collaboration mode presets through app-server', async () => {
    const modes = [
      {
        name: 'Plan',
        mode: 'plan',
        model: 'gpt-5.5',
        reasoning_effort: 'medium'
      },
      {
        name: 'Default',
        mode: 'default',
        model: null,
        reasoning_effort: null
      }
    ]
    const mock = createMockClient([{ data: modes }])
    const client = createCodexHistoryClient({ createClient: () => mock })

    await expect(client.listCollaborationModes()).resolves.toEqual(modes)

    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'collaborationMode/list', params: {} }
    ])
  })

  it('lists every experimental feature page through app-server', async () => {
    const mock = createMockClient([
      { data: [{ name: 'goals', enabled: true }], nextCursor: 'next' },
      { data: [{ name: 'other', enabled: false }], nextCursor: null }
    ])
    const client = createCodexHistoryClient({ createClient: () => mock })

    await expect(client.listExperimentalFeatures()).resolves.toEqual([
      { name: 'goals', enabled: true },
      { name: 'other', enabled: false }
    ])
    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'experimentalFeature/list', params: { limit: 100 } },
      { method: 'experimentalFeature/list', params: { cursor: 'next', limit: 100 } }
    ])
  })

  it('gets, sets, and clears thread goals through app-server', async () => {
    const currentGoal = goal({ status: 'active', objective: 'Ship Plan mode' })
    const updatedGoal = goal({
      objective: 'Ship Plan mode with tests',
      status: 'paused',
      tokenBudget: 10_000
    })
    const mock = createMockClient([{ goal: currentGoal }, { goal: updatedGoal }, { cleared: true }])
    const client = createCodexHistoryClient({ createClient: () => mock })

    await expect(client.getThreadGoal('thread_1')).resolves.toBe(currentGoal)
    await expect(
      client.setThreadGoal('thread_1', {
        objective: 'Ship Plan mode with tests',
        status: 'paused',
        tokenBudget: 10_000
      })
    ).resolves.toBe(updatedGoal)
    await expect(client.clearThreadGoal('thread_1')).resolves.toBe(true)

    expect(mock.requests).toEqual([
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/goal/get', params: { threadId: 'thread_1' } },
      expect.objectContaining({ method: 'initialize' }),
      {
        method: 'thread/goal/set',
        params: {
          threadId: 'thread_1',
          objective: 'Ship Plan mode with tests',
          status: 'paused',
          tokenBudget: 10_000
        }
      },
      expect.objectContaining({ method: 'initialize' }),
      { method: 'thread/goal/clear', params: { threadId: 'thread_1' } }
    ])
  })
})

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'thread',
    extra: null,
    sessionId: 'session',
    forkedFromId: null,
    parentThreadId: null,
    preview: 'Prompt',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: 'legacy',
    modelProvider: 'openai',
    createdAt: 1782777600,
    updatedAt: 1782777900,
    recencyAt: 1782777900,
    status: { type: 'idle' },
    path: null,
    cwd: '/repo',
    cliVersion: '0.0.0',
    source: 'appServer',
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides
  }
}

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    threadId: 'thread_1',
    objective: 'Ship',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1782777600,
    updatedAt: 1782777900,
    ...overrides
  }
}
