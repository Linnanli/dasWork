import { basename, isAbsolute, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  CodexFuzzyFileSearchSession,
  CodexTaskSearchResult
} from '@dascowork/codex-app-server-client'
import {
  COMPOSER_CONTEXT_CATALOG_VERSION,
  COMPOSER_CONTEXT_SEARCH_VERSION,
  composerContextSearchSectionEventSchema,
  composerContextSearchStartResultSchema,
  type ComposerContextReference,
  type ComposerContextSearchSectionEvent,
  type ComposerContextSearchStartRequest,
  type ComposerContextSearchStartResult,
  type ComposerContextSearchUpdateRequest,
  type SidebarConversationListState
} from '../../shared/codexIpcApi'
import type {
  ProjectState,
  ResolvedExecutionTarget,
  ThreadProjectAssignment
} from '../../shared/projects/projectTypes'
import type { ProjectService } from '../projects/ProjectService'
import type { ProjectStore } from '../projects/ProjectStore'

type FuzzyFileResult = {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
  score: number
}

export type ComposerContextSearchProviderLike = {
  createFuzzyFileSearchSession(input: {
    roots: string[]
    onUpdated(files: FuzzyFileResult[], query: string): void
    onCompleted(query: string): void
  }): Promise<CodexFuzzyFileSearchSession>
  searchThreads(input: { query: string; limit?: number }): Promise<CodexTaskSearchResult[]>
}

type ActiveSession = {
  sessionId: string
  ownerWebContentsId: number
  hostId: string
  roots: string[]
  currentThreadId?: string
  currentProjectAssignment?: ThreadProjectAssignment
  currentQuery: string
  queryGeneration: number
  excludedThreadIds: Set<string>
  filesAvailable: boolean
  tasksAvailable: boolean
  fileItems: ComposerContextReference[]
  taskItems: ComposerContextReference[]
  fileSession?: CodexFuzzyFileSearchSession
  fileSessionPromise?: Promise<CodexFuzzyFileSearchSession>
  stopped: boolean
}

type SearchTarget = {
  hostId: string
  roots: string[]
  currentThreadId?: string
  currentProjectAssignment?: ThreadProjectAssignment
  filesAvailable: boolean
  tasksAvailable: boolean
}

export type ComposerContextSearchServiceOptions = {
  provider: ComposerContextSearchProviderLike
  projectService: Pick<ProjectService, 'resolveExistingThreadTarget' | 'resolveNewThreadTarget'>
  projectStore: Pick<ProjectStore, 'getState'>
  conversations: {
    getConversationSnapshot(): SidebarConversationListState
  }
  publish(ownerWebContentsId: number, event: ComposerContextSearchSectionEvent): void
}

export class ComposerContextSearchService {
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(private readonly options: ComposerContextSearchServiceOptions) {}

  async start(
    ownerWebContentsId: number,
    input: ComposerContextSearchStartRequest
  ): Promise<ComposerContextSearchStartResult> {
    const target = await this.resolveTarget(input)
    const session: ActiveSession = {
      sessionId: randomUUID(),
      ownerWebContentsId,
      hostId: target.hostId,
      roots: target.roots,
      ...(target.currentThreadId ? { currentThreadId: target.currentThreadId } : {}),
      ...(target.currentProjectAssignment
        ? { currentProjectAssignment: target.currentProjectAssignment }
        : {}),
      currentQuery: '',
      queryGeneration: 0,
      excludedThreadIds: new Set(input.excludedThreadIds ?? []),
      filesAvailable: target.filesAvailable,
      tasksAvailable: target.tasksAvailable,
      fileItems: [],
      taskItems: [],
      stopped: false
    }
    this.sessions.set(session.sessionId, session)
    return composerContextSearchStartResultSchema.parse({
      version: COMPOSER_CONTEXT_SEARCH_VERSION,
      sessionId: session.sessionId,
      hostId: session.hostId,
      filesAvailable: session.filesAvailable,
      tasksAvailable: session.tasksAvailable
    })
  }

