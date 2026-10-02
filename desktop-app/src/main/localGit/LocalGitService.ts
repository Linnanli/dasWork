import { createHash, randomUUID } from 'node:crypto'
import { posix, relative, resolve, win32 } from 'node:path'

import type { TurnDiffStoreLookup } from '../conversations/TurnDiffStore'
import type { ProjectService } from '../projects/ProjectService'
import {
  LOCAL_GIT_PATCH_MAX_CHARACTERS,
  LOCAL_GIT_REVIEW_SEARCH_MAX_RESULTS,
  LOCAL_GIT_TURN_PATCH_MAX_BATCHES
} from '../../shared/localGitApi'
import { applyGitPatch } from './applyPatch'
import { isGitCliError, runCachedGitRead, runGit } from './gitCli'
import { GitManager, GitReviewSnapshotStaleError, type WorktreeRepository } from './GitManager'
import { GitHostRegistry } from './GitHostRegistry'
import {
  GitRepositoryTargetResolver,
  type ResolvedGitRepository
} from './GitRepositoryTargetResolver'
import {
  computeFileRevision,
  computeWorkspaceStateHash,
  createReviewSnapshot,
  getDiffForSource,
  getSearchDiffForSource,
  InMemorySnapshotGenerationStore,
  listReviewFiles,
  type SnapshotGenerationRecord,
  type SnapshotGenerationStore
} from './reviewSnapshot'
import {
  readReviewDiffFileContents,
  readReviewFileContent,
  readReviewTurnDiffFileContents
} from './reviewFileContent'
import {
  assertSafeRepoRelativePath,
  extractFilePatch,
  extractHunkPatch,
  validateGitPatch
} from './reviewPatch'
import type {
  LocalGitFileDiffResult,
  LocalGitMutationResult,
  LocalGitCommitSummary,
  LocalGitRefreshReviewFilesRequest,
  LocalGitMergeBase,
  LocalGitReviewFile,
  LocalGitGetReviewApplyCommandRequest,
  LocalGitGetReviewFileContentRequest,
  LocalGitGetReviewDiffFileContentsRequest,
  LocalGitGetTurnDiffFileContentsRequest,
  LocalGitReviewApplyCommand,
  LocalGitReviewFileContent,
  LocalGitReviewDiffFileContents,
  LocalGitReviewFilesRefresh,
  LocalGitReviewMutationRequest,
  LocalGitReviewSearchResult,
  LocalGitReviewSnapshot,
  LocalGitReviewSource,
  LocalGitSearchReviewRequest,
  LocalGitSummary,
  LocalGitTarget,
  TurnPatchRequest
} from './types'
import type { LocalGitWatchState } from './LocalGitWatchBroker'
const maxTurnPatchBytes = LOCAL_GIT_PATCH_MAX_CHARACTERS

export class LocalGitService {
  private readonly snapshots: SnapshotGenerationStore
  private readonly targetResolver: GitRepositoryTargetResolver
  private readonly turnDiffStore: TurnDiffStoreLookup | undefined
  private readonly reviewGenerations = new Map<string, { hostId: string; generation: number }>()

  constructor(options: {
    projectService?: ProjectService
    targetResolver?: GitRepositoryTargetResolver
    snapshots?: SnapshotGenerationStore
    turnDiffStore?: TurnDiffStoreLookup
  }) {
    this.snapshots = options.snapshots ?? new InMemorySnapshotGenerationStore()
    this.turnDiffStore = options.turnDiffStore
    if (options.targetResolver) {
      this.targetResolver = options.targetResolver
    } else if (options.projectService) {
      this.targetResolver = new GitRepositoryTargetResolver({
        projectService: options.projectService,
        gitManager: new GitManager(),
        hosts: new GitHostRegistry()
      })
    } else {
      throw new Error('LocalGitService requires a Git repository target resolver')
    }
  }

