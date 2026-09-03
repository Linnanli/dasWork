import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ClockIcon,
  CombineIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileIcon,
  FilePenIcon,
  FolderOpenIcon,
  ImageIcon,
  LinkIcon,
  ListChecksIcon,
  MessageSquareMoreIcon,
  MoreHorizontalIcon,
  PanelRightOpenIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  Undo2Icon,
  WrenchIcon,
  type LucideIcon
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table'
import { DiffViewer } from '@/components/assistant-ui/diff-viewer'
import {
  useLocalGitReview,
  type LocalGitReviewLastTurn
} from '@/components/local-git-review/LocalGitReviewProvider'
import { useOptionalRightWorkspace } from '@/components/right-workspace'
import { isPptxArtifactPath } from '@/components/workspace-container'
import { toolGroupIconMap } from '@/components/assistant-ui/tool-group'
import type { AssistantRenderUnit, McpSourceMetadata } from '@/lib/assistantRenderUnits'
import type { CodeComment } from '@/lib/codeCommentDirectives'
import {
  normalizeTodoItems,
  parseTurnDiffFiles,
  turnDiffLineTotals,
  type TurnDiffFile
} from '@/lib/composerTurnStatus'
import type { ToolActivityDetailRow } from '@/lib/toolActivityDisplay'
import {
  extractToolInput,
  extractThreadItem,
  isToolPartActive,
  type ToolGroupSummary
} from '@/lib/toolGroupSummary'
import {
  resolveInlineReferenceAction,
  type InlineReferenceAction
} from '@/lib/referenceInlineAction'
import type { InlineReferenceDescriptor } from '@/lib/referenceInlineTarget'
import { cn } from '@/lib/utils'
import { renderUnitAttributes } from './renderUnitAttributes'
import { ResourceFileIcon } from './resourceFileIcon'

type AnyRecord = Record<string, unknown>
type EntryUnit = Extract<AssistantRenderUnit, { type: 'entry' }>
type ReviewCommentsUnit = Extract<AssistantRenderUnit, { type: 'review-comments' }>

const CODEX_PROVIDER_ID = '@janole/ai-sdk-provider-codex-asp'
const MAX_VISIBLE_ROWS = 3
const MAX_VISIBLE_DIFF_FILES = 3
const LARGE_DIFF_TEXT_LENGTH = 50_000
const MAX_LOCAL_PATH_CHECK_BATCH_SIZE = 64
const WebSearchIcon = toolGroupIconMap['web-search']

export function CollapsedActivityDetails({
  detailRows,
  summary
}: {
  detailRows?: readonly ToolActivityDetailRow[]
  summary?: ToolGroupSummary
}): React.JSX.Element | null {
  const rows: readonly ToolActivityDetailRow[] = detailRows ?? legacySummaryRows(summary)

  if (rows.length === 0) return null

  return (
    <div data-slot="collapsed-activity-details" className="space-y-1 text-xs text-muted-foreground">
      <ul className="space-y-1">
        {rows.slice(0, 4).map((row) => (
          <li key={`${row.label ?? ''}:${row.value}`} className="min-w-0 truncate">
            {row.label ? `${row.label}：${row.value}` : row.value}
          </li>
        ))}
      </ul>
    </div>
  )
}

function legacySummaryRows(summary: ToolGroupSummary | undefined): ToolActivityDetailRow[] {
  return [
    summary?.sourceSummary ? { label: '来源', value: summary.sourceSummary } : undefined,
    ...(summary?.details ?? []).map((value) => ({ value }))
  ].filter(isDefined)
}

export function McpToolCallDetails({
  parts,
  mcpSource
}: {
  parts: readonly AnyRecord[]
  mcpSource?: McpSourceMetadata
}): React.JSX.Element {
  return (
    <div data-slot="mcp-rich-output" className="space-y-2">
      <McpSourceBadge source={mcpSource} />
      {parts.map((part, index) => (
        <McpToolCallDetail
          key={String(part.toolCallId ?? extractThreadItem(part)?.id ?? index)}
          part={part}
          index={index}
        />
      ))}
    </div>
  )
}

export function WebSearchDetails({ parts }: { parts: readonly AnyRecord[] }): React.JSX.Element {
  const items = parts.map(webSearchDetailForPart)
  const hasAnyTarget = items.some(({ target }) => target)

  if (!hasAnyTarget) {
    return (
      <p data-slot="web-search-detail-fallback" className="text-xs text-muted-foreground">
        搜索详情暂不可用
      </p>
    )
  }

  return (
    <ol data-slot="web-search-details" className="space-y-1">
      {items.map(({ part, item, target }, index) => {
        const active = isToolPartActive(part) || isActiveStatus(item?.status)

        return (
          <li
            key={String(item?.id ?? part.toolCallId ?? index)}
            className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
          >
            <WebSearchIcon
              aria-hidden
              data-slot="web-search-detail-icon"
              className="size-3.5 shrink-0"
            />
            <span className="shrink-0 leading-none font-normal">
              {active ? '正在搜索网页' : '已搜索网页'}
            </span>
            <span className="min-w-0 truncate leading-none font-normal">{target}</span>
          </li>
        )
      })}
    </ol>
  )
}

function webSearchDetailForPart(part: AnyRecord): {
  part: AnyRecord
  item?: AnyRecord
  target?: string
} {
  const item = extractThreadItem(part)
  const input = extractToolInput(part)
  const action = item?.action ?? webSearchActionFromInput(input)
  const query = stringValue(item?.query) ?? webSearchQueryFromInput(input)

  return {
    part,
    item,
    target: webSearchUrl(action) ?? query
  }
}

export function SpecialEntryRenderer({
  unit,
  workspaceCwd,
  canOpenLocalPaths = true
}: {
  unit: EntryUnit
  workspaceCwd?: string
  canOpenLocalPaths?: boolean
}): React.JSX.Element | null {
  const item = unit.item
  if (!item) return null

  switch (unit.itemType) {
    case 'todoList':
      return <TodoListEntryUnit unit={unit} />
    case 'turnDiff':
      return <TurnDiffEntryUnit unit={unit} />
    case 'imageGeneration':
      return <GeneratedImageEntryUnit unit={unit} />
    case 'endResources':
      return (
        <EndResourceCardsUnit
          unit={unit}
          workspaceCwd={workspaceCwd}
          canOpenLocalPaths={canOpenLocalPaths}
        />
      )
    case 'reviewComments':
      return <ReviewCommentsEntryUnit unit={unit} />
    case 'automaticApprovalReview':
      return <AutomaticApprovalReviewEntryUnit unit={unit} />
    case 'streamError':
    case 'systemError':
      return <ErrorEntryUnit unit={unit} />
    case 'permissionRequest':
    case 'mcpServerElicitation':
    case 'userInputResponse':
    case 'remoteTaskCreated':
    case 'personalityChanged':
    case 'modelChanged':
    case 'modelRerouted':
    case 'worktreeInit':
    case 'automationUpdate':
    case 'sleep':
    case 'loadedTool':
      return <CompactEntryUnit unit={unit} />
    case 'contextCompaction':
      return <ContextCompactionEntryUnit unit={unit} />
    default:
      return null
  }
}

export function UnknownPartRenderer({
  part,
  unit
}: {
  part: AnyRecord
  unit: Extract<AssistantRenderUnit, { type: 'unknown' }>
}): React.JSX.Element | null {
  if (part.type === 'file' && stringValue(part.mediaType)?.startsWith('image/')) {
    return <GeneratedImageFileUnit part={part} unit={unit} />
  }

  return null
}

