import { pendingAssistantMessageText } from './assistantMessages'
import { parseCodeCommentDirectives, type CodeComment } from './codeCommentDirectives'
import {
  extractToolInput,
  extractThreadItem,
  isActiveStatus,
  isToolPartActive,
  summarizeToolGroup,
  type ToolGroupSummary
} from './toolGroupSummary'
import { ENTRY_ITEM_RENDER_MODES, type EntryRenderMode } from './renderUnitCapabilityMatrix'

type AssistantMessagePart = Record<string, unknown>

export type AssistantRenderDetailLevel = 'default' | 'stepsProse'
export type AssistantMessagePhase = 'commentary' | 'final_answer'
export type ReasoningGroupState = 'thinking' | 'blocked' | 'completed'

type AssistantMessageLike = {
  status?: { type?: string }
  content: readonly AssistantMessagePart[]
  parts?: readonly AssistantMessagePart[]
  textPhases?: readonly (AssistantMessagePhase | undefined)[]
  hasBlockingRequest?: boolean
  processDurationMs?: number
  detailLevel?: AssistantRenderDetailLevel
  workspaceCwd?: string
  canOpenLocalPaths?: boolean
  metadata?: unknown
}

type AssistantActivityPhase =
  | 'inactive'
  | 'blocked'
  | 'showing-text'
  | 'exploring'
  | 'planning'
  | 'active-activity'
  | 'thinking'

type ThinkingPresentation =
  | { type: 'hidden' }
  | { type: 'tool-group'; unitKey: string }
  | { type: 'standalone' }

type AssistantActivityContext = {
  isRunning: boolean
  hasBlockingRequest: boolean
}

export type AssistantRenderTarget = {
  id: string
  itemIds: readonly string[]
}

export type McpSourceMetadata = {
  groupKey: string
  sourceType: 'app' | 'server' | 'browser' | 'computer-use' | 'node-repl'
  label: string
  server?: string
  appKey?: string
  resourceUri?: string
  pluginId?: string
  toolName?: string
  callIds: readonly string[]
  hasAppMetadata: boolean
}

export type DynamicToolMetadata = {
  summaryOnlyInConversationGroup: boolean
  standaloneInConversation: boolean
  continuesLiveActivityBetweenCalls: boolean
  completedSummaryKey?: string
  repeatCount: number
  hasRegistryMetadata: boolean
  displayLabels: readonly DynamicToolDisplayLabel[]
}

export type DynamicToolDisplayLabel = {
  key: string
  activeLabel: string
  completedLabel: string
  count: number
  callIds: readonly string[]
  hasRegistryMetadata: boolean
}

export type ToolGroupKind =
  | 'composite'
  | 'exploration'
  | 'web-search'
  | 'mcp'
  | 'dynamic'
  | 'multi-agent'
  | 'command'
  | 'file-change'
  | 'generic'

export type ToolItemStatus = 'running' | 'complete' | 'error' | 'requires-action'

export type ToolItem = {
  id: string
  kind: string
  status: ToolItemStatus
  label?: string
  source?: McpSourceMetadata
  input?: unknown
  output?: unknown
  error?: unknown
  rawPart: AssistantMessagePart
  rawItem?: Record<string, unknown>
  partIndex: number
  dynamicMetadata?: DynamicToolMetadata
  action?: string
  receiverAgents?: readonly MultiAgentReceiverAgent[]
}

export type SubagentActivityDisplayStatus = 'active' | 'updated' | 'finished' | 'interrupted'

export type SubagentActivityAgent = {
  threadId?: string
  eventId: string
  agentPath: string
  displayName: string
  displayStatus: SubagentActivityDisplayStatus
}

export type MultiAgentReceiverAgent = {
  threadId: string
  displayName: string
  status?: string
  message?: string
}

export type AssistantRenderUnitBase = {
  key: string
  partIndices: readonly number[]
  target: AssistantRenderTarget
  itemType?: string
  active?: boolean
  summary?: ToolGroupSummary
  showThinkingFallback?: boolean
}

export type AssistantRenderUnit =
  | (AssistantRenderUnitBase & { type: 'message-thinking'; partIndices: readonly [] })
  | (AssistantRenderUnitBase & {
      type: 'text'
      partIndex: number
      text: string
      phase?: AssistantMessagePhase
      streaming?: boolean
    })
  | (AssistantRenderUnitBase & {
      type: 'review-comments'
      comments: readonly CodeComment[]
      workspaceCwd?: string
      canOpenLocalPaths: boolean
    })
  | (AssistantRenderUnitBase & {
      type: 'reasoning-group'
      children: readonly AssistantRenderUnit[]
      durationMs?: number
      state: ReasoningGroupState
      turnRunning: boolean
    })
  | (AssistantRenderUnitBase & {
      type: 'entry'
      partIndex: number
      part: AssistantMessagePart
      item?: Record<string, unknown>
      itemType?: string
      mcpSource?: McpSourceMetadata
      dynamicMetadata?: DynamicToolMetadata
      renderMode: EntryRenderMode
    })
  | (AssistantRenderUnitBase & { type: 'unknown'; partIndex: number; part: AssistantMessagePart })
  | (AssistantRenderUnitBase & {
      type: 'tool-group'
      kind: ToolGroupKind
      status: ToolItemStatus
      parts: readonly AssistantMessagePart[]
      children: readonly ToolItem[]
      mcpSource?: McpSourceMetadata
      dynamicMetadata?: DynamicToolMetadata
      action?: string
      summaryOnly?: boolean
    })
  | (AssistantRenderUnitBase & {
      type: 'subagent-activity-group'
      agents: readonly SubagentActivityAgent[]
      status: SubagentActivityDisplayStatus
    })

export type AssistantRenderModel = {
  units: readonly AssistantRenderUnit[]
  isThinkingOnly: boolean
}

type NormalizedPart =
  | {
      kind: 'text'
      partIndex: number
      part: AssistantMessagePart
      text: string
      phase?: AssistantMessagePhase
    }
  | {
      kind: 'entry'
      partIndex: number
      part: AssistantMessagePart
      item: Record<string, unknown>
      itemType: string
    }
  | {
      kind: 'tool'
      partIndex: number
      part: AssistantMessagePart
      item?: Record<string, unknown>
      itemType?: string
      toolName?: string
      callId?: string
      action?: string
      mcpSource?: McpSourceMetadata
      dynamicMetadata?: DynamicToolMetadata
    }
  | { kind: 'unknown'; partIndex: number; part: AssistantMessagePart }

type GroupableUnit =
  | {
      type: 'text'
      partIndex: number
      partIndices: readonly number[]
      text: string
      phase?: AssistantMessagePhase
    }
  | {
      type: 'entry'
      partIndex: number
      partIndices: readonly number[]
      part: AssistantMessagePart
      parts?: readonly AssistantMessagePart[]
      item?: Record<string, unknown>
      itemType?: string
      toolName?: string
      callId?: string
      action?: string
      mcpSource?: McpSourceMetadata
      dynamicMetadata?: DynamicToolMetadata
    }
  | {
      type: 'unknown'
      partIndex: number
      partIndices: readonly number[]
      part: AssistantMessagePart
    }
  | {
      type: 'tool-group-candidate'
      kind: ToolGroupKind
      partIndices: readonly number[]
      parts: readonly AssistantMessagePart[]
      mcpSource?: McpSourceMetadata
      dynamicMetadata?: DynamicToolMetadata
      action?: string
    }
  | {
      type: 'subagent-activity-group'
      partIndices: readonly number[]
      parts: readonly AssistantMessagePart[]
      anchorEventId: string
      agents: readonly SubagentActivityAgent[]
      status: SubagentActivityDisplayStatus
    }

type ToolGroupableUnit = GroupableUnit & {
  parts?: readonly AssistantMessagePart[]
}

type EntryGroupableUnit = Extract<GroupableUnit, { type: 'entry' }>

type ExplorationActionKind = 'read' | 'list' | 'search'

type ExplorationAction = {
  type: ExplorationActionKind
  label?: string
  path?: string
  query?: string
  command?: string
}

const STEPS_PROSE_HIDDEN_ACTIVITY_TYPES = new Set([
  'contextCompaction',
  'context-compaction',
  'hookPrompt',
  'hook-prompt',
  'loadedTool',
  'loaded-tool',
  'sleep'
])

const WEB_SEARCH_ITEM_TYPES = new Set(['webSearch', 'web-search'])
const DYNAMIC_ITEM_TYPES = new Set(['dynamicToolCall', 'dynamic-tool-call'])
const MCP_ITEM_TYPES = new Set(['mcpToolCall', 'mcp-tool-call'])
const LOADED_TOOL_ITEM_TYPES = new Set(['loadedTool', 'loaded-tool'])
const MULTI_AGENT_ITEM_TYPES = new Set([
  'collabAgentToolCall',
  'collabToolCall',
  'multi-agent-action'
])
const SUBAGENT_ACTIVITY_ITEM_TYPES = new Set(['subAgentActivity', 'subagent-activity'])
const THINKING_FALLBACK_TOOL_GROUP_KINDS = new Set<ToolGroupKind>([
  'composite',
  'command',
  'file-change',
  'generic',
  'mcp',
  'dynamic'
])
const END_RESOURCE_SOURCE_FILE_EXTENSIONS = new Set([
  'bash',
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'cxx',
  'fish',
  'go',
  'gql',
  'graphql',
  'h',
  'html',
  'hpp',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'less',
  'mjs',
  'php',
  'ps1',
  'py',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'zsh'
])
const WEBSITE_FILE_EXTENSIONS = new Set(['htm', 'html'])
type SubagentRenderContext = {
  displayNamesByThreadId: ReadonlyMap<string, string>
  activityStatusesByPartIndex: ReadonlyMap<number, SubagentActivityDisplayStatus>
}

type DerivedEndResource = {
  type: 'file' | 'website' | 'google-drive' | 'appgen-app'
  path?: string
  url?: string
  title: string
  line?: number
  cwd?: string
}

type SubagentActivityNormalizedPart = Extract<NormalizedPart, { kind: 'tool' | 'entry' }> & {
  itemType: 'subAgentActivity' | 'subagent-activity'
}

const KNOWN_DYNAMIC_TOOL_METADATA: Record<
  string,
  {
    activeLabel: string
    completedLabel: string
    completedSummaryKey?: string
    standaloneInConversation?: boolean
  }
> = {
  load_workspace_dependencies: {
    activeLabel: '正在加载工作区依赖',
    completedLabel: '已加载工作区依赖',
    standaloneInConversation: true
  },
  pia_slackbot_dm: { activeLabel: 'Pia Slackbot DM', completedLabel: 'Pia Slackbot DM' },
  read_thread_terminal: {
    activeLabel: '正在读取线程终端',
    completedLabel: '已读取线程终端',
    standaloneInConversation: true
  }
}

