import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { LocalGitService } from './LocalGitService'
import { LocalPushService } from './LocalPushService'
import { createGitReadCacheKey, GitReadCache } from './GitReadCache'
import type { WorktreeRepository } from './GitManager'
import { createGitFixture, git, gitTarget } from './testHelpers'

describe('LocalPushService', () => {
  it('publishes a branch for the first time and sets its upstream', async () => {
    const { repo, projectService } = await createGitFixture()
    const remote = await createBareRemote()
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['commit', '--allow-empty', '-m', 'publish me'])
    const service = new LocalPushService(new LocalGitService({ projectService }))

    await expect(service.getStatus(gitTarget(repo))).resolves.toMatchObject({
      branch: 'master',
      selectedPushRemote: 'origin',
      commitsAhead: 2,
      pushBlockedReason: null
    })
    await expect(service.push(gitTarget(repo))).resolves.toMatchObject({
      status: 'success',
      branch: 'master',
      upstreamRemote: 'origin',
      upstreamRemoteRef: 'refs/heads/master'
    })
    expect(
      git(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).trim()
    ).toBe('origin/master')
    expect(git(remote, ['show-ref', '--verify', 'refs/heads/master']).trim()).not.toBe('')
  }, 60_000)

  it('reuses a nonstandard configured upstream remote and ref', async () => {
    const { repo, projectService } = await createGitFixture()
    const remote = await createBareRemote()
    git(repo, ['remote', 'add', 'upstream-host', remote])
    git(repo, ['push', '--set-upstream', 'upstream-host', 'HEAD:refs/heads/review/base'])
    git(repo, ['commit', '--allow-empty', '-m', 'follow up'])
    const service = new LocalPushService(new LocalGitService({ projectService }))

    await expect(service.getStatus(gitTarget(repo))).resolves.toMatchObject({
      upstreamTrackingRef: 'refs/remotes/upstream-host/review/base',
      upstreamRemote: 'upstream-host',
      upstreamRemoteRef: 'refs/heads/review/base',
      selectedPushRemote: 'upstream-host',
      commitsAhead: 1,
      pushBlockedReason: null
    })
    await expect(service.push(gitTarget(repo))).resolves.toMatchObject({
      status: 'success',
      upstreamRemote: 'upstream-host',
      upstreamRemoteRef: 'refs/heads/review/base'
    })
    expect(git(remote, ['log', '-1', '--format=%s', 'refs/heads/review/base']).trim()).toBe(
      'follow up'
    )
  }, 60_000)

  it('keeps an existing upstream ahead of push-specific remotes and retains its ref', async () => {
    const gitCalls: Array<{
      args: readonly string[]
      options?: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }
    }> = []
    const service = createMockPushService({
      gitCalls,
      remotes: 'upstream-host\npush-default\nbranch-push\n',
      configuredPushRemote: 'branch-push',
      pushDefault: 'push-default',
      upstream: {
        trackingRef: 'refs/remotes/upstream-host/review/base',
        remote: 'upstream-host',
        remoteRef: 'refs/heads/review/base'
      }
    })

    await expect(service.getStatus(gitTarget('/mock/repo'))).resolves.toMatchObject({
      upstreamRemote: 'upstream-host',
      upstreamRemoteRef: 'refs/heads/review/base',
      selectedPushRemote: 'upstream-host',
      commitsAhead: 1,
      pushBlockedReason: null
    })
    await expect(service.push(gitTarget('/mock/repo'))).resolves.toMatchObject({
      status: 'success',
      upstreamRemote: 'upstream-host',
      upstreamRemoteRef: 'refs/heads/review/base'
    })
    expect(gitCalls.findLast((call) => call.args[0] === 'push')?.args).toEqual([
      'push',
      'upstream-host',
      'HEAD:refs/heads/review/base'
    ])
  })

  it('coalesces concurrent publish-status reads for the same repository', async () => {
    const gitCalls: Array<{ args: readonly string[] }> = []
    const service = createMockPushService({ gitCalls })

    const [first, second] = await Promise.all([
      service.getStatus(gitTarget('/mock/repo')),
      service.getStatus(gitTarget('/mock/repo'))
    ])

    expect(second).toEqual(first)
    expect(gitCalls.filter((call) => call.args[0] === 'remote')).toHaveLength(1)
    expect(gitCalls.filter((call) => call.args[0] === 'for-each-ref')).toHaveLength(1)
  })

  it('falls back through push config when no upstream is configured', async () => {
    await expect(
      createMockPushService({
        remotes: 'origin\nbranch-push\npush-default\nbranch-remote\n',
        configuredPushRemote: 'branch-push',
        pushDefault: 'push-default',
        configuredRemote: 'branch-remote'
      }).getStatus(gitTarget('/mock/repo'))
    ).resolves.toMatchObject({ selectedPushRemote: 'branch-push' })

    await expect(
      createMockPushService({
        remotes: 'origin\npush-default\nbranch-remote\n',
        configuredPushRemote: 'missing',
        pushDefault: 'push-default',
        configuredRemote: 'branch-remote'
      }).getStatus(gitTarget('/mock/repo'))
    ).resolves.toMatchObject({ selectedPushRemote: 'push-default' })

    await expect(
      createMockPushService({
        remotes: 'origin\nbranch-remote\n',
        configuredPushRemote: 'missing',
        pushDefault: 'missing',
        configuredRemote: 'branch-remote'
      }).getStatus(gitTarget('/mock/repo'))
    ).resolves.toMatchObject({ selectedPushRemote: 'branch-remote' })

    await expect(
      createMockPushService({
        remotes: 'origin\nother\n',
        configuredPushRemote: 'missing',
        pushDefault: 'missing',
        configuredRemote: 'missing'
      }).getStatus(gitTarget('/mock/repo'))
    ).resolves.toMatchObject({ selectedPushRemote: 'origin' })

    await expect(
      createMockPushService({
        remotes: 'only\n',
        configuredPushRemote: 'missing',
        pushDefault: 'missing',
        configuredRemote: 'missing'
      }).getStatus(gitTarget('/mock/repo'))
    ).resolves.toMatchObject({ selectedPushRemote: 'only' })
  })

  it('reports a non-fast-forward push as a failed push', async () => {
    const { repo, projectService } = await createGitFixture()
    const remote = await createBareRemote()
    const otherParent = await mkdtemp(join(tmpdir(), 'dascowork-local-git-other-'))
    onTestFinished(() => rm(otherParent, { recursive: true, force: true }))
    const other = join(otherParent, 'repo')
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '--set-upstream', 'origin', 'HEAD'])
    git(otherParent, ['clone', remote, other])
    git(other, ['config', 'user.email', 'test@example.com'])
    git(other, ['config', 'user.name', 'Test User'])
    await writeFile(join(other, 'remote.txt'), 'remote\n')
    git(other, ['add', 'remote.txt'])
    git(other, ['commit', '-m', 'remote moved'])
    git(other, ['push', 'origin', 'HEAD:master'])
    await writeFile(join(repo, 'local.txt'), 'local\n')
    git(repo, ['add', 'local.txt'])
    git(repo, ['commit', '-m', 'local moved'])
    const beforeRemote = git(remote, ['rev-parse', 'refs/heads/master']).trim()
    const beforeHead = git(repo, ['rev-parse', 'HEAD']).trim()
    const service = new LocalPushService(new LocalGitService({ projectService }))

    await expect(service.push(gitTarget(repo))).resolves.toMatchObject({
      status: 'push-failed',
      message: expect.stringMatching(/fetch first|non-fast-forward|rejected/u)
    })
    expect(git(remote, ['rev-parse', 'refs/heads/master']).trim()).toBe(beforeRemote)
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead)
    expect(git(repo, ['branch', '--show-current']).trim()).toBe('master')
    await expect(readFile(join(repo, 'local.txt'), 'utf8')).resolves.toBe('local\n')
  }, 60_000)

  it('runs push with fixed non-interactive timeout and output limits', async () => {
    const gitCalls: Array<{
      args: readonly string[]
      options?: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }
    }> = []
    const service = createMockPushService({
      gitCalls,
      remotes: 'origin\n',
      commitCount: '1\n'
    })

    await expect(service.push(gitTarget('/mock/repo'))).resolves.toMatchObject({
      status: 'success'
    })
    const pushCall = gitCalls.find((call) => call.args[0] === 'push')
    expect(pushCall).toMatchObject({
      args: ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/master'],
      options: {
        timeoutMs: 45_000,
        maxOutputBytes: 64 * 1024,
        env: { GIT_TERMINAL_PROMPT: '0' }
      }
    })
  })

  it('maps timeout and oversized push output to bounded messages', async () => {
    await expect(
      createMockPushService({
        pushResult: {
          success: false,
          code: null,
          stdout: '',
          stderr: 'git process timed out after 45000ms'
        }
      }).push(gitTarget('/mock/repo'))
    ).resolves.toEqual({
      status: 'push-failed',
      message: 'Git publish operation timed out.'
    })

    await expect(
      createMockPushService({
        pushResult: {
          success: false,
          code: null,
          stdout: 'x'.repeat(70_000),
          stderr: 'git output exceeded limit'
        }
      }).push(gitTarget('/mock/repo'))
    ).resolves.toEqual({
      status: 'push-failed',
      message: 'Git publish operation produced too much output.'
    })

    await expect(
      createMockPushService({
        pushResult: {
          success: false,
          code: 1,
          stdout: '',
          stderr: 'x'.repeat(2_500)
        }
      }).push(gitTarget('/mock/repo'))
    ).resolves.toMatchObject({
      status: 'push-failed',
      message: 'x'.repeat(2_000)
    })
  })

  it('reports nothing-to-push without invoking a push', async () => {
    const { repo, projectService } = await createGitFixture()
    const remote = await createBareRemote()
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['push', '--set-upstream', 'origin', 'HEAD'])
    const service = new LocalPushService(new LocalGitService({ projectService }))

    await expect(service.getStatus(gitTarget(repo))).resolves.toMatchObject({
      commitsAhead: 0,
      pushBlockedReason: 'nothing-to-push'
    })
    await expect(service.push(gitTarget(repo))).resolves.toEqual({ status: 'nothing-to-push' })
  }, 60_000)

  it('does not pick a remote when none exists or more than one is ambiguous', async () => {
    const { repo, projectService } = await createGitFixture()
    const service = new LocalPushService(new LocalGitService({ projectService }))

    await expect(service.getStatus(gitTarget(repo))).resolves.toMatchObject({
      selectedPushRemote: null,
      pushBlockedReason: 'remote-missing'
    })
    await expect(service.push(gitTarget(repo))).resolves.toEqual({ status: 'remote-missing' })

    const first = await createBareRemote()
    const second = await createBareRemote()
    git(repo, ['remote', 'add', 'first', first])
    git(repo, ['remote', 'add', 'second', second])

    await expect(service.getStatus(gitTarget(repo))).resolves.toMatchObject({
      selectedPushRemote: null,
      pushBlockedReason: 'remote-ambiguous'
    })
    await expect(service.push(gitTarget(repo))).resolves.toEqual({ status: 'remote-ambiguous' })
  }, 60_000)

  it('does not publish from detached HEAD', async () => {
    const { repo, projectService } = await createGitFixture()
    const remote = await createBareRemote()
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['checkout', '--detach'])
    const service = new LocalPushService(new LocalGitService({ projectService }))

    await expect(service.getStatus(gitTarget(repo))).resolves.toMatchObject({
      branch: null,
      selectedPushRemote: 'origin',
      pushBlockedReason: 'branch-missing'
    })
    await expect(service.push(gitTarget(repo))).resolves.toEqual({ status: 'branch-missing' })
  }, 60_000)
})