  async update(
    ownerWebContentsId: number,
    input: ComposerContextSearchUpdateRequest
  ): Promise<void> {
    const session = this.requireOwnedSession(ownerWebContentsId, input.sessionId)
    const query = input.query.trim()
    const generation = ++session.queryGeneration
    session.currentQuery = query
    session.excludedThreadIds = new Set(input.excludedThreadIds ?? session.excludedThreadIds)

    if (!query) {
      this.publish(session, 'files', 'ready', [], true)
      this.publish(session, 'tasks', 'ready', [], true)
      return
    }

    if (!session.filesAvailable) {
      this.publish(
        session,
        'files',
        'error',
        [],
        true,
        session.hostId === 'local' ? '当前任务没有可搜索的文件目录' : '该主机暂不支持文件搜索'
      )
    } else {
      this.publish(session, 'files', 'loading', [], false)
      void this.updateFiles(session, query, generation)
    }

    if (!session.tasksAvailable) {
      this.publish(session, 'tasks', 'error', [], true, '该主机暂不支持任务搜索')
    } else {
      this.publish(session, 'tasks', 'loading', [], false)
      void this.updateTasks(session, query, generation)
    }
  }

  async stop(ownerWebContentsId: number, sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return
    const session = this.requireOwnedSession(ownerWebContentsId, sessionId)
    await this.stopSession(session)
  }

