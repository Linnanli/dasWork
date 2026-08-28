import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import {
  attachDiagnostics,
  cleanupTempDirs,
  closeApp,
  collectRendererLogs,
  launchApp
} from './support/app'
import { createLocalProject, sendComposerMessage } from './support/chatActions'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

const execFile = promisify(execFileCallback)

test('RW-E2E-01 opens task, timeline, outputs, sources, and processes from a real local conversation', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-right-workspace-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('right-workspace-thread', 'right-workspace-message', 'Thread ready')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Right workspace ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open the right workspace acceptance test.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Thread ready')
    await openRightWorkspace(page)

    await expect(page.getByRole('button', { name: 'Open Files', exact: true })).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-01-launcher')

    await page.getByRole('button', { name: 'Open Files', exact: true }).click()
    await expect(page.getByText('只读预览')).toBeVisible()
    await expect(page.getByRole('tablist', { name: 'Workspace tabs' })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible()
    await expect
      .poll(() =>
        page
          .locator('file-tree-container')
          .evaluate((element) => element.getBoundingClientRect().height)
      )
      .toBeGreaterThan(0)
    await captureWorkspaceScreenshot(page, testInfo, 'RW-03-files')

    await openWorkspaceMenuItem(page, 'Browser')
    await expect(page.getByRole('textbox', { name: 'Browser address' })).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-04-browser-empty')

    await openWorkspaceMenuItem(page, 'Terminal')
    await expect(page.locator('.xterm')).toBeVisible()
    const terminalInput = page.locator('.xterm-helper-textarea')
    await terminalInput.focus()
    await page.keyboard.type('printf terminal-ready')
    await page.keyboard.press('Enter')
    await expect(page.locator('.xterm')).toContainText('terminal-ready')
    await expectWorkspaceLayout(page)
    await captureWorkspaceScreenshot(page, testInfo, 'RW-02-terminal')

    await openWorkspaceMenuItem(page, 'Review')
    await expect(page.locator('[data-slot="review-workspace"]')).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-05-review')

    await openWorkspaceMenuItem(page, 'Task')
    await expect(page.locator('[data-slot="workspace-task-summary"]')).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-07-task-summary')
    const taskProcess = page.locator('[data-slot="workspace-task-process"]')
    await expect(taskProcess).toContainText('运行中')
    await taskProcess.getByRole('button', { name: '打开输出' }).click()
    await expect(page.locator('.xterm')).toBeVisible()

    await openWorkspaceMenuItem(page, 'Timeline')
    await expect(page.locator('[data-slot="workspace-timeline"]')).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-08-timeline')

    await openWorkspaceMenuItem(page, 'Outputs')
    await expect(page.locator('[data-slot="workspace-outputs"]')).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-09-outputs')

    await openWorkspaceMenuItem(page, 'Sources')
    await expect(page.locator('[data-slot="workspace-sources"]')).toBeVisible()
    await expect(page.getByText('这个任务还没有可显示的来源。')).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-10-sources')

    await openWorkspaceMenuItem(page, 'Processes')
    await expect(page.locator('[data-slot="workspace-processes"]')).toBeVisible()
    await expect(page.locator('[data-slot="workspace-process"]')).toContainText('运行中')
    await page.getByRole('button', { name: '停止全部运行进程', exact: true }).click()
    await expect(page.locator('[data-slot="workspace-stop-all-processes-dialog"]')).toBeVisible()
    await page.getByRole('button', { name: '停止全部', exact: true }).click()
    await expect(page.locator('[data-slot="workspace-process"]')).toContainText('已退出')
    await captureWorkspaceScreenshot(page, testInfo, 'RW-11-processes')

    await page.setViewportSize({ width: 1_100, height: 800 })
    await page.getByRole('button', { name: '最大化工作区', exact: true }).click()
    await expect(page.locator('[data-slot="right-workspace-shell"]')).toHaveClass(/absolute/)
    await captureWorkspaceScreenshot(page, testInfo, 'RW-12-maximized-workspace')
    await page.getByRole('button', { name: '恢复工作区宽度', exact: true }).click()
    await page.getByRole('tab', { name: 'Files', exact: true }).click()
    await expect(page.getByText('只读预览')).toBeVisible()
    await captureWorkspaceScreenshot(page, testInfo, 'RW-06-narrow-files')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('RW-E2E-02 keeps the shared workspace toggle stable during width transitions', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await page.waitForTimeout(250)

    const openingSamples = await sampleWorkspaceTransition(page, '打开工作区')
    expectMonotonicTransitionWidths(openingSamples, 'opening')
    expectStableTogglePosition(openingSamples)

    const closingSamples = await sampleWorkspaceTransition(page, '关闭工作区')
    expectMonotonicTransitionWidths(closingSamples, 'closing')
    expectStableTogglePosition(closingSamples)
  } finally {
    await closeApp(app)
    await backend.close()
  }
})

