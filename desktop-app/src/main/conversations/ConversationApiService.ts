import {
  type CodexTurnInputItem,
  userInputText as codexUserInputText
} from '@dascowork/codex-app-server-client'
import type {
  SidebarConversationActionPayload,
  SidebarConversationListState,
  SidebarConversationGoalSetPayload,
  SidebarConversationOpenResult,
  SidebarConversationRenamePayload,
  SidebarPreferences,
  ThreadGoalLoadResult,
  ThreadGoalSummary
} from '../../shared/codexIpcApi'
import type { ProjectState, ThreadProjectAssignment } from '../../shared/projects/projectTypes'
import type { CodexExperimentalFeature } from '@dascowork/codex-app-server-client'
import type { AppServerThreadGoal, AppServerThreadRow } from './AppServerThreadClient'
import { normalizeLocalMediaUrls } from './localMediaUrls'

export type ConversationThreadClientLike = {
  listThreads(input: {
    includeArchived: boolean
    sortKey?: 'updated_at' | 'created_at'
  }): Promise<AppServerThreadRow[]>
  readThread(threadId: string, input?: { includeTurns?: boolean }): Promise<AppServerThreadRow>
  readThreadWithFullTurns(threadId: string): Promise<AppServerThreadRow>
  archiveThread(threadId: string): Promise<void>
  unarchiveThread(threadId: string): Promise<void>
  renameThread(threadId: string, name: string): Promise<void>
  listExperimentalFeatures?(): Promise<CodexExperimentalFeature[]>
  getThreadGoal?(threadId: string): Promise<AppServerThreadGoal | null>
  setThreadGoal?(threadId: string, objective: string): Promise<AppServerThreadGoal>
  clearThreadGoal?(threadId: string): Promise<boolean>
}

export type ConversationProjectStoreLike = {
  getState(): Promise<ProjectState>
}

export type ConversationApiServiceOptions = {
  threadClient: ConversationThreadClientLike
  projectStore: ConversationProjectStoreLike
  waitForConversationSettlement?: (conversationId: string) => Promise<void>
  onConversationArchived?: (conversationId: string) => Promise<void> | void
}

export type ObservedStartedThread = {
  threadId: string
  originConversationId?: string
  title?: string | null
  cwd?: string | null
  createdAt?: string
  updatedAt?: string
  projectAssignment?: ThreadProjectAssignment
}

const defaultPreferences: SidebarPreferences = {
  organizeMode: 'project',
  sortKey: 'updated_at',
  collapsedSectionIds: [],
  collapsedGroupIds: []
}
const placeholderThreadTitles = new Set(['New Chat'])

const emptyProjectState: ProjectState = {
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
  projectlessHints: {}
}

export class ConversationApiService {
  private preferences: SidebarPreferences = defaultPreferences
  private authoritativeThreadRows: AppServerThreadRow[] = []
  /**
   * Threads confirmed by `thread/read` while `thread/list` is still catching
   * up. These are never optimistic rows: each later refresh reads them again
   * before projecting them into the sidebar.
   */
  private readonly readConfirmedThreadRows = new Map<string, AppServerThreadRow>()
  private readonly observedStartedThreads = new Map<string, AppServerThreadRow>()
  /**
   * App-server can expose an immediately interrupted thread with the generic
   * "New Chat" label before its first user item has reached history. Preserve
   * the bound request title until app-server supplies a real presentation.
   */
  private readonly startedThreadTitleFallbacks = new Map<string, string>()
  private readonly observedStartedThreadAssignments = new Map<string, ThreadProjectAssignment>()
  private readonly observedStartedThreadOrigins = new Map<string, string>()
  private lastProjectState: ProjectState = emptyProjectState
  private lastState: SidebarConversationListState = {
    conversations: [],
    archivedConversationIds: [],
    loaded: false
  }
  private initialLoadPromise: Promise<SidebarConversationListState> | undefined

  constructor(private readonly options: ConversationApiServiceOptions) {}

  observeStartedThreadSnapshot(input: ObservedStartedThread): SidebarConversationListState {
    this.storeObservedStartedThread(input)
    return this.updateLastState({
      projectState: this.lastProjectState,
      threads: this.mergeObservedStartedThreads(this.authoritativeThreadRows)
    })
  }