  async stopOwnedBy(ownerWebContentsId: number): Promise<void> {
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.ownerWebContentsId === ownerWebContentsId)
        .map((session) => this.stopSession(session))
    )
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => this.stopSession(session)))
  }

  private async resolveTarget(input: ComposerContextSearchStartRequest): Promise<SearchTarget> {
    if (input.threadId) {
      const target = await this.options.projectService.resolveExistingThreadTarget({
        conversationId: input.threadId,
        threadId: input.threadId
      })
      return target
        ? searchTargetFromExecutionTarget(target, input.threadId)
        : localTarget([], input.threadId)
    }

    const state = await this.options.projectStore.getState()
    const selection = input.projectSelection ?? state.activeProjectSelection
    if (!selection) {
      return localTarget(input.cwd ? [input.cwd] : [])
    }
    if (selection.projectKind === 'projectless') return localTarget([])

    const target = await this.options.projectService.resolveNewThreadTarget({
      selection,
      prompt: ''
    })
    return searchTargetFromExecutionTarget(target)
  }

  private async updateFiles(
    session: ActiveSession,
    query: string,
    generation: number
  ): Promise<void> {
    try {
      const fileSession = await this.getFileSession(session)
      if (!this.isCurrent(session, query, generation)) return
      await fileSession.update(query)
    } catch (error) {
      if (!this.isCurrent(session, query, generation)) return
      this.publish(session, 'files', 'error', [], true, errorMessage(error))
    }
  }

  private async updateTasks(
    session: ActiveSession,
    query: string,
    generation: number
  ): Promise<void> {
    try {
      const [searchResults, state] = await Promise.all([
        this.options.provider.searchThreads({ query, limit: 50 }),
        this.options.projectStore.getState()
      ])
      if (!this.isCurrent(session, query, generation)) return
      const items = mergeTaskResults({
        query,
        searchResults,
        snapshot: this.options.conversations.getConversationSnapshot(),
        state,
        roots: session.roots,
        currentThreadId: session.currentThreadId,
        currentProjectAssignment: session.currentProjectAssignment,
        excludedThreadIds: session.excludedThreadIds
      })
      this.publish(session, 'tasks', 'ready', items.slice(0, 50), true)
    } catch (error) {
      if (!this.isCurrent(session, query, generation)) return
      this.publish(session, 'tasks', 'error', [], true, errorMessage(error))
    }
  }

  private publish(
    session: ActiveSession,
    sectionId: 'files' | 'tasks',
    status: 'loading' | 'ready' | 'error',
    items: ComposerContextReference[] | undefined,
    complete: boolean,
    error?: string
  ): void {
    if (session.stopped) return
    const sectionItems = sectionId === 'files' ? session.fileItems : session.taskItems
    if (items) {
      sectionItems.splice(0, sectionItems.length, ...items)
    }
    this.options.publish(
      session.ownerWebContentsId,
      composerContextSearchSectionEventSchema.parse({
        version: COMPOSER_CONTEXT_SEARCH_VERSION,
        sessionId: session.sessionId,
        query: session.currentQuery,
        sectionId,
        status,
        items: items ?? sectionItems,
        complete,
        ...(error ? { error } : {})
      })
    )
  }

  private isCurrent(session: ActiveSession, query: string, generation: number): boolean {
    return (
      !session.stopped &&
      this.sessions.get(session.sessionId) === session &&
      session.currentQuery === query &&
      session.queryGeneration === generation
    )
  }

  private isCurrentQuery(session: ActiveSession, query: string): boolean {
    return (
      !session.stopped &&
      this.sessions.get(session.sessionId) === session &&
      session.currentQuery === query
    )
  }

  private requireOwnedSession(ownerWebContentsId: number, sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Composer context search session not found: ${sessionId}`)
    if (session.ownerWebContentsId !== ownerWebContentsId) {
      throw new Error('Composer context search session owner mismatch')
    }
    return session
  }

  private async getFileSession(session: ActiveSession): Promise<CodexFuzzyFileSearchSession> {
    session.fileSessionPromise ??= this.options.provider
      .createFuzzyFileSearchSession({
        roots: session.roots,
        onUpdated: (files, resultQuery) => {
          if (!this.isCurrentQuery(session, resultQuery)) return
          this.publish(
            session,
            'files',
            'ready',
            files.flatMap((file) => fileReference(file)).slice(0, 50),
            false
          )
        },
        onCompleted: (resultQuery) => {
          if (!this.isCurrentQuery(session, resultQuery)) return
          this.publish(session, 'files', 'ready', undefined, true)
        }
      })
      .then((fileSession) => {
        session.fileSession = fileSession
        return fileSession
      })
      .catch((error) => {
        session.fileSessionPromise = undefined
        throw error
      })
    return session.fileSessionPromise
  }

  private async stopSession(session: ActiveSession): Promise<void> {
    if (session.stopped) return
    session.stopped = true
    this.sessions.delete(session.sessionId)
    const fileSession =
      session.fileSession ?? (await session.fileSessionPromise?.catch(() => undefined))
    await fileSession?.stop()
  }
}

function searchTargetFromExecutionTarget(
  target: ResolvedExecutionTarget,
  currentThreadId?: string
): SearchTarget {
  if (target.hostId !== 'local') {
    return {
      hostId: target.hostId,
      roots: [],
      ...(currentThreadId ? { currentThreadId } : {}),
      ...(target.projectAssignment ? { currentProjectAssignment: target.projectAssignment } : {}),
      filesAvailable: false,
      tasksAvailable: false
    }
  }
  return localTarget(target.workspaceRoots, currentThreadId, target.projectAssignment)
}

function localTarget(
  roots: string[],
  currentThreadId?: string,
  currentProjectAssignment?: ThreadProjectAssignment
): SearchTarget {
  return {
    hostId: 'local',
    roots,
    ...(currentThreadId ? { currentThreadId } : {}),
    ...(currentProjectAssignment ? { currentProjectAssignment } : {}),
    filesAvailable: roots.length > 0,
    tasksAvailable: true
  }
}

function fileReference(file: FuzzyFileResult): ComposerContextReference[] {
  const absolutePath = safeAbsolutePath(file.root, file.path)
  if (!absolutePath) return []
  const kind = file.match_type === 'directory' ? 'folder' : 'file'
  return [
    {
      version: COMPOSER_CONTEXT_CATALOG_VERSION,
      kind,
      canonicalId: `${kind}:${absolutePath}`,
      label: file.file_name || basename(absolutePath),
      presentation: 'mention',
      path: absolutePath,
      root: file.root,
      score: file.score
    }
  ]
}

function safeAbsolutePath(root: string, path: string): string | null {
  const absoluteRoot = resolve(root)
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(absoluteRoot, path)
  const relativePath = relative(absoluteRoot, absolutePath)
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    return null
  }
  return absolutePath
}

function mergeTaskResults(input: {
  query: string
  searchResults: CodexTaskSearchResult[]
  snapshot: SidebarConversationListState
  state: ProjectState
  roots: string[]
  currentThreadId?: string
  currentProjectAssignment?: ThreadProjectAssignment
  excludedThreadIds: Set<string>
}): ComposerContextReference[] {
  const normalizedQuery = input.query.toLocaleLowerCase()
  const byThreadId = new Map<string, CodexTaskSearchResult>()
  for (const result of input.searchResults) {
    if (isSubagentResult(result)) continue
    byThreadId.set(result.threadId, result)
  }
  for (const conversation of input.snapshot.conversations) {
    const threadId = conversation.threadId
    if (!threadId || conversation.archived) continue
    const searchable = [conversation.title, conversation.cwd]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
    if (!searchable.includes(normalizedQuery) && !byThreadId.has(threadId)) continue
    const existing = byThreadId.get(threadId)
    byThreadId.set(threadId, {
      threadId,
      name: conversation.title ?? existing?.name,
      preview: existing?.preview,
      snippet: existing?.snippet,
      cwd: conversation.cwd ?? existing?.cwd,
      updatedAt: conversation.updatedAt ?? existing?.updatedAt ?? '',
      branch: existing?.branch,
      source: existing?.source ?? 'appServer',
      threadSource: existing?.threadSource,
      parentThreadId: existing?.parentThreadId,
      archived: conversation.archived ?? existing?.archived ?? false
    })
  }

  return [...byThreadId.values()]
    .filter(
      (task) =>
        !task.archived &&
        task.threadId !== input.currentThreadId &&
        !input.excludedThreadIds.has(task.threadId)
    )
    .sort((left, right) => compareTasks(left, right, input))
    .map(taskReference)
}

function compareTasks(
  left: CodexTaskSearchResult,
  right: CodexTaskSearchResult,
  input: {
    query: string
    roots: string[]
    state: ProjectState
    currentProjectAssignment?: ThreadProjectAssignment
  }
): number {
  const group = taskGroup(left, input) - taskGroup(right, input)
  if (group !== 0) return group
  const field = taskMatchRank(left, input.query) - taskMatchRank(right, input.query)
  if (field !== 0) return field
  return right.updatedAt.localeCompare(left.updatedAt)
}

function taskGroup(
  task: CodexTaskSearchResult,
  input: {
    roots: string[]
    state: ProjectState
    currentProjectAssignment?: ThreadProjectAssignment
  }
): number {
  const assignment = input.state.threadProjectAssignments[task.threadId]
  if (
    sameProject(assignment, input.currentProjectAssignment) ||
    input.roots.some((root) => task.cwd && isWithin(root, task.cwd))
  ) {
    return 0
  }
  if (
    assignment?.projectKind === 'projectless' ||
    input.state.projectlessThreadIds.includes(task.threadId)
  ) {
    return 1
  }
  return 2
}

function taskMatchRank(task: CodexTaskSearchResult, query: string): number {
  const normalized = query.toLocaleLowerCase()
  if ((task.name ?? task.preview ?? '').toLocaleLowerCase().includes(normalized)) return 0
  if ((task.snippet ?? '').toLocaleLowerCase().includes(normalized)) return 1
  if ((task.branch ?? '').toLocaleLowerCase().includes(normalized)) return 2
  if ((task.cwd ?? '').toLocaleLowerCase().includes(normalized)) return 3
  return 4
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function isSubagentResult(result: CodexTaskSearchResult): boolean {
  return (
    Boolean(result.parentThreadId) ||
    result.threadSource === 'subagent' ||
    result.threadSource === 'memory_consolidation' ||
    (typeof result.source === 'object' && result.source !== null && 'subAgent' in result.source)
  )
}

function sameProject(
  candidate: ThreadProjectAssignment | undefined,
  current: ThreadProjectAssignment | undefined
): boolean {
  if (!candidate || !current || candidate.projectKind !== current.projectKind) return false
  if (candidate.projectKind === 'local' && current.projectKind === 'local') {
    return candidate.projectId === current.projectId
  }
  if (candidate.projectKind === 'remote' && current.projectKind === 'remote') {
    return candidate.projectId === current.projectId && candidate.hostId === current.hostId
  }
  return false
}

function taskReference(task: CodexTaskSearchResult): ComposerContextReference {
  const label = task.name || task.preview || task.threadId
  return {
    version: COMPOSER_CONTEXT_CATALOG_VERSION,
    kind: 'chat',
    canonicalId: `chat:${task.threadId}`,
    label,
    presentation: 'mention',
    threadId: task.threadId,
    uri: `thread://${encodeURIComponent(task.threadId)}`,
    updatedAt: task.updatedAt,
    cwd: task.cwd ?? null,
    searchTitle: task.name ?? task.preview,
    snippet: task.snippet,
    gitBranch: task.branch,
    description: task.snippet ?? task.branch ?? task.cwd
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
