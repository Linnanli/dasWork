import { expect, test, type ElectronApplication } from '@playwright/test'

import { attachDiagnostics, closeApp, launchApp } from './support/app'
import {
  createAppServerRequestCapture,
  type AppServerRequestCapture
} from './support/appServerRequestCapture'
import { ensureLocalProjectSelected, sendComposerMessage } from './support/chatActions'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

test('injects one gated desktop app-context into normal and projectless app-server threads', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'desktop-context-local',
        'desktop-context-local-message',
        'Local reply'
      ),
      assistantMessageResponse(
        'desktop-context-projectless',
        'desktop-context-projectless-message',
        'Projectless reply'
      )
    ]
  })
  const appServerCapture = await createAppServerRequestCapture()
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, { environment: appServerCapture.environment })
    const page = await app.firstWindow()
    await ensureLocalProjectSelected(page)
    await sendComposerMessage(page, 'Create a normal local thread.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Local reply')

    await expect
      .poll(async () => (await outboundDeveloperInstructions(appServerCapture)).length, {
        timeout: 10_000
      })
      .toBe(1)
    const localInstructions = (await outboundDeveloperInstructions(appServerCapture))[0]
    expect(localInstructions).toBeDefined()
    assertNormalDesktopContext(localInstructions ?? '')

    await page.evaluate(async () => {
      await window.desktopApp.projects.selectProject({ projectKind: 'projectless' })
    })
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await sendComposerMessage(page, 'Create a projectless thread.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Projectless reply')

    await expect
      .poll(async () => (await outboundDeveloperInstructions(appServerCapture)).length, {
        timeout: 10_000
      })
      .toBe(2)
    const projectlessInstructions = (await outboundDeveloperInstructions(appServerCapture))[1]
    expect(projectlessInstructions).toBeDefined()
    assertProjectlessDesktopContext(projectlessInstructions ?? '')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await appServerCapture.cleanup()
    await backend.close()
  }
})

async function outboundDeveloperInstructions(capture: AppServerRequestCapture): Promise<string[]> {
  const requests = await capture.requestParams('thread/start')
  return requests.flatMap((params) => {
    const developerInstructions = params.developerInstructions
    return typeof developerInstructions === 'string' ? [developerInstructions] : []
  })
}

function assertNormalDesktopContext(instructions: string): void {
  assertRequiredDesktopContext(instructions)
  expect(instructions).not.toContain('### Projectless Chat')
}

function assertRequiredDesktopContext(instructions: string): void {
  expect(instructions.match(/<app-context>/gu)).toHaveLength(1)
  expect(instructions).toContain('# DasCowork desktop context')
  expect(instructions).toContain('### Inline Code Comments')
  expect(instructions).not.toContain('load_workspace_dependencies')
  expect(instructions).not.toContain('automation_update')
  expect(instructions).not.toContain(':::writing')
  expect(instructions).not.toContain('::git-*')
  expect(instructions).not.toContain('<heartbeat>')
}

function assertProjectlessDesktopContext(instructions: string): void {
  assertRequiredDesktopContext(instructions)
  expect(instructions).toContain('### Projectless Chat')

  const outputDirectory = instructions.match(/User-facing deliverables directory: (.+)\./u)?.[1]
  expect(outputDirectory).toMatch(/^\//u)
  expect(instructions).toContain(`Store user-facing deliverables only under ${outputDirectory}.`)
  expect(instructions).toContain(`link only files under ${outputDirectory}.`)
}
