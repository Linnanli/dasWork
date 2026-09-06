import { AppServerClient } from './client/app-server-client'
import { StdioTransport } from './client/transport-stdio'
import { WebSocketTransport } from './client/transport-websocket'
import type { CodexAppServerClientSettings, TransportContext } from './client-settings'
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info'
import type { Thread } from './protocol/app-server-protocol/v2/Thread'
import type { TurnItemsView } from './protocol/app-server-protocol/v2/TurnItemsView'
import type { TurnsPage } from './protocol/app-server-protocol/v2/TurnsPage'
import type {
  CodexInitializeParams,
  CodexInitializeResult,
  CollaborationModeListResponse,
  CollaborationModeMask,
  ThreadGoal,
  ThreadGoalClearResponse,
  ThreadGoalGetResponse,
  ThreadGoalSetParams,
  ThreadGoalSetResponse
} from './protocol/types'
import { stripUndefined } from './utils/object'

export type CodexHistorySortKey = 'updated_at' | 'created_at'
export type CodexHistorySortDirection = 'asc' | 'desc'

export interface CodexHistoryJsonRpcClientLike {
  connect(): Promise<void>
  disconnect(): Promise<void>
  notification(method: string, params?: unknown): Promise<void>
  request<T = unknown>(method: string, params?: unknown): Promise<T>
}

export interface CodexHistoryClientLease {
  client: CodexHistoryJsonRpcClientLike
  release(): Promise<void>
}

export interface CodexHistoryClientSettings extends CodexAppServerClientSettings {
  createClient?: () => CodexHistoryJsonRpcClientLike
  /**
   * Supplies an already-initialized logical client owned by the embedding host.
   * When provided, this client never performs the app-server handshake itself.
   */
  acquireClient?: () => Promise<CodexHistoryClientLease>
}

export interface CodexThreadListParams {
  cursor?: string
  limit?: number
  sortKey?: CodexHistorySortKey
  sortDirection?: CodexHistorySortDirection
  archived?: boolean
  cwd?: string
  searchTerm?: string
  modelProviders?: string[]
  sourceKinds?: string[]
  parentThreadId?: string
  ancestorThreadId?: string
}

export interface CodexTurnListParams {
  cursor?: string
  limit?: number
  sortDirection?: CodexHistorySortDirection
  itemsView?: TurnItemsView
}

export interface CodexThreadReadParams {
  includeTurns?: boolean
}

export interface CodexThreadForkParams {
  ephemeral?: boolean
  excludeTurns?: boolean
}

export type CodexThreadGoalSetParams = Omit<ThreadGoalSetParams, 'threadId'>

/** Stable, renderer-independent subset of experimentalFeature/list. */
export interface CodexExperimentalFeature {
  name: string
  enabled: boolean
}

interface ExperimentalFeatureListResponse {
  data: CodexExperimentalFeature[]
  nextCursor?: string | null
}

export interface CodexThreadListResponse {
  data: Thread[]
  nextCursor?: string | null
}

export interface CodexThreadReadResponse {
  thread: Thread
}

export interface CodexThreadForkResponse {
  thread: Thread
}

export class CodexHistoryClient {
  constructor(private readonly settings: CodexHistoryClientSettings = {}) {}

  async listThreads(params: CodexThreadListParams = {}): Promise<CodexThreadListResponse> {
    return this.withClient((client) =>
      client.request<CodexThreadListResponse>('thread/list', threadListParams(params))
    )
  }

  async listAllThreads(params: Omit<CodexThreadListParams, 'cursor'> = {}): Promise<Thread[]> {
    return this.withClient(async (client) => {
      const threads: Thread[] = []
      let cursor: string | undefined

      do {
        const pageParams: CodexThreadListParams = { ...params }
        if (cursor !== undefined) {
          pageParams.cursor = cursor
        }
        const response = await client.request<CodexThreadListResponse>(
          'thread/list',
          threadListParams(pageParams)
        )
        threads.push(...response.data)
        cursor = response.nextCursor ?? undefined
      } while (cursor)

      return threads
    })
  }

  async readThread(threadId: string, params: CodexThreadReadParams = {}): Promise<Thread> {
    return this.withClient(async (client) => {
      const response = await client.request<CodexThreadReadResponse>('thread/read', {
        threadId,
        includeTurns: params.includeTurns ?? false
      })
      return response.thread
    })
  }

