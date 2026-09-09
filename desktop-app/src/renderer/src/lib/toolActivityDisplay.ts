import type { AssistantRenderUnit, DynamicToolMetadata, ToolItem } from './assistantRenderUnits'
import { pendingAssistantMessageText } from './assistantMessages'
import {
  extractThreadItem,
  extractToolInput,
  type ToolGroupIconName,
  type ToolGroupSummary
} from './toolGroupSummary'

type AnyRecord = Record<string, unknown>
type ToolGroupUnit = Extract<AssistantRenderUnit, { type: 'tool-group' }>

export type ToolActivityStatus =
  | 'running'
  | 'completed'
  | 'stopped'
  | 'error'
  | 'requiresAction'
  | 'mixed'

export type ToolActivityDetailRow = {
  label?: string
  value: string
}

export type ToolGroupDisplay = {
  label: string
  icon?: ToolGroupIconName
  status: ToolActivityStatus
  showShimmer: boolean
  count: number
  expandable: boolean
  detailRows: readonly ToolActivityDetailRow[]
}

export type ToolItemShellDetails = {
  command?: string
  cwd?: string
  output?: string
  exitCode?: number
  durationMs?: number
}

export type ToolItemFileChange = {
  path: string
  kind?: 'add' | 'delete' | 'update'
  patch?: string
}

export type ToolItemFileChangeDetails = {
  files: readonly ToolItemFileChange[]
}

export type ToolItemFileChangeStats = {
  additions: number
  deletions: number
}

export type ToolItemDisplayDetails = {
  shell?: ToolItemShellDetails
  fileChange?: ToolItemFileChangeDetails
  argsText?: string
  result?: unknown
  error?: unknown
  approval?: unknown
  showResult: boolean
}

export type ToolItemDisplay = {
  id: string
  label: string
  activeLabel?: string
  status: ToolActivityStatus
  statusLabel: string
  shortTarget?: string
  icon?: ToolGroupIconName
  toolName: string
  filePath?: string
  fileChangeStats?: ToolItemFileChangeStats
  defaultOpen: boolean
  details: ToolItemDisplayDetails
}

export type ToolActivityDisplayModel = {
  group: ToolGroupDisplay
  items: readonly ToolItemDisplay[]
}

export type ToolActivityDisplayOptions = {
  pendingLabel?: string
}

const MAX_TRIGGER_COMMAND_CHARS = 96
const MAX_ACTIVE_COMMAND_CHARS = 72
const MAX_SHELL_OUTPUT_CHARS = 20_000

export function buildToolActivityDisplayModel(
  unit: ToolGroupUnit,
  options: ToolActivityDisplayOptions = {}
): ToolActivityDisplayModel {
  const items = unit.children.map((item) => buildToolItemDisplay(item, unit))
  return {
    group: buildToolGroupDisplay(unit, items, options),
    items
  }
}

export function buildToolGroupDisplay(
  unit: ToolGroupUnit,
  items: readonly ToolItemDisplay[] = unit.children.map((item) => buildToolItemDisplay(item, unit)),
  options: ToolActivityDisplayOptions = {}
): ToolGroupDisplay {
  const status = toolGroupActivityStatus(unit, items)
  const showThinkingFallback = unit.showThinkingFallback === true
  const showShimmer =
    showThinkingFallback ||
    status === 'running' ||
    status === 'requiresAction' ||
    Boolean(unit.active)

  return {
    label: showThinkingFallback
      ? (options.pendingLabel ?? pendingAssistantMessageText)
      : toolGroupLabel(unit, items, showShimmer),
    icon: showThinkingFallback ? undefined : toolGroupIcon(unit),
    status,
    showShimmer,
    count: unit.children.length,
    expandable: !unit.summaryOnly,
    detailRows: groupDetailRows(unit.summary)
  }
}

