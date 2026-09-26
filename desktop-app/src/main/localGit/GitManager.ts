import { posix, win32 } from 'node:path'

import { createGitDiffArgs, gitDiffOutputLimitBytes, type GitDiffCliOptions } from './gitCli'
import {
  GitReadCache,
  createGitReadCacheKey,
  gitReadCachePathMatches,
  type GitReadCacheKey,
  type GitReadCacheMetadata,
  type GitReadInvalidationReason
} from './GitReadCache'

export type GitRunResult = {
  success: boolean
  code: number | null
  stdout: string
  stderr: string
}

export type GitBytesResult = {
  success: boolean
  code: number | null
  stdout: Uint8Array
  stderr: string
}

export type GitRunOptions = {
  input?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  priority?: 'background'
}

export type GitHost = {
  id: string
  isLocal: boolean
  runGit(args: readonly string[], cwd: string, options?: GitRunOptions): Promise<GitRunResult>
  runGitBytes?(
    args: readonly string[],
    cwd: string,
    options?: GitRunOptions
  ): Promise<GitBytesResult>
  readFileBytes?(
    path: string,
    options?: { maxBytes?: number; signal?: AbortSignal }
  ): Promise<Uint8Array>
  realpathFile?(path: string, options?: { signal?: AbortSignal }): Promise<string>
  createTempDirectory?(prefix: string, options?: { signal?: AbortSignal }): Promise<string>
  copyFile?(source: string, destination: string, options?: { signal?: AbortSignal }): Promise<void>
  remove?(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  statFile?(
    path: string,
    options?: { signal?: AbortSignal }
  ): Promise<{ size?: number; mtimeMs?: number; ctimeMs?: number; ino?: number } | null>
  /** Used only when a Windows-hosted Git executable expects a WSL path. */
  toGitPath?(path: string): string
  platformFamily?: 'posix' | 'windows'
}

export type GitAppEvent = { type: 'background' } | { type: 'foreground' } | { type: 'turnComplete' }

export type GitAppEventSource = {
  subscribe(listener: (event: GitAppEvent) => void): () => void
}

type StableMetadata = {
  root: string
  commonDir: string
}

const stableMetadataCacheMs = 24 * 60 * 60 * 1000
const stableMetadataPermissionRetryMs = 1000
const permanentGitReadCacheMs = Number.POSITIVE_INFINITY
const allUntrackedPathsCacheMs = 10_000
const slowAllUntrackedPathsCacheMs = 20_000
const slowAllUntrackedPathsThresholdMs = 7_000
const maxReliableUntrackedReconcilePaths = 64

type GitConfigScope = 'local' | 'worktree'
type TemporaryIndexPaths = {
  indexPath: string
  sharedIndexPath: string | null
}

type AllUntrackedPathsCacheEntry = {
  generation: number
  paths: readonly string[] | null
  promise: Promise<readonly string[]> | null
  createdAt: number
  staleTime: number
  pendingReconcilePaths: readonly string[] | null
}

export class RepoRepository {
  private readonly originUrlCache = new TinyAsyncCache<void, string | null>(stableMetadataCacheMs)

  constructor(
    private readonly commonDir: string,
    readonly host: GitHost
  ) {}

  getCommonDir(): string {
    return this.commonDir
  }

  getOriginUrl(signal?: AbortSignal): Promise<string | null> {
    return this.originUrlCache.get(undefined, async () => {
      const result = await this.host.runGit(
        ['config', '--get', 'remote.origin.url'],
        this.commonDir,
        { signal }
      )
      return result.success && result.stdout.trim() ? result.stdout.trim() : null
    })
  }
}

export class GitReviewSnapshotStaleError extends Error {
  constructor() {
    super('Git snapshot became stale')
    this.name = 'GitReviewSnapshotStaleError'
  }
}

export class GitReviewSnapshot {
  private readonly abortController = new AbortController()
  private activeOperations = 0
  private objectStorePromise: Promise<Record<string, string>> | null = null
  readonly signal = this.abortController.signal

  constructor(
    private readonly worktreeRepo: WorktreeRepository,
    readonly generation: number
  ) {}

  git(args: readonly string[], options: GitRunOptions = {}): Promise<GitRunResult> {
    return this.run(false, (env) => this.worktreeRepo.git(args, this.commandOptions(options, env)))
  }

  gitDiff(args: readonly string[], options: GitDiffCliOptions = {}): Promise<GitRunResult> {
    return this.run(false, (env) => {
      const { maxOutputBytes, ...commandOptions } = options
      return this.worktreeRepo.git(createGitDiffArgs(args, options), {
        ...this.commandOptions(commandOptions, env),
        maxOutputBytes:
          maxOutputBytes === undefined
            ? gitDiffOutputLimitBytes
            : Math.min(maxOutputBytes, gitDiffOutputLimitBytes)
      })
    })
  }

  queryKey(type: string, ...parts: string[]): GitReadCacheKey {
    return this.worktreeRepo.queryKey(type, 'review', String(this.generation), ...parts)
  }

  read<T>(operation: (env?: Record<string, string>) => Promise<T>): Promise<T> {
    return this.run(false, operation)
  }

  withTempIndex<T>(operation: (env: Record<string, string>) => Promise<T>): Promise<T> {
    return this.run(true, async (objectStoreEnv) => {
      const host = this.worktreeRepo.host
      if (!host.createTempDirectory || !host.copyFile || !host.remove) {
        throw new Error('Git host cannot create a temporary index')
      }
      const indexPaths = await resolveTemporaryIndexPaths(this.worktreeRepo, this.signal)
      if (!indexPaths) throw new Error('Failed to resolve git index path')
      const directory = await host.createTempDirectory('codex-index-', {
        signal: this.signal
      })
      const platformPath = host.platformFamily === 'windows' ? win32 : posix
      const temporaryIndex = platformPath.join(directory, 'index')
      const gitIndexPath = host.toGitPath?.(temporaryIndex) ?? temporaryIndex
      try {
        await copyTemporaryIndexFiles(directory, indexPaths, host, this.signal)
        return await operation({
          ...(objectStoreEnv ?? {}),
          GIT_INDEX_FILE: gitIndexPath
        })
      } finally {
        await host.remove(directory, { recursive: true, force: true })
      }
    })
  }

  retire(): void {
    if (this.signal.aborted) return
    this.abortController.abort()
    this.removeRetiredStoreWhenIdle()
  }

  private async run<T>(
    needsObjectStore: boolean,
    operation: (env?: Record<string, string>) => Promise<T>
  ): Promise<T> {
    this.assertCurrent()
    this.activeOperations += 1
    try {
      const env = needsObjectStore
        ? await (this.objectStorePromise ??= this.createObjectStore())
        : await this.objectStorePromise
      this.assertCurrent()
      const result = await operation(env ?? undefined)
      this.assertCurrent()
      return result
    } catch (error) {
      if (this.worktreeRepo.reviewSnapshot === this) throw error
      throw new GitReviewSnapshotStaleError()
    } finally {
      this.activeOperations -= 1
      this.removeRetiredStoreWhenIdle()
    }
  }

  private assertCurrent(): void {
    if (this.signal.aborted || this.worktreeRepo.reviewSnapshot !== this) {
      throw new GitReviewSnapshotStaleError()
    }
  }

  private commandOptions(
    options: GitRunOptions,
    objectStoreEnv?: Record<string, string>
  ): GitRunOptions {
    return {
      ...options,
      env: { ...objectStoreEnv, ...options.env },
      signal: combineSignals(this.signal, options.signal)
    }
  }

  private async createObjectStore(): Promise<Record<string, string>> {
    const host = this.worktreeRepo.host
    if (!host.createTempDirectory) throw new Error('Git host cannot create temporary directories')
    const objectsDirectory = await resolveGitPath(this.worktreeRepo, 'objects', this.signal)
    if (!objectsDirectory) throw new Error('Failed to resolve Git object directory')
    const directory = await host.createTempDirectory('codex-review-objects-', {
      signal: this.signal
    })
    return {
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(objectsDirectory),
      GIT_OBJECT_DIRECTORY: directory
    }
  }

  private removeRetiredStoreWhenIdle(): void {
    const store = this.objectStorePromise
    if (!this.signal.aborted || this.activeOperations !== 0 || !store) return
    store
      .then(({ GIT_OBJECT_DIRECTORY }) =>
        this.worktreeRepo.host.remove?.(GIT_OBJECT_DIRECTORY, { recursive: true, force: true })
      )
      .catch(() => undefined)
  }
}

export class WorktreeRepository {
  private readonly gitReadCache = new GitReadCache()
  private gitReadGenerationValue = 0
  private untrackedGenerationValue = 0
  private allUntrackedPathsCache: AllUntrackedPathsCacheEntry | null = null
  private reviewSnapshotValue: GitReviewSnapshot

  constructor(
    readonly root: string,
    readonly host: GitHost
  ) {
    this.reviewSnapshotValue = new GitReviewSnapshot(this, 0)
  }

  get gitReadGeneration(): number {
    return this.gitReadGenerationValue
  }

  get untrackedGeneration(): number {
    return this.untrackedGenerationValue
  }

  get reviewSnapshot(): GitReviewSnapshot {
    return this.reviewSnapshotValue
  }

  git(args: readonly string[], options?: GitRunOptions): Promise<GitRunResult> {
    return this.host.runGit(args, this.root, options)
  }

  queryKey(type: string, ...parts: string[]): GitReadCacheKey {
    return createGitReadCacheKey(this.host.id, this.root, type, ...parts)
  }

  readCached<T>(
    type: string,
    parts: readonly string[],
    load: () => Promise<T>,
    options: { staleTime?: number; metadata?: GitReadCacheMetadata } = {}
  ): Promise<T> {
    return this.gitReadCache.fetch(this.queryKey(type, ...parts), load, options)
  }

  async listUntrackedPaths(signal?: AbortSignal): Promise<readonly string[]> {
    const generation = this.untrackedGenerationValue
    const existing = this.allUntrackedPathsCache
    if (existing?.generation === generation) {
      if (existing.promise) return existing.promise
      if (existing.paths && Date.now() - existing.createdAt < existing.staleTime) {
        return existing.paths
      }
    }

    const previousPaths = existing?.paths ?? null
    const reconcileRequest =
      existing?.pendingReconcilePaths && previousPaths
        ? { previousPaths, paths: [...existing.pendingReconcilePaths] }
        : null
    const startedAt = Date.now()
    const promise = (
      reconcileRequest
        ? this.reconcileUntrackedPaths(
            reconcileRequest.previousPaths,
            reconcileRequest.paths,
            signal
          )
        : this.loadAllUntrackedPaths(signal)
    ).then(async (paths) => {
      if (this.untrackedGenerationValue !== generation) {
        return this.listUntrackedPaths(signal)
      }
      const staleTime =
        Date.now() - startedAt > slowAllUntrackedPathsThresholdMs
          ? slowAllUntrackedPathsCacheMs
          : allUntrackedPathsCacheMs
      this.allUntrackedPathsCache = {
        generation,
        paths,
        promise: null,
        createdAt: Date.now(),
        staleTime,
        pendingReconcilePaths: null
      }
      return paths
    })

    this.allUntrackedPathsCache = {
      generation,
      paths: previousPaths,
      promise,
      createdAt: startedAt,
      staleTime: 0,
      pendingReconcilePaths: reconcileRequest?.paths ?? null
    }
    try {
      return await promise
    } catch (error) {
      if (this.allUntrackedPathsCache?.promise === promise) this.allUntrackedPathsCache = null
      throw error
    }
  }

  async getConfigValue(key: string, signal?: AbortSignal): Promise<string | null> {
    return this.readCached(
      'config-value',
      [key],
      async () => {
        const result = await this.git(['config', '--get', key], { signal })
        return result.success && result.stdout ? result.stdout : null
      },
      { staleTime: permanentGitReadCacheMs, metadata: { gitReadInvalidation: ['config'] } }
    )
  }

  async getConfigValueForScope(
    key: string,
    scope: GitConfigScope,
    signal?: AbortSignal
  ): Promise<string | null> {
    return this.readCached(
      'config-value-for-scope',
      [scope, key],
      async () => {
        const result = await this.git(
          ['config', scope === 'local' ? '--local' : '--worktree', '--get', key],
          {
            signal
          }
        )
        return result.success && result.stdout ? result.stdout : null
      },
      { staleTime: permanentGitReadCacheMs, metadata: { gitReadInvalidation: ['config'] } }
    )
  }

  async setConfigValueForScope(
    key: string,
    value: string,
    scope: GitConfigScope,
    signal?: AbortSignal
  ): Promise<boolean> {
    const args = ['config', scope === 'local' ? '--local' : '--worktree', key, value]
    let result = await this.git(args, { signal })
    if (
      !result.success &&
      scope === 'worktree' &&
      result.stderr.toLowerCase().includes('worktreeconfig')
    ) {
      const enableResult = await this.git(['config', 'extensions.worktreeConfig', 'true'], {
        signal
      })
      if (enableResult.success) result = await this.git(args, { signal })
    }
    if (!result.success) return false
    this.invalidateGitReadCachesForRepoChange('config')
    return true
  }

  requireReviewSnapshot(generation: number): GitReviewSnapshot {
    if (
      this.reviewSnapshotValue.generation !== generation ||
      this.reviewSnapshotValue.signal.aborted
    ) {
      throw new GitReviewSnapshotStaleError()
    }
    return this.reviewSnapshotValue
  }

  clearGitReadCaches(): void {
    this.gitReadGenerationValue += 1
    this.untrackedGenerationValue += 1
    this.gitReadCache.clear()
    this.allUntrackedPathsCache = null
  }

  clearShortLivedGitReadCaches(): void {
    this.gitReadGenerationValue += 1
    this.gitReadCache.invalidateWhere(
      (entry) => entry.metadata.gitReadInvalidation === 'short-lived'
    )
  }

  invalidateUntrackedPathsCache(paths: readonly string[] | null = null): void {
    this.untrackedGenerationValue += 1
    const reconcilePaths = normalizeReliableUntrackedReconcilePaths(this.root, paths)
    if (reconcilePaths && this.allUntrackedPathsCache?.paths) {
      this.allUntrackedPathsCache = {
        generation: this.untrackedGenerationValue,
        paths: this.allUntrackedPathsCache.paths,
        promise: null,
        createdAt: 0,
        staleTime: 0,
        pendingReconcilePaths: reconcilePaths
      }
      return
    }
    this.allUntrackedPathsCache = null
    this.gitReadCache.invalidateWhere((entry) => entry.key[3] === 'all-untracked-paths')
  }

  invalidateGitReadCachesForMutation(): void {
    this.gitReadGenerationValue += 1
    this.advanceReviewSnapshot()
    this.gitReadCache.invalidateWhere(
      (entry) => entry.metadata.gitReadInvalidation === 'short-lived'
    )
  }

  invalidateGitReadCachesForRepoChange(
    reason: GitReadInvalidationReason,
    changedPaths?: readonly string[]
  ): void {
    this.gitReadGenerationValue += 1
    if (reason === 'working-tree') this.invalidateUntrackedPathsCache(changedPaths ?? null)
    this.advanceReviewSnapshot()
    this.gitReadCache.invalidateWhere((entry) => {
      const invalidation = entry.metadata.gitReadInvalidation
      if (invalidation === 'short-lived') return true
      if (!Array.isArray(invalidation) || !invalidation.includes(reason)) return false
      return gitReadCachePathMatches(this.root, entry.metadata.gitReadPaths, changedPaths)
    })
  }

  private advanceReviewSnapshot(): void {
    const previous = this.reviewSnapshotValue
    this.reviewSnapshotValue = new GitReviewSnapshot(this, previous.generation + 1)
    previous.retire()
  }

  private async loadAllUntrackedPaths(signal?: AbortSignal): Promise<readonly string[]> {
    const result = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], { signal })
    if (!result.success) {
      throw new Error(
        `Failed to list untracked paths: ${result.stderr || result.stdout || 'Unknown error'}`
      )
    }
    return parseNulPaths(result.stdout)
  }

  private async reconcileUntrackedPaths(
    previousPaths: readonly string[],
    changedPaths: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly string[]> {
    const result = await this.git(
      ['ls-files', '--stage', '--others', '--exclude-standard', '-z', '--', ...changedPaths],
      { signal }
    )
    if (!result.success) {
      throw new Error(
        `Failed to reconcile untracked paths: ${result.stderr || result.stdout || 'Unknown error'}`
      )
    }
    const next = new Set(previousPaths)
    for (const changedPath of changedPaths) {
      for (const existingPath of [...next]) {
        if (pathIntersects(existingPath, changedPath)) next.delete(existingPath)
      }
    }
    for (const path of parseLsFilesStageOthersOutput(result.stdout)) next.add(path)
    return [...next].sort()
  }
}