  async listTurns(threadId: string, params: CodexTurnListParams = {}): Promise<TurnsPage> {
    return this.withClient((client) =>
      client.request<TurnsPage>(
        'thread/turns/list',
        stripUndefined({
          threadId,
          cursor: params.cursor,
          limit: params.limit ?? 100,
          sortDirection: params.sortDirection ?? 'desc',
          itemsView: params.itemsView ?? 'full'
        })
      )
    )
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.withClient((client) => client.request('thread/name/set', { threadId, name }))
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.withClient((client) => client.request('thread/archive', { threadId }))
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.withClient((client) => client.request('thread/unarchive', { threadId }))
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.withClient((client) => client.request('thread/delete', { threadId }))
  }

  async forkThread(threadId: string, params: CodexThreadForkParams = {}): Promise<Thread> {
    return this.withClient(async (client) => {
      const response = await client.request<CodexThreadForkResponse>(
        'thread/fork',
        stripUndefined({
          threadId,
          ephemeral: params.ephemeral,
          excludeTurns: params.excludeTurns
        })
      )
      return response.thread
    })
  }

  async listCollaborationModes(): Promise<CollaborationModeMask[]> {
    return this.withClient(async (client) => {
      const response = await client.request<CollaborationModeListResponse>(
        'collaborationMode/list',
        {}
      )
      return response.data
    })
  }

  async listExperimentalFeatures(): Promise<CodexExperimentalFeature[]> {
    return this.withClient(async (client) => {
      const features: CodexExperimentalFeature[] = []
      let cursor: string | undefined
      do {
        const response = await client.request<ExperimentalFeatureListResponse>(
          'experimentalFeature/list',
          stripUndefined({ cursor, limit: 100 })
        )
        features.push(...response.data)
        cursor = response.nextCursor ?? undefined
      } while (cursor)
      return features
    })
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return this.withClient(async (client) => {
      const response = await client.request<ThreadGoalGetResponse>('thread/goal/get', { threadId })
      return response.goal
    })
  }

  async setThreadGoal(threadId: string, params: CodexThreadGoalSetParams): Promise<ThreadGoal> {
    return this.withClient(async (client) => {
      const response = await client.request<ThreadGoalSetResponse>(
        'thread/goal/set',
        stripUndefined({
          threadId,
          objective: params.objective,
          status: params.status,
          tokenBudget: params.tokenBudget
        })
      )
      return response.goal
    })
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    return this.withClient(async (client) => {
      const response = await client.request<ThreadGoalClearResponse>('thread/goal/clear', {
        threadId
      })
      return response.cleared
    })
  }

  private async withClient<T>(
    callback: (client: CodexHistoryJsonRpcClientLike) => Promise<T>
  ): Promise<T> {
    if (this.settings.acquireClient) {
      const lease = await this.settings.acquireClient()
      try {
        return await callback(lease.client)
      } finally {
        await lease.release().catch(() => undefined)
      }
    }

    const client = this.createClient()
    try {
      await client.connect()
      await client.request<CodexInitializeResult>('initialize', this.initializeParams())
      await client.notification('initialized')
      return await callback(client)
    } finally {
      await client.disconnect().catch(() => undefined)
    }
  }

  private createClient(): CodexHistoryJsonRpcClientLike {
    if (this.settings.createClient) {
      return this.settings.createClient()
    }

    const transport = this.settings.transportFactory
      ? this.settings.transportFactory({} satisfies TransportContext)
      : this.settings.transport?.type === 'websocket'
        ? new WebSocketTransport(this.settings.transport.websocket)
        : new StdioTransport(this.settings.transport?.stdio)

    return new AppServerClient(transport)
  }

  private initializeParams(): CodexInitializeParams {
    return stripUndefined({
      clientInfo: this.settings.clientInfo ?? {
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION
      },
      capabilities: { experimentalApi: this.settings.experimentalApi ?? true }
    })
  }
}

export function createCodexHistoryClient(
  settings: CodexHistoryClientSettings = {}
): CodexHistoryClient {
  return new CodexHistoryClient(settings)
}

function threadListParams(params: CodexThreadListParams): Record<string, unknown> {
  return stripUndefined({
    cursor: params.cursor,
    limit: params.limit ?? 100,
    modelProviders: params.modelProviders ?? [],
    sourceKinds: params.sourceKinds,
    sortKey: params.sortKey ?? 'updated_at',
    sortDirection: params.sortDirection ?? 'desc',
    archived: params.archived,
    cwd: params.cwd,
    searchTerm: params.searchTerm,
    parentThreadId: params.parentThreadId,
    ancestorThreadId: params.ancestorThreadId
  })
}
