import { describe, expect, it } from 'vitest'

import type { AssistantRenderUnit } from './assistantRenderUnits'
import {
  buildComposerDiffStatus,
  buildComposerPlanStatus,
  buildComposerTurnStatus,
  countTurnDiffLines,
  isComposerStatusRenderUnit,
  normalizeTodoItems,
  parseTurnDiffFiles,
  turnDiffLineTotals,
  withoutComposerStatusRenderUnits
} from './composerTurnStatus'

describe('buildComposerPlanStatus', () => {
  it('normalizes step shapes and selects the first in-progress step', () => {
    const plan = buildComposerPlanStatus({
      items: [
        { text: 'Inspect contract', status: 'done' },
        { title: 'Patch renderer', status: 'in_progress' },
        { content: 'Run tests', status: 'pending' }
      ]
    })

    expect(plan).toMatchObject({
      steps: [
        { label: 'Inspect contract', status: 'completed' },
        { label: 'Patch renderer', status: 'in-progress' },
        { label: 'Run tests', status: 'pending' }
      ],
      completedSteps: 1,
      totalSteps: 3,
      currentStep: 2
    })
    expect(plan?.progressPercent).toBeCloseTo(100 / 3)
  })

  it('uses the first pending step when none is active and the last step when all are complete', () => {
    expect(
      buildComposerPlanStatus({
        tasks: [
          { label: 'One', status: 'complete' },
          { label: 'Two', status: 'pending' },
          { label: 'Three' }
        ]
      })?.currentStep
    ).toBe(2)

    expect(
      buildComposerPlanStatus({
        todos: [
          { label: 'One', status: 'completed' },
          { label: 'Two', status: 'completed' }
        ]
      })
    ).toMatchObject({ currentStep: 2, completedSteps: 2, progressPercent: 100 })
  })

  it('does not create a plan for an empty update', () => {
    expect(buildComposerPlanStatus({ items: [] })).toBeUndefined()
  })

  it('exposes the normalized items for rich renderers to reuse', () => {
    expect(normalizeTodoItems({ items: [{ status: { type: 'inProgress' } }] })).toEqual([
      { label: '任务 1', status: 'in-progress' }
    ])
  })
})

describe('buildComposerDiffStatus', () => {
  it('counts changed files and lines in a multi-file unified diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '-old',
      '+new',
      '+again',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '-removed',
      '+added'
    ].join('\n')

    expect(buildComposerDiffStatus({ diff })).toEqual({
      filesChanged: 2,
      additions: 3,
      deletions: 2
    })
  })

  it('merges repeated unified-diff sections for the same path', () => {
    const diff = [
      'diff --git a/src/created.ts b/src/created.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/created.ts',
      '@@ -0,0 +1 @@',
      '+temporary',
      'diff --git a/src/created.ts b/src/created.ts',
      '--- a/src/created.ts',
      '+++ b/src/created.ts',
      '@@ -1 +1 @@',
      '-temporary',
      '+final'
    ].join('\n')

    const files = parseTurnDiffFiles({ diff })

    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'src/created.ts', added: 2, removed: 1 })
    expect(buildComposerDiffStatus({ diff })).toEqual({
      filesChanged: 1,
      additions: 2,
      deletions: 1
    })
  })

  it('sorts changed files by path like the live turn diff tracker', () => {
    const diff = [
      'diff --git a/z-last.ts b/z-last.ts',
      '--- a/z-last.ts',
      '+++ b/z-last.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      'diff --git a/a-first.ts b/a-first.ts',
      '--- a/a-first.ts',
      '+++ b/a-first.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new'
    ].join('\n')

    expect(parseTurnDiffFiles({ diff }).map((file) => file.path)).toEqual([
      'a-first.ts',
      'z-last.ts'
    ])
  })

  it('uses explicit file statistics and falls back to each file patch', () => {
    const item = {
      changes: [
        { path: 'a.ts', additions: 4, deletions: 2 },
        { path: 'b.ts', patch: '--- a/b.ts\n+++ b/b.ts\n+new\n' }
      ]
    }
    const files = parseTurnDiffFiles(item)

    expect(files).toEqual([
      { path: 'a.ts', diff: undefined, added: 4, removed: 2 },
      {
        path: 'b.ts',
        diff: '--- a/b.ts\n+++ b/b.ts\n+new\n',
        added: 1,
        removed: 0
      }
    ])
    expect(turnDiffLineTotals(files)).toEqual({ additions: 5, deletions: 2 })
    expect(buildComposerDiffStatus(item)).toEqual({
      filesChanged: 2,
      additions: 5,
      deletions: 2
    })
  })

  it('does not create a diff summary when the update has no changes', () => {
    expect(buildComposerDiffStatus({ diff: '   ' })).toBeUndefined()
    expect(buildComposerDiffStatus({ files: [] })).toBeUndefined()
  })

  it('keeps an explicit changed file even when its patch has no line totals', () => {
    expect(buildComposerDiffStatus({ files: [{ path: 'renamed.ts' }] })).toEqual({
      filesChanged: 1,
      additions: 0,
      deletions: 0
    })
  })

  it('counts header-looking content inside a unified diff hunk', () => {
    expect(
      countTurnDiffLines(
        [
          '--- a/example.ts',
          '+++ b/example.ts',
          '@@ -1 +1 @@',
          '--- removed content',
          '+++ added content'
        ].join('\n')
      )
    ).toEqual({ added: 1, removed: 1 })
  })
})