export class GitManager {
  private readonly reposByKey = new Map<string, RepoRepository>()
  private readonly worktreesByKey = new Map<string, WorktreeRepository>()
  private readonly stableMetadataRetryByKey = new Map<
    string,
    { error: Error; retryAfterMs: number }
  >()
  private readonly stableRootCache = new TinyAsyncCache<string, string | null>(
    stableMetadataCacheMs
  )
  private readonly stableMetadataCache = new TinyAsyncCache<string, StableMetadata | null>(
    stableMetadataCacheMs
  )
  private hasBackgroundedSinceLastForeground = false

  constructor(appEvents?: GitAppEventSource) {
    appEvents?.subscribe((event) => {
      this.handleAppEvent(event)
    })
  }

  async getRepoRepository(cwd: string, host: GitHost): Promise<RepoRepository | null> {
    const metadata = await this.getStableMetadata(cwd, host)
    return metadata ? this.getOrCreateRepo(metadata.commonDir, host) : null
  }

  async getWorktreeRepository(cwd: string, host: GitHost): Promise<WorktreeRepository | null> {
    const root = await this.getStableRoot(cwd, host)
    return root ? this.getOrCreateWorktree(root, host) : null
  }

  getWorktreeRepositoryForRoot(root: string, host: GitHost): WorktreeRepository {
    return this.getOrCreateWorktree(root, host)
  }