export function buildToolItemDisplay(item: ToolItem, group?: ToolGroupUnit): ToolItemDisplay {
  const part = item.rawPart
  const toolName = stringValue(part.toolName) ?? item.kind ?? 'unknown_tool'
  const status = toolItemActivityStatus(item)
  const shell = shellCommandDetails(item)
  const fileChange = fileChangeDetails(item)
  const fileChangeStats = fileChangeLineStats(fileChange?.files)
  const argsText = shell ? undefined : formattedJson(item.input)
  const result = item.output
  const error = itemError(item)
  const approval = itemApproval(item)
  const showResult = shell
    ? shouldRenderShellResult(result, part.isError === true)
    : result !== undefined
  const label =
    shell?.command !== undefined
      ? commandItemLabel(shell.command, status)
      : itemLabel(item, group, status)

  return {
    id: item.id,
    label,
    activeLabel: activeItemLabel(item, group, shell, status),
    status,
    statusLabel: statusLabel(status),
    shortTarget: shortTarget(item, shell),
    icon: itemIcon(item, group),
    toolName,
    filePath: fileChange?.files[0]?.path,
    fileChangeStats,
    defaultOpen: status === 'requiresAction',
    details: {
      shell,
      fileChange,
      argsText,
      result,
      error,
      approval,
      showResult
    }
  }
}

export function shellOutputText(details: ToolItemShellDetails): string {
  return [details.command ? `$ ${details.command}` : undefined, truncateShellOutput(details.output)]
    .filter(isDefined)
    .filter((line) => line.length > 0)
    .join('\n')
}

export function shellMetadata(details: ToolItemShellDetails): string[] {
  return [
    details.cwd ? `cwd: ${details.cwd}` : undefined,
    details.exitCode !== undefined ? `exit ${details.exitCode}` : undefined,
    details.durationMs !== undefined ? durationLabel(details.durationMs) : undefined
  ].filter(isDefined)
}

function toolGroupLabel(
  unit: ToolGroupUnit,
  items: readonly ToolItemDisplay[],
  active: boolean
): string {
  if (unit.kind === 'exploration') return explorationGroupLabel(unit)
  if (unit.kind === 'mcp') return mcpGroupLabel(unit, unit.mcpSource?.label, active)
  if (unit.kind === 'dynamic') return dynamicGroupLabel(unit, active)
  if (unit.kind === 'web-search') return webSearchGroupLabel(unit, active)
  if (unit.kind === 'multi-agent') return multiAgentGroupLabel(unit, active)

  const onlyItem = items.length === 1 ? items[0] : undefined
  if (active && onlyItem?.activeLabel) return onlyItem.activeLabel
  if (onlyItem && isAttentionStatus(onlyItem.status)) return onlyItem.activeLabel ?? onlyItem.label

  return unit.summary?.label ?? (active ? '正在使用工具' : '已使用工具')
}

function toolGroupIcon(unit: ToolGroupUnit): ToolGroupIconName | undefined {
  if (unit.kind === 'exploration') return 'code-searching'
  if (unit.kind === 'mcp') return 'mcp-tools'
  if (unit.kind === 'dynamic') return unit.summary?.icon ?? 'generic-tool'
  if (unit.kind === 'web-search') return 'web-search'
  if (unit.kind === 'multi-agent') return 'sub-agent'
  return unit.summary?.icon
}

function groupDetailRows(summary: ToolGroupSummary | undefined): ToolActivityDetailRow[] {
  if (!summary) return []

  const rows: ToolActivityDetailRow[] = []
  if (summary.sourceSummary) rows.push({ label: '来源', value: summary.sourceSummary })

  for (const detail of summary.details) {
    if (isGroupLevelDetail(detail)) rows.push({ value: detail })
  }

  return rows
}

function isGroupLevelDetail(detail: string): boolean {
  return detail.startsWith('已停止') || detail.includes('自动审批')
}

