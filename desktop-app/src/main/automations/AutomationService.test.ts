import { describe, expect, it, vi } from 'vitest'

import type { CodexChatRequest } from '../../shared/codexIpcApi'
import { AutomationStore } from './AutomationStore'
import { AutomationService, nextRunAt } from './AutomationService'

describe('AutomationService', () => {
  it('persists a local schedule, runs it with the source project, and records the created task', async () => {
    const onThreadStarted = vi.fn()
    const runtime = {
      startChatStream: vi.fn(
        async (
          request: CodexChatRequest,
          _port: unknown,
          callbacks:
            | {
                onThreadIdAvailable?: (threadId: string, thread?: unknown) => Promise<void>
                onTerminal?: (event: { type: 'finish' }) => void
              }
            | undefined,
          _streamId: string | undefined,
          options: { threadSource?: 'automation' } | undefined
        ) => {
          expect(request.body?.projectSelection).toEqual({
            projectKind: 'local',
            projectId: 'project-1'
          })
          expect(request.messages[0]?.parts).toEqual([{ type: 'text', text: 'Run the report.' }])
          expect(options).toEqual({ threadSource: 'automation' })
          await callbacks?.onThreadIdAvailable?.('automation-thread', {
            threadId: 'automation-thread',
            originConversationId: 'automation:automation-1:run-1',
            title: 'Daily report',
            cwd: '/repo'
          })
          callbacks?.onTerminal?.({ type: 'finish' })
          return { threadId: 'automation-thread' }
        }
      )
    }
    const service = new AutomationService({
      store: AutomationStore.inMemory(),
      projectStore: {
        getState: async () => ({
          threadProjectAssignments: {
            source: { projectKind: 'local', projectId: 'project-1', cwd: '/repo' }
          }
        })
      } as never,
      runtime: runtime as never,
      onThreadStarted,
      now: () => new Date('2026-08-28T08:00:00.000Z'),
      createId: idSequence('automation-1', 'run-1')
    })
    await service.load()
    await service.create({
      sourceConversationId: 'source',
      sourceThreadId: 'source',
      title: 'Daily report',
      prompt: 'Run the report.',
      schedule: { kind: 'daily', time: '09:00' }
    })

    expect(service.list()[0]?.sourceProjectSelection).toEqual({
      projectKind: 'local',
      projectId: 'project-1'
    })

    await service.runNow('automation-1')
    await vi.waitFor(() => {
      expect(service.list()[0]?.runs[0]).toMatchObject({
        id: 'run-1',
        status: 'completed',
        conversationId: 'automation-thread',
        threadId: 'automation-thread'
      })
    })
    expect(runtime.startChatStream).toHaveBeenCalledTimes(1)
    expect(onThreadStarted).toHaveBeenCalledWith({
      sourceConversationId: 'source',
      thread: expect.objectContaining({ threadId: 'automation-thread' })
    })
  })

  it('does not mark a run successful until the terminal outcome arrives', async () => {
    let releaseTerminal: (() => void) | undefined
    const runtime = {
      startChatStream: vi.fn(
        async (
          _request: CodexChatRequest,
          _port: unknown,
          callbacks:
            | {
                onThreadIdAvailable?: (threadId: string) => Promise<void>
                onTerminal?: (event: { type: 'error'; error: string }) => void
              }
            | undefined
        ) => {
          await callbacks?.onThreadIdAvailable?.('started-thread')
          await new Promise<void>((resolve) => {
            releaseTerminal = resolve
          })
          callbacks?.onTerminal?.({ type: 'error', error: 'model unavailable' })
          return { threadId: 'started-thread' }
        }
      )
    }
    const service = new AutomationService({
      store: AutomationStore.inMemory(),
      projectStore: { getState: async () => ({ threadProjectAssignments: {} }) } as never,
      runtime: runtime as never,
      createId: idSequence('automation-1', 'run-1')
    })
    await service.load()
    await service.create({
      sourceConversationId: 'source',
      title: 'Report',
      prompt: 'Report status.',
      schedule: { kind: 'daily', time: '09:00' }
    })

    await service.runNow('automation-1')
    await vi.waitFor(() => {
      expect(service.list()[0]?.runs[0]).toMatchObject({
        status: 'running',
        threadId: 'started-thread'
      })
    })
    await vi.waitFor(() => expect(releaseTerminal).toBeTypeOf('function'))
    releaseTerminal!()
    await vi.waitFor(() => {
      expect(service.list()[0]?.runs[0]).toMatchObject({
        status: 'failed',
        error: 'model unavailable'
      })
    })
  })

  it('pauses, resumes, and skips missed one-time schedules after an app restart', async () => {
    const store = AutomationStore.inMemory()
    const now = new Date('2026-08-28T08:00:00.000Z')
    const service = new AutomationService({
      store,
      projectStore: { getState: async () => ({ threadProjectAssignments: {} }) } as never,
      runtime: { startChatStream: vi.fn() },
      now: () => now,
      createId: idSequence('once', 'daily')
    })
    await service.load()
    await service.create({
      sourceConversationId: 'source',
      title: 'One time',
      prompt: 'Do this once.',
      schedule: { kind: 'once', at: '2026-08-28T09:00:00.000Z' }
    })
    await service.create({
      sourceConversationId: 'source',
      title: 'Daily',
      prompt: 'Do this daily.',
      schedule: { kind: 'daily', time: '09:00' }
    })
    await service.setStatus({ id: 'daily', status: 'paused' })
    expect(
      service.list().find((automation) => automation.id === 'daily')?.nextRunAt
    ).toBeUndefined()
    await service.setStatus({ id: 'daily', status: 'active' })
    expect(service.list().find((automation) => automation.id === 'daily')?.nextRunAt).toBe(
      nextRunAt({ kind: 'daily', time: '09:00' }, now)?.toISOString()
    )

    const restarted = new AutomationService({
      store,
      projectStore: { getState: async () => ({ threadProjectAssignments: {} }) } as never,
      runtime: { startChatStream: vi.fn() },
      now: () => new Date('2026-08-28T10:00:00.000Z')
    })
    await restarted.load()
    expect(
      restarted.list().find((automation) => automation.id === 'once')?.nextRunAt
    ).toBeUndefined()
    expect(restarted.list().find((automation) => automation.id === 'daily')?.nextRunAt).toBe(
      nextRunAt(
        { kind: 'daily', time: '09:00' },
        new Date('2026-08-28T10:00:00.000Z')
      )?.toISOString()
    )
  })

  it('cleans source schedules and deleted generated-task links', async () => {
    const runtime = {
      startChatStream: vi.fn(
        async (
          _request: CodexChatRequest,
          _port: unknown,
          callbacks:
            | {
                onThreadIdAvailable?: (threadId: string) => Promise<void>
                onTerminal?: (event: { type: 'finish' }) => void
              }
            | undefined
        ) => {
          await callbacks?.onThreadIdAvailable?.('generated-task')
          callbacks?.onTerminal?.({ type: 'finish' })
          return { threadId: 'generated-task' }
        }
      )
    }
    const service = new AutomationService({
      store: AutomationStore.inMemory(),
      projectStore: { getState: async () => ({ threadProjectAssignments: {} }) } as never,
      runtime: runtime as never,
      createId: idSequence('source-schedule', 'kept-schedule', 'run-1')
    })
    await service.load()
    await service.create({
      sourceConversationId: 'source-task',
      title: 'Remove me',
      prompt: 'Remove me.',
      schedule: { kind: 'daily', time: '09:00' }
    })
    await service.create({
      sourceConversationId: 'kept-task',
      title: 'Keep me',
      prompt: 'Keep me.',
      schedule: { kind: 'daily', time: '09:00' }
    })
    await service.runNow('kept-schedule')
    await vi.waitFor(() => {
      expect(
        service.list().find((automation) => automation.id === 'kept-schedule')?.runs[0]?.threadId
      ).toBe('generated-task')
    })

    await service.removeConversationReferences('source-task')
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]?.id).toBe('kept-schedule')

    await service.removeConversationReferences('generated-task')
    expect(service.list()[0]?.runs[0]).toMatchObject({ status: 'completed' })
    expect(service.list()[0]?.runs[0]?.threadId).toBeUndefined()
    expect(service.list()[0]?.runs[0]?.conversationId).toBeUndefined()
  })

  it('calculates daily and weekly future occurrences in the local timezone', () => {
    const friday = new Date(2026, 7, 28, 9, 0, 0)
    expect(nextRunAt({ kind: 'daily', time: '09:00' }, friday)?.toDateString()).toBe(
      new Date(2026, 7, 29).toDateString()
    )
    expect(nextRunAt({ kind: 'weekly', weekday: 5, time: '10:00' }, friday)?.toDateString()).toBe(
      friday.toDateString()
    )
  })
})

function idSequence(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? `id-${index}`
}
