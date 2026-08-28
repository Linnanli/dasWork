import { describe, expect, it, vi } from 'vitest'

import type { GitRepositoryTarget } from '../../shared/localGitApi'
import type { WorktreeRepository } from '../localGit/GitManager'
import type { LocalGitService } from '../localGit/LocalGitService'
import { GithubCliError } from './githubCli'
import { GithubPullRequestService } from './GithubPullRequestService'

const target: GitRepositoryTarget = {
  conversationId: 'conversation-1',
  threadId: 'thread-1',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}

describe('GithubPullRequestService', () => {
  it('returns the current PR without exposing credentials or raw CLI output', async () => {
    const { service, runGithubCli } = createService({ hasPullRequest: true })

    await expect(service.getStatus(target)).resolves.toMatchObject({
      status: 'ready',
      repository: { nameWithOwner: 'octo/repo', defaultBranch: 'main' },
      account: 'octocat',
      branch: 'feature',
      pullRequest: {
        number: 42,
        commentCount: 1,
        checks: [{ name: 'CI', conclusion: 'SUCCESS' }],
        reviews: [{ author: 'ada', state: 'APPROVED' }],
        reviewRequests: ['grace']
      }
    })
    expect(runGithubCli).toHaveBeenCalledWith('/repo', ['auth', 'status', '--active', '--json', 'hosts'])
    expect(runGithubCli.mock.calls.flat().join(' ')).not.toContain('show-token')
  })

  it('creates a draft PR only with the already-pushed branch and fixed CLI flags', async () => {
    const { service, runGithubCli } = createService({ hasPullRequest: false })

    await expect(
      service.create({
        target,
        title: 'Improve workspace',
        body: 'A safe change.',
        base: 'main',
        draft: true,
        reviewers: ['ada']
      })
    ).resolves.toMatchObject({ status: 'success', pullRequest: { number: 42 } })

    expect(runGithubCli).toHaveBeenCalledWith('/repo', [
      'pr',
      'create',
      '--head',
      'feature',
      '--base',
      'main',
      '--title',
      'Improve workspace',
      '--body',
      'A safe change.',
      '--draft',
      '--reviewer',
      'ada'
    ])
    expect(runGithubCli.mock.calls.flat().join(' ')).not.toContain('push')
  })

  it('refuses duplicate PR creation and uses fixed commands for comments and reviews', async () => {
    const { service, runGithubCli } = createService({ hasPullRequest: true })

    await expect(
      service.create({
        target,
        title: 'Duplicate',
        body: '',
        base: 'main',
        draft: false
      })
    ).resolves.toMatchObject({ status: 'error', message: '当前分支已经有关联的 Pull Request。' })
    expect(runGithubCli.mock.calls.some(([, args]) => args[0] === 'pr' && args[1] === 'create')).toBe(false)

    await service.comment({ target, body: 'Looks good.' })
    await service.submitReview({ target, event: 'request-changes', body: 'Please add coverage.' })
    await service.requestReviewers({ target, reviewers: ['grace', 'ada'] })

    expect(runGithubCli).toHaveBeenCalledWith('/repo', ['pr', 'comment', '--body', 'Looks good.'])
    expect(runGithubCli).toHaveBeenCalledWith('/repo', [
      'pr',
      'review',
      '--request-changes',
      '--body',
      'Please add coverage.'
    ])
    expect(runGithubCli).toHaveBeenCalledWith('/repo', [
      'pr',
      'edit',
      '--add-reviewer',
      'grace',
      '--add-reviewer',
      'ada'
    ])
  })

  it('does not invoke the local GitHub CLI for remote repositories', async () => {
    const { service, runGithubCli } = createService({ isLocal: false })

    await expect(service.getStatus(target)).resolves.toMatchObject({
      status: 'unavailable',
      reason: '远程工作目录暂不支持通过本机 GitHub CLI 管理 Pull Request。'
    })
    expect(runGithubCli).not.toHaveBeenCalled()
  })

  it('returns a clear unavailable result when GitHub CLI is not installed', async () => {
    const { service, runGithubCli } = createService()
    runGithubCli.mockRejectedValue(
      new GithubCliError('GitHub CLI is not installed', 'GITHUB_CLI_UNAVAILABLE')
    )

    await expect(service.getStatus(target)).resolves.toEqual({
      status: 'unavailable',
      reason: '未检测到 GitHub CLI（gh）。',
      ghInstalled: false
    })
  })

  it.each([
    [
      'the repository has no GitHub remote',
      'unable to determine current repository, no GitHub remotes configured for this repository',
      '当前仓库没有 GitHub 远端；仍可继续使用本地 Git 和 Codex Review。'
    ],
    [
      'the account is not authorized',
      'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
      'GitHub CLI 未登录或当前账号无权访问该仓库。'
    ],
    [
      'the current account cannot access the repository',
      'HTTP 403: Resource not accessible by integration',
      '当前 GitHub 账号无权访问这个仓库，或仓库已不存在。'
    ],
    [
      'GitHub cannot be reached',
      'dial tcp: lookup api.github.com: no such host',
      '暂时无法连接 GitHub，请检查网络后重试。'
    ]
  ])('returns a safe actionable notice when %s', async (_scenario, stderr, reason) => {
    const { service, runGithubCli } = createService()
    runGithubCli.mockRejectedValue(new GithubCliError('GitHub CLI command failed', 'GITHUB_CLI_FAILED', stderr))

    await expect(service.getStatus(target)).resolves.toEqual({
      status: 'unavailable',
      reason,
      ghInstalled: true
    })
  })
})

function createService({
  hasPullRequest,
  isLocal = true
}: {
  hasPullRequest?: boolean
  isLocal?: boolean
} = {}): {
  service: GithubPullRequestService
  runGithubCli: ReturnType<typeof vi.fn>
} {
  let pullRequestExists = hasPullRequest ?? false
  const repository = {
    root: '/repo',
    host: { isLocal },
    git: vi.fn(async () => ({ success: true, code: 0, stdout: 'feature\n', stderr: '' }))
  } as unknown as WorktreeRepository
  const localGit = {
    resolveTrustedRepository: vi.fn(async () => ({ repository }))
  } as unknown as LocalGitService
  const runGithubCli = vi.fn(async (_cwd: string, args: readonly string[]) => {
    if (args[0] === 'repo') {
      return {
        stdout: JSON.stringify({
          nameWithOwner: 'octo/repo',
          url: 'https://github.com/octo/repo',
          defaultBranchRef: { name: 'main' }
        }),
        stderr: ''
      }
    }
    if (args[0] === 'auth') {
      return {
        stdout: JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'octocat' }] } }),
        stderr: ''
      }
    }
    if (args[0] === 'pr' && args[1] === 'create') pullRequestExists = true
    if (args[0] === 'pr' && args[1] === 'list') {
      return { stdout: JSON.stringify(pullRequestExists ? [pullRequestPayload()] : []), stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
  return { service: new GithubPullRequestService({ localGit, runGithubCli }), runGithubCli }
}

function pullRequestPayload(): Record<string, unknown> {
  return {
    number: 42,
    title: 'Improve workspace',
    url: 'https://github.com/octo/repo/pull/42',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefName: 'feature',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    comments: [{ author: { login: 'lin' }, body: 'Thanks', url: 'https://github.com/octo/repo/pull/42#issuecomment-1' }],
    statusCheckRollup: [
      {
        name: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/octo/repo/actions/runs/1'
      }
    ],
    reviews: [{ author: { login: 'ada' }, state: 'APPROVED' }],
    reviewRequests: [{ login: 'grace' }]
  }
}