  async observeStartedThread(input: ObservedStartedThread): Promise<SidebarConversationListState> {
    this.storeObservedStartedThread(input)
    const projectState = await this.options.projectStore.getState()
    this.lastProjectState = projectState
    return this.updateLastState({
      projectState,
      threads: this.mergeObservedStartedThreads(this.authoritativeThreadRows)
    })
  }

  async getConversationList(): Promise<SidebarConversationListState> {
    if (!this.lastState.loaded) return this.ensureConversationListLoaded()
    return this.refreshConversationList()
  }

  getConversationSnapshot(): SidebarConversationListState {
    return this.lastState
  }

  ensureConversationListLoaded(): Promise<SidebarConversationListState> {
    if (this.lastState.loaded) return Promise.resolve(this.lastState)
    if (this.initialLoadPromise) return this.initialLoadPromise

    const loading = this.refreshConversationList().finally(() => {
      if (this.initialLoadPromise === loading) this.initialLoadPromise = undefined
    })
    this.initialLoadPromise = loading
    return loading
  }

  applyProjectState(projectState: ProjectState): SidebarConversationListState {
    this.lastProjectState = projectState
    if (!this.lastState.loaded) return this.lastState
    return this.updateLastState({
      projectState,
      threads: this.mergeObservedStartedThreads(this.authoritativeThreadRows)
    })
  }

  /**
   * Checks whether a thread appears in the raw `thread/list` result without
   * updating `lastState`. Used by the convergence loop to detect when
   * `thread/list` has caught up to a newly created thread.
   */
  async hasThreadInList(threadId: string): Promise<boolean> {
    const threads = await this.options.threadClient.listThreads({
      includeArchived: false,
      sortKey: this.preferences.sortKey
    })
    return threads.some((thread) => thread.id === threadId)
  }

  async discardStartedThreadObservation(threadId: string): Promise<SidebarConversationListState> {
    if (!this.observedStartedThreads.delete(threadId)) {
      return this.lastState
    }
    this.observedStartedThreadAssignments.delete(threadId)
    this.observedStartedThreadOrigins.delete(threadId)

    const projectState = await this.options.projectStore.getState()
    this.lastProjectState = projectState
    return this.updateLastState({
      projectState,
      threads: this.mergeObservedStartedThreads(this.authoritativeThreadRows)
    })
  }

  async refreshConversationList(
    input: { ensureThreadIds?: string[] } = {}
  ): Promise<SidebarConversationListState> {
    try {
      const [projectState, threads] = await Promise.all([
        this.options.projectStore.getState(),
        this.options.threadClient.listThreads({
          includeArchived: false,
          sortKey: this.preferences.sortKey
        })
      ])
      this.lastProjectState = projectState
      this.authoritativeThreadRows = await this.includeRequiredThreads({
        threads: await this.reconcileReadConfirmedThreads(threads),
        requiredThreadIds: input.ensureThreadIds
      })
      return this.updateLastState({
        projectState,
        threads: this.mergeObservedStartedThreads(this.authoritativeThreadRows)
      })
    } catch (error) {
      this.lastState = {
        ...this.lastState,
        loaded: this.lastState.loaded,
        error: errorMessage(error)
      }
      return this.lastState
    }
  }

  async openConversation(
    input: SidebarConversationActionPayload
  ): Promise<SidebarConversationOpenResult> {
    // This is intentionally a point-in-time read. The renderer immediately
    // attaches to any active main-process run and replays the missing events.
    // Waiting here would turn a refresh into a silent full-turn delay.
    const [projectState, thread, threadGoalResult] = await Promise.all([
      this.options.projectStore.getState(),
      this.options.threadClient.readThreadWithFullTurns(input.conversationId),
      this.loadConversationGoal(input.conversationId)
    ])
    const messages = normalizeLocalMediaUrls(thread.messages ?? [])

    return {
      conversationId: thread.id,
      threadId: thread.id,
      title: thread.title,
      messages,
      historyRevision: thread.updatedAt ?? null,
      projectAssignment: resolveAssignment(projectState, thread),
      cwd: thread.cwd,
      threadGoalResult
    }
  }

  async getConversationGoal(conversationId: string): Promise<ThreadGoalLoadResult> {
    return this.loadConversationGoal(conversationId)
  }

  async setConversationGoal(input: SidebarConversationGoalSetPayload): Promise<ThreadGoalSummary> {
    if (!this.options.threadClient.setThreadGoal) {
      throw new Error('Thread goals are not supported by this app-server')
    }
    return toThreadGoalSummary(
      await this.options.threadClient.setThreadGoal(input.conversationId, input.objective)
    )
  }

