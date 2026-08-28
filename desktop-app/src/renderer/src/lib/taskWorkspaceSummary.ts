import type { ActiveConversationContext } from './ElectronIpcChatTransport'
import {
  buildAssistantRenderUnits,
  type McpSourceMetadata,
  type AssistantRenderUnit,
  type ToolItem,
  type SubagentActivityDisplayStatus
} from './assistantRenderUnits'
import {
  LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
  LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE
} from '../../../shared/composerContext'
import type { ConversationChatEntry } from '../runtime/ConversationChatRegistry'
import type {
  WorkspaceTaskAgent,
  WorkspaceOutputResource,
  WorkspaceSource,
  WorkspaceTaskSummary,
  WorkspaceTimelineEvent
} from '../components/workspace-container/taskWorkspaceTypes'

type TaskWorkspaceConversation = Pick<
  ConversationChatEntry,
  'context' | 'localId' | 'messages' | 'status' | 'threadGoal'
>

export function createTaskWorkspaceSummary(
  entry: TaskWorkspaceConversation,
  activeConversation: ActiveConversationContext | undefined
): WorkspaceTaskSummary {
  const units: AssistantRenderUnit[] = []
  const timeline: WorkspaceTimelineEvent[] = []
  const outputs: WorkspaceOutputResource[] = []
  const sources: WorkspaceSource[] = []
  const workspaceCwd = activeConversation?.cwd ?? entry.context.cwd ?? undefined
  const projectSelection = activeConversation?.projectSelection ?? entry.context.projectSelection
  const canOpenLocalPaths = projectSelection?.projectKind !== 'remote'
  entry.messages.forEach((message) => {
    sources.push(...sourcesFromUserAttachments(message))
    const text = message.parts
      .filter(
        (part): part is Extract<(typeof message.parts)[number], { type: 'text' }> =>
          part.type === 'text'
      )
      .map((part) => part.text)
      .join('\n')
      .trim()
    if (text) {
      timeline.push({
        id: `${message.renderId}:message`,
        type: message.role === 'user' ? 'user' : 'assistant',
        label: compactTimelineText(text)
      })
    }
    if (message.role !== 'assistant') return
    const parts = message.parts as unknown as readonly Record<string, unknown>[]
    const messageUnits = buildAssistantRenderUnits({
      content: parts,
      parts,
      metadata: message.metadata,
      workspaceCwd,
      canOpenLocalPaths
    }).units
    units.push(...messageUnits)
    timeline.push(...timelineEventsFromUnits(messageUnits))
    const messageOutputs = outputResourcesFromUnits(messageUnits)
    outputs.push(...messageOutputs)
    sources.push(...sourcesFromRenderUnits(messageUnits))
  })
  const conversationId =
    activeConversation?.conversationId ?? entry.context.conversationId ?? entry.localId
  const threadId = activeConversation?.threadId ?? entry.context.threadId
  return {
    conversationId,
    ...(threadId ? { threadId } : {}),
    title: activeConversation?.title,
    ...(projectSelection ? { projectSelection } : {}),
    ...(workspaceCwd ? { cwd: workspaceCwd } : {}),
    status: entry.status,
    messageCount: entry.messages.length,
    canOpenLocalPaths,
    goal: entry.threadGoal,
    agents: taskAgentsFromRenderUnits(units),
    timeline,
    outputs: deduplicateOutputResources(outputs),
    sources: deduplicateSources(sources)
  }
}

function sourcesFromRenderUnits(units: readonly AssistantRenderUnit[]): readonly WorkspaceSource[] {
  const sources: WorkspaceSource[] = []
  const visit = (unit: AssistantRenderUnit): void => {
    if (unit.type === 'reasoning-group') {
      unit.children.forEach(visit)
      return
    }
    if (unit.type === 'entry') {
      if (unit.itemType === 'source') {
        const source = sourceFromValue(unit.item)
        if (source) sources.push(source)
      }
      return
    }
    if (unit.type !== 'tool-group') return
    for (const item of unit.children) {
      sources.push(...sourcesFromToolItem(item))
    }
  }
  units.forEach(visit)
  return sources
}

function sourcesFromUserAttachments(
  message: TaskWorkspaceConversation['messages'][number]
): readonly WorkspaceSource[] {
  if (message.role !== 'user') return []

  const sources: WorkspaceSource[] = []
  for (const value of message.parts) {
    if (!isRecord(value) || value.type !== 'file') continue
    const mediaType = stringProperty(value.mediaType)
    if (mediaType !== LOCAL_FILE_ATTACHMENT_MEDIA_TYPE && mediaType !== LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE) {
      continue
    }
    const filename = stringProperty(value.filename)
    if (!filename) continue
    const url = stringProperty(value.url)
    sources.push({
      id: `user-file:${url ?? filename}`,
      sourceType: 'file',
      title: filename,
      ...(url ? { url } : {}),
      filename,
      mediaType,
      detail: mediaType === LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE ? '用户提供的文件夹' : '用户提供的文件',
      usageCount: 1
    })
  }
  return sources
}