  invalidateStableMetadata(): void {
    this.stableRootCache.clear()
    this.stableMetadataCache.clear()
    this.stableMetadataRetryByKey.clear()
  }

  invalidateUntrackedPathsCache(root: string | null = null, host?: GitHost | null): void {
    for (const [key, worktree] of this.worktreesByKey) {
      if (root !== null && worktree.root !== root) continue
      if (!host || key.startsWith(`${host.id}|`)) worktree.invalidateUntrackedPathsCache()
    }
  }

  invalidateShortLivedGitReadCaches(host?: GitHost | null): void {
    for (const [key, worktree] of this.worktreesByKey) {
      if (!host || key.startsWith(`${host.id}|`)) worktree.clearShortLivedGitReadCaches()
    }
  }

  async invalidateGitReadCachesForMutation(root: string, host: GitHost): Promise<void> {
    const key = this.getWorktreeKey(root, host)
    let worktree = this.worktreesByKey.get(key)
    if (!worktree) {
      try {
        worktree = (await this.getWorktreeRepository(root, host)) ?? undefined
      } catch {
        worktree = undefined
      }
    }

    if (worktree) {
      worktree.invalidateGitReadCachesForMutation()
      return
    }

    for (const [candidateKey, candidate] of this.worktreesByKey) {
      if (candidateKey.startsWith(`${host.id}|`)) candidate.invalidateGitReadCachesForMutation()
    }
  }