  async getSummary(target: LocalGitTarget): Promise<LocalGitSummary> {
    const snapshotGeneration = randomUUID()
    try {
      const { repository } = await this.resolveTrustedRepository(target)
      const gitRoot = repository.root
      const [staged, unstaged, untracked, stats, branch, stateHash] = await Promise.all([
        countLines(repository, 'summary-staged-count', ['diff', '--cached', '--name-only']),
        countLines(repository, 'summary-unstaged-count', ['diff', '--name-only']),
        countUntracked(repository),
        combinedNumstat(repository),
        runCachedGitRead(
          repository,
          'summary-branch',
          [],
          ['branch', '--show-current'],
          {},
          { staleTime: Infinity, metadata: { gitReadInvalidation: ['head'] } }
        ).then((result) => result.stdout.trim() || null),
        computeWorkspaceStateHash(repository)
      ])
      this.snapshots.rememberState(snapshotGeneration, gitRoot, stateHash)
      return {
        snapshotGeneration,
        gitRoot,
        stagedFileCount: staged,
        unstagedFileCount: unstaged,
        untrackedFileCount: untracked,
        additions: stats.additions,
        deletions: stats.deletions,
        branch
      }
    } catch (error) {
      return {
        snapshotGeneration,
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        additions: 0,
        deletions: 0,
        branch: null,
        unavailableReason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async getSnapshot(
    target: LocalGitTarget,
    source: LocalGitReviewSnapshot['source']
  ): Promise<LocalGitReviewSnapshot> {
    const { repository } = await this.resolveTrustedRepository(target)
    // A watcher can report the same worktree change while this first snapshot
    // is being read. Retry once against the newly-issued review snapshot so a
    // normal refresh cannot leave the review panel waiting for a stale read.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reviewSnapshot = repository.reviewSnapshot
      try {
        const { snapshot, stateHash } = await reviewSnapshot.read(() =>
          createReviewSnapshot({ repository, source })
        )
        this.snapshots.remember(snapshot, stateHash)
        this.reviewGenerations.set(snapshot.snapshotGeneration, {
          hostId: repository.host.id,
          generation: reviewSnapshot.generation
        })
        return snapshot
      } catch (error) {
        if (attempt === 0 && error instanceof GitReviewSnapshotStaleError) continue
        throw error
      }
    }

    throw new Error('Unable to create a current Git review snapshot')
  }

  async refreshReviewFiles(
    input: LocalGitRefreshReviewFilesRequest
  ): Promise<LocalGitReviewFilesRefresh> {
    if (input.source.type === 'last-turn') throw new Error('last-turn files cannot be refreshed')
    const { repository } = await this.resolveTrustedRepository(input.target)
    const record = this.snapshots.get(input.snapshotGeneration)
    if (
      !record ||
      record.gitRoot !== repository.root ||
      !sameReviewSource(record.source, input.source)
    ) {
      throw new Error('stale-snapshot')
    }

    repository.clearShortLivedGitReadCaches()
    const reviewSnapshot = repository.reviewSnapshot
    const files = await reviewSnapshot.read(() =>
      listReviewFiles(repository, input.source, input.paths)
    )
    const refreshedFiles = mergeRefreshedReviewFiles(record.files, input.paths, files)
    const refreshedSnapshot: LocalGitReviewSnapshot = {
      snapshotGeneration: randomUUID(),
      gitRoot: repository.root,
      source: input.source,
      files: refreshedFiles,
      stagedFileCount: record.stagedFileCount,
      unstagedFileCount: record.unstagedFileCount,
      largeDiff: record.largeDiff && refreshedFiles.length > 0
    }
    this.snapshots.remember(refreshedSnapshot, record.stateHash)
    this.reviewGenerations.set(refreshedSnapshot.snapshotGeneration, {
      hostId: repository.host.id,
      generation: reviewSnapshot.generation
    })
    return { snapshotGeneration: refreshedSnapshot.snapshotGeneration, files }
  }

  async listCommits(target: LocalGitTarget, limit = 30): Promise<LocalGitCommitSummary[]> {
    const { repository } = await this.resolveTrustedRepository(target)
    const output = (
      await runCachedGitRead(
        repository,
        'commit-list',
        [String(limit)],
        ['log', `--max-count=${String(limit)}`, '--format=%H%x00%s%x00%ct%x00'],
        {},
        { staleTime: Infinity, metadata: { gitReadInvalidation: ['head'] } }
      )
    ).stdout
    const values = output.split('\0').filter(Boolean)
    const commits: LocalGitCommitSummary[] = []
    for (let index = 0; index + 2 < values.length; index += 3) {
      const sha = values[index]
      const subject = values[index + 1]
      const committedAt = Number(values[index + 2])
      if (!sha || !subject || !Number.isSafeInteger(committedAt)) continue
      commits.push({ sha, subject, committedAt })
    }
    return commits
  }

  async resolveMergeBase(target: LocalGitTarget, baseBranch: string): Promise<LocalGitMergeBase> {
    const { repository } = await this.resolveTrustedRepository(target)
    const mergeBase = (
      await runCachedGitRead(
        repository,
        'merge-base',
        [baseBranch],
        ['merge-base', baseBranch, 'HEAD'],
        {},
        { staleTime: Infinity, metadata: { gitReadInvalidation: ['head', 'remote-refs'] } }
      )
    ).stdout.trim()
    if (!/^[a-f0-9]{7,64}$/iu.test(mergeBase)) {
      throw new Error('Unable to resolve a merge base for the selected branch')
    }
    return { baseBranch, mergeBase }
  }

  async getFileDiff(input: {
    target: LocalGitTarget
    source: LocalGitReviewSnapshot['source']
    snapshotGeneration: string
    file: { path: string; previousPath?: string; revision: string }
    options?: { ignoreWhitespace: boolean; fullFiles: boolean }
  }): Promise<LocalGitFileDiffResult> {
    const { repository } = await this.resolveTrustedRepository(input.target)
    const context = this.findReviewContext(
      {
        snapshotGeneration: input.snapshotGeneration,
        source: input.source
      },
      repository
    )
    if (!context) return { status: 'stale' }
    const { record, reviewSnapshot } = context
    const file = record.files.get(input.file.path)
    if (!file || file.revision !== input.file.revision) return { status: 'stale' }
    try {
      const { currentRevision, diff } = await reviewSnapshot.read(async () => ({
        currentRevision: await computeFileRevision({
          gitRoot: repository,
          source: input.source,
          path: input.file.path
        }),
        diff: await getDiffForSource({
          gitRoot: repository,
          source: input.source,
          path: input.file.path,
          options: input.options
        })
      }))
      if (currentRevision !== input.file.revision) return { status: 'stale' }
      const truncated = diff.length > LOCAL_GIT_PATCH_MAX_CHARACTERS
      return {
        status: 'ready',
        snapshotGeneration: input.snapshotGeneration,
        file,
        diff: truncated ? diff.slice(0, LOCAL_GIT_PATCH_MAX_CHARACTERS) : diff,
        truncated,
        binary: file.binary,
        conflicted: file.conflicted
      }
    } catch (error) {
      if (error instanceof GitReviewSnapshotStaleError) return { status: 'stale' }
      throw error
    }
  }

  async getReviewApplyCommand(
    input: LocalGitGetReviewApplyCommandRequest
  ): Promise<LocalGitReviewApplyCommand> {
    if (input.source.type === 'last-turn') {
      throw new Error('上一轮没有可验证的完整 Git patch。')
    }
    const { repository } = await this.resolveTrustedRepository(input.target)
    const { reviewSnapshot } = this.resolveReviewContext(
      {
        snapshotGeneration: input.snapshotGeneration,
        source: input.source
      },
      repository
    )
    const patch = await reviewSnapshot.read(() =>
      getDiffForSource({ gitRoot: repository, source: input.source })
    )
    if (!patch.trim()) throw new Error('当前来源没有可导出的 patch。')
    if (patch.length > LOCAL_GIT_PATCH_MAX_CHARACTERS) {
      throw new Error('完整 patch 超出安全导出上限。')
    }
    validateGitPatch(patch)
    return {
      snapshotGeneration: input.snapshotGeneration,
      source: input.source,
      command: reviewApplyCommand(patch)
    }
  }

  async searchReview(input: LocalGitSearchReviewRequest): Promise<LocalGitReviewSearchResult> {
    const query = input.query.trim()
    if (!query) return emptyReviewSearchResult(input)
    const { repository } = await this.resolveTrustedRepository(input.target)
    const { record, reviewSnapshot } = this.resolveReviewContext(
      {
        snapshotGeneration: input.snapshotGeneration,
        source: input.source
      },
      repository
    )
    const searchablePaths = new Set(
      [...record.files.values()]
        .filter((file) => !file.binary && !isGeneratedReviewPath(file.path))
        .map((file) => file.path)
    )
    const diff = await reviewSnapshot.read(() =>
      getSearchDiffForSource({ gitRoot: repository, source: input.source })
    )
    return searchReviewDiff(diff, query, searchablePaths, input)
  }

  async getReviewFileContent(
    input: LocalGitGetReviewFileContentRequest
  ): Promise<LocalGitReviewFileContent> {
    if (input.source.type === 'last-turn') {
      return { status: 'unsupported', reason: '上一轮没有可验证的文件内容。' }
    }
    const source = input.source
    const { repository } = await this.resolveTrustedRepository(input.target)
    const context = this.findReviewContext(
      {
        snapshotGeneration: input.snapshotGeneration,
        source: input.source
      },
      repository
    )
    if (!context) return { status: 'stale' }
    const { record, reviewSnapshot } = context
    const file = record.files.get(input.file.path)
    if (!file || file.revision !== input.file.revision) {
      return { status: 'stale' }
    }
    try {
      return await reviewSnapshot.read(async () => {
        const currentRevision = await computeFileRevision({
          gitRoot: repository,
          source,
          path: file.path
        })
        if (currentRevision !== file.revision) return { status: 'stale' }
        return readReviewFileContent({ repository, source, file, side: input.side })
      })
    } catch (error) {
      if (error instanceof GitReviewSnapshotStaleError) {
        return { status: 'stale' }
      }
      throw error
    }
  }

  async getReviewDiffFileContents(
    input: LocalGitGetReviewDiffFileContentsRequest
  ): Promise<LocalGitReviewDiffFileContents> {
    if (input.source.type === 'last-turn') {
      return { status: 'unsupported', reason: '上一轮没有可验证的完整文件内容。' }
    }
    const source = input.source
    const { repository } = await this.resolveTrustedRepository(input.target)
    const context = this.findReviewContext(
      {
        snapshotGeneration: input.snapshotGeneration,
        source: input.source
      },
      repository
    )
    if (!context) return { status: 'stale' }
    const { record, reviewSnapshot } = context
    const file = record.files.get(input.file.path)
    if (!file || file.revision !== input.file.revision) {
      return { status: 'stale' }
    }
    try {
      return await reviewSnapshot.read(async () => {
        const currentRevision = await computeFileRevision({
          gitRoot: repository,
          source,
          path: file.path
        })
        if (currentRevision !== file.revision) return { status: 'stale' }
        return readReviewDiffFileContents({ repository, source, file })
      })
    } catch (error) {
      if (error instanceof GitReviewSnapshotStaleError) {
        return { status: 'stale' }
      }
      throw error
    }
  }

  async getTurnDiffFileContents(
    input: LocalGitGetTurnDiffFileContentsRequest
  ): Promise<LocalGitReviewDiffFileContents> {
    const { repository, target } = await this.resolveTrustedRepository(input.target)
    const threadId = target.threadId
    if (!this.turnDiffStore || !threadId) {
      return { status: 'unsupported', reason: '无法验证上一轮差异所属的任务。' }
    }

    const turnDiff = await this.turnDiffStore.read(threadId, input.turnId)
    if (turnDiff === undefined) {
      return { status: 'unsupported', reason: '找不到可信的上一轮差异。' }
    }

    let fileDiff: string
    try {
      fileDiff = extractFilePatch(turnDiff, input.path)
    } catch {
      return { status: 'unsupported', reason: '上一轮差异中没有这个文件。' }
    }
    return readReviewTurnDiffFileContents({ repository, path: input.path, diff: fileDiff })
  }

  async mutateReview(input: LocalGitReviewMutationRequest): Promise<LocalGitMutationResult> {
    if (!reviewMutationIsAllowed(input.source.type, input.action)) {
      return unsupportedReviewMutationResult()
    }
    const { repository } = await this.resolveTrustedRepository(input.target)
    const context = this.findReviewContext(
      {
        snapshotGeneration: input.snapshotGeneration,
        source: input.source
      },
      repository
    )
    if (!context) return staleSnapshotResult()
    const { record } = context
    if (!hasExactSnapshotTargets(record, input)) return staleSnapshotResult()
    // A review snapshot can reuse its reads while it is rendered, but a write
    // must compare against the filesystem again immediately before applying.
    repository.clearShortLivedGitReadCaches()
    for (const file of input.files) {
      assertSafeRepoRelativePath(file.path)
      const currentRevision = await computeFileRevision({
        gitRoot: repository,
        source: input.source,
        path: file.path
      })
      if (currentRevision !== file.revision) return staleSnapshotResult()
    }

    const patch = await this.patchForMutation(repository, input)
    if (!patch) return emptyTurnPatchError('patch-too-large')
    const affectedPaths = validateGitPatch(patch).map((entry) => entry.path)
    if (affectedPaths.length === 0) {
      return { status: 'success', appliedPaths: [], skippedPaths: [], conflictedPaths: [] }
    }

    if (input.action === 'stage') {
      return this.applyReviewPatch(repository, { patch, cached: true })
    }
    if (input.action === 'unstage') {
      return this.applyReviewPatch(repository, { patch, reverse: true, cached: true })
    }

    if (input.source.type === 'staged' || input.patchTarget === 'staged-and-unstaged') {
      const indexResult = await applyGitPatch({
        repository,
        patch,
        reverse: true,
        cached: true
      })
      if (indexResult.status !== 'success') return indexResult
      const worktreeResult = await applyGitPatch({ repository, patch, reverse: true })
      if (worktreeResult.status === 'success') {
        repository.invalidateGitReadCachesForMutation()
        repository.invalidateUntrackedPathsCache()
        return worktreeResult
      }
      repository.invalidateGitReadCachesForMutation()
      repository.invalidateUntrackedPathsCache()
      return {
        status: 'partial-success',
        errorCode: worktreeResult.errorCode,
        appliedPaths: indexResult.appliedPaths,
        skippedPaths: [],
        conflictedPaths: worktreeResult.conflictedPaths
      }
    }

    return this.applyReviewPatch(repository, { patch, reverse: true })
  }

  async applyTurnPatch(input: TurnPatchRequest): Promise<LocalGitMutationResult> {
    if (input.batches.length > LOCAL_GIT_TURN_PATCH_MAX_BATCHES) {
      return emptyTurnPatchError('too-many-patch-batches')
    }
    if (input.batches.some((batch) => turnPatchBatchBytes(batch) > maxTurnPatchBytes)) {
      return emptyTurnPatchError('patch-too-large')
    }
    if (
      input.batches.reduce((total, batch) => total + turnPatchBatchBytes(batch), 0) >
      maxTurnPatchBytes
    ) {
      return emptyTurnPatchError('patch-too-large')
    }

    const { repository } = await this.resolveTrustedRepository(input.target)
    const validatedBatches = await Promise.all(
      input.batches.map(async (batch) => {
        validateGitPatch(batch.diff)
        const target = await this.resolveTrustedTurnRepository(repository, batch.cwd, batch.gitRoot)
        return { ...target, diff: batch.diff }
      })
    )
    const orderedBatches =
      input.action === 'undo' ? [...validatedBatches].reverse() : validatedBatches
    const aggregate: LocalGitMutationResult = {
      status: 'success',
      appliedPaths: [],
      skippedPaths: [],
      conflictedPaths: []
    }

    for (const batch of orderedBatches) {
      const result = await applyGitPatch({
        repository: batch.repository,
        cwd: batch.cwd,
        directory: batch.directory,
        patch: batch.diff,
        reverse: input.action === 'undo'
      })
      if (result.status === 'success') {
        batch.repository.invalidateGitReadCachesForMutation()
        batch.repository.invalidateUntrackedPathsCache()
      }
      aggregate.appliedPaths.push(...result.appliedPaths)
      aggregate.skippedPaths.push(...result.skippedPaths)
      aggregate.conflictedPaths.push(...result.conflictedPaths)
      if (result.status !== 'success')
        return { ...aggregate, status: result.status, errorCode: result.errorCode }
    }

    return aggregate
  }

  async getWatchState(target: LocalGitTarget): Promise<LocalGitWatchState> {
    const { repository } = await this.resolveTrustedRepository(target)
    const gitRoot = repository.root
    const [config, head, index, remoteRefs, branchStatus, worktreeTopology, worktreeDiff] =
      await Promise.all([
        readWatchOutput(repository, ['config', '--local', '--list', '--show-origin']),
        readWatchOutput(repository, ['rev-parse', 'HEAD']),
        readWatchOutput(repository, ['diff', '--cached', '--raw', '-z']),
        readWatchOutput(repository, [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)',
          'refs/remotes'
        ]),
        readWatchOutput(repository, ['status', '--branch', '--porcelain=v1', '-z']),
        readWatchOutput(repository, ['worktree', 'list', '--porcelain']),
        readWatchOutput(repository, ['diff', '--raw', '-z'])
      ])
    const { branch: syncedBranch, status } = splitBranchStatus(branchStatus)
    const stateHash = sha256(
      [untrackedPathsFromPorcelain(status).join('\0'), worktreeDiff, index, head].join('\0')
    )
    const snapshotGeneration = randomUUID()
    this.snapshots.rememberState(snapshotGeneration, gitRoot, stateHash)
    return {
      snapshotGeneration,
      fingerprint: {
        config: sha256(config),
        head: head.trim(),
        index: sha256(index),
        remoteRefs: sha256(remoteRefs),
        syncedBranch: sha256(syncedBranch),
        worktreeTopology: sha256(worktreeTopology),
        worktree: sha256([worktreeDiff, status].join('\0'))
      },
      workingTreePaths: pathsFromPorcelain(status)
    }
  }

  async resolveTrustedGitRoot(target: LocalGitTarget): Promise<string> {
    return (await this.resolveTrustedRepository(target)).repository.root
  }

  resolveTrustedRepository(target: LocalGitTarget): Promise<ResolvedGitRepository> {
    return this.targetResolver.assertRepository(target)
  }

  private async patchForMutation(
    repository: WorktreeRepository,
    input: LocalGitReviewMutationRequest
  ): Promise<string | undefined> {
    if (input.source.type === 'last-turn') {
      throw new Error('last-turn review mutations must use turn patch actions')
    }
    const patches: string[] = []
    let patchBytes = 0
    for (const file of input.files) {
      const sourcePatch = await getDiffForSource({
        gitRoot: repository,
        source: input.source,
        path: file.path
      })
      const patch =
        input.scope === 'section' || input.scope === 'file'
          ? extractFilePatch(sourcePatch, file.path)
          : extractHunkPatch(sourcePatch, file.path, input.hunkIndex ?? 0)
      patchBytes += Buffer.byteLength(patch)
      if (patchBytes > maxTurnPatchBytes) return undefined
      patches.push(patch)
    }
    return patches.join('\n')
  }

  private async resolveTrustedTurnRepository(
    repository: WorktreeRepository,
    cwd: string,
    assertedGitRoot?: string
  ): Promise<{ repository: WorktreeRepository; cwd: string; directory?: string }> {
    if (!isAbsolutePath(repository, cwd) || !isSameOrInside(repository, cwd, repository.root)) {
      throw new Error('turn patch cwd must stay inside the trusted repository')
    }
    if (assertedGitRoot && !samePath(repository, assertedGitRoot, repository.root)) {
      throw new Error('turn patch git root does not match trusted repository')
    }
    const gitRoot = await repository.host.runGit(['rev-parse', '--show-toplevel'], cwd)
    if (!gitRoot.success || !samePath(repository, gitRoot.stdout.trim(), repository.root)) {
      throw new Error('turn patch cwd git root does not match trusted repository')
    }
    const directory = repositoryRelativePath(repository, cwd)
    return { repository, cwd, ...(directory ? { directory } : {}) }
  }

  private async applyReviewPatch(
    repository: WorktreeRepository,
    options: { patch: string; reverse?: boolean; cached?: boolean }
  ): Promise<LocalGitMutationResult> {
    const result = await applyGitPatch({ repository, ...options })
    if (result.status === 'success' || result.status === 'partial-success') {
      repository.invalidateGitReadCachesForMutation()
      repository.invalidateUntrackedPathsCache()
    }
    return result
  }

  private resolveReviewContext(
    input: {
      snapshotGeneration: string
      source: LocalGitReviewSource
    },
    repository: WorktreeRepository
  ): {
    record: SnapshotGenerationRecord
    reviewSnapshot: ReturnType<WorktreeRepository['requireReviewSnapshot']>
  } {
    const context = this.findReviewContext(input, repository)
    if (!context) throw new Error('stale-snapshot')
    return context
  }

  private findReviewContext(
    input: {
      snapshotGeneration: string
      source: LocalGitReviewSource
    },
    repository: WorktreeRepository
  ):
    | {
        record: SnapshotGenerationRecord
        reviewSnapshot: ReturnType<WorktreeRepository['requireReviewSnapshot']>
      }
    | undefined {
    const record = this.snapshots.get(input.snapshotGeneration)
    const reviewGeneration = this.reviewGenerations.get(input.snapshotGeneration)
    const reviewSnapshot = repository.reviewSnapshot
    if (
      !record ||
      record.gitRoot !== repository.root ||
      !reviewGeneration ||
      reviewGeneration.hostId !== repository.host.id ||
      reviewGeneration.generation !== reviewSnapshot.generation ||
      !sameReviewSource(record.source, input.source)
    ) {
      return undefined
    }
    return { record, reviewSnapshot }
  }
}

function mergeRefreshedReviewFiles(
  previousFiles: ReadonlyMap<string, LocalGitReviewFile>,
  refreshedPaths: readonly string[],
  refreshedFiles: readonly LocalGitReviewFile[]
): LocalGitReviewFile[] {
  const paths = new Set(refreshedPaths)
  const nextFiles = new Map(previousFiles)
  for (const [path, file] of nextFiles) {
    if (paths.has(path) || (file.previousPath !== undefined && paths.has(file.previousPath))) {
      nextFiles.delete(path)
    }
  }
  for (const file of refreshedFiles) {
    if (file.previousPath !== undefined) nextFiles.delete(file.previousPath)
    nextFiles.set(file.path, file)
  }
  return [...nextFiles.values()].sort((left, right) => left.path.localeCompare(right.path))
}

function emptyReviewSearchResult(
  input: Pick<LocalGitSearchReviewRequest, 'snapshotGeneration' | 'source'>
): LocalGitReviewSearchResult {
  return {
    snapshotGeneration: input.snapshotGeneration,
    source: input.source,
    items: [],
    totalMatches: 0,
    isCapped: false
  }
}

function searchReviewDiff(
  diff: string,
  query: string,
  searchablePaths: ReadonlySet<string>,
  identity: Pick<LocalGitSearchReviewRequest, 'snapshotGeneration' | 'source'>
): LocalGitReviewSearchResult {
  const normalizedQuery = query.toLocaleLowerCase()
  const items: LocalGitReviewSearchResult['items'] = []
  let totalMatches = 0
  let currentPath: string | undefined
  let currentHunk: SearchHunk | undefined
  let nextDeletionLine = 0
  let nextAdditionLine = 0
  let patchOffset = 0
  let pathMatchEmitted = false

  for (const line of diff.split(/\r?\n/u)) {
    const linePatchOffset = patchOffset
    patchOffset += line.length + 1
    const diffPath = parseDiffGitPath(line)
    if (diffPath) {
      currentPath = diffPath
      currentHunk = undefined
      pathMatchEmitted = false
      if (
        searchablePaths.has(currentPath) &&
        currentPath.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        totalMatches = pushReviewSearchItem(items, totalMatches, {
          path: currentPath,
          hunkId: 'path',
          side: 'additions',
          lineStart: 0,
          lineEnd: 0,
          patchOffset: linePatchOffset,
          snippet: { before: '', match: currentPath.slice(0, 1_000), after: '' }
        })
        pathMatchEmitted = true
      }
      continue
    }
    const nextPath = parseDiffNewPath(line)
    if (nextPath) {
      currentPath = nextPath
      if (
        !pathMatchEmitted &&
        searchablePaths.has(currentPath) &&
        currentPath.toLocaleLowerCase().includes(normalizedQuery)
      ) {
        totalMatches = pushReviewSearchItem(items, totalMatches, {
          path: currentPath,
          hunkId: 'path',
          side: 'additions',
          lineStart: 0,
          lineEnd: 0,
          patchOffset: linePatchOffset,
          snippet: { before: '', match: currentPath.slice(0, 1_000), after: '' }
        })
        pathMatchEmitted = true
      }
      continue
    }
    if (line.startsWith('@@')) {
      currentHunk = { header: line, lines: [] }
      const starts = parseHunkStarts(line)
      nextDeletionLine = starts.deletions
      nextAdditionLine = starts.additions
      continue
    }
    if (!currentPath || !currentHunk || !searchablePaths.has(currentPath)) {
      continue
    }
    if (!line.startsWith('-') && !line.startsWith('+') && !line.startsWith(' ')) continue
    const side = line.startsWith('-') ? 'deletions' : 'additions'
    const lineStart = side === 'deletions' ? nextDeletionLine : nextAdditionLine
    const lineEnd = lineStart
    currentHunk.lines.push({ text: line, lineStart, lineEnd, patchOffset: linePatchOffset })
    if (line.toLocaleLowerCase().includes(normalizedQuery)) {
      totalMatches = pushReviewSearchItem(items, totalMatches, {
        path: currentPath,
        hunkId: currentHunk.header.slice(0, 2_000),
        side,
        lineStart,
        lineEnd,
        patchOffset: linePatchOffset,
        snippet: createReviewSearchSnippet(currentHunk.lines, currentHunk.lines.length - 1)
      })
    }
    if (!line.startsWith('+')) nextDeletionLine += 1
    if (!line.startsWith('-')) nextAdditionLine += 1
  }

  return {
    snapshotGeneration: identity.snapshotGeneration,
    source: identity.source,
    items,
    totalMatches,
    isCapped: totalMatches > LOCAL_GIT_REVIEW_SEARCH_MAX_RESULTS
  }
}

type SearchHunk = {
  header: string
  lines: SearchHunkLine[]
}

type SearchHunkLine = {
  text: string
  lineStart: number
  lineEnd: number
  patchOffset: number
}

function pushReviewSearchItem(
  items: LocalGitReviewSearchResult['items'],
  totalMatches: number,
  item: LocalGitReviewSearchResult['items'][number]
): number {
  const nextTotal = totalMatches + 1
  if (items.length < LOCAL_GIT_REVIEW_SEARCH_MAX_RESULTS) items.push(item)
  return nextTotal
}

function createReviewSearchSnippet(
  lines: readonly SearchHunkLine[],
  matchIndex: number
): LocalGitReviewSearchResult['items'][number]['snippet'] {
  const start = Math.max(0, matchIndex - 2)
  const end = Math.min(lines.length, matchIndex + 3)
  return {
    before: lines
      .slice(start, matchIndex)
      .map((line) => line.text)
      .join('\n')
      .slice(0, 1_000),
    match: (lines[matchIndex]?.text ?? '').slice(0, 1_000),
    after: lines
      .slice(matchIndex + 1, end)
      .map((line) => line.text)
      .join('\n')
      .slice(0, 1_000)
  }
}

function parseHunkStarts(header: string): { deletions: number; additions: number } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(header)
  return {
    deletions: match ? Number(match[1]) : 0,
    additions: match ? Number(match[2]) : 0
  }
}