export function buildAssistantRenderUnits(message: AssistantMessageLike): AssistantRenderModel {
  const parts = message.parts ?? message.content
  const isRunning = message.status?.type === 'running'
  const detailLevel = message.detailLevel ?? 'default'
  const normalized = normalizeParts(parts, isRunning, message.textPhases)
  const subagentContext = buildSubagentRenderContext(normalized)
  const visibleParts = normalized.filter((part) => !isWaitingMultiAgentPart(part))
  const preGrouped = groupWebSearchAndMultiAgent(visibleParts, subagentContext)
  const dynamicGrouped = groupDynamicToolCalls(preGrouped)
  const mcpGrouped = groupPendingMcpToolCalls(dynamicGrouped)
  const activityCollapsed = groupAdjacentToolActivity(mcpGrouped, { detailLevel })
  const visibleUnits = activityCollapsed.map((unit, index) =>
    toRenderUnit(unit, index, isRunning, subagentContext)
  )
  const { processUnits, completedTurnDiffs } = partitionCompletedTurnDiffs(visibleUnits, isRunning)
  const groupedUnits = groupAssistantProcess(processUnits, isRunning, message.processDurationMs)
  const orderedUnits = [...groupedUnits, ...completedTurnDiffs]
  const unitsWithThinking = applyThinkingPresentation(orderedUnits, {
    isRunning,
    hasBlockingRequest: message.hasBlockingRequest === true
  })
  const unitsWithReviewComments = deriveReviewCommentsUnit(
    unitsWithThinking,
    message.status?.type === undefined || message.status.type === 'complete',
    message.workspaceCwd,
    message.canOpenLocalPaths !== false
  )
  const units = deriveEndResourcesUnit(
    unitsWithReviewComments,
    normalized,
    message.status?.type === undefined || message.status.type === 'complete',
    message.workspaceCwd,
    message.canOpenLocalPaths !== false,
    message.metadata
  )

  return { isThinkingOnly: units.length === 1 && units[0]?.type === 'message-thinking', units }
}

function partitionCompletedTurnDiffs(
  units: readonly AssistantRenderUnit[],
  isRunning: boolean
): {
  processUnits: readonly AssistantRenderUnit[]
  completedTurnDiffs: readonly AssistantRenderUnit[]
} {
  if (isRunning) return { processUnits: units, completedTurnDiffs: [] }

  const completedTurnDiffs: AssistantRenderUnit[] = []
  const processUnits: AssistantRenderUnit[] = []

  for (const unit of units) {
    if (isCompletedTurnDiffEntry(unit)) {
      completedTurnDiffs.push(unit)
    } else {
      processUnits.push(unit)
    }
  }

  return { processUnits, completedTurnDiffs }
}

function isCompletedTurnDiffEntry(
  unit: AssistantRenderUnit
): unit is Extract<AssistantRenderUnit, { type: 'entry' }> {
  return unit.type === 'entry' && unit.itemType === 'turnDiff' && unit.item?.status === 'completed'
}

function deriveEndResourcesUnit(
  units: readonly AssistantRenderUnit[],
  parts: readonly NormalizedPart[],
  shouldDerive: boolean,
  workspaceCwd: string | undefined,
  canOpenLocalPaths: boolean,
  metadata: unknown
): AssistantRenderUnit[] {
  if (
    !shouldDerive ||
    units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
  ) {
    return [...units]
  }

  const { resources, sourcePartIndices, sourceItemIds } = deriveEndResources(
    parts,
    workspaceCwd,
    metadata,
    canOpenLocalPaths
  )
  if (resources.length === 0) return [...units]

  return [
    ...units,
    {
      type: 'entry',
      key: 'end-resources:generated-files',
      partIndex: sourcePartIndices.at(-1) ?? 0,
      partIndices: sourcePartIndices,
      target: {
        id: 'end-resources:generated-files',
        itemIds: sourceItemIds
      },
      part: { type: 'endResources' },
      item: {
        id: 'end-resources:generated-files',
        type: 'endResources',
        status: 'completed',
        resources
      },
      itemType: 'endResources',
      renderMode: 'custom',
      active: false,
      showThinkingFallback: false
    }
  ]
}

function deriveEndResources(
  parts: readonly NormalizedPart[],
  workspaceCwd: string | undefined,
  metadata: unknown,
  canOpenLocalPaths: boolean
): {
  resources: readonly DerivedEndResource[]
  sourcePartIndices: readonly number[]
  sourceItemIds: readonly string[]
} {
  const resourcesByKey = new Map<string, DerivedEndResource>()
  const sourcePartIndices: number[] = []
  const sourceItemIds = new Set<string>()
  const externalUrls = new Set<string>()

  for (const resource of artifactResourcesFromMetadata(metadata, workspaceCwd)) {
    addEndResource(resourcesByKey, resource)
  }

  for (const part of parts) {
    if (part.kind === 'text') {
      const textResources = endResourcesFromAssistantText(part.text, workspaceCwd)
      for (const resource of textResources.resources) {
        addEndResource(resourcesByKey, resource)
      }
      for (const url of textResources.externalUrls) externalUrls.add(url)
      if (textResources.resources.length > 0 || textResources.externalUrls.length > 0) {
        sourcePartIndices.push(part.partIndex)
        const textPartId = stringValue(part.part.id)
        if (textPartId) sourceItemIds.add(textPartId)
      }
      continue
    }

    if (part.kind !== 'tool' || !part.item || isFailedToolPart(part.part, part.item)) continue

    const resources =
      part.itemType === 'fileChange'
        ? arrayValue(part.item.changes)
            .map((change) => endResourceForFileChange(change, workspaceCwd))
            .filter(isDefined)
        : [endResourceForMcpItem(part.item)]
    const artifactResources = artifactResourcesFromPart(part, workspaceCwd)
    resources.push(...artifactResources)
    for (const resource of resources) {
      addEndResource(resourcesByKey, resource)
    }

    const urls = externalUrlsFromRecord(part.item)
    for (const url of urls) externalUrls.add(url)
    if (resources.length === 0 && urls.length === 0) continue
    sourcePartIndices.push(part.partIndex)
    const itemId = stringValue(part.item.id)
    if (itemId) sourceItemIds.add(itemId)
  }

  for (const url of externalUrls) {
    addEndResource(resourcesByKey, endResourceForHttpUrl(url))
  }

  const resources = [...resourcesByKey.values()].filter(
    (resource) => canOpenLocalPaths || !resource.path
  )
  resources.sort((left, right) => {
    const rank = { 'appgen-app': 0, website: 1, file: 2, 'google-drive': 3 }
    const typeOrder = rank[left.type] - rank[right.type]
    if (typeOrder !== 0) return typeOrder
    return (left.path ?? left.url ?? left.title).localeCompare(
      right.path ?? right.url ?? right.title
    )
  })

  return { resources, sourcePartIndices, sourceItemIds: [...sourceItemIds] }
}

function addEndResource(
  resourcesByKey: Map<string, DerivedEndResource>,
  resource: DerivedEndResource | undefined
): void {
  if (!resource) return
  const key = resourceKey(resource)
  if (!resourcesByKey.has(key)) resourcesByKey.set(key, resource)
}

function resourceKey(resource: DerivedEndResource): string {
  const value = resource.path ?? resource.url ?? resource.title
  return `${resource.type}:${value.replace(/\\/g, '/')}`
}

function endResourcesFromAssistantText(
  text: string,
  workspaceCwd: string | undefined
): { resources: DerivedEndResource[]; externalUrls: string[] } {
  const resources: DerivedEndResource[] = []
  const externalUrls = new Set<string>()
  for (const link of markdownLinksOutsideCodeFences(text)) {
    const destination = link.destination
    const googleDriveUrl = googleDriveUrlFor(destination)
    if (googleDriveUrl) {
      resources.push({
        type: 'google-drive',
        url: googleDriveUrl,
        title: link.label || googleDriveUrl
      })
      continue
    }

    const websiteUrl = websitePreviewUrlFor(destination)
    if (websiteUrl) {
      externalUrls.add(websiteUrl)
      continue
    }

    const localPath = localMarkdownPath(destination)
    const resource = localPath
      ? endResourceForPath(localPath.path, workspaceCwd, link.label, false, localPath.line)
      : undefined
    if (resource) resources.push(resource)
  }

  for (const inlineCode of inlineCodeSpansOutsideCodeFences(text)) {
    const localPath = localMarkdownPath(inlineCode)
    const resource = localPath
      ? endResourceForPath(localPath.path, workspaceCwd, undefined, false, localPath.line)
      : undefined
    if (resource) resources.push(resource)
  }

  for (const url of text.match(/https?:\/\/[^\s<>)"'`]+/gi) ?? []) {
    const normalizedUrl = trimUrlPunctuation(url)
    const googleDriveUrl = googleDriveUrlFor(normalizedUrl)
    if (googleDriveUrl) {
      resources.push({
        type: 'google-drive',
        url: googleDriveUrl,
        title: websiteTitle(googleDriveUrl)
      })
      continue
    }
    const websiteUrl = websitePreviewUrlFor(normalizedUrl)
    if (websiteUrl) externalUrls.add(websiteUrl)
  }

  return { resources, externalUrls: [...externalUrls] }
}

function markdownLinksOutsideCodeFences(text: string): { label: string; destination: string }[] {
  const links: { label: string; destination: string }[] = []
  let inFence = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const linkPattern = /!?\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g
    for (const match of line.matchAll(linkPattern)) {
      const label = match[1]?.trim() ?? ''
      const destination = match[2]?.replace(/^<|>$/g, '')
      if (destination) links.push({ label, destination })
    }
  }
  return links
}

