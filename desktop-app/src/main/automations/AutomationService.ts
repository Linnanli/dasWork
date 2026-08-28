import type {
  AutomationCreateRequest,
  AutomationRun,
  AutomationSchedule,
  AutomationStatusRequest,
  AutomationUpdateRequest,
  ScheduledAutomation
} from '../../shared/automationApi'
import type {
  CodexChatRequest,
  CodexChatStreamEnvelope,
  CodexChatStreamEvent
} from '../../shared/codexIpcApi'
import type { ProjectSelection, ThreadProjectAssignment } from '../../shared/projects/projectTypes'
import type { CodexPortLike, StartedConversationThread } from '../codexChatRuntimeService'
import type { ProjectStore } from '../projects/ProjectStore'
import { AutomationStore } from './AutomationStore'

const maxTimerDelayMs = 2_147_483_647
const retainedRuns = 20

type AutomationRuntime = {
  startChatStream(
    request: CodexChatRequest,
    port: CodexPortLike,
    callbacks?: {
      onThreadIdAvailable?: (
        threadId: string,
        thread?: StartedConversationThread
      ) => void | Promise<void>
      onTerminal?: (
        event: Extract<CodexChatStreamEvent, { type: 'finish' | 'aborted' | 'error' }>
      ) => void
    },
    streamId?: string,
    options?: { threadSource?: 'automation' }
  ): Promise<{ threadId?: string }>
}

type Timer = ReturnType<typeof setTimeout>

export type AutomationServiceDependencies = {
  store: AutomationStore
  projectStore: Pick<ProjectStore, 'getState'>
  runtime: AutomationRuntime
  onThreadStarted?: (input: {
    sourceConversationId: string
    thread: StartedConversationThread
  }) => void | Promise<void>
  now?: () => Date
  createId?: () => string
  setTimer?: (callback: () => void, delayMs: number) => Timer
  clearTimer?: (timer: Timer) => void
}

/**
 * A desktop-local scheduler. It intentionally does not claim to run while the
 * app is closed; schedules are recalculated from the next future occurrence at
 * startup rather than replaying work that was missed offline.
 */
export class AutomationService {
  private automations: ScheduledAutomation[] = []
  private timer: Timer | undefined
  private readonly runningAutomationIds = new Set<string>()
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer
  private readonly clearTimer: (timer: Timer) => void

