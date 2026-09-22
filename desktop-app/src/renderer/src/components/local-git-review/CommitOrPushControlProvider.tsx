/* eslint-disable react-hooks/set-state-in-effect, react-refresh/only-export-components -- target changes must clear dialog state before a new repository can be acted on; controller and hook share one context boundary. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import type { GitRepositoryTarget, LocalBranchSummary } from '../../../../shared/localGitApi'
import {
  CommitOrPushDialog,
  type CommitOrPushDialogActionInput,
  type CommitOrPushDialogStatus
} from '@/components/right-workspace/review/CommitOrPushDialog'
import { useGitRepository } from './GitRepositoryProvider'
import { useLocalGitReview } from './LocalGitReviewProvider'

export type CommitOrPushControlOrigin = 'summary-panel' | 'review-toolbar'

type CommitOrPushControlContextValue = {
  target?: GitRepositoryTarget
  targetAvailable: boolean
  status?: CommitOrPushDialogStatus
  pending: boolean
  buttonEnabled: boolean
  refreshVersion: number
  registerTrigger(origin: CommitOrPushControlOrigin, element: HTMLElement | null): void
  openDialog(origin?: CommitOrPushControlOrigin): Promise<void>
  refreshStatus(): Promise<void>
}

const CommitOrPushControlContext = createContext<CommitOrPushControlContextValue>({
  targetAvailable: false,
  pending: false,
  buttonEnabled: false,
  refreshVersion: 0,
  registerTrigger: () => undefined,
  openDialog: async () => undefined,
  refreshStatus: async () => undefined
})

export function CommitOrPushControlProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const repository = useGitRepository()
  const { finishGitWorkflow, notifyGitOperation, startGitWorkflow, updateGitWorkflow } =
    useLocalGitReview()
  const target = repository.status === 'ready' ? repository.target : undefined
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<CommitOrPushDialogStatus>()
  const [branches, setBranches] = useState<LocalBranchSummary>()
  const [pending, setPending] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const dialogOpenRef = useRef(open)
  const dialogOriginRef = useRef<CommitOrPushControlOrigin>('summary-panel')
  const triggerRefs = useRef<Partial<Record<CommitOrPushControlOrigin, HTMLElement | null>>>({})
  const targetKey = gitTargetKey(target)
  const activeTargetKeyRef = useRef(targetKey)
  const statusRequestRef = useRef(0)
  const branchesRequestRef = useRef(0)

  useEffect(() => {
    activeTargetKeyRef.current = targetKey
    statusRequestRef.current += 1
    branchesRequestRef.current += 1
    dialogOpenRef.current = false
    setOpen(false)
    setStatus(undefined)
    setBranches(undefined)
  }, [targetKey])

  const bumpRefreshVersion = useCallback(() => {
    setRefreshVersion((version) => version + 1)
  }, [])

  const registerTrigger = useCallback(
    (origin: CommitOrPushControlOrigin, element: HTMLElement | null): void => {
      triggerRefs.current[origin] = element
    },
    []
  )

  const setDialogOpen = useCallback((nextOpen: boolean): void => {
    dialogOpenRef.current = nextOpen
    setOpen(nextOpen)
    if (!nextOpen) {
      window.requestAnimationFrame(() => triggerRefs.current[dialogOriginRef.current]?.focus())
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    const requestId = ++statusRequestRef.current
    if (!target) {
      setStatus(undefined)
      return
    }
    try {
      const nextStatus = await window.desktopApp.git.getPublishStatus({ target })
      if (requestId !== statusRequestRef.current || targetKey !== activeTargetKeyRef.current) {
        return
      }
      setStatus(nextStatus)
    } catch (cause) {
      if (requestId !== statusRequestRef.current || targetKey !== activeTargetKeyRef.current) {
        return
      }
      setStatus({
        branch: null,
        hasHead: false,
        staged: { fileCount: 0, additions: 0, deletions: 0 },
        unstaged: { fileCount: 0, additions: 0, deletions: 0 },
        upstreamTrackingRef: null,
        upstreamRemote: null,
        upstreamRemoteRef: null,
        selectedPushRemote: null,
        commitsAhead: 0,
        pushBlockedReason: 'status-unavailable',
        unavailableReason: cause instanceof Error ? cause.message : '无法读取 Git 状态。'
      })
    }
  }, [target, targetKey])

  const refreshBranches = useCallback(async () => {
    const requestId = ++branchesRequestRef.current
    if (!target) {
      setBranches(undefined)
      return
    }
    try {
      const nextBranches = await window.desktopApp.git.listBranches({ target })
      if (requestId !== branchesRequestRef.current || targetKey !== activeTargetKeyRef.current) {
        return
      }
      setBranches(nextBranches)
    } catch {
      if (requestId !== branchesRequestRef.current || targetKey !== activeTargetKeyRef.current) {
        return
      }
      setBranches(undefined)
    }
  }, [target, targetKey])

  useEffect(() => {
    if (!target) return undefined
    return window.desktopApp.git.subscribe((event): void => {
      if (
        event.target.hostId !== target.hostId ||
        event.target.cwd !== target.cwd ||
        !event.changeTypes.some((type) =>
          ['config', 'head', 'index', 'remote-refs', 'working-tree'].includes(type)
        )
      ) {
        return
      }
      bumpRefreshVersion()
      if (dialogOpenRef.current) void refreshStatus()
    })
  }, [bumpRefreshVersion, refreshStatus, target])

  const openDialog = useCallback(
    async (origin: CommitOrPushControlOrigin = 'summary-panel'): Promise<void> => {
      if (!target) return
      dialogOriginRef.current = origin
      setDialogOpen(true)
      await Promise.all([refreshStatus(), refreshBranches()])
    },
    [refreshBranches, refreshStatus, setDialogOpen, target]
  )

  const runAction = useCallback(
    async ({
      action,
      message,
      includeUnstaged,
      newBranch
    }: CommitOrPushDialogActionInput): Promise<void> => {
      if (!target) throw new Error('当前项目不可提交。')
      const feedbackId = `publish-operation:${target.hostId}:${target.cwd}`
      const previousBranch = status?.branch
      let branch = newBranch ?? previousBranch ?? '当前分支'
      let committed = false

      const initialPhase = newBranch
        ? 'creating-branch'
        : action === 'push'
          ? 'pushing'
          : 'committing'
      if (!startGitWorkflow(target, { kind: 'commit-or-push', phase: initialPhase })) {
        notifyGitOperation({
          id: feedbackId,
          tone: 'info',
          message: '当前仓库已有 Git 操作进行中。'
        })
        return
      }

      setDialogOpen(false)
      setPending(true)
      try {
        if (newBranch) {
          notifyGitOperation({ id: feedbackId, tone: 'info', message: '正在创建新分支…' })
          const created = await window.desktopApp.git.createBranch({
            target,
            branch: newBranch,
            failIfExists: true
          })
          if (created.status !== 'success') throw new Error(created.message ?? '创建分支失败。')
          branch = created.current
        }

        if (action === 'commit' || action === 'commit-and-push') {
          updateGitWorkflow(target, { kind: 'commit-or-push', phase: 'committing' })
          notifyGitOperation({ id: feedbackId, tone: 'info', message: '正在提交更改…' })
          const result = await window.desktopApp.git.commitChanges({
            target,
            message,
            includeUnstaged
          })
          if (result.status !== 'success') throw new Error(result.message ?? '提交失败。')
          committed = true
        }

        if (action === 'commit-and-push' || action === 'push') {
          updateGitWorkflow(target, { kind: 'commit-or-push', phase: 'pushing' })
          notifyGitOperation({ id: feedbackId, tone: 'info', message: '正在推送提交…' })
          const result = await window.desktopApp.git.pushChanges({ target })
          if (result.status !== 'success') throw new PushOperationError(pushFailureReason(result))
          branch = result.branch
        }

        notifyGitOperation({
          id: feedbackId,
          tone: 'success',
          message:
            action === 'push' || action === 'commit-and-push'
              ? `已推送 ${branch}。`
              : `已提交到 ${branch}。`
        })
        bumpRefreshVersion()
      } catch (cause) {
        const failureMessage = cause instanceof Error ? cause.message : 'Git 操作失败。'
        notifyGitOperation({
          id: feedbackId,
          tone: 'error',
          message: committed ? `提交成功，但推送失败：${failureMessage}` : failureMessage
        })
        bumpRefreshVersion()
      } finally {
        finishGitWorkflow(target)
        setPending(false)
        void refreshStatus()
      }
    },
    [
      bumpRefreshVersion,
      finishGitWorkflow,
      notifyGitOperation,
      refreshStatus,
      setDialogOpen,
      startGitWorkflow,
      status,
      target,
      updateGitWorkflow
    ]
  )

  const buttonEnabled =
    Boolean(target) &&
    !pending &&
    (!status ||
      status.staged.fileCount > 0 ||
      status.unstaged.fileCount > 0 ||
      status.commitsAhead > 0)
  const value = useMemo(
    () => ({
      target,
      targetAvailable: Boolean(target),
      status,
      pending,
      buttonEnabled,
      refreshVersion,
      registerTrigger,
      openDialog,
      refreshStatus
    }),
    [
      buttonEnabled,
      openDialog,
      pending,
      registerTrigger,
      refreshStatus,
      refreshVersion,
      status,
      target
    ]
  )

  return (
    <CommitOrPushControlContext.Provider value={value}>
      {children}
      <CommitOrPushDialog
        open={open}
        status={status}
        branches={branches?.local}
        pending={pending}
        onOpenChange={setDialogOpen}
        onAction={runAction}
      />
    </CommitOrPushControlContext.Provider>
  )
}

function gitTargetKey(target: GitRepositoryTarget | undefined): string | undefined {
  if (!target) return undefined
  return [
    target.conversationId,
    target.threadId ?? '',
    target.hostId,
    target.cwd,
    target.gitRoot
  ].join('\u0000')
}

export function useCommitOrPushControl(): CommitOrPushControlContextValue {
  return useContext(CommitOrPushControlContext)
}

class PushOperationError extends Error {}

function pushFailureReason(
  result: Exclude<
    Awaited<ReturnType<typeof window.desktopApp.git.pushChanges>>,
    { status: 'success' }
  >
): string {
  switch (result.status) {
    case 'branch-missing':
      return '当前不在可推送的分支上，请先创建或切换分支。'
    case 'remote-missing':
      return '未配置可用的远端。'
    case 'remote-ambiguous':
      return '无法确定要推送到哪个远端。'
    case 'nothing-to-push':
      return '没有待推送的提交。'
    case 'status-unavailable':
      return withPushDetail('无法读取推送状态。', result.message)
    case 'push-failed':
      return withPushDetail('推送失败。', result.message)
  }
}

function withPushDetail(message: string, detail: string | undefined): string {
  const trimmedDetail = detail?.trim().slice(0, 2_000)
  return trimmedDetail ? `${message}\n${trimmedDetail}` : message
}
