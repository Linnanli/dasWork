import { describe, expect, it, vi } from 'vitest'

import { BundledPluginReconcileCoordinator } from './BundledPluginReconcileCoordinator'

describe('BundledPluginReconcileCoordinator', () => {
  it('serializes startup and post-install reconcile runs and refreshes after each run', async () => {
    const order: string[] = []
    const firstRun = deferred()
    let runCount = 0
    const coordinator = new BundledPluginReconcileCoordinator({
      reconcile: vi.fn(async () => {
        runCount += 1
        const current = runCount
        order.push(`start-${current}`)
        if (current === 1) await firstRun.promise
        order.push(`finish-${current}`)
      }),
      refreshCapabilities: vi.fn(() => {
        order.push('refresh')
      }),
      onFailure: vi.fn(),
      warn: vi.fn()
    })

    const startup = coordinator.run('startup')
    const postInstall = coordinator.run('primary-runtime-install')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(order).toEqual(['start-1'])
    firstRun.resolve()
    await Promise.all([startup, postInstall])

    expect(order).toEqual(['start-1', 'finish-1', 'refresh', 'start-2', 'finish-2', 'refresh'])
  })

  it('keeps later reconcile runs retryable after a failed run', async () => {
    const warn = vi.fn()
    const onFailure = vi.fn()
    let runCount = 0
    const coordinator = new BundledPluginReconcileCoordinator({
      reconcile: vi.fn(async () => {
        runCount += 1
        if (runCount === 1) throw new Error('catalog unavailable')
      }),
      refreshCapabilities: vi.fn(),
      onFailure,
      warn
    })

    await coordinator.run('startup')
    await coordinator.run('primary-runtime-install')

    expect(runCount).toBe(2)
    expect(warn).toHaveBeenCalledWith(
      '[bundled-plugins] reconcile failed after startup',
      expect.any(Error)
    )
    expect(onFailure).toHaveBeenCalledOnce()
  })
})

function deferred(): {
  promise: Promise<void>
  resolve(): void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
