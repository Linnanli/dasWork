import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import {
  appRoot,
  attachDiagnostics,
  closeApp,
  collectRendererLogs,
  launchApp,
  repoRoot
} from './support/app'
import {
  createLocalProject,
  expectConversationInAuthoritativeList,
  sendComposerMessage,
  sendMessage
} from './support/chatActions'
import {
  assistantMessageResponse,
  providerResponseBodies,
  startMockBackend
} from './support/mockBackend'

test('switches projects from the left sidebar project list', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [assistantMessageResponse('resp-sidebar-switch', 'msg-sidebar-switch', 'ok')]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    const runId = Date.now().toString(36)
    const firstProjectName = `E2E Sidebar Alpha ${runId}`
    const secondProjectName = `E2E Sidebar Beta ${runId}`
    await createLocalProject(page, firstProjectName, appRoot)
    await createLocalProject(page, secondProjectName, repoRoot)
    await expect(page.locator('[data-slot="composer-project-card"]')).toContainText(
      secondProjectName
    )

    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByText(firstProjectName, { exact: true })
      .click()

    await expect(page.locator('[data-slot="composer-project-card"]')).toContainText(
      firstProjectName
    )
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('opens a sidebar conversation and continues the same desktop thread', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const firstPrompt = `sidebar-history-${runId}`
  const secondPrompt = `sidebar-continued-${runId}`
  const firstResponse = `sidebar restored response ${runId}`
  const secondResponse = `sidebar continued response ${runId}`
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'resp-sidebar-history-first',
        'msg-sidebar-history-first',
        firstResponse
      ),
      assistantMessageResponse(
        'resp-sidebar-history-second',
        'msg-sidebar-history-second',
        secondResponse
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, firstPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse }).first()
    ).toBeVisible()
    await expect(page.locator('[data-slot="composer-project-card-shell"]')).toHaveCount(0)

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await expect(sidebar.getByText(firstPrompt, { exact: true })).toBeVisible()

    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(page.locator('[data-role="user"]').filter({ hasText: firstPrompt })).toHaveCount(0)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse }).first()
    ).toHaveCount(0)

    await sidebar.getByText(firstPrompt, { exact: true }).click()
    await expect(page.locator('[data-role="user"]')).toContainText(firstPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse }).first()
    ).toBeVisible()
    await expect(page.locator('[data-slot="composer-project-card-shell"]')).toHaveCount(0)

    await sendComposerMessage(page, secondPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: secondResponse })
    ).toBeVisible()

    const providerBodies = providerResponseBodies(backend)
    expect(providerBodies).toHaveLength(2)
    const resumedInput = JSON.stringify(providerBodies[1])
    expect(resumedInput).toContain(firstPrompt)
    expect(resumedInput).toContain(firstResponse)
    expect(resumedInput).toContain(secondPrompt)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('renames, pins, archives, searches, and restores a sidebar task through its menu', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const initialTitle = `sidebar-menu-${runId}`
  const renamedTitle = `sidebar-menu-renamed-${runId}`
  const backend = await startMockBackend({
    responses: [assistantMessageResponse('resp-sidebar-menu', 'msg-sidebar-menu', 'done')]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, initialTitle)
    await expect(page.locator('[data-role="assistant"]').filter({ hasText: 'done' })).toBeVisible()

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    const openMenu = async (title: string): Promise<void> => {
      const row = sidebar.getByRole('button', { name: title, exact: true }).locator('..')
      await row.hover()
      await row.getByRole('button', { name: `更多操作：${title}` }).click()
    }

    await openMenu(initialTitle)
    await page.getByRole('menuitem', { name: '重命名' }).click()
    await page.getByRole('textbox', { name: '任务名称' }).fill(renamedTitle)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(sidebar.getByRole('button', { name: renamedTitle, exact: true })).toBeVisible()

    await openMenu(renamedTitle)
    await page.getByRole('menuitem', { name: '置顶' }).click()
    await expect(
      sidebar
        .getByRole('button', { name: renamedTitle, exact: true })
        .locator('svg[aria-label="已置顶"]')
    ).toHaveCount(1)

    await openMenu(renamedTitle)
    await page.getByRole('menuitem', { name: '归档任务' }).click()
    await expect(sidebar.getByRole('button', { name: renamedTitle, exact: true })).toHaveCount(0)

    const taskSearch = sidebar.getByRole('searchbox', { name: '搜索所有任务' })
    await taskSearch.fill(renamedTitle)
    await expect(
      sidebar
        .locator('[data-slot="sidebar-task-search-results"]')
        .getByRole('button', { name: renamedTitle, exact: true })
    ).toBeVisible()
    await taskSearch.fill('')

    const archivedChats = sidebar.locator('[data-slot="archived-chats"]')
    await archivedChats.locator('summary').click()
    const archiveSearch = archivedChats.getByRole('searchbox', { name: '搜索已归档任务' })
    await archiveSearch.fill('no-match')
    await expect(archivedChats.getByText('没有匹配的归档任务。')).toBeVisible()
    await archiveSearch.fill(renamedTitle)
    await expect(
      archivedChats.getByRole('button', { name: renamedTitle, exact: true })
    ).toBeVisible()
    await openMenu(renamedTitle)
    await page.getByRole('menuitem', { name: '恢复任务' }).click()
    await expect(sidebar.getByRole('button', { name: renamedTitle, exact: true })).toBeVisible()
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('keeps sidebar projects and conversations after a renderer reload', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const projectName = `E2E Reload Project ${runId}`
  const firstPrompt = `reload-history-${runId}`
  const firstResponse = `reload restored response ${runId}`
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('resp-reload-history', 'msg-reload-history', firstResponse)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await createLocalProject(page, projectName, appRoot)
    await expect(page.locator('[data-slot="composer-project-card"]')).toContainText(projectName)

    await sendComposerMessage(page, firstPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse }).first()
    ).toBeVisible()
    await expect(page.locator('[data-slot="composer-project-card-shell"]')).toHaveCount(0)

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await expect(sidebar.getByText(projectName, { exact: true })).toBeVisible()
    await expect(sidebar.getByText(firstPrompt, { exact: true })).toBeVisible()

    await page.reload()

    await expect(sidebar.getByText(projectName, { exact: true })).toBeVisible()
    await expect(sidebar.getByText(firstPrompt, { exact: true })).toBeVisible()
    await sidebar.getByText(firstPrompt, { exact: true }).click()
    await expect(page.locator('[data-role="user"]')).toContainText(firstPrompt)
    await expect(page.locator('[data-slot="composer-project-card-shell"]')).toHaveCount(0)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('preserves a new conversation across reload and restores its history', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const firstPrompt = `preserve-reload-${runId}`
  const firstResponse = `preserve reloaded response ${runId}`
  const backend = await startMockBackend({
    responses: [assistantMessageResponse('resp-preserve', 'msg-preserve', firstResponse)]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, firstPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse }).first()
    ).toBeVisible()

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await expect(sidebar.getByText(firstPrompt, { exact: true })).toBeVisible()
    await expectConversationInAuthoritativeList(page, firstPrompt)
    await expect(sidebar.getByText(firstPrompt, { exact: true })).toBeVisible()

    await page.reload()

    await expect(sidebar.getByText(firstPrompt, { exact: true })).toBeVisible()

    await sidebar.getByText(firstPrompt, { exact: true }).click()
    await expect(page.locator('[data-role="user"]')).toContainText(firstPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse }).first()
    ).toBeVisible()
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})
