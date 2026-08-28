import { BotIcon, CircleAlertIcon } from 'lucide-react'

import type {
  AssistantRenderUnit,
  MultiAgentReceiverAgent,
  ToolItem
} from '@/lib/assistantRenderUnits'
import { cn } from '@/lib/utils'
import { renderUnitAttributes } from './renderUnitAttributes'

type SubagentActivityGroupUnit = Extract<AssistantRenderUnit, { type: 'subagent-activity-group' }>

export type OpenSubagentConversation = (conversationId: string) => void

const MAX_VISIBLE_AGENTS = 3

export function SubagentActivityGroup({
  unit,
  onOpenConversation
}: {
  unit: SubagentActivityGroupUnit
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element {
  const visibleAgents = unit.agents.slice(0, MAX_VISIBLE_AGENTS)
  const hiddenCount = Math.max(0, unit.agents.length - visibleAgents.length)

  return (
    <div
      data-slot="subagent-activity-group"
      data-status={unit.status}
      className="my-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
      {...renderUnitAttributes(unit)}
    >
      <span data-slot="subagent-activity-summary" className="shrink-0 text-xs font-medium">
        {activityStatusLabel(unit.status)}
      </span>
      {visibleAgents.map((agent) => {
        const threadId = agent.threadId
        const content = (
          <>
            <BotIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="max-w-44 truncate">{agent.displayName}</span>
            {agent.model ? (
              <span className="max-w-28 truncate text-[11px] text-muted-foreground/80">
                {agent.model}
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground/80">
              {activityStatusLabel(agent.displayStatus)}
            </span>
          </>
        )

        return threadId ? (
          <button
            key={agent.eventId}
            type="button"
            data-slot="subagent-activity-agent"
            data-agent-thread-id={threadId}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/35 px-2 py-1 text-xs text-foreground/90 transition-colors hover:border-border hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`打开 ${agent.displayName} 的会话`}
            onClick={() => onOpenConversation(threadId)}
          >
            {content}
          </button>
        ) : (
          <span
            key={agent.eventId}
            data-slot="subagent-activity-agent"
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/35 px-2 py-1 text-xs text-foreground/90"
          >
            {content}
          </span>
        )
      })}
      {hiddenCount > 0 ? (
        <span data-slot="subagent-activity-overflow" className="text-xs text-muted-foreground/80">
          另有 {hiddenCount} 个子 agent
        </span>
      ) : null}
    </div>
  )
}

export function MultiAgentToolItemDetails({
  item,
  onOpenConversation
}: {
  item: ToolItem
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element {
  const rawItem = item.rawItem
  const input = recordValue(item.input)
  const receiverAgents =
    item.receiverAgents && item.receiverAgents.length > 0
      ? item.receiverAgents
      : receiverAgentsFromRecords(rawItem, input)
  const prompt = stringValue(rawItem?.prompt) ?? stringValue(input?.prompt)
  const model = stringValue(rawItem?.model) ?? stringValue(input?.model)
  const reasoningEffort =
    stringValue(rawItem?.reasoningEffort) ?? stringValue(input?.reasoningEffort)
  const fallbackStatus = stringValue(rawItem?.status) ?? toolItemStatus(item.status)

  if (receiverAgents.length === 0) {
    return (
      <div
        data-slot="multi-agent-detail-row"
        className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
      >
        <p>{collabStatusLabel(fallbackStatus)}</p>
        {prompt ? <p className="mt-1 whitespace-pre-wrap text-foreground/80">{prompt}</p> : null}
      </div>
    )
  }

  return (
    <div data-slot="multi-agent-detail-list" className="space-y-2">
      {receiverAgents.map((agent) => {
        const row = (
          <>
            <div className="flex min-w-0 items-center gap-2">
              {isProblemAgentStatus(agent.status) ? (
                <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <BotIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {agent.displayName}
              </span>
              <span className={cn('shrink-0 text-xs', agentStatusClass(agent.status))}>
                {collabStatusLabel(agent.status ?? fallbackStatus)}
              </span>
            </div>
            {model || reasoningEffort ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {[model, reasoningEffort].filter(Boolean).join(' · ')}
              </p>
            ) : null}
            {prompt ? (
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-foreground/80">
                {prompt}
              </p>
            ) : null}
            {agent.message ? (
              <p className="mt-1 text-xs text-muted-foreground">{agent.message}</p>
            ) : null}
          </>
        )

        return agent.threadId ? (
          <button
            key={agent.threadId}
            type="button"
            data-slot="multi-agent-detail-row"
            data-agent-thread-id={agent.threadId}
            className="block w-full rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-left transition-colors hover:border-border hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`打开 ${agent.displayName} 的会话`}
            onClick={() => onOpenConversation(agent.threadId)}
          >
            {row}
          </button>
        ) : (
          <div
            key={agent.displayName}
            data-slot="multi-agent-detail-row"
            className="rounded-md border border-border/50 bg-muted/20 px-3 py-2"
          >
            {row}
          </div>
        )
      })}
    </div>
  )
}

function receiverAgentsFromRecords(
  item: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined
): MultiAgentReceiverAgent[] {
  const receiverThreads = arrayValue(item?.receiverThreads)
  const receiverThreadIds = stringArray(item?.receiverThreadIds ?? input?.receiverThreadIds)
  const agentsStates = recordValue(item?.agentsStates)

  if (receiverThreads.length > 0) {
    return receiverThreads.flatMap((thread): MultiAgentReceiverAgent[] => {
      const threadId = stringValue(thread.id) ?? stringValue(thread.threadId)
      if (!threadId) return []
      const state = recordValue(agentsStates?.[threadId])
      return [
        {
          threadId,
          displayName:
            stringValue(thread.agentNickname) ??
            stringValue(thread.agentRole) ??
            stringValue(thread.name) ??
            shortAgentName(threadId),
          status: stringValue(state?.status),
          message: stringValue(state?.message)
        }
      ]
    })
  }

  return receiverThreadIds.map((threadId) => {
    const state = recordValue(agentsStates?.[threadId])
    return {
      threadId,
      displayName: shortAgentName(threadId),
      status: stringValue(state?.status),
      message: stringValue(state?.message)
    }
  })
}

function activityStatusLabel(status: string): string {
  if (status === 'updated') return '已更新'
  if (status === 'finished') return '已完成'
  if (status === 'interrupted') return '已中断'
  return '正在工作'
}

function collabStatusLabel(status: string): string {
  switch (status) {
    case 'pendingInit':
      return '等待初始化'
    case 'running':
    case 'inProgress':
      return '正在运行'
    case 'completed':
    case 'complete':
      return '已完成'
    case 'interrupted':
      return '已中断'
    case 'errored':
    case 'failed':
    case 'error':
      return '失败'
    case 'shutdown':
      return '已关闭'
    case 'notFound':
      return '未找到'
    default:
      return '状态未知'
  }
}

function toolItemStatus(status: ToolItem['status']): string {
  if (status === 'running') return 'inProgress'
  if (status === 'error') return 'failed'
  return 'completed'
}

function shortAgentName(threadId: string): string {
  const compactId = threadId.length > 10 ? `${threadId.slice(0, 8)}…` : threadId
  return `子 agent ${compactId}`
}

function isProblemAgentStatus(status: string | undefined): boolean {
  return status === 'interrupted' || status === 'errored' || status === 'notFound'
}

function agentStatusClass(status: string | undefined): string {
  return isProblemAgentStatus(status) ? 'text-destructive' : 'text-muted-foreground'
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordValue).filter(isDefined) : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