function parseDiffGitPath(line: string): string | undefined {
  const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
  if (!match) return undefined
  return unquoteGitDiffPath(match[2])
}

function parseDiffNewPath(line: string): string | undefined {
  if (!line.startsWith('+++ b/')) return undefined
  return unquoteGitDiffPath(line.slice('+++ b/'.length))
}

function unquoteGitDiffPath(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path
}

function isGeneratedReviewPath(path: string): boolean {
  const segments = path.split('/')
  if (
    segments.some((segment) =>
      [
        '.next',
        '.nuxt',
        '.parcel-cache',
        '.svelte-kit',
        '.turbo',
        '.vite',
        'build',
        'coverage',
        'dist',
        'node_modules',
        'out',
        'target'
      ].includes(segment)
    )
  ) {
    return true
  }
  return /\.(?:bundle|chunk|min)\.(?:css|js|mjs|cjs)$/iu.test(path)
}

function sameReviewSource(
  left: LocalGitReviewSnapshot['source'],
  right: LocalGitReviewSnapshot['source']
): boolean {
  if (left.type !== right.type) return false
  if (left.type === 'commit' && right.type === 'commit') {
    return left.commitSha === right.commitSha
  }
  if (left.type === 'branch' && right.type === 'branch') {
    return left.baseBranch === right.baseBranch
  }
  if (left.type === 'last-turn' && right.type === 'last-turn') {
    return left.turnId === right.turnId
  }
  return true
}