function explorationGroupLabel(unit: ToolGroupUnit): string {
  const counts = explorationCounts(unit.children)
  const details = [
    counts.read > 0 ? `${counts.read} 个文件` : undefined,
    counts.search > 0 ? `${counts.search} 次搜索` : undefined,
    counts.list > 0 ? `${counts.list} 次列表` : undefined
  ].filter(isDefined)
  const prefix = unit.active ? '正在探索' : '已探索'

  return details.length > 0 ? `${prefix} ${details.join('，')}` : prefix
}

function explorationCounts(items: readonly ToolItem[]): {
  read: number
  search: number
  list: number
} {
  const counts = { read: 0, search: 0, list: 0 }

  for (const item of items) {
    const actions = explorationActionsForToolItem(item)
    for (const action of actions) {
      if (action === 'read') counts.read += 1
      if (action === 'search') counts.search += 1
      if (action === 'list') counts.list += 1
    }
  }

  return counts
}

function explorationActionsForToolItem(item: ToolItem): string[] {
  const record = recordValue(item.rawItem) ?? recordValue(item.input)
  if (!record) return []

  const commandActions = arrayValue(record.commandActions)
    .map(recordValue)
    .filter(isDefined)
    .map((action) => explorationActionKind(stringValue(action.type)))
    .filter(isDefined)
  if (commandActions.length > 0) return commandActions

  const parsed = recordValue(record.parsedCmd)
  const parsedKind = explorationActionKind(stringValue(parsed?.type))
  return parsedKind ? [parsedKind] : []
}

function explorationActionKind(value: string | undefined): 'read' | 'search' | 'list' | undefined {
  switch (value) {
    case 'read':
    case 'readFile':
    case 'read_file':
      return 'read'
    case 'search':
    case 'searchCode':
    case 'search_code':
    case 'grep':
    case 'rg':
      return 'search'
    case 'list':
    case 'listFiles':
    case 'list_files':
    case 'ls':
      return 'list'
    default:
      return undefined
  }
}

function mcpGroupLabel(
  unit: ToolGroupUnit,
  sourceLabel: string | undefined,
  active: boolean
): string {
  const sourceType = unit.mcpSource?.sourceType
  if (sourceType === 'node-repl') {
    return active ? '正在运行命令' : commandCountLabel(unit.children.length)
  }
  if (sourceType === 'browser') {
    return active ? '正在使用 Browser' : '已使用 Browser'
  }
  if (sourceType === 'app' && sourceLabel) {
    return active ? `正在使用 ${sourceLabel}` : `已使用 ${sourceLabel} 集成`
  }

  if (active) {
    return sourceLabel ? `正在使用 ${sourceLabel}` : (unit.summary?.activeSummary ?? '正在使用集成')
  }
  if (sourceLabel) return `已使用 ${sourceLabel}`
  if (unit.summary?.sourceSummary) return `已使用 ${unit.summary.sourceSummary}`
  return unit.summary?.label ?? '已使用集成'
}

function dynamicGroupLabel(unit: ToolGroupUnit, active: boolean): string {
  const labels = unit.dynamicMetadata?.displayLabels ?? []
  if (labels.length > 0) {
    return labels
      .map((label) => {
        const text = active ? label.activeLabel : label.completedLabel
        return label.count > 1 ? `${text}（${label.count} 次）` : text
      })
      .join(' · ')
  }

  return unit.summary?.label ?? '已使用工具'
}

function webSearchGroupLabel(unit: ToolGroupUnit, active: boolean): string {
  if (active) {
    return unit.children.length === 1
      ? (unit.summary?.activeSummary ?? '正在搜索网页')
      : (unit.summary?.label ?? '正在搜索网页')
  }
  return '已搜索网页'
}

