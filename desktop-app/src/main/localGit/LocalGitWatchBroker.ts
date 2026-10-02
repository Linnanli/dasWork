import { watch, type FSWatcher } from 'node:fs'
import { join, relative } from 'node:path'

import {
  gitIpcChannels,
  type LocalGitChangeEvent,
  type LocalGitChangeType
} from '../../shared/localGitApi'
import { sendToActiveRenderer } from '../rendererIpc'
import type { LocalGitTarget } from './types'

export type LocalGitWatchState = {
  snapshotGeneration: string
  fingerprint: {
    config: string
    head: string
    index: string
    remoteRefs: string
    syncedBranch: string
    worktreeTopology: string
    worktree: string
  }
  workingTreePaths?: readonly string[]
}

export type LocalGitWatchSession = {
  close(): void
}

export type LocalGitWatchFactory = (
  target: LocalGitTarget,
  onPaths: (paths: readonly string[]) => void,
  onFailure: () => void
) => LocalGitWatchSession | undefined

type WatchedTarget = {
  target: LocalGitTarget
  lastState?: LocalGitWatchState
  polling: boolean
  pendingPaths: Set<string>
  watcher?: LocalGitWatchSession
  watcherDebounceTimer?: NodeJS.Timeout
  watcherRetryTimer?: NodeJS.Timeout
  watcherRetryMs: number
}

type Subscriber = {
  webContents: LocalGitWatchWebContents
  count: number
  destroyedListener: () => void
}

