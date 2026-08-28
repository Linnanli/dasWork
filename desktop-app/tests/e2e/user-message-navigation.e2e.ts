import { expect, test, type ElectronApplication } from '@playwright/test'

import { attachDiagnostics, closeApp, collectRendererLogs, launchApp } from './support/app'
import { sendComposerMessage, sendMessage } from './support/chatActions'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

test('shows a user-message navigation rail for a long conversation', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('navigation-thread', 'navigation-message-1', `reply one ${runId}`),
      assistantMessageResponse('navigation-thread', 'navigation-message-2', `reply two ${runId}`),
      assistantMessageResponse('navigation-thread', 'navigation-message-3', `reply three ${runId}`)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, `navigation one ${runId}`)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: `reply one ${runId}` })
    ).toBeVisible()
    await sendComposerMessage(page, `navigation two ${runId}`)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: `reply two ${runId}` })
    ).toBeVisible()
    await sendComposerMessage(page, `navigation three ${runId}`)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: `reply three ${runId}` })
    ).toBeVisible()

    const rail = page.locator('[data-slot="user-message-navigation-rail"]')
    await expect(rail).toBeVisible()
    await expect(rail.getByRole('button')).toHaveCount(3)
    const firstTarget = rail.getByRole('button', { name: /^跳转到消息 1：/ })
    await firstTarget.click()
    await expect(firstTarget).toHaveAttribute('aria-current', 'true')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('loads unmounted historical messages before navigating to an earlier marker', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(180_000)

  const runId = Date.now().toString(36)
  const prompts = Array.from(
    { length: 121 },
    (_, index) => `history navigation ${runId} request ${index}`
  )
  const backend = await startMockBackend({
    responses: prompts.map((_, index) =>
      assistantMessageResponse(
        `history-navigation-response-${index}`,
        `history-navigation-message-${index}`,
        `history navigation ${runId} reply ${index}`
      )
    )
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    for (const [index, prompt] of prompts.entries()) {
      if (index === 0) await sendMessage(page, prompt)
      else await sendComposerMessage(page, prompt)
      await expect(
        page
          .locator('[data-role="assistant"]')
          .filter({ hasText: `history navigation ${runId} reply ${index}` })
          .last()
      ).toBeVisible()
    }

    await page.reload()

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await sidebar.getByText(prompts[0]!, { exact: true }).click()
    const userMessages = page.locator('[data-role="user"]')
    await expect(userMessages.filter({ hasText: prompts[0]! })).toHaveCount(0)
    expect(await userMessages.count()).toBeLessThan(prompts.length)

    const rail = page.locator('[data-slot="user-message-navigation-rail"]')
    const firstTarget = rail.getByRole('button', { name: /^跳转到消息 1：/ })
    await expect(firstTarget).toBeVisible()
    await firstTarget.click()

    await expect(userMessages).toHaveCount(121)
    await expect(userMessages.filter({ hasText: prompts[0]! })).toBeVisible()
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})
