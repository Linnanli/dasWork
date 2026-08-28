import { expect, test, type ElectronApplication } from '@playwright/test'

import { attachDiagnostics, closeApp, collectRendererLogs, launchApp } from './support/app'
import { sendMessage } from './support/chatActions'
import { assistantMessageResponse, deferred, startMockBackend } from './support/mockBackend'

test('opens a task in a separate window without changing the original window navigation', async (
  { browserName },
  testInfo
) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const prompt = `task-window-${Date.now().toString(36)}`
  const response = `task-window-response-${Date.now().toString(36)}`
  const releaseFinalResponse = deferred()
  const backend = await startMockBackend({
    responses: [
      {
        ...assistantMessageResponse('task-window-response', 'task-window-message', response),
        beforeEvent: (_event, index) => (index === 2 ? releaseFinalResponse.promise : undefined)
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const originalWindow = await app.firstWindow()
    collectRendererLogs(originalWindow, logs)

    await sendMessage(originalWindow, prompt)
    await expect(
      originalWindow.locator('[data-role="user"]').filter({ hasText: prompt }).first(),
    ).toBeVisible()

    const sidebar = originalWindow.locator('[data-slot="codex-sidebar"]')
    const row = sidebar.getByRole('button', { name: prompt }).locator('..')
    await row.hover()
    await row.getByRole('button', { name: `更多操作：${prompt}` }).click()

    const taskWindowPromise = app.waitForEvent('window')
    await originalWindow.getByRole('menuitem', { name: '在新窗口打开' }).click()
    const taskWindow = await taskWindowPromise
    collectRendererLogs(taskWindow, logs)

    releaseFinalResponse.resolve()

    await expect(
      taskWindow.locator('[data-role="user"]').filter({ hasText: prompt }).first(),
    ).toBeVisible()
    await expect(
      taskWindow.locator('[data-role="assistant"]').filter({ hasText: response }).first(),
    ).toBeVisible()
    await expect(
      originalWindow.locator('[data-role="assistant"]').filter({ hasText: response }).first(),
    ).toBeVisible()
    await expect(
      originalWindow.locator('[data-role="user"]').filter({ hasText: prompt }).first(),
    ).toBeVisible()
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})