async function countLines(
  repository: WorktreeRepository,
  cacheType: string,
  args: string[]
): Promise<number> {
  const output = (
    await runCachedGitRead(
      repository,
      cacheType,
      [],
      args,
      {},
      {
        staleTime: 10_000,
        metadata: { gitReadInvalidation: 'short-lived' }
      }
    )
  ).stdout.trim()
  return output ? output.split(/\r?\n/u).length : 0
}

async function countUntracked(repository: WorktreeRepository): Promise<number> {
  return (await repository.listUntrackedPaths()).length
}

async function combinedNumstat(
  repository: WorktreeRepository
): Promise<{ additions: number; deletions: number }> {
  const trackedOutputs = await Promise.all([
    runCachedGitRead(
      repository,
      'summary-numstat',
      ['unstaged'],
      ['diff', '--numstat'],
      {},
      {
        staleTime: 10_000,
        metadata: { gitReadInvalidation: 'short-lived' }
      }
    ).then((result) => result.stdout),
    runCachedGitRead(
      repository,
      'summary-numstat',
      ['staged'],
      ['diff', '--cached', '--numstat'],
      {},
      {
        staleTime: 10_000,
        metadata: { gitReadInvalidation: 'short-lived' }
      }
    ).then((result) => result.stdout)
  ])
  const untrackedPaths = await repository.listUntrackedPaths()
  const untrackedOutputs = await Promise.all(
    untrackedPaths.map((path) => untrackedNumstat(repository, path))
  )
  let additions = 0
  let deletions = 0
  for (const line of [...trackedOutputs, ...untrackedOutputs].join('\n').split(/\r?\n/u)) {
    const [added, deleted] = line.split(/\s+/u)
    if (!added || !deleted || added === '-' || deleted === '-') continue
    additions += Number(added)
    deletions += Number(deleted)
  }
  return { additions, deletions }
}

