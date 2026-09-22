import type {
  LocalGitFileDiff,
  LocalGitReviewFile,
  LocalGitReviewSearchItem,
  LocalGitReviewSource,
  LocalGitReviewSnapshot,
  LocalGitTarget
} from '../../../../../shared/localGitApi'
import type { LocalGitReviewLastTurn } from '../../local-git-review/LocalGitReviewProvider'
import type { ReviewOpenIntent } from '../../local-git-review/reviewOpenIntent'

export type ReviewDisplaySource = { type: 'uncommitted' } | LocalGitReviewSource

export type ReviewBackendSource = Exclude<LocalGitReviewSource, { type: 'last-turn' }>

export type ReviewFileSection =
  | {
      kind: 'snapshot'
      backendSource: ReviewBackendSource
      snapshotGeneration: string
      file: LocalGitReviewFile
      key: string
      loadState: ReviewSectionDiffState
    }
  | {
      kind: 'turn'
      backendSource: { type: 'last-turn'; turnId: string }
      file: LocalGitReviewFile
      key: string
      diff?: string
      loadState: ReviewSectionDiffState
    }
  | {
      kind: 'partial-error'
      backendSource: ReviewBackendSource
      key: string
      message: string
      loadState: ReviewSectionDiffState
    }

export type ReviewSectionDiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      diff: LocalGitFileDiff | { diff: string; binary: false; conflicted: false; truncated: false }
    }
  | { status: 'error'; message: string }

export type ReviewFileGroup = {
  path: string
  previousPath?: string
  sections: ReviewFileSection[]
  additions: number
  deletions: number
  treeStatus: ReviewTreeStatus
}

export type ReviewTreeStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'

export type ReviewSourceLoadState =
  | { status: 'idle' | 'loading' }
  | {
      status: 'ready'
      groups: ReviewFileGroup[]
      snapshots: LocalGitReviewSnapshot[]
      partialErrors: ReviewPartialSourceError[]
      largeDiff: boolean
      gitRoot?: string
    }
  | { status: 'error'; message: string }

export type ReviewPartialSourceError = {
  source: ReviewBackendSource
  message: string
}

export type ReviewSearchMatch = {
  item: LocalGitReviewSearchItem
  sectionKey: string
}

export type ReviewSearchState = {
  open: boolean
  query: string
  status: 'idle' | 'searching' | 'ready' | 'error'
  matches: ReviewSearchMatch[]
  totalMatches: number
  isCapped: boolean
  partialErrors: string[]
  currentIndex: number
  error?: string
}

export type ReviewWorkspaceController = {
  target?: LocalGitTarget
  displaySource: ReviewDisplaySource
  loadState: ReviewSourceLoadState
  selectedPath?: string
  activePath?: string
  treeVisible: boolean
  refreshing: boolean
  mutationStale: boolean
  canCopyApplyCommand: boolean
  canLoadMoreSearchMatches: boolean
  preferences: ReviewWorkspacePreferences
  search: ReviewSearchState
  setDisplaySource(source: ReviewDisplaySource): void
  setSelectedPath(path: string): void
  setActivePath(path: string): void
  setTreeFilter(value: string): void
  setTreeVisible(value: boolean): void
  setTreeWidth(width: number): void
  setDiffMode(mode: ReviewDiffMode): void
  setLineDiffType(type: ReviewLineDiffType): void
  setWrap(value: boolean): void
  setIgnoreWhitespace(value: boolean): void
  setFullFiles(value: boolean): void
  setRichPreview(value: boolean): void
  setSkipRevertConfirmation(value: boolean): void
  setCollapsed(groupKey: string, collapsed: boolean): void
  expandAll(): void
  collapseAll(): void
  isViewed(group: ReviewFileGroup): boolean
  setViewed(group: ReviewFileGroup, viewed: boolean): void
  refresh(): void
  retryPartialSource(source: ReviewBackendSource): void
  setSearchOpen(open: boolean): void
  setSearchQuery(query: string): void
  moveSearchMatch(direction: -1 | 1): void
  selectSearchMatch(index: number): void
  loadMoreSearchMatches(): void
  copyReviewApplyCommand(): void
  loadSectionDiff(sectionKey: string): void
  isMutationDisabled(
    section: ReviewFileSection,
    scope: 'section' | 'file' | 'hunk',
    hunkIndex?: number
  ): boolean
  applyHunkAction(
    group: ReviewFileGroup,
    section: Extract<ReviewFileSection, { kind: 'snapshot' }>,
    action: 'stage' | 'unstage' | 'revert',
    hunkIndex: number
  ): void
  applySectionAction(section: ReviewFileSection, action: 'stage' | 'unstage' | 'revert'): void
  applyFileAction(
    group: ReviewFileGroup,
    section: ReviewFileSection,
    action: 'stage' | 'unstage' | 'revert'
  ): void
}

export type ReviewDiffMode = 'unified' | 'split'

export type ReviewLineDiffType = 'word' | 'char' | 'none'

export type ReviewWorkspacePreferences = {
  source: ReviewDisplaySource
  diffMode: ReviewDiffMode
  lineDiffType: ReviewLineDiffType
  wrap: boolean
  ignoreWhitespace: boolean
  fullFiles: boolean
  richPreview: boolean
  skipRevertConfirmation: boolean
  treeVisible: boolean
  treeWidth: number
  treeFilter: string
  collapsedKeys: string[]
}

export type ReviewWorkspaceControllerInput = {
  target?: LocalGitTarget
  workflowActive?: boolean
  source: LocalGitReviewSource
  lastTurn?: LocalGitReviewLastTurn
  reviewOpenIntent?: ReviewOpenIntent
  onSourceChange(source: LocalGitReviewSource): void
  onReviewOpenIntentAcknowledged?(token: number): void
  onFeedback?(feedback: { tone: 'success' | 'info' | 'error'; message: string }): void
}
