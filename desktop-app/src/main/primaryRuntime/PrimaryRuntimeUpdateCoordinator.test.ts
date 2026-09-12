import { describe, expect, it, vi } from 'vitest'

import { PrimaryRuntimeUpdateCoordinator } from './PrimaryRuntimeUpdateCoordinator'

describe('PrimaryRuntimeUpdateCoordinator', () => {
  it('single-flights scheduled checks, reports failures, and cancels pending install on stop', async () => {
    const updateIfAvailable = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('feed offline'))
    const cancelInstall = vi.fn(async () => undefined)
    const onFailure = vi.fn()
    let scheduled: (() => void) | undefined
    let nowMs = 0
    const coordinator = new PrimaryRuntimeUpdateCoordinator({
      runtime: { updateIfAvailable, cancelInstall },
      pollIntervalMs: 30_000,
      onFailure,
      schedule: (callback) => {
        scheduled = callback
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: vi.fn(),
      now: () => new Date(nowMs)
    })

    await coordinator.start()
    expect(updateIfAvailable).toHaveBeenCalledOnce()
    expect(scheduled).toBeTypeOf('function')

    nowMs += 60_000
    scheduled?.()
    expect(updateIfAvailable).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
    await coordinator.stop()
    expect(cancelInstall).toHaveBeenCalledOnce()
  })

  it('uses jittered steady-state polling and exponential backoff after failures', async () => {
    const updateIfAvailable = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('feed offline'))
      .mockRejectedValueOnce(new Error('feed still offline'))
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    const onScheduled = vi.fn()
    let nowMs = Date.parse('2026-09-10T06:00:00.000Z')
    const coordinator = new PrimaryRuntimeUpdateCoordinator({
      runtime: {
        updateIfAvailable,
        cancelInstall: vi.fn(async () => undefined)
      },
      pollIntervalMs: 30_000,
      random: () => 0.75,
      now: () => new Date(nowMs),
      onScheduled,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: vi.fn()
    })

    await coordinator.start()
    expect(scheduled[0]?.delayMs).toBe(30_000)
    expect(onScheduled).toHaveBeenLastCalledWith(new Date('2026-09-10T06:00:31.500Z'))

    nowMs += 32_000
    scheduled[0]?.callback()
    await vi.waitFor(() => expect(scheduled).toHaveLength(2))
    expect(scheduled[1]?.delayMs).toBe(30_000)

    nowMs += 32_000
    scheduled[1]?.callback()
    await vi.waitFor(() => expect(scheduled).toHaveLength(3))
    expect(scheduled[2]?.delayMs).toBe(30_000)
    expect(onScheduled).toHaveBeenLastCalledWith(new Date('2026-09-10T06:02:07.000Z'))
    await coordinator.stop()
  })

  it('reuses a persisted jitter sample instead of resampling after restart', async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    const jitterStore = {
      read: vi.fn(async () => 0),
      write: vi.fn(async () => undefined)
    }
    const coordinator = new PrimaryRuntimeUpdateCoordinator({
      runtime: {
        updateIfAvailable: vi.fn(async () => undefined),
        cancelInstall: vi.fn(async () => undefined)
      },
      pollIntervalMs: 30_000,
      random: () => 0.75,
      jitterStore,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return scheduled.length as unknown as ReturnType<typeof setTimeout>
      },
      clearSchedule: vi.fn()
    })

    await coordinator.start()

    expect(jitterStore.read).toHaveBeenCalledOnce()
    expect(jitterStore.write).not.toHaveBeenCalled()
    expect(scheduled[0]?.delayMs).toBe(30_000)
    await coordinator.stop()
  })

  it('rechecks immediately after a product config or workspace feature change', async () => {
    const updateIfAvailable = vi.fn(async () => undefined)
    const clearSchedule = vi.fn()
    const coordinator = new PrimaryRuntimeUpdateCoordinator({
      runtime: { updateIfAvailable, cancelInstall: vi.fn(async () => undefined) },
      pollIntervalMs: 30_000,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearSchedule
    })

    await coordinator.start()
    await coordinator.refreshAfterConfigurationChange()

    expect(updateIfAvailable).toHaveBeenCalledTimes(2)
    expect(clearSchedule).toHaveBeenCalledOnce()
    await coordinator.stop()
  })
})
