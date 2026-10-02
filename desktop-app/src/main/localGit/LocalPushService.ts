import { isGitCliError, runGit } from './gitCli'
import type { WorktreeRepository } from './GitManager'
import type { LocalGitService } from './LocalGitService'
import type {
  LocalGitPublishStatus,
  LocalGitPushBlockedReason,
  LocalGitSelectionSummary,
  LocalGitTarget,
  LocalPushResult
} from './types'

const PUSH_TIMEOUT_MS = 45_000
const PUSH_OUTPUT_MAX_BYTES = 64 * 1024
const EMPTY_SELECTION: LocalGitSelectionSummary = { fileCount: 0, additions: 0, deletions: 0 }

type RepositoryPublishState = LocalGitPublishStatus & {
  branch: string | null
  selectedPushRemote: string | null
}

/**
 * Owns the fixed publish workflow. It deliberately receives no remote, refspec,
 * force, or command fields from the renderer; every value used by `git push` is
 * freshly resolved from the trusted repository immediately before execution.
 */
export class LocalPushService {
  constructor(private readonly localGit: LocalGitService) {}

  async getStatus(target: LocalGitTarget): Promise<LocalGitPublishStatus> {
    try {
      const { repository } = await this.localGit.resolveTrustedRepository(target)
      return await this.getStatusForRepository(repository)
    } catch (error) {
      return unavailableStatus(error)
    }
  }

  async push(target: LocalGitTarget): Promise<LocalPushResult> {
    let repository: WorktreeRepository
    try {
      repository = (await this.localGit.resolveTrustedRepository(target)).repository
    } catch (error) {
      return { status: 'status-unavailable', message: errorMessage(error) }
    }

    let state: RepositoryPublishState
    try {
      // Do not use the dialog's old state: all branch, remote, and ahead data is
      // read again while executing the action.
      state = await this.readStatusForRepository(repository)
    } catch (error) {
      return { status: 'status-unavailable', message: errorMessage(error) }
    }

    if (state.unavailableReason) {
      return { status: 'status-unavailable', message: state.unavailableReason }
    }
    if (!state.branch) return { status: 'branch-missing' }
    if (!state.selectedPushRemote) {
      return blockedPushResult(state.pushBlockedReason ?? 'remote-missing')
    }
    if (state.commitsAhead === 0) return { status: 'nothing-to-push' }

    const upstreamRemoteRef = state.upstreamRemoteRef ?? `refs/heads/${state.branch}`
    const isFirstPush = !state.upstreamRemote || !state.upstreamRemoteRef
    const args = isFirstPush
      ? ['push', '--set-upstream', state.selectedPushRemote, `HEAD:${upstreamRemoteRef}`]
      : ['push', state.selectedPushRemote, `HEAD:${upstreamRemoteRef}`]

    try {
      await runGit(repository, args, {
        timeoutMs: PUSH_TIMEOUT_MS,
        maxOutputBytes: PUSH_OUTPUT_MAX_BYTES,
        // LocalGitHost already defaults this to 0. Passing it explicitly keeps
        // the non-interactive contract true for all Git hosts.
        env: { GIT_TERMINAL_PROMPT: '0' }
      })
    } catch (error) {
      return { status: 'push-failed', message: errorMessage(error) }
    }

    repository.invalidateGitReadCachesForRepoChange('config')
    repository.invalidateGitReadCachesForRepoChange('remote-refs')

    return {
      status: 'success',
      branch: state.branch,
      upstreamTrackingRef:
        state.upstreamTrackingRef ?? `refs/remotes/${state.selectedPushRemote}/${state.branch}`,
      upstreamRemote: state.selectedPushRemote,
      upstreamRemoteRef
    }
  }

  private async getStatusForRepository(
    repository: WorktreeRepository
  ): Promise<RepositoryPublishState> {
    return repository.readCached(
      'publish-status',
      [],
      () => this.readStatusForRepository(repository),
      { metadata: { gitReadInvalidation: 'short-lived' } }
    )
  }

