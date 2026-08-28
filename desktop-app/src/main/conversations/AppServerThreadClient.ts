import {
  createCodexHistoryClient,
  type CodexFeedbackClassification,
  type CodexExperimentalFeature,
  mapCodexThreadToUiMessages,
  type CodexThreadGoalSetParams,
  type CodexThreadForkParams,
  type CodexTurnListParams,
  type CodexHistoryClient,
  type CodexThreadForUi,
  type ThreadGoal
} from '@janole/ai-sdk-provider-codex-asp'
import type { UIMessage } from 'ai'

import type { CodexAppServerLaunchOptions } from '../codexAppServerLaunch'
import { createCodexClientInfo } from '../codexClientInfo'
import type { TurnDiffStoreReader } from './TurnDiffStore'

type AppServerHistoryThread = CodexThreadForUi & {
  id: string
  name: string | null
  preview: string
  createdAt: number
  updatedAt: number
  status: { type: string }
  cwd: string | null
  threadSource?: string | null
}

export type AppServerThreadRow = {
  id: string
  title: string | null
  preview: string
  createdAt?: string
  updatedAt?: string
  archived: boolean
  running: boolean
  cwd: string | null
  threadSource?: string
  turns?: CodexThreadForUi['turns']
  messages?: UIMessage[]
}

export type AppServerThreadGoal = ThreadGoal

type AppServerTurnsPage = {
  data: CodexThreadForUi['turns']
  nextCursor?: string | null
  backwardsCursor?: string | null
}

export type AppServerHistoryClientLike = {
  listAllThreads(input: {
    archived?: boolean
    sortKey?: 'updated_at' | 'created_at'
    sortDirection?: 'asc' | 'desc'
    modelProviders?: string[]
  }): Promise<AppServerHistoryThread[]>
  readThread(threadId: string, input?: { includeTurns?: boolean }): Promise<AppServerHistoryThread>
  listTurns(threadId: string, input?: CodexTurnListParams): Promise<AppServerTurnsPage>
  archiveThread(threadId: string): Promise<void>
  unarchiveThread(threadId: string): Promise<void>
  deleteThread?(threadId: string): Promise<void>
  renameThread(threadId: string, name: string): Promise<void>
  forkThread(threadId: string, input?: CodexThreadForkParams): Promise<AppServerHistoryThread>
  rollbackThread(threadId: string, numTurns: number): Promise<AppServerHistoryThread>
  submitFeedback?(
    threadId: string,
    classification: CodexFeedbackClassification,
    targetTurnId?: string
  ): Promise<void>
  listExperimentalFeatures?(): Promise<CodexExperimentalFeature[]>
  getThreadGoal?(threadId: string): Promise<AppServerThreadGoal | null>
  setThreadGoal?(threadId: string, params: CodexThreadGoalSetParams): Promise<AppServerThreadGoal>
  clearThreadGoal?(threadId: string): Promise<boolean>
}

export type AppServerThreadClientOptions = {
  launch?: CodexAppServerLaunchOptions
  historyClient?: AppServerHistoryClientLike
  createHistoryClient?: () => AppServerHistoryClientLike
  turnDiffStore?: TurnDiffStoreReader
}

export class AppServerThreadClient {
  constructor(private readonly options: AppServerThreadClientOptions) {}

  async listThreads(input: {
    includeArchived: boolean
    sortKey?: 'updated_at' | 'created_at'
  }): Promise<AppServerThreadRow[]> {
    return this.withHistoryClient(async (client) => {
      const threads = await client.listAllThreads({
        // Empty means all providers; omitting this would filter to the
        // sidebar app-server process's default provider.
        modelProviders: [],
        sortKey: input.sortKey === 'created_at' ? 'created_at' : 'updated_at',
        sortDirection: 'desc',
        ...(input.includeArchived ? { archived: true } : {})
      })
      return threads.map((thread) => toThreadRow(thread, input.includeArchived))
    })
  }

