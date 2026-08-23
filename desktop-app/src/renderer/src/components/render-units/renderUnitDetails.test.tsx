// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SpecialEntryRenderer } from './renderUnitDetails'
import type { AssistantRenderUnit } from '@/lib/assistantRenderUnits'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const reviewTarget = {
  conversationId: 'conversation',
  threadId: 'thread',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}

const openReview = vi.fn()
const notifyGitOperation = vi.fn()

vi.mock('@/components/local-git-review/LocalGitReviewProvider', () => ({
  useLocalGitReview: () => ({
    target: reviewTarget,
    openReview,
    notifyGitOperation,
    closeReview: vi.fn()
  })
}))

describe('SpecialEntryRenderer turn diff patch actions', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    openReview.mockClear()
    notifyGitOperation.mockClear()
    window.desktopApp = {
      git: {
        applyTurnPatch: vi.fn(async () => ({
          status: 'success',
          appliedPaths: ['notes.txt'],
          skippedPaths: [],
          conflictedPaths: []
        }))
      }
    } as never
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows reapply after undo succeeds', async () => {
    await renderTurnDiff()

    await clickPatchAction('撤销')

    expect(window.desktopApp.git.applyTurnPatch).toHaveBeenCalledWith({
      target: reviewTarget,
      action: 'undo',
      turnId: 'turn-history',
      batches: [
        {
          cwd: '/repo',
          gitRoot: '/repo',
          diff: 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n'
        }
      ]
    })
    expect(patchActionButton('重新应用')).toBeInstanceOf(HTMLButtonElement)
    expect(notifyGitOperation).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Changes reverted'
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows undo after reapply succeeds', async () => {
    await renderTurnDiff()
    await clickPatchAction('撤销')
    ;(window.desktopApp.git.applyTurnPatch as ReturnType<typeof vi.fn>).mockClear()

    await clickPatchAction('重新应用')

    expect(window.desktopApp.git.applyTurnPatch).toHaveBeenCalledWith({
      target: reviewTarget,
      action: 'reapply',
      turnId: 'turn-history',
      batches: [
        {
          cwd: '/repo',
          gitRoot: '/repo',
          diff: 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n'
        }
      ]
    })
    expect(patchActionButton('撤销')).toBeInstanceOf(HTMLButtonElement)
    expect(notifyGitOperation).toHaveBeenCalledWith({
      tone: 'success',
      message: 'Changes reapplied'
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('opens the clicked changed file in the matching turn review', async () => {
    await renderTurnDiff()

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="在审核中查看 notes.txt"]')
        ?.click()
    })

    expect(openReview).toHaveBeenCalledWith(
      { type: 'last-turn', turnId: 'turn-history' },
      {
        turnId: 'turn-history',
        selectedPath: 'notes.txt',
        files: [
          {
            path: 'notes.txt',
            diff: '--- a/notes.txt\n+++ b/notes.txt\n-old\n+new\n',
            additions: 1,
            deletions: 1
          }
        ]
      }
    )
  })

  it('shows failure feedback when undo is rejected', async () => {
    ;(window.desktopApp.git.applyTurnPatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'error',
      errorCode: 'patch-apply-failed',
      appliedPaths: [],
      skippedPaths: ['notes.txt'],
      conflictedPaths: []
    })

    await renderTurnDiff()
    await clickPatchAction('撤销')

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Failed to revert changes'
    )
    expect(notifyGitOperation).toHaveBeenCalledWith({
      tone: 'error',
      message: 'Failed to revert changes'
    })
    expect(patchActionButton('撤销')).toBeInstanceOf(HTMLButtonElement)
  })

  it('shows partial-success feedback when undo only applies some paths', async () => {
    ;(window.desktopApp.git.applyTurnPatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'partial-success',
      errorCode: 'patch-apply-failed',
      appliedPaths: ['notes.txt'],
      skippedPaths: [],
      conflictedPaths: ['src/conflict.ts']
    })

    await renderTurnDiff()
    await clickPatchAction('撤销')

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Applied: notes.txt · Conflicts: src/conflict.ts'
    )
    expect(notifyGitOperation).toHaveBeenCalledWith({
      tone: 'info',
      message: 'Changes partially reverted'
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(patchActionButton('撤销')).toBeInstanceOf(HTMLButtonElement)
  })

  it('shows partial-success feedback when reapply only applies some paths', async () => {
    await renderTurnDiff()
    await clickPatchAction('撤销')
    ;(window.desktopApp.git.applyTurnPatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 'partial-success',
      errorCode: 'patch-apply-failed',
      appliedPaths: ['notes.txt'],
      skippedPaths: ['src/skipped.ts'],
      conflictedPaths: []
    })
    notifyGitOperation.mockClear()

    await clickPatchAction('重新应用')

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Applied: notes.txt · Skipped: src/skipped.ts'
    )
    expect(notifyGitOperation).toHaveBeenCalledWith({
      tone: 'info',
      message: 'Changes partially reapplied'
    })
    expect(patchActionButton('重新应用')).toBeInstanceOf(HTMLButtonElement)
  })

  async function renderTurnDiff(): Promise<void> {
    await act(async () => {
      root.render(<SpecialEntryRenderer unit={turnDiffUnit()} />)
      await Promise.resolve()
    })
  }

  async function clickPatchAction(label: string): Promise<void> {
    await act(async () => {
      patchActionButton(label)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  function patchActionButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label
    )
  }
})

