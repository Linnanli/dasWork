// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  LocalGitChangeEvent,
  LocalGitReviewFile,
  LocalGitReviewSearchItem,
  LocalGitReviewSearchResult,
  LocalGitReviewSnapshot,
  LocalGitReviewSource
} from '../../../../../shared/localGitApi'
import type { LocalGitReviewLastTurn } from '../../local-git-review/LocalGitReviewProvider'
import { ReviewWorkspace } from './ReviewWorkspace'
import { reviewWorkspacePreferencesKey } from './reviewWorkspaceStore'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const target = {
  conversationId: 'conversation',
  threadId: 'thread',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}

let reviewSource: LocalGitReviewSource = { type: 'unstaged' }
let reviewOpenIntent: { type: 'uncommitted'; token: number } | undefined
let lastTurn: LocalGitReviewLastTurn | undefined
const setReviewSource = vi.fn()
const acknowledgeReviewOpenIntent = vi.fn((token: number) => {
  if (reviewOpenIntent?.token === token) reviewOpenIntent = undefined
})
const notifyGitOperation = vi.fn()
const pierreFileDiffRender = vi.hoisted(() => vi.fn())
const pierreLineScroll = vi.hoisted(() => vi.fn())
const pierreProcessFile = vi.hoisted(() =>
  vi.fn(
    (
      diff: string,
      options?: {
        oldFile?: { contents: string }
        newFile?: { contents: string }
      }
    ) => {
      const name = diff.includes('b/src/a.ts') ? 'src/a.ts' : 'README.md'
      const additionLines = [options?.newFile?.contents ?? 'after\n']
      const deletionLines = [options?.oldFile?.contents ?? 'before\n']
      return {
        name,
        additionLines,
        deletionLines,
        hunks: [
          {
            additionStart: 1,
            additionCount: 1,
            additionLineIndex: 0,
            deletionStart: 1,
            deletionCount: 1,
            deletionLineIndex: 0,
            hunkContent: [
              {
                type: 'change' as const,
                additions: 1,
                deletions: 1,
                additionLineIndex: 0,
                deletionLineIndex: 0
              }
            ]
          }
        ]
      }
    }
  )
)
const pierreTreeResetPaths = vi.hoisted(() => vi.fn())
const pierreTreeSelectPath = vi.hoisted(() => vi.fn())
const pierreTreeDeselectPath = vi.hoisted(() => vi.fn())
const pierreTreeSelectedPaths = vi.hoisted(() => ({ current: [] as readonly string[] }))
const scrollIntoView = vi.fn()

vi.mock('@/components/local-git-review/LocalGitReviewProvider', () => ({
  useLocalGitReview: () => ({
    target,
    source: reviewSource,
    lastTurn,
    reviewOpenIntent,
    setReviewSource,
    notifyGitOperation,
    startGitWorkflow: () => true,
    updateGitWorkflow: () => undefined,
    finishGitWorkflow: () => undefined,
    acknowledgeReviewOpenIntent,
    getGitWorkflow: () => undefined
  })
}))

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: (props: { fileDiff: { name: string }; selectedLines?: unknown }) => {
    pierreFileDiffRender(props)
    return createElement(
      'diffs-container',
      {
        'data-testid': 'pierre-file-diff',
        ref: (element: HTMLElement | null) => {
          if (!element || element.shadowRoot) return
          const shadow = element.attachShadow({ mode: 'open' })
          const additions = document.createElement('div')
          additions.dataset.additions = ''
          const line = document.createElement('div')
          line.dataset.line = '1'
          line.dataset.lineType = 'change-addition'
          Object.defineProperty(line, 'scrollIntoView', { value: pierreLineScroll })
          additions.appendChild(line)
          shadow.appendChild(additions)
        }
      },
      props.fileDiff.name
    )
  }
}))

vi.mock('@pierre/diffs', () => ({
  processFile: pierreProcessFile
}))

vi.mock('./ReviewRichPreview', () => ({
  ReviewRichPreview: () => null
}))

