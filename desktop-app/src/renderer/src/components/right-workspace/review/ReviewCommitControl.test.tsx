// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  GitRepositoryTarget,
  LocalGitChangeEvent,
  LocalBranchSummary,
  LocalGitPublishStatus
} from '../../../../../shared/localGitApi'
import { CommitOrPushControlProvider } from '@/components/local-git-review/CommitOrPushControlProvider'
import { GitRepositoryProvider } from '@/components/local-git-review/GitRepositoryProvider'
import {
  LocalGitReviewProvider,
  useLocalGitReview
} from '@/components/local-git-review/LocalGitReviewProvider'
import { ReviewCommitControl } from './ReviewCommitControl'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const target: GitRepositoryTarget = {
  conversationId: 'conversation',
  threadId: 'thread',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}
const otherTarget: GitRepositoryTarget = {
  conversationId: 'other-conversation',
  threadId: 'other-thread',
  hostId: 'local',
  cwd: '/other-repo',
  gitRoot: '/other-repo'
}

let container: HTMLDivElement
let root: Root
let git: {
  resolveRepositoryTarget: ReturnType<typeof vi.fn>
  getPublishStatus: ReturnType<typeof vi.fn>
  listBranches: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  commitChanges: ReturnType<typeof vi.fn>
  pushChanges: ReturnType<typeof vi.fn>
  createBranch: ReturnType<typeof vi.fn>
}