  async readThread(
    threadId: string,
    input: { includeTurns?: boolean } = {}
  ): Promise<AppServerThreadRow> {
    return this.withHistoryClient(async (client) => {
      const thread = await client.readThread(threadId, {
        includeTurns: input.includeTurns ?? false
      })
      return toThreadRow(thread, false, { includeMessages: input.includeTurns ?? false })
    })
  }

  async readThreadWithFullTurns(
    threadId: string,
    input: { limit?: number } = {}
  ): Promise<AppServerThreadRow> {
    return this.withHistoryClient(async (client) => {
      const thread = await client.readThread(threadId, { includeTurns: false })
      const turns = await listAllFullTurns(client, threadId, { limit: input.limit })
      const hydratedTurns = await hydratePersistedTurnDiffs(
        threadId,
        turns,
        this.options.turnDiffStore
      )
      return toThreadRow({ ...thread, turns: hydratedTurns }, false, { includeMessages: true })
    })
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.withHistoryClient((client) => client.archiveThread(threadId))
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.withHistoryClient((client) => client.unarchiveThread(threadId))
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.withHistoryClient((client) => {
      if (!client.deleteThread) {
        throw new Error('Deleting tasks is not supported by this app-server')
      }
      return client.deleteThread(threadId)
    })
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.withHistoryClient((client) => client.renameThread(threadId, name))
  }

  async submitFeedback(
    threadId: string,
    classification: CodexFeedbackClassification,
    targetTurnId?: string
  ): Promise<void> {
    await this.withHistoryClient((client) => {
      if (!client.submitFeedback) {
        throw new Error('Feedback is not supported by this app-server')
      }
      return client.submitFeedback(threadId, classification, targetTurnId)
    })
  }

  async forkThread(input: {
    threadId: string
    targetTurnId: string
    ephemeral: boolean
    cwd?: string
    runtimeWorkspaceRoots?: string[]
  }): Promise<AppServerThreadRow> {
    return this.withHistoryClient(async (client) => {
      const sourceTurns = await listAllFullTurns(client, input.threadId, {})
      const targetTurnIndex = sourceTurns.findIndex((turn) => turn.id === input.targetTurnId)
      if (targetTurnIndex < 0) {
        throw new Error('无法从该消息继续：原任务中找不到对应的执行步骤。')
      }

      const forkedThread = await client.forkThread(input.threadId, {
        ephemeral: input.ephemeral,
        cwd: input.cwd,
        runtimeWorkspaceRoots: input.runtimeWorkspaceRoots
      })
      const turnsToDiscard = forkedThread.turns.length - targetTurnIndex - 1
      const completedThread =
        turnsToDiscard > 0
          ? await client.rollbackThread(forkedThread.id, turnsToDiscard)
          : forkedThread
      const retainedTurn = completedThread.turns.at(-1)
      if (
        completedThread.turns.length !== targetTurnIndex + 1 ||
        retainedTurn?.id !== input.targetTurnId
      ) {
        throw new Error('无法从该消息继续：新任务未能保留正确的历史步骤。')
      }

      return toThreadRow(completedThread, false, { includeMessages: true })
    })
  }

  async getThreadGoal(threadId: string): Promise<AppServerThreadGoal | null> {
    return this.withHistoryClient((client) => {
      if (!client.getThreadGoal)
        throw new Error('Thread goals are not supported by this app-server')
      return client.getThreadGoal(threadId)
    })
  }

  async listExperimentalFeatures(): Promise<CodexExperimentalFeature[]> {
    return this.withHistoryClient((client) => {
      if (!client.listExperimentalFeatures)
        throw new Error('Experimental feature catalog is not supported by this app-server')
      return client.listExperimentalFeatures()
    })
  }