function multiAgentGroupLabel(unit: ToolGroupUnit, active: boolean): string {
  const count = multiAgentReceiverCount(unit)
  const failed = unit.status === 'error'

  switch (unit.action) {
    case 'spawnAgent':
      if (failed) return `启动 ${count} 个子 agent 失败`
      return active ? `正在启动 ${count} 个子 agent` : `已启动 ${count} 个子 agent`
    case 'sendInput':
      if (failed) return `向 ${count} 个子 agent 发送消息失败`
      return active ? `正在向 ${count} 个子 agent 发送消息` : `已向 ${count} 个子 agent 发送消息`
    case 'resumeAgent':
      if (failed) return `恢复 ${count} 个子 agent 失败`
      return active ? `正在恢复 ${count} 个子 agent` : `已恢复 ${count} 个子 agent`
    case 'closeAgent':
      if (failed) return `关闭 ${count} 个子 agent 失败`
      return active ? `正在关闭 ${count} 个子 agent` : `已关闭 ${count} 个子 agent`
    default:
      if (failed) return `处理 ${count} 个协作任务失败`
      return active ? `正在处理 ${count} 个协作任务` : `已处理 ${count} 个协作任务`
  }
}

function multiAgentReceiverCount(unit: ToolGroupUnit): number {
  const threadIds = new Set<string>()

  for (const child of unit.children) {
    const item = child.rawItem
    const input = recordValue(child.input)
    const receiverThreadIds = arrayValue(item?.receiverThreadIds ?? input?.receiverThreadIds)
    for (const threadId of receiverThreadIds) {
      if (typeof threadId === 'string' && threadId.length > 0) threadIds.add(threadId)
    }
  }

  return threadIds.size > 0 ? threadIds.size : unit.children.length
}

function commandCountLabel(count: number): string {
  return count === 1 ? '已运行命令' : `已运行 ${count} 条命令`
}

function isAttentionStatus(status: ToolActivityStatus): boolean {
  return status === 'requiresAction' || status === 'stopped' || status === 'error'
}

function toolGroupActivityStatus(
  unit: ToolGroupUnit,
  items: readonly ToolItemDisplay[]
): ToolActivityStatus {
  if (unit.status === 'requires-action' || items.some((item) => item.status === 'requiresAction')) {
    return 'requiresAction'
  }
  if (unit.status === 'running' || unit.active || items.some((item) => item.status === 'running')) {
    return 'running'
  }
  const statuses = new Set(items.map((item) => item.status))
  if (statuses.size > 1) return 'mixed'
  if (items.some((item) => item.status === 'error')) return 'error'
  if (items.some((item) => item.status === 'stopped')) return 'stopped'
  return statuses.values().next().value ?? 'completed'
}

function toolItemActivityStatus(item: ToolItem): ToolActivityStatus {
  const itemStatus = stringValue(item.rawItem?.status)
  const partStatus = recordValue(item.rawPart.status)

  if (item.status === 'requires-action') return 'requiresAction'
  if (item.status === 'running') return 'running'
  if (
    itemStatus === 'cancelled' ||
    itemStatus === 'stopped' ||
    partStatus?.reason === 'cancelled'
  ) {
    return 'stopped'
  }
  if (
    item.status === 'error' ||
    itemStatus === 'failed' ||
    itemStatus === 'error' ||
    item.rawPart.isError === true ||
    itemError(item) !== undefined
  ) {
    return 'error'
  }

  return 'completed'
}

function statusLabel(status: ToolActivityStatus): string {
  switch (status) {
    case 'running':
      return '正在运行'
    case 'requiresAction':
      return '等待审批'
    case 'stopped':
      return '已停止'
    case 'error':
      return '出错'
    case 'mixed':
      return '状态混合'
    case 'completed':
      return '已完成'
  }
}

function itemLabel(
  item: ToolItem,
  group: ToolGroupUnit | undefined,
  status: ToolActivityStatus
): string {
  if (item.kind === 'mcpToolCall') return mcpItemLabel(item)
  if (item.kind === 'webSearch') return webSearchItemLabel(item)
  if (item.kind === 'fileChange') return fileChangeItemLabel(item, status)

  const dynamicLabel = dynamicToolMetadataLabel(
    item.dynamicMetadata ?? group?.dynamicMetadata,
    item.rawPart,
    status === 'running'
  )
  if (dynamicLabel) return withVisibleStatus(dynamicLabel, status)

  const label = item.label ?? humanizeToolName(stringValue(item.rawPart.toolName)) ?? 'Tool'
  return withVisibleStatus(label, status)
}