describe('ReviewCommitControl', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    git = {
      resolveRepositoryTarget: vi.fn(async ({ target: identity }) => ({
        status: 'ready',
        target: identity.conversationId === otherTarget.conversationId ? otherTarget : target
      })),
      getPublishStatus: vi.fn(async () => publishStatus({ stagedFiles: 1 })),
      listBranches: vi.fn(async () => branchSummary()),
      subscribe: vi.fn(() => () => undefined),
      commitChanges: vi.fn(async () => ({ status: 'success', commitSha: 'abc1234' })),
      pushChanges: vi.fn(async () => ({
        status: 'success',
        branch: 'main',
        upstreamTrackingRef: 'refs/remotes/origin/main',
        upstreamRemote: 'origin',
        upstreamRemoteRef: 'refs/heads/main'
      })),
      createBranch: vi.fn()
    }
    window.desktopApp = { git } as never
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('loads shared working-tree publish status only after a toolbar trigger opens the dialog', async () => {
    await render()
    await act(flush)

    expect(button().disabled).toBe(false)
    await act(async () => button().click())
    await act(flush)

    expect(git.getPublishStatus).toHaveBeenCalledWith({ target })
    expect(git.listBranches).toHaveBeenCalledWith({ target })
    expect(document.body.querySelector('[data-slot="commit-or-push-dialog"]')).not.toBeNull()
  })

  it('renders one shared dialog for multiple toolbar triggers', async () => {
    await render({ controlCount: 2 })
    await act(flush)

    expect(git.subscribe).toHaveBeenCalledTimes(1)
    expect(buttons()).toHaveLength(2)
    await act(async () => buttons()[1]?.click())
    await flush()

    expect(document.body.querySelectorAll('[data-slot="commit-or-push-dialog"]')).toHaveLength(1)
  })

  it('commits before pushing for commit-and-push and reports the pushed branch', async () => {
    await render()
    await act(flush)
    await act(async () => button().click())
    await flush()
    await act(async () => actionButton('commit-and-push').click())
    await flush()

    expect(git.commitChanges).toHaveBeenCalledWith({ target, message: '', includeUnstaged: true })
    expect(git.pushChanges).toHaveBeenCalledWith({ target })
    expect(git.commitChanges.mock.invocationCallOrder[0]).toBeLessThan(
      git.pushChanges.mock.invocationCallOrder[0]!
    )
    expect(document.body.textContent).toContain('已推送 main。')
  })

  it('push-only does not create a commit', async () => {
    git.getPublishStatus.mockResolvedValue(publishStatus({ stagedFiles: 0, commitsAhead: 1 }))
    await render()
    await act(flush)
    await act(async () => button().click())
    await flush()
    await act(async () => actionButton('push').click())
    await flush()

    expect(git.commitChanges).not.toHaveBeenCalled()
    expect(git.pushChanges).toHaveBeenCalledWith({ target })
  })

  it('disables the toolbar after a completed operation refreshes a clean repository status', async () => {
    git.getPublishStatus
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 1 }))
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 0 }))

    await render()
    await act(flush)
    await act(async () => button().click())
    await act(flush)
    await act(async () => actionButton('commit').click())
    await act(flush)

    expect(git.getPublishStatus).toHaveBeenCalledTimes(2)
    expect(button().disabled).toBe(true)
  })

  it('refreshes a disabled toolbar when an external working-tree change arrives', async () => {
    let notifyGitChange: ((event: LocalGitChangeEvent) => void) | undefined
    git.subscribe.mockImplementation((listener) => {
      notifyGitChange = listener
      return () => undefined
    })
    git.getPublishStatus
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 1 }))
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 0 }))
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 1 }))

    await render()
    await act(flush)
    await act(async () => button().click())
    await act(flush)
    await act(async () => actionButton('commit').click())
    await act(flush)
    expect(button().disabled).toBe(true)

    await act(async () => {
      notifyGitChange?.({
        target,
        snapshotGeneration: 'external-working-tree-change',
        changeTypes: ['working-tree']
      })
      await flush()
    })

    expect(git.getPublishStatus).toHaveBeenCalledTimes(3)
    expect(button().disabled).toBe(false)
  })

  it('coalesces repository change events while a publish workflow is active', async () => {
    let notifyGitChange: ((event: LocalGitChangeEvent) => void) | undefined
    const commit = deferred<Awaited<ReturnType<typeof window.desktopApp.git.commitChanges>>>()
    git.subscribe.mockImplementation((listener) => {
      notifyGitChange = listener
      return () => undefined
    })
    git.commitChanges.mockReturnValue(commit.promise)
    git.getPublishStatus
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 1 }))
      .mockResolvedValueOnce(publishStatus({ stagedFiles: 0 }))

    await render()
    await act(flush)
    await act(async () => button().click())
    await act(flush)
    await act(async () => actionButton('commit').click())

    await act(async () => {
      notifyGitChange?.({
        target,
        snapshotGeneration: 'commit-in-progress',
        changeTypes: ['head', 'index', 'working-tree']
      })
      await flush()
    })

    expect(git.getPublishStatus).toHaveBeenCalledTimes(1)

    await act(async () => {
      commit.resolve({ status: 'success', commitSha: 'abc1234' })
      await flush()
    })

    expect(git.getPublishStatus).toHaveBeenCalledTimes(2)
  })

  it('opens from a clean detached HEAD when a remote can publish a new branch', async () => {
    git.getPublishStatus.mockResolvedValue(
      publishStatus({ stagedFiles: 0, branch: null, commitsAhead: 0 })
    )
    await render()
    await act(flush)

    expect(button().disabled).toBe(false)
    await act(async () => button().click())
    await act(flush)
    expect(document.body.querySelector('[data-slot="commit-or-push-dialog"]')).not.toBeNull()
  })

  it('publishes a clean detached HEAD after creating a new branch', async () => {
    git.getPublishStatus.mockResolvedValue(
      publishStatus({ stagedFiles: 0, branch: null, commitsAhead: 0 })
    )
    git.createBranch.mockResolvedValue({ status: 'success', current: 'feature/publish-detached' })
    await render()
    await act(flush)
    await act(async () => button().click())
    await act(flush)

    await act(async () => branchTargetButton().click())
    await act(async () => newBranchButton().click())
    await act(async () => setInputValue(newBranchInput(), 'feature/publish-detached'))
    await act(async () => actionButton('push').click())
    await act(flush)

    expect(git.createBranch).toHaveBeenCalledWith({
      target,
      branch: 'feature/publish-detached',
      failIfExists: true
    })
    expect(git.commitChanges).not.toHaveBeenCalled()
    expect(git.pushChanges).toHaveBeenCalledWith({ target })
  })

  it.each([
    ['branch-missing', '当前不在可推送的分支上，请先创建或切换分支。'],
    ['remote-missing', '未配置可用的远端。'],
    ['remote-ambiguous', '无法确定要推送到哪个远端。'],
    ['nothing-to-push', '没有待推送的提交。'],
    ['status-unavailable', '无法读取推送状态。\nstatus detail'],
    ['push-failed', '推送失败。\npush detail']
  ] as const)('shows a useful %s push failure reason', async (status, expectedMessage) => {
    git.getPublishStatus.mockResolvedValue(publishStatus({ stagedFiles: 0, commitsAhead: 1 }))
    git.pushChanges.mockResolvedValue({
      status,
      ...(status === 'status-unavailable'
        ? { message: 'status detail' }
        : status === 'push-failed'
          ? { message: 'push detail' }
          : {})
    })
    await render()
    await act(flush)
    await act(async () => button().click())
    await act(flush)
    await act(async () => actionButton('push').click())
    await act(flush)

    expect(document.body.textContent).toContain(expectedMessage)
  })

  it('retains a successful commit when the following push fails', async () => {
    git.pushChanges.mockResolvedValue({ status: 'remote-missing' })
    await render()
    await act(flush)
    await act(async () => button().click())
    await act(flush)
    await act(async () => actionButton('commit-and-push').click())
    await act(flush)

    expect(document.body.textContent).toContain('提交成功，但推送失败：未配置可用的远端。')
  })

  it('does not execute when another workflow already holds the repository lock', async () => {
    await render({ workflowOccupied: true })
    await act(flush)
    await act(async () => button().click())
    await act(flush)
    await act(async () => actionButton('commit').click())
    await act(flush)

    expect(git.commitChanges).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('当前仓库已有 Git 操作进行中。')
  })

  it('closes and invalidates a dialog when the conversation target changes', async () => {
    const initialStatus = deferred<LocalGitPublishStatus>()
    const initialBranches = deferred<LocalBranchSummary>()
    git.getPublishStatus.mockImplementation(({ target: requestedTarget }) =>
      requestedTarget.conversationId === target.conversationId
        ? initialStatus.promise
        : Promise.resolve(publishStatus({ stagedFiles: 1 }))
    )
    git.listBranches.mockImplementation(({ target: requestedTarget }) =>
      requestedTarget.conversationId === target.conversationId
        ? initialBranches.promise
        : Promise.resolve(branchSummary())
    )

    await render()
    await act(flush)
    await act(async () => button().click())
    expect(document.body.querySelector('[data-slot="commit-or-push-dialog"]')).not.toBeNull()

    await render({ identity: otherTarget })
    await act(flush)
    expect(document.body.querySelector('[data-slot="commit-or-push-dialog"]')).toBeNull()

    await act(async () => {
      initialStatus.resolve(publishStatus({ stagedFiles: 1 }))
      initialBranches.resolve(branchSummary())
    })
    await act(flush)
    expect(document.body.querySelector('[data-slot="commit-or-push-dialog"]')).toBeNull()

    await act(async () => button().click())
    await act(flush)
    expect(git.getPublishStatus).toHaveBeenLastCalledWith({ target: otherTarget })
    expect(git.listBranches).toHaveBeenLastCalledWith({ target: otherTarget })

    await act(async () => actionButton('commit').click())
    await act(flush)
    expect(git.commitChanges).toHaveBeenCalledWith({
      target: otherTarget,
      message: '',
      includeUnstaged: true
    })
  })
})

