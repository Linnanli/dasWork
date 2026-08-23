/* eslint-disable react-refresh/only-export-components -- the review context and hook form one state boundary. */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import type { GitRepositoryTarget, LocalGitReviewSource } from '../../../../shared/localGitApi'
import { Toaster } from '@/components/ui/sonner'
import { useOptionalRightWorkspace } from '@/components/right-workspace'
import { useGitRepository } from './GitRepositoryProvider'
import { toast } from 'sonner'
import type { ReviewOpenIntent } from './reviewOpenIntent'

export type LocalGitReviewLastTurn = {
  turnId: string
  selectedPath?: string
  files: Array<{
    path: string
    diff?: string
    additions: number
    deletions: number
  }>
}

export type LocalGitOperationFeedback = {
  id?: string
  tone: 'success' | 'info' | 'error'
  message: string
}

export type LocalGitWorkflow =
  | {
      kind: 'branch-switch'
      phase: 'switching-branch' | 'creating-branch'
    }
  | {
      kind: 'commit-and-switch'
      phase: 'committing' | 'switching-branch'
    }
  | {
      kind: 'commit-or-push'
      phase: 'creating-branch' | 'committing' | 'pushing'
    }

type LocalGitReviewContextValue = {
  target?: GitRepositoryTarget
  source: LocalGitReviewSource
  lastTurn?: LocalGitReviewLastTurn
  reviewOpenIntent?: ReviewOpenIntent
  openReview(source?: LocalGitReviewSource, lastTurn?: LocalGitReviewLastTurn): void
  openUncommittedReview(): void
  acknowledgeReviewOpenIntent(token: number): void
  setReviewSource(source: LocalGitReviewSource): void
  closeReview(): void
  notifyGitOperation(feedback: LocalGitOperationFeedback): void
  startGitWorkflow(target: GitRepositoryTarget, workflow: LocalGitWorkflow): boolean
  updateGitWorkflow(target: GitRepositoryTarget, workflow: LocalGitWorkflow): void
  finishGitWorkflow(target: GitRepositoryTarget): void
  getGitWorkflow(target: GitRepositoryTarget): LocalGitWorkflow | undefined
}

const LocalGitReviewContext = createContext<LocalGitReviewContextValue>({
  openReview: () => undefined,
  openUncommittedReview: () => undefined,
  acknowledgeReviewOpenIntent: () => undefined,
  source: { type: 'unstaged' },
  setReviewSource: () => undefined,
  closeReview: () => undefined,
  notifyGitOperation: () => undefined,
  startGitWorkflow: () => true,
  updateGitWorkflow: () => undefined,
  finishGitWorkflow: () => undefined,
  getGitWorkflow: () => undefined
})

const GIT_OPERATION_TOAST_DURATION = 6_000
const GIT_OPERATION_TOAST_TEST_ID = 'local-git-operation-toast'

