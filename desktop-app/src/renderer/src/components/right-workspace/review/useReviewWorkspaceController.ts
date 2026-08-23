/* eslint-disable react-hooks/set-state-in-effect -- controller effects synchronize Git snapshots and persisted UI preferences. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  LocalGitReviewSearchItem,
  LocalGitReviewSnapshot
} from '../../../../../shared/localGitApi'
import { LOCAL_GIT_REVIEW_MUTATION_MAX_FILES } from '../../../../../shared/localGitApi'
import {
  backendSourcesForDisplay,
  createLastTurnGroups,
  createSnapshotGroups,
  displaySourceIdentity,
  fileTarget,
  groupKey,
  mutationFeedback,
  sameReviewSource
} from './reviewWorkspaceModel'
import {
  clampReviewTreeWidth,
  loadReviewPreferences,
  loadViewedFiles,
  persistViewedFiles,
  reviewGroupRevisions,
  reviewViewedFileKey,
  persistReviewPreferences,
  reviewWorkspacePreferencesKey,
  shouldUseUncommittedDefault,
  sourceChanged
} from './reviewWorkspaceStore'
import { markReviewPerformance, measureFromMark } from './reviewPerformance'
import type {
  ReviewBackendSource,
  ReviewDisplaySource,
  ReviewFileGroup,
  ReviewFileSection,
  ReviewPartialSourceError,
  ReviewSearchMatch,
  ReviewSearchState,
  ReviewSourceLoadState,
  ReviewWorkspaceController,
  ReviewWorkspaceControllerInput,
  ReviewWorkspacePreferences
} from './reviewWorkspaceTypes'

export function useReviewWorkspaceController({
  lastTurn,
  onFeedback,
  onReviewOpenIntentAcknowledged,
  onSourceChange,
  reviewOpenIntent,
  source,
  target
}: ReviewWorkspaceControllerInput): ReviewWorkspaceController {
  const initialDisplaySource = useMemo<ReviewDisplaySource>(
    () => (reviewOpenIntent ? { type: 'uncommitted' } : defaultDisplaySource(source)),
    [reviewOpenIntent, source]
  )
  const storageKey = useMemo(
    () =>
      reviewWorkspacePreferencesKey({
        hostId: target?.hostId,
        repository: target?.gitRoot ?? target?.cwd,
        workspaceId: 'review'
      }),
    [target?.cwd, target?.gitRoot, target?.hostId]
  )
  const [preferences, setPreferences] = useState<ReviewWorkspacePreferences>(() =>
    loadReviewPreferences(window.localStorage, storageKey, initialDisplaySource)
  )
  const [viewedFiles, setViewedFiles] = useState(() =>
    loadViewedFiles(window.localStorage, storageKey)
  )
  const [displaySource, setDisplaySourceState] = useState<ReviewDisplaySource>(() =>
    reviewOpenIntent
      ? { type: 'uncommitted' }
      : persistedDisplaySource(source, preferences.source, initialDisplaySource)
  )
  const [loadState, setLoadState] = useState<ReviewSourceLoadState>({ status: 'idle' })
  const [selectedPath, setSelectedPathState] = useState<string>()
  const [activePath, setActivePathState] = useState<string>()
  const [isCompact, setIsCompact] = useState(() => window.innerWidth < 760)
  const [compactTreeOpen, setCompactTreeOpen] = useState(false)
  const [search, setSearch] = useState<ReviewSearchState>(emptyReviewSearchState)
  const [refreshing, setRefreshing] = useState(false)
  const [mutationStale, setMutationStale] = useState(false)
  const [pendingMutations, setPendingMutations] = useState<PendingReviewMutation[]>([])
  const [navigationIntent, setNavigationIntent] = useState<ReviewNavigationIntent | undefined>(
    undefined
  )
  const requestIdRef = useRef(0)
  const activeDiffLoadsRef = useRef(0)
  const pendingDiffLoadsRef = useRef(new Map<string, () => void>())
  const diffOptionsGenerationRef = useRef(0)
  const searchRequestIdRef = useRef(0)
  const navigationTokenRef = useRef(0)
  const pendingMutationsRef = useRef<PendingReviewMutation[]>([])
  const loadedSourceIdentityRef = useRef<string | undefined>(undefined)
  const lastHandledReviewOpenIntentTokenRef = useRef<number | undefined>(undefined)
  const programmaticScrollUntilRef = useRef(0)
  const loadStateRef = useRef(loadState)
  const pendingGitChangeRefreshRef = useRef(false)
  const reviewIndexesRef = useRef(createReviewIndexes(loadState))
  const reviewSearchIdentity = useMemo(
    () =>
      loadState.status === 'ready'
        ? loadState.snapshots
            .map((snapshot) => `${snapshot.snapshotGeneration}:${JSON.stringify(snapshot.source)}`)
            .join('|')
        : loadState.status,
    [loadState]
  )

  useEffect(() => {
    loadStateRef.current = loadState
  }, [loadState])

  useEffect(() => {
    setPreferences(loadReviewPreferences(window.localStorage, storageKey, displaySource))
    setViewedFiles(loadViewedFiles(window.localStorage, storageKey))
  }, [displaySource, storageKey])

  useEffect(() => {
    persistReviewPreferences(window.localStorage, storageKey, preferences)
  }, [preferences, storageKey])

  useEffect(() => {
    persistViewedFiles(window.localStorage, storageKey, viewedFiles)
  }, [storageKey, viewedFiles])

  useEffect(() => {
    if (source.type === 'last-turn' && sourceChanged(displaySource, source)) {
      setDisplaySourceState(source)
      setPreferences((current) => ({ ...current, source }))
    }
  }, [displaySource, source])

  useEffect(() => {
    if (!reviewOpenIntent) return
    if (lastHandledReviewOpenIntentTokenRef.current === reviewOpenIntent.token) return
    lastHandledReviewOpenIntentTokenRef.current = reviewOpenIntent.token
    const nextSource: ReviewDisplaySource = { type: 'uncommitted' }
    setDisplaySourceState(nextSource)
    setPreferences((current) => ({ ...current, source: nextSource }))
    onReviewOpenIntentAcknowledged?.(reviewOpenIntent.token)
  }, [onReviewOpenIntentAcknowledged, reviewOpenIntent])

  useEffect(() => {
    const updateCompactState = (): void => {
      const nextCompact = window.innerWidth < 760
      setIsCompact(nextCompact)
      if (!nextCompact) setCompactTreeOpen(false)
    }
    window.addEventListener('resize', updateCompactState)
    return () => window.removeEventListener('resize', updateCompactState)
  }, [])

  useEffect(() => {
    setSearch(
      (current): ReviewSearchState =>
        current.open ? { ...emptyReviewSearchState(), open: true, query: current.query } : current
    )
    setNavigationIntent(undefined)
    searchRequestIdRef.current += 1
  }, [displaySource, reviewSearchIdentity])

  const updatePreferences = useCallback(
    (updater: (current: ReviewWorkspacePreferences) => ReviewWorkspacePreferences) => {
      setPreferences((current) => updater(current))
    },
    []
  )

  const commitLoadState = useCallback((next: ReviewSourceLoadState) => {
    loadStateRef.current = next
    reviewIndexesRef.current = createReviewIndexes(next)
    setLoadState(next)
  }, [])

  const updateLoadState = useCallback(
    (updater: (current: ReviewSourceLoadState) => ReviewSourceLoadState) => {
      setLoadState((current) => {
        const next = updater(current)
        loadStateRef.current = next
        if (next !== current) {
          reviewIndexesRef.current = createReviewIndexes(next)
          markReviewPerformance('controller-update')
        }
        return next
      })
    },
    []
  )

  const replaceGroups = useCallback(
    (updater: (groups: ReviewFileGroup[]) => ReviewFileGroup[]) => {
      updateLoadState((current) => {
        if (current.status !== 'ready') return current
        const groups = updater(current.groups)
        return groups === current.groups ? current : { ...current, groups }
      })
    },
    [updateLoadState]
  )

  const load = useCallback(
    async (
      nextSource: ReviewDisplaySource = displaySource,
      options: { discardCurrentSnapshot?: boolean } = {}
    ): Promise<boolean> => {
      const requestId = ++requestIdRef.current
      pendingDiffLoadsRef.current.clear()
      const nextSourceIdentity = displaySourceIdentity(nextSource)
      const backgroundRefresh =
        !options.discardCurrentSnapshot &&
        loadStateRef.current.status === 'ready' &&
        loadedSourceIdentityRef.current === nextSourceIdentity
      if (backgroundRefresh) setRefreshing(true)
      if (nextSource.type === 'last-turn') {
        const groups = createLastTurnGroups(nextSource, lastTurn)
        const nextLoadState: ReviewSourceLoadState = {
          status: 'ready',
          groups,
          snapshots: [],
          partialErrors: [],
          largeDiff: false
        }
        commitLoadState(nextLoadState)
        loadedSourceIdentityRef.current = nextSourceIdentity
        setRefreshing(false)
        setMutationStale(false)
        const selectedTurnPath = lastTurn?.selectedPath
        const initialTurnPath =
          selectedTurnPath && groups.some((group) => group.path === selectedTurnPath)
            ? selectedTurnPath
            : undefined
        if (initialTurnPath) {
          updatePreferences((current) => {
            const currentTurnPaths = new Set(groups.map((group) => group.path))
            const collapsedKeys = [
              ...current.collapsedKeys.filter((key) => !currentTurnPaths.has(key)),
              ...groups.filter((group) => group.path !== initialTurnPath).map((group) => group.path)
            ]
            return {
              ...current,
              collapsedKeys
            }
          })
        }
        setSelectedPathState((current) => initialTurnPath ?? current ?? groups[0]?.path)
        setActivePathState((current) => initialTurnPath ?? current ?? groups[0]?.path)
        return true
      }
      if (!target) {
        const nextLoadState: ReviewSourceLoadState = {
          status: 'error',
          message: 'No Git repository is available for review.'
        }
        commitLoadState(nextLoadState)
        setRefreshing(false)
        return false
      }
      if (!backgroundRefresh) {
        const nextLoadState: ReviewSourceLoadState = { status: 'loading' }
        commitLoadState(nextLoadState)
      }
      const backendSources = backendSourcesForDisplay(nextSource)
      const settled = await Promise.allSettled(
        backendSources.map((backendSource) =>
          window.desktopApp.git.getReviewSnapshot({ target, source: backendSource })
        )
      )
      if (requestId !== requestIdRef.current) return false
      const snapshots: LocalGitReviewSnapshot[] = []
      const partialErrors: ReviewPartialSourceError[] = []
      settled.forEach((result, index) => {
        const sourceForResult = backendSources[index]
        if (!sourceForResult) return
        if (result.status === 'fulfilled') snapshots.push(result.value)
        else {
          partialErrors.push({
            source: sourceForResult,
            message:
              result.reason instanceof Error
                ? result.reason.message
                : 'Unable to load review source.'
          })
        }
      })
      if (snapshots.length === 0 && partialErrors.length > 0) {
        if (!backgroundRefresh) {
          const nextLoadState: ReviewSourceLoadState = {
            status: 'error',
            message: partialErrors.map((error) => error.message).join('\n')
          }
          commitLoadState(nextLoadState)
        } else {
          onFeedback?.({
            tone: 'error',
            message: partialErrors.map((error) => error.message).join('\n')
          })
        }
        setRefreshing(false)
        return false
      }
      const groups = createSnapshotGroups(snapshots, partialErrors)
      const nextLoadState: ReviewSourceLoadState = {
        status: 'ready',
        groups,
        snapshots,
        partialErrors,
        largeDiff: snapshots.some((snapshot) => snapshot.largeDiff),
        gitRoot: snapshots[0]?.gitRoot
      }
      commitLoadState(nextLoadState)
      loadedSourceIdentityRef.current = nextSourceIdentity
      setRefreshing(false)
      setMutationStale(false)
      setSelectedPathState((current) =>
        current && groups.some((group) => group.path === current) ? current : groups[0]?.path
      )
      setActivePathState((current) =>
        current && groups.some((group) => group.path === current) ? current : groups[0]?.path
      )
      return true
    },
    [commitLoadState, displaySource, lastTurn, onFeedback, target, updatePreferences]
  )

  useEffect(() => {
    void load(displaySource)
  }, [displaySource, load])

  useEffect(() => {
    if (!target || displaySource.type === 'last-turn') return
    return window.desktopApp.git.subscribe?.((event) => {
      if (
        event.target.hostId === target.hostId &&
        event.target.cwd === target.cwd &&
        event.target.gitRoot === target.gitRoot
      ) {
        if (loadStateRef.current.status === 'loading') {
          pendingGitChangeRefreshRef.current = true
          return
        }
        void load(displaySource)
      }
    })
  }, [displaySource, load, target])

  useEffect(() => {
    if (!pendingGitChangeRefreshRef.current || loadState.status === 'loading') return
    pendingGitChangeRefreshRef.current = false
    void load(displaySource)
  }, [displaySource, load, loadState.status])

  useEffect(() => {
    if (!search.open || !search.query.trim()) return
    const requestId = ++searchRequestIdRef.current
    const query = search.query.trim()
    const timer = window.setTimeout(() => {
      const current = loadStateRef.current
      if (current.status !== 'ready') return
      setSearch((value) => ({ ...value, status: 'searching', error: undefined }))
      if (displaySource.type === 'last-turn') {
        const matches = searchLastTurnGroups(current.groups, query)
        if (requestId !== searchRequestIdRef.current) return
        setSearch((value) => ({
          ...value,
          status: 'ready',
          matches,
          totalMatches: matches.length,
          isCapped: false,
          partialErrors: [],
          currentIndex: matches.length > 0 ? 0 : -1
        }))
        return
      }
      if (!target) return
      const snapshots = current.snapshots
      void Promise.allSettled(
        snapshots.map((snapshot) =>
          window.desktopApp.git.searchReview({
            target,
            source: snapshot.source,
            snapshotGeneration: snapshot.snapshotGeneration,
            query
          })
        )
      ).then((settled) => {
        if (requestId !== searchRequestIdRef.current) return
        const matches: ReviewSearchMatch[] = []
        const partialErrors: string[] = []
        let totalMatches = 0
        let isCapped = false
        settled.forEach((result, index) => {
          const snapshot = snapshots[index]
          if (!snapshot) return
          if (result.status === 'rejected') {
            partialErrors.push(
              result.reason instanceof Error ? result.reason.message : '部分来源搜索失败。'
            )
            return
          }
          totalMatches += result.value.totalMatches
          isCapped ||= result.value.isCapped
          for (const item of result.value.items) {
            const section = reviewIndexesRef.current.sectionBySnapshotPath.get(
              snapshotPathKey(snapshot.snapshotGeneration, item.path)
            )
            if (section) matches.push({ item, sectionKey: section.key })
          }
        })
        if (matches.length === 0 && partialErrors.length > 0) {
          setSearch((value) => ({
            ...value,
            status: 'error',
            matches: [],
            totalMatches: 0,
            isCapped: false,
            partialErrors,
            currentIndex: -1,
            error: partialErrors.join('\n')
          }))
          return
        }
        setSearch((value) => ({
          ...value,
          status: 'ready',
          matches,
          totalMatches,
          isCapped,
          partialErrors,
          currentIndex: matches.length > 0 ? 0 : -1
        }))
      })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [displaySource, reviewSearchIdentity, search.open, search.query, target])

  const setDisplaySource = useCallback(
    (nextSource: ReviewDisplaySource) => {
      setDisplaySourceState(nextSource)
      setPreferences((current) => ({ ...current, source: nextSource }))
      if (nextSource.type !== 'uncommitted') onSourceChange(nextSource)
    },
    [onSourceChange]
  )

  const selectPath = useCallback(
    (path: string, navigation?: ReviewNavigationTarget) => {
      const current = loadStateRef.current
      const group =
        current.status === 'ready' ? reviewIndexesRef.current.groupByPath.get(path) : undefined
      const section = group?.sections.find((item) => item.kind !== 'partial-error')
      setSelectedPathState(path)
      setActivePathState(path)
      updatePreferences((value) => ({
        ...value,
        collapsedKeys: value.collapsedKeys.filter((key) => key !== path)
      }))
      setNavigationIntent({
        token: ++navigationTokenRef.current,
        path,
        ...(navigation ?? { sectionKey: section?.key })
      })
    },
    [updatePreferences]
  )
  const setSelectedPath = useCallback((path: string) => selectPath(path), [selectPath])

  const replaceSection = useCallback(
    (sectionKey: string, loadState: ReviewFileSection['loadState']) => {
      replaceGroups((groups) => replaceReviewSection(groups, sectionKey, loadState))
    },
    [replaceGroups]
  )

  useEffect(() => {
    diffOptionsGenerationRef.current += 1
    pendingDiffLoadsRef.current.clear()
    replaceGroups((groups) =>
      groups.map((group) => ({
        ...group,
        sections: group.sections.map((section) =>
          section.kind === 'snapshot' ? { ...section, loadState: { status: 'idle' } } : section
        )
      }))
    )
  }, [preferences.ignoreWhitespace, replaceGroups])

  const loadSectionDiff = useCallback(
    (sectionKey: string) => {
      const current = loadStateRef.current
      if (current.status !== 'ready' || !target) return
      const section = reviewIndexesRef.current.sectionByKey.get(sectionKey)
      if (
        !section ||
        section.loadState.status === 'loading' ||
        section.loadState.status === 'ready'
      )
        return
      if (section.kind === 'turn') {
        replaceSection(sectionKey, {
          status: 'ready',
          diff: {
            diff: section.diff ?? '',
            binary: false,
            conflicted: false,
            truncated: false
          }
        })
        return
      }
      if (section.kind !== 'snapshot') return
      replaceSection(sectionKey, { status: 'loading' })
      const currentRequestId = requestIdRef.current
      const currentDiffOptionsGeneration = diffOptionsGenerationRef.current
      const task = (): void => {
        activeDiffLoadsRef.current += 1
        const requestMark = markReviewPerformance('section-diff-request')
        void window.desktopApp.git
          .getFileDiff({
            target,
            source: section.backendSource,
            snapshotGeneration: section.snapshotGeneration,
            file: fileTarget(section.file),
            options: {
              ignoreWhitespace: preferences.ignoreWhitespace,
              // Complete before/after files are loaded on demand by the diff
              // component, so this patch can remain bounded even when the user
              // chooses to show every unchanged line.
              fullFiles: false
            }
          })
          .then((diff) => {
            if (
              currentRequestId !== requestIdRef.current ||
              currentDiffOptionsGeneration !== diffOptionsGenerationRef.current
            )
              return
            if (diff.status === 'stale') {
              // Staleness invalidates the signed snapshot as a whole. load()
              // advances requestId synchronously, so concurrent stale replies
              // from this batch collapse into one refresh.
              void load(displaySource, { discardCurrentSnapshot: true })
              return
            }
            replaceSection(sectionKey, { status: 'ready', diff })
          })
          .catch((cause) => {
            if (
              currentRequestId !== requestIdRef.current ||
              currentDiffOptionsGeneration !== diffOptionsGenerationRef.current
            )
              return
            replaceSection(sectionKey, {
              status: 'error',
              message: cause instanceof Error ? cause.message : 'Unable to load file diff.'
            })
          })
          .finally(() => {
            measureFromMark('section-diff-request', requestMark)
            activeDiffLoadsRef.current -= 1
            runNextDiffLoad(activeDiffLoadsRef, pendingDiffLoadsRef)
          })
      }
      pendingDiffLoadsRef.current.set(sectionKey, task)
      runNextDiffLoad(activeDiffLoadsRef, pendingDiffLoadsRef)
    },
    [displaySource, load, preferences.ignoreWhitespace, replaceSection, target]
  )

  useEffect(() => {
    if (!navigationIntent) return
    const current = loadStateRef.current
    if (current.status !== 'ready') return
    const group = current.groups.find((item) => item.path === navigationIntent.path)
    if (!group) {
      setNavigationIntent(undefined)
      return
    }
    const section = navigationIntent.sectionKey
      ? group.sections.find((item) => item.key === navigationIntent.sectionKey)
      : group.sections.find((item) => item.kind !== 'partial-error')
    if (section && section.kind !== 'partial-error') {
      if (section.loadState.status === 'idle' || section.loadState.status === 'error') {
        loadSectionDiff(section.key)
        return
      }
      if (section.loadState.status === 'loading') return
    }
    const cancel = scrollToReviewIntent(navigationIntent, () => {
      programmaticScrollUntilRef.current = Date.now() + 300
      setNavigationIntent((value) => (value?.token === navigationIntent.token ? undefined : value))
    })
    return cancel
  }, [loadSectionDiff, loadState, navigationIntent])

  const runMutation = useCallback(
    async ({
      action,
      files,
      hunkIndex,
      scope,
      section
    }: {
      action: 'stage' | 'unstage' | 'revert'
      files: ReturnType<typeof fileTarget>[]
      hunkIndex?: number
      scope: 'section' | 'file' | 'hunk'
      section: Extract<ReviewFileSection, { kind: 'snapshot' }>
    }): Promise<void> => {
      if (!target || mutationStale || refreshing || loadStateRef.current.status !== 'ready') return
      const pending = mutationDescriptor(section, scope, hunkIndex)
      if (pendingMutationsRef.current.some((item) => mutationsOverlap(item, pending))) return
      pendingMutationsRef.current = [...pendingMutationsRef.current, pending]
      setPendingMutations(pendingMutationsRef.current)
      try {
        const result = await window.desktopApp.git.applyReviewAction({
          target,
          source: section.backendSource,
          snapshotGeneration: section.snapshotGeneration,
          action,
          scope,
          ...(hunkIndex === undefined ? {} : { hunkIndex }),
          files
        })
        if (result.errorCode === 'stale-snapshot') {
          setMutationStale(true)
          onFeedback?.({ tone: 'error', message: '审阅快照已过期，正在自动刷新。' })
          await load(displaySource)
          return
        }
        onFeedback?.(mutationFeedback(action, result))
        if (result.status !== 'error') await load(displaySource)
      } catch (cause) {
        const stale = isStaleSnapshotError(cause)
        if (stale) setMutationStale(true)
        onFeedback?.({
          tone: 'error',
          message: cause instanceof Error ? cause.message : 'Git operation failed.'
        })
        if (stale) await load(displaySource)
      } finally {
        pendingMutationsRef.current = pendingMutationsRef.current.filter(
          (item) => item.key !== pending.key
        )
        setPendingMutations(pendingMutationsRef.current)
      }
    },
    [displaySource, load, mutationStale, onFeedback, refreshing, target]
  )

  const applyFileAction = useCallback(
    (
      _group: ReviewFileGroup,
      section: ReviewFileSection,
      action: 'stage' | 'unstage' | 'revert'
    ) => {
      if (section.kind !== 'snapshot') return
      void runMutation({ action, files: [fileTarget(section.file)], scope: 'file', section })
    },
    [runMutation]
  )

  const applyHunkAction = useCallback(
    (
      _group: ReviewFileGroup,
      section: Extract<ReviewFileSection, { kind: 'snapshot' }>,
      action: 'stage' | 'unstage' | 'revert',
      hunkIndex: number
    ) => {
      void runMutation({
        action,
        files: [fileTarget(section.file)],
        hunkIndex,
        scope: 'hunk',
        section
      })
    },
    [runMutation]
  )

  const applySectionAction = useCallback(
    (section: ReviewFileSection, action: 'stage' | 'unstage' | 'revert') => {
      const current = loadStateRef.current
      if (current.status !== 'ready' || section.kind !== 'snapshot') return
      const files =
        reviewIndexesRef.current.fileTargetsBySource.get(
          reviewBackendSourceKey(section.backendSource)
        ) ?? []
      if (files.length === 0) return
      if (files.length > LOCAL_GIT_REVIEW_MUTATION_MAX_FILES) {
        onFeedback?.({
          tone: 'error',
          message: `一次最多操作 ${LOCAL_GIT_REVIEW_MUTATION_MAX_FILES} 个文件，请按文件逐个处理。`
        })
        return
      }
      void runMutation({ action, files, scope: 'section', section })
    },
    [onFeedback, runMutation]
  )

  const selectedPathValue = useMemo(() => {
    if (selectedPath) return selectedPath
    return loadState.status === 'ready' ? loadState.groups[0]?.path : undefined
  }, [loadState, selectedPath])
  const activePathValue = useMemo(() => {
    if (activePath) return activePath
    return selectedPathValue
  }, [activePath, selectedPathValue])
  const unloadedSearchSectionKeys = useMemo(() => {
    if (!search.isCapped || loadState.status !== 'ready') return []
    const sections = new Map(
      loadState.groups.flatMap((group) => group.sections).map((section) => [section.key, section])
    )
    return [...new Set(search.matches.map((match) => match.sectionKey))].filter((sectionKey) => {
      const section = sections.get(sectionKey)
      return section?.loadState.status === 'idle' || section?.loadState.status === 'error'
    })
  }, [loadState, search.isCapped, search.matches])
  const canCopyApplyCommand =
    Boolean(target) &&
    displaySource.type !== 'last-turn' &&
    loadState.status === 'ready' &&
    loadState.snapshots.some((snapshot) => snapshot.files.length > 0)

  const copyReviewApplyCommand = useCallback(() => {
    const current = loadStateRef.current
    if (!target || current.status !== 'ready' || displaySource.type === 'last-turn') return
    const snapshots = current.snapshots
      .filter((snapshot) => snapshot.files.length > 0)
      .sort((left, right) => reviewApplyOrder(left.source) - reviewApplyOrder(right.source))
    if (snapshots.length === 0) return
    void Promise.all(
      snapshots.map((snapshot) =>
        window.desktopApp.git.getReviewApplyCommand({
          target,
          source: snapshot.source,
          snapshotGeneration: snapshot.snapshotGeneration
        })
      )
    )
      .then(async (results) => {
        await navigator.clipboard.writeText(results.map((result) => result.command).join('\n\n'))
        onFeedback?.({ tone: 'success', message: '已复制稳定快照的 git apply 命令。' })
      })
      .catch((cause) => {
        const stale = isStaleSnapshotError(cause)
        let message = '复制 git apply 命令失败。'
        if (cause instanceof Error) message = cause.message
        if (stale) message = '审阅快照已过期，请刷新后重试。'
        onFeedback?.({
          tone: 'error',
          message
        })
        if (stale) void load(displaySource)
      })
  }, [displaySource, load, onFeedback, target])

  const isMutationDisabled = useCallback(
    (
      section: ReviewFileSection,
      scope: 'section' | 'file' | 'hunk',
      hunkIndex?: number
    ): boolean => {
      if (
        section.kind !== 'snapshot' ||
        mutationStale ||
        refreshing ||
        loadState.status !== 'ready'
      )
        return true
      const targetMutation = mutationDescriptor(section, scope, hunkIndex)
      return pendingMutations.some((pending) => mutationsOverlap(pending, targetMutation))
    },
    [loadState.status, mutationStale, pendingMutations, refreshing]
  )

  return {
    target,
    displaySource,
    loadState,
    selectedPath: selectedPathValue,
    activePath: activePathValue,
    treeVisible: preferences.treeVisible && (!isCompact || compactTreeOpen),
    refreshing,
    mutationStale,
    canCopyApplyCommand,
    canLoadMoreSearchMatches: unloadedSearchSectionKeys.length > 0,
    preferences,
    search,
    setDisplaySource,
    setSelectedPath,
    setActivePath: (path) => {
      if (Date.now() < programmaticScrollUntilRef.current) return
      setActivePathState(path)
    },
    setTreeFilter: (value) => updatePreferences((current) => ({ ...current, treeFilter: value })),
    setTreeVisible: (value) => {
      if (isCompact) {
        setCompactTreeOpen(value)
        return
      }
      updatePreferences((current) => ({ ...current, treeVisible: value }))
    },
    setTreeWidth: (width) =>
      updatePreferences((current) => ({ ...current, treeWidth: clampReviewTreeWidth(width) })),
    setDiffMode: (mode) => updatePreferences((current) => ({ ...current, diffMode: mode })),
    setLineDiffType: (lineDiffType) =>
      updatePreferences((current) => ({ ...current, lineDiffType })),
    setWrap: (value) => updatePreferences((current) => ({ ...current, wrap: value })),
    setIgnoreWhitespace: (value) =>
      updatePreferences((current) => ({ ...current, ignoreWhitespace: value })),
    setFullFiles: (value) => updatePreferences((current) => ({ ...current, fullFiles: value })),
    setRichPreview: (value) => updatePreferences((current) => ({ ...current, richPreview: value })),
    setSkipRevertConfirmation: (value) =>
      updatePreferences((current) => ({ ...current, skipRevertConfirmation: value })),
    setCollapsed: (key, collapsed) =>
      updatePreferences((current) => {
        const keys = new Set(current.collapsedKeys)
        if (collapsed) keys.add(key)
        else keys.delete(key)
        return { ...current, collapsedKeys: [...keys].slice(0, 500) }
      }),
    expandAll: () => updatePreferences((current) => ({ ...current, collapsedKeys: [] })),
    collapseAll: () =>
      updatePreferences((current) => ({
        ...current,
        collapsedKeys:
          loadState.status === 'ready' ? loadState.groups.map(groupKey) : current.collapsedKeys
      })),
    isViewed: (group) => {
      if (displaySource.type !== 'branch') return false
      const key = reviewViewedFileKey(displaySourceIdentity(displaySource), group.path)
      const revisions = reviewGroupRevisions(group)
      return viewedFiles.some(
        (entry) =>
          entry.key === key &&
          entry.revisions.length === revisions.length &&
          entry.revisions.every((value, index) => value === revisions[index])
      )
    },
    setViewed: (group, viewed) => {
      if (displaySource.type !== 'branch') return
      const key = reviewViewedFileKey(displaySourceIdentity(displaySource), group.path)
      const revisions = reviewGroupRevisions(group)
      setViewedFiles((current) => {
        const remaining = current.filter((entry) => entry.key !== key)
        return viewed
          ? [...remaining, { key, revisions, updatedAt: Date.now() }].slice(-500)
          : remaining
      })
    },
    refresh: () => void load(displaySource),
    retryPartialSource: (sourceToRetry: ReviewBackendSource) => {
      const current = loadStateRef.current
      const isFailedSource =
        current.status === 'ready' &&
        current.partialErrors.some((error) => sameReviewSource(error.source, sourceToRetry))
      if (isFailedSource) void load(displaySource)
    },
    setSearchOpen: (open) => {
      searchRequestIdRef.current += 1
      setSearch((current) =>
        open ? { ...current, open: true } : { ...emptyReviewSearchState(), open: false }
      )
    },
    setSearchQuery: (query) => {
      searchRequestIdRef.current += 1
      const hasQuery = query.trim().length > 0
      setSearch((current) => ({
        ...current,
        query: query.slice(0, 255),
        status: hasQuery ? 'searching' : 'idle',
        matches: hasQuery ? current.matches : [],
        totalMatches: hasQuery ? current.totalMatches : 0,
        isCapped: hasQuery ? current.isCapped : false,
        partialErrors: hasQuery ? current.partialErrors : [],
        currentIndex: hasQuery ? current.currentIndex : -1,
        error: undefined
      }))
    },
    moveSearchMatch: (direction) => {
      setSearch((current) => {
        if (current.matches.length === 0) return current
        const currentIndex = current.currentIndex < 0 ? 0 : current.currentIndex
        const nextIndex =
          (currentIndex + direction + current.matches.length) % current.matches.length
        return { ...current, currentIndex: nextIndex }
      })
    },
    selectSearchMatch: (index) => {
      const match = search.matches[index]
      if (!match) return
      setSearch((current) => ({ ...current, currentIndex: index }))
      selectPath(match.item.path, {
        sectionKey: match.sectionKey,
        lineStart: match.item.lineStart,
        lineEnd: match.item.lineEnd,
        side: match.item.side
      })
    },
    loadMoreSearchMatches: () => {
      unloadedSearchSectionKeys.slice(0, 10).forEach(loadSectionDiff)
    },
    copyReviewApplyCommand,
    loadSectionDiff,
    isMutationDisabled,
    applyHunkAction,
    applySectionAction,
    applyFileAction
  }
}

function defaultDisplaySource(source: ReviewDisplaySource): ReviewDisplaySource {
  if (source.type === 'last-turn') return source
  return shouldUseUncommittedDefault(source) ? { type: 'uncommitted' } : source
}

function persistedDisplaySource(
  incomingSource: ReviewDisplaySource,
  persistedSource: ReviewDisplaySource,
  fallbackSource: ReviewDisplaySource
): ReviewDisplaySource {
  if (incomingSource.type === 'last-turn') return incomingSource
  return persistedSource.type === 'last-turn' ? fallbackSource : persistedSource
}

function emptyReviewSearchState(): ReviewSearchState {
  return {
    open: false,
    query: '',
    status: 'idle',
    matches: [],
    totalMatches: 0,
    isCapped: false,
    partialErrors: [],
    currentIndex: -1
  }
}

type ReviewIndexes = {
  groupByPath: Map<string, ReviewFileGroup>
  sectionByKey: Map<string, ReviewFileSection>
  sectionBySnapshotPath: Map<string, Extract<ReviewFileSection, { kind: 'snapshot' }>>
  fileTargetsBySource: Map<string, ReturnType<typeof fileTarget>[]>
}

function createReviewIndexes(loadState: ReviewSourceLoadState): ReviewIndexes {
  const indexes: ReviewIndexes = {
    groupByPath: new Map(),
    sectionByKey: new Map(),
    sectionBySnapshotPath: new Map(),
    fileTargetsBySource: new Map()
  }
  if (loadState.status !== 'ready') return indexes

  for (const group of loadState.groups) {
    indexes.groupByPath.set(group.path, group)
    for (const section of group.sections) {
      indexes.sectionByKey.set(section.key, section)
      if (section.kind !== 'snapshot') continue
      indexes.sectionBySnapshotPath.set(
        snapshotPathKey(section.snapshotGeneration, section.file.path),
        section
      )
      const sourceKey = reviewBackendSourceKey(section.backendSource)
      const targets = indexes.fileTargetsBySource.get(sourceKey) ?? []
      targets.push(fileTarget(section.file))
      indexes.fileTargetsBySource.set(sourceKey, targets)
    }
  }
  return indexes
}

function replaceReviewSection(
  groups: ReviewFileGroup[],
  sectionKey: string,
  loadState: ReviewFileSection['loadState']
): ReviewFileGroup[] {
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    const sectionIndex = group.sections.findIndex((section) => section.key === sectionKey)
    if (sectionIndex < 0) continue
    const section = group.sections[sectionIndex]
    if (!section || sameSectionLoadState(section.loadState, loadState)) return groups

    const sections = group.sections.slice()
    sections[sectionIndex] = { ...section, loadState }
    const next = groups.slice()
    next[groupIndex] = { ...group, sections }
    return next
  }
  return groups
}

function sameSectionLoadState(
  left: ReviewFileSection['loadState'],
  right: ReviewFileSection['loadState']
): boolean {
  if (left.status !== right.status) return false
  if (left.status === 'ready' && right.status === 'ready') return left.diff === right.diff
  if (left.status === 'error' && right.status === 'error') return left.message === right.message
  return true
}

function snapshotPathKey(snapshotGeneration: string, path: string): string {
  return `${snapshotGeneration}\u0000${path}`
}

function reviewBackendSourceKey(source: ReviewBackendSource): string {
  return JSON.stringify(source)
}

function searchLastTurnGroups(
  groups: readonly ReviewFileGroup[],
  query: string
): ReviewSearchMatch[] {
  const normalizedQuery = query.toLocaleLowerCase()
  const matches: ReviewSearchMatch[] = []
  for (const group of groups) {
    for (const section of group.sections) {
      if (section.kind !== 'turn') continue
      const lines = (section.diff ?? '').split(/\r?\n/u)
      lines.forEach((line, index) => {
        if (!line.toLocaleLowerCase().includes(normalizedQuery)) return
        matches.push({
          sectionKey: section.key,
          item: localSearchItem(
            group.path,
            section.key,
            line,
            lines[index - 1] ?? '',
            lines[index + 1] ?? '',
            index
          )
        })
      })
    }
  }
  return matches.slice(0, 250)
}

function localSearchItem(
  path: string,
  hunkId: string,
  match: string,
  before: string,
  after: string,
  index: number
): LocalGitReviewSearchItem {
  return {
    path,
    hunkId,
    side: match.startsWith('-') ? 'deletions' : 'additions',
    lineStart: index + 1,
    lineEnd: index + 1,
    patchOffset: index,
    snippet: { before, match, after }
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/"/gu, '\\"')
}

type ReviewNavigationIntent = {
  token: number
  path: string
  sectionKey?: string
  lineStart?: number
  lineEnd?: number
  side?: 'deletions' | 'additions'
}

type ReviewNavigationTarget = Omit<ReviewNavigationIntent, 'token' | 'path'>

type PendingReviewMutation = {
  key: string
  sourceKey: string
  sectionKey: string
  scope: 'section' | 'file' | 'hunk'
  hunkIndex?: number
}

function mutationDescriptor(
  section: Extract<ReviewFileSection, { kind: 'snapshot' }>,
  scope: PendingReviewMutation['scope'],
  hunkIndex?: number
): PendingReviewMutation {
  const sourceKey = `${section.snapshotGeneration}:${JSON.stringify(section.backendSource)}`
  return {
    key: `${scope}:${section.key}:${hunkIndex ?? 'all'}`,
    sourceKey,
    sectionKey: section.key,
    scope,
    ...(hunkIndex === undefined ? {} : { hunkIndex })
  }
}

function mutationsOverlap(left: PendingReviewMutation, right: PendingReviewMutation): boolean {
  if (left.sourceKey !== right.sourceKey) return false
  if (left.scope === 'section' || right.scope === 'section') return true
  if (left.sectionKey !== right.sectionKey) return false
  if (left.scope === 'file' || right.scope === 'file') return true
  return left.hunkIndex === right.hunkIndex
}

function isStaleSnapshotError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /stale(?:-|\s)?snapshot|snapshot.*stale|快照.*过期/iu.test(message)
}

function reviewApplyOrder(source: LocalGitReviewSnapshot['source']): number {
  if (source.type === 'staged') return 0
  if (source.type === 'unstaged') return 1
  return 0
}

function scrollToReviewIntent(intent: ReviewNavigationIntent, onComplete: () => void): () => void {
  let cancelled = false
  let frame = 0
  let attempts = 0
  const tryScroll = (): void => {
    if (cancelled) return
    const file = document.querySelector<HTMLElement>(
      `[data-review-path="${cssEscape(intent.path)}"]`
    )
    if (!file) {
      if (attempts++ < 30) frame = window.requestAnimationFrame(tryScroll)
      return
    }
    if (intent.sectionKey && intent.lineStart && intent.side) {
      const diff = file.querySelector<HTMLElement>(
        `[data-review-file-diff="${cssEscape(intent.sectionKey)}"]`
      )
      const pierre = diff?.querySelector<HTMLElement>('diffs-container')
      const lineType = intent.side === 'additions' ? 'change-addition' : 'change-deletion'
      const line =
        pierre?.shadowRoot?.querySelector<HTMLElement>(
          `[data-${intent.side}] [data-line="${intent.lineStart}"]`
        ) ??
        pierre?.shadowRoot?.querySelector<HTMLElement>(
          `[data-line="${intent.lineStart}"][data-line-type="${lineType}"]`
        ) ??
        pierre?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${intent.lineStart}"]`)
      if (line) {
        line.scrollIntoView({ block: 'center' })
        onComplete()
        return
      }
      if (attempts++ < 30) {
        frame = window.requestAnimationFrame(tryScroll)
        return
      }
    }
    file.scrollIntoView({ block: 'start' })
    onComplete()
  }
  frame = window.requestAnimationFrame(tryScroll)
  return () => {
    cancelled = true
    window.cancelAnimationFrame(frame)
  }
}

function runNextDiffLoad(
  activeLoads: React.MutableRefObject<number>,
  pendingLoads: React.MutableRefObject<Map<string, () => void>>
): void {
  while (activeLoads.current < 4) {
    const next = pendingLoads.current.values().next().value as (() => void) | undefined
    const key = pendingLoads.current.keys().next().value as string | undefined
    if (!next || !key) return
    pendingLoads.current.delete(key)
    next()
  }
}