  constructor(private readonly dependencies: AutomationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date())
    this.createId = dependencies.createId ?? (() => crypto.randomUUID())
    this.setTimer = dependencies.setTimer ?? setTimeout
    this.clearTimer = dependencies.clearTimer ?? clearTimeout
  }

  async load(): Promise<void> {
    const now = this.now()
    this.automations = (await this.dependencies.store.load()).map((automation) =>
      normalizeNextRun(automation, now)
    )
    await this.persist()
    this.scheduleNextRun()
  }

  list(): ScheduledAutomation[] {
    return cloneAutomations(this.automations)
  }

  async create(input: AutomationCreateRequest): Promise<ScheduledAutomation> {
    const now = this.now()
    const timestamp = now.toISOString()
    const sourceProjectSelection = await this.projectSelectionForSource(input)
    const automation: ScheduledAutomation = {
      id: this.createId(),
      sourceConversationId: input.sourceConversationId,
      ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
      ...(sourceProjectSelection ? { sourceProjectSelection } : {}),
      title: input.title,
      prompt: input.prompt,
      schedule: input.schedule,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: nextRunAt(input.schedule, now)?.toISOString(),
      runs: []
    }
    this.automations = [automation, ...this.automations]
    await this.persist()
    this.scheduleNextRun()
    return cloneAutomation(automation)
  }

  async update(input: AutomationUpdateRequest): Promise<ScheduledAutomation> {
    const current = this.requireAutomation(input.id)
    const now = this.now()
    const schedule = input.schedule ?? current.schedule
    const next: ScheduledAutomation = {
      ...current,
      ...(input.title ? { title: input.title } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      schedule,
      updatedAt: now.toISOString(),
      nextRunAt: current.status === 'active' ? nextRunAt(schedule, now)?.toISOString() : undefined
    }
    this.replace(next)
    await this.persist()
    this.scheduleNextRun()
    return cloneAutomation(next)
  }

  async setStatus(input: AutomationStatusRequest): Promise<ScheduledAutomation> {
    const current = this.requireAutomation(input.id)
    const now = this.now()
    const next: ScheduledAutomation = {
      ...current,
      status: input.status,
      updatedAt: now.toISOString(),
      nextRunAt:
        input.status === 'active' ? nextRunAt(current.schedule, now)?.toISOString() : undefined
    }
    this.replace(next)
    await this.persist()
    this.scheduleNextRun()
    return cloneAutomation(next)
  }

  async remove(id: string): Promise<void> {
    this.requireAutomation(id)
    this.automations = this.automations.filter((automation) => automation.id !== id)
    await this.persist()
    this.scheduleNextRun()
  }

  /** Removes schedules owned by a deleted task and unlinks deleted run tasks. */
  async removeConversationReferences(conversationId: string): Promise<void> {
    const updatedAt = this.now().toISOString()
    let changed = false
    const next: ScheduledAutomation[] = []

    for (const automation of this.automations) {
      if (
        automation.sourceConversationId === conversationId ||
        automation.sourceThreadId === conversationId
      ) {
        changed = true
        continue
      }

      const runs = automation.runs.map((run) => {
        if (run.conversationId !== conversationId && run.threadId !== conversationId) return run
        changed = true
        const unlinkedRun = { ...run }
        delete unlinkedRun.conversationId
        delete unlinkedRun.threadId
        return unlinkedRun
      })
      next.push(
        changedForAutomation(automation.runs, runs)
          ? { ...automation, updatedAt, runs }
          : automation
      )
    }

    if (!changed) return
    this.automations = next
    await this.persist()
    this.scheduleNextRun()
  }

  async runNow(id: string): Promise<ScheduledAutomation> {
    const automation = this.requireAutomation(id)
    if (this.runningAutomationIds.has(id)) {
      throw new Error('This scheduled task is already running.')
    }
    await this.startRun(automation, false)
    return cloneAutomation(this.requireAutomation(id))
  }

  stop(): void {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = undefined
  }

  private scheduleNextRun(): void {
    this.stop()
    const now = this.now().getTime()
    const next = this.automations
      .filter((automation) => automation.status === 'active' && automation.nextRunAt)
      .map((automation) => new Date(automation.nextRunAt!).getTime())
      .filter((timestamp) => Number.isFinite(timestamp))
      .sort((left, right) => left - right)[0]
    if (next === undefined) return

    this.timer = this.setTimer(
      () => {
        this.timer = undefined
        void this.runDueAutomations()
      },
      Math.min(Math.max(0, next - now), maxTimerDelayMs)
    )
  }

  private async runDueAutomations(): Promise<void> {
    const now = this.now()
    const due = this.automations.filter(
      (automation) =>
        automation.status === 'active' &&
        automation.nextRunAt !== undefined &&
        new Date(automation.nextRunAt).getTime() <= now.getTime()
    )

    for (const automation of due) {
      if (!this.runningAutomationIds.has(automation.id)) {
        await this.startRun(automation, true)
      }
    }
    this.scheduleNextRun()
  }

  private async startRun(automation: ScheduledAutomation, scheduled: boolean): Promise<void> {
    this.runningAutomationIds.add(automation.id)
    const now = this.now()
    const run: AutomationRun = {
      id: this.createId(),
      startedAt: now.toISOString(),
      status: 'running'
    }
    const scheduledAutomation: ScheduledAutomation = {
      ...automation,
      updatedAt: now.toISOString(),
      ...(scheduled ? { nextRunAt: nextRunAt(automation.schedule, now)?.toISOString() } : {})
    }
    this.replace({
      ...scheduledAutomation,
      runs: [run, ...scheduledAutomation.runs].slice(0, retainedRuns)
    })
    await this.persist()
    this.scheduleNextRun()

    void this.executeRun(automation.id, run.id)
  }

  private async executeRun(automationId: string, runId: string): Promise<void> {
    let terminal:
      | Extract<CodexChatStreamEvent, { type: 'finish' | 'aborted' | 'error' }>
      | undefined
    try {
      const automation = this.requireAutomation(automationId)
      const projectSelection = await this.projectSelectionFor(automation)
      const request: CodexChatRequest = {
        chatId: `automation:${automationId}:${runId}`,
        trigger: 'submit-message',
        messages: [
          {
            id: `automation-prompt:${runId}`,
            role: 'user',
            parts: [{ type: 'text', text: automation.prompt }]
          }
        ],
        body: {
          ...(projectSelection ? { projectSelection } : {}),
          approvalModeKind: 'request-approval'
        }
      }
      await this.dependencies.runtime.startChatStream(
        request,
        new AutomationPort(),
        {
          onThreadIdAvailable: async (threadId, thread) => {
            await this.recordRunThread(automationId, runId, threadId)
            if (thread) {
              try {
                await this.dependencies.onThreadStarted?.({
                  sourceConversationId: automation.sourceConversationId,
                  thread
                })
              } catch (error) {
                console.warn('failed to publish scheduled task', error)
              }
            }
          },
          onTerminal: (event) => {
            terminal = event
          }
        },
        `automation:${runId}`,
        { threadSource: 'automation' }
      )
      if (terminal?.type === 'error') {
        await this.completeRun(automationId, runId, { error: errorMessage(terminal.error) })
      } else if (terminal?.type === 'aborted') {
        await this.completeRun(automationId, runId, {
          error: 'The scheduled task was interrupted.'
        })
      } else {
        await this.completeRun(automationId, runId, {})
      }
    } catch (error) {
      await this.completeRun(automationId, runId, { error: errorMessage(error) })
    } finally {
      this.runningAutomationIds.delete(automationId)
      this.scheduleNextRun()
    }
  }

  private async completeRun(
    automationId: string,
    runId: string,
    result: { threadId?: string; error?: string }
  ): Promise<void> {
    const automation = this.automations.find((candidate) => candidate.id === automationId)
    if (!automation) return
    const currentRun = automation.runs.find((candidate) => candidate.id === runId)
    if (!currentRun || currentRun.status !== 'running') return
    const completedAt = this.now().toISOString()
    const nextRun: AutomationRun = {
      ...currentRun,
      ...(result.threadId ? { threadId: result.threadId, conversationId: result.threadId } : {}),
      ...(result.error
        ? { status: 'failed' as const, error: result.error }
        : { status: 'completed' as const }),
      completedAt
    }
    this.replace({
      ...automation,
      updatedAt: completedAt,
      runs: automation.runs.map((candidate) => (candidate.id === runId ? nextRun : candidate))
    })
    await this.persist()
  }

  private async recordRunThread(
    automationId: string,
    runId: string,
    threadId: string
  ): Promise<void> {
    const automation = this.automations.find((candidate) => candidate.id === automationId)
    if (!automation) return
    const currentRun = automation.runs.find((candidate) => candidate.id === runId)
    if (!currentRun || currentRun.status !== 'running') return
    this.replace({
      ...automation,
      runs: automation.runs.map((candidate) =>
        candidate.id === runId ? { ...candidate, threadId, conversationId: threadId } : candidate
      )
    })
    await this.persist()
  }

  private async projectSelectionFor(
    automation: ScheduledAutomation
  ): Promise<ProjectSelection | undefined> {
    return automation.sourceProjectSelection ?? this.projectSelectionForSource(automation)
  }

  private async projectSelectionForSource(input: {
    sourceConversationId: string
    sourceThreadId?: string
  }): Promise<ProjectSelection | undefined> {
    const state = await this.dependencies.projectStore.getState()
    const assignment =
      (input.sourceThreadId ? state.threadProjectAssignments[input.sourceThreadId] : undefined) ??
      state.threadProjectAssignments[input.sourceConversationId]
    return assignment ? selectionForAssignment(assignment) : undefined
  }

  private requireAutomation(id: string): ScheduledAutomation {
    const automation = this.automations.find((candidate) => candidate.id === id)
    if (!automation) throw new Error('Scheduled task not found.')
    return automation
  }

  private replace(next: ScheduledAutomation): void {
    this.automations = this.automations.map((automation) =>
      automation.id === next.id ? next : automation
    )
  }

  private async persist(): Promise<void> {
    await this.dependencies.store.set(this.automations)
  }
}

