import { useLayoutEffect } from 'react'

import { useLocalGitReview } from '@/components/local-git-review/LocalGitReviewProvider'
import { ReviewDiffStack } from './ReviewDiffStack'
import { ReviewDiffWorkerPool } from './ReviewDiffWorkerPool'
import { ReviewFileTree } from './ReviewFileTree'
import { ReviewFindBar } from './ReviewFindBar'
import { ReviewToolbar } from './ReviewToolbar'
import { useReviewWorkspaceController } from './useReviewWorkspaceController'
import { markReviewPerformance } from './reviewPerformance'

export function ReviewWorkspace(): React.JSX.Element {
  const {
    acknowledgeReviewOpenIntent,
    getGitWorkflow,
    lastTurn,
    notifyGitOperation,
    reviewOpenIntent,
    setReviewSource,
    source,
    target
  } = useLocalGitReview()
  const workflowActive = Boolean(target && getGitWorkflow(target))
  const controller = useReviewWorkspaceController({
    target,
    workflowActive,
    source,
    lastTurn,
    reviewOpenIntent,
    onSourceChange: setReviewSource,
    onReviewOpenIntentAcknowledged: acknowledgeReviewOpenIntent,
    onFeedback: notifyGitOperation
  })

  return (
    <div
      data-slot="review-workspace"
      aria-label="Review"
      tabIndex={-1}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
    >
      <ReviewCommitMarker />
      <ReviewToolbar controller={controller} lastTurnId={lastTurn?.turnId} />
      {controller.mutationStale ? (
        <div
          role="alert"
          className="border-b bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
        >
          审阅快照已过期，写操作已暂停，刷新成功后会自动恢复。
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1">
        <ReviewDiffWorkerPool lineDiffType={controller.preferences.lineDiffType}>
          <ReviewDiffStack controller={controller} />
        </ReviewDiffWorkerPool>
        <ReviewFileTree controller={controller} />
        <ReviewFindBar controller={controller} />
      </div>
    </div>
  )
}

function ReviewCommitMarker(): null {
  useLayoutEffect(() => {
    markReviewPerformance('react-commit')
  })
  return null
}
