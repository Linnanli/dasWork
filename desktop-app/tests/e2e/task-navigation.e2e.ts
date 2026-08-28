import { expect, test, type ElectronApplication } from '@playwright/test'

import { attachDiagnostics, closeApp, collectRendererLogs, launchApp } from './support/app'
import { sendMessage } from './support/chatActions'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

test('moves between adjacent non-archived tasks from the conversation header', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const firstResponse = `task-navigation-first-${runId}`
  const secondResponse = `task-navigation-second-${runId}`
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'task-navigation-first-thread',
        'task-navigation-first-message',
        firstResponse
      ),
      assistantMessageResponse(
        'task-navigation-second-thread',
        'task-navigation-second-message',
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

    await sendMessage(page, `first task ${runId}`)
    await expect(page.locator('[data-role="assistant"]')).toContainText(firstResponse)

    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await sendMessage(page, `second task ${runId}`)
    await expect(page.locator('[data-role="assistant"]')).toContainText(secondResponse)

    await expect(page.getByRole('button', { name: '上一任务' })).toBeDisabled()
    await page.getByRole('button', { name: '下一任务' }).click()
    await expect(page.locator('[data-role="assistant"]')).toContainText(firstResponse)
    await expect(page.getByRole('button', { name: '上一任务' })).toBeEnabled()

    await page.getByRole('button', { name: '上一任务' }).click()
    await expect(page.locator('[data-role="assistant"]')).toContainText(secondResponse)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})