function McpToolCallDetail({ part, index }: { part: AnyRecord; index: number }): React.JSX.Element {
  const item = extractThreadItem(part)
  const result = recordValue(item?.result)
  const progressOutput = stringValue(recordValue(part.result)?.output)
  const error = item?.error ?? (result?.isError === true ? result : undefined)
  const statusLabel = mcpStatusLabel(part, item)
  const sourceLabel = mcpItemSourceLabel(item, part)
  const tool = stringValue(item?.tool) ?? mcpToolFromToolName(stringValue(part.toolName))

  return (
    <section
      data-slot="mcp-call-detail"
      className="min-w-0 rounded-md border border-border/50 bg-background/60 px-3 py-2"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {[sourceLabel, tool].filter(Boolean).join(' / ') || `MCP 工具 ${index + 1}`}
          </p>
          <p className="text-xs text-muted-foreground">{statusLabel}</p>
        </div>
        {error ? (
          <span className="shrink-0 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
            错误
          </span>
        ) : null}
      </div>

      <McpArguments item={item} />
      {progressOutput ? (
        <p className="mt-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
          {progressOutput}
        </p>
      ) : null}
      <McpResultContent result={result} error={error} />
      <RawOutputToggle value={item?.result ?? item?.error ?? recordValue(part.result) ?? part} />
    </section>
  )
}

function McpArguments({ item }: { item?: AnyRecord }): React.JSX.Element | null {
  if (item?.arguments === undefined) return null
  return (
    <div className="mt-2">
      <p className="text-[11px] font-medium text-muted-foreground">参数</p>
      <JsonPreview value={item.arguments} className="mt-1 max-h-24" />
    </div>
  )
}

function McpResultContent({
  result,
  error
}: {
  result?: AnyRecord
  error: unknown
}): React.JSX.Element {
  if (error) {
    return (
      <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-2.5 py-2 text-sm text-destructive">
        {errorText(error)}
      </div>
    )
  }

  const content = arrayValue(result?.content)
  const structuredContent = result?.structuredContent ?? result?.structured_content

  if (content.length > 0) {
    return (
      <div className="mt-2 space-y-2">
        {content.map((block, index) => (
          <McpContentBlock key={index} block={block} />
        ))}
      </div>
    )
  }

  if (structuredContent !== undefined) {
    return (
      <div className="mt-2">
        <p className="text-[11px] font-medium text-muted-foreground">结构化结果</p>
        <JsonPreview value={structuredContent} className="mt-1" />
      </div>
    )
  }

  if (result) {
    const resultKeys = Object.keys(result).filter((key) => key !== 'isError')
    if (resultKeys.length > 0) return <JsonPreview value={result} className="mt-2" />
  }

  return (
    <p className="mt-2 rounded-md bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground">
      暂无内容
    </p>
  )
}

function McpContentBlock({ block }: { block: unknown }): React.JSX.Element {
  const record = recordValue(block)
  const type = stringValue(record?.type)

  if (type === 'text') {
    return (
      <p className="whitespace-pre-wrap rounded-md bg-muted/30 px-2.5 py-2 text-sm">
        {stringValue(record?.text) ?? ''}
      </p>
    )
  }

  if (type === 'image') {
    const src = mediaSrc(record)
    return src ? (
      <img
        alt={stringValue(record?.altText) ?? stringValue(record?.name) ?? 'MCP image'}
        className="max-h-72 max-w-full rounded-md border object-contain"
        src={src}
      />
    ) : (
      <JsonFallback label="图片内容缺少 preview" value={record} />
    )
  }

  if (type === 'audio') {
    const src = mediaSrc(record)
    return src ? (
      <audio className="w-full" controls src={src} />
    ) : (
      <JsonFallback label="音频内容" value={record} />
    )
  }

  if (type === 'resource_link') {
    const title = stringValue(record?.title) ?? stringValue(record?.name) ?? '资源链接'
    const uri = stringValue(record?.uri) ?? stringValue(record?.url)
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/50 px-2.5 py-2 text-sm">
        <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="truncate font-medium">{title}</p>
          {uri ? <p className="truncate text-xs text-muted-foreground">{uri}</p> : null}
        </div>
      </div>
    )
  }

  if (type === 'resource' || type === 'embedded_resource') {
    const resource = recordValue(record?.resource) ?? record
    const title =
      stringValue(resource?.title) ??
      stringValue(resource?.name) ??
      stringValue(resource?.uri) ??
      '嵌入资源'
    const text = stringValue(resource?.text) ?? stringValue(resource?.blob)
    return (
      <div className="rounded-md border border-border/50 px-2.5 py-2 text-sm">
        <p className="font-medium">{title}</p>
        {text ? (
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{text}</p>
        ) : (
          <JsonPreview value={resource} className="mt-2" />
        )}
      </div>
    )
  }

  return <JsonFallback label={type ? `未知内容：${type}` : '未知内容'} value={record ?? block} />
}

function McpSourceBadge({ source }: { source?: McpSourceMetadata }): React.JSX.Element | null {
  if (!source) return null
  const sourceLabelMap: Record<McpSourceMetadata['sourceType'], string> = {
    app: 'App',
    server: 'Server',
    browser: 'Browser',
    'computer-use': 'Computer Use',
    'node-repl': 'Node'
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="rounded-sm border border-border/60 px-1.5 py-0.5">
        {sourceLabelMap[source.sourceType]}
      </span>
      <span className="min-w-0 truncate">{source.label}</span>
      {source.pluginId ? <span className="truncate">plugin:{source.pluginId}</span> : null}
    </div>
  )
}

function TodoListEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const item = unit.item ?? {}
  const todos = normalizeTodoItems(item)
  const completed = todos.filter((todo) => todo.status === 'completed').length
  const current = todos.find((todo) => todo.status !== 'completed')

  return (
    <RenderUnitCard unit={unit} slot="todo-list-entry-unit">
      <div className="flex items-start gap-2">
        <ListChecksIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            待办进度 {completed}/{todos.length || 0}
          </p>
          {current ? (
            <p className="truncate text-xs text-muted-foreground">当前：{current.label}</p>
          ) : null}
          {todos.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm">
              {todos.slice(0, 5).map((todo, index) => (
                <li key={`${todo.label}:${index}`} className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      todo.status === 'completed' ? 'bg-emerald-500' : 'bg-muted-foreground'
                    )}
                  />
                  <span className="min-w-0 truncate">{todo.label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">待办详情暂不可用</p>
          )}
        </div>
      </div>
    </RenderUnitCard>
  )
}

function TurnDiffEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const item = unit.item ?? {}
  const files = parseTurnDiffFiles(item)
  const { additions: added, deletions: removed } = turnDiffLineTotals(files)
  const diffTextLength = files.reduce((total, file) => total + (file.diff?.length ?? 0), 0)
  const largeDiff = isDiffTruncated(item) || diffTextLength > LARGE_DIFF_TEXT_LENGTH
  const cwd = turnDiffCwd(item)
  const [expanded, setExpanded] = useState(false)
  const [patchAction, setPatchAction] = useState<'undo' | 'reapply'>('undo')
  const [patchPending, setPatchPending] = useState(false)
  const [patchError, setPatchError] = useState<string>()
  const [patchFeedback, setPatchFeedback] = useState<string>()
  const { notifyGitOperation, openReview, target } = useLocalGitReview()
  const batches = turnPatchBatches(item)
  const turnId = completedTurnId(item, unit.key)
  const patchUnavailableReason = turnPatchUnavailableReason(item, batches)
  const canApplyPatch = Boolean(target && batches && item.status === 'completed')
  const patchActionLabel = turnPatchActionLabel(patchAction, patchPending)
  const visible = expanded ? files : files.slice(0, MAX_VISIBLE_DIFF_FILES)

  const applyTurnPatch = (): void => {
    if (!target || !batches || !canApplyPatch || patchPending) return
    setPatchPending(true)
    setPatchError(undefined)
    setPatchFeedback(undefined)
    void window.desktopApp.git
      .applyTurnPatch({ target, action: patchAction, turnId, batches })
      .then((result) => {
        if (result.status === 'success') {
          setPatchAction((action) => (action === 'undo' ? 'reapply' : 'undo'))
          notifyGitOperation?.({
            tone: 'success',
            message: patchAction === 'undo' ? 'Changes reverted' : 'Changes reapplied'
          })
          return
        }
        const message = turnPatchFeedback(patchAction, result.status)
        notifyGitOperation?.({
          tone: result.status === 'partial-success' ? 'info' : 'error',
          message
        })
        if (result.status === 'partial-success') {
          setPatchFeedback(mutationResultDetails(result))
          return
        }
        setPatchError(message)
      })
      .catch((error) => {
        const message = turnPatchFeedback(patchAction, 'error')
        notifyGitOperation?.({ tone: 'error', message })
        setPatchError(error instanceof Error ? error.message : message)
      })
      .finally(() => setPatchPending(false))
  }

  return (
    <Card
      data-slot="turn-diff-entry-unit"
      className="mt-6 gap-0 rounded-2xl py-0 shadow-none"
      {...renderUnitAttributes(unit)}
    >
      <CardHeader className="!grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-3 py-3 sm:px-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background">
          <FilePenIcon aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <CardTitle className="text-base tracking-tight sm:text-lg">
            已编辑 {files.length} 个文件
          </CardTitle>
          {added > 0 || removed > 0 ? (
            <CardDescription
              data-slot="turn-diff-line-summary"
              className="mt-0.5 flex items-center gap-2 text-sm tabular-nums"
            >
              {added > 0 ? (
                <span className="text-emerald-500 dark:text-emerald-400">+{added}</span>
              ) : null}
              {removed > 0 ? (
                <span className="text-red-500 dark:text-red-400">-{removed}</span>
              ) : null}
            </CardDescription>
          ) : null}
        </div>
        <CardAction className="!col-start-3 !row-span-1 !row-start-1 flex shrink-0 items-center gap-5 self-center justify-self-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={!canApplyPatch || patchPending}
            title={turnPatchActionTitle(canApplyPatch, patchAction, patchUnavailableReason)}
            className="h-auto gap-1.5 px-0 py-1.5 text-sm font-semibold hover:bg-transparent"
            onClick={applyTurnPatch}
          >
            {patchActionLabel}
            <Undo2Icon className="size-4" strokeWidth={1.8} />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-auto rounded-xl px-3 py-1.5 text-sm font-semibold"
            onClick={() => openReview({ type: 'last-turn', turnId }, lastTurnReview(turnId, files))}
          >
            审核
          </Button>
        </CardAction>
      </CardHeader>
      {largeDiff ? (
        <CardContent className="border-b bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground sm:px-6">
          大 diff 已折叠，只显示文件摘要
        </CardContent>
      ) : null}
      {files.length > 0 ? (
        <CardContent className="px-0">
          <Table>
            <TableBody>
              {visible.map((file, index) => (
                <TurnDiffFileRow
                  key={`${file.path}:${index}`}
                  file={file}
                  cwd={cwd}
                  onOpen={() =>
                    openReview(
                      { type: 'last-turn', turnId },
                      lastTurnReview(turnId, files, file.path)
                    )
                  }
                />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      ) : (
        <CardContent className="px-4 py-4 text-sm text-muted-foreground sm:px-6">
          暂未取得文件明细
        </CardContent>
      )}
      {patchError ? (
        <CardContent className="border-t px-3 py-2 text-xs text-destructive sm:px-4">
          <span role="alert">{patchError}</span>
        </CardContent>
      ) : null}
      {patchFeedback ? (
        <CardContent className="border-t px-3 py-2 text-xs text-muted-foreground sm:px-4">
          <span role="status">{patchFeedback}</span>
        </CardContent>
      ) : null}
      {patchUnavailableReason ? (
        <CardContent className="border-t px-3 py-2 text-xs text-muted-foreground sm:px-4">
          {patchUnavailableReason}
        </CardContent>
      ) : null}
      {expanded || files.length > visible.length ? (
        <CardFooter className="p-0">
          <TurnDiffShowMoreButton
            expanded={expanded}
            hiddenCount={files.length - visible.length}
            onClick={() => setExpanded((value) => !value)}
          />
        </CardFooter>
      ) : null}
    </Card>
  )
}

function turnPatchActionLabel(action: 'undo' | 'reapply', pending: boolean): string {
  if (pending) return '处理中'
  return action === 'undo' ? '撤销' : '重新应用'
}

function turnPatchActionTitle(
  canApplyPatch: boolean,
  action: 'undo' | 'reapply',
  unavailableReason: string | undefined
): string {
  if (!canApplyPatch) return unavailableReason ?? '撤销需要受信任 Git 仓库中的已完成补丁'
  return action === 'undo' ? '撤销本轮编辑' : '重新应用本轮编辑'
}

function turnPatchFeedback(
  action: 'undo' | 'reapply',
  status: 'partial-success' | 'error'
): string {
  if (status === 'partial-success') {
    return action === 'undo' ? 'Changes partially reverted' : 'Changes partially reapplied'
  }
  return action === 'undo' ? 'Failed to revert changes' : 'Failed to reapply changes'
}

function mutationResultDetails(result: {
  appliedPaths: string[]
  skippedPaths: string[]
  conflictedPaths: string[]
}): string {
  const parts = [
    result.appliedPaths.length > 0 ? `Applied: ${result.appliedPaths.join(', ')}` : undefined,
    result.skippedPaths.length > 0 ? `Skipped: ${result.skippedPaths.join(', ')}` : undefined,
    result.conflictedPaths.length > 0
      ? `Conflicts: ${result.conflictedPaths.join(', ')}`
      : undefined
  ].filter((part): part is string => Boolean(part))
  return parts.join(' · ') || 'Partial success'
}

function turnPatchBatches(
  item: AnyRecord
): Array<{ cwd: string; diff: string; gitRoot?: string }> | undefined {
  const rawBatches = item.patchBatches
  if (!Array.isArray(rawBatches) || rawBatches.length === 0) return undefined
  const batches = rawBatches.map((rawBatch) => {
    const batch = recordValue(rawBatch)
    const cwd = stringValue(batch?.cwd)
    const diff = stringValue(batch?.diff)
    if (!cwd || !diff) return undefined
    const gitRoot = stringValue(batch?.gitRoot)
    return { cwd, diff, ...(gitRoot ? { gitRoot } : {}) }
  })
  return batches.every(isDefined) ? batches : undefined
}

function turnPatchUnavailableReason(
  item: AnyRecord,
  batches: Array<{ cwd: string; diff: string; gitRoot?: string }> | undefined
): string | undefined {
  if (item.status !== 'completed') return '本轮编辑尚未完成，暂不能恢复。'
  if (batches) return undefined
  if (item.patchUnavailableReason === 'patch-too-large') {
    return '完整补丁超过安全大小限制，无法恢复。'
  }
  if (item.patchUnavailableReason === 'missing-cwd') {
    return '缺少完整补丁的工作目录，无法恢复。'
  }
  return '缺少完整补丁数据，无法恢复。'
}

function lastTurnReview(
  turnId: string,
  files: readonly TurnDiffFile[],
  selectedPath?: string
): LocalGitReviewLastTurn {
  return {
    turnId,
    ...(selectedPath ? { selectedPath } : {}),
    files: files.map((file) => ({
      path: file.path,
      diff: file.diff,
      additions: file.added,
      deletions: file.removed
    }))
  }
}

function TurnDiffFileRow({
  file,
  cwd,
  onOpen
}: {
  file: TurnDiffFile
  cwd: string | undefined
  onOpen(): void
}): React.JSX.Element {
  const displayPath = displayTurnDiffFilePath(file.path, cwd)

  return (
    <TableRow>
      <TableCell className="p-0">
        <HoverCard openDelay={150} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span className="block min-w-0">
              <Button
                aria-label={`在审核中查看 ${file.path}`}
                type="button"
                title={`在审核中查看 ${file.path}`}
                variant="ghost"
                className="h-auto w-full min-w-0 justify-start gap-4 rounded-none px-4 py-3 text-left font-normal transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:px-6"
                onClick={onOpen}
              >
                <span
                  data-slot="turn-diff-file-path"
                  className="min-w-0 flex-1 truncate text-sm text-foreground/80 sm:text-base"
                >
                  {displayPath}
                </span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  <span className="text-emerald-500 dark:text-emerald-400">+{file.added}</span>
                  <span className="text-red-500 dark:text-red-400">-{file.removed}</span>
                </span>
              </Button>
            </span>
          </HoverCardTrigger>
          <HoverCardContent
            align="start"
            className="w-[48rem] max-w-[calc(100vw-2rem)] max-h-[min(32rem,70vh)] overflow-y-auto p-0"
            side="top"
            sideOffset={8}
          >
            <DiffViewer patch={file.diff} size="sm" variant="muted" />
          </HoverCardContent>
        </HoverCard>
      </TableCell>
    </TableRow>
  )
}

function GeneratedImageEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const item = unit.item ?? {}
  const images = imageEntriesFromItem(item)
  const pending = images.length === 0 || images.every((image) => !image.src)

  return (
    <RenderUnitCard unit={unit} slot="generated-image-entry-unit">
      <div className="flex items-start gap-2">
        <ImageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {pending ? '正在生成图片' : `已生成 ${images.length} 张图片`}
          </p>
          <ImageGallery images={images.length > 0 ? images : [{ alt: '图片生成中' }]} />
        </div>
      </div>
    </RenderUnitCard>
  )
}

function GeneratedImageFileUnit({
  part,
  unit
}: {
  part: AnyRecord
  unit: Extract<AssistantRenderUnit, { type: 'unknown' }>
}): React.JSX.Element {
  const metadata = recordValue(recordValue(part.providerMetadata)?.[CODEX_PROVIDER_ID])
  const image = {
    src: imageSourceFromPart(part),
    alt: stringValue(metadata?.revisedPrompt) ?? stringValue(part.name) ?? '生成图片',
    savedPath: stringValue(metadata?.savedPath)
  }

  return (
    <RenderUnitCard unit={unit} slot="generated-image-file-unit">
      <div className="flex items-start gap-2">
        <ImageIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">已生成图片</p>
          <ImageGallery images={[image]} />
        </div>
      </div>
    </RenderUnitCard>
  )
}

function EndResourceCardsUnit({
  unit,
  workspaceCwd,
  canOpenLocalPaths
}: {
  unit: EntryUnit
  workspaceCwd?: string
  canOpenLocalPaths: boolean
}): React.JSX.Element | null {
  const resources = useMemo(
    () => arrayValue(unit.item?.resources ?? unit.item?.items).map(resourceCardData),
    [unit.item]
  )
  const localPathCheck = useExistingLocalResourcePaths(resources)
  const displayableResources = resources.filter(
    (resource) =>
      !resource.openPath ||
      localPathCheck.status !== 'resolved' ||
      localPathCheck.existingPaths.has(localResourceLookupKey(resource.openPath, resource.cwd))
  )
  const localPathCheckPending = localPathCheck.status === 'pending'
  const localPathCheckFailed = localPathCheck.status === 'failed'

  if (displayableResources.length === 0) return null

  return (
    <div
      data-slot="end-resource-cards-unit"
      className="mt-6 space-y-3"
      {...renderUnitAttributes(unit)}
    >
      {localPathCheckPending ? (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          正在确认本地资源是否可用…
        </p>
      ) : null}
      {localPathCheckFailed ? (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          暂时无法确认本地资源，仍可尝试打开。
        </p>
      ) : null}
      {displayableResources.map((resource, index) => (
        <ResourceCard
          key={`${resource.type}:${resource.openPath ?? resource.openUrl ?? resource.label}:${index}`}
          resource={resource}
          actionsDisabled={localPathCheckPending && Boolean(resource.openPath)}
          workspaceCwd={workspaceCwd}
          canOpenLocalPaths={canOpenLocalPaths}
        />
      ))}
    </div>
  )
}

function useExistingLocalResourcePaths(
  resources: readonly ResourceCardData[]
): LocalResourcePathCheck {
  const candidates = useMemo(() => {
    const candidatesByKey = new Map<string, { path: string; cwd?: string }>()
    for (const resource of resources) {
      if (!resource.openPath) continue
      const candidate = {
        path: resource.openPath,
        ...(resource.cwd ? { cwd: resource.cwd } : {})
      }
      candidatesByKey.set(localResourceLookupKey(candidate.path, candidate.cwd), candidate)
    }
    return [...candidatesByKey.values()]
  }, [resources])
  const requestKey = useMemo(
    () =>
      candidates
        .map((candidate) => localResourceLookupKey(candidate.path, candidate.cwd))
        .sort()
        .join('\n'),
    [candidates]
  )
  const [result, setResult] = useState<LocalResourcePathCheckResult>()

  useEffect(() => {
    let cancelled = false
    if (candidates.length === 0) return

    const checkLocalResources = async (): Promise<void> => {
      await Promise.resolve()
      try {
        const listExistingLocalPaths = window.desktopApp.codex.listExistingLocalPaths
        if (typeof listExistingLocalPaths !== 'function') {
          throw new Error('Local path availability is unavailable')
        }
        const checks = await Promise.allSettled(
          chunkValues(candidates, MAX_LOCAL_PATH_CHECK_BATCH_SIZE).map((paths) =>
            listExistingLocalPaths({ paths })
          )
        )
        if (cancelled) return

        const existingPaths = checks.flatMap((check) =>
          check.status === 'fulfilled' ? check.value.existingPaths : []
        )
        setResult({
          requestKey,
          status: checks.some((check) => check.status === 'rejected') ? 'failed' : 'resolved',
          existingPaths: new Set(
            existingPaths.map((path) => localResourceLookupKey(path.path, path.cwd))
          )
        })
      } catch {
        if (!cancelled) {
          setResult({ requestKey, status: 'failed', existingPaths: EMPTY_LOCAL_RESOURCE_PATHS })
        }
      }
    }

    void checkLocalResources()

    return () => {
      cancelled = true
    }
  }, [candidates, requestKey])

  if (candidates.length === 0) {
    return { status: 'resolved', existingPaths: EMPTY_LOCAL_RESOURCE_PATHS }
  }
  if (result?.requestKey === requestKey) return result
  return { status: 'pending', existingPaths: EMPTY_LOCAL_RESOURCE_PATHS }
}

function localResourceLookupKey(path: string, cwd: string | undefined): string {
  return `${cwd ?? ''}\u0000${path}`
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function ReviewCommentsEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const comments = arrayValue(unit.item?.comments)
    .map(recordValue)
    .filter(isDefined)
    .map(normalizeStructuredReviewComment)
    .filter(isDefined)

  return <ReviewCommentsCard comments={comments} slot="review-comments-entry-unit" unit={unit} />
}

export function ReviewCommentsDetails({ unit }: { unit: ReviewCommentsUnit }): React.JSX.Element {
  return (
    <ReviewCommentsCard
      comments={unit.comments}
      slot="review-comments-unit"
      unit={unit}
      workspaceCwd={unit.workspaceCwd}
      canOpenLocalPaths={unit.canOpenLocalPaths}
    />
  )
}

function AutomaticApprovalReviewEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const item = unit.item ?? {}
  const outcome =
    stringValue(item.outcome) ?? stringValue(item.result) ?? stringValue(item.decision)
  const status = stringValue(item.status)
  const label = automaticApprovalLabel(outcome ?? status)
  const denied = outcome === 'denied' || outcome === 'rejected'
  const Icon = denied ? ShieldXIcon : ShieldCheckIcon

  return (
    <RenderUnitCard unit={unit} slot="automatic-approval-review-entry-unit">
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0',
            denied ? 'text-destructive' : 'text-muted-foreground'
          )}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          {stringValue(item.rationale) ? (
            <p className="mt-1 text-xs text-muted-foreground">{stringValue(item.rationale)}</p>
          ) : null}
        </div>
      </div>
    </RenderUnitCard>
  )
}

function ErrorEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const item = unit.item ?? {}
  const message =
    stringValue(item.message) ?? stringValue(item.error) ?? stringValue(item.reason) ?? '发生错误'

  return (
    <RenderUnitCard
      unit={unit}
      slot="error-entry-unit"
      className="border-destructive/25 bg-destructive/5"
    >
      <div className="flex items-start gap-2 text-destructive">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {unit.itemType === 'streamError' ? '流式响应错误' : '系统错误'}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-xs">{message}</p>
        </div>
      </div>
    </RenderUnitCard>
  )
}

function CompactEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  const item = unit.item ?? {}
  const content = compactEntryContent(unit.itemType, item)
  const Icon = content.icon
  const title = unit.active && unit.summary?.label ? unit.summary.label : content.title

  return (
    <RenderUnitCard unit={unit} slot="compact-entry-unit">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          {content.detail ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {content.detail}
            </p>
          ) : null}
        </div>
      </div>
    </RenderUnitCard>
  )
}

function ContextCompactionEntryUnit({ unit }: { unit: EntryUnit }): React.JSX.Element {
  return (
    <div
      data-slot="context-compaction-entry-unit"
      className="my-2 flex w-full items-center gap-2 py-1.5 text-sm text-muted-foreground"
      {...renderUnitAttributes(unit)}
    >
      <CombineIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="leading-none font-normal">上下文已自动压缩</span>
    </div>
  )
}