export function LocalGitReviewProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { target } = useGitRepository()
  const workspace = useOptionalRightWorkspace()
  const [source, setSource] = useState<LocalGitReviewSource>({ type: 'unstaged' })
  const [lastTurn, setLastTurn] = useState<LocalGitReviewLastTurn>()
  const [reviewOpenIntent, setReviewOpenIntent] = useState<ReviewOpenIntent>()
  const [gitWorkflows, setGitWorkflows] = useState<Record<string, LocalGitWorkflow>>({})
  const reviewOpenIntentSequenceRef = useRef(0)
  const gitWorkflowsRef = useRef<Record<string, LocalGitWorkflow>>({})

  const openReview = useCallback(
    (
      nextSource: LocalGitReviewSource = { type: 'unstaged' },
      nextLastTurn?: LocalGitReviewLastTurn
    ) => {
      setSource(nextSource)
      setLastTurn(nextSource.type === 'last-turn' ? nextLastTurn : undefined)
      workspace?.openReview(nextSource)
    },
    [workspace]
  )
  const openUncommittedReview = useCallback(() => {
    const nextSource: LocalGitReviewSource = { type: 'unstaged' }
    const nextIntent: ReviewOpenIntent = {
      type: 'uncommitted',
      token: ++reviewOpenIntentSequenceRef.current
    }
    setSource(nextSource)
    setLastTurn(undefined)
    setReviewOpenIntent(nextIntent)
    workspace?.openReview(nextSource)
  }, [workspace])
  const acknowledgeReviewOpenIntent = useCallback((token: number) => {
    setReviewOpenIntent((current) => (current?.token === token ? undefined : current))
  }, [])
  const closeReview = useCallback(() => {
    workspace?.closeTab('review')
  }, [workspace])
  const setReviewSource = useCallback(
    (nextSource: LocalGitReviewSource) => {
      setSource(nextSource)
      workspace?.openReview(nextSource)
    },
    [workspace]
  )
  const notifyGitOperation = useCallback((feedback: LocalGitOperationFeedback) => {
    const options = {
      duration: GIT_OPERATION_TOAST_DURATION,
      testId: GIT_OPERATION_TOAST_TEST_ID,
      ...(feedback.id === undefined ? {} : { id: feedback.id })
    }

    if (feedback.tone === 'success') {
      toast.success(feedback.message, options)
      return
    }
    if (feedback.tone === 'error') {
      toast.error(feedback.message, options)
      return
    }
    toast.info(feedback.message, options)
  }, [])

  const startGitWorkflow = useCallback(
    (workflowTarget: GitRepositoryTarget, workflow: LocalGitWorkflow): boolean => {
      const key = gitWorkflowKey(workflowTarget)
      if (gitWorkflowsRef.current[key]) return false
      gitWorkflowsRef.current = { ...gitWorkflowsRef.current, [key]: workflow }
      setGitWorkflows(gitWorkflowsRef.current)
      return true
    },
    []
  )
  const updateGitWorkflow = useCallback(
    (workflowTarget: GitRepositoryTarget, workflow: LocalGitWorkflow) => {
      const key = gitWorkflowKey(workflowTarget)
      if (!gitWorkflowsRef.current[key]) return
      gitWorkflowsRef.current = { ...gitWorkflowsRef.current, [key]: workflow }
      setGitWorkflows(gitWorkflowsRef.current)
    },
    []
  )
  const finishGitWorkflow = useCallback((workflowTarget: GitRepositoryTarget) => {
    const key = gitWorkflowKey(workflowTarget)
    if (!gitWorkflowsRef.current[key]) return
    const remainingWorkflows = { ...gitWorkflowsRef.current }
    delete remainingWorkflows[key]
    gitWorkflowsRef.current = remainingWorkflows
    setGitWorkflows(remainingWorkflows)
  }, [])
  const getGitWorkflow = useCallback(
    (workflowTarget: GitRepositoryTarget) => gitWorkflows[gitWorkflowKey(workflowTarget)],
    [gitWorkflows]
  )
  const value = useMemo(
    () => ({
      target,
      source,
      lastTurn,
      reviewOpenIntent,
      openReview,
      openUncommittedReview,
      acknowledgeReviewOpenIntent,
      setReviewSource,
      closeReview,
      notifyGitOperation,
      startGitWorkflow,
      updateGitWorkflow,
      finishGitWorkflow,
      getGitWorkflow
    }),
    [
      closeReview,
      acknowledgeReviewOpenIntent,
      finishGitWorkflow,
      getGitWorkflow,
      notifyGitOperation,
      openReview,
      openUncommittedReview,
      lastTurn,
      reviewOpenIntent,
      startGitWorkflow,
      target,
      source,
      setReviewSource,
      updateGitWorkflow
    ]
  )

  return (
    <LocalGitReviewContext.Provider value={value}>
      {children}
      <Toaster
        position="top-center"
        theme="system"
        duration={GIT_OPERATION_TOAST_DURATION}
        visibleToasts={3}
      />
    </LocalGitReviewContext.Provider>
  )
}

export function useLocalGitReview(): LocalGitReviewContextValue {
  return useContext(LocalGitReviewContext)
}

function gitWorkflowKey(target: GitRepositoryTarget): string {
  return JSON.stringify([target.hostId, target.cwd])
}