function sourcesFromToolItem(item: ToolItem): readonly WorkspaceSource[] {
  const sources: WorkspaceSource[] = []
  const record = item.rawItem ?? recordValue(item.input)

  if (item.source) {
    sources.push(sourceFromMcpSource(item.source))
  }
  if (item.kind === 'webSearch') {
    const source = sourceFromWebSearch(record, item.input)
    if (source) sources.push(source)
  }
  if (item.kind === 'commandExecution' || item.kind === 'exec' || item.kind === 'exploration') {
    sources.push(...sourcesFromReadActions(record))
  }
  if (item.kind === 'fileChange') {
    sources.push(...sourcesFromFileChanges(record))
  }

  return sources
}

function sourceFromMcpSource(source: McpSourceMetadata): WorkspaceSource {
  const detail = [source.server, source.toolName].filter(isDefined).join(' · ')
  const resourceUri = source.sourceType === 'app' ? source.resourceUri : undefined
  return {
    id: `mcp:${source.groupKey}${resourceUri ? `:${resourceUri}` : ''}`,
    sourceType: source.sourceType === 'app' ? 'app' : 'mcp',
    title: source.label,
    ...(detail ? { detail } : {}),
    ...(source.server ? { mcpServer: source.server } : {}),
    ...(resourceUri ? { resourceUri } : {}),
    usageCount: 1
  }
}

function sourceFromWebSearch(
  item: Record<string, unknown> | undefined,
  input: unknown
): WorkspaceSource | undefined {
  const query = webSearchQuery(item) ?? webSearchQuery(recordValue(input))
  if (!query) return undefined
  return {
    id: `web-search:${query}`,
    sourceType: 'web-search',
    title: `Web 搜索：${query}`,
    detail: '搜索词',
    usageCount: 1
  }
}

function webSearchQuery(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined
  const directQuery = stringProperty(record.query)
  if (directQuery) return directQuery

  const action = recordValue(record.action)
  const actionQuery = stringProperty(action?.query)
  if (actionQuery) return actionQuery

  const argumentsRecord = recordValue(record.arguments) ?? recordValue(record.args)
  const argumentsQuery = stringProperty(argumentsRecord?.query)
  if (argumentsQuery) return argumentsQuery

  const searchQuery = firstRecord(record.search_query, recordValue(record.commands)?.search_query)
  return stringProperty(searchQuery?.q) ?? stringProperty(searchQuery?.query)
}

function sourcesFromReadActions(record: Record<string, unknown> | undefined): readonly WorkspaceSource[] {
  if (!record) return []
  const actions = arrayRecords(record.commandActions)
  const parsedCommand = recordValue(record.parsedCmd)
  const candidates = actions.length > 0 ? actions : parsedCommand ? [parsedCommand] : []
  return candidates.flatMap((action) => {
    const type = stringProperty(action.type)
    if (type !== 'read' && type !== 'readFile' && type !== 'read_file') return []
    const path =
      stringProperty(action.path) ??
      stringProperty(action.file) ??
      stringProperty(action.filename)
    return path ? [fileActivitySource(path, '已读取的文件')] : []
  })
}

function sourcesFromFileChanges(record: Record<string, unknown> | undefined): readonly WorkspaceSource[] {
  if (!record) return []
  return arrayRecords(record.changes).flatMap((change) => {
    const path =
      stringProperty(change.path) ??
      stringProperty(change.file) ??
      stringProperty(change.filename)
    if (!path) return []

    const changeKind = stringProperty(recordValue(change.kind)?.type) ?? stringProperty(change.kind)
    if (changeKind === 'delete' || changeKind === 'remove') return []
    const detail = changeKind === 'add' || changeKind === 'create' ? '已创建的文件' : '已更新的文件'
    return [fileActivitySource(path, detail)]
  })
}

function fileActivitySource(path: string, detail: string): WorkspaceSource {
  return {
    id: `file:${path}`,
    sourceType: 'file',
    title: filenameFromPath(path),
    filename: path,
    detail,
    usageCount: 1
  }
}

function filenameFromPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return normalized.split('/').filter(Boolean).pop() ?? path
}

function sourceFromValue(value: unknown): WorkspaceSource | undefined {
  if (!isRecord(value)) return undefined
  const sourceType = stringProperty(value.sourceType)
  if (sourceType !== 'url' && sourceType !== 'document') return undefined
  const url = stringProperty(value.url)
  const filename = stringProperty(value.filename)
  const title =
    stringProperty(value.title) ?? filename ?? (sourceType === 'url' ? '网页来源' : '文档来源')
  return {
    id: stringProperty(value.id) ?? `${sourceType}:${url ?? filename ?? title}`,
    sourceType,
    title,
    ...(url ? { url } : {}),
    ...(filename ? { filename } : {}),
    ...(stringProperty(value.mediaType) ? { mediaType: stringProperty(value.mediaType) } : {}),
    usageCount: 1
  }
}

function arrayRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    for (const entry of Array.isArray(value) ? value : []) {
      const record = recordValue(entry)
      if (record) return record
    }
  }
  return undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function deduplicateSources(sources: readonly WorkspaceSource[]): readonly WorkspaceSource[] {
  const unique = new Map<string, WorkspaceSource>()
  for (const source of sources) {
    const key = `${source.sourceType}:${source.url ?? source.filename ?? source.resourceUri ?? source.id}`
    const existing = unique.get(key)
    unique.set(
      key,
      existing ? { ...existing, usageCount: existing.usageCount + source.usageCount } : source
    )
  }
  return [...unique.values()]
}

function outputResourcesFromUnits(
  units: readonly AssistantRenderUnit[]
): readonly WorkspaceOutputResource[] {
  const resources: WorkspaceOutputResource[] = []
  const visit = (unit: AssistantRenderUnit): void => {
    if (unit.type === 'reasoning-group') {
      unit.children.forEach(visit)
      return
    }
    if (unit.type !== 'entry' || unit.itemType !== 'endResources') return
    const values = unit.item?.resources ?? unit.item?.items
    if (!Array.isArray(values)) return
    for (const value of values) {
      const resource = outputResourceFromValue(value)
      if (resource) resources.push(resource)
    }
  }
  units.forEach(visit)
  return resources
}

function outputResourceFromValue(value: unknown): WorkspaceOutputResource | undefined {
  if (!isRecord(value)) return undefined
  const type = value.type
  if (type !== 'file' && type !== 'website' && type !== 'google-drive' && type !== 'appgen-app') {
    return undefined
  }
  const title = stringProperty(value.title)
  if (!title) return undefined
  const path = stringProperty(value.path)
  const url = stringProperty(value.url)
  if (!path && !url) return undefined
  return {
    id: `${type}:${path ?? url}`,
    type,
    title,
    ...(path ? { path } : {}),
    ...(url ? { url } : {}),
    ...(positiveInteger(value.line) ? { line: positiveInteger(value.line) } : {}),
    ...(stringProperty(value.cwd) ? { cwd: stringProperty(value.cwd) } : {})
  }
}

function deduplicateOutputResources(
  resources: readonly WorkspaceOutputResource[]
): readonly WorkspaceOutputResource[] {
  const unique = new Map<string, WorkspaceOutputResource>()
  for (const resource of resources) unique.set(resource.id, resource)
  return [...unique.values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function timelineEventsFromUnits(
  units: readonly AssistantRenderUnit[]
): readonly WorkspaceTimelineEvent[] {
  const events: WorkspaceTimelineEvent[] = []
  const visit = (unit: AssistantRenderUnit): void => {
    if (unit.type === 'reasoning-group') {
      unit.children.forEach(visit)
      return
    }
    if (unit.type === 'tool-group' && unit.summary?.label) {
      events.push({
        id: `activity:${unit.key}`,
        type: 'activity',
        label: unit.summary.label,
        status: toolStatusLabel(unit.status)
      })
      return
    }
    if (unit.type === 'subagent-activity-group') {
      for (const agent of unit.agents) {
        events.push({
          id: `subagent:${agent.eventId}`,
          type: 'subagent',
          label: `${agent.displayName}：${subagentStatusLabel(agent.displayStatus)}`
        })
      }
    }
  }
  units.forEach(visit)
  return events
}

function compactTimelineText(text: string): string {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized
}

function toolStatusLabel(status: string): string {
  if (status === 'running') return '正在运行'
  if (status === 'error') return '失败'
  if (status === 'requires-action') return '需要处理'
  return '已完成'
}

function subagentStatusLabel(status: SubagentActivityDisplayStatus): string {
  if (status === 'finished') return '已完成'
  if (status === 'interrupted') return '已中断'
  if (status === 'updated') return '已更新'
  return '正在工作'
}

/**
 * Retains the latest activity record for every subagent so a task workspace
 * can present one current row per agent instead of replaying the transcript.
 */
export function taskAgentsFromRenderUnits(
  units: readonly AssistantRenderUnit[]
): readonly WorkspaceTaskAgent[] {
  const agents = new Map<string, WorkspaceTaskAgent>()

  const visit = (unit: AssistantRenderUnit): void => {
    if (unit.type === 'subagent-activity-group') {
      for (const agent of unit.agents) {
        const key = agent.threadId ?? agent.agentPath ?? agent.eventId
        const previous = agents.get(key)
        const model = agent.model ?? previous?.model
        agents.set(key, {
          ...agent,
          ...(model ? { model } : {})
        })
      }
      return
    }
    if (unit.type === 'reasoning-group') {
      unit.children.forEach(visit)
    }
  }

  units.forEach(visit)
  return [...agents.values()]
}