function RenderUnitCard({
  unit,
  slot,
  className,
  children
}: {
  unit: AssistantRenderUnit
  slot: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      data-slot={slot}
      className={cn(
        'my-1 min-w-0 rounded-md border border-border/50 bg-muted/20 px-3 py-2',
        className
      )}
      {...renderUnitAttributes(unit)}
    >
      {children}
    </div>
  )
}

function ImageGallery({ images }: { images: readonly ImageEntry[] }): React.JSX.Element {
  const [preview, setPreview] = useState<ImageEntry | undefined>()
  const visible = images.slice(0, 4)
  const overflow = images.length - visible.length

  return (
    <div data-slot="generated-image-gallery" className="mt-2 space-y-2">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2">
        {visible.map((image, index) => (
          <Button
            aria-label={image.src ? `预览 ${image.alt ?? '生成图片'}` : (image.alt ?? '图片生成中')}
            key={`${image.src ?? image.alt ?? 'pending'}:${index}`}
            className="group relative aspect-square h-auto min-w-0 w-full justify-start overflow-hidden rounded-md border bg-muted/35 p-0 text-left hover:bg-muted/35"
            variant="ghost"
            type="button"
            onClick={() => image.src && setPreview(image)}
            disabled={!image.src}
          >
            {image.src ? (
              <img
                alt={image.alt ?? '生成图片'}
                className="size-full object-cover"
                src={image.src}
              />
            ) : (
              <div className="flex size-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                {image.alt ?? '等待图片'}
              </div>
            )}
            {index === visible.length - 1 && overflow > 0 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-background/75 text-sm font-medium">
                +{overflow}
              </span>
            ) : null}
          </Button>
        ))}
      </div>
      {images.some((image) => image.alt || image.savedPath) ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          {images.slice(0, 2).map((image, index) => (
            <p key={`${image.alt ?? image.savedPath ?? index}`} className="truncate">
              {image.alt ?? image.savedPath}
            </p>
          ))}
        </div>
      ) : null}
      {preview ? (
        <div
          data-slot="generated-image-preview"
          className="rounded-md border bg-background p-2 shadow-sm"
        >
          <img
            alt={preview.alt ?? '生成图片预览'}
            className="max-h-96 w-full rounded object-contain"
            src={preview.src}
          />
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onClick={() => setPreview(undefined)}
          >
            关闭预览
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ResourceCard({
  resource,
  actionsDisabled = false,
  workspaceCwd,
  canOpenLocalPaths
}: {
  resource: ResourceCardData
  actionsDisabled?: boolean
  workspaceCwd?: string
  canOpenLocalPaths: boolean
}): React.JSX.Element {
  const Icon = resource.icon
  const workspace = useOptionalRightWorkspace()
  const descriptor = resourceReferenceDescriptor(resource)
  const action =
    descriptor &&
    resolveInlineReferenceAction(descriptor, {
      canOpenLocalPaths,
      canOpenWorkspace: Boolean(workspace),
      workspaceCwd: workspaceCwd ?? resource.cwd
    })
  const canOpenInApp = isWorkspaceAction(action)

  const executeAction = (nextAction: InlineReferenceAction): void => {
    switch (nextAction.type) {
      case 'workspace-file':
        if (!workspace) return
        if (isPptxArtifactPath(nextAction.relativePath)) {
          workspace.openArtifact(
            {
              artifactType: 'slides',
              importKind: 'pptx',
              source: { kind: 'workspace-file', relativePath: nextAction.relativePath },
              title: resource.label,
              openSource: 'generated-resource'
            },
            { mode: nextAction.mode }
          )
          return
        }
        workspace.openFile(nextAction.relativePath, resource.label, {
          location: {
            ...(nextAction.line ? { line: nextAction.line } : {}),
            ...(nextAction.column ? { column: nextAction.column } : {}),
            ...(nextAction.endLine ? { endLine: nextAction.endLine } : {})
          },
          mode: nextAction.mode
        })
        return
      case 'workspace-folder':
        if (!workspace) return
        workspace.openFile('', 'Files', { mode: 'pinned', revealPath: nextAction.relativePath })
        return
      case 'workspace-browser':
        if (!workspace) return
        workspace.openBrowser(nextAction.url, resource.label)
        return
      case 'system-file':
        void window.desktopApp.codex
          .openLocalPath({
            path: nextAction.path,
            ...(nextAction.cwd ? { cwd: nextAction.cwd } : {}),
            ...(nextAction.line ? { line: nextAction.line } : {})
          })
          .catch(() => undefined)
        return
      case 'external-browser':
        void window.desktopApp.codex.openExternalHttpUrl(nextAction.url).catch(() => undefined)
        return
      case 'conversation':
      case 'display-only':
        return
    }
  }

  const openInApp = (): void => {
    if (!action || !isWorkspaceAction(action)) return
    executeAction(action)
  }
  const openWithSystem = (): void => {
    if (resource.openPath) {
      void window.desktopApp.codex
        .openLocalPath({
          path: resource.openPath,
          line: resource.line,
          ...(resource.cwd ? { cwd: resource.cwd } : {})
        })
        .catch(() => undefined)
      return
    }
    if (resource.openUrl) {
      void window.desktopApp.codex.openExternalHttpUrl(resource.openUrl).catch(() => undefined)
    }
  }
  const handleOpen = (): void => {
    if (!action || actionsDisabled) return
    executeAction(action)
  }
  const revealInFileManager = (): void => {
    if (!resource.openPath) return
    void window.desktopApp.codex
      .revealLocalPath({
        path: resource.openPath,
        ...(resource.cwd ? { cwd: resource.cwd } : {})
      })
      .catch(() => undefined)
  }
  const canOpen = !actionsDisabled && action !== undefined && action.type !== 'display-only'
  const canCopyLink = Boolean(resource.openUrl && navigator.clipboard?.writeText)

  return (
    <CardHeader
      data-slot="end-resource-card-unit"
      data-resource-type={resource.type}
      className="!grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-2xl border bg-card px-3 py-3 text-card-foreground shadow-none sm:px-4"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-background">
        {resource.type === 'file' ? (
          <ResourceFileIcon
            aria-hidden
            className="size-6"
            mimeType={resource.mimeType}
            path={resource.filePath}
          />
        ) : (
          <Icon aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.8} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <CardTitle className="truncate text-base tracking-tight sm:text-lg">
          {resource.label}
        </CardTitle>
        <CardDescription className="mt-0.5 truncate text-sm">{resource.kind}</CardDescription>
      </div>
      <CardAction className="!col-start-3 !row-span-1 !row-start-1 flex shrink-0 items-center gap-1 self-center justify-self-end">
        <Button
          aria-label={canOpen ? `打开 ${resource.label}` : `${resource.label} 无法打开`}
          className="h-auto gap-1.5 px-0 py-1.5 text-sm font-semibold hover:bg-transparent"
          disabled={!canOpen}
          size="sm"
          type="button"
          variant="ghost"
          onClick={handleOpen}
        >
          打开
          <ExternalLinkIcon className="size-4" strokeWidth={1.8} />
        </Button>
        {canOpen ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                aria-label={`${resource.label} 的更多操作`}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canOpenInApp ? (
                <DropdownMenuItem onSelect={() => openInApp()}>
                  <PanelRightOpenIcon />
                  在应用内打开
                </DropdownMenuItem>
              ) : null}
              {resource.openUrl || resource.openPath ? (
                <DropdownMenuItem onSelect={openWithSystem}>
                  <ExternalLinkIcon />
                  {resource.openPath ? '在默认应用中打开' : '在默认浏览器中打开'}
                </DropdownMenuItem>
              ) : null}
              {resource.openPath ? (
                <DropdownMenuItem onSelect={revealInFileManager}>
                  <FolderOpenIcon />
                  在文件夹中显示
                </DropdownMenuItem>
              ) : null}
              {canCopyLink ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      void navigator.clipboard
                        .writeText(resource.openUrl ?? '')
                        .catch(() => undefined)
                    }
                  >
                    <CopyIcon />
                    复制链接
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </CardAction>
    </CardHeader>
  )
}

function resourceReferenceDescriptor(
  resource: ResourceCardData
): InlineReferenceDescriptor | undefined {
  if (resource.openPath) {
    return {
      href: resource.openPath,
      kind: 'local-file',
      label: resource.label,
      path: resource.openPath,
      tooltip: resource.openPath,
      ...(resource.line ? { line: resource.line } : {})
    }
  }
  if (!resource.openUrl) return undefined
  return {
    href: resource.openUrl,
    kind: 'external-url',
    label: resource.label,
    tooltip: resource.openUrl
  }
}

function isWorkspaceAction(
  action: InlineReferenceAction | undefined
): action is Extract<InlineReferenceAction, { type: `workspace-${string}` }> {
  return (
    action?.type === 'workspace-file' ||
    action?.type === 'workspace-folder' ||
    action?.type === 'workspace-browser'
  )
}

function ReviewCommentsCard({
  comments,
  unit,
  slot,
  workspaceCwd,
  canOpenLocalPaths = true
}: {
  comments: readonly CodeComment[]
  unit: AssistantRenderUnit
  slot: string
  workspaceCwd?: string
  canOpenLocalPaths?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const sortedComments = comments
    .map((comment, index) => ({ comment, index }))
    .sort(
      (left, right) =>
        reviewCommentPriorityRank(left.comment) - reviewCommentPriorityRank(right.comment) ||
        left.index - right.index
    )
    .map(({ comment }) => comment)
  const visibleComments = expanded ? sortedComments : sortedComments.slice(0, MAX_VISIBLE_ROWS)
  const hiddenCount = sortedComments.length - visibleComments.length

  return (
    <Card
      data-slot={slot}
      className="my-3 gap-0 rounded-lg border-border/70 bg-muted/70 py-0 shadow-none"
      {...renderUnitAttributes(unit)}
    >
      <CardHeader className="flex min-h-14 flex-row items-center gap-2.5 px-5 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/70 text-muted-foreground">
          <MessageSquareMoreIcon aria-hidden className="size-4" />
        </span>
        <CardTitle className="text-base font-normal">{sortedComments.length} comments</CardTitle>
      </CardHeader>
      <CardContent className="border-t px-0 py-1">
        {visibleComments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">评论详情暂不可用</p>
        ) : (
          <div>
            {visibleComments.map((comment, index) => (
              <ReviewCommentRow
                key={`${comment.file}:${comment.startLine}:${comment.title}:${index}`}
                comment={comment}
                workspaceCwd={workspaceCwd}
                canOpenLocalPaths={canOpenLocalPaths}
              />
            ))}
          </div>
        )}
      </CardContent>
      {expanded || hiddenCount > 0 ? (
        <CardFooter className="border-0 bg-transparent p-0">
          <Button
            aria-expanded={expanded}
            className="h-auto w-full justify-start gap-2 rounded-none px-6 py-2 text-left text-sm font-normal hover:bg-muted/50 has-[>svg]:px-6"
            variant="ghost"
            type="button"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '收起评论' : `再显示 ${hiddenCount} 条评论`}
            <ChevronDownIcon
              aria-hidden
              className={cn('size-4 transition-transform', expanded && 'rotate-180')}
            />
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}

function ReviewCommentRow({
  comment,
  workspaceCwd,
  canOpenLocalPaths
}: {
  comment: CodeComment
  workspaceCwd?: string
  canOpenLocalPaths: boolean
}): React.JSX.Element {
  const absolutePath = localFilePath(comment.file)
  const relativePath = safeRelativeLocalPath(comment.file)
  const openPath = absolutePath ?? (workspaceCwd && relativePath ? comment.file : undefined)
  const canOpen = canOpenLocalPaths && Boolean(openPath)
  const location = reviewCommentLocation(comment)
  const displayTitle = comment.title.replace(/^\[P[0-3]\]\s*/i, '') || '审查建议'
  const handleOpen = (): void => {
    if (!canOpen || !openPath) return
    void window.desktopApp.codex
      .openLocalPath({
        path: openPath,
        line: comment.startLine,
        ...(absolutePath ? {} : { cwd: workspaceCwd })
      })
      .catch(() => undefined)
  }

  return (
    <HoverCard openDelay={600} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button
          aria-disabled={!canOpen}
          aria-label={canOpen ? `打开 ${location}` : `${location} 无法作为本地文件打开`}
          className={cn(
            'flex h-auto w-full min-w-0 items-center justify-start gap-3 rounded-none px-6 py-1.5 text-left hover:bg-muted/40',
            !canOpen && 'cursor-default'
          )}
          variant="ghost"
          type="button"
          onClick={handleOpen}
        >
          <span className="inline-flex w-fit min-w-7 shrink-0 justify-center rounded-md border border-border/70 bg-muted/20 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
            {comment.priority ?? '—'}
          </span>
          <span className="max-w-[45%] min-w-0 shrink-0 truncate text-sm font-medium text-foreground">
            {displayTitle}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-left text-sm font-normal text-muted-foreground [direction:rtl]"
            title={location}
          >
            <span className="[direction:ltr]">{location}</span>
          </span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-96 max-w-[calc(100vw-2rem)] space-y-3">
        <p className="break-all text-xs text-muted-foreground">{location}</p>
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">{displayTitle}</p>
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{comment.body}</p>
        </div>
        {canOpen ? (
          <Button
            className="gap-2"
            size="sm"
            type="button"
            variant="secondary"
            onClick={handleOpen}
          >
            <FileIcon className="size-3.5" />
            打开文件
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            {canOpenLocalPaths ? '该路径无法作为本地文件打开' : '远程项目文件暂不支持本地打开'}
          </p>
        )}
      </HoverCardContent>
    </HoverCard>
  )
}

function reviewCommentLocation(comment: CodeComment): string {
  const range =
    comment.endLine > comment.startLine
      ? `${comment.startLine}-${comment.endLine}`
      : String(comment.startLine)
  return `${comment.file}:${range}`
}

function reviewCommentPriorityRank(comment: CodeComment): number {
  return comment.priority ? Number(comment.priority.slice(1)) : 9
}

function normalizeStructuredReviewComment(comment: AnyRecord): CodeComment | undefined {
  const file = stringValue(comment.file) ?? stringValue(comment.path)
  if (!file) return undefined

  const rawTitle = stringValue(comment.title) ?? '审查建议'
  const titlePriority = rawTitle.match(/^\[(P[0-3])\]/i)?.[1]?.toUpperCase()
  const rawPriority = stringValue(comment.priority) ?? stringValue(comment.severity)
  const normalizedPriority = rawPriority?.toUpperCase()
  const priority =
    titlePriority ?? (/^P[0-3]$/.test(normalizedPriority ?? '') ? normalizedPriority : undefined)
  const startLine = Math.max(
    1,
    Math.trunc(
      numberValue(comment.startLine) ?? numberValue(comment.start) ?? numberValue(comment.line) ?? 1
    )
  )
  const endLine = Math.max(
    startLine,
    Math.trunc(numberValue(comment.endLine) ?? numberValue(comment.end) ?? startLine)
  )
  const title = priority && !/^\[P[0-3]\]/i.test(rawTitle) ? `[${priority}] ${rawTitle}` : rawTitle

  return {
    title,
    body: stringValue(comment.body) ?? stringValue(comment.preview) ?? '',
    file,
    startLine,
    endLine,
    ...(priority ? { priority: priority as CodeComment['priority'] } : {})
  }
}

function TurnDiffShowMoreButton({
  expanded,
  hiddenCount,
  onClick
}: {
  expanded: boolean
  hiddenCount: number
  onClick: () => void
}): React.JSX.Element | null {
  if (expanded || hiddenCount > 0) {
    return (
      <Button
        aria-expanded={expanded}
        className="h-auto w-full justify-start gap-2 rounded-none px-4 py-3 text-left text-sm font-normal transition-colors hover:bg-muted/50 sm:px-6"
        variant="ghost"
        type="button"
        onClick={onClick}
      >
        {expanded ? '收起文件' : `再显示 ${hiddenCount} 个文件`}
        <ChevronDownIcon
          aria-hidden
          className={cn('size-4 transition-transform', expanded && 'rotate-180')}
          strokeWidth={2}
        />
      </Button>
    )
  }
  return null
}

function RawOutputToggle({ value }: { value: unknown }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2">
      <Button size="sm" variant="ghost" type="button" onClick={() => setOpen((value) => !value)}>
        {open ? '隐藏原始输出' : '查看原始输出'}
      </Button>
      {open ? <JsonPreview value={value} className="mt-2 max-h-64" /> : null}
    </div>
  )
}

function JsonPreview({
  value,
  className
}: {
  value: unknown
  className?: string
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap break-words text-foreground/90',
        className
      )}
    >
      {safeJson(value)}
    </pre>
  )
}

function JsonFallback({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 px-2.5 py-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <JsonPreview value={value} className="mt-1" />
    </div>
  )
}

type ImageEntry = {
  src?: string
  alt?: string
  savedPath?: string
}

type ResourceCardData = {
  type: string
  kind: string
  label: string
  openUrl?: string
  openPath?: string
  line?: number
  cwd?: string
  icon: LucideIcon
  filePath?: string
  mimeType?: string
}

type LocalResourcePathCheckStatus = 'pending' | 'resolved' | 'failed'

type LocalResourcePathCheck = {
  status: LocalResourcePathCheckStatus
  existingPaths: ReadonlySet<string>
}

type LocalResourcePathCheckResult = LocalResourcePathCheck & {
  requestKey: string
}

const EMPTY_LOCAL_RESOURCE_PATHS: ReadonlySet<string> = new Set()

function isDiffTruncated(item: AnyRecord): boolean {
  return item.truncated === true || (numberValue(item.originalLength) ?? 0) > LARGE_DIFF_TEXT_LENGTH
}

function turnDiffCwd(item: AnyRecord): string | undefined {
  const metadata = recordValue(item.metadata)
  const context = recordValue(item.context)
  const thread = recordValue(item.thread)
  return localFilePath(
    stringValue(item.cwd) ??
      stringValue(item.threadCwd) ??
      stringValue(item.workspaceRoot) ??
      stringValue(metadata?.cwd) ??
      stringValue(context?.cwd) ??
      stringValue(thread?.cwd)
  )
}

/**
 * Provider turn-diff entries use `turn-diff:<turnId>` as their render-unit id.
 * The local Git bridge deliberately stores patches by the app-server turn id, so
 * normalize the display id before requesting an undo or reapply.
 */
function completedTurnId(item: AnyRecord, fallback: string): string {
  const explicitTurnId = stringValue(item.turnId)
  if (explicitTurnId) return explicitTurnId

  const itemId = stringValue(item.id)
  return itemId?.startsWith('turn-diff:') ? itemId.slice('turn-diff:'.length) : (itemId ?? fallback)
}

function displayTurnDiffFilePath(path: string, cwd: string | undefined): string {
  const normalizedPath = path.replace(/\\/g, '/').replace(/^[ab]\//, '')
  const normalizedCwd = cwd?.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedCwd) return normalizedPath

  const caseInsensitive = /^[A-Za-z]:\//.test(normalizedPath) || /^[A-Za-z]:\//.test(normalizedCwd)
  const pathForComparison = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
  const cwdForComparison = caseInsensitive ? normalizedCwd.toLowerCase() : normalizedCwd
  if (pathForComparison === cwdForComparison) return '.'

  const projectPrefix = `${cwdForComparison}/`
  if (pathForComparison.startsWith(projectPrefix)) {
    return normalizedPath.slice(normalizedCwd.length + 1)
  }

  return normalizedPath
}

function safeRelativeLocalPath(path: string): string | undefined {
  if (!path || path.includes('\0') || hasUrlScheme(path)) return undefined
  const withoutDiffPrefix = path.replace(/\\/g, '/').replace(/^[ab]\//, '')
  const segments = withoutDiffPrefix.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

function imageEntriesFromItem(item: AnyRecord): ImageEntry[] {
  const explicitImages = arrayValue(item.images)
  if (explicitImages.length > 0) {
    return explicitImages.map((image) => {
      const record = recordValue(image)
      return {
        src: imageSrcFromRecord(record),
        alt:
          stringValue(record?.alt) ?? stringValue(record?.altText) ?? stringValue(record?.prompt),
        savedPath: stringValue(record?.savedPath)
      }
    })
  }

  return [
    {
      src: imageSrcFromRecord(item),
      alt:
        stringValue(item.alt) ??
        stringValue(item.altText) ??
        stringValue(item.revisedPrompt) ??
        stringValue(item.prompt),
      savedPath: stringValue(item.savedPath)
    }
  ]
}

function imageSourceFromPart(part: AnyRecord): string | undefined {
  const url = stringValue(part.url)
  if (url) return safeRenderableImageSrc(url)
  const data = stringValue(part.data)
  const mediaType = stringValue(part.mediaType) ?? 'image/png'
  if (!data) return undefined
  return data.startsWith('data:') ? data : `data:${mediaType};base64,${data}`
}

function imageSrcFromRecord(record: AnyRecord | undefined): string | undefined {
  if (!record) return undefined
  const src =
    stringValue(record.previewSrc) ??
    stringValue(record.src) ??
    stringValue(record.url) ??
    stringValue(record.imageUrl) ??
    stringValue(record.result)
  if (!src) return undefined
  const safeSrc = safeRenderableImageSrc(src)
  if (safeSrc) return safeSrc
  if (hasUrlScheme(src)) return undefined
  return `data:image/png;base64,${src}`
}

function resourceCardData(value: unknown): ResourceCardData {
  const record = recordValue(value)
  const type = stringValue(record?.type) ?? stringValue(record?.kind) ?? 'unknown'
  const url = stringValue(record?.url)
  const rawPath = stringValue(record?.path) ?? stringValue(record?.file)
  const mimeType =
    stringValue(record?.mimeType) ??
    stringValue(record?.mediaType) ??
    stringValue(record?.contentType)
  const cwd = localFilePath(stringValue(record?.cwd))
  const path = resourceOpenPath(rawPath, cwd)
  const label =
    stringValue(record?.title) ??
    stringValue(record?.name) ??
    stringValue(record?.path) ??
    url ??
    '未命名资源'
  const openUrl = externalHttpUrl(url)

  if (type === 'google-drive') {
    return {
      type,
      kind: googleDriveKind(openUrl),
      label,
      icon: LinkIcon,
      openUrl
    }
  }
  if (type === 'appgen-app') {
    return { type, kind: 'Site', label, icon: WrenchIcon, openUrl }
  }
  if (type === 'website') {
    return {
      type,
      kind: 'Website',
      label,
      icon: LinkIcon,
      openUrl,
      openPath: path,
      line: positiveInteger(record?.line),
      cwd
    }
  }
  if (type === 'file') {
    return {
      type,
      kind: fileResourceKind(rawPath),
      label,
      icon: FileIcon,
      filePath: rawPath,
      mimeType,
      openPath: path,
      line: positiveInteger(record?.line),
      cwd
    }
  }
  return { type, kind: '未知', label, icon: FileIcon }
}

function resourceOpenPath(path: string | undefined, cwd: string | undefined): string | undefined {
  const absolutePath = localFilePath(path)
  if (absolutePath) return absolutePath
  return cwd && safeRelativeLocalPath(path ?? '') ? path : undefined
}

function googleDriveKind(url: string | undefined): string {
  if (!url) return 'Google Drive'
  try {
    const path = new URL(url).pathname
    if (path.startsWith('/document/')) return 'Google Docs'
    if (path.startsWith('/spreadsheets/')) return 'Google Sheets'
    if (path.startsWith('/presentation/')) return 'Google Slides'
  } catch {
    // Keep the generic label for malformed legacy items.
  }
  return 'Google Drive'
}

function fileResourceKind(path: string | undefined): string {
  const name = path?.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const extension = name.includes('.') ? name.split('.').at(-1)?.toUpperCase() : undefined
  return extension && extension.length <= 8 ? extension : 'File'
}

function compactEntryContent(
  itemType: string | undefined,
  item: AnyRecord
): { title: string; detail?: string; icon: LucideIcon } {
  switch (itemType) {
    case 'permissionRequest':
      return {
        title: '权限请求',
        detail:
          stringValue(item.reason) ??
          stringValue(item.message) ??
          permissionSummary(item.permissions),
        icon: ShieldCheckIcon
      }
    case 'mcpServerElicitation':
      return {
        title: stringValue(item.title) ?? 'MCP 需要输入',
        detail: stringValue(item.message) ?? stringValue(item.prompt),
        icon: WrenchIcon
      }
    case 'userInputResponse':
      return {
        title: '已提交输入',
        detail: stringValue(item.summary) ?? stringValue(item.response) ?? stringValue(item.text),
        icon: CheckCircle2Icon
      }
    case 'worktreeInit':
      return {
        title: '工作区已准备',
        detail: stringValue(item.path) ?? stringValue(item.cwd) ?? stringValue(item.branch),
        icon: FileIcon
      }
    case 'automationUpdate':
      return {
        title: stringValue(item.title) ?? '自动化已更新',
        detail: stringValue(item.summary) ?? stringValue(item.name) ?? stringValue(item.action),
        icon: ClockIcon
      }
    case 'modelChanged':
      return {
        title: '模型已切换',
        detail: [stringValue(item.from), stringValue(item.to)].filter(Boolean).join(' → '),
        icon: WrenchIcon
      }
    case 'modelRerouted':
      return {
        title: '模型已重新路由',
        detail: stringValue(item.reason) ?? stringValue(item.to),
        icon: WrenchIcon
      }
    case 'sleep':
      return {
        title: '等待完成',
        detail: durationLabel(numberValue(item.durationMs)),
        icon: ClockIcon
      }
    case 'loadedTool':
      return {
        title: '已加载工具定义',
        detail: stringValue(item.name) ?? stringValue(item.toolName) ?? stringValue(item.title),
        icon: WrenchIcon
      }
    default:
      return {
        title: stringValue(item.title) ?? stringValue(item.name) ?? '状态更新',
        detail: stringValue(item.summary) ?? stringValue(item.message) ?? stringValue(item.text),
        icon: ClockIcon
      }
  }
}

function automaticApprovalLabel(value: string | undefined): string {
  if (value === 'approved' || value === 'allowed') return '自动审批已通过'
  if (value === 'denied' || value === 'rejected') return '自动审批已拒绝'
  if (value === 'timedOut' || value === 'timed-out' || value === 'timeout') return '自动审批已超时'
  if (value === 'aborted') return '自动审批已中止'
  return '自动审批审核中'
}

function permissionSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return safeJson(value)
}

function durationLabel(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value < 1000) return `${value}ms`
  return `${(value / 1000).toFixed(1)}s`
}

function mcpStatusLabel(part: AnyRecord, item: AnyRecord | undefined): string {
  if (isToolPartActive(part) || isActiveStatus(item?.status)) return '正在调用'
  if (item?.error) return '调用失败'
  if (stringValue(item?.status) === 'failed') return '调用失败'
  return '调用完成'
}

function mcpItemSourceLabel(item: AnyRecord | undefined, part: AnyRecord): string | undefined {
  const appContext = recordValue(item?.appContext)
  return (
    stringValue(appContext?.displayName) ??
    stringValue(appContext?.appName) ??
    stringValue(appContext?.name) ??
    stringValue(item?.server) ??
    mcpServerFromToolName(stringValue(part.toolName))
  )
}

function mcpServerFromToolName(toolName: string | undefined): string | undefined {
  if (!toolName?.startsWith('mcp:')) return undefined
  const body = toolName.slice('mcp:'.length)
  return body.split('/')[0] || undefined
}

function mcpToolFromToolName(toolName: string | undefined): string | undefined {
  if (!toolName?.startsWith('mcp:')) return undefined
  const slashIndex = toolName.indexOf('/')
  return slashIndex >= 0 ? toolName.slice(slashIndex + 1) || undefined : undefined
}

function webSearchUrl(action: unknown): string | undefined {
  return stringValue(recordValue(action)?.url)
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

function mediaSrc(record: AnyRecord | undefined): string | undefined {
  if (!record) return undefined
  const url = stringValue(record.url) ?? stringValue(record.uri)
  if (url) return safeRenderableMediaSrc(url)
  const data = stringValue(record.data)
  if (!data) return undefined
  if (data.startsWith('data:')) return data
  return `data:${stringValue(record.mimeType) ?? stringValue(record.mediaType) ?? 'application/octet-stream'};base64,${data}`
}

function safeRenderableImageSrc(src: string | undefined): string | undefined {
  if (!src) return undefined
  return isSafeDomMediaSrc(src) ? src : undefined
}

function safeRenderableMediaSrc(src: string | undefined): string | undefined {
  if (!src) return undefined
  return isSafeDomMediaSrc(src) ? src : undefined
}

function isSafeDomMediaSrc(src: string): boolean {
  return src.startsWith('data:')
}

function hasUrlScheme(src: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(src)
}

function externalHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function localFilePath(path: string | undefined): string | undefined {
  if (!path || path.includes('\0')) return undefined
  if (path.startsWith('/')) return path
  if (/^[A-Za-z]:[\\/]/.test(path)) return path
  if (hasUrlScheme(path)) return undefined
  return undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = numberValue(value)
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  const record = recordValue(error)
  return (
    stringValue(record?.message) ??
    stringValue(record?.error) ??
    stringValue(record?.reason) ??
    safeJson(error)
  )
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function isActiveStatus(status: unknown): boolean {
  if (status === 'inProgress' || status === 'running') return true
  const record = recordValue(status)
  return (
    record?.type === 'inProgress' ||
    record?.type === 'running' ||
    record?.type === 'requires-action'
  )
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function recordValue(value: unknown): AnyRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as AnyRecord) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