  async clearConversationGoal(conversationId: string): Promise<boolean> {
    if (!this.options.threadClient.clearThreadGoal) {
      throw new Error('Thread goals are not supported by this app-server')
    }
    return this.options.threadClient.clearThreadGoal(conversationId)
  }

  async archiveConversation(
    input: SidebarConversationActionPayload
  ): Promise<SidebarConversationListState> {
    await this.options.threadClient.archiveThread(input.conversationId)
    await this.options.onConversationArchived?.(input.conversationId)
    this.observedStartedThreads.delete(input.conversationId)
    this.startedThreadTitleFallbacks.delete(input.conversationId)
    this.observedStartedThreadAssignments.delete(input.conversationId)
    this.observedStartedThreadOrigins.delete(input.conversationId)
    this.readConfirmedThreadRows.delete(input.conversationId)
    return this.refreshConversationList()
  }

  async unarchiveConversation(
    input: SidebarConversationActionPayload
  ): Promise<SidebarConversationListState> {
    await this.options.threadClient.unarchiveThread(input.conversationId)
    return this.refreshConversationList()
  }

  async renameConversation(
    input: SidebarConversationRenamePayload
  ): Promise<SidebarConversationListState> {
    await this.options.threadClient.renameThread(input.conversationId, input.title.trim())
    this.startedThreadTitleFallbacks.set(input.conversationId, input.title.trim())
    return this.refreshConversationList()
  }

  getPreferences(): SidebarPreferences {
    return this.preferences
  }

  setPreferences(input: Partial<SidebarPreferences>): SidebarPreferences {
    this.preferences = {
      ...this.preferences,
      ...input,
      collapsedSectionIds: input.collapsedSectionIds ?? this.preferences.collapsedSectionIds,
      collapsedGroupIds: input.collapsedGroupIds ?? this.preferences.collapsedGroupIds
    }
    return this.preferences
  }

  private async loadConversationGoal(conversationId: string): Promise<ThreadGoalLoadResult> {
    if (!this.options.threadClient.getThreadGoal) {
      return { status: 'unsupported', message: '当前 Codex 服务不支持任务目标' }
    }
    try {
      if (this.options.threadClient.listExperimentalFeatures) {
        const features = await this.options.threadClient.listExperimentalFeatures()
        if (!features.some((feature) => feature.name === 'goals' && feature.enabled)) {
          return { status: 'unsupported', message: '当前 Codex 服务未启用任务目标' }
        }
      }
      const goal = await this.options.threadClient.getThreadGoal(conversationId)
      return { status: 'loaded', goal: goal ? toThreadGoalSummary(goal) : null }
    } catch (error) {
      if (isUnsupportedGoalFeatureError(error)) {
        return { status: 'unsupported', message: '当前 Codex 服务不支持任务目标' }
      }
      return { status: 'error', message: '无法读取已保存的任务目标' }
    }
  }

  private storeObservedStartedThread(input: ObservedStartedThread): void {
    const now = new Date().toISOString()
    const existing = this.observedStartedThreads.get(input.threadId)
    if (input.projectAssignment) {
      this.observedStartedThreadAssignments.set(input.threadId, input.projectAssignment)
    }
    if (input.originConversationId) {
      this.observedStartedThreadOrigins.set(input.threadId, input.originConversationId)
    }
    const title = cleanTitle(input.title)
    if (title) this.startedThreadTitleFallbacks.set(input.threadId, title)
    this.observedStartedThreads.set(input.threadId, {
      id: input.threadId,
      title: input.title ?? existing?.title ?? null,
      preview: input.title ?? existing?.preview ?? '',
      createdAt: input.createdAt ?? existing?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      archived: false,
      running: true,
      cwd: input.cwd ?? existing?.cwd ?? null
    })
  }

  private async includeRequiredThreads({
    threads,
    requiredThreadIds = []
  }: {
    threads: AppServerThreadRow[]
    requiredThreadIds?: string[]
  }): Promise<AppServerThreadRow[]> {
    const rows = [...threads]
    const rowsById = new Map(threads.map((thread) => [thread.id, thread]))
    const requiredMissingThreadIds = uniqueThreadIds(requiredThreadIds).filter(
      (threadId) => !rowsById.has(threadId)
    )

    for (const threadId of requiredMissingThreadIds) {
      let thread: AppServerThreadRow
      try {
        thread = await this.options.threadClient.readThreadWithFullTurns(threadId)
      } catch (error) {
        if (this.observedStartedThreads.has(threadId)) continue
        throw error
      }
      if (rowsById.has(thread.id)) continue
      if (thread.archived) continue
      this.observedStartedThreads.delete(thread.id)
      this.readConfirmedThreadRows.set(thread.id, thread)
      rowsById.set(thread.id, thread)
      rows.unshift(thread)
    }

    return rows
  }