function activeItemLabel(
  item: ToolItem,
  group: ToolGroupUnit | undefined,
  shell: ToolItemShellDetails | undefined,
  status: ToolActivityStatus
): string | undefined {
  if (shell?.command) return commandItemLabel(shell.command, status, MAX_ACTIVE_COMMAND_CHARS)
  if (item.kind === 'webSearch') {
    const query = webSearchQuery(item)
    return query
      ? `正在搜索网页：${truncateMiddle(query, MAX_ACTIVE_COMMAND_CHARS)}`
      : '正在搜索网页'
  }
  if (item.kind === 'mcpToolCall') {
    const label = mcpItemLabel(item)
    return label ? `正在调用 ${label.replace(/^MCP：/, '')}` : '正在调用 MCP 工具'
  }

  const dynamicLabel = dynamicToolMetadataLabel(
    item.dynamicMetadata ?? group?.dynamicMetadata,
    item.rawPart,
    true
  )
  return dynamicLabel ? withVisibleStatus(dynamicLabel, status) : undefined
}

function shortTarget(item: ToolItem, shell: ToolItemShellDetails | undefined): string | undefined {
  if (shell?.command) return truncateMiddle(shell.command, MAX_ACTIVE_COMMAND_CHARS)
  if (item.kind === 'webSearch') return webSearchQuery(item)
  if (item.kind === 'mcpToolCall') return mcpItemLabel(item).replace(/^MCP：/, '')
  return item.label
}

function itemIcon(item: ToolItem, group: ToolGroupUnit | undefined): ToolGroupIconName | undefined {
  if (item.kind === 'commandExecution' || item.kind === 'exec') return 'run-command'
  if (item.kind === 'fileChange') return 'edit-files'
  if (item.kind === 'webSearch') return 'web-search'
  if (item.kind === 'mcpToolCall') {
    return group?.mcpSource?.sourceType === 'node-repl' ? 'run-command' : 'mcp-tools'
  }
  return group?.summary?.icon
}

function itemError(item: ToolItem): unknown {
  const partStatus = recordValue(item.rawPart.status)
  const result = recordValue(item.rawPart.result)
  const output = recordValue(item.rawPart.output)
  return item.error ?? partStatus?.error ?? result?.error ?? output?.error
}

function itemApproval(item: ToolItem): unknown {
  return item.rawPart.approval ?? item.rawPart.interrupt
}

function shellCommandDetails(item: ToolItem): ToolItemShellDetails | undefined {
  const part = item.rawPart
  const rawItem = recordValue(item.rawItem) ?? extractThreadItem(part)
  const input = recordValue(item.input) ?? recordValue(extractToolInput(part))

  if (item.kind !== 'commandExecution' && item.kind !== 'exec') return undefined

  const details = {
    command:
      stringValue(rawItem?.command) ??
      stringValue(input?.command) ??
      commandFromActions(rawItem?.commandActions) ??
      commandFromActions(input?.commandActions),
    cwd: stringValue(rawItem?.cwd) ?? stringValue(input?.cwd),
    output:
      stringValue(rawItem?.aggregatedOutput) ??
      stringValue(rawItem?.output) ??
      stringValue(recordValue(part.result)?.output) ??
      stringValue(recordValue(part.output)?.output),
    exitCode: numberValue(rawItem?.exitCode),
    durationMs: numberValue(rawItem?.durationMs)
  }

  return hasShellCommandDetails(details) ? details : undefined
}