async function untrackedNumstat(repository: WorktreeRepository, path: string): Promise<string> {
  try {
    return (
      await runCachedGitRead(
        repository,
        'summary-untracked-numstat',
        [path],
        ['diff', '--no-index', '--numstat', '/dev/null', path],
        {},
        {
          staleTime: 10_000,
          metadata: { gitReadInvalidation: 'short-lived', gitReadPaths: [path] }
        }
      )
    ).stdout
  } catch (error) {
    if (isGitCliError(error) && error.exitCode === 1) return error.stdout
    throw error
  }
}

function isSameOrInside(repository: WorktreeRepository, candidate: string, root: string): boolean {
  const path = repositoryPathModule(repository)
  const relativePath = path
    ? path.relative(path.resolve(root), path.resolve(candidate))
    : relative(resolve(root), resolve(candidate))
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') &&
      !relativePath.startsWith('/') &&
      !relativePath.startsWith('\\'))
  )
}

function samePath(repository: WorktreeRepository, left: string, right: string): boolean {
  const path = repositoryPathModule(repository)
  const normalizedLeft = path ? path.resolve(left) : resolve(left)
  const normalizedRight = path ? path.resolve(right) : resolve(right)
  return repository.host.platformFamily === 'windows'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isAbsolutePath(repository: WorktreeRepository, value: string): boolean {
  const path = repositoryPathModule(repository)
  return path ? path.isAbsolute(value) : value.startsWith('/')
}

function repositoryRelativePath(repository: WorktreeRepository, cwd: string): string {
  const path = repositoryPathModule(repository)
  const value = path
    ? path.relative(path.resolve(repository.root), path.resolve(cwd))
    : relative(resolve(repository.root), resolve(cwd))
  return value.replaceAll('\\', '/')
}

function turnPatchBatchBytes(batch: TurnPatchRequest['batches'][number]): number {
  return (
    Buffer.byteLength(batch.cwd) +
    Buffer.byteLength(batch.gitRoot ?? '') +
    Buffer.byteLength(batch.diff)
  )
}

function emptyTurnPatchError(errorCode: string): LocalGitMutationResult {
  return {
    status: 'error',
    errorCode,
    appliedPaths: [],
    skippedPaths: [],
    conflictedPaths: []
  }
}

function repositoryPathModule(repository: WorktreeRepository): typeof win32 | typeof posix | null {
  if (repository.host.platformFamily === 'windows') return win32
  if (!repository.host.isLocal) return posix
  return null
}

async function readWatchOutput(
  repository: WorktreeRepository,
  args: readonly string[]
): Promise<string> {
  try {
    return (await runGit(repository, args, { priority: 'background' })).stdout
  } catch {
    // Some repositories have no HEAD, upstream, or remotes. A missing optional
    // fingerprint is still a stable observable state for the watcher.
    return ''
  }
}

function pathsFromPorcelain(output: string): string[] {
  const fields = output.split('\0').filter(Boolean)
  const paths = new Set<string>()
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]
    const path = entry.slice(3)
    if (path) paths.add(path)
    // A rename/copy has an additional NUL-separated old path. Record its
    // parent too, so a directory-scoped cached read is invalidated correctly.
    if ((entry.startsWith('R') || entry.startsWith('C')) && fields[index + 1]) {
      paths.add(fields[index + 1])
      index += 1
    }
  }
  return [...paths]
}