function inlineCodeSpansOutsideCodeFences(text: string): string[] {
  const spans: string[] = []
  let inFence = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^ {0,3}(`{3,}|~{3,})/u.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    for (const match of line.matchAll(/(`+)([^`]+?)\1/g)) {
      const value = match[2]?.trim()
      if (value) spans.push(value)
    }
  }
  return spans
}

function decodeMarkdownDestination(destination: string): string {
  try {
    return decodeURIComponent(destination)
  } catch {
    return destination
  }
}

function trimUrlPunctuation(value: string): string {
  return value.replace(/[.,;!?]+$/u, '')
}

function localMarkdownPath(destination: string): { path: string; line?: number } | undefined {
  let path: string
  if (destination.startsWith('file://')) {
    try {
      const url = new URL(destination)
      if (url.protocol !== 'file:') return undefined
      path = decodeURIComponent(url.pathname)
    } catch {
      return undefined
    }
  } else {
    if (hasUrlScheme(destination)) return undefined
    path = decodeMarkdownDestination(destination.split(/[?#]/u, 1)[0] ?? '')
  }

  const match = path.match(/^(.*):(\d+)$/u)
  const line = match?.[2] ? Number.parseInt(match[2], 10) : undefined
  return {
    path: match?.[1] ?? path,
    ...(line && line > 0 ? { line } : {})
  }
}

function googleDriveUrlFor(value: string): string | undefined {
  const url = externalHttpUrlValue(value)
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.toLowerCase()
    return /(?:^|\.)google(?:usercontent)?\.com$/u.test(host) ||
      /(?:^|\.)(?:drive|docs|sheets|slides)\.google\.com$/u.test(host)
      ? url
      : undefined
  } catch {
    return undefined
  }
}

function externalHttpUrlValue(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function websitePreviewUrlFor(value: string): string | undefined {
  return externalHttpUrlValue(value)
}

function endResourceForPath(
  path: string | undefined,
  workspaceCwd: string | undefined,
  title?: string,
  allowMarkdown = true,
  line?: number
): DerivedEndResource | undefined {
  if (!path) return undefined
  const openTarget = endResourceOpenTarget(path, workspaceCwd)
  if (!openTarget) return undefined
  const extension = fileExtension(path)
  if (!extension || END_RESOURCE_SOURCE_FILE_EXTENSIONS.has(extension)) return undefined
  if (!allowMarkdown && (extension === 'md' || extension === 'mdx')) return undefined
  return {
    type: WEBSITE_FILE_EXTENSIONS.has(extension) ? 'website' : 'file',
    title: title || resourceTitle(path),
    ...(line ? { line } : {}),
    ...openTarget
  }
}

function endResourceForMcpItem(item: Record<string, unknown>): DerivedEndResource | undefined {
  const result = recordValue(item.result)
  const structuredContent =
    recordValue(result?.structuredContent) ?? recordValue(item.structuredContent)
  if (!structuredContent) return undefined
  const url = [
    stringValue(structuredContent.current_live_url),
    stringValue(structuredContent.current_preview_url),
    stringValue(structuredContent.deployment_url),
    stringValue(structuredContent.url)
  ]
    .map((value) => externalHttpUrlValue(value ?? ''))
    .find(isDefined)
  if (!url) return undefined
  if (!isAppgenMcpItem(item)) return endResourceForHttpUrl(url)
  return {
    type: 'appgen-app',
    url,
    title: stringValue(structuredContent.title)?.trim() || 'Generated app'
  }
}

function endResourceForHttpUrl(url: string): DerivedEndResource {
  const googleDriveUrl = googleDriveUrlFor(url)
  return googleDriveUrl
    ? { type: 'google-drive', url: googleDriveUrl, title: websiteTitle(googleDriveUrl) }
    : { type: 'website', url, title: websiteTitle(url) }
}

function isAppgenMcpItem(item: Record<string, unknown>): boolean {
  const server = stringValue(item.server)?.toLowerCase()
  const tool = stringValue(item.tool)?.toLowerCase() ?? ''
  return server === 'sites' || tool.startsWith('sites_') || tool.startsWith('codex_apps__sites_')
}

function artifactResourcesFromPart(
  part: Extract<NormalizedPart, { kind: 'tool' }>,
  workspaceCwd: string | undefined
): DerivedEndResource[] {
  const candidates = [part.part, part.item]
    .flatMap((value) => {
      const record = recordValue(value)
      const artifacts = recordValue(record?.artifacts)
      return [
        ...arrayValue(artifacts?.editedFilePaths),
        ...arrayValue(artifacts?.referencedFilePaths),
        ...arrayValue(record?.editedFilePaths),
        ...arrayValue(record?.referencedFilePaths)
      ]
    })
    .map(stringValue)
    .filter(isDefined)
  const diffPaths = [
    ...arrayValue(part.item?.patchBatches).flatMap((batch) => {
      const record = recordValue(batch)
      return diffPathsFromUnifiedDiff(stringValue(record?.diff))
    }),
    ...diffPathsFromUnifiedDiff(stringValue(part.item?.diff))
  ]
  return [...candidates, ...diffPaths]
    .map((path) => endResourceForPath(path, workspaceCwd))
    .filter(isDefined)
}

function artifactResourcesFromMetadata(
  metadata: unknown,
  workspaceCwd: string | undefined
): DerivedEndResource[] {
  const record = recordValue(metadata)
  const candidates = [record, recordValue(record?.artifacts), recordValue(record?.codexArtifacts)]
    .flatMap((value) => [
      ...arrayValue(value?.editedFilePaths),
      ...arrayValue(value?.referencedFilePaths),
      ...arrayValue(value?.files)
    ])
    .map((value) => {
      const file = recordValue(value)
      return stringValue(file?.path) ?? stringValue(value)
    })
    .filter(isDefined)
  return candidates.map((path) => endResourceForPath(path, workspaceCwd)).filter(isDefined)
}

function diffPathsFromUnifiedDiff(diff: string | undefined): string[] {
  if (!diff) return []
  const paths: string[] = []
  for (const line of diff.split(/\r?\n/u)) {
    const match = line.match(/^\+\+\+ (.*?)(?:\t.*)?$/u)
    const path = match?.[1]?.replace(/^[ab]\//u, '')
    if (path && path !== '/dev/null') paths.push(path)
  }
  return paths
}

function externalUrlsFromRecord(item: Record<string, unknown>): string[] {
  return [
    stringValue(item.url),
    stringValue(item.current_live_url),
    stringValue(item.current_preview_url),
    stringValue(item.deployment_url)
  ]
    .map((value) => externalHttpUrlValue(value ?? ''))
    .filter(isDefined)
}

function websiteTitle(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'Website'
  }
}

function endResourceForFileChange(
  value: unknown,
  workspaceCwd: string | undefined
): DerivedEndResource | undefined {
  const change = recordValue(value)
  const kind = recordValue(change?.kind)
  if (stringValue(kind?.type) === 'delete') return undefined

  const path =
    (stringValue(kind?.type) === 'update' ? stringValue(kind?.move_path) : undefined) ??
    stringValue(change?.path)
  if (!path) return undefined

  return endResourceForPath(path, workspaceCwd)
}

function isFailedToolPart(part: AssistantMessagePart, item: Record<string, unknown>): boolean {
  const partStatus = recordValue(part.status)
  const result = recordValue(part.result) ?? recordValue(part.output)
  return (
    ['failed', 'declined', 'cancelled', 'error', 'output-error'].includes(
      stringValue(item.status) ?? ''
    ) ||
    ['error', 'output-error'].includes(stringValue(partStatus?.type) ?? '') ||
    part.isError === true ||
    result?.isError === true ||
    item.success === false ||
    recordValue(item.error) !== undefined
  )
}

function endResourceOpenTarget(
  path: string,
  workspaceCwd: string | undefined
): { path: string; cwd?: string } | undefined {
  if (isAbsoluteLocalPath(path)) {
    return isAbsoluteLocalPath(workspaceCwd ?? '') ? { path, cwd: workspaceCwd } : { path }
  }
  if (!isSafeRelativeLocalPath(path) || !isAbsoluteLocalPath(workspaceCwd ?? '')) return undefined
  return { path, cwd: workspaceCwd }
}

function isAbsoluteLocalPath(path: string): boolean {
  return (path.startsWith('/') && !path.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(path)
}

function isSafeRelativeLocalPath(path: string): boolean {
  if (!path || path.includes('\0') || path.startsWith('\\') || hasUrlScheme(path)) return false
  const segments = path.replace(/\\/g, '/').split('/')
  return !segments.some((segment) => segment === '.' || segment === '..')
}

function fileExtension(path: string): string | undefined {
  const fileName = resourceTitle(path)
  const separator = fileName.lastIndexOf('.')
  if (separator <= 0 || separator === fileName.length - 1) return undefined
  return fileName.slice(separator + 1).toLowerCase()
}

function resourceTitle(path: string): string {
  const normalizedPath = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1) || path
}

function hasUrlScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value)
}

function deriveReviewCommentsUnit(
  units: readonly AssistantRenderUnit[],
  shouldParse: boolean,
  workspaceCwd: string | undefined,
  canOpenLocalPaths: boolean
): AssistantRenderUnit[] {
  if (!shouldParse) return [...units]

  const comments: CodeComment[] = []
  const commentKeys = new Set<string>()
  const sourcePartIndices: number[] = []
  const visibleUnits = units.flatMap((unit): AssistantRenderUnit[] => {
    if (unit.type !== 'text' || unit.phase === 'commentary') return [unit]

    const parsed = parseCodeCommentDirectives(unit.text)
    if (parsed.comments.length === 0) return [unit]

    sourcePartIndices.push(...unit.partIndices)
    for (const comment of parsed.comments) {
      const key = codeCommentKey(comment)
      if (commentKeys.has(key)) continue
      commentKeys.add(key)
      comments.push(comment)
    }

    return parsed.visibleText.trim().length > 0 ? [{ ...unit, text: parsed.visibleText }] : []
  })

  if (comments.length === 0) return visibleUnits

  const partIndices = [...new Set(sourcePartIndices)]
  return [
    ...visibleUnits,
    {
      type: 'review-comments',
      key: 'review-comments:model',
      partIndices,
      target: {
        id: 'review-comments:model',
        itemIds: comments.map(
          (comment, index) => `review-comment:${index}:${comment.file}:${comment.startLine}`
        )
      },
      comments,
      workspaceCwd,
      canOpenLocalPaths,
      showThinkingFallback: false
    }
  ]
}

function codeCommentKey(comment: CodeComment): string {
  return [comment.file, comment.startLine, comment.endLine, comment.title, comment.body].join(
    '\u0000'
  )
}

function normalizeParts(
  parts: readonly AssistantMessagePart[],
  isMessageRunning: boolean,
  textPhases: readonly (AssistantMessagePhase | undefined)[] | undefined
): NormalizedPart[] {
  let textIndex = 0

  return parts.flatMap((part, partIndex): NormalizedPart[] => {
    const type = typeof part.type === 'string' ? part.type : undefined

    if (type === 'text') {
      const text = typeof part.text === 'string' ? part.text : ''
      const phase = textPhases?.[textIndex]
      textIndex += 1
      return isVisibleAssistantText(text) ? [{ kind: 'text', partIndex, part, text, phase }] : []
    }

    if (type === 'reasoning') return []

    if (type === 'indicator' || type === 'step-start') return []

    if (isToolLikePartType(type)) {
      const toolName = stringValue(part.toolName)
      const item =
        extractThreadItem(part) ?? inferredItemForToolPart(part, toolName, isMessageRunning)
      const normalizedItem = automationUpdateItemForToolPart(part, item, toolName) ?? item
      const itemType = canonicalItemType(
        typeof normalizedItem?.type === 'string' ? normalizedItem.type : undefined
      )
      const action = multiAgentAction(normalizedItem, part)

      return [
        {
          kind: 'tool',
          partIndex,
          part,
          item: normalizedItem,
          itemType,
          toolName,
          callId: partCallId(part, normalizedItem),
          action,
          mcpSource:
            itemType && MCP_ITEM_TYPES.has(itemType)
              ? mcpSourceForPart(part, normalizedItem)
              : undefined,
          dynamicMetadata:
            (itemType && DYNAMIC_ITEM_TYPES.has(itemType)) || type === 'dynamic-tool'
              ? dynamicMetadataForPart(part, normalizedItem)
              : undefined
        }
      ]
    }

    const item = extractThreadItem(part)
    const itemType = canonicalItemType(typeof item?.type === 'string' ? item.type : undefined)
    if (item && itemType) {
      return [{ kind: 'entry', partIndex, part, item, itemType }]
    }

    return [{ kind: 'unknown', partIndex, part }]
  })
}

function groupWebSearchAndMultiAgent(
  parts: readonly NormalizedPart[],
  subagentContext: SubagentRenderContext
): GroupableUnit[] {
  const units: GroupableUnit[] = []
  let webSearchParts: NormalizedPart[] = []

  const flushWebSearch = (): void => {
    if (webSearchParts.length === 0) return
    units.push({
      type: 'tool-group-candidate',
      kind: 'web-search',
      partIndices: webSearchParts.map((part) => part.partIndex),
      parts: webSearchParts.map((part) => part.part)
    })
    webSearchParts = []
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]

    if (part.kind === 'tool' && WEB_SEARCH_ITEM_TYPES.has(part.itemType ?? '')) {
      webSearchParts.push(part)
      continue
    }

    flushWebSearch()

    if (isSubagentActivityPart(part)) {
      const group = [part]
      let nextIndex = index + 1

      while (nextIndex < parts.length) {
        const next = parts[nextIndex]
        if (!next || !isSubagentActivityPart(next)) break
        group.push(next)
        nextIndex += 1
      }

      const agents = mergeSubagentActivityAgents(group, subagentContext.activityStatusesByPartIndex)
      const anchorEventId = subagentActivityAgent(group[0]!)?.eventId
      if (agents.length > 0) {
        units.push({
          type: 'subagent-activity-group',
          partIndices: group.map((item) => item.partIndex),
          parts: group.map((item) => item.part),
          anchorEventId: anchorEventId ?? agents[0]!.eventId,
          agents,
          status: subagentActivityGroupStatus(agents)
        })
      }
      index = nextIndex - 1
      continue
    }

    if (part.kind === 'tool' && MULTI_AGENT_ITEM_TYPES.has(part.itemType ?? '')) {
      const group = [part]
      const action = part.action
      let nextIndex = index + 1

      while (nextIndex < parts.length) {
        const next = parts[nextIndex]
        if (next?.kind !== 'tool' || !MULTI_AGENT_ITEM_TYPES.has(next.itemType ?? '')) break
        if (next.action !== action) break
        group.push(next)
        nextIndex += 1
      }

      units.push({
        type: 'tool-group-candidate',
        kind: 'multi-agent',
        partIndices: group.map((part) => part.partIndex),
        parts: group.map((part) => part.part),
        action
      })
      index = nextIndex - 1
      continue
    }

    units.push(normalizedToUnit(part))
  }

  flushWebSearch()
  return units
}

function groupAdjacentToolActivity(
  units: readonly GroupableUnit[],
  options: { detailLevel: AssistantRenderDetailLevel }
): GroupableUnit[] {
  const visibleUnits =
    options.detailLevel === 'stepsProse'
      ? units.filter((unit) => !isLowValueStepsProseActivityUnit(unit))
      : units
  const groupedUnits = groupLoadedToolActivity(visibleUnits)
  const result: GroupableUnit[] = []

  for (let index = 0; index < groupedUnits.length; index += 1) {
    const group = collectConsecutive(groupedUnits, index, isAdjacentToolActivityUnit)

    if (group.length === 0) {
      result.push(groupedUnits[index]!)
      continue
    }

    pushAdjacentToolGroup(result, group)
    index += group.length - 1
  }

  return result
}

function pushAdjacentToolGroup(result: GroupableUnit[], group: readonly GroupableUnit[]): void {
  if (group.length > 1) {
    result.push({
      type: 'tool-group-candidate',
      kind: 'composite',
      partIndices: group.flatMap((unit) => [...unit.partIndices]),
      parts: group.flatMap(partsForUnit)
    } as GroupableUnit)
    return
  }

  const first = group[0]
  if (first) result.push(first)
}

function groupDynamicToolCalls(units: readonly GroupableUnit[]): GroupableUnit[] {
  const result: GroupableUnit[] = []

  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index]
    if (!unit || !isDynamicToolUnit(unit)) {
      unit && result.push(unit)
      continue
    }

    const group: GroupableUnit[] = []
    let nextIndex = index + 1
    group.push(unit)

    while (nextIndex < units.length) {
      const next = units[nextIndex]
      if (!next || !isDynamicToolUnit(next)) break
      if (dynamicMetadataForUnit(next)?.standaloneInConversation === true) break
      group.push(next)
      nextIndex += 1
    }

    const metadata = mergeDynamicMetadata(group)
    if (group.length > 1 || metadata.standaloneInConversation) {
      result.push({
        type: 'tool-group-candidate',
        kind: 'dynamic',
        partIndices: group.flatMap((unit) => [...unit.partIndices]),
        parts: group.flatMap(partsForUnit),
        dynamicMetadata: metadata
      } as GroupableUnit)
    } else {
      result.push(unit)
    }

    index = nextIndex - 1
  }

  return result
}

function groupPendingMcpToolCalls(units: readonly GroupableUnit[]): GroupableUnit[] {
  const result: GroupableUnit[] = []

  for (let index = 0; index < units.length; index += 1) {
    const first = units[index]
    if (!first || !isMcpToolUnit(first)) {
      first && result.push(first)
      continue
    }

    const group = [first]
    const firstKey = mcpGroupKey(first)
    let nextIndex = index + 1

    while (nextIndex < units.length) {
      const next = units[nextIndex]
      if (!next || !isMcpToolUnit(next) || mcpGroupKey(next) !== firstKey) break
      group.push(next)
      nextIndex += 1
    }

    if (group.length > 1 || shouldRenderSingleMcpGroup(first)) {
      result.push({
        type: 'tool-group-candidate',
        kind: 'mcp',
        partIndices: group.flatMap((unit) => [...unit.partIndices]),
        parts: group.flatMap(partsForUnit),
        mcpSource: mergeMcpSource(group)
      } as GroupableUnit)
    } else {
      result.push(first)
    }

    index = nextIndex - 1
  }

  return result
}

function groupLoadedToolActivity(units: readonly GroupableUnit[]): GroupableUnit[] {
  const result: GroupableUnit[] = []

  for (let index = 0; index < units.length; index += 1) {
    const first = units[index]
    if (!first || !isLoadedToolUnit(first)) {
      first && result.push(first)
      continue
    }

    const group = [first]
    let nextIndex = index + 1

    while (nextIndex < units.length) {
      const next = units[nextIndex]
      if (!next || !isLoadedToolUnit(next)) break
      group.push(next)
      nextIndex += 1
    }

    result.push({
      type: 'tool-group-candidate',
      kind: 'generic',
      partIndices: group.flatMap((unit) => [...unit.partIndices]),
      parts: group.flatMap(partsForUnit)
    })
    index = nextIndex - 1
  }

  return result
}

function applyThinkingPresentation(
  units: readonly AssistantRenderUnit[],
  context: AssistantActivityContext
): AssistantRenderUnit[] {
  const stableUnits = units.map((unit) => {
    if (unit.type !== 'reasoning-group') return { ...unit, showThinkingFallback: false }

    const state = context.hasBlockingRequest && unit.active === true ? 'blocked' : unit.state
    return { ...unit, state, showThinkingFallback: false }
  })
  const activityPhase = deriveAssistantActivityPhase(stableUnits, context)
  const presentation = deriveThinkingPresentation(stableUnits, activityPhase)

  if (presentation.type === 'standalone') return [...stableUnits, messageThinkingUnit()]
  if (presentation.type === 'hidden') return stableUnits

  return stableUnits.map((unit) =>
    unit.key === presentation.unitKey ? { ...unit, showThinkingFallback: true } : unit
  )
}

function deriveAssistantActivityPhase(
  units: readonly AssistantRenderUnit[],
  context: AssistantActivityContext
): AssistantActivityPhase {
  if (!context.isRunning) return 'inactive'
  if (context.hasBlockingRequest) return 'blocked'
  if (hasVisibleTextAfterLatestActivity(units)) return 'showing-text'
  const processUnits = units.flatMap((unit) =>
    unit.type === 'reasoning-group' ? unit.children : [unit]
  )
  if (processUnits.some(isActiveExplorationUnit)) return 'exploring'
  if (processUnits.some(isActivePlanningUnit)) return 'planning'
  if (processUnits.some(isActiveActivityUnit)) return 'active-activity'
  return 'thinking'
}

function deriveThinkingPresentation(
  units: readonly AssistantRenderUnit[],
  activityPhase: AssistantActivityPhase
): ThinkingPresentation {
  if (activityPhase !== 'thinking') return { type: 'hidden' }
  if (hasSettledCommentaryCommandOutput(units)) return { type: 'hidden' }

  const latestUnit = units.at(-1)
  if (latestUnit && isThinkingFallbackToolGroup(latestUnit)) {
    return { type: 'tool-group', unitKey: latestUnit.key }
  }

  return { type: 'standalone' }
}

function hasSettledCommentaryCommandOutput(units: readonly AssistantRenderUnit[]): boolean {
  const latestUnit = units.at(-1)
  if (latestUnit?.type !== 'reasoning-group') return false
  if (!latestUnit.children.some((unit) => unit.type === 'text' && unit.phase === 'commentary')) {
    return false
  }

  const latestProcessUnit = latestUnit.children.at(-1)
  if (latestProcessUnit?.type !== 'tool-group') return false

  return latestProcessUnit.children.some(
    (item) =>
      item.status === 'complete' &&
      item.kind === 'commandExecution' &&
      typeof item.rawItem?.aggregatedOutput === 'string' &&
      item.rawItem.aggregatedOutput.trim().length > 0
  )
}

function hasVisibleTextAfterLatestActivity(units: readonly AssistantRenderUnit[]): boolean {
  let latestUnphasedTextIndex = -1
  let latestActivityIndex = -1

  for (const [index, unit] of units.entries()) {
    if (unit.type === 'text') {
      if (unit.phase === 'final_answer') return true
      if (unit.phase === undefined) latestUnphasedTextIndex = index
      continue
    }

    if (isActivityUnit(unit)) latestActivityIndex = index
  }

  return latestUnphasedTextIndex > latestActivityIndex
}

function isActivityUnit(unit: AssistantRenderUnit): boolean {
  return (
    unit.type === 'entry' || unit.type === 'tool-group' || unit.type === 'subagent-activity-group'
  )
}

function isActiveExplorationUnit(unit: AssistantRenderUnit): boolean {
  return unit.type === 'tool-group' && unit.kind === 'exploration' && unit.active === true
}

function isActivePlanningUnit(unit: AssistantRenderUnit): boolean {
  return unit.type === 'entry' && unit.itemType === 'todoList' && unit.active === true
}

function isActiveActivityUnit(unit: AssistantRenderUnit): boolean {
  return unit.type !== 'reasoning-group' && unit.active === true
}

function isThinkingFallbackToolGroup(
  unit: AssistantRenderUnit
): unit is Extract<AssistantRenderUnit, { type: 'tool-group' }> {
  return (
    unit.type === 'tool-group' &&
    unit.active !== true &&
    THINKING_FALLBACK_TOOL_GROUP_KINDS.has(unit.kind)
  )
}

function groupAssistantProcess(
  units: readonly AssistantRenderUnit[],
  isRunning: boolean,
  processDurationMs: number | undefined
): AssistantRenderUnit[] {
  const hasCommentary = units.some((unit) => unit.type === 'text' && unit.phase === 'commentary')
  if (hasCommentary) return groupCommentaryProcess(units, isRunning, processDurationMs)

  const hasExplicitPhase = units.some((unit) => unit.type === 'text' && unit.phase !== undefined)
  if (hasExplicitPhase) return [...units]

  return groupUnphasedAssistantProcess(units, isRunning, processDurationMs)
}

function groupCommentaryProcess(
  units: readonly AssistantRenderUnit[],
  isRunning: boolean,
  processDurationMs: number | undefined
): AssistantRenderUnit[] {
  const commentaryIndex = units.findIndex(
    (unit) => unit.type === 'text' && unit.phase === 'commentary'
  )
  if (commentaryIndex < 0) return [...units]

  const answerIndex = units.findIndex((unit) => unit.type === 'text' && unit.phase !== 'commentary')
  if (answerIndex >= 0 && answerIndex < commentaryIndex) return [...units]

  const processEnd = answerIndex >= 0 ? answerIndex : units.length
  const children = units.slice(0, processEnd)
  if (children.length === 0) return [...units]

  return groupProcessSegments(children, units.slice(processEnd), {
    active: isRunning && answerIndex < 0,
    state: isRunning && answerIndex < 0 ? 'thinking' : 'completed',
    durationMs: isRunning ? undefined : processDurationMs,
    turnRunning: isRunning
  })
}

function groupUnphasedAssistantProcess(
  units: readonly AssistantRenderUnit[],
  isRunning: boolean,
  processDurationMs: number | undefined
): AssistantRenderUnit[] {
  // Without provider phases, only the trailing assistant text is a provisional answer.
  // A later activity item moves that text back into the process group on the next render.
  if (!units.some((unit) => unit.type === 'text')) return [...units]

  const tail = units.at(-1)
  if (!tail || (tail.type !== 'text' && !isActivityUnit(tail))) return [...units]

  const candidateAnswerIndex = tail.type === 'text' ? units.length - 1 : -1
  const processEnd = candidateAnswerIndex >= 0 ? candidateAnswerIndex : units.length
  const children = units.slice(0, processEnd)
  if (children.length === 0) return [...units]

  const active = isRunning && candidateAnswerIndex < 0
  return groupProcessSegments(children, units.slice(processEnd), {
    active,
    state: active ? 'thinking' : 'completed',
    durationMs: isRunning ? undefined : processDurationMs,
    turnRunning: isRunning
  })
}

type ReasoningGroupOptions = {
  active: boolean
  state: ReasoningGroupState
  durationMs: number | undefined
  turnRunning: boolean
}

function groupProcessSegments(
  processUnits: readonly AssistantRenderUnit[],
  trailingUnits: readonly AssistantRenderUnit[],
  options: ReasoningGroupOptions
): AssistantRenderUnit[] {
  const hasStandaloneActivity = processUnits.some(shouldRenderOutsideProcessGroup)
  if (!hasStandaloneActivity) {
    return [
      reasoningGroupForProcessSegment(processUnits, options, 'reasoning-group'),
      ...trailingUnits
    ]
  }

  const result: AssistantRenderUnit[] = []
  let segment: AssistantRenderUnit[] = []

  const flushSegment = (): void => {
    if (segment.length === 0) return
    const firstPartIndex = segment[0]?.partIndices[0] ?? result.length
    result.push(
      reasoningGroupForProcessSegment(segment, options, `reasoning-group:${firstPartIndex}`)
    )
    segment = []
  }

  for (const unit of processUnits) {
    if (shouldRenderOutsideProcessGroup(unit)) {
      flushSegment()
      result.push(unit)
      continue
    }
    segment.push(unit)
  }

  flushSegment()
  return [...result, ...trailingUnits]
}

function reasoningGroupForProcessSegment(
  children: readonly AssistantRenderUnit[],
  options: ReasoningGroupOptions,
  key: string
): Extract<AssistantRenderUnit, { type: 'reasoning-group' }> {
  const partIndices = [...new Set(children.flatMap((unit) => [...unit.partIndices]))]
  const itemIds = [...new Set(children.flatMap((unit) => [...unit.target.itemIds]))]
  return {
    type: 'reasoning-group',
    key,
    partIndices,
    target: { id: key, itemIds },
    children,
    active: options.active,
    state: options.state,
    durationMs: options.durationMs,
    turnRunning: options.turnRunning,
    showThinkingFallback: false
  }
}

function shouldRenderOutsideProcessGroup(unit: AssistantRenderUnit): boolean {
  return unit.type === 'tool-group' && unit.dynamicMetadata?.standaloneInConversation === true
}

function messageThinkingUnit(): AssistantRenderUnit {
  return {
    type: 'message-thinking',
    key: 'message-thinking',
    partIndices: [],
    target: { id: 'message-thinking', itemIds: [] },
    active: true,
    showThinkingFallback: true
  }
}

function toRenderUnit(
  unit: GroupableUnit,
  index: number,
  isMessageRunning: boolean,
  subagentContext: SubagentRenderContext
): AssistantRenderUnit {
  switch (unit.type) {
    case 'text':
      return {
        type: 'text',
        key: `text:${unit.partIndex}`,
        partIndex: unit.partIndex,
        partIndices: unit.partIndices,
        target: targetForUnit(`text:${unit.partIndex}`, unit),
        text: unit.text,
        phase: unit.phase,
        streaming: isMessageRunning,
        showThinkingFallback: false
      }
    case 'unknown':
      return {
        type: 'unknown',
        key: `unknown:${unit.partIndex}`,
        partIndex: unit.partIndex,
        partIndices: unit.partIndices,
        target: targetForUnit(`unknown:${unit.partIndex}`, unit),
        part: unit.part,
        showThinkingFallback: false
      }
    case 'entry': {
      const summary = summarizeToolGroup([unit.part])
      if (shouldRenderEntryAsToolGroup(unit)) {
        return toToolGroupRenderUnit(unit, index, isMessageRunning, subagentContext)
      }

      const key = itemKey(unit.item, unit.partIndex, unit.callId)
      return {
        type: 'entry',
        key,
        partIndex: unit.partIndex,
        partIndices: unit.partIndices,
        target: targetForUnit(key, unit),
        part: unit.part,
        item: unit.item,
        itemType: unit.itemType,
        mcpSource: unit.mcpSource,
        dynamicMetadata: unit.dynamicMetadata,
        renderMode: entryRenderModeFor(unit.itemType),
        summary,
        active: summary.active || isItemActive(unit.item) || isToolPartActive(unit.part),
        showThinkingFallback: false
      }
    }
    case 'tool-group-candidate':
      return toToolGroupRenderUnit(unit, index, isMessageRunning, subagentContext)
    case 'subagent-activity-group': {
      const key = `subagent-activity-group:${unit.anchorEventId}`
      return {
        type: 'subagent-activity-group',
        key,
        partIndices: unit.partIndices,
        target: targetForUnit(key, unit),
        agents: unit.agents,
        status: unit.status,
        active: unit.status === 'active' || unit.status === 'updated',
        showThinkingFallback: false
      }
    }
  }
}

function shouldRenderEntryAsToolGroup(unit: EntryGroupableUnit): boolean {
  if (unit.itemType === 'exploration') return true

  const renderMode = entryRenderModeFor(unit.itemType)
  return renderMode === 'tool' || renderMode === 'fallback'
}

function toToolGroupRenderUnit(
  unit: GroupableUnit,
  index: number,
  isMessageRunning: boolean,
  subagentContext: SubagentRenderContext
): AssistantRenderUnit {
  const children = toolItemsForUnit(unit, subagentContext)
  // One file-change part can include several files, which are expanded into individual
  // child items below. Build the group summary from the original parts so those files
  // are counted once rather than once per expanded child.
  const summary = summarizeToolGroup(partsForUnit(unit))
  const kind = toolGroupKindForUnit(unit, children)
  const key = toolGroupKey(unit, index, children)
  const status = toolGroupStatus(children)
  const dynamicMetadata = dynamicMetadataForToolGroup(unit, children)
  const active =
    summary.active ||
    status === 'running' ||
    status === 'requires-action' ||
    (isMessageRunning && groupContinuesLiveActivity(children))

  return {
    type: 'tool-group',
    kind,
    status,
    key,
    partIndices: unit.partIndices,
    target: targetForUnit(key, unit),
    parts: partsForUnit(unit),
    children,
    summary,
    active,
    showThinkingFallback: false,
    mcpSource:
      unit.type === 'tool-group-candidate' && unit.kind === 'mcp'
        ? unit.mcpSource
        : mergeMcpSource([unit]),
    dynamicMetadata,
    action: toolGroupAction(unit, kind, children),
    summaryOnly: isSummaryOnlyToolGroup(children)
  }
}

function normalizedToUnit(part: NormalizedPart): GroupableUnit {
  if (part.kind === 'text') {
    return {
      type: 'text',
      partIndex: part.partIndex,
      partIndices: [part.partIndex],
      text: part.text,
      phase: part.phase
    }
  }

  if (part.kind === 'unknown') {
    return {
      type: 'unknown',
      partIndex: part.partIndex,
      partIndices: [part.partIndex],
      part: part.part
    }
  }

  if (part.kind === 'entry') {
    return {
      type: 'entry',
      partIndex: part.partIndex,
      partIndices: [part.partIndex],
      part: part.part,
      item: part.item,
      itemType: part.itemType
    }
  }

  return {
    type: 'entry',
    partIndex: part.partIndex,
    partIndices: [part.partIndex],
    part: part.part,
    item: part.item,
    itemType: part.itemType,
    toolName: part.toolName,
    callId: part.callId,
    action: part.action,
    mcpSource: part.mcpSource,
    dynamicMetadata: part.dynamicMetadata
  }
}

function toolItemsForUnit(unit: GroupableUnit, subagentContext: SubagentRenderContext): ToolItem[] {
  if (unit.type === 'entry' && unit.itemType === 'exploration') {
    const childItems = arrayValue(unit.item?.items).map(recordValue).filter(isDefined)
    if (childItems.length > 0) {
      return childItems.flatMap((item, index) =>
        toolItemsFromPart({
          part: unit.part,
          partIndex: unit.partIndices[index] ?? unit.partIndex,
          item,
          fallbackKind: canonicalItemType(stringValue(item.type)) ?? 'exploration',
          subagentContext
        })
      )
    }
  }

  if (unit.type === 'entry') {
    return toolItemsFromPart({
      part: unit.part,
      partIndex: unit.partIndex,
      item: unit.item,
      fallbackKind: unit.itemType,
      mcpSource: unit.mcpSource,
      dynamicMetadata: unit.dynamicMetadata,
      action: unit.action,
      subagentContext
    })
  }

  return partsForUnit(unit).flatMap((part, index) =>
    toolItemsFromPart({
      part,
      partIndex: unit.partIndices[index] ?? index,
      mcpSource:
        unit.type === 'tool-group-candidate' && unit.kind === 'mcp' ? unit.mcpSource : undefined,
      dynamicMetadata:
        unit.type === 'tool-group-candidate' && unit.kind === 'dynamic'
          ? unit.dynamicMetadata
          : undefined,
      action:
        unit.type === 'tool-group-candidate' && unit.kind === 'multi-agent'
          ? unit.action
          : undefined,
      subagentContext
    })
  )
}

type ToolItemFromPartOptions = {
  part: AssistantMessagePart
  partIndex: number
  item?: Record<string, unknown>
  fallbackKind?: string
  mcpSource?: McpSourceMetadata
  dynamicMetadata?: DynamicToolMetadata
  action?: string
  subagentContext: SubagentRenderContext
}

function toolItemsFromPart(options: ToolItemFromPartOptions): ToolItem[] {
  const item = toolItemFromPart(options)
  if (item.kind !== 'fileChange') return [item]

  const source = item.rawItem ?? recordValue(item.input)
  const changes = arrayValue(source?.changes).map(recordValue).filter(isDefined)
  if (changes.length <= 1) return [item]

  return changes.map((change, index) => {
    const id = `${item.id}:file:${index}`
    return {
      ...item,
      id,
      rawItem: {
        ...source,
        id,
        changes: [change]
      }
    }
  })
}

function toolItemFromPart({
  part,
  partIndex,
  item,
  fallbackKind,
  mcpSource,
  dynamicMetadata,
  action,
  subagentContext
}: ToolItemFromPartOptions): ToolItem {
  const toolName = stringValue(part.toolName)
  const rawItem =
    item ??
    extractThreadItem(part) ??
    inferredItemForToolPart(part, toolName, isToolPartActive(part))
  const kind =
    canonicalItemType(stringValue(rawItem?.type)) ??
    fallbackKind ??
    inferredToolKindFromToolName(toolName, part, rawItem) ??
    (part.type === 'dynamic-tool' ? 'dynamicToolCall' : undefined) ??
    'generic'
  const source =
    mcpSource ?? (MCP_ITEM_TYPES.has(kind) ? mcpSourceForPart(part, rawItem) : undefined)
  const input = extractToolInput(part)
  const output = part.output ?? part.result
  const error = rawItem?.error ?? recordValue(part.result)?.error ?? recordValue(part.output)?.error
  const id = partCallId(part, rawItem) ?? stringValue(part.id) ?? `${kind}:${partIndex}`

  return {
    id,
    kind,
    status: toolItemStatus(part, rawItem),
    label: toolItemLabel({ part, item: rawItem, kind, toolName }),
    source,
    input,
    output,
    error,
    rawPart: part,
    rawItem,
    partIndex,
    dynamicMetadata:
      dynamicMetadata ??
      (DYNAMIC_ITEM_TYPES.has(kind) || part.type === 'dynamic-tool'
        ? dynamicMetadataForPart(part, rawItem)
        : undefined),
    action: action ?? multiAgentAction(rawItem, part),
    receiverAgents: MULTI_AGENT_ITEM_TYPES.has(kind)
      ? receiverAgentsForMultiAgentItem(rawItem, input, subagentContext)
      : undefined
  }
}

function inferredToolKindFromToolName(
  toolName: string | undefined,
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): string | undefined {
  if (toolName === 'codex_command_execution') return 'commandExecution'
  if (toolName === 'codex_file_change') return 'fileChange'
  if (toolName === 'codex_web_search') {
    return item || isToolPartActive(part) ? 'webSearch' : undefined
  }
  if (toolName?.startsWith('mcp:')) return 'mcpToolCall'
  if (toolName === 'codex_collab_agent') return 'collabAgentToolCall'
  return undefined
}

function toolItemStatus(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): ToolItemStatus {
  if (isRequiresActionToolPart(part)) return 'requires-action'
  if (isToolPartActive(part) || isActiveStatus(item?.status)) return 'running'
  if (isErrorToolPart(part, item)) return 'error'
  return 'complete'
}

function isRequiresActionToolPart(part: AssistantMessagePart): boolean {
  if (recordValue(part.status)?.type === 'requires-action') return true
  return part.state === 'approval-requested'
}

function isErrorToolPart(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): boolean {
  const status = stringValue(item?.status)
  if (status === 'failed' || status === 'cancelled' || status === 'error') return true
  if (item?.error !== undefined) return true
  if (part.isError === true) return true
  const partStatus = recordValue(part.status)
  if (partStatus?.type === 'incomplete' || partStatus?.type === 'error') {
    return true
  }
  const result = recordValue(part.result)
  const output = recordValue(part.output)
  if (result?.error !== undefined || output?.error !== undefined) return true
  if (result?.isError === true || output?.isError === true) return true
  return part.state === 'output-error'
}

function toolItemLabel({
  part,
  item,
  kind,
  toolName
}: {
  part: AssistantMessagePart
  item: Record<string, unknown> | undefined
  kind: string
  toolName: string | undefined
}): string | undefined {
  if (kind === 'dynamicToolCall') {
    const metadata = dynamicMetadataForPart(part, item)
    const first = metadata.displayLabels[0]
    return first?.completedLabel
  }

  return (
    stringValue(item?.label) ??
    stringValue(item?.title) ??
    stringValue(item?.name) ??
    stringValue(item?.toolName) ??
    stringValue(item?.tool) ??
    humanizeToolName(toolName)
  )
}

function toolGroupKindForUnit(unit: GroupableUnit, children: readonly ToolItem[]): ToolGroupKind {
  if (unit.type === 'tool-group-candidate' && unit.kind !== 'composite') return unit.kind
  if (unit.type === 'entry' && unit.itemType === 'exploration') return 'exploration'
  if (children.length > 0 && children.every(isExplorationToolItem)) return 'exploration'
  if (children.length > 0 && children.every((child) => child.kind === 'webSearch')) {
    return 'web-search'
  }
  if (children.length > 0 && children.every((child) => child.kind === 'mcpToolCall')) {
    return 'mcp'
  }
  if (children.length > 0 && children.every((child) => DYNAMIC_ITEM_TYPES.has(child.kind))) {
    return 'dynamic'
  }
  if (children.length > 0 && children.every((child) => MULTI_AGENT_ITEM_TYPES.has(child.kind))) {
    return 'multi-agent'
  }
  if (children.length > 0 && children.every((child) => child.kind === 'fileChange')) {
    return 'file-change'
  }
  if (
    children.length > 0 &&
    children.every((child) => child.kind === 'commandExecution' || child.kind === 'exec')
  ) {
    return 'command'
  }
  return hasRecognizedToolItem(children) ? 'composite' : 'generic'
}

function isExplorationToolItem(item: ToolItem): boolean {
  if (item.kind === 'exploration') return true
  if (item.kind !== 'commandExecution' && item.kind !== 'exec') return false
  return (
    explorationActionsFromRecord(item.rawItem).length > 0 ||
    explorationActionsFromRecord(recordValue(item.input)).length > 0
  )
}

function toolGroupStatus(children: readonly ToolItem[]): ToolItemStatus {
  if (children.some((child) => child.status === 'requires-action')) return 'requires-action'
  if (children.some((child) => child.status === 'running')) return 'running'
  if (children.some((child) => child.status === 'error')) return 'error'
  return 'complete'
}

function toolGroupAction(
  unit: GroupableUnit,
  kind: ToolGroupKind,
  children: readonly ToolItem[]
): string | undefined {
  if (kind !== 'multi-agent') return undefined
  if (unit.type === 'tool-group-candidate' && unit.kind === 'multi-agent') return unit.action

  const actions = [...new Set(children.map((child) => child.action).filter(isDefined))]
  return actions.length === 1 ? actions[0] : undefined
}

function toolGroupKey(unit: GroupableUnit, index: number, children: readonly ToolItem[]): string {
  const firstChild = children[0]
  const firstIndex = unit.partIndices[0] ?? index
  const stableIdentity = firstChild?.id ?? firstIndex

  return `tool-group:${stableIdentity}`
}

function dynamicMetadataForToolGroup(
  unit: GroupableUnit,
  children: readonly ToolItem[]
): DynamicToolMetadata | undefined {
  if (unit.type === 'tool-group-candidate' && unit.kind === 'dynamic' && unit.dynamicMetadata) {
    return unit.dynamicMetadata
  }

  const metadata = children.map((child) => child.dynamicMetadata).filter(isDefined)
  return metadata.length > 0 ? mergeDynamicMetadataValues(metadata, metadata.length) : undefined
}

function groupContinuesLiveActivity(children: readonly ToolItem[]): boolean {
  return children.some((child) => child.dynamicMetadata?.continuesLiveActivityBetweenCalls === true)
}

function isSummaryOnlyToolGroup(children: readonly ToolItem[]): boolean {
  return (
    children.length > 0 &&
    children.every((child) => child.dynamicMetadata?.summaryOnlyInConversationGroup === true)
  )
}

function hasRecognizedToolItem(children: readonly ToolItem[]): boolean {
  return children.some(
    (child) =>
      isExplorationToolItem(child) ||
      child.kind === 'webSearch' ||
      child.kind === 'mcpToolCall' ||
      child.kind === 'fileChange' ||
      child.kind === 'commandExecution' ||
      child.kind === 'exec' ||
      DYNAMIC_ITEM_TYPES.has(child.kind) ||
      MULTI_AGENT_ITEM_TYPES.has(child.kind)
  )
}

function collectConsecutive(
  units: readonly GroupableUnit[],
  startIndex: number,
  predicate: (unit: GroupableUnit) => boolean
): GroupableUnit[] {
  const group: GroupableUnit[] = []

  for (let index = startIndex; index < units.length; index += 1) {
    const unit = units[index]
    if (!unit || !predicate(unit)) break
    group.push(unit)
  }

  return group
}

function isAdjacentToolActivityUnit(unit: GroupableUnit): boolean {
  if (unit.type === 'tool-group-candidate') return unit.kind !== 'multi-agent'
  if (unit.type !== 'entry') return false

  const renderMode = entryRenderModeFor(unit.itemType)
  return renderMode === 'tool' || renderMode === 'fallback'
}

function isLowValueStepsProseActivityUnit(unit: GroupableUnit): boolean {
  if (isGroupableUnitActive(unit) || unit.type !== 'entry') return false
  if (!unit.itemType) return false
  return STEPS_PROSE_HIDDEN_ACTIVITY_TYPES.has(unit.itemType)
}

function isGroupableUnitActive(unit: GroupableUnit): boolean {
  if (unit.type === 'entry') {
    return isToolPartActive(unit.part) || isActiveStatus(unit.item?.status)
  }
  return partsForUnit(unit).some(isToolPartActive)
}

function explorationActionsFromRecord(
  record: Record<string, unknown> | undefined
): ExplorationAction[] {
  if (!record) return []

  const commandActions = arrayValue(record.commandActions)
    .map((action) => explorationActionFromRecord(recordValue(action)))
    .filter(isDefined)
  if (commandActions.length > 0) return commandActions

  const parsedCommand = explorationActionFromRecord(recordValue(record.parsedCmd))
  return parsedCommand ? [parsedCommand] : []
}

function explorationActionFromRecord(
  record: Record<string, unknown> | undefined
): ExplorationAction | undefined {
  if (!record) return undefined

  const type = explorationActionKind(stringValue(record.type))
  if (!type) return undefined

  return {
    type,
    label:
      stringValue(record.name) ??
      stringValue(record.label) ??
      stringValue(record.path) ??
      stringValue(record.query) ??
      stringValue(record.command),
    path:
      stringValue(record.path) ??
      stringValue(record.file) ??
      stringValue(record.filename) ??
      stringValue(record.directory),
    query: stringValue(record.query) ?? stringValue(record.pattern),
    command: stringValue(record.command)
  }
}

function explorationActionKind(value: string | undefined): ExplorationActionKind | undefined {
  switch (value) {
    case 'read':
    case 'readFile':
    case 'read_file':
      return 'read'
    case 'list':
    case 'listFiles':
    case 'list_files':
    case 'ls':
      return 'list'
    case 'search':
    case 'searchCode':
    case 'search_code':
    case 'grep':
    case 'rg':
      return 'search'
    default:
      return undefined
  }
}

function isDynamicToolUnit(unit: GroupableUnit): boolean {
  return unit.type === 'entry' && DYNAMIC_ITEM_TYPES.has(unit.itemType ?? '')
}

function isMcpToolUnit(unit: GroupableUnit): boolean {
  return (
    unit.type === 'entry' &&
    MCP_ITEM_TYPES.has(unit.itemType ?? '') &&
    unit.mcpSource?.sourceType !== 'computer-use'
  )
}

function isLoadedToolUnit(unit: GroupableUnit): boolean {
  return unit.type === 'entry' && LOADED_TOOL_ITEM_TYPES.has(unit.itemType ?? '')
}

function shouldRenderSingleMcpGroup(unit: GroupableUnit): boolean {
  if (unit.type !== 'entry') return false

  const sourceType = unit.mcpSource?.sourceType
  return sourceType !== 'computer-use'
}

function partsForUnit(unit: ToolGroupableUnit): readonly AssistantMessagePart[] {
  if (unit.parts) return unit.parts
  return unit.type === 'entry' ? [unit.part] : []
}

function mcpGroupKey(unit: GroupableUnit): string {
  if (unit.type !== 'entry') return 'unknown'
  return unit.mcpSource?.groupKey ?? 'unknown'
}

function itemKey(
  item: Record<string, unknown> | undefined,
  partIndex: number,
  fallbackCallId?: string
): string {
  const type = canonicalItemType(stringValue(item?.type)) ?? 'tool'
  if (type === 'exploration') return explorationKey(item, partIndex)

  const id = stringValue(item?.id)
  const callId = stringValue(item?.callId) ?? fallbackCallId
  if (id) return `item:${type}:${id}`
  if (callId) return `item:${type}:${callId}`
  return `item:${type}:${partIndex}`
}

function explorationKey(item: Record<string, unknown> | undefined, partIndex: number): string {
  const firstItem = arrayValue(item?.items).map(recordValue).find(isDefined)
  const firstType = canonicalItemType(stringValue(firstItem?.type))
  const callId = stringValue(firstItem?.callId) ?? stringValue(firstItem?.id)

  if (firstType === 'commandExecution' && callId) return `exploration:${callId}`
  const id = stringValue(item?.id)
  if (id) return id
  return `exploration:${firstType ?? `unknown-${partIndex}`}`
}

function isVisibleAssistantText(text: string): boolean {
  return text.trim().length > 0 && text !== pendingAssistantMessageText
}

function isItemActive(item: Record<string, unknown> | undefined): boolean {
  return isActiveStatus(item?.status)
}

function isCompleteStatus(status: unknown): boolean {
  if (status === 'completed' || status === 'complete') return true
  const record = recordValue(status)
  if (!record) return false
  return record.type === 'complete' || record.type === 'completed'
}

function entryRenderModeFor(itemType: string | undefined): EntryRenderMode {
  if (!itemType) return 'tool'
  return ENTRY_ITEM_RENDER_MODES[itemType] ?? 'tool'
}

function targetForUnit(key: string, unit: GroupableUnit): AssistantRenderTarget {
  const itemIds = collectTargetIds(unit)
  return {
    id: domSafeId(`render-unit:${key}`),
    itemIds
  }
}

function collectTargetIds(unit: GroupableUnit): readonly string[] {
  const parts = partsForUnit(unit)
  const ids = new Set<string>()

  for (const part of parts) {
    collectTargetIdsFromPart(part, ids)
  }

  if (unit.type === 'entry') {
    collectTargetIdsFromItem(unit.item, ids)
    addStringToSet(ids, unit.callId)
  }

  return [...ids]
}

function collectTargetIdsFromPart(part: AssistantMessagePart, ids: Set<string>): void {
  addStringToSet(ids, stringValue(part.toolCallId))
  addStringToSet(ids, stringValue(part.id))
  collectTargetIdsFromItem(extractThreadItem(part), ids)
}

function collectTargetIdsFromItem(
  item: Record<string, unknown> | undefined,
  ids: Set<string>
): void {
  if (!item) return
  addStringToSet(ids, stringValue(item.id))
  addStringToSet(ids, stringValue(item.callId))

  for (const child of arrayValue(item.items)) {
    collectTargetIdsFromItem(recordValue(child), ids)
  }
}

function addStringToSet(values: Set<string>, value: string | undefined): void {
  if (value) values.add(value)
}

function domSafeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-')
}

function canonicalItemType(itemType: string | undefined): string | undefined {
  switch (itemType) {
    case 'web-search':
      return 'webSearch'
    case 'mcp-tool-call':
      return 'mcpToolCall'
    case 'dynamic-tool-call':
      return 'dynamicToolCall'
    case 'multi-agent-action':
      return 'multi-agent-action'
    case 'exec':
      return 'commandExecution'
    case 'patch':
      return 'fileChange'
    case 'todo-list':
      return 'todoList'
    case 'user-input-response':
      return 'userInputResponse'
    case 'mcp-server-elicitation':
      return 'mcpServerElicitation'
    case 'permission-request':
      return 'permissionRequest'
    case 'stream-error':
      return 'streamError'
    case 'system-error':
      return 'systemError'
    case 'remote-task-created':
      return 'remoteTaskCreated'
    case 'personality-changed':
      return 'personalityChanged'
    case 'model-changed':
      return 'modelChanged'
    case 'model-rerouted':
      return 'modelRerouted'
    case 'subagent-activity':
      return 'subAgentActivity'
    case 'context-compaction':
      return 'contextCompaction'
    case 'worktree-init':
      return 'worktreeInit'
    case 'automation-update':
      return 'automationUpdate'
    case 'hook-prompt':
      return 'hookPrompt'
    case 'automatic-approval-review':
      return 'automaticApprovalReview'
    case 'turn-diff':
      return 'turnDiff'
    case 'generated-image':
      return 'imageGeneration'
    case 'review-comments':
      return 'reviewComments'
    case 'loaded-tool':
      return 'loadedTool'
    default:
      return itemType
  }
}

function inferredItemForToolPart(
  part: AssistantMessagePart,
  toolName: string | undefined,
  isMessageRunning: boolean
): Record<string, unknown> | undefined {
  if (toolName !== 'codex_web_search') return undefined
  if (!isMessageRunning && !isToolPartActive(part)) return undefined

  const input = extractToolInput(part)
  const query = webSearchQueryFromInput(input)
  const action = webSearchActionFromInput(input) ?? (query ? { type: 'search' } : undefined)

  return {
    id: stringValue(part.toolCallId) ?? stringValue(part.id) ?? 'web-search',
    type: 'webSearch',
    status: isToolPartActive(part) ? 'inProgress' : 'completed',
    ...(query ? { query } : {}),
    ...(action ? { action } : {})
  }
}

function automationUpdateItemForToolPart(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined,
  toolName: string | undefined
): Record<string, unknown> | undefined {
  const itemToolName = stringValue(item?.tool) ?? stringValue(item?.functionName) ?? toolName
  if (itemToolName !== 'automation_update') return undefined
  if (!isCompletedSuccessfulAutomationUpdate(part, item)) return undefined

  const details = automationUpdateDetails(part, item)
  if (!details) return undefined

  const id = partCallId(part, item) ?? stringValue(part.id) ?? 'automation-update'
  return {
    id,
    type: 'automationUpdate',
    status: 'completed',
    title: details.title,
    summary: details.summary,
    name: details.name,
    action: details.action
  }
}

function isCompletedSuccessfulAutomationUpdate(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): boolean {
  if (isToolPartActive(part) || isActiveStatus(item?.status)) return false
  if (item?.success === false || isErrorToolPart(part, item)) return false
  return (
    item?.success === true ||
    isCompleteStatus(item?.status) ||
    isCompleteStatus(part.status) ||
    part.state === 'output-available'
  )
}

function automationUpdateDetails(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
):
  | {
      title?: string
      summary?: string
      name?: string
      action?: string
    }
  | undefined {
  const input = recordValue(extractToolInput(part))
  const argumentsRecord = firstRecord(item?.arguments, item?.args, input)
  if (!argumentsRecord) return undefined

  const name =
    stringValue(item?.name) ??
    stringValue(argumentsRecord.name) ??
    stringValue(argumentsRecord.title) ??
    stringValue(argumentsRecord.id)
  const action =
    stringValue(item?.action) ??
    stringValue(argumentsRecord.action) ??
    stringValue(argumentsRecord.operation) ??
    stringValue(argumentsRecord.status)
  const summary =
    stringValue(item?.summary) ??
    stringValue(argumentsRecord.summary) ??
    [action, name].filter(isDefined).join(' ')

  return {
    title: stringValue(item?.title) ?? stringValue(argumentsRecord.title),
    summary: summary || undefined,
    name,
    action
  }
}

function webSearchQueryFromInput(input: unknown): string | undefined {
  const record = recordValue(input)
  if (!record) return undefined

  const directQuery = stringValue(record.query)
  if (directQuery) return directQuery

  const action = recordValue(record.action)
  const actionQuery = stringValue(action?.query)
  if (actionQuery) return actionQuery

  const firstSearchQuery = arrayValue(record.search_query).map(recordValue).find(isDefined)
  const searchQuery = stringValue(firstSearchQuery?.q) ?? stringValue(firstSearchQuery?.query)
  if (searchQuery) return searchQuery

  const commands = recordValue(record.commands)
  const commandSearchQuery = arrayValue(commands?.search_query).map(recordValue).find(isDefined)
  return stringValue(commandSearchQuery?.q) ?? stringValue(commandSearchQuery?.query)
}

function webSearchActionFromInput(input: unknown): unknown {
  const record = recordValue(input)
  if (!record) return undefined
  return record.action ?? record.actionType
}

function isToolLikePartType(type: string | undefined): boolean {
  return type === 'tool-call' || type === 'dynamic-tool'
}

function partCallId(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): string | undefined {
  return stringValue(item?.callId) ?? stringValue(item?.id) ?? stringValue(part.toolCallId)
}

function multiAgentAction(
  item: Record<string, unknown> | undefined,
  part?: AssistantMessagePart
): string | undefined {
  const input = part ? recordValue(extractToolInput(part)) : undefined
  return (
    stringValue(item?.tool) ??
    stringValue(input?.tool) ??
    stringValue(input?.action) ??
    stringValue(item?.action) ??
    stringValue(recordValue(item?.metadata)?.action) ??
    stringValue(recordValue(item?.display)?.action)
  )
}

export function displayNameForSubagentPath(agentPath: string): string {
  const segment = agentPath
    .split('/')
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== 'root')
    .at(-1)
  if (!segment) return '子 agent'

  const displayName = segment.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  return displayName ? `${displayName[0]?.toUpperCase() ?? ''}${displayName.slice(1)}` : '子 agent'
}

function buildSubagentRenderContext(parts: readonly NormalizedPart[]): SubagentRenderContext {
  const displayNamesByThreadId = new Map<string, string>()
  const activityStatusesByPartIndex = new Map<number, SubagentActivityDisplayStatus>()
  const latestActivityPartIndexByThreadId = new Map<string, number>()

  for (const part of parts) {
    const activity = subagentActivityAgent(part)
    if (activity?.threadId) {
      displayNamesByThreadId.set(activity.threadId, activity.displayName)
      latestActivityPartIndexByThreadId.set(activity.threadId, part.partIndex)
    }

    if (!isMultiAgentPart(part)) continue
    const states = recordValue(part.item?.agentsStates)
    if (!states) continue

    for (const [threadId, value] of Object.entries(states)) {
      const state = recordValue(value)
      const activityPartIndex = latestActivityPartIndexByThreadId.get(threadId)
      const displayStatus = subagentActivityStatusFromState(state)
      if (activityPartIndex !== undefined && displayStatus) {
        activityStatusesByPartIndex.set(activityPartIndex, displayStatus)
      }
    }
  }

  return { displayNamesByThreadId, activityStatusesByPartIndex }
}

function isSubagentActivityPart(part: NormalizedPart): part is SubagentActivityNormalizedPart {
  return (
    (part.kind === 'tool' || part.kind === 'entry') &&
    SUBAGENT_ACTIVITY_ITEM_TYPES.has(part.itemType ?? '')
  )
}

function isMultiAgentPart(part: NormalizedPart): part is Extract<NormalizedPart, { kind: 'tool' }> {
  return part.kind === 'tool' && MULTI_AGENT_ITEM_TYPES.has(part.itemType ?? '')
}

function isWaitingMultiAgentPart(part: NormalizedPart): boolean {
  return isMultiAgentPart(part) && part.action === 'wait'
}

function mergeSubagentActivityAgents(
  parts: readonly NormalizedPart[],
  activityStatusesByPartIndex: ReadonlyMap<number, SubagentActivityDisplayStatus>
): SubagentActivityAgent[] {
  const agents = new Map<string, SubagentActivityAgent>()

  for (const part of parts) {
    const agent = subagentActivityAgent(part)
    if (!agent) continue
    const displayStatus = activityStatusesByPartIndex.get(part.partIndex) ?? agent.displayStatus
    agents.set(agent.threadId ?? agent.eventId, { ...agent, displayStatus })
  }

  return [...agents.values()]
}

function subagentActivityAgent(part: NormalizedPart): SubagentActivityAgent | undefined {
  if (!isSubagentActivityPart(part)) return undefined
  const item = part.item
  const input = part.kind === 'tool' ? recordValue(extractToolInput(part.part)) : undefined
  const eventId =
    stringValue(item?.id) ??
    (part.kind === 'tool' ? part.callId : undefined) ??
    stringValue(part.part.id) ??
    `subagent-activity:${part.partIndex}`
  const threadId = stringValue(item?.agentThreadId) ?? stringValue(input?.agentThreadId)
  const agentPath = stringValue(item?.agentPath) ?? stringValue(input?.agentPath) ?? ''
  const kind = stringValue(item?.kind) ?? stringValue(input?.kind)

  return {
    ...(threadId ? { threadId } : {}),
    eventId,
    agentPath,
    displayName: displayNameForSubagentPath(agentPath),
    displayStatus: subagentActivityStatusFromKind(kind)
  }
}

function subagentActivityStatusFromKind(kind: string | undefined): SubagentActivityDisplayStatus {
  switch (kind) {
    case 'interacted':
    case 'updated':
      return 'updated'
    case 'interrupted':
      return 'interrupted'
    case 'started':
    default:
      return 'active'
  }
}

function subagentActivityStatusFromState(
  state: Record<string, unknown> | undefined
): SubagentActivityDisplayStatus | undefined {
  const status = stringValue(state?.status)
  if (status === 'completed' || status === 'complete') return 'finished'
  return undefined
}

function subagentActivityGroupStatus(
  agents: readonly SubagentActivityAgent[]
): SubagentActivityDisplayStatus {
  if (agents.some((agent) => agent.displayStatus === 'interrupted')) return 'interrupted'
  if (agents.some((agent) => agent.displayStatus === 'updated')) return 'updated'
  if (agents.length > 0 && agents.every((agent) => agent.displayStatus === 'finished')) {
    return 'finished'
  }
  return 'active'
}

function receiverAgentsForMultiAgentItem(
  item: Record<string, unknown> | undefined,
  input: unknown,
  context: SubagentRenderContext
): readonly MultiAgentReceiverAgent[] | undefined {
  const inputRecord = recordValue(input)
  const agentsStates = recordValue(item?.agentsStates) ?? {}
  const threadIds = [
    ...arrayValue(item?.receiverThreadIds),
    ...arrayValue(inputRecord?.receiverThreadIds),
    ...Object.keys(agentsStates)
  ]
    .map(stringValue)
    .filter(isDefined)
  const uniqueThreadIds = [...new Set(threadIds)]
  if (uniqueThreadIds.length === 0) return undefined

  return uniqueThreadIds.map((threadId) => {
    const state = recordValue(agentsStates[threadId])
    return {
      threadId,
      displayName:
        context.displayNamesByThreadId.get(threadId) ??
        `子 agent ${threadId.length > 10 ? `${threadId.slice(0, 8)}…` : threadId}`,
      ...(stringValue(state?.status) ? { status: stringValue(state?.status) } : {}),
      ...(stringValue(state?.message) ? { message: stringValue(state?.message) } : {})
    }
  })
}

function dynamicMetadataForPart(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): DynamicToolMetadata {
  const toolName =
    stringValue(item?.tool) ?? stringValue(item?.functionName) ?? stringValue(part.toolName)
  const localMetadata = toolName ? KNOWN_DYNAMIC_TOOL_METADATA[toolName] : undefined
  const registry = firstRecord(
    item?.registryMetadata,
    item?.displayMetadata,
    item?.dynamicTool,
    item?.toolRegistration,
    recordValue(part.result)?.metadata,
    recordValue(part.output)?.metadata
  )
  const display = firstRecord(item?.display, item?.displayMetadata, registry)
  const completedSummaryKey =
    stringValue(registry?.completedSummaryKey) ??
    stringValue(item?.completedSummaryKey) ??
    stringValue(item?.summaryKey) ??
    localMetadata?.completedSummaryKey
  const activeLabel =
    stringValue(display?.activeLabel) ??
    stringValue(registry?.activeLabel) ??
    stringValue(item?.activeLabel) ??
    localMetadata?.activeLabel
  const completedLabel =
    stringValue(display?.completedLabel) ??
    stringValue(display?.label) ??
    stringValue(registry?.completedLabel) ??
    stringValue(registry?.label) ??
    stringValue(item?.completedLabel) ??
    stringValue(item?.label) ??
    stringValue(item?.title) ??
    localMetadata?.completedLabel ??
    humanizeToolName(toolName)
  const fallbackActiveLabel =
    activeLabel ?? completedLabel ?? localMetadata?.activeLabel ?? humanizeToolName(toolName)
  const fallbackCompletedLabel =
    completedLabel ?? activeLabel ?? localMetadata?.completedLabel ?? humanizeToolName(toolName)
  const hasRegistryMetadata = registry !== undefined || localMetadata !== undefined
  const displayLabels =
    fallbackActiveLabel && fallbackCompletedLabel
      ? [
          {
            key: dynamicDisplayLabelKey({
              completedSummaryKey,
              toolName,
              activeLabel: fallbackActiveLabel,
              completedLabel: fallbackCompletedLabel
            }),
            activeLabel: fallbackActiveLabel,
            completedLabel: fallbackCompletedLabel,
            count: numberValue(item?.repeatCount) ?? 1,
            callIds: [partCallId(part, item)].filter(isDefined),
            hasRegistryMetadata
          }
        ]
      : []

  return {
    summaryOnlyInConversationGroup: booleanValue(registry?.summaryOnlyInConversationGroup),
    standaloneInConversation:
      booleanValue(registry?.standaloneInConversation) ||
      localMetadata?.standaloneInConversation === true,
    continuesLiveActivityBetweenCalls: booleanValue(registry?.continuesLiveActivityBetweenCalls),
    completedSummaryKey,
    repeatCount: numberValue(item?.repeatCount) ?? 1,
    hasRegistryMetadata,
    displayLabels
  }
}

function dynamicMetadataForUnit(unit: GroupableUnit): DynamicToolMetadata | undefined {
  if (unit.type === 'entry') return unit.dynamicMetadata
  if (unit.type === 'tool-group-candidate' && unit.kind === 'dynamic') return unit.dynamicMetadata
  return undefined
}

function mergeDynamicMetadata(group: readonly GroupableUnit[]): DynamicToolMetadata {
  const metadata = group.map(dynamicMetadataForUnit).filter(isDefined)
  return mergeDynamicMetadataValues(metadata, group.length)
}

function mergeDynamicMetadataValues(
  metadata: readonly DynamicToolMetadata[],
  fallbackCount: number
): DynamicToolMetadata {
  const first = metadata[0]
  const displayLabels = mergeDynamicDisplayLabels(metadata.flatMap((item) => item.displayLabels))
  const completedSummaryKey =
    first?.completedSummaryKey ??
    metadata.find((item) => item.completedSummaryKey)?.completedSummaryKey
  const repeatedCount =
    completedSummaryKey == null
      ? fallbackCount
      : metadata.filter((item) => item.completedSummaryKey === completedSummaryKey).length

  return {
    summaryOnlyInConversationGroup:
      metadata.length > 0 && metadata.every((item) => item.summaryOnlyInConversationGroup),
    standaloneInConversation: first?.standaloneInConversation ?? false,
    continuesLiveActivityBetweenCalls: metadata.some(
      (item) => item.continuesLiveActivityBetweenCalls
    ),
    completedSummaryKey,
    repeatCount: Math.max(
      repeatedCount,
      ...metadata.map((item) => item.repeatCount),
      ...displayLabels.map((item) => item.count)
    ),
    hasRegistryMetadata: metadata.length > 0 && metadata.every((item) => item.hasRegistryMetadata),
    displayLabels
  }
}

function mergeDynamicDisplayLabels(
  labels: readonly DynamicToolDisplayLabel[]
): DynamicToolDisplayLabel[] {
  const result: DynamicToolDisplayLabel[] = []

  for (const label of labels) {
    const existing = result.find((item) => item.key === label.key)
    if (!existing) {
      result.push(label)
      continue
    }

    result[result.indexOf(existing)] = {
      ...existing,
      count: existing.count + label.count,
      callIds: [...new Set([...existing.callIds, ...label.callIds])],
      hasRegistryMetadata: existing.hasRegistryMetadata && label.hasRegistryMetadata
    }
  }

  return result
}

function dynamicDisplayLabelKey({
  completedSummaryKey,
  toolName,
  activeLabel,
  completedLabel
}: {
  completedSummaryKey?: string
  toolName?: string
  activeLabel: string
  completedLabel: string
}): string {
  return `${toolName ?? 'dynamic-tool'}:${completedSummaryKey ?? completedLabel ?? activeLabel}`
}

function humanizeToolName(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined
  const tail = toolName.includes('/') ? toolName.split('/').at(-1) : toolName
  const words = (tail ?? toolName)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  if (!words) return undefined
  return words.replace(/\b\w/g, (character) => character.toUpperCase())
}

function mcpSourceForPart(
  part: AssistantMessagePart,
  item: Record<string, unknown> | undefined
): McpSourceMetadata {
  const invocation = recordValue(item?.invocation)
  const appContext = recordValue(item?.appContext)
  const toolName = stringValue(part.toolName)
  const parsedToolName = parseMcpToolName(toolName)
  const server =
    stringValue(item?.server) ?? stringValue(invocation?.server) ?? parsedToolName?.server
  const connectorId = stringValue(appContext?.connectorId) ?? stringValue(appContext?.id)
  const resourceUri = stringValue(appContext?.resourceUri) ?? stringValue(item?.mcpAppResourceUri)
  const pluginId = stringValue(item?.pluginId)
  const appKey = connectorId ?? resourceUri ?? pluginId
  const appLabel =
    stringValue(appContext?.displayName) ??
    stringValue(appContext?.appName) ??
    stringValue(appContext?.name)
  const tool =
    stringValue(item?.tool) ?? stringValue(invocation?.tool) ?? parsedToolName?.tool ?? toolName
  const sourceType = mcpSourceType(server, toolName, appKey, appLabel)
  const label = mcpSourceLabel({ sourceType, appLabel, server, tool })
  const groupKey = mcpSourceGroupKey({
    sourceType,
    connectorId,
    resourceUri,
    pluginId,
    server,
    toolName
  })

  return {
    groupKey,
    sourceType,
    label,
    server,
    appKey,
    resourceUri,
    pluginId,
    toolName: tool,
    callIds: [partCallId(part, item)].filter(isDefined),
    hasAppMetadata: appKey !== undefined || appLabel !== undefined
  }
}

function mergeMcpSource(group: readonly GroupableUnit[]): McpSourceMetadata | undefined {
  const sources = group
    .map((unit) => (unit.type === 'entry' ? unit.mcpSource : undefined))
    .filter(isDefined)
  const first = sources[0]
  if (!first) return undefined

  return {
    ...first,
    callIds: [...new Set(sources.flatMap((source) => source.callIds))]
  }
}

function parseMcpToolName(
  toolName: string | undefined
): { server?: string; tool?: string } | undefined {
  if (!toolName?.startsWith('mcp:')) return undefined
  const body = toolName.slice('mcp:'.length)
  const slashIndex = body.indexOf('/')
  if (slashIndex < 0) return { server: body }
  return {
    server: body.slice(0, slashIndex) || undefined,
    tool: body.slice(slashIndex + 1) || undefined
  }
}

function mcpSourceType(
  server: string | undefined,
  toolName: string | undefined,
  appKey: string | undefined,
  appLabel: string | undefined
): McpSourceMetadata['sourceType'] {
  const haystack = `${server ?? ''} ${toolName ?? ''}`.toLowerCase()
  if (haystack.includes('computer-use')) return 'computer-use'
  if (haystack.includes('node_repl') || haystack.includes('node-repl')) return 'node-repl'
  if (haystack.includes('browser')) return 'browser'
  if (appKey || appLabel) return 'app'
  return 'server'
}

function mcpSourceGroupKey({
  sourceType,
  connectorId,
  resourceUri,
  pluginId,
  server,
  toolName
}: {
  sourceType: McpSourceMetadata['sourceType']
  connectorId?: string
  resourceUri?: string
  pluginId?: string
  server?: string
  toolName?: string
}): string {
  if (sourceType === 'app') {
    if (connectorId) return `app:${connectorId}`
    if (resourceUri) return `resource:${resourceUri}`
    if (pluginId) return `plugin:${pluginId}`
  }

  return `${sourceType}:${server ?? toolName ?? 'unknown'}`
}

function mcpSourceLabel({
  sourceType,
  appLabel,
  server,
  tool
}: {
  sourceType: McpSourceMetadata['sourceType']
  appLabel?: string
  server?: string
  tool?: string
}): string {
  if (sourceType === 'browser') return 'Browser'
  if (sourceType === 'computer-use') return 'Computer Use'
  if (sourceType === 'node-repl') return 'Node REPL'
  if (appLabel) return appLabel
  if (server) return server
  return tool ?? 'MCP'
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  return values.find((value): value is Record<string, unknown> => recordValue(value) !== undefined)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