  invalidateGitReadCachesForRepoChange(reason: string, host?: GitHost | null): void {
    if (!isGitReadInvalidationReason(reason)) return
    for (const [key, worktree] of this.worktreesByKey) {
      if (!host || key.startsWith(`${host.id}|`)) {
        worktree.invalidateGitReadCachesForRepoChange(reason)
      }
    }
  }

  handleAppEvent(event: GitAppEvent): void {
    switch (event.type) {
      case 'background':
        this.hasBackgroundedSinceLastForeground = true
        break
      case 'foreground':
        if (this.hasBackgroundedSinceLastForeground) {
          this.invalidateUntrackedPathsCache()
          this.invalidateShortLivedGitReadCaches()
        }
        this.hasBackgroundedSinceLastForeground = false
        break
      case 'turnComplete':
        this.invalidateUntrackedPathsCache()
        this.invalidateShortLivedGitReadCaches()
        break
    }
  }

  private getOrCreateRepo(commonDir: string, host: GitHost): RepoRepository {
    const key = this.getRepoKey(commonDir, host)
    const existing = this.reposByKey.get(key)
    if (existing) return existing
    const repo = new RepoRepository(commonDir, host)
    this.reposByKey.set(key, repo)
    return repo
  }

  private getOrCreateWorktree(root: string, host: GitHost): WorktreeRepository {
    const key = this.getWorktreeKey(root, host)
    const existing = this.worktreesByKey.get(key)
    if (existing) return existing
    const worktree = new WorktreeRepository(root, host)
    this.worktreesByKey.set(key, worktree)
    return worktree
  }

