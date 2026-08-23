import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

import {
  attachDiagnostics,
  cleanupTempDirs,
  closeApp,
  collectRendererLogs,
  launchApp
} from './support/app'
import { createLocalProject, sendComposerMessage } from './support/chatActions'
import {
  assistantMessageResponse,
  deferred,
  responseCompleted,
  responseCreated,
  startMockBackend,
  type ResponsesStreamStep
} from './support/mockBackend'

test('IR-E2E-01 routes streamed Markdown references into the workspace and survives history reload', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(120_000)

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-inline-routing-'))
  const releaseCompletion = deferred()
  const responseText = [
    '[preview fixture](src/fixture.ts:2-3)',
    `[same fixture](${join(projectRoot, 'src', 'fixture.ts')}:3)`,
    '[open folder](src/components/)',
    '[HTTP docs](http://example.test/docs)',
    '[HTTPS docs](https://example.test/secure)',
    '[unsafe](javascript:alert(1))'
  ].join('\n\n')
  const streamingResponse: ResponsesStreamStep = {
    events: [
      responseCreated('resp-inline-routing'),
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          id: 'msg-inline-routing',
          content: [{ type: 'output_text', text: '' }]
        }
      },
      { type: 'response.output_text.delta', delta: responseText },
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: 'msg-inline-routing',
          content: [{ type: 'output_text', text: responseText }]
        }
      },
      responseCompleted('resp-inline-routing')
    ],
    beforeEvent: (_event, index) => (index === 4 ? releaseCompletion.promise : undefined)
  }
  const backend = await startMockBackend({ responses: [streamingResponse] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await initializeProject(projectRoot)
    app = await launchApp(backend, logs)
    let page = await app.firstWindow()
    await page.evaluate(() => window.localStorage.clear())
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Inline routing ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open the inline routing fixture.')

    const assistant = page.locator('[data-role="assistant"]').filter({ hasText: 'preview fixture' })
    await expect(assistant).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
    await expect(assistant.locator('a[href^="javascript:"]')).toHaveCount(0)

    const previewReference = assistant
      .locator('[data-inline-reference-kind="local-file"]')
      .filter({ hasText: 'preview fixture' })
    await previewReference.focus()
    await page.keyboard.press('Enter')
    const workspace = page.locator('[data-slot="right-workspace-shell"]')
    const fixtureTab = workspace.locator(
      '[role="tab"][data-workspace-tab-id="file:src/fixture.ts"]'
    )
    await expect(workspace).toBeVisible()
    await expect(fixtureTab).toBeVisible()
    await expect(fixtureTab.locator('xpath=..')).toHaveAttribute('data-preview', 'true')

    await previewReference.dblclick()
    await expect(fixtureTab.locator('xpath=..')).toHaveAttribute('data-preview', 'false')

    await assistant
      .locator('[data-inline-reference-kind="local-file"]')
      .filter({ hasText: 'same fixture' })
      .click()
    await expect(
      workspace.locator('[role="tab"][data-workspace-tab-id="file:src/fixture.ts"]')
    ).toHaveCount(1)

    await assistant
      .locator('[data-inline-reference-kind="local-folder"]')
      .filter({ hasText: 'open folder' })
      .click()
    await expect(
      workspace.locator('[role="tab"][data-workspace-tab-id="files:explorer"]')
    ).toBeVisible()
    await expectFolderToBeLocated(page, 'src/components/')

    await assistant
      .locator('a[data-inline-reference-kind="external-url"]')
      .filter({ hasText: 'HTTP docs' })
      .click()
    const address = page.getByRole('textbox', { name: 'Browser address' })
    await expect(address).toHaveValue('http://example.test/docs')

    await assistant
      .locator('a[data-inline-reference-kind="external-url"]')
      .filter({ hasText: 'HTTPS docs' })
      .click()
    await expect(address).toHaveValue('https://example.test/secure')
    await expect(workspace.locator('[role="tab"][data-workspace-tab-id^="browser:"]')).toHaveCount(
      2
    )

    releaseCompletion.resolve()
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0)

    await page.reload()
    page = await app.firstWindow()
    collectRendererLogs(page, logs)
    const reloadedAssistant = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: 'preview fixture' })
    await expect(reloadedAssistant).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(
      'https://example.test/secure'
    )

    await reloadedAssistant
      .locator('[data-inline-reference-kind="local-file"]')
      .filter({ hasText: 'same fixture' })
      .first()
      .click()
    await expect(
      page
        .locator('[data-slot="right-workspace-shell"]')
        .locator('[role="tab"][data-workspace-tab-id="file:src/fixture.ts"]')
    ).toHaveCount(1)
  } finally {
    releaseCompletion.resolve()
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('IR-E2E-02 opens the referenced thread through the normal conversation flow', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runId = Date.now().toString(36)
  const firstPrompt = `inline-reference-source-${runId}`
  const secondPrompt = `inline-reference-link-${runId}`
  let firstConversationId: string | undefined
  const linkedResponse: ResponsesStreamStep = {
    events: [
      responseCreated('resp-inline-conversation-link'),
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: 'msg-inline-conversation-link',
          content: [{ type: 'output_text', text: '' }]
        }
      },
      responseCompleted('resp-inline-conversation-link')
    ],
    beforeResponse: () => {
      if (!firstConversationId)
        throw new Error('Expected the source conversation id before link reply')
      const event = linkedResponse.events[1] as {
        item: { content: Array<{ text: string; type: 'output_text' }> }
      }
      event.item.content[0]!.text = `[Open source task](thread://${firstConversationId})`
    }
  }
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'resp-inline-conversation-source',
        'msg-inline-conversation-source',
        'Source ready'
      ),
      linkedResponse
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendComposerMessage(page, firstPrompt)
    await expect(page.locator('[data-role="assistant"]')).toContainText('Source ready')
    firstConversationId = await conversationIdForPrompt(page, firstPrompt)

    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await sendComposerMessage(page, secondPrompt)
    const assistant = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: 'Open source task' })
    await expect(assistant).toBeVisible()
    await assistant
      .locator('[data-inline-reference-kind="conversation"]')
      .filter({ hasText: 'Open source task' })
      .click()

    await expect(page.locator('[data-role="user"]').filter({ hasText: firstPrompt })).toHaveCount(1)
    await expect(page.locator('[data-role="user"]').filter({ hasText: secondPrompt })).toHaveCount(
      0
    )
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