class AutomationPort implements CodexPortLike {
  private messageHandler: ((event: { data: unknown }) => void) | undefined

  postMessage(message: CodexChatStreamEnvelope | CodexChatStreamEvent): void {
    const event = 'event' in message ? message.event : message
    if (event.type !== 'thread-bound') return
    queueMicrotask(() =>
      this.messageHandler?.({ data: { type: 'thread-bound-ack', threadId: event.threadId } })
    )
  }

  on(_event: 'message', handler: (event: { data: unknown }) => void): void {
    this.messageHandler = handler
  }

  start(): void {
    return undefined
  }

  close(): void {
    return undefined
  }
}

function normalizeNextRun(automation: ScheduledAutomation, now: Date): ScheduledAutomation {
  return {
    ...automation,
    nextRunAt:
      automation.status === 'active'
        ? nextRunAt(automation.schedule, now)?.toISOString()
        : undefined
  }
}

export function nextRunAt(schedule: AutomationSchedule, now: Date): Date | undefined {
  if (schedule.kind === 'once') {
    const scheduled = new Date(schedule.at)
    return scheduled.getTime() > now.getTime() ? scheduled : undefined
  }

  const [hours, minutes] = schedule.time.split(':').map(Number)
  if (schedule.kind === 'daily') {
    const candidate = new Date(now)
    candidate.setHours(hours!, minutes!, 0, 0)
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1)
    return candidate
  }

  const candidate = new Date(now)
  const dayOffset = (schedule.weekday - candidate.getDay() + 7) % 7
  candidate.setDate(candidate.getDate() + dayOffset)
  candidate.setHours(hours!, minutes!, 0, 0)
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7)
  return candidate
}

function selectionForAssignment(assignment: ThreadProjectAssignment): ProjectSelection {
  if (assignment.projectKind === 'local') {
    return { projectKind: 'local', projectId: assignment.projectId }
  }
  if (assignment.projectKind === 'remote') {
    return {
      projectKind: 'remote',
      projectId: assignment.projectId,
      hostId: assignment.hostId
    }
  }
  return { projectKind: 'projectless' }
}

function cloneAutomation(automation: ScheduledAutomation): ScheduledAutomation {
  return JSON.parse(JSON.stringify(automation)) as ScheduledAutomation
}

function cloneAutomations(automations: ScheduledAutomation[]): ScheduledAutomation[] {
  return JSON.parse(JSON.stringify(automations)) as ScheduledAutomation[]
}

function changedForAutomation(
  before: readonly AutomationRun[],
  after: readonly AutomationRun[]
): boolean {
  return before.some((run, index) => run !== after[index])
}

function errorMessage(error: unknown): string {
  let message = 'Scheduled task failed to start.'
  if (typeof error === 'string' && error.trim()) {
    message = error
  } else if (error instanceof Error && error.message) {
    message = error.message
  }
  return message.trim().slice(0, 1_000)
}