  private getRepoKey(commonDir: string, host: GitHost): string {
    return `${host.id}|${commonDir}`
  }

  private getWorktreeKey(root: string, host: GitHost): string {
    return `${host.id}|${root}`
  }

  private async getStableRoot(cwd: string, host: GitHost): Promise<string | null> {
    this.throwStableMetadataRetry(cwd, host)
    try {
      const root = await this.stableRootCache.get(this.getStableMetadataKey(cwd, host), () =>
        resolveGitRoot(cwd, host)
      )
      this.stableMetadataRetryByKey.delete(this.getStableMetadataKey(cwd, host))
      return root
    } catch (error) {
      this.throwStableMetadataReadError(cwd, host, error)
    }
  }

  private async getStableMetadata(cwd: string, host: GitHost): Promise<StableMetadata | null> {
    this.throwStableMetadataRetry(cwd, host)
    try {
      const metadata = await this.stableMetadataCache.get(
        this.getStableMetadataKey(cwd, host),
        async () => {
          const root = await this.getStableRoot(cwd, host)
          if (!root) return null
          const commonDir = await resolveGitCommonDir(root, host)
          return commonDir ? { root, commonDir } : null
        }
      )
      this.stableMetadataRetryByKey.delete(this.getStableMetadataKey(cwd, host))
      return metadata
    } catch (error) {
      this.throwStableMetadataReadError(cwd, host, error)
    }
  }