  private async readStatusForRepository(
    repository: WorktreeRepository
  ): Promise<RepositoryPublishState> {
    const [branch, hasHead, staged, unstaged] = await Promise.all([
      currentBranch(repository),
      hasHeadCommit(repository),
      selectionSummary(repository, true),
      selectionSummary(repository, false)
    ])

    if (!branch) {
      const [remotes, pushDefault] = await Promise.all([
        remoteNames(repository),
        configValue(repository, 'remote.pushDefault')
      ])
      return {
        branch: null,
        hasHead,
        staged,
        unstaged,
        upstreamTrackingRef: null,
        upstreamRemote: null,
        upstreamRemoteRef: null,
        // This is deliberately only a prospective default for a new branch.
        // `push()` still refuses detached HEAD and reruns all resolution after
        // the branch is created, so the renderer cannot turn it into a refspec.
        selectedPushRemote: resolvePushRemote({
          remotes,
          configuredPushRemote: null,
          pushDefault,
          configuredRemote: null,
          upstreamRemote: null
        }),
        commitsAhead: 0,
        pushBlockedReason: 'branch-missing'
      }
    }

    const [remotes, configuredRemote, configuredPushRemote, pushDefault, upstream] =
      await Promise.all([
        remoteNames(repository),
        configValue(repository, `branch.${branch}.remote`),
        configValue(repository, `branch.${branch}.pushRemote`),
        configValue(repository, 'remote.pushDefault'),
        upstreamForBranch(repository, branch)
      ])
    const upstreamTrackingRef = upstream.trackingRef
    const upstreamRemote = upstream.remote
    const upstreamRemoteRef = upstream.remoteRef
    const selectedPushRemote = resolvePushRemote({
      remotes,
      configuredPushRemote,
      pushDefault,
      configuredRemote,
      upstreamRemote
    })

    let commitsAhead = 0
    if (hasHead) {
      if (upstreamTrackingRef) {
        commitsAhead = await commitCount(repository, `${upstreamTrackingRef}..HEAD`)
      } else if (selectedPushRemote) {
        const remoteBranchRef = `refs/remotes/${selectedPushRemote}/${branch}`
        const remoteBranchExists = await refExists(repository, remoteBranchRef)
        commitsAhead = remoteBranchExists
          ? await commitCount(repository, `${remoteBranchRef}..HEAD`)
          : await commitCount(repository, 'HEAD')
      }
    }

    const pushBlockedReason = resolvePushBlockedReason({
      hasHead,
      selectedPushRemote,
      remotes,
      commitsAhead
    })

    return {
      branch,
      hasHead,
      staged,
      unstaged,
      upstreamTrackingRef,
      upstreamRemote,
      upstreamRemoteRef,
      selectedPushRemote,
      commitsAhead,
      pushBlockedReason
    }
  }
}

async function currentBranch(repository: WorktreeRepository): Promise<string | null> {
  const result = await repository.git(['branch', '--show-current'])
  return result.stdout.trim() || null
}

async function hasHeadCommit(repository: WorktreeRepository): Promise<boolean> {
  const result = await repository.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  return result.success
}

async function selectionSummary(
  repository: WorktreeRepository,
  staged: boolean
): Promise<LocalGitSelectionSummary> {
  const diffArgs = staged ? ['diff', '--cached'] : ['diff']
  const [nameResult, numstatResult, untracked] = await Promise.all([
    repository.git([...diffArgs, '--name-only']),
    repository.git([...diffArgs, '--numstat']),
    staged ? Promise.resolve([]) : repository.listUntrackedPaths()
  ])
  const tracked = summaryFromOutput(nameResult.stdout, numstatResult.stdout)
  if (staged || untracked.length === 0) return tracked

  const untrackedStats = await Promise.all(
    untracked.map(async (path) => {
      const result = await repository.git(['diff', '--no-index', '--numstat', '/dev/null', path])
      // `diff --no-index` uses exit code 1 when it found a difference.
      if (!result.success && result.code !== 1) {
        throw new Error(result.stderr || `Unable to inspect untracked file: ${path}`)
      }
      return summaryFromOutput(path, result.stdout)
    })
  )
  return untrackedStats.reduce(
    (total, value) => ({
      fileCount: total.fileCount + value.fileCount,
      additions: total.additions + value.additions,
      deletions: total.deletions + value.deletions
    }),
    tracked
  )
}

function summaryFromOutput(namesOutput: string, numstatOutput: string): LocalGitSelectionSummary {
  let additions = 0
  let deletions = 0
  for (const line of numstatOutput.split(/\r?\n/u)) {
    const [added, deleted] = line.split(/\s+/u)
    if (!added || !deleted || added === '-' || deleted === '-') continue
    additions += Number(added)
    deletions += Number(deleted)
  }
  return {
    fileCount: namesOutput.split(/\r?\n/u).filter(Boolean).length,
    additions,
    deletions
  }
}