  private async reconcileReadConfirmedThreads(
    threads: AppServerThreadRow[]
  ): Promise<AppServerThreadRow[]> {
    const rows = [...threads]
    const rowsById = new Map(rows.map((thread) => [thread.id, thread]))

    for (const threadId of this.readConfirmedThreadRows.keys()) {
      if (rowsById.has(threadId)) {
        this.readConfirmedThreadRows.delete(threadId)
        continue
      }

      try {
        const thread = await this.options.threadClient.readThreadWithFullTurns(threadId)
        if (thread.archived) {
          this.readConfirmedThreadRows.delete(threadId)
          continue
        }
        this.readConfirmedThreadRows.set(thread.id, thread)
        rowsById.set(thread.id, thread)
        rows.unshift(thread)
      } catch {
        // A read-confirmed row is only retained while app-server can still
        // read it. This prevents a stale local sidebar fallback.
        this.readConfirmedThreadRows.delete(threadId)
      }
    }

    return rows
  }

  private mergeObservedStartedThreads(threads: AppServerThreadRow[]): AppServerThreadRow[] {
    const rowsById = new Map(threads.map((thread) => [thread.id, thread]))
    for (const thread of threads) {
      if (this.observedStartedThreads.has(thread.id)) {
        this.observedStartedThreads.delete(thread.id)
      }
    }

    const observedRows = [...this.observedStartedThreads.values()]
      .filter((thread) => !rowsById.has(thread.id) && !thread.archived)
      .sort((left, right) => compareIsoDescending(left.updatedAt, right.updatedAt))

    return [...observedRows, ...threads]
  }

  private updateLastState({
    projectState,
    threads
  }: {
    projectState: ProjectState
    threads: AppServerThreadRow[]
  }): SidebarConversationListState {
    this.lastState = this.createListState({ projectState, threads })
    this.clearReconciledStartedThreadMetadata(threads)
    return this.lastState
  }

  private clearReconciledStartedThreadMetadata(threads: readonly AppServerThreadRow[]): void {
    for (const thread of threads) {
      if (this.observedStartedThreads.has(thread.id)) continue
      this.observedStartedThreadAssignments.delete(thread.id)
      this.observedStartedThreadOrigins.delete(thread.id)
      if (hasAuthoritativeThreadPresentation(thread)) {
        this.startedThreadTitleFallbacks.delete(thread.id)
      }
    }
  }

  private createListState({
    projectState,
    threads
  }: {
    projectState: ProjectState
    threads: AppServerThreadRow[]
  }): SidebarConversationListState {
    return {
      conversations: threads.map((thread) => ({
        ...conversationListRowTitle(thread, this.startedThreadTitleFallbacks.get(thread.id)),
        id: thread.id,
        threadId: thread.id,
        ...(this.observedStartedThreadOrigins.has(thread.id)
          ? { originConversationId: this.observedStartedThreadOrigins.get(thread.id) }
          : {}),
        projectAssignment:
          this.observedStartedThreadAssignments.get(thread.id) ??
          resolveAssignment(projectState, thread),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        archived: thread.archived,
        running: thread.running,
        cwd: thread.cwd
      })),
      archivedConversationIds: threads
        .filter((thread) => thread.archived)
        .map((thread) => thread.id),
      loaded: true,
      error: undefined
    }
  }
}

function compareIsoDescending(left: string | undefined, right: string | undefined): number {
  const leftTime = Date.parse(left ?? '')
  const rightTime = Date.parse(right ?? '')
  return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime)
}

function uniqueThreadIds(threadIds: (string | undefined)[]): string[] {
  return [...new Set(threadIds.filter((threadId): threadId is string => Boolean(threadId)))]
}

function conversationTitle(thread: AppServerThreadRow): string | null {
  const title = cleanTitle(thread.title)
  const firstUserText = cleanTitle(firstTurnText(thread))
  if (isPlaceholderThreadTitle(title)) return firstUserText ?? title
  return title ?? firstUserText ?? null
}