  private throwStableMetadataRetry(cwd: string, host: GitHost): void {
    const key = this.getStableMetadataKey(cwd, host)
    const retry = this.stableMetadataRetryByKey.get(key)
    if (!retry) return
    if (Date.now() < retry.retryAfterMs) throw retry.error
    this.stableMetadataRetryByKey.delete(key)
  }

  private throwStableMetadataReadError(cwd: string, host: GitHost, error: unknown): never {
    if (!isPermissionCwdReadError(error)) throw error
    const normalized = error instanceof Error ? error : new Error(String(error))
    const key = this.getStableMetadataKey(cwd, host)
    this.stableMetadataRetryByKey.set(key, {
      error: normalized,
      retryAfterMs: Date.now() + stableMetadataPermissionRetryMs
    })
    this.stableRootCache.delete(key)
    this.stableMetadataCache.delete(key)
    throw normalized
  }

  private getStableMetadataKey(cwd: string, host: GitHost): string {
    return `${host.id}|${cwd}`
  }
}

class TinyAsyncCache<K, V> {
  private readonly entries = new Map<K, { expiresAt: number; promise: Promise<V> }>()

  constructor(private readonly maxAgeMs: number) {}

  get(key: K, load: () => Promise<V>): Promise<V> {
    const now = Date.now()
    const existing = this.entries.get(key)
    if (existing && existing.expiresAt > now) return existing.promise

    const promise = load()
    this.entries.set(key, { expiresAt: now + this.maxAgeMs, promise })
    promise.catch(() => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key)
    })
    return promise
  }

  delete(key: K): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