function turnDiffUnit(): Extract<AssistantRenderUnit, { type: 'entry' }> {
  return {
    type: 'entry',
    key: 'turn-diff:turn-history',
    target: { id: 'turn-history', itemIds: ['turn-history'] },
    partIndex: 0,
    partIndices: [0],
    part: {},
    itemType: 'turnDiff',
    renderMode: 'custom',
    item: {
      id: 'turn-diff:turn-history',
      status: 'completed',
      cwd: '/repo',
      patchBatches: [
        {
          cwd: '/repo',
          gitRoot: '/repo',
          diff: 'diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n'
        }
      ],
      files: [{ path: 'notes.txt', diff: '--- a/notes.txt\n+++ b/notes.txt\n-old\n+new\n' }]
    }
  }
}

describe('SpecialEntryRenderer resource availability', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders only local resources confirmed by the host', async () => {
    const listExistingLocalPaths = vi.fn(
      async ({ paths }: { paths: { path: string; cwd?: string }[] }) => ({
        existingPaths: paths.filter(
          (path: { path: string }) => path.path === '/tmp/ai-agent-security-market.html'
        )
      })
    )
    window.desktopApp = { codex: { listExistingLocalPaths } } as never

    await renderResources()

    expect(listExistingLocalPaths).toHaveBeenCalledWith({
      paths: [{ path: '/tmp/ai-agent-security-market.html' }, { path: '/tmp/missing-report.pdf' }]
    })
    expect(container.querySelector('[data-slot="end-resource-cards-unit"]')).not.toBeNull()
    expect(container.textContent).toContain('AI Agent 安全市场')
    expect(container.textContent).not.toContain('不存在的报告')
  })

  it('keeps local resources visible when the host cannot check them', async () => {
    const listExistingLocalPaths = vi.fn(async () => {
      throw new Error('IPC unavailable')
    })
    window.desktopApp = { codex: { listExistingLocalPaths } } as never

    await renderResources()

    expect(container.querySelector('[data-slot="end-resource-cards-unit"]')).not.toBeNull()
    expect(container.textContent).toContain('AI Agent 安全市场')
    expect(container.textContent).toContain('暂时无法确认本地资源，仍可尝试打开。')
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="打开 AI Agent 安全市场"]')
        ?.disabled
    ).toBe(false)
  })

  it('renders each final resource as a separate completed-turn-diff-style card', async () => {
    const listExistingLocalPaths = vi.fn(
      async ({ paths }: { paths: { path: string; cwd?: string }[] }) => ({ existingPaths: paths })
    )
    window.desktopApp = { codex: { listExistingLocalPaths } } as never

    await renderResources(
      resourcesUnit([
        { type: 'file', path: '/tmp/market.csv', title: '市场数据' },
        { type: 'file', path: '/tmp/market.docx', title: '市场报告' }
      ])
    )

    const cards = container.querySelectorAll<HTMLElement>('[data-slot="end-resource-card-unit"]')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.parentElement).toBe(cards[1]?.parentElement)
    expect(cards[0]?.contains(cards[1] ?? null)).toBe(false)
    expect(cards[0]?.className).toContain('rounded-2xl')
    expect(cards[0]?.textContent).toContain('市场数据')
    expect(cards[1]?.textContent).toContain('市场报告')
    expect(cards[0]?.querySelector('[data-slot="card-header"]')).toBeNull()
    expect(cards[0]?.querySelector('[data-slot="card-content"]')).toBeNull()
    expect(cards[0]?.textContent).not.toContain('/tmp/market.csv')
    expect(cards[1]?.textContent).not.toContain('/tmp/market.docx')
    expect(
      cards[0]?.querySelector('[data-slot="resource-file-icon"]')?.getAttribute('data-file-icon')
    ).toBe('spreadsheet')
    expect(
      cards[1]?.querySelector('[data-slot="resource-file-icon"]')?.getAttribute('data-file-icon')
    ).toBe('artifactDocument')
  })

  it('uses the reference file artwork for presentation and PDF resource cards', async () => {
    const listExistingLocalPaths = vi.fn(
      async ({ paths }: { paths: { path: string; cwd?: string }[] }) => ({ existingPaths: paths })
    )
    window.desktopApp = { codex: { listExistingLocalPaths } } as never

    await renderResources(
      resourcesUnit([
        { type: 'file', path: '/tmp/market-analysis.pptx', title: '市场分析' },
        { type: 'file', path: '/tmp/market-analysis.pdf', title: '市场分析 PDF' },
        { type: 'file', path: '/tmp/notes.txt', title: '备注' }
      ])
    )

    const cards = container.querySelectorAll<HTMLElement>('[data-slot="end-resource-card-unit"]')
    expect(
      cards[0]?.querySelector('[data-slot="resource-file-icon"]')?.getAttribute('data-file-icon')
    ).toBe('presentation')
    expect(
      cards[1]?.querySelector('[data-slot="resource-file-icon"]')?.getAttribute('data-file-icon')
    ).toBe('pdf')
    expect(
      cards[2]?.querySelector('[data-slot="resource-file-icon"]')?.getAttribute('data-file-icon')
    ).toBe('document')
  })

  it('uses the reference file-icon mapping for every remaining file category', async () => {
    const listExistingLocalPaths = vi.fn(
      async ({ paths }: { paths: { path: string; cwd?: string }[] }) => ({ existingPaths: paths })
    )
    window.desktopApp = { codex: { listExistingLocalPaths } } as never
    const cases = [
      ['script.ts', 'typescript'],
      ['component.tsx', 'react'],
      ['service.js', 'javascript'],
      ['main.py', 'python'],
      ['server.java', 'java'],
      ['lib.rs', 'rust'],
      ['index.php', 'php'],
      ['styles.scss', 'css'],
      ['native.cpp', 'cplusplus'],
      ['query.sql', 'code'],
      ['config.json', 'json'],
      ['guide.md', 'document'],
      ['notes.txt', 'document'],
      ['page.html', 'html'],
      ['settings.yml', 'yaml'],
      ['workspace.toml', 'toml'],
      ['analysis.ipynb', 'notebook'],
      ['deploy.sh', 'shell'],
      ['Dockerfile', 'terminal'],
      ['logo.png', 'image'],
      ['build.gradle', 'build'],
      ['release.sha256', 'hashes'],
      ['bundle.tgz', 'folder'],
      ['SKILL.md', 'skill'],
      ['unknown.bin', 'file']
    ] as const

    await renderResources(
      resourcesUnit([
        ...cases.map(([name]) => ({ type: 'file', path: `/tmp/${name}`, title: name })),
        {
          type: 'file',
          path: '/tmp/no-extension',
          title: 'text MIME fallback',
          mimeType: 'text/plain'
        },
        {
          type: 'file',
          path: '/tmp/no-extension',
          title: 'image MIME fallback',
          mimeType: 'image/png'
        },
        {
          type: 'file',
          path: '/tmp/no-extension',
          title: 'archive MIME fallback',
          mimeType: 'application/gzip'
        }
      ])
    )

    const icons = Array.from(container.querySelectorAll('[data-slot="resource-file-icon"]'))
    expect(icons.map((icon) => icon.getAttribute('data-file-icon'))).toEqual([
      ...cases.map(([, kind]) => kind),
      'document',
      'image',
      'folder'
    ])
  })

  it('checks more than 64 local resources in separate host requests', async () => {
    const listExistingLocalPaths = vi.fn(
      async ({ paths }: { paths: { path: string; cwd?: string }[] }) => ({ existingPaths: paths })
    )
    window.desktopApp = { codex: { listExistingLocalPaths } } as never
    const resources = Array.from({ length: 65 }, (_, index) => ({
      type: 'file',
      path: `/tmp/report-${index}.pdf`,
      title: `报告 ${index}`
    }))

    await renderResources(resourcesUnit(resources))

    expect(listExistingLocalPaths).toHaveBeenCalledTimes(2)
    expect(listExistingLocalPaths.mock.calls.map(([input]) => input.paths)).toHaveLength(2)
    expect(listExistingLocalPaths.mock.calls[0]?.[0].paths).toHaveLength(64)
    expect(listExistingLocalPaths.mock.calls[1]?.[0].paths).toHaveLength(1)
  })

  async function renderResources(unit = endResourcesUnit()): Promise<void> {
    await act(async () => {
      root.render(<SpecialEntryRenderer unit={unit} />)
      await Promise.resolve()
      await Promise.resolve()
    })
  }
})

function endResourcesUnit(): Extract<AssistantRenderUnit, { type: 'entry' }> {
  return resourcesUnit([
    {
      type: 'website',
      path: '/tmp/ai-agent-security-market.html',
      line: 1,
      title: 'AI Agent 安全市场'
    },
    { type: 'file', path: '/tmp/missing-report.pdf', title: '不存在的报告' }
  ])
}

function resourcesUnit(
  resources: readonly unknown[]
): Extract<AssistantRenderUnit, { type: 'entry' }> {
  return {
    type: 'entry',
    key: 'end-resources:generated-files',
    target: { id: 'end-resources:generated-files', itemIds: ['generated-files'] },
    partIndex: 0,
    partIndices: [0],
    part: { type: 'endResources' },
    itemType: 'endResources',
    renderMode: 'custom',
    item: {
      id: 'end-resources:generated-files',
      type: 'endResources',
      status: 'completed',
      resources
    }
  }
}