  async setThreadGoal(threadId: string, objective: string): Promise<AppServerThreadGoal> {
    return this.withHistoryClient((client) => {
      if (!client.setThreadGoal)
        throw new Error('Thread goals are not supported by this app-server')
      return client.setThreadGoal(threadId, { objective, status: 'active' })
    })
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    return this.withHistoryClient((client) => {
      if (!client.clearThreadGoal)
        throw new Error('Thread goals are not supported by this app-server')
      return client.clearThreadGoal(threadId)
    })
  }

  private async withHistoryClient<T>(
    callback: (client: AppServerHistoryClientLike) => Promise<T>
  ): Promise<T> {
    return callback(this.createHistoryClient())
  }

  private createHistoryClient(): AppServerHistoryClientLike {
    if (this.options.historyClient) return this.options.historyClient
    if (this.options.createHistoryClient) return this.options.createHistoryClient()
    if (!this.options.launch) throw new Error('Codex app-server launch options are required')
    return createCodexHistoryClient({
      clientInfo: createCodexClientInfo('dascowork_desktop_sidebar', 'dasCowork Desktop Sidebar'),
      experimentalApi: true,
      transport: {
        type: 'stdio',
        stdio: {
          command: this.options.launch.command,
          args: this.options.launch.args,
          cwd: this.options.launch.cwd,
          env: this.options.launch.env
        }
      }
    }) satisfies CodexHistoryClient
  }
}

async function hydratePersistedTurnDiffs(
  threadId: string,
  turns: CodexThreadForUi['turns'],
  store: TurnDiffStoreReader | undefined
): Promise<CodexThreadForUi['turns']> {
  if (!store || turns.length === 0) return turns

  const diffs = await store.readMany(
    threadId,
    turns.map((turn) => turn.id)
  )
  return turns.map((turn) => {
    const diff = diffs.get(turn.id)
    return diff === undefined ? turn : { ...turn, diff }
  })
}

async function listAllFullTurns(
  client: AppServerHistoryClientLike,
  threadId: string,
  input: { limit?: number }
): Promise<CodexThreadForUi['turns']> {
  const turns: CodexThreadForUi['turns'] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  do {
    const page = await client.listTurns(threadId, {
      ...(cursor ? { cursor } : {}),
      limit: input.limit ?? 100,
      sortDirection: 'desc',
      itemsView: 'full'
    })
    assertFullTurnsPage(threadId, page)
    turns.push(...page.data)

    const nextCursor = page.nextCursor ?? undefined
    if (!nextCursor || seenCursors.has(nextCursor)) break
    seenCursors.add(nextCursor)
    cursor = nextCursor
  } while (cursor)

  return turns.reverse()
}

function assertFullTurnsPage(threadId: string, page: AppServerTurnsPage): void {
  const partialTurn = page.data.find((turn) => turn.itemsView !== 'full')
  if (!partialTurn) return

  throw new Error(
    `App server returned ${partialTurn.itemsView} items for ${threadId}/${partialTurn.id}; expected full turn items`
  )
}

function toThreadRow(
  thread: AppServerHistoryThread,
  archived: boolean,
  options: { includeMessages?: boolean } = {}
): AppServerThreadRow {
  const title = cleanTitle(thread.name) ?? cleanTitle(thread.preview) ?? null
  return {
    id: thread.id,
    title,
    preview: thread.preview ?? '',
    createdAt: fromUnixSeconds(thread.createdAt),
    updatedAt: fromUnixSeconds(thread.updatedAt),
    archived,
    running: thread.status.type === 'active',
    cwd: thread.cwd,
    ...(thread.threadSource ? { threadSource: thread.threadSource } : {}),
    ...(thread.turns.length > 0 ? { turns: thread.turns } : {}),
    ...(options.includeMessages ? { messages: mapCodexThreadToUiMessages(thread) } : {})
  }
}

function cleanTitle(value: string | null | undefined): string | null {
  const title = value?.trim()
  return title ? title : null
}

function fromUnixSeconds(value: number | undefined): string | undefined {
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined
}