vi.mock('@pierre/trees/react', () => ({
  FileTree: ({ model }: { model: { paths: readonly string[] } }) => (
    <div role="tree">
      {model.paths
        .filter((path) => !path.endsWith('/'))
        .map((path) => (
          <div role="treeitem" key={path}>
            {path}
          </div>
        ))}
    </div>
  ),
  useFileTree: (options: {
    paths: readonly string[]
    onSelectionChange(paths: readonly string[]): void
  }) => ({
    model: {
      paths: options.paths,
      resetPaths: pierreTreeResetPaths,
      setGitStatus: vi.fn(),
      setSearch: vi.fn(),
      getSelectedPaths: vi.fn(() => pierreTreeSelectedPaths.current),
      getItem: vi.fn((path: string) => ({
        deselect: () => pierreTreeDeselectPath(path),
        select: () => pierreTreeSelectPath(path),
        isDirectory: () => path.endsWith('/')
      })),
      scrollToPath: vi.fn()
    }
  })
}))

describe('ReviewWorkspace', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    reviewSource = { type: 'unstaged' }
    reviewOpenIntent = undefined
    lastTurn = undefined
    setReviewSource.mockClear()
    acknowledgeReviewOpenIntent.mockClear()
    notifyGitOperation.mockClear()
    pierreFileDiffRender.mockClear()
    pierreLineScroll.mockClear()
    pierreProcessFile.mockClear()
    pierreTreeResetPaths.mockClear()
    pierreTreeSelectPath.mockClear()
    pierreTreeDeselectPath.mockClear()
    pierreTreeSelectedPaths.current = []
    scrollIntoView.mockClear()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(performance.now())
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) }
    })
    window.desktopApp = {
      git: {
        getReviewSnapshot: vi.fn(async ({ source }) => snapshotFor(source)),
        getFileDiff: vi.fn(async ({ file }) => ({
          status: 'ready' as const,
          snapshotGeneration: 'generation',
          file,
          diff: `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1 +1 @@\n-before\n+after\n`,
          truncated: false,
          binary: false,
          conflicted: false
        })),
        getReviewDiffFileContents: vi.fn(async () => ({
          status: 'text',
          before: 'before\n',
          after: 'after\n'
        })),
        getTurnDiffFileContents: vi.fn(async () => ({
          status: 'text',
          before: 'before\n',
          after: 'after\n'
        })),
        searchReview: vi.fn(async ({ source, snapshotGeneration, query }) => ({
          snapshotGeneration,
          source,
          items: query
            ? [
                {
                  path: 'src/a.ts',
                  hunkId: '@@ -1 +1 @@',
                  side: 'additions',
                  lineStart: 1,
                  lineEnd: 1,
                  patchOffset: 0,
                  snippet: { before: '', match: '+after', after: '' }
                }
              ]
            : [],
          totalMatches: query ? 1 : 0,
          isCapped: false
        })),
        applyReviewAction: vi.fn(async () => ({
          status: 'success',
          appliedPaths: ['src/a.ts'],
          skippedPaths: [],
          conflictedPaths: []
        })),
        getReviewApplyCommand: vi.fn(async ({ source, snapshotGeneration }) => ({
          snapshotGeneration,
          source,
          command: `${source.type}-command`
        })),
        listCommits: vi.fn(async () => []),
        listBranches: vi.fn(async () => ({
          current: 'feature/review',
          defaultBase: 'main',
          local: ['main'],
          recent: [],
          uncommittedFileCount: 0
        })),
        subscribe: vi.fn(() => () => undefined)
      }
    } as never
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('loads staged and unstaged snapshots for the renderer-only uncommitted source', async () => {
    await renderReview()

    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledWith({
      target,
      source: { type: 'unstaged' }
    })
    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledWith({
      target,
      source: { type: 'staged' }
    })
    expect(container.textContent).toContain('未提交')
    expect(container.textContent).toContain('src/a.ts')
    expect(container.textContent).toContain('README.md')
  })

  it('selects only the file requested by a last-turn review', async () => {
    reviewSource = { type: 'last-turn', turnId: 'turn-1' }
    lastTurn = {
      turnId: 'turn-1',
      selectedPath: 'README.md',
      files: [
        { path: 'src/a.ts', additions: 2, deletions: 1, diff: 'diff --git a/src/a.ts b/src/a.ts' },
        {
          path: 'README.md',
          additions: 1,
          deletions: 0,
          diff: 'diff --git a/README.md b/README.md'
        }
      ]
    }
    const storageKey = reviewWorkspacePreferencesKey({
      hostId: target.hostId,
      repository: target.gitRoot,
      workspaceId: 'review'
    })
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        source: reviewSource,
        diffMode: 'unified',
        lineDiffType: 'word',
        wrap: false,
        ignoreWhitespace: false,
        fullFiles: false,
        richPreview: false,
        skipRevertConfirmation: false,
        treeVisible: true,
        treeWidth: 280,
        treeFilter: '',
        collapsedKeys: ['README.md']
      })
    )

    pierreTreeSelectedPaths.current = ['README.md']
    await renderReview()

    const selectedFile = container.querySelector<HTMLElement>('[data-review-path="README.md"]')
    const otherFile = container.querySelector<HTMLElement>('[data-review-path="src/a.ts"]')
    expect(selectedFile?.classList.contains('ring-1')).toBe(true)
    expect(selectedFile?.classList.contains('ring-ring/35')).toBe(true)
    expect(selectedFile?.querySelector('[data-testid="pierre-file-diff"]')).not.toBeNull()
    expect(otherFile?.querySelector('[data-testid="pierre-file-diff"]')).toBeNull()
    expect(window.desktopApp.git.getReviewSnapshot).not.toHaveBeenCalled()
    expect(pierreTreeSelectPath).toHaveBeenLastCalledWith('README.md')

    lastTurn = { ...lastTurn, selectedPath: 'src/a.ts' }
    pierreTreeSelectedPaths.current = ['README.md']
    await renderReview()

    expect(pierreTreeDeselectPath).toHaveBeenLastCalledWith('README.md')
    expect(pierreTreeSelectPath).toHaveBeenLastCalledWith('src/a.ts')
  })

  it('finishes the initial snapshot before applying a matching Git change refresh', async () => {
    let resolveSnapshots: (() => void) | undefined
    let notifyGitChange: ((event: LocalGitChangeEvent) => void) | undefined
    const snapshotsReady = new Promise<void>((resolve) => {
      resolveSnapshots = resolve
    })
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockImplementation(async ({ source }) => {
      await snapshotsReady
      return snapshotFor(source)
    })
    vi.mocked(window.desktopApp.git.subscribe).mockImplementation((listener) => {
      notifyGitChange = listener
      return () => undefined
    })

    await renderReview()
    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledTimes(2)

    await act(async () => {
      notifyGitChange?.({
        target,
        snapshotGeneration: 'changed-generation',
        changeTypes: ['working-tree']
      })
      await Promise.resolve()
    })

    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolveSnapshots?.()
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      await Promise.resolve()
    })

    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledTimes(4)
    expect(container.textContent).toContain('src/a.ts')
  })

  it('collapses stale file-diff replies into one snapshot refresh', async () => {
    vi.mocked(window.desktopApp.git.getFileDiff)
      .mockResolvedValueOnce({ status: 'stale' })
      .mockResolvedValueOnce({ status: 'stale' })
      .mockResolvedValueOnce({ status: 'stale' })

    await renderReview()

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      await Promise.resolve()
    })

    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledTimes(4)
    expect(container.textContent).not.toContain('Git snapshot became stale')
  })

  it('discards an unusable snapshot when its stale refresh fails', async () => {
    let snapshotRequests = 0
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockImplementation(async ({ source }) => {
      snapshotRequests += 1
      if (snapshotRequests > 2) throw new Error('refresh unavailable')
      return snapshotFor(source)
    })
    vi.mocked(window.desktopApp.git.getFileDiff).mockResolvedValueOnce({ status: 'stale' })

    await renderReview()

    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain('refresh unavailable'))
    })

    expect(container.textContent).not.toContain('Loading review...')
  })

  it('consumes an uncommitted open intent and overrides a persisted branch review source once', async () => {
    const storageKey = reviewWorkspacePreferencesKey({
      hostId: target.hostId,
      repository: target.gitRoot,
      workspaceId: 'review'
    })
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        source: { type: 'branch', baseBranch: 'feature/old' },
        diffMode: 'unified',
        lineDiffType: 'word',
        wrap: false,
        ignoreWhitespace: false,
        fullFiles: false,
        richPreview: false,
        skipRevertConfirmation: false,
        treeVisible: true,
        treeWidth: 280,
        treeFilter: '',
        collapsedKeys: []
      })
    )
    reviewOpenIntent = { type: 'uncommitted', token: 7 }

    await renderReview()

    expect(acknowledgeReviewOpenIntent).toHaveBeenCalledWith(7)
    expect(container.textContent).toContain('未提交')
    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledWith({
      target,
      source: { type: 'unstaged' }
    })
    expect(window.desktopApp.git.getReviewSnapshot).toHaveBeenCalledWith({
      target,
      source: { type: 'staged' }
    })
    expect(window.desktopApp.git.getReviewSnapshot).not.toHaveBeenCalledWith({
      target,
      source: { type: 'branch', branch: 'feature/old' }
    })
  })

  it('consumes each uncommitted intent token once across repeated renders', async () => {
    acknowledgeReviewOpenIntent.mockImplementation(() => undefined)
    reviewOpenIntent = { type: 'uncommitted', token: 11 }

    await renderReview()
    reviewOpenIntent = { type: 'uncommitted', token: 11 }
    await renderReview()

    expect(acknowledgeReviewOpenIntent).toHaveBeenCalledTimes(1)

    reviewOpenIntent = { type: 'uncommitted', token: 12 }
    await renderReview()

    expect(acknowledgeReviewOpenIntent).toHaveBeenCalledTimes(2)
    expect(acknowledgeReviewOpenIntent).toHaveBeenLastCalledWith(12)
  })

  it('expands review file-tree directories by default', async () => {
    await renderReview()

    expect(pierreTreeResetPaths).toHaveBeenLastCalledWith(
      expect.arrayContaining(['README.md', 'src/', 'src/a.ts']),
      { initialExpandedPaths: ['src/'] }
    )
  })

  it('toggles all review file sections between expanded and collapsed', async () => {
    await renderReview()

    const collapseAll = container.querySelector<HTMLButtonElement>('[aria-label="折叠全部文件"]')
    expect(collapseAll).not.toBeNull()
    expect(
      container.querySelectorAll('[aria-label="展开全部文件"], [aria-label="折叠全部文件"]')
    ).toHaveLength(1)
    expect(collapseAll?.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      collapseAll?.click()
      await Promise.resolve()
    })

    const expandAll = container.querySelector<HTMLButtonElement>('[aria-label="展开全部文件"]')
    expect(expandAll).not.toBeNull()
    expect(
      container.querySelectorAll('[aria-label="展开全部文件"], [aria-label="折叠全部文件"]')
    ).toHaveLength(1)
    expect(expandAll?.getAttribute('aria-pressed')).toBe('false')

    await act(async () => {
      expandAll?.click()
      await Promise.resolve()
    })

    expect(container.querySelector('[aria-label="折叠全部文件"]')).not.toBeNull()
  })

  it('filters the Pierre tree locally without loading another snapshot', async () => {
    await renderReview()
    const callsBeforeFilter = vi.mocked(window.desktopApp.git.getReviewSnapshot).mock.calls.length
    const input = container.querySelector<HTMLInputElement>('[aria-label="筛选文件"]')

    await act(async () => {
      if (!input) throw new Error('Expected file filter input')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'readme')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(vi.mocked(window.desktopApp.git.getReviewSnapshot).mock.calls.length).toBe(
      callsBeforeFilter
    )
    expect(container.textContent).toContain('README.md')
  })

  it('preserves a pending tree filter when the file tree is hidden and shown again', async () => {
    await renderReview()
    const input = container.querySelector<HTMLInputElement>('[aria-label="筛选文件"]')

    await act(async () => {
      if (!input) throw new Error('Expected file filter input')
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'readme')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      container.querySelector<HTMLButtonElement>('[aria-label="隐藏文件树"]')?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 450))
      container.querySelector<HTMLButtonElement>('[aria-label="显示文件树"]')?.click()
      await Promise.resolve()
    })

    expect(container.querySelector<HTMLInputElement>('[aria-label="筛选文件"]')?.value).toBe(
      'readme'
    )
  })

  it('keeps review content search separate from the tree filter', async () => {
    vi.mocked(window.desktopApp.git.searchReview).mockImplementation(
      async ({ source, snapshotGeneration, query }) => ({
        snapshotGeneration,
        source,
        items: source.type === 'unstaged' && query ? [searchItem('src/a.ts', 1)] : [],
        totalMatches: source.type === 'unstaged' && query ? 1 : 0,
        isCapped: false
      })
    )
    await renderReview()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-slot="review-workspace"]')?.focus()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="在审阅中查找"]')
    expect(input).not.toBeNull()
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, 'after')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
      expect(container.textContent).toContain('查找中')
      await new Promise((resolve) => window.setTimeout(resolve, 220))
    })

    expect(window.desktopApp.git.searchReview).toHaveBeenCalledWith({
      target,
      source: { type: 'unstaged' },
      snapshotGeneration: 'unstaged-generation',
      query: 'after'
    })
    expect(window.desktopApp.git.searchReview).toHaveBeenCalledWith({
      target,
      source: { type: 'staged' },
      snapshotGeneration: 'staged-generation',
      query: 'after'
    })
    expect(pierreFileDiffRender).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedLines: { start: 1, end: 1, side: 'additions', endSide: 'additions' }
      })
    )
    expect(pierreLineScroll).toHaveBeenCalledWith({ block: 'center' })
  })

  it('discards a late search response immediately after the query is cleared', async () => {
    let resolveLateSearch: ((result: LocalGitReviewSearchResult) => void) | undefined
    vi.mocked(window.desktopApp.git.searchReview).mockImplementation(
      ({ source, snapshotGeneration }) => {
        if (source.type === 'unstaged') {
          return new Promise((resolve) => {
            resolveLateSearch = resolve
          })
        }
        return Promise.resolve({
          snapshotGeneration,
          source,
          items: [],
          totalMatches: 0,
          isCapped: false
        })
      }
    )
    await renderReview()
    await openReviewSearch('late')
    const input = container.querySelector<HTMLInputElement>('input[aria-label="在审阅中查找"]')

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, '')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      resolveLateSearch?.({
        snapshotGeneration: 'unstaged-generation',
        source: { type: 'unstaged' },
        items: [searchItem('src/a.ts', 1)],
        totalMatches: 1,
        isCapped: false
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(
      pierreFileDiffRender.mock.calls.some(
        ([props]) => props.selectedLines !== null && props.selectedLines !== undefined
      )
    ).toBe(false)
  })

  it('loads and scrolls to a file selected from the jump menu', async () => {
    await renderReview()

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="跳转到文件"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const readmeOption = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-content"][data-state="open"] [role="option"]'
      )
    ].find((option) => option.textContent?.includes('README.md'))
    expect(readmeOption).toBeDefined()
    await act(async () => {
      readmeOption?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 100))
    })

    expect(container.querySelector('[data-review-path="README.md"]')?.className).toContain('ring-1')
    expect(scrollIntoView).toHaveBeenCalled()
    expect(container.querySelector('[data-review-path="README.md"]')).not.toBeNull()
  })

  it('re-fetches diffs with the fixed whitespace option', async () => {
    await renderReview()
    vi.mocked(window.desktopApp.git.getFileDiff).mockClear()

    await selectReviewOption('忽略空白差异')
    await act(async () => {
      await vi.waitFor(() => expect(window.desktopApp.git.getFileDiff).toHaveBeenCalled())
    })
    expect(window.desktopApp.git.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ options: { ignoreWhitespace: true, fullFiles: false } })
    )
  })

  it('keeps diff patches bounded when full-file context is enabled', async () => {
    await renderReview()
    await selectReviewOption('显示完整文件上下文')
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    expect(
      vi
        .mocked(window.desktopApp.git.getFileDiff)
        .mock.calls.every(([request]) => request.options?.fullFiles === false)
    ).toBe(true)
    expect(pierreProcessFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        oldFile: expect.objectContaining({ contents: 'before\n' }),
        newFile: expect.objectContaining({ contents: 'after\n' })
      })
    )
  })

  it('copies staged then unstaged apply commands generated by Main', async () => {
    await renderReview()

    await selectReviewOption('复制 git apply 命令')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.desktopApp.git.getReviewApplyCommand).toHaveBeenNthCalledWith(1, {
      target,
      source: { type: 'staged' },
      snapshotGeneration: 'staged-generation'
    })
    expect(window.desktopApp.git.getReviewApplyCommand).toHaveBeenNthCalledWith(2, {
      target,
      source: { type: 'unstaged' },
      snapshotGeneration: 'unstaged-generation'
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('staged-command\n\nunstaged-command')
  })

  it('skips empty snapshot sources when copying apply commands', async () => {
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockImplementation(async ({ source }) => ({
      ...snapshotFor(source),
      files: source.type === 'staged' ? [] : snapshotFor(source).files,
      stagedFileCount: 0
    }))
    await renderReview()

    await selectReviewOption('复制 git apply 命令')
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.desktopApp.git.getReviewApplyCommand).toHaveBeenCalledTimes(1)
    expect(window.desktopApp.git.getReviewApplyCommand).toHaveBeenCalledWith({
      target,
      source: { type: 'unstaged' },
      snapshotGeneration: 'unstaged-generation'
    })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('unstaged-command')
  })

  it('loads still-unrendered known match files without pretending to paginate past the cap', async () => {
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockImplementation(async ({ source }) => ({
      ...snapshotFor(source),
      files:
        source.type === 'unstaged'
          ? Array.from({ length: 6 }, (_, index) =>
              file(`src/file-${index}.ts`, `revision-${index}`, 1, 0)
            )
          : [],
      stagedFileCount: 0,
      unstagedFileCount: source.type === 'unstaged' ? 6 : 0
    }))
    vi.mocked(window.desktopApp.git.searchReview).mockImplementation(
      async ({ source, snapshotGeneration, query }) => ({
        snapshotGeneration,
        source,
        items:
          source.type === 'unstaged' && query
            ? [searchItem('src/file-0.ts', 1), searchItem('src/file-5.ts', 6)]
            : [],
        totalMatches: source.type === 'unstaged' && query ? 300 : 0,
        isCapped: source.type === 'unstaged' && Boolean(query)
      })
    )
    await renderReview()
    vi.mocked(window.desktopApp.git.getFileDiff).mockClear()

    await openReviewSearch('needle')

    expect(container.textContent).toContain('仅显示前 250 个，共 300 个')
    const loadMore = buttonWithText('加载更多匹配项')
    expect(loadMore).toBeDefined()
    await act(async () => {
      loadMore?.click()
      await Promise.resolve()
    })
    expect(window.desktopApp.git.getFileDiff).toHaveBeenCalledWith(
      expect.objectContaining({ file: expect.objectContaining({ path: 'src/file-5.ts' }) })
    )
  })

  it('P004-EDGE-02 renders an empty repository snapshot and keeps review controls available', async () => {
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockResolvedValue({
      snapshotGeneration: 'empty-generation',
      gitRoot: '/repo',
      source: { type: 'unstaged' },
      files: [],
      stagedFileCount: 0,
      unstagedFileCount: 0,
      largeDiff: false
    })

    await renderReview()

    expect(container.textContent).toContain('No changes to review.')
    expect(container.querySelector('[aria-label="刷新更改"]')).not.toBeNull()
  })

  it('P004-EDGE-04/P004-EDGE-05/P004-EDGE-06/P004-EDGE-07/P004-EDGE-08/P004-EDGE-12 renders file paths and rename origins without section labels', async () => {
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockImplementation(async ({ source }) => ({
      snapshotGeneration: `${source.type}-generation`,
      gitRoot: '/repo',
      source,
      files:
        source.type === 'unstaged'
          ? [
              {
                ...file('renamed.txt', 'renamed', 1, 1),
                previousPath: 'notes.txt',
                changeKind: 'renamed' as const
              },
              {
                ...file('copied.txt', 'copied', 1, 0),
                previousPath: 'notes.txt',
                changeKind: 'copied' as const
              },
              { ...file('typed.txt', 'typed', 0, 0), changeKind: 'type-change' as const },
              { ...file('image.bin', 'binary', 0, 0), binary: true },
              { ...file('vendor/submodule', 'gitlink', 0, 0), binary: true },
              {
                ...file('conflicted.txt', 'conflict', 0, 0),
                conflicted: true,
                changeKind: 'unmerged' as const
              }
            ]
          : [],
      stagedFileCount: 0,
      unstagedFileCount: source.type === 'unstaged' ? 6 : 0,
      largeDiff: false
    }))
    vi.mocked(window.desktopApp.git.getFileDiff).mockImplementation(async ({ file }) => ({
      status: 'ready' as const,
      snapshotGeneration: 'generation',
      file: {
        path: file.path,
        changeKind: 'modified',
        revision: file.revision,
        additions: 0,
        deletions: 0,
        binary: false,
        conflicted: false
      },
      diff: `diff --git a/${file.path} b/${file.path}\n`,
      truncated: false,
      binary: file.path === 'image.bin' || file.path === 'vendor/submodule',
      conflicted: file.path === 'conflicted.txt'
    }))

    await renderReview()
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('来自 notes.txt')
    expect(container.textContent).toContain('image.bin')
    expect(container.textContent).toContain('vendor/submodule')
    expect(container.textContent).not.toContain('已重命名')
    expect(container.textContent).not.toContain('已复制')
    expect(container.textContent).not.toContain('类型已变更')
    expect(container.textContent).toContain('此文件存在冲突，暂不渲染文本差异。')
  })

  it('locks only the overlapping file while its mutation is pending', async () => {
    let resolveMutation:
      | ((value: {
          status: 'error'
          errorCode: string
          appliedPaths: string[]
          skippedPaths: string[]
          conflictedPaths: string[]
        }) => void)
      | undefined
    vi.mocked(window.desktopApp.git.applyReviewAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        })
    )
    await renderReview()
    const stageButtons = buttonsWithLabel('暂存未暂存文件')
    expect(stageButtons).toHaveLength(2)

    await act(async () => {
      stageButtons[0]?.click()
      await Promise.resolve()
    })

    expect(stageButtons[0]?.disabled).toBe(true)
    expect(stageButtons[1]?.disabled).toBe(false)
    await act(async () => {
      resolveMutation?.({
        status: 'error',
        errorCode: 'expected-test-error',
        appliedPaths: [],
        skippedPaths: [],
        conflictedPaths: []
      })
      await Promise.resolve()
    })
    expect(stageButtons[0]?.disabled).toBe(false)
  })

  it('P004-EDGE-09/P004-EDGE-10 keeps stale writes frozen until a refresh succeeds and never retries the write', async () => {
    vi.mocked(window.desktopApp.git.applyReviewAction).mockResolvedValue({
      status: 'error',
      errorCode: 'stale-snapshot',
      appliedPaths: [],
      skippedPaths: [],
      conflictedPaths: []
    })
    await renderReview()
    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockRejectedValue(
      new Error('refresh failed')
    )

    await act(async () => {
      buttonWithLabel('暂存未暂存文件')?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(window.desktopApp.git.applyReviewAction).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('审阅快照已过期')
    expect(buttonsWithLabel('暂存未暂存文件').every((button) => button.disabled)).toBe(true)
    expect(container.textContent).toContain('src/a.ts')

    vi.mocked(window.desktopApp.git.getReviewSnapshot).mockImplementation(async ({ source }) =>
      snapshotFor(source)
    )
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="刷新更改"]')?.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.textContent).not.toContain('审阅快照已过期')
    expect(buttonsWithLabel('暂存未暂存文件').some((button) => !button.disabled)).toBe(true)
    expect(window.desktopApp.git.applyReviewAction).toHaveBeenCalledTimes(1)
  })

  it('P004-EDGE-13 keeps partial-success feedback with applied and conflict paths', async () => {
    vi.mocked(window.desktopApp.git.applyReviewAction).mockResolvedValue({
      status: 'partial-success',
      appliedPaths: ['src/a.ts'],
      skippedPaths: [],
      conflictedPaths: ['README.md']
    })
    await renderReview()

    await act(async () => buttonWithLabel('暂存未暂存文件')?.click())
    await Promise.resolve()

    expect(notifyGitOperation).toHaveBeenCalledWith({
      tone: 'info',
      message: '已应用：src/a.ts；冲突：README.md'
    })
  })

  async function renderReview(): Promise<void> {
    await act(async () => {
      root.render(<ReviewWorkspace />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      await Promise.resolve()
    })
  }

  async function selectReviewOption(text: string): Promise<void> {
    await act(async () => {
      const trigger = container.querySelector<HTMLButtonElement>('[aria-label="审阅选项"]')
      if (trigger?.dataset.state !== 'open') {
        trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      }
      await Promise.resolve()
      await Promise.resolve()
    })
    const item = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-slot="dropdown-menu-content"][data-state="open"] [role="menuitem"]'
      )
    ].find((candidate) => candidate.textContent?.trim().includes(text))
    if (!item) throw new Error(`Expected review option: ${text}`)
    await act(async () => {
      item.click()
      await Promise.resolve()
    })
  }

  async function openReviewSearch(query: string): Promise<void> {
    await act(async () => {
      container.querySelector<HTMLElement>('[data-slot="review-workspace"]')?.focus()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))
      await Promise.resolve()
    })
    const input = container.querySelector<HTMLInputElement>('input[aria-label="在审阅中查找"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(input, query)
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 220))
      await Promise.resolve()
    })
  }
})

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text
  )
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
  return buttonsWithLabel(label)[0]
}

function buttonsWithLabel(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.getAttribute('aria-label') === label
  )
}

function snapshotFor(source: LocalGitReviewSource): LocalGitReviewSnapshot {
  return {
    snapshotGeneration: `${source.type}-generation`,
    gitRoot: '/repo',
    source,
    files:
      source.type === 'unstaged'
        ? [file('src/a.ts', 'unstaged-revision', 2, 1), file('README.md', 'readme-revision', 1, 0)]
        : [file('src/a.ts', 'staged-revision', 1, 0)],
    stagedFileCount: source.type === 'staged' ? 1 : 0,
    unstagedFileCount: source.type === 'unstaged' ? 2 : 0,
    largeDiff: false
  }
}

function searchItem(path: string, line: number): LocalGitReviewSearchItem {
  return {
    path,
    hunkId: '@@ -1 +1 @@',
    side: 'additions' as const,
    lineStart: line,
    lineEnd: line,
    patchOffset: line,
    snippet: { before: '', match: '+needle', after: '' }
  }
}

function file(
  path: string,
  revision: string,
  additions: number,
  deletions: number
): LocalGitReviewFile {
  return {
    path,
    changeKind: 'modified' as const,
    revision,
    additions,
    deletions,
    binary: false,
    conflicted: false
  }
}
