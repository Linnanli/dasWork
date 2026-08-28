import type {
  GithubPullRequestComment,
  GithubPullRequestCommentRequest,
  GithubPullRequestCreateRequest,
  GithubPullRequestMutationResult,
  GithubPullRequestRequestReviewersRequest,
  GithubPullRequestStatusResult,
  GithubPullRequestSubmitReviewRequest,
  GithubPullRequestSummary
} from '../../shared/githubPullRequestApi'
import { githubPullRequestStatusResultSchema } from '../../shared/githubPullRequestApi'
import type { GitRepositoryTarget } from '../../shared/localGitApi'
import { runGit } from '../localGit/gitCli'
import type { WorktreeRepository } from '../localGit/GitManager'
import type { LocalGitService } from '../localGit/LocalGitService'
import { GithubCliError, runGithubCli, type GithubCliResult } from './githubCli'

type GithubCliRunner = (cwd: string, args: readonly string[]) => Promise<GithubCliResult>

type GithubRepository = {
  nameWithOwner: string
  url: string
  defaultBranch: string
}

/**
 * A fixed, non-interactive GitHub CLI boundary. Renderer input becomes only
 * validated PR text and reviewer names; the repository and current branch are
 * re-resolved from the active trusted conversation for every operation.
 */
export class GithubPullRequestService {
  constructor(
    private readonly options: {
      localGit: LocalGitService
      runGithubCli?: GithubCliRunner
    }
  ) {}

  async getStatus(target: GitRepositoryTarget): Promise<GithubPullRequestStatusResult> {
    try {
      const repository = await this.resolveRepository(target)
      const [githubRepository, branch, account] = await Promise.all([
        this.githubRepository(repository),
        currentBranch(repository),
        this.activeAccount(repository)
      ])
      const pullRequest = branch ? await this.currentPullRequest(repository, branch) : null
      return githubPullRequestStatusResultSchema.parse({
        status: 'ready',
        repository: githubRepository,
        account,
        branch,
        pullRequest
      })
    } catch (error) {
      return unavailableStatus(error)
    }
  }

  async create(input: GithubPullRequestCreateRequest): Promise<GithubPullRequestMutationResult> {
    return this.mutate(input.target, async (repository) => {
      const status = await this.getStatus(input.target)
      if (status.status !== 'ready') throw new Error(status.reason)
      if (status.pullRequest) throw new Error('当前分支已经有关联的 Pull Request。')
      if (!status.branch) throw new Error('当前 Git HEAD 未指向分支，无法创建 Pull Request。')
      const args = [
        'pr',
        'create',
        '--head',
        status.branch,
        '--base',
        input.base,
        '--title',
        input.title,
        '--body',
        input.body,
        ...(input.draft ? ['--draft'] : []),
        ...reviewerArgs('--reviewer', input.reviewers)
      ]
      await this.gh(repository, args)
    })
  }

  async comment(input: GithubPullRequestCommentRequest): Promise<GithubPullRequestMutationResult> {
    return this.mutate(input.target, async (repository) => {
      await this.requirePullRequest(input.target)
      await this.gh(repository, ['pr', 'comment', '--body', input.body])
    })
  }

  async submitReview(
    input: GithubPullRequestSubmitReviewRequest
  ): Promise<GithubPullRequestMutationResult> {
    return this.mutate(input.target, async (repository) => {
      await this.requirePullRequest(input.target)
      const eventFlag = reviewEventFlag(input.event)
      await this.gh(repository, [
        'pr',
        'review',
        eventFlag,
        ...(input.body.trim() ? ['--body', input.body] : [])
      ])
    })
  }

  async requestReviewers(
    input: GithubPullRequestRequestReviewersRequest
  ): Promise<GithubPullRequestMutationResult> {
    return this.mutate(input.target, async (repository) => {
      await this.requirePullRequest(input.target)
      await this.gh(repository, ['pr', 'edit', ...reviewerArgs('--add-reviewer', input.reviewers)])
    })
  }