test('RW-E2E-03 keeps a terminal session alive when its tab moves between panels', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-terminal-panels-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('terminal-panels-thread', 'terminal-panels-message', 'Ready')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Terminal panels ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open terminal before moving the tab.')
    await openRightWorkspace(page)
    await openWorkspaceMenuItem(page, 'Terminal')
    const firstStarted = await startVisibleTerminalIfAvailable(page)
    test.skip(!firstStarted, 'Terminal native module is unavailable in this E2E environment')
    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    const terminalSessionId = await activeTerminalSessionId(rightPanel)

    await typeVisibleTerminalCommand(page, 'echo RW_E2E_03_BEFORE_MOVE')
    await expectTerminalSnapshot(page, terminalSessionId, ['RW_E2E_03_BEFORE_MOVE'])

    await page.getByRole('button', { name: '打开底部工作区', exact: true }).click()
    const bottomPanel = page.locator('[data-slot="bottom-workspace-shell"]')
    await expect(bottomPanel).toBeVisible()
    await page.waitForTimeout(250)

    await dragActiveTabToPanel(page, rightPanel, bottomPanel)
    await expect(
      bottomPanel.locator(`[role="tab"][data-workspace-tab-id="terminal:${terminalSessionId}"]`)
    ).toBeVisible()
    await expect(rightPanel.getByRole('tab')).toHaveCount(0)
    expect(await activeTerminalSessionId(bottomPanel)).toBe(terminalSessionId)
    await expectTerminalSnapshot(page, terminalSessionId, ['RW_E2E_03_BEFORE_MOVE'])

    await typeVisibleTerminalCommand(page, 'echo RW_E2E_03_AFTER_BOTTOM_MOVE')
    await expectTerminalSnapshot(page, terminalSessionId, [
      'RW_E2E_03_BEFORE_MOVE',
      'RW_E2E_03_AFTER_BOTTOM_MOVE'
    ])
    await captureWorkspaceScreenshot(page, testInfo, 'RW-07-terminal-panel-move')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('RW-E2E-06 restores the same terminal session and tail after renderer reload', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-terminal-reload-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('terminal-reload-thread', 'terminal-reload-message', 'Ready')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    let page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Terminal reload ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open terminal before reloading the renderer.')
    await openRightWorkspace(page)
    await openWorkspaceMenuItem(page, 'Terminal')
    const firstStarted = await startVisibleTerminalIfAvailable(page)
    test.skip(!firstStarted, 'Terminal native module is unavailable in this E2E environment')
    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    const terminalSessionId = await activeTerminalSessionId(rightPanel)

    await typeVisibleTerminalCommand(page, 'echo RW_E2E_06_BEFORE_RELOAD')
    await expectTerminalSnapshot(page, terminalSessionId, ['RW_E2E_06_BEFORE_RELOAD'])

    await page.reload()
    page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await expect(page.locator('[data-slot="right-workspace-shell"]')).toBeVisible()
    await expect(
      page.locator(`[role="tab"][data-workspace-tab-id="terminal:${terminalSessionId}"]`)
    ).toBeVisible()
    await expect(page.locator('.xterm')).toBeVisible()
    await expectTerminalSnapshot(page, terminalSessionId, ['RW_E2E_06_BEFORE_RELOAD'])

    await typeVisibleTerminalCommand(page, 'echo RW_E2E_06_AFTER_RELOAD')
    await expectTerminalSnapshot(page, terminalSessionId, [
      'RW_E2E_06_BEFORE_RELOAD',
      'RW_E2E_06_AFTER_RELOAD'
    ])
    await captureWorkspaceScreenshot(page, testInfo, 'RW-09-terminal-reload')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('RW-E2E-07 keeps task A terminal output continuous after switching A to B and back', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-terminal-task-switch-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('terminal-task-a-thread', 'terminal-task-a-message', 'Task A ready'),
      assistantMessageResponse('terminal-task-b-thread', 'terminal-task-b-message', 'Task B ready')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Terminal task switch ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Task A terminal continuity.')
    const taskAConversation = sidebarConversationButton(page, 'Task A terminal continuity.')
    await expect(taskAConversation).toBeVisible()
    await openRightWorkspace(page)
    await openWorkspaceMenuItem(page, 'Terminal')
    const firstStarted = await startVisibleTerminalIfAvailable(page)
    test.skip(!firstStarted, 'Terminal native module is unavailable in this E2E environment')
    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    const taskASessionId = await activeTerminalSessionId(rightPanel)
    await typeVisibleTerminalCommand(page, 'echo RW_E2E_07_TASK_A_FIRST')
    await expectTerminalSnapshot(page, taskASessionId, ['RW_E2E_07_TASK_A_FIRST'])

    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(taskAConversation).toBeVisible()
    await sendComposerMessage(page, 'Task B terminal continuity.')
    await expect(sidebarConversationButton(page, 'Task B terminal continuity.')).toBeVisible()
    await openRightWorkspace(page)
    await openWorkspaceMenuItem(page, 'Terminal')
    const secondStarted = await startVisibleTerminalIfAvailable(page)
    test.skip(!secondStarted, 'Terminal native module is unavailable in this E2E environment')
    const taskBSessionId = await activeTerminalSessionId(rightPanel)
    expect(taskBSessionId).not.toBe(taskASessionId)
    await typeVisibleTerminalCommand(page, 'echo RW_E2E_07_TASK_B_ONLY')
    await expectTerminalSnapshot(page, taskBSessionId, ['RW_E2E_07_TASK_B_ONLY'])

    await taskAConversation.click()
    await expect(
      page.locator(`[role="tab"][data-workspace-tab-id="terminal:${taskASessionId}"]`)
    ).toBeVisible()
    await expectTerminalSnapshot(
      page,
      taskASessionId,
      ['RW_E2E_07_TASK_A_FIRST'],
      ['RW_E2E_07_TASK_B_ONLY']
    )
    await typeVisibleTerminalCommand(page, 'echo RW_E2E_07_TASK_A_SECOND')
    await expectTerminalSnapshot(
      page,
      taskASessionId,
      ['RW_E2E_07_TASK_A_FIRST', 'RW_E2E_07_TASK_A_SECOND'],
      ['RW_E2E_07_TASK_B_ONLY']
    )
    await captureWorkspaceScreenshot(page, testInfo, 'RW-10-terminal-task-switch')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('RW-E2E-08 isolates output between multiple terminal sessions', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-terminal-isolation-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('terminal-isolation-thread', 'terminal-isolation-message', 'Ready')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Terminal isolation ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open isolated terminals.')
    await openRightWorkspace(page)
    await openWorkspaceMenuItem(page, 'Terminal')
    const firstStarted = await startVisibleTerminalIfAvailable(page)
    test.skip(!firstStarted, 'Terminal native module is unavailable in this E2E environment')
    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    const firstSessionId = await activeTerminalSessionId(rightPanel)
    await typeVisibleTerminalCommand(page, 'echo RW_E2E_08_FIRST_ONLY')
    await expectTerminalSnapshot(page, firstSessionId, ['RW_E2E_08_FIRST_ONLY'])

    await openWorkspaceMenuItem(page, 'Terminal')
    const secondSessionId = await waitForActiveTerminalSessionChange(rightPanel, firstSessionId)
    expect(secondSessionId).not.toBe(firstSessionId)
    await typeVisibleTerminalCommand(page, 'echo RW_E2E_08_SECOND_ONLY')
    await expectTerminalSnapshot(
      page,
      secondSessionId,
      ['RW_E2E_08_SECOND_ONLY'],
      ['RW_E2E_08_FIRST_ONLY']
    )
    await expectTerminalSnapshot(
      page,
      firstSessionId,
      ['RW_E2E_08_FIRST_ONLY'],
      ['RW_E2E_08_SECOND_ONLY']
    )
    await captureWorkspaceScreenshot(page, testInfo, 'RW-11-terminal-isolation')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('RW-E2E-04 replaces the empty Files tab, then reuses preview file tabs', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-workspace-preview-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('workspace-preview-thread', 'workspace-preview-message', 'Ready')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1_500, height: 900 })
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Workspace preview ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open files for preview replacement.')
    await openRightWorkspace(page)
    await page.getByRole('button', { name: 'Open Files', exact: true }).click()
    await page.getByRole('button', { name: '最大化工作区', exact: true }).click()

    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    const sourceTreeItem = rightPanel.getByRole('treeitem', { name: 'src', exact: true })
    await sourceTreeItem.click()
    const fixtureTreeItem = rightPanel.getByRole('treeitem', { name: 'fixture.ts', exact: true })
    await expect(fixtureTreeItem).toBeVisible()
    await fixtureTreeItem.click()
    await expectWorkspaceTab(rightPanel, 'fixture.ts', { preview: false })
    await expect(rightPanel.getByRole('tab', { name: 'Files', exact: true })).toHaveCount(0)
    await expect(rightPanel.getByRole('tab')).toHaveCount(1)
    await expect(rightPanel.locator('[data-workspace-code-preview="pierre"]')).toBeVisible()
    await expect(rightPanel.locator('diffs-container pre')).toContainText(
      'export const workspace = false'
    )

    await rightPanel.getByRole('treeitem', { name: 'second.ts', exact: true }).click()
    await expectWorkspaceTab(rightPanel, 'fixture.ts', { preview: false })
    await expectWorkspaceTab(rightPanel, 'second.ts', { preview: true })
    await expect(rightPanel.getByRole('tab')).toHaveCount(2)

    await rightPanel.getByRole('treeitem', { name: 'README.md', exact: true }).click()
    await expectWorkspaceTab(rightPanel, 'fixture.ts', { preview: false })
    await expectWorkspaceTab(rightPanel, 'README.md', { preview: true })
    await expect(rightPanel.getByRole('tab', { name: 'second.ts', exact: true })).toHaveCount(0)
    await expect(rightPanel.getByRole('tab')).toHaveCount(2)
    await captureWorkspaceScreenshot(page, testInfo, 'RW-08-preview-pin')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('RW-E2E-05 asks before closing a running terminal from its tab close control', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-terminal-close-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'workspace-terminal-close-thread',
        'workspace-terminal-close-message',
        'Ready'
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(
      page,
      `Workspace terminal close ${Date.now().toString(36)}`,
      projectRoot
    )
    await sendComposerMessage(page, 'Open terminal close guard.')
    await openRightWorkspace(page)

    await openWorkspaceMenuItem(page, 'Terminal')
    const firstStarted = await startVisibleTerminalIfAvailable(page)
    test.skip(!firstStarted, 'Terminal native module is unavailable in this E2E environment')
    const terminalTabId = await page
      .locator('[data-slot="right-workspace-shell"] [role="tab"][aria-selected="true"]')
      .getAttribute('data-workspace-tab-id')
    if (!terminalTabId) throw new Error('Missing terminal tab id')

    await openWorkspaceMenuItem(page, 'Browser')
    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    const terminalCloseLabel = await rightPanel
      .locator(`[data-workspace-tab-id="${terminalTabId}"]`)
      .first()
      .evaluate((tab) => {
        const label = tab.parentElement
          ?.querySelector<HTMLButtonElement>('button[aria-label^="关闭"]')
          ?.getAttribute('aria-label')
        if (!label) throw new Error('Missing terminal tab close control')
        return label
      })
    const closeTerminal = rightPanel.getByRole('button', { name: terminalCloseLabel, exact: true })
    await expect(rightPanel.getByRole('tab')).toHaveCount(2)

    await closeTerminal.click()
    await expect(page.getByRole('dialog', { name: '关闭正在运行的终端？' })).toBeVisible()
    await expect(page.getByText('关闭该标签会终止正在运行的终端进程。')).toBeVisible()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(rightPanel.getByRole('tab')).toHaveCount(2)

    await closeTerminal.click()
    await page.getByRole('button', { name: '关闭终端', exact: true }).click()
    await expect(rightPanel.getByRole('tab', { name: 'New tab', exact: true })).toBeVisible()
    await expect(rightPanel.getByRole('tab')).toHaveCount(1)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

type WorkspaceTransitionSample = {
  width: number
  actionSlotWidth: number
  toggleLeft: number
  toggleTop: number
}

async function sampleWorkspaceTransition(
  page: Page,
  toggleLabel: string
): Promise<WorkspaceTransitionSample[]> {
  return page.evaluate(async (label) => {
    const toggle = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (!toggle) throw new Error(`Missing workspace toggle: ${label}`)

    toggle.click()
    const samples: WorkspaceTransitionSample[] = []
    const startedAt = performance.now()

    await new Promise<void>((resolve) => {
      const sampleFrame = (): void => {
        const workspace = document.querySelector<HTMLElement>('[data-slot="right-workspace-shell"]')
        const currentToggle = document.querySelector<HTMLElement>('[data-slot="workspace-toggle"]')
        const actionSlot = document.querySelector<HTMLElement>(
          '[data-slot="workspace-header-actions"] > div'
        )
        const toggleBounds = currentToggle?.getBoundingClientRect()
        samples.push({
          width: workspace?.getBoundingClientRect().width ?? 0,
          actionSlotWidth: actionSlot?.getBoundingClientRect().width ?? 0,
          toggleLeft: toggleBounds?.left ?? 0,
          toggleTop: toggleBounds?.top ?? 0
        })
        if (performance.now() - startedAt >= 320) {
          resolve()
          return
        }
        window.setTimeout(sampleFrame, 16)
      }
      sampleFrame()
    })

    return samples
  }, toggleLabel)
}

function expectMonotonicTransitionWidths(
  samples: WorkspaceTransitionSample[],
  direction: 'opening' | 'closing'
): void {
  expect(samples.length).toBeGreaterThan(5)
  expectMonotonicValues(
    samples.map((sample) => sample.width),
    direction
  )
  expectMonotonicValues(
    samples.map((sample) => sample.actionSlotWidth),
    direction
  )
}

function expectMonotonicValues(values: number[], direction: 'opening' | 'closing'): void {
  const subpixelAnimationTolerance = 1
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (direction === 'opening') {
      expect(current).toBeGreaterThanOrEqual(previous - subpixelAnimationTolerance)
    } else {
      expect(current).toBeLessThanOrEqual(previous + subpixelAnimationTolerance)
    }
  }
}

function expectStableTogglePosition(samples: WorkspaceTransitionSample[]): void {
  const first = samples[0]
  for (const sample of samples.slice(1)) {
    expect(Math.abs(sample.toggleLeft - first.toggleLeft)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(sample.toggleTop - first.toggleTop)).toBeLessThanOrEqual(0.5)
  }
}

async function initializeProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, 'src'), { recursive: true })
  await writeFile(join(projectRoot, 'README.md'), '# Right workspace\n', 'utf8')
  await writeFile(join(projectRoot, 'src', 'fixture.ts'), 'export const workspace = true\n', 'utf8')
  await writeFile(join(projectRoot, 'src', 'second.ts'), 'export const second = true\n', 'utf8')
  await execFile('git', ['init'], { cwd: projectRoot })
  await execFile('git', ['config', 'user.email', 'e2e@example.test'], { cwd: projectRoot })
  await execFile('git', ['config', 'user.name', 'E2E'], { cwd: projectRoot })
  await execFile('git', ['add', '.'], { cwd: projectRoot })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: projectRoot })
  await writeFile(
    join(projectRoot, 'src', 'fixture.ts'),
    'export const workspace = false\n',
    'utf8'
  )
}

