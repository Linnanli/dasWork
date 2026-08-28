import { expect, test, type ElectronApplication } from '@playwright/test'

import { attachDiagnostics, closeApp, collectRendererLogs, launchApp } from './support/app'
import { sendMessage } from './support/chatActions'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

test('finds and navigates matching user and assistant messages in the current conversation', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const needle = `conversation-find-${Date.now().toString(36)}`
  const backend = await startMockBackend({
    responses: [assistantMessageResponse('find-thread', 'find-message', `Completed ${needle}`)]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, needle)
    await expect(page.locator('[data-role="assistant"]')).toContainText(needle)
    await page.locator('[data-role="assistant"]').click()

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected an open desktop window')
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['meta'] })
    })
    const findBar = page.locator('[data-slot="conversation-find-bar"]')
    await expect(findBar).toBeVisible()
    const search = findBar.getByRole('textbox', { name: '在当前对话中查找' })
    await search.fill(needle)
    await expect(findBar).toContainText('1/2')
    await expect(page.locator('[data-role="user"]')).toHaveClass(/ring-primary\/70/)

    await search.press('Enter')
    await expect(findBar).toContainText('2/2')
    await expect(page.locator('[data-role="assistant"]')).toHaveClass(/ring-primary\/70/)

    await findBar.getByRole('button', { name: '关闭对话查找' }).click()
    await expect(findBar).toHaveCount(0)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})