  private async mutate(
    target: GitRepositoryTarget,
    action: (repository: WorktreeRepository) => Promise<void>
  ): Promise<GithubPullRequestMutationResult> {
    try {
      const repository = await this.resolveRepository(target)
      await action(repository)
      const status = await this.getStatus(target)
      if (status.status !== 'ready') throw new Error(status.reason)
      if (!status.pullRequest) throw new Error('GitHub 未返回当前分支的 Pull Request。')
      return { status: 'success', pullRequest: status.pullRequest }
    } catch (error) {
      return { status: 'error', message: mutationErrorMessage(error) }
    }
  }

  private async requirePullRequest(
    target: GitRepositoryTarget
  ): Promise<GithubPullRequestSummary> {
    const status = await this.getStatus(target)
    if (status.status !== 'ready') throw new Error(status.reason)
    if (!status.pullRequest) throw new Error('当前分支没有关联的 Pull Request。')
    return status.pullRequest
  }

  private async resolveRepository(
    target: GitRepositoryTarget
  ): Promise<WorktreeRepository> {
    const { repository } = await this.options.localGit.resolveTrustedRepository(target)
    if (!repository.host.isLocal) {
      throw new Error('远程工作目录暂不支持通过本机 GitHub CLI 管理 Pull Request。')
    }
    return repository
  }

  private gh(repository: WorktreeRepository, args: readonly string[]): Promise<GithubCliResult> {
    return (this.options.runGithubCli ?? runGithubCli)(repository.root, args)
  }

  private async githubRepository(repository: WorktreeRepository): Promise<GithubRepository> {
    const { stdout } = await this.gh(repository, [
      'repo',
      'view',
      '--json',
      'nameWithOwner,url,defaultBranchRef'
    ])
    const value = parseJsonRecord(stdout)
    const defaultBranch = record(value.defaultBranchRef)?.name
    if (
      typeof value.nameWithOwner !== 'string' ||
      typeof value.url !== 'string' ||
      typeof defaultBranch !== 'string'
    ) {
      throw new Error('GitHub CLI 返回了无效的仓库信息。')
    }
    return { nameWithOwner: value.nameWithOwner, url: value.url, defaultBranch }
  }

  private async activeAccount(repository: WorktreeRepository): Promise<string | null> {
    const { stdout } = await this.gh(repository, ['auth', 'status', '--active', '--json', 'hosts'])
    const hosts = record(parseJsonRecord(stdout).hosts)
    for (const accounts of Object.values(hosts)) {
      if (!Array.isArray(accounts)) continue
      const active = accounts.map(recordOrUndefined).find((account) => account?.active === true)
      const login = active?.login
      if (typeof login === 'string' && login) return login
    }
    return null
  }

  private async currentPullRequest(
    repository: WorktreeRepository,
    branch: string
  ): Promise<GithubPullRequestSummary | null> {
    const { stdout } = await this.gh(repository, [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--limit',
      '1',
      '--json',
      'number,title,url,state,isDraft,baseRefName,headRefName,mergeStateStatus,reviewDecision,comments,statusCheckRollup,reviews,reviewRequests'
    ])
    const entries = parseJsonArray(stdout)
    return entries.length > 0 ? pullRequestFromRecord(record(entries[0])) : null
  }
}

async function currentBranch(repository: WorktreeRepository): Promise<string | null> {
  const { stdout } = await runGit(repository, ['branch', '--show-current'])
  return stdout.trim() || null
}

function reviewerArgs(flag: '--reviewer' | '--add-reviewer', reviewers: readonly string[] | undefined): string[] {
  return reviewers?.flatMap((reviewer) => [flag, reviewer]) ?? []
}

function reviewEventFlag(event: GithubPullRequestSubmitReviewRequest['event']): string {
  switch (event) {
    case 'approve':
      return '--approve'
    case 'request-changes':
      return '--request-changes'
    case 'comment':
      return '--comment'
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  return record(parsed)
}

function parseJsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('GitHub CLI 返回了无效的 Pull Request 列表。')
  return parsed
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GitHub CLI 返回了无效的 JSON。')
  }
  return value as Record<string, unknown>
}