function createMockPushService(input: {
  gitCalls?: Array<{
    args: readonly string[]
    options?: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }
  }>
  remotes?: string
  commitCount?: string
  configuredPushRemote?: string | null
  pushDefault?: string | null
  configuredRemote?: string | null
  upstream?: { trackingRef: string; remote: string; remoteRef: string }
  pushResult?: {
    success: boolean
    code: number | null
    stdout: string
    stderr: string
  }
}): LocalPushService {
  const gitCalls = input.gitCalls ?? []
  const readCache = new GitReadCache()
  const repository = {
    git: vi.fn(async (args: readonly string[], options?: unknown) => {
      gitCalls.push({
        args,
        options: options as {
          timeoutMs?: number
          maxOutputBytes?: number
          env?: Record<string, string>
        }
      })
      if (args[0] === 'branch') return gitResult({ stdout: 'master\n' })
      if (args[0] === 'rev-parse') return gitResult()
      if (args[0] === 'diff') return gitResult()
      if (args[0] === 'remote') return gitResult({ stdout: input.remotes ?? 'origin\n' })
      if (args[0] === 'config') {
        const key = args[2]
        const configValues: Record<string, string | null | undefined> = {
          'branch.master.pushRemote': input.configuredPushRemote,
          'remote.pushDefault': input.pushDefault,
          'branch.master.remote': input.configuredRemote
        }
        const value = configValues[String(key)]
        return value ? gitResult({ stdout: `${value}\n` }) : gitResult({ success: false, code: 1 })
      }
      if (args[0] === 'for-each-ref') {
        return gitResult({
          stdout: input.upstream
            ? `${input.upstream.trackingRef}\0${input.upstream.remote}\0${input.upstream.remoteRef}\n`
            : ''
        })
      }
      if (args[0] === 'show-ref') return gitResult({ success: false, code: 1 })
      if (args[0] === 'rev-list') return gitResult({ stdout: input.commitCount ?? '1\n' })
      if (args[0] === 'push') return input.pushResult ?? gitResult()
      return gitResult()
    }),
    listUntrackedPaths: vi.fn(async () => []),
    readCached: vi.fn(
      async <T>(
        type: string,
        parts: readonly unknown[],
        loader: () => Promise<T>,
        options?: Parameters<GitReadCache['fetch']>[2]
      ): Promise<T> =>
        readCache.fetch(
          createGitReadCacheKey('local', '/mock/repo', type, ...parts),
          loader,
          options
        )
    ),
    invalidateGitReadCachesForRepoChange: vi.fn()
  } as unknown as WorktreeRepository
  const localGit = {
    resolveTrustedRepository: vi.fn(async () => ({ repository }))
  } as unknown as LocalGitService
  return new LocalPushService(localGit)
}

function gitResult(
  input: {
    success?: boolean
    code?: number | null
    stdout?: string
    stderr?: string
  } = {}
): {
  success: boolean
  code: number | null
  stdout: string
  stderr: string
} {
  return {
    success: input.success ?? true,
    code: input.code ?? 0,
    stdout: input.stdout ?? '',
    stderr: input.stderr ?? ''
  }
}

async function createBareRemote(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'dascowork-local-git-remote-'))
  onTestFinished(() => rm(parent, { recursive: true, force: true }))
  const remote = join(parent, 'remote.git')
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' })
  return remote
}