function conversationListRowTitle(
  thread: AppServerThreadRow,
  startedThreadTitleFallback: string | undefined
): { title: string | null } {
  const title = conversationTitle(thread)
  return {
    title:
      (isPlaceholderThreadTitle(title) ? startedThreadTitleFallback : title) ??
      startedThreadTitleFallback ??
      null
  }
}

function hasAuthoritativeThreadPresentation(thread: AppServerThreadRow): boolean {
  return [thread.title, thread.preview, firstTurnText(thread)].some((value) => {
    const title = cleanTitle(value)
    return title !== null && !isPlaceholderThreadTitle(title)
  })
}

function isPlaceholderThreadTitle(title: string | null): boolean {
  return title !== null && placeholderThreadTitles.has(title)
}

function firstTurnText(thread: AppServerThreadRow): string | null {
  for (const turn of thread.turns ?? []) {
    const items = isRecord(turn) && Array.isArray(turn.items) ? turn.items : []
    for (const item of items) {
      if (!isRecord(item)) continue
      if (item.type === 'userMessage') return cleanTitle(userInputText(item.content))
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        return cleanTitle(item.text)
      }
    }
  }
  return null
}

function cleanTitle(value: string | null | undefined): string | null {
  const title = value?.trim()
  return title ? title : null
}

function resolveAssignment(
  projectState: ProjectState,
  thread: AppServerThreadRow
): ThreadProjectAssignment | undefined {
  const explicit = projectState.threadProjectAssignments[thread.id]
  if (explicit) return explicit

  if (projectState.projectlessThreadIds.includes(thread.id)) {
    const hints = projectState.projectlessHints[thread.id]
    return {
      projectKind: 'projectless',
      cwd: thread.cwd,
      workspaceRoot: hints?.workspaceRoot ?? thread.cwd,
      outputDirectory:
        hints?.outputDirectory ?? projectState.threadProjectlessOutputDirectories[thread.id] ?? null
    }
  }

  const workspaceRootHint = projectState.threadWorkspaceRootHints[thread.id]?.[0]
  if (workspaceRootHint) {
    return {
      projectKind: 'local',
      projectId: `path:${workspaceRootHint}`,
      path: workspaceRootHint,
      cwd: thread.cwd ?? workspaceRootHint
    }
  }

  const localProject = Object.values(projectState.localProjects).find((project) =>
    project.writableRoots.some((root) => root === thread.cwd)
  )
  if (localProject) {
    return {
      projectKind: 'local',
      projectId: localProject.id,
      cwd: thread.cwd ?? localProject.defaultCwd ?? null
    }
  }

  return undefined
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const inputs = value
    .map(toCodexTurnInputItem)
    .filter((entry): entry is CodexTurnInputItem => Boolean(entry))
  return humanizeComposerContextDirectives(codexUserInputText(inputs))
}

function humanizeComposerContextDirectives(value: string): string {
  return value.replace(
    /:([\w-]{1,64})\[([^\]\n]{1,1024})\]\{name=([^}\n]{1,4096})\}/gu,
    (_directive, type: string, encodedLabel: string, encodedPath: string) => {
      const label = decodeDirectiveField(encodedLabel)
      const path = decodeDirectiveField(encodedPath)
      if (type === 'skill' || type === 'app') return `$${label}`
      if (type === 'plugin' || type === 'chat' || type === 'agent' || type === 'agentRole') {
        return `@${label}`
      }
      if (type === 'file' || type === 'folder') return label
      return path.length > 0 ? label : _directive
    }
  )
}

function decodeDirectiveField(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toCodexTurnInputItem(entry: unknown): CodexTurnInputItem | null {
  if (!isRecord(entry)) return null

  switch (entry.type) {
    case 'text':
      return typeof entry.text === 'string'
        ? {
            type: 'text',
            text: entry.text,
            text_elements: Array.isArray(entry.text_elements) ? entry.text_elements : []
          }
        : null
    case 'skill':
    case 'mention':
      return typeof entry.name === 'string'
        ? {
            type: entry.type,
            name: entry.name,
            path: typeof entry.path === 'string' ? entry.path : ''
          }
        : null
    default:
      return null
  }
}

function toThreadGoalSummary(goal: AppServerThreadGoal): ThreadGoalSummary {
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  }
}

function isUnsupportedGoalFeatureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return message.includes('not supported') || message.includes('method not found')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