async function openRightWorkspace(page: Page): Promise<void> {
  const closeToggle = page.getByRole('button', { name: '关闭工作区', exact: true })
  const openToggle = page.getByRole('button', { name: '打开工作区', exact: true })
  await expect(openToggle).toBeVisible()
  await openToggle.click()
  await expect(closeToggle).toBeVisible()
}

function sidebarConversationButton(page: Page, title: string): Locator {
  return page
    .locator('[data-slot="codex-sidebar"]')
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}`) })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

async function openWorkspaceMenuItem(page: Page, label: string): Promise<void> {
  const menuTrigger = page.getByRole('button', { name: 'Open workspace tab', exact: true })
  if (await menuTrigger.isVisible().catch(() => false)) {
    await menuTrigger.click()
    await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
    return
  }

  const launcherLabels: Record<string, string> = {
    Task: '任务',
    Timeline: '时间线',
    Sources: '来源',
    Processes: '进程',
    Review: '审阅',
    Terminal: '终端',
    Browser: '浏览器',
    Files: 'Open Files'
  }
  const launcherLabel = launcherLabels[label] ?? label
  await page
    .getByRole('button', {
      name: label === 'Files' ? launcherLabel : new RegExp(`^${launcherLabel}`)
    })
    .click()
}

async function expectWorkspaceTab(
  panel: Locator,
  name: string,
  options: { preview: boolean }
): Promise<void> {
  const tab = panel.getByRole('tab', { name, exact: true })
  await expect(tab).toBeVisible()
  await expect(tab).toHaveAttribute('data-workspace-tab', 'true')
  await expect(tab.locator('xpath=..')).toHaveAttribute('data-preview', String(options.preview))
}

async function startVisibleTerminalIfAvailable(page: Page): Promise<boolean> {
  const xterm = page.locator('.xterm')
  const unavailable = page.getByText(/终端原生模块不可用|无法启动终端|node-pty/u)
  return Promise.race([
    xterm.waitFor({ state: 'visible', timeout: 7_500 }).then(() => true),
    unavailable.waitFor({ state: 'visible', timeout: 7_500 }).then(() => false)
  ])
}

async function activeTerminalSessionId(panel: Locator): Promise<string> {
  const tabId = await panel
    .locator('[role="tab"][aria-selected="true"][data-workspace-tab-id^="terminal:"]')
    .getAttribute('data-workspace-tab-id')
  if (!tabId?.startsWith('terminal:')) throw new Error('Missing active terminal tab id')
  return tabId.slice('terminal:'.length)
}

async function waitForActiveTerminalSessionChange(
  panel: Locator,
  previousSessionId: string
): Promise<string> {
  await expect
    .poll(async () => activeTerminalSessionId(panel), { timeout: 10_000 })
    .not.toBe(previousSessionId)
  return activeTerminalSessionId(panel)
}

async function typeVisibleTerminalCommand(page: Page, command: string): Promise<void> {
  const terminalInput = page.locator('.xterm-helper-textarea').last()
  await terminalInput.focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function expectTerminalSnapshot(
  page: Page,
  sessionId: string,
  expectedFragments: string[],
  forbiddenFragments: string[] = []
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const snapshot = await window.desktopApp.workspace.terminal.snapshot({
            version: 2,
            sessionId: id
          })
          return snapshot.output
        }, sessionId),
      { timeout: 10_000 }
    )
    .toEqual(expect.stringContaining(expectedFragments.at(-1) ?? ''))

  const output = await page.evaluate(async (id) => {
    const snapshot = await window.desktopApp.workspace.terminal.snapshot({
      version: 2,
      sessionId: id
    })
    return snapshot.output
  }, sessionId)
  for (const fragment of expectedFragments) expect(output).toContain(fragment)
  for (const fragment of forbiddenFragments) expect(output).not.toContain(fragment)
}

async function dragActiveTabToPanel(
  page: Page,
  sourcePanel: Locator,
  destinationPanel: Locator
): Promise<void> {
  const sourceTab = sourcePanel.locator('[role="tab"][aria-selected="true"]').first()
  const sourceBox = await sourceTab.boundingBox()
  const destinationBox = await destinationPanel.boundingBox()
  if (!sourceBox || !destinationBox) throw new Error('Missing workspace drag targets')
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(
    destinationBox.x + destinationBox.width / 2,
    destinationBox.y + destinationBox.height / 2,
    { steps: 6 }
  )
  await page.mouse.up()
}

async function expectWorkspaceLayout(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const workspace = document.querySelector<HTMLElement>('[data-slot="right-workspace-shell"]')
    const workspaceRow = document.querySelector<HTMLElement>(
      '[data-slot="conversation-workspace-row"]'
    )
    const thread = document.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')
    return {
      workspaceWidth: workspace?.getBoundingClientRect().width ?? 0,
      workspaceRowWidth: workspaceRow?.getBoundingClientRect().width ?? 0,
      threadWidth: thread?.getBoundingClientRect().width ?? 0
    }
  })

  expect(layout.workspaceWidth).toBeGreaterThan(0)
  expect(layout.workspaceWidth).toBeLessThanOrEqual(layout.workspaceRowWidth * 0.7 + 1)
  expect(layout.threadWidth).toBeGreaterThan(300)
}

async function captureWorkspaceScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { contentType: 'image/png', path })
}