async function resolveGitRoot(cwd: string, host: GitHost): Promise<string | null> {
  const result = await host.runGit(['rev-parse', '--show-toplevel'], cwd)
  if (result.success && result.stdout.trim()) return normalizePath(result.stdout)
  if (
    (result.code === 128 && isNotGitRepositoryError(result.stderr)) ||
    result.stderr === 'Git is unavailable'
  ) {
    return null
  }
  throw new Error(
    `Failed to resolve git root: ${result.stderr || result.stdout || 'Unknown error'}`
  )
}

async function resolveGitCommonDir(root: string, host: GitHost): Promise<string | null> {
  const result = await host.runGit(['rev-parse', '--git-common-dir'], root)
  if (result.success && result.stdout.trim()) {
    const commonDir = result.stdout.trim()
    return resolveHostPath(host, root, commonDir)
  }
  if (result.code === 128 && isNotGitRepositoryError(result.stderr)) return null
  throw new Error(
    `Failed to resolve git common dir: ${result.stderr || result.stdout || 'Unknown error'}`
  )
}

async function resolveGitDirectory(
  repository: WorktreeRepository,
  signal?: AbortSignal
): Promise<string | null> {
  return repository.readCached(
    'git-dir',
    [],
    async () => {
      const result = await repository.git(['rev-parse', '--git-dir'], { signal })
      if (!result.success || !result.stdout.trim()) return null
      return resolveHostPath(repository.host, repository.root, result.stdout.trim())
    },
    { staleTime: permanentGitReadCacheMs }
  )
}

async function resolveGitPath(
  repository: WorktreeRepository,
  pathPart: string,
  signal?: AbortSignal
): Promise<string | null> {
  return repository.readCached(
    'git-path',
    [pathPart],
    async () => {
      const result = await repository.git(['rev-parse', '--git-path', pathPart], { signal })
      if (!result.success || !result.stdout.trim()) return null
      const rawPath = result.stdout.trim()
      const platformPath = pathForHost(repository.host)
      if (platformPath.isAbsolute(rawPath)) return normalizePath(rawPath)
      if (rawPath.startsWith('.git/') || rawPath.startsWith('.git\\')) {
        return normalizePath(platformPath.join(repository.root, rawPath))
      }
      const gitDirectory = await resolveGitDirectory(repository, signal)
      return gitDirectory ? normalizePath(platformPath.join(gitDirectory, rawPath)) : null
    },
    { staleTime: permanentGitReadCacheMs }
  )
}

const sharedIndexByWorktree = new WeakMap<
  WorktreeRepository,
  { indexPath: string; fingerprint: string; sharedIndexPath: string | null }
>()

async function resolveTemporaryIndexPaths(
  repository: WorktreeRepository,
  signal?: AbortSignal
): Promise<TemporaryIndexPaths | null> {
  const indexPath = await resolveGitPath(repository, 'index', signal)
  if (!indexPath) return null
  return { indexPath, sharedIndexPath: await resolveSharedIndexPath(repository, indexPath, signal) }
}

async function resolveSharedIndexPath(
  repository: WorktreeRepository,
  indexPath: string,
  signal?: AbortSignal
): Promise<string | null> {
  const fingerprint = await fingerprintIndex(repository.host, indexPath, signal)
  const previous = sharedIndexByWorktree.get(repository)
  if (fingerprint && previous?.indexPath === indexPath && previous.fingerprint === fingerprint) {
    return previous.sharedIndexPath
  }

  const result = await repository.git(['rev-parse', '--shared-index-path'], { signal })
  const sharedIndexPath =
    result.success && result.stdout.trim()
      ? resolveHostPath(repository.host, repository.root, result.stdout.trim())
      : null
  if (fingerprint) {
    sharedIndexByWorktree.set(repository, { indexPath, fingerprint, sharedIndexPath })
  }
  return sharedIndexPath
}

async function fingerprintIndex(
  host: GitHost,
  indexPath: string,
  signal?: AbortSignal
): Promise<string | null> {
  const stat = await host.statFile?.(indexPath, { signal })
  if (!stat) return null
  return [stat.size ?? 0, stat.mtimeMs ?? 0, stat.ctimeMs ?? 0, stat.ino ?? 0].join(':')
}