async function initializeProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, 'src', 'components'), { recursive: true })
  await writeFile(
    join(projectRoot, 'src', 'fixture.ts'),
    ['export const first = true', 'export const second = true', 'export const third = true'].join(
      '\n'
    ),
    'utf8'
  )
  await writeFile(join(projectRoot, 'src', 'components', 'Button.tsx'), 'export {}\n', 'utf8')
}

async function expectFolderToBeLocated(page: Page, path: string): Promise<void> {
  const tree = page.locator('file-tree-container')
  await expect(tree).toBeVisible()
  await expect
    .poll(
      () =>
        tree.evaluate((element, selectedPath) => {
          const item = element.shadowRoot?.querySelector<HTMLButtonElement>(
            `button[data-item-path="${selectedPath}"]`
          )
          return item
            ?.closest<HTMLElement>('[data-type="item"]')
            ?.hasAttribute('data-item-selected')
        }, path),
      { timeout: 15_000 }
    )
    .toBe(true)
}

async function conversationIdForPrompt(page: Page, prompt: string): Promise<string> {
  await expect
    .poll(
      () =>
        page.evaluate(async (expectedPrompt) => {
          const state = await window.desktopApp.conversations.refreshConversationList()
          return (
            state.conversations.find((conversation) => conversation.title?.includes(expectedPrompt))
              ?.id ?? null
          )
        }, prompt),
      { timeout: 15_000 }
    )
    .not.toBeNull()
  const conversationId = await page.evaluate(async (expectedPrompt) => {
    const state = await window.desktopApp.conversations.refreshConversationList()
    return state.conversations.find((conversation) => conversation.title?.includes(expectedPrompt))
      ?.id
  }, prompt)
  if (!conversationId) throw new Error(`Could not find conversation for ${prompt}`)
  return conversationId
}