function fileChangeDetails(item: ToolItem): ToolItemFileChangeDetails | undefined {
  if (item.kind !== 'fileChange') return undefined

  const input = recordValue(item.input)
  const source = item.rawItem ?? input
  const files = arrayValue(source?.changes)
    .map(recordValue)
    .filter(isDefined)
    .map((change, index) => ({
      path:
        stringValue(change.path) ??
        stringValue(change.file) ??
        stringValue(change.filename) ??
        `文件 ${index + 1}`,
      kind: fileChangeKind(change.kind),
      patch: stringValue(change.diff) ?? stringValue(change.patch)
    }))

  return { files }
}

function fileChangeKind(value: unknown): ToolItemFileChange['kind'] | undefined {
  const type = stringValue(recordValue(value)?.type) ?? stringValue(value)
  if (type === 'add' || type === 'delete' || type === 'update') return type
  return undefined
}

function fileChangeLineStats(
  files: readonly ToolItemFileChange[] | undefined
): ToolItemFileChangeStats | undefined {
  let additions = 0
  let deletions = 0

  for (const file of files ?? []) {
    for (const line of file.patch?.split('\n') ?? []) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) additions += 1
      if (line.startsWith('-')) deletions += 1
    }
  }

  if (additions === 0 && deletions === 0) return undefined
  return { additions, deletions }
}

function hasShellCommandDetails(details: ToolItemShellDetails): boolean {
  return Boolean(
    details.command ||
    details.cwd ||
    details.output ||
    details.exitCode !== undefined ||
    details.durationMs !== undefined
  )
}

function commandFromActions(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined

  return value
    .map(recordValue)
    .filter(isDefined)
    .map((action) => stringValue(action.command))
    .find(isDefined)
}

function mcpItemLabel(item: ToolItem): string {
  const sourceLabel = item.source?.label ?? mcpItemSourceLabel(item.rawItem, item.rawPart)
  const tool =
    stringValue(item.rawItem?.tool) ?? mcpToolFromToolName(stringValue(item.rawPart.toolName))
  return `MCP：${[sourceLabel, tool].filter(Boolean).join(' / ') || item.label || 'MCP 工具'}`
}

function mcpItemSourceLabel(item: AnyRecord | undefined, part: AnyRecord): string | undefined {
  const invocation = recordValue(item?.invocation)
  const appContext = recordValue(item?.appContext)
  return (
    stringValue(appContext?.displayName) ??
    stringValue(appContext?.appName) ??
    stringValue(appContext?.name) ??
    stringValue(item?.server) ??
    stringValue(invocation?.server) ??
    mcpServerFromToolName(stringValue(part.toolName))
  )
}

function webSearchItemLabel(item: ToolItem): string {
  const query = webSearchQuery(item)
  return query ? `网页搜索：${truncateMiddle(query, MAX_TRIGGER_COMMAND_CHARS)}` : '网页搜索'
}

function webSearchQuery(item: ToolItem): string | undefined {
  const input = recordValue(item.input)
  return stringValue(item.rawItem?.query) ?? stringValue(input?.query)
}

function fileChangeItemLabel(item: ToolItem, status: ToolActivityStatus): string {
  const changes = arrayValue(item.rawItem?.changes).map(recordValue).filter(isDefined)
  const firstChange = changes[0]
  const firstPath = changes.map((change) => stringValue(change.path)).find(isDefined)
  const label = fileChangeStatusLabel(firstChange, status)
  return firstPath ? `${label}：${firstPath}` : label
}

function dynamicToolMetadataLabel(
  metadata: DynamicToolMetadata | undefined,
  part: Record<string, unknown>,
  active: boolean
): string | undefined {
  const labels = metadata?.displayLabels
  if (!labels || labels.length === 0) return undefined

  const callId = stringValue(part.toolCallId) ?? stringValue(part.id)
  const label =
    (callId ? labels.find((candidate) => candidate.callIds.includes(callId)) : undefined) ??
    (labels.length === 1 ? labels[0] : undefined)

  if (!label) return undefined
  return active ? label.activeLabel : label.completedLabel
}