export type LocalGitWatchWebContents = {
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

/**
 * Produces the same typed changes for local and remote repositories. Local
 * repositories use fs.watch as a low-latency hint, while the fingerprint poll
 * remains the correctness fallback for missed filesystem events and every
 * remote host.
 */
export class LocalGitWatchBroker {
  private readonly subscribers = new Map<number, Subscriber>()
  private readonly targets = new Map<string, WatchedTarget>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly options: {
      getState(target: LocalGitTarget): Promise<LocalGitWatchState>
      onRepositoryChange?: (target: LocalGitTarget, event: LocalGitChangeEvent) => void
      pollIntervalMs?: number
      watchDebounceMs?: number
      watchRetryMs?: number
      createLocalWatcher?: LocalGitWatchFactory
      setInterval?: typeof setInterval
      clearInterval?: typeof clearInterval
      setTimeout?: typeof setTimeout
      clearTimeout?: typeof clearTimeout
    }
  ) {}

  subscribe(webContents: LocalGitWatchWebContents): void {
    const existing = this.subscribers.get(webContents.id)
    if (existing) {
      existing.count += 1
      this.ensureStarted()
      return
    }

    const destroyedListener = (): void => this.removeSubscriber(webContents.id)
    webContents.once('destroyed', destroyedListener)
    this.subscribers.set(webContents.id, { webContents, count: 1, destroyedListener })
    this.ensureStarted()
    void this.pollNow()
  }

  unsubscribe(webContentsId: number): void {
    const subscriber = this.subscribers.get(webContentsId)
    if (!subscriber) return
    subscriber.count -= 1
    if (subscriber.count > 0) return
    subscriber.webContents.removeListener('destroyed', subscriber.destroyedListener)
    this.removeSubscriber(webContentsId)
  }

  observeTarget(target: LocalGitTarget): void {
    const key = targetKey(target)
    const isNewTarget = !this.targets.has(key)
    if (isNewTarget) {
      this.targets.set(key, {
        target: { ...target },
        polling: false,
        pendingPaths: new Set(),
        watcherRetryMs: this.options.watchRetryMs ?? 1000
      })
    }
    if (this.hasSubscribers()) {
      if (isNewTarget && target.hostId !== 'local') this.restartTimer()
      this.ensureStarted()
      this.startLocalWatcher(key)
      if (isNewTarget) void this.pollTarget(key)
    }
  }

  async pollNow(): Promise<void> {
    if (!this.hasSubscribers()) return
    await Promise.all([...this.targets.keys()].map((key) => this.pollTarget(key)))
  }

  dispose(): void {
    this.stopTimer()
    for (const watched of this.targets.values()) this.stopTargetWatcher(watched)
    for (const subscriber of this.subscribers.values()) {
      subscriber.webContents.removeListener('destroyed', subscriber.destroyedListener)
    }
    this.subscribers.clear()
    this.targets.clear()
  }

  private async pollTarget(key: string): Promise<void> {
    const watched = this.targets.get(key)
    if (!watched || watched.polling || !this.hasSubscribers()) return
    watched.polling = true
    const watcherPaths = compactChangedPaths(watched.target.gitRoot, watched.pendingPaths)
    watched.pendingPaths.clear()
    try {
      const nextState = await this.options.getState(watched.target)
      const previousState = watched.lastState
      watched.lastState = nextState
      if (!previousState) return
      const changeTypes = changedTypes(previousState, nextState, watcherPaths)
      if (changeTypes.length === 0) return
      const changedPaths = changeTypes.includes('working-tree')
        ? (watcherPaths ?? compactChangedPaths(watched.target.gitRoot, nextState.workingTreePaths))
        : undefined
      const event: LocalGitChangeEvent = {
        target: watched.target,
        snapshotGeneration: nextState.snapshotGeneration,
        changeTypes,
        ...(changedPaths ? { changedPaths } : {})
      }
      this.options.onRepositoryChange?.(watched.target, event)
      this.publish(event)
    } catch {
      // Polling is best-effort. User-facing calls still surface Git errors.
    } finally {
      watched.polling = false
      if (watched.pendingPaths.size > 0) void this.pollTarget(key)
    }
  }

  private queueWatchedPaths(key: string, paths: readonly string[]): void {
    const watched = this.targets.get(key)
    if (!watched || !this.hasSubscribers()) return
    for (const path of paths) watched.pendingPaths.add(path)
    if (watched.watcherDebounceTimer) return
    const setTimeoutImpl = this.options.setTimeout ?? setTimeout
    watched.watcherDebounceTimer = setTimeoutImpl(() => {
      watched.watcherDebounceTimer = undefined
      void this.pollTarget(key)
    }, this.options.watchDebounceMs ?? 75)
  }

  private startLocalWatcher(key: string): void {
    const watched = this.targets.get(key)
    if (
      !watched ||
      watched.target.hostId !== 'local' ||
      watched.watcher ||
      !this.hasSubscribers()
    ) {
      return
    }
    const createWatcher = this.options.createLocalWatcher ?? createFileSystemWatcher
    try {
      watched.watcher = createWatcher(
        watched.target,
        (paths) => this.queueWatchedPaths(key, paths),
        () => queueMicrotask(() => this.rebuildLocalWatcher(key))
      )
      watched.watcherRetryMs = this.options.watchRetryMs ?? 1000
    } catch {
      this.rebuildLocalWatcher(key)
    }
  }

  private rebuildLocalWatcher(key: string): void {
    const watched = this.targets.get(key)
    if (!watched) return
    watched.watcher?.close()
    watched.watcher = undefined
    if (!this.hasSubscribers() || watched.watcherRetryTimer) return
    const setTimeoutImpl = this.options.setTimeout ?? setTimeout
    const delay = watched.watcherRetryMs
    watched.watcherRetryMs = Math.min(delay * 2, 10_000)
    watched.watcherRetryTimer = setTimeoutImpl(() => {
      watched.watcherRetryTimer = undefined
      this.startLocalWatcher(key)
    }, delay)
  }

  private stopTargetWatcher(watched: WatchedTarget): void {
    const clearTimeoutImpl = this.options.clearTimeout ?? clearTimeout
    watched.watcher?.close()
    watched.watcher = undefined
    if (watched.watcherDebounceTimer) clearTimeoutImpl(watched.watcherDebounceTimer)
    if (watched.watcherRetryTimer) clearTimeoutImpl(watched.watcherRetryTimer)
    watched.watcherDebounceTimer = undefined
    watched.watcherRetryTimer = undefined
    watched.pendingPaths.clear()
  }

  private publish(event: LocalGitChangeEvent): void {
    for (const subscriber of this.subscribers.values()) {
      sendToActiveRenderer(subscriber.webContents, gitIpcChannels.changed, event)
    }
  }

  private ensureStarted(): void {
    this.ensureTimer()
    for (const key of this.targets.keys()) this.startLocalWatcher(key)
  }

  private ensureTimer(): void {
    if (this.timer || !this.hasSubscribers()) return
    const setIntervalImpl = this.options.setInterval ?? setInterval
    this.timer = setIntervalImpl(
      () => void this.pollNow(),
      this.options.pollIntervalMs ?? this.defaultPollIntervalMs()
    ) as NodeJS.Timeout
  }

  private restartTimer(): void {
    this.stopTimer()
    this.ensureTimer()
  }

  private defaultPollIntervalMs(): number {
    return [...this.targets.values()].some((watched) => watched.target.hostId !== 'local')
      ? 5_000
      : 1_500
  }

  private stopTimer(): void {
    if (!this.timer) return
    const clearIntervalImpl = this.options.clearInterval ?? clearInterval
    clearIntervalImpl(this.timer)
    this.timer = undefined
  }

  private removeSubscriber(webContentsId: number): void {
    this.subscribers.delete(webContentsId)
    if (this.hasSubscribers()) return
    this.stopTimer()
    for (const watched of this.targets.values()) this.stopTargetWatcher(watched)
  }

  private hasSubscribers(): boolean {
    return this.subscribers.size > 0
  }
}