async function remoteNames(repository: WorktreeRepository): Promise<string[]> {
  const result = await repository.git(['remote'])
  return result.stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
}

async function configValue(repository: WorktreeRepository, key: string): Promise<string | null> {
  const result = await repository.git(['config', '--get', key])
  return result.success && result.stdout.trim() ? result.stdout.trim() : null
}

async function upstreamForBranch(
  repository: WorktreeRepository,
  branch: string
): Promise<{ trackingRef: string | null; remote: string | null; remoteRef: string | null }> {
  const result = await repository.git([
    'for-each-ref',
    '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
    `refs/heads/${branch}`
  ])
  const [trackingRef = '', remote = '', remoteRef = ''] = result.success
    ? result.stdout.trim().split('\0', 3)
    : []
  return {
    trackingRef: trackingRef.startsWith('refs/remotes/') ? trackingRef : null,
    remote: remote || null,
    remoteRef: remoteRef.startsWith('refs/heads/') ? remoteRef : null
  }
}

async function refExists(repository: WorktreeRepository, ref: string): Promise<boolean> {
  const result = await repository.git(['show-ref', '--verify', '--quiet', ref])
  return result.success
}

async function commitCount(repository: WorktreeRepository, revision: string): Promise<number> {
  const result = await repository.git(['rev-list', '--count', revision])
  if (!result.success) throw new Error(result.stderr || `Unable to count commits for ${revision}`)
  const count = Number(result.stdout.trim())
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Git returned an invalid commit count')
  return count
}

function resolvePushRemote(input: {
  remotes: readonly string[]
  configuredPushRemote: string | null
  pushDefault: string | null
  configuredRemote: string | null
  upstreamRemote: string | null
}): string | null {
  if (input.upstreamRemote && input.remotes.includes(input.upstreamRemote))
    return input.upstreamRemote
  for (const candidate of [
    input.configuredPushRemote,
    input.pushDefault,
    input.configuredRemote,
    input.remotes.includes('origin') ? 'origin' : null
  ]) {
    if (candidate && input.remotes.includes(candidate)) return candidate
  }
  return input.remotes.length === 1 ? (input.remotes[0] ?? null) : null
}

function resolvePushBlockedReason(input: {
  hasHead: boolean
  selectedPushRemote: string | null
  remotes: readonly string[]
  commitsAhead: number
}): LocalGitPushBlockedReason | null {
  if (!input.hasHead) return 'nothing-to-push'
  if (!input.selectedPushRemote) {
    return input.remotes.length === 0 ? 'remote-missing' : 'remote-ambiguous'
  }
  return input.commitsAhead === 0 ? 'nothing-to-push' : null
}

function blockedPushResult(reason: LocalGitPushBlockedReason): LocalPushResult {
  switch (reason) {
    case 'branch-missing':
      return { status: 'branch-missing' }
    case 'remote-ambiguous':
      return { status: 'remote-ambiguous' }
    case 'nothing-to-push':
      return { status: 'nothing-to-push' }
    case 'status-unavailable':
      return { status: 'status-unavailable' }
    case 'remote-missing':
      return { status: 'remote-missing' }
  }
}

function unavailableStatus(error: unknown): LocalGitPublishStatus {
  return {
    branch: null,
    hasHead: false,
    staged: EMPTY_SELECTION,
    unstaged: EMPTY_SELECTION,
    upstreamTrackingRef: null,
    upstreamRemote: null,
    upstreamRemoteRef: null,
    selectedPushRemote: null,
    commitsAhead: 0,
    pushBlockedReason: 'status-unavailable',
    unavailableReason: errorMessage(error)
  }
}

function errorMessage(error: unknown): string {
  if (isGitCliError(error)) {
    const output = `${error.stderr}\n${error.stdout}`.trim() || error.message
    if (output.includes('git process timed out') || error.message.includes('timed out')) {
      return 'Git publish operation timed out.'
    }
    if (
      output.includes('git output exceeded limit') ||
      error.message.includes('output exceeded limit')
    ) {
      return 'Git publish operation produced too much output.'
    }
    return truncateMessage(output)
  }
  const message = error instanceof Error ? error.message : String(error)
  return truncateMessage(message)
}

function truncateMessage(message: string): string {
  return message.slice(0, 2_000) || 'Git publish operation failed.'
}