describe('buildComposerTurnStatus', () => {
  it('uses the latest plan and diff entries and lets empty updates clear older values', () => {
    const oldPlan = entryUnit('old-plan', 'todoList', {
      items: [{ label: 'Old plan', status: 'inProgress' }]
    })
    const oldDiff = entryUnit('old-diff', 'turnDiff', {
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+added\n'
    })
    const newPlan = entryUnit('new-plan', 'todo-list', {
      items: [{ label: 'New plan', status: 'running' }]
    })
    const clearedDiff = entryUnit('cleared-diff', 'turn-diff', { diff: '' })

    expect(buildComposerTurnStatus([oldPlan, oldDiff, newPlan, clearedDiff])).toEqual({
      plan: {
        steps: [{ label: 'New plan', status: 'in-progress' }],
        completedSteps: 0,
        totalSteps: 1,
        currentStep: 1,
        progressPercent: 0
      },
      diff: undefined
    })
    expect(isComposerStatusRenderUnit(newPlan)).toBe(true)
    expect(isComposerStatusRenderUnit(textUnit())).toBe(false)
  })

  it('keeps completed turn diffs visible in the completed assistant message', () => {
    const completedDiff = entryUnit('completed-diff', 'turnDiff', {
      status: 'completed',
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+added\n'
    })

    expect(isComposerStatusRenderUnit(completedDiff)).toBe(false)
    expect(withoutComposerStatusRenderUnits([completedDiff])).toEqual([completedDiff])
  })

  it('can keep the last in-progress diff after the assistant message completes', () => {
    const latestDiff = entryUnit('latest-diff', 'turnDiff', {
      status: 'inProgress',
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+added\n'
    })

    expect(withoutComposerStatusRenderUnits([latestDiff])).toEqual([])
    expect(withoutComposerStatusRenderUnits([latestDiff], { keepTurnDiff: true })).toEqual([
      latestDiff
    ])
  })

  it('returns undefined when no plan or diff status is available', () => {
    expect(buildComposerTurnStatus([textUnit()])).toBeUndefined()
  })

  it('recursively removes status entries while preserving other reasoning children', () => {
    const status = entryUnit('nested-plan', 'todoList', {
      items: [{ label: 'Nested plan', status: 'running' }]
    })
    const text = textUnit()
    const mixedGroup = reasoningGroup('mixed', [status, text])
    const statusOnlyGroup = reasoningGroup('status-only', [status])
    const semanticEmptyGroup = reasoningGroup('already-empty', [])

    expect(
      withoutComposerStatusRenderUnits([mixedGroup, statusOnlyGroup, semanticEmptyGroup])
    ).toEqual([{ ...mixedGroup, children: [text] }, semanticEmptyGroup])
  })

  it('removes status entries nested more than one reasoning level deep', () => {
    const nestedStatus = entryUnit('deep-plan', 'todoList', {
      items: [{ label: 'Deep plan', status: 'running' }]
    })
    const text = textUnit()
    const nestedGroup = reasoningGroup('outer', [
      reasoningGroup('middle', [reasoningGroup('inner', [nestedStatus, text])])
    ])
    const visible = withoutComposerStatusRenderUnits([nestedGroup])

    expect(buildComposerTurnStatus(visible)).toBeUndefined()
    expect(JSON.stringify(visible)).not.toContain('Deep plan')
    expect(JSON.stringify(visible)).toContain('Hello')
  })
})

function entryUnit(
  key: string,
  itemType: string,
  item: Record<string, unknown>
): Extract<AssistantRenderUnit, { type: 'entry' }> {
  return {
    type: 'entry',
    key,
    partIndices: [0],
    partIndex: 0,
    part: {},
    target: { id: key, itemIds: [key] },
    itemType,
    item,
    renderMode: 'custom'
  }
}

function textUnit(): Extract<AssistantRenderUnit, { type: 'text' }> {
  return {
    type: 'text',
    key: 'text',
    partIndices: [0],
    partIndex: 0,
    target: { id: 'text', itemIds: [] },
    text: 'Hello'
  }
}

function reasoningGroup(
  key: string,
  children: readonly AssistantRenderUnit[]
): Extract<AssistantRenderUnit, { type: 'reasoning-group' }> {
  return {
    type: 'reasoning-group',
    key,
    partIndices: [],
    target: { id: key, itemIds: [] },
    children,
    state: 'thinking',
    turnRunning: true,
    hasFinalAnswerStarted: false,
    canCollapse: false,
    defaultExpanded: true,
    expanded: true,
    forceExpanded: true
  }
}
