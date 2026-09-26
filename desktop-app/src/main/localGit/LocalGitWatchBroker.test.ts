import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { gitIpcChannels } from '../../shared/localGitApi'
import {
  changedTypes,
  compactChangedPaths,
  LocalGitWatchBroker,
  type LocalGitWatchState
} from './LocalGitWatchBroker'

const target = {
  conversationId: 'thread1',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}

describe('LocalGitWatchBroker', () => {
  it('does not poll observed targets until a subscriber exists', () => {
    const getState = vi.fn<() => Promise<LocalGitWatchState>>()
    const broker = new LocalGitWatchBroker({ getState })

    broker.observeTarget(target)

    expect(getState).not.toHaveBeenCalled()
    broker.dispose()
  })

  it('publishes a changed event after a subscribed target fingerprint changes', async () => {
    const webContents = new FakeWebContents(1)
    const states = [
      state('generation-1', { head: 'a', index: 'i1', worktree: 'w1' }),
      state('generation-2', { head: 'a', index: 'i1', worktree: 'w2' })
    ]
    const getState = vi.fn(async () => states.shift() ?? states[0])
    const broker = new LocalGitWatchBroker({
      getState,
      setInterval: vi.fn(() => 1 as never),
      clearInterval: vi.fn()
    })

    broker.subscribe(webContents)
    broker.observeTarget(target)
    await flushPromises()
    await broker.pollNow()

    expect(webContents.send).toHaveBeenCalledWith(gitIpcChannels.changed, {
      target,
      snapshotGeneration: 'generation-2',
      changeTypes: ['working-tree']
    })
    broker.dispose()
  })

  it('does not restart an immediate poll when an existing target is observed again', async () => {
    const getState = vi.fn(async () =>
      state('generation-1', { head: 'a', index: 'i1', worktree: 'w1' })
    )
    const broker = new LocalGitWatchBroker({
      getState,
      setInterval: vi.fn(() => 1 as never),
      clearInterval: vi.fn()
    })

    broker.subscribe(new FakeWebContents(1))
    broker.observeTarget({ ...target, hostId: 'devbox' })
    await flushPromises()
    expect(getState).toHaveBeenCalledTimes(1)

    broker.observeTarget({ ...target, hostId: 'devbox' })
    await flushPromises()

    expect(getState).toHaveBeenCalledTimes(1)
    broker.dispose()
  })

  it('keeps every changed type from one fingerprint sample', () => {
    expect(
      changedTypes(
        state('before', { head: 'one', index: 'one', worktree: 'one' }),
        state('after', { head: 'two', index: 'two', worktree: 'two' })
      )
    ).toEqual(['head', 'index', 'working-tree'])
  })

  it('compacts parent paths and falls back to broad invalidation for .gitignore or too many paths', () => {
    expect(compactChangedPaths('/repo', ['/repo/src', '/repo/src/file.ts'])).toEqual(['src'])
    expect(compactChangedPaths('/repo', ['/repo/.gitignore'])).toBeUndefined()
    expect(
      compactChangedPaths(
        '/repo',
        Array.from({ length: 65 }, (_, index) => `/repo/file-${String(index)}.ts`)
      )
    ).toBeUndefined()
  })

  it('rebuilds a failed local watcher while polling remains available', async () => {
    vi.useFakeTimers()
    try {
      const webContents = new FakeWebContents(1)
      const close = vi.fn()
      const createLocalWatcher = vi
        .fn()
        .mockImplementationOnce((_target, _onPaths, onFailure) => {
          onFailure()
          return { close }
        })
        .mockReturnValue({ close })
      const broker = new LocalGitWatchBroker({
        getState: vi.fn(async () =>
          state('generation-1', { head: 'a', index: 'i', worktree: 'w' })
        ),
        createLocalWatcher,
        setInterval: vi.fn(() => 1 as never),
        clearInterval: vi.fn(),
        setTimeout,
        clearTimeout
      })

      broker.subscribe(webContents)
      broker.observeTarget(target)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(createLocalWatcher).toHaveBeenCalledTimes(2)
      broker.unsubscribe(webContents.id)
      expect(close).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops publishing after the last subscriber unsubscribes', async () => {
    const webContents = new FakeWebContents(1)
    const clearInterval = vi.fn()
    const getState = vi
      .fn<() => Promise<LocalGitWatchState>>()
      .mockResolvedValueOnce(state('generation-1', { head: 'a', index: 'i1', worktree: 'w1' }))
      .mockResolvedValue(state('generation-2', { head: 'b', index: 'i1', worktree: 'w1' }))
    const broker = new LocalGitWatchBroker({
      getState,
      setInterval: vi.fn(() => 1 as never),
      clearInterval
    })

    broker.subscribe(webContents)
    broker.observeTarget(target)
    await flushPromises()
    broker.unsubscribe(webContents.id)
    await broker.pollNow()

    expect(clearInterval).toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalled()
    broker.dispose()
  })

  it('uses a lower default polling rate when observing a remote repository', () => {
    const setInterval = vi.fn(() => 1 as never)
    const clearInterval = vi.fn()
    const broker = new LocalGitWatchBroker({
      getState: vi.fn<() => Promise<LocalGitWatchState>>(),
      setInterval,
      clearInterval
    })

    broker.subscribe(new FakeWebContents(1))
    broker.observeTarget({ ...target, hostId: 'devbox' })

    expect(setInterval).toHaveBeenLastCalledWith(expect.any(Function), 5_000)
    expect(clearInterval).toHaveBeenCalledWith(1)
    broker.dispose()
  })
})

class FakeWebContents extends EventEmitter {
  readonly send = vi.fn()
  private destroyed = false

  constructor(readonly id: number) {
    super()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function state(
  snapshotGeneration: string,
  fingerprint: Partial<LocalGitWatchState['fingerprint']>
): LocalGitWatchState {
  return {
    snapshotGeneration,
    fingerprint: {
      config: '',
      head: '',
      index: '',
      remoteRefs: '',
      syncedBranch: '',
      worktreeTopology: '',
      worktree: '',
      ...fingerprint
    }
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