export const localGitWatchControlChannels = {
  subscribe: `${gitIpcChannels.changed}:subscribe`,
  unsubscribe: `${gitIpcChannels.changed}:unsubscribe`
} as const

export function changedTypes(
  previous: LocalGitWatchState,
  next: LocalGitWatchState,
  watcherPaths?: readonly string[]
): LocalGitChangeType[] {
  const types: LocalGitChangeType[] = []
  if (previous.fingerprint.config !== next.fingerprint.config) types.push('config')
  if (previous.fingerprint.head !== next.fingerprint.head) types.push('head')
  if (previous.fingerprint.index !== next.fingerprint.index) types.push('index')
  if (previous.fingerprint.remoteRefs !== next.fingerprint.remoteRefs) types.push('remote-refs')
  if (previous.fingerprint.syncedBranch !== next.fingerprint.syncedBranch)
    types.push('synced-branch')
  if (previous.fingerprint.worktreeTopology !== next.fingerprint.worktreeTopology) {
    types.push('worktree-topology')
  }
  if (previous.fingerprint.worktree !== next.fingerprint.worktree || watcherPaths) {
    types.push('working-tree')
  }
  return types
}

export function compactChangedPaths(
  root: string,
  paths: Iterable<string> | undefined
): string[] | undefined {
  if (!paths) return undefined
  const normalized = new Set<string>()
  for (const path of paths) {
    if (!path) return undefined
    const relativePath = (
      path === root ||
      path.startsWith(`${root}/`) ||
      path.startsWith(`${root}\\`) ||
      path.startsWith('/') ||
      /^[A-Za-z]:[\\/]/u.test(path)
        ? relative(root, path)
        : path
    ).replaceAll('\\', '/')
    if (!relativePath || relativePath === '.' || relativePath.startsWith('../')) return undefined
    if (relativePath === '.gitignore') return undefined
    if (relativePath === '.git' || relativePath.startsWith('.git/')) continue
    normalized.add(relativePath)
    if (normalized.size > 64) return undefined
  }
  if (normalized.size === 0) return undefined
  return [...normalized]
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .filter(
      (path, index, values) =>
        !values.slice(0, index).some((parent) => path.startsWith(`${parent}/`))
    )
}

function createFileSystemWatcher(
  target: LocalGitTarget,
  onPaths: (paths: readonly string[]) => void,
  onFailure: () => void
): LocalGitWatchSession | undefined {
  let closed = false
  const watchers: FSWatcher[] = []
  const fail = (): void => {
    if (!closed) onFailure()
  }
  try {
    for (const directory of [target.gitRoot, join(target.gitRoot, '.git')]) {
      const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
        if (!filename) {
          onPaths([directory])
          return
        }
        onPaths([join(directory, filename.toString())])
      })
      watcher.once('error', fail)
      watcher.once('close', fail)
      watchers.push(watcher)
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close()
    throw error
  }
  return {
    close: () => {
      closed = true
      for (const watcher of watchers) watcher.close()
    }
  }
}

function targetKey(target: LocalGitTarget): string {
  return JSON.stringify({
    conversationId: target.conversationId,
    threadId: target.threadId ?? null,
    hostId: target.hostId,
    gitRoot: target.gitRoot
  })
}