function pullRequestFromRecord(value: Record<string, unknown>): GithubPullRequestSummary {
  const comments = Array.isArray(value.comments)
    ? value.comments.slice(0, 100).flatMap(commentFromValue)
    : []
  const checks = Array.isArray(value.statusCheckRollup)
    ? value.statusCheckRollup.slice(0, 100).flatMap(checkFromValue)
    : []
  const reviews = Array.isArray(value.reviews) ? value.reviews.slice(0, 100).flatMap(reviewFromValue) : []
  const reviewRequests = Array.isArray(value.reviewRequests)
    ? value.reviewRequests
        .slice(0, 100)
        .flatMap((request) => {
          const login = recordOrUndefined(request)?.login
          return typeof login === 'string' && login ? [login] : []
        })
    : []
  return {
    number: positiveNumber(value.number),
    title: requiredString(value.title),
    url: requiredString(value.url),
    state: requiredString(value.state),
    isDraft: value.isDraft === true,
    baseRefName: requiredString(value.baseRefName),
    headRefName: requiredString(value.headRefName),
    mergeStateStatus: optionalString(value.mergeStateStatus),
    reviewDecision: optionalString(value.reviewDecision),
    commentCount: comments.length,
    comments,
    checks,
    reviews,
    reviewRequests
  }
}

function commentFromValue(value: unknown): GithubPullRequestComment[] {
  const comment = recordOrUndefined(value)
  if (!comment) return []
  const body = optionalString(comment.body)
  if (!body) return []
  return [
    {
      author: optionalString(recordOrUndefined(comment.author)?.login),
      body,
      url: optionalHttpsUrl(comment.url)
    }
  ]
}

function checkFromValue(value: unknown): GithubPullRequestSummary['checks'] {
  const check = recordOrUndefined(value)
  if (!check) return []
  const name = optionalString(check.name) ?? optionalString(check.context)
  const status = optionalString(check.status)
  if (!name || !status) return []
  return [
    {
      name,
      status,
      conclusion: optionalString(check.conclusion),
      detailsUrl: optionalHttpsUrl(check.detailsUrl)
    }
  ]
}

function reviewFromValue(value: unknown): GithubPullRequestSummary['reviews'] {
  const review = recordOrUndefined(value)
  const state = review && optionalString(review.state)
  if (!review || !state) return []
  return [{ author: optionalString(recordOrUndefined(review.author)?.login), state }]
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(value: unknown): string {
  const result = optionalString(value)
  if (!result) throw new Error('GitHub CLI 返回了不完整的 Pull Request 数据。')
  return result
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('GitHub CLI 返回了无效的 Pull Request 编号。')
  }
  return value
}

function optionalHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null
  return value
}

function unavailableStatus(error: unknown): GithubPullRequestStatusResult {
  if (error instanceof GithubCliError && error.code === 'GITHUB_CLI_UNAVAILABLE') {
    return { status: 'unavailable', reason: '未检测到 GitHub CLI（gh）。', ghInstalled: false }
  }
  return { status: 'unavailable', reason: mutationErrorMessage(error), ghInstalled: true }
}

function mutationErrorMessage(error: unknown): string {
  if (error instanceof GithubCliError) {
    const message = error.stderr.toLowerCase()
    if (message.includes('no github remotes') || message.includes('no git remotes')) {
      return '当前仓库没有 GitHub 远端；仍可继续使用本地 Git 和 Codex Review。'
    }
    if (message.includes('authentication') || message.includes('not logged')) {
      return 'GitHub CLI 未登录或当前账号无权访问该仓库。'
    }
    if (
      message.includes('http 403') ||
      message.includes('http 404') ||
      message.includes('resource not accessible')
    ) {
      return '当前 GitHub 账号无权访问这个仓库，或仓库已不存在。'
    }
    if (message.includes('no pull requests found')) return '当前分支没有关联的 Pull Request。'
    if (message.includes('head ref must be pushed')) return '请先推送当前分支，再创建 Pull Request。'
    if (error.code === 'GITHUB_CLI_TIMED_OUT') return 'GitHub CLI 请求超时，请稍后重试。'
    if (
      message.includes('could not resolve host') ||
      message.includes('network is unreachable') ||
      message.includes('no such host')
    ) {
      return '暂时无法连接 GitHub，请检查网络后重试。'
    }
    return 'GitHub 操作失败。请检查 GitHub CLI 登录状态和仓库权限。'
  }
  return error instanceof Error && error.message ? error.message.slice(0, 2_000) : 'GitHub 操作失败。'
}