function publishStatus({
  stagedFiles,
  commitsAhead = 0,
  branch = 'main'
}: {
  stagedFiles: number
  commitsAhead?: number
  branch?: string | null
}): LocalGitPublishStatus {
  return {
    branch,
    hasHead: true,
    staged: { fileCount: stagedFiles, additions: stagedFiles, deletions: 0 },
    unstaged: { fileCount: 0, additions: 0, deletions: 0 },
    upstreamTrackingRef: 'refs/remotes/origin/main',
    upstreamRemote: 'origin',
    upstreamRemoteRef: 'refs/heads/main',
    selectedPushRemote: 'origin',
    commitsAhead,
    pushBlockedReason: commitsAhead > 0 ? null : 'nothing-to-push'
  }
}

function branchSummary(): LocalBranchSummary {
  return {
    current: 'main',
    defaultBase: 'main',
    local: ['main'],
    recent: [],
    uncommittedFileCount: 0
  }
}

async function render({
  controlCount = 1,
  identity = target,
  workflowOccupied = false
}: {
  controlCount?: number
  identity?: Pick<GitRepositoryTarget, 'conversationId' | 'threadId'>
  workflowOccupied?: boolean
} = {}): Promise<void> {
  await act(async () => {
    root.render(
      <GitRepositoryProvider identity={identity}>
        <LocalGitReviewProvider>
          {workflowOccupied ? <WorkflowOccupier /> : null}
          <CommitOrPushControlProvider>
            {Array.from({ length: controlCount }, (_, index) => (
              <ReviewCommitControl key={index} />
            ))}
          </CommitOrPushControlProvider>
        </LocalGitReviewProvider>
      </GitRepositoryProvider>
    )
    await flush()
  })
}

function WorkflowOccupier(): null {
  const { startGitWorkflow } = useLocalGitReview()
  useEffect(() => {
    startGitWorkflow(target, { kind: 'branch-switch', phase: 'switching-branch' })
  }, [startGitWorkflow])
  return null
}

function button(): HTMLButtonElement {
  const [element] = buttons()
  if (!element) throw new Error('Missing commit or push control')
  return element
}

function buttons(): HTMLButtonElement[] {
  const elements = [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter(
    (candidate) => candidate.textContent?.includes('提交或推送')
  )
  if (elements.length === 0) throw new Error('Missing commit or push control')
  return elements
}

function actionButton(action: 'commit' | 'commit-and-push' | 'push'): HTMLButtonElement {
  const element = document.body.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
  if (!element) throw new Error(`Missing ${action} action`)
  return element
}

function branchTargetButton(): HTMLButtonElement {
  const element = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.includes('当前分支')
  )
  if (!element) throw new Error('Missing current branch target button')
  return element
}

function newBranchButton(): HTMLButtonElement {
  const element = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === '新分支'
  )
  if (!element) throw new Error('Missing new branch choice')
  return element
}

function newBranchInput(): HTMLInputElement {
  const element = document.body.querySelector<HTMLInputElement>('input[aria-label="新分支名称"]')
  if (!element) throw new Error('Missing new branch input')
  return element
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