async function copyTemporaryIndexFiles(
  directory: string,
  paths: TemporaryIndexPaths,
  host: GitHost,
  signal?: AbortSignal
): Promise<void> {
  const platformPath = pathForHost(host)
  await copyFileIfPresent(paths.indexPath, platformPath.join(directory, 'index'), host, signal)
  if (paths.sharedIndexPath) {
    await copyFileIfPresent(
      paths.sharedIndexPath,
      platformPath.join(directory, platformPath.basename(paths.sharedIndexPath)),
      host,
      signal
    )
  }
}

async function copyFileIfPresent(
  source: string,
  destination: string,
  host: GitHost,
  signal?: AbortSignal
): Promise<void> {
  try {
    await host.copyFile?.(source, destination, { signal })
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }
}

function resolveHostPath(host: GitHost, root: string, path: string): string {
  const platformPath = pathForHost(host)
  return normalizePath(platformPath.isAbsolute(path) ? path : platformPath.resolve(root, path))
}

function pathForHost(host: GitHost): typeof posix | typeof win32 {
  return host.platformFamily === 'windows' ? win32 : posix
}

function normalizePath(path: string): string {
  const trimmed = path.trim()
  if (/^[/\\]+$/u.test(trimmed)) return trimmed.startsWith('\\') ? '\\' : '/'
  if (/^[A-Za-z]:[\\/]$/u.test(trimmed)) return trimmed
  return trimmed.replace(/[\\/]+$/u, '')
}

function parseNulPaths(output: string): readonly string[] {
  return output.split('\0').filter(Boolean).sort()
}

function parseLsFilesStageOthersOutput(output: string): readonly string[] {
  const paths: string[] = []
  for (const entry of output.split('\0').filter(Boolean)) {
    const tabIndex = entry.indexOf('\t')
    if (tabIndex === -1) {
      paths.push(entry)
    }
  }
  return paths.sort()
}

function normalizeReliableUntrackedReconcilePaths(
  root: string,
  paths: readonly string[] | null
): readonly string[] | null {
  if (!paths || paths.length === 0 || paths.length > maxReliableUntrackedReconcilePaths) {
    return null
  }
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/+$/u, '')
  const normalized = [
    ...new Set(
      paths.map((path) => {
        const slashPath = path.replaceAll('\\', '/')
        return slashPath.startsWith(`${normalizedRoot}/`)
          ? slashPath.slice(normalizedRoot.length + 1)
          : slashPath.replace(/^\/+/u, '')
      })
    )
  ]
    .map((path) => path.replace(/\/+$/u, ''))
    .filter(Boolean)
  if (
    normalized.length === 0 ||
    normalized.length > maxReliableUntrackedReconcilePaths ||
    normalized.some((path) => path === '.gitignore' || path.endsWith('/.gitignore'))
  ) {
    return null
  }
  return normalized
}

function pathIntersects(existingPath: string, changedPath: string): boolean {
  return (
    existingPath === changedPath ||
    existingPath.startsWith(`${changedPath}/`) ||
    changedPath.startsWith(`${existingPath}/`)
  )
}

function isNotGitRepositoryError(stderr: string): boolean {
  const normalized = stderr.toLowerCase()
  return (
    normalized.includes('not a git repository') ||
    normalized.includes('invalid gitfile format') ||
    normalized.includes('no path in gitfile') ||
    normalized.includes('invalid gitdir')
  )
}

function isPermissionCwdReadError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('unable to read current working directory') &&
    (message.includes('operation not permitted') || message.includes('permission denied'))
  )
}

function isMissingPathError(error: unknown): boolean {
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|No such file or directory|Not a directory/u.test(message)
}

function isGitReadInvalidationReason(reason: string): reason is GitReadInvalidationReason {
  return ['config', 'head', 'index', 'remote-refs', 'working-tree'].includes(reason)
}

function combineSignals(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([primary, secondary])

  const controller = new AbortController()
  const abort = (): void => controller.abort()
  if (primary.aborted || secondary.aborted) {
    controller.abort()
    return controller.signal
  }
  primary.addEventListener('abort', abort, { once: true })
  secondary.addEventListener('abort', abort, { once: true })
  return controller.signal
}