function shouldRenderShellResult(result: unknown, isError: boolean): boolean {
  if (result === undefined) return false
  if (isError) return true

  const record = recordValue(result)
  if (!record) return true
  if (record.error !== undefined) return true
  if (record.isError === true) return true

  const item = recordValue(record.item)
  if (stringValue(item?.type) === 'commandExecution') return false
  if (stringValue(record.type) === 'commandExecution') return false

  return true
}

function commandItemLabel(
  command: string,
  status: ToolActivityStatus,
  maxLength = MAX_TRIGGER_COMMAND_CHARS
): string {
  return `${commandStatusLabel(status)}：${truncateMiddle(command, maxLength)}`
}

function commandStatusLabel(status: ToolActivityStatus): string {
  switch (status) {
    case 'running':
      return '正在运行'
    case 'requiresAction':
      return '等待审批'
    case 'stopped':
      return '已停止'
    case 'error':
      return '命令出错'
    case 'mixed':
      return '命令状态混合'
    case 'completed':
      return '已运行'
  }
}

function fileChangeStatusLabel(change: AnyRecord | undefined, status: ToolActivityStatus): string {
  const action = fileChangeAction(change)
  if (status === 'requiresAction') return '等待审批'
  if (status === 'stopped') return action === 'create' ? '已停止创建' : '已停止变更'
  if (status === 'error') return '文件变更出错'
  if (status === 'mixed') return '文件变更状态混合'

  if (action === 'create') return status === 'running' ? '正在创建' : '已创建'
  if (action === 'delete') return status === 'running' ? '正在删除' : '已删除'
  return status === 'running' ? '正在编辑' : '已编辑'
}

function fileChangeAction(change: AnyRecord | undefined): 'create' | 'delete' | 'edit' {
  const kind = recordValue(change?.kind)
  if (kind?.type === 'add') return 'create'
  if (kind?.type === 'delete') return 'delete'
  return 'edit'
}

function withVisibleStatus(label: string, status: ToolActivityStatus): string {
  if (status === 'completed') return label
  const statusText = statusLabel(status)
  if (labelImpliesStatus(label, statusText)) return label
  return `${statusText}：${label}`
}

function labelImpliesStatus(label: string, statusText: string): boolean {
  if (label.includes(statusText)) return true
  if (statusText === '正在运行' && label.startsWith('正在')) return true
  if (statusText === '已停止' && label.startsWith('已停止')) return true
  if (statusText === '出错' && label.includes('出错')) return true
  if (statusText === '等待审批' && label.includes('等待审批')) return true
  if (statusText === '状态混合' && label.includes('状态混合')) return true
  return false
}

function truncateShellOutput(output: string | undefined): string | undefined {
  if (!output || output.length <= MAX_SHELL_OUTPUT_CHARS) return output

  const hiddenChars = output.length - MAX_SHELL_OUTPUT_CHARS
  return `${output.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n\n[output truncated: ${hiddenChars} chars hidden]`
}

function durationLabel(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  return `${Number((durationMs / 1000).toFixed(1))}s`
}

function formattedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function humanizeToolName(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined
  const cleaned = toolName
    .replace(/^mcp:/, '')
    .replace(/^codex_/, '')
    .replace(/[_/-]+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase())
}

function mcpServerFromToolName(toolName: string | undefined): string | undefined {
  if (!toolName?.startsWith('mcp:')) return undefined
  const body = toolName.slice('mcp:'.length)
  return body.split('/')[0] || undefined
}

function mcpToolFromToolName(toolName: string | undefined): string | undefined {
  if (!toolName?.startsWith('mcp:')) return undefined
  const slashIndex = toolName.indexOf('/')
  if (slashIndex < 0) return undefined
  return toolName.slice(slashIndex + 1) || undefined
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value

  const half = Math.floor((maxLength - 5) / 2)
  return `${value.slice(0, half)} ... ${value.slice(value.length - half)}`
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function recordValue(value: unknown): AnyRecord | undefined {
  return isRecord(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