function splitBranchStatus(output: string): { branch: string; status: string } {
  const separator = output.indexOf('\0')
  if (separator < 0) return { branch: output, status: '' }
  return {
    branch: output.slice(0, separator),
    status: output.slice(separator + 1)
  }
}

function untrackedPathsFromPorcelain(output: string): string[] {
  return output
    .split('\0')
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
}

function staleSnapshotResult(): LocalGitMutationResult {
  return {
    status: 'error',
    errorCode: 'stale-snapshot',
    appliedPaths: [],
    skippedPaths: [],
    conflictedPaths: []
  }
}

function hasExactSnapshotTargets(
  record: SnapshotGenerationRecord,
  input: LocalGitReviewMutationRequest
): boolean {
  if (input.scope === 'section') {
    if (input.files.length !== record.files.size) return false
  } else if (input.files.length !== 1) {
    return false
  }

  if (input.scope === 'hunk' ? input.hunkIndex === undefined : input.hunkIndex !== undefined) {
    return false
  }

  const requestedPaths = new Set<string>()
  for (const target of input.files) {
    if (requestedPaths.has(target.path)) return false
    requestedPaths.add(target.path)

    const signedFile = record.files.get(target.path)
    if (
      !signedFile ||
      signedFile.previousPath !== target.previousPath ||
      signedFile.revision !== target.revision
    ) {
      return false
    }
  }

  return input.scope !== 'section' || requestedPaths.size === record.files.size
}

function reviewMutationIsAllowed(
  sourceType: LocalGitReviewMutationRequest['source']['type'],
  action: LocalGitReviewMutationRequest['action']
): boolean {
  if (sourceType === 'unstaged') return action === 'stage' || action === 'revert'
  if (sourceType === 'staged') return action === 'unstage' || action === 'revert'
  return false
}

function unsupportedReviewMutationResult(): LocalGitMutationResult {
  return {
    status: 'error',
    errorCode: 'unsupported-review-source-action',
    appliedPaths: [],
    skippedPaths: [],
    conflictedPaths: []
  }
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function reviewApplyCommand(patch: string): string {
  let delimiter = `CODEX_REVIEW_PATCH_${sha256(patch).slice(0, 16).toUpperCase()}`
  while (patch.split(/\r?\n/u).includes(delimiter)) delimiter += '_X'
  const normalizedPatch = patch.endsWith('\n') ? patch : `${patch}\n`
  return `git apply --whitespace=nowarn - <<'${delimiter}'\n${normalizedPatch}${delimiter}`
}
