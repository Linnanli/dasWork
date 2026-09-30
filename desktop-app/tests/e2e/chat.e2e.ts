import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect, type Locator, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import {
  appRoot,
  attachDiagnostics,
  closeApp,
  collectRendererLogs,
  expectAppReady,
  launchApp
} from './support/app'
import {
  createLocalProject,
  ensureLocalProjectSelected,
  sendComposerMessage,
  sendMessage
} from './support/chatActions'
import {
  assistantMessageResponse,
  deferred,
  providerResponseBodies,
  startMockBackend
} from './support/mockBackend'
import { expectTerminalScenario } from './support/terminalScenario'

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

test('sends a real desktop chat turn through the admin backend model provider', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [assistantMessageResponse('resp-e2e', 'msg-resp-e2e', 'E2E hello response')]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, '你好')

    await expect(page.locator('[data-role="assistant"]')).toContainText('E2E hello response')

    const providerRequest = backend.requests.find(
      (request) => request.method === 'POST' && request.url === '/responses'
    )
    expect(providerRequest).toBeDefined()
    if (!providerRequest) throw new Error('Expected provider responses request')

    expect(providerRequest.headers.authorization).toBe('Bearer sk-e2e-test-key')
    const providerBody = JSON.parse(providerRequest.body) as {
      model?: string
      input?: unknown
    }
    expect(providerBody.model).toBe('qwen3.7-plus')
    expect(JSON.stringify(providerBody.input)).toContain('你好')
    expect(
      backend.requests.some((request) => request.url === '/compatible-mode/v1/chat/completions')
    ).toBe(false)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('renders the add-context menu above and aligned with the composer', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await expect(page.locator('body')).toContainText('qwen3.7-plus')
    await page.evaluate(async () => {
      await window.desktopApp.projects.selectProject({ projectKind: 'projectless' })
    })
    await expect(page.locator('[data-slot="composer-project-card"]')).toHaveText('选择项目')
    const addContextButton = page.getByRole('button', { name: '添加文件和更多', exact: true })
    await expect(addContextButton).toBeEnabled()
    await addContextButton.click()

    const popover = page.getByRole('listbox', { name: '添加上下文' })
    const composer = page.locator('[data-slot="aui_composer-shell"]')
    const header = page.locator('header').first()
    await expect(popover).toBeVisible()
    await expect(popover.getByRole('region', { name: 'Files and tasks' })).toContainText(
      '输入以搜索文件或任务'
    )
    await expect(popover.getByRole('region', { name: '技能' })).toHaveCount(0)
    const popoverMaxHeight = await popover.evaluate((element) =>
      Number.parseFloat(window.getComputedStyle(element).maxHeight)
    )
    expect(popoverMaxHeight).toBeGreaterThan(0)
    expect(popoverMaxHeight).toBeLessThanOrEqual(320)
    await popover.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })

    const [popoverBox, composerBox, headerBox] = await Promise.all([
      popover.boundingBox(),
      composer.boundingBox(),
      header.boundingBox()
    ])
    expect(popoverBox).not.toBeNull()
    expect(composerBox).not.toBeNull()
    expect(headerBox).not.toBeNull()
    if (!popoverBox || !composerBox || !headerBox) {
      throw new Error('Could not measure composer add menu')
    }

    expect(Math.abs(popoverBox.x - composerBox.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(popoverBox.width - composerBox.width)).toBeLessThanOrEqual(1)
    expect(popoverBox.y - (headerBox.y + headerBox.height)).toBeGreaterThanOrEqual(7)
    expect(composerBox.y - (popoverBox.y + popoverBox.height)).toBeGreaterThanOrEqual(11)
    expect(composerBox.y - (popoverBox.y + popoverBox.height)).toBeLessThanOrEqual(13)

    const screenshotPath = testInfo.outputPath('composer-add-menu.png')
    await page.screenshot({ path: screenshotPath })
    await testInfo.attach('composer-add-menu.png', {
      contentType: 'image/png',
      path: screenshotPath
    })
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('opens the Composer project card picker above the input and filters projects', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await expect(page.locator('body')).toContainText('qwen3.7-plus')
    const runId = Date.now().toString(36)
    const alphaName = `E2E Picker Alpha ${runId}`
    const betaName = `E2E Picker Beta ${runId}`
    await createLocalProject(page, alphaName, appRoot)
    await createLocalProject(page, betaName, join(appRoot, '..'))
    await page.evaluate(async () => {
      await window.desktopApp.projects.selectProject({ projectKind: 'projectless' })
    })

    const shell = page.locator('[data-slot="composer-project-card-shell"]')
    const card = page.locator('[data-slot="composer-project-card"]')
    await expect(shell).toHaveCSS('height', '40px')
    await expect(shell).not.toHaveCSS('background-color', 'rgb(21, 21, 21)')
    await expect(card).toHaveText('选择项目')
    const [shellBox, closedCardBox] = await Promise.all([shell.boundingBox(), card.boundingBox()])
    expect(shellBox).not.toBeNull()
    expect(closedCardBox).not.toBeNull()
    if (!shellBox || !closedCardBox) throw new Error('Could not measure project card')
    expect(closedCardBox.width).toBeLessThan(shellBox.width)
    await card.click()

    const searchInput = page.getByPlaceholder('搜索项目')
    const popover = page.locator('[data-slot="popover-content"]').filter({ has: searchInput })
    await expect(popover).toBeVisible()
    await expect(popover).toHaveCSS('padding', '4px')
    await expect(popover).toHaveCSS('border-radius', '16px')
    await searchInput.fill('alpha')
    await expect(popover.getByText(alphaName, { exact: true })).toBeVisible()
    await expect(popover.getByText(betaName, { exact: true })).toHaveCount(0)
    await expect(popover).not.toContainText(appRoot)

    await popover.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    const [cardBox, popoverBox] = await Promise.all([card.boundingBox(), popover.boundingBox()])
    expect(cardBox).not.toBeNull()
    expect(popoverBox).not.toBeNull()
    if (!cardBox || !popoverBox) throw new Error('Could not measure project picker')
    expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(cardBox.y)

    const screenshotPath = testInfo.outputPath('composer-project-picker.png')
    await page.screenshot({ path: screenshotPath })
    await testInfo.attach('composer-project-picker.png', {
      contentType: 'image/png',
      path: screenshotPath
    })

    await popover.getByText(alphaName, { exact: true }).click()
    await expect(card).toContainText(alphaName)

    await card.click()
    const reopenedPopover = page
      .locator('[data-slot="popover-content"]')
      .filter({ has: page.getByPlaceholder('搜索项目') })
    await reopenedPopover.getByText('新建项目', { exact: true }).click()
    await page.getByText('新建空白项目', { exact: true }).click()

    const blankProjectName = `E2E Blank ${runId}`
    const dialog = page.locator('[data-slot="create-blank-project-dialog"]')
    await dialog.locator('[data-slot="blank-project-name-input"]').fill(blankProjectName)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(card).toContainText(blankProjectName)

    const blankProjectPath = await page.evaluate(() => {
      return window.desktopApp.projects.getState().then((state) => {
        const selection = state.activeProjectSelection
        return selection?.projectKind === 'path' ? selection.path : null
      })
    })
    expect(blankProjectPath).not.toBeNull()
    if (!blankProjectPath) throw new Error('Expected a path selection for the blank project')
    expect((await stat(blankProjectPath)).isDirectory()).toBe(true)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('discovers, overrides, and inserts custom agent roles from local TOML files', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({ responses: [] })
  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-agent-project-'))
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    await mkdir(join(projectRoot, '.codex', 'agents'), { recursive: true })
    await writeFile(
      join(projectRoot, '.codex', 'agents', 'reviewer.toml'),
      [
        'name = "reviewer"',
        'description = "Project review role"',
        'developer_instructions = "Review this project."'
      ].join('\n')
    )

    app = await launchApp(backend, logs, {
      configureCodexHome: async (codexHomeDir) => {
        await mkdir(join(codexHomeDir, 'agents'), { recursive: true })
        await writeFile(
          join(codexHomeDir, 'agents', 'reviewer.toml'),
          [
            'name = "reviewer"',
            'description = "Global review role"',
            'developer_instructions = "Review globally."'
          ].join('\n')
        )
        await writeFile(
          join(codexHomeDir, 'agents', 'tester.toml'),
          [
            'name = "tester"',
            'description = "Valid beside a broken file"',
            'developer_instructions = "Test changes."'
          ].join('\n')
        )
        await writeFile(join(codexHomeDir, 'agents', 'broken.toml'), 'name = "broken')
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await expect(page.locator('body')).toContainText('qwen3.7-plus')
    await createLocalProject(page, `E2E Agents ${Date.now().toString(36)}`, projectRoot)

    await page.getByRole('button', { name: '添加文件和更多', exact: true }).click()
    const popover = page.getByRole('listbox', { name: '添加上下文' })
    const reviewer = popover.getByRole('option').filter({ hasText: 'reviewer' })
    await expect(popover.getByRole('region', { name: '智能体' })).toBeVisible()
    await expect(reviewer).toContainText('Project review role')
    await expect(reviewer).not.toContainText('Global review role')
    await expect(popover.getByRole('option').filter({ hasText: 'tester' })).toContainText(
      'Valid beside a broken file'
    )

    await reviewer.click()
    await expect(
      page.locator(
        '.aui-directive-chip[data-directive-type="agentRole"][data-directive-id="subagent://reviewer"]'
      )
    ).toContainText('reviewer')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test('preserves a workspace reference, local file, folder and image after conversation switch and reload', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const prompt = '请结合这个文件和图片说明下一步'
  const responseText = '已收到文件上下文和图片。'
  const workspaceFileLabel = 'src/renderer/src/App.tsx'
  const workspaceFileDisplayLabel = 'App.tsx'
  const workspaceFilePath = `${appRoot}/${workspaceFileLabel}`
  const backend = await startMockBackend({
    capabilities: ['text', 'image'],
    responses: [assistantMessageResponse('resp-context-photo', 'msg-context-photo', responseText)]
  })
  const localContextDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-local-context-'))
  const attachmentPath = join(localContextDir, 'e2e-notes.txt')
  const folderPath = join(localContextDir, 'e2e-reference-folder')
  const imagePath = join(localContextDir, 'e2e-context.png')
  await writeFile(attachmentPath, 'Local attachment contents must not be uploaded.')
  await mkdir(folderPath)
  await writeFile(imagePath, onePixelPng)
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    await app.evaluate(
      ({ dialog }, { filePaths, folderPath }) => {
        let pickerChoice = 0
        Object.assign(dialog, {
          showMessageBox: async () => ({ response: pickerChoice++, checkboxChecked: false }),
          showOpenDialog: async ({ properties }: { properties: string[] }) => ({
            canceled: false,
            filePaths:
              properties.includes('openDirectory') && !properties.includes('openFile')
                ? [folderPath]
                : filePaths,
            bookmarks: []
          })
        })
      },
      { filePaths: [attachmentPath, folderPath, imagePath], folderPath }
    )
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await expect(page.locator('body')).toContainText('qwen3.7-plus')
    await ensureLocalProjectSelected(page)

    const composer = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await composer.fill(`${prompt} @${workspaceFileLabel}`)

    const contextPanel = page.getByRole('listbox', { name: '添加上下文' })
    await expect(contextPanel).toBeVisible()
    const workspaceResult = contextPanel.getByRole('option').filter({ hasText: workspaceFileLabel })
    await expect(workspaceResult).toHaveCount(1)
    await workspaceResult.click()

    await page.getByRole('button', { name: '添加文件和更多', exact: true }).click()
    await page.getByRole('option', { name: 'Files and folders', exact: true }).click()
    if (process.platform !== 'darwin') {
      await page.getByRole('button', { name: '添加文件和更多', exact: true }).click()
      await page.getByRole('option', { name: 'Files and folders', exact: true }).click()
    }
    await expect(page.getByRole('button', { name: 'File attachment', exact: true })).toHaveCount(2)
    await expect(
      page.getByRole('button', { name: '预览e2e-context.png', exact: true })
    ).toBeVisible()

    const sendButton = page.getByRole('button', { name: '发送消息', exact: true })
    await expect(sendButton).toBeEnabled()
    await sendButton.click()
    await expect(page.locator('[data-role="assistant"]')).toContainText(responseText)
    await expectTerminalScenario({
      page,
      logs,
      backend,
      terminal: 'finish',
      outcome: 'completed',
      providerRequestCount: 1,
      turnStartedCount: 1,
      pendingApprovalCount: 0,
      observedToolCount: 0,
      toolResultCount: 0,
      queue: { items: [] }
    })

    const providerBody = await expectProviderResponseBody(backend)
    const contents = providerInputContents(providerBody)
    expect(contents).toContainEqual({
      type: 'input_text',
      text:
        '# Files mentioned by the user:\n\n' +
        `## ${JSON.stringify(workspaceFileDisplayLabel)}: ${JSON.stringify(workspaceFilePath)}\n\n` +
        `## ${JSON.stringify('e2e-notes.txt')}: ${JSON.stringify(attachmentPath)}\n\n` +
        `## ${JSON.stringify('e2e-reference-folder')}: ${JSON.stringify(folderPath)}` +
        `\n\n## My request for Codex:\n${prompt}`
    })
    expect(JSON.stringify(providerBody)).not.toContain(
      'Local attachment contents must not be uploaded.'
    )
    expect(contents).toContainEqual(
      expect.objectContaining({
        type: 'input_image',
        image_url: expect.stringMatching(/^data:image\/png;base64,/u)
      })
    )
    expect(
      contents.some(
        (content) =>
          content.type === 'input_text' &&
          typeof content.text === 'string' &&
          content.text.startsWith('<image name=[Image #1] path="')
      )
    ).toBe(true)

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    const originalConversation = sidebar.getByRole('button', {
      name: new RegExp(`^${prompt}`)
    })
    await expect(originalConversation).toBeVisible()
    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await expect(page.locator('[data-role="user"]').filter({ hasText: prompt })).toHaveCount(0)

    await originalConversation.click()
    const restoredMessage = page.locator('[data-role="user"]').filter({ hasText: prompt })
    await expect(restoredMessage).toHaveCount(1)
    await expectAttachmentNames(page, restoredMessage, {
      file: 'e2e-notes.txt',
      folder: 'e2e-reference-folder',
      image: 'e2e-context.png'
    })

    await page.reload()
    await expectAppReady(page)
    await sidebar.getByRole('button', { name: new RegExp(`^${prompt}`) }).click()
    const reloadedMessage = page.locator('[data-role="user"]').filter({ hasText: prompt })
    await expect(reloadedMessage).toHaveCount(1)
    await expectAttachmentNames(page, reloadedMessage, {
      file: 'e2e-notes.txt',
      folder: 'e2e-reference-folder',
      image: 'e2e-context.png'
    })
    expect(providerResponseBodies(backend)).toHaveLength(1)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(localContextDir, { recursive: true, force: true })
  }
})

async function expectAttachmentNames(
  page: Page,
  message: Locator,
  names: { file: string; folder: string; image: string }
): Promise<void> {
  const attachments = message.locator('.aui-attachment-root')
  await expect(attachments).toHaveCount(3)
  const fileAttachment = message.locator(`[data-attachment-name="${names.file}"]`)
  const folderAttachment = message.locator(`[data-attachment-name="${names.folder}"]`)
  await expect(fileAttachment).toHaveCount(1)
  await expect(folderAttachment).toHaveCount(1)
  await expectAttachmentTooltip(page, fileAttachment, names.file)
  await expectAttachmentTooltip(page, folderAttachment, names.folder)

  const imagePreview = attachments.locator('img')
  await expect(imagePreview).toHaveCount(1)
  const imagePreviewSource = await imagePreview.getAttribute('src')
  expect(imagePreviewSource).toMatch(/^app:\/\/fs\//u)
  expect(imagePreviewSource?.endsWith(`/${names.image}`)).toBe(true)
  await expect(imagePreview).toHaveAttribute('alt', names.image)
}

async function expectAttachmentTooltip(
  page: Page,
  attachment: Locator,
  name: string
): Promise<void> {
  await attachment.hover()
  await expect(page.getByRole('tooltip', { name, exact: true })).toHaveText(name)
}

async function expectProviderResponseBody(backend: {
  requests: Array<{ method: string; url: string; body: string }>
}): Promise<unknown> {
  await expect
    .poll(
      () =>
        backend.requests.find(
          (request) => request.method === 'POST' && request.url === '/responses'
        )?.body,
      { timeout: 20_000 }
    )
    .toBeTruthy()

  const providerRequest = backend.requests.find(
    (request) => request.method === 'POST' && request.url === '/responses'
  )
  if (!providerRequest) throw new Error('Expected provider responses request')
  return JSON.parse(providerRequest.body) as unknown
}

function providerInputContents(providerBody: unknown): Array<Record<string, unknown>> {
  if (!isRecord(providerBody) || !Array.isArray(providerBody.input)) {
    throw new Error('Expected the provider request to include an input array')
  }

  return providerBody.input.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return []
    return item.content.filter(isRecord)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

test('creates a sidebar conversation entry before the provider response returns', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const releaseProviderResponse = deferred()
  const runId = Date.now().toString(36)
  const prompt = `immediate-sidebar-${runId}`
  const responseText = `immediate sidebar response ${runId}`
  const backend = await startMockBackend({
    responses: [
      {
        ...assistantMessageResponse(
          'resp-immediate-sidebar',
          'msg-immediate-sidebar',
          responseText
        ),
        beforeResponse: () => releaseProviderResponse.promise
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, prompt)

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await expect(sidebar.getByText(prompt, { exact: true })).toBeVisible()
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: responseText })
    ).toHaveCount(0)

    releaseProviderResponse.resolve()
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: responseText })
    ).toBeVisible()
  } finally {
    releaseProviderResponse.resolve()
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('keeps one conversation streaming while another conversation completes', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const releaseFirstResponse = deferred()
  const runId = Date.now().toString(36)
  const firstPrompt = `parallel-first-${runId}`
  const secondPrompt = `parallel-second-${runId}`
  const firstResponse = `parallel first response ${runId}`
  const secondResponse = `parallel second response ${runId}`
  const backend = await startMockBackend({
    responses: [
      {
        ...assistantMessageResponse('resp-parallel-first', 'msg-parallel-first', firstResponse),
        beforeResponse: () => releaseFirstResponse.promise
      },
      assistantMessageResponse('resp-parallel-second', 'msg-parallel-second', secondResponse)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, firstPrompt)

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    const firstConversation = sidebar.getByRole('button', {
      name: new RegExp(`^${firstPrompt}, running`)
    })
    await expect(firstConversation).toBeVisible()

    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await sendComposerMessage(page, secondPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: secondResponse })
    ).toBeVisible()
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse })
    ).toHaveCount(0)

    await firstConversation.click()
    await expect(page.locator('[data-role="user"]')).toContainText(firstPrompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: secondResponse })
    ).toHaveCount(0)

    releaseFirstResponse.resolve()
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse })
    ).toBeVisible()

    const providerBodies = providerResponseBodies(backend)
    expect(providerBodies).toHaveLength(2)
    expect(JSON.stringify(providerBodies[0])).toContain(firstPrompt)
    expect(JSON.stringify(providerBodies[1])).toContain(secondPrompt)
  } finally {
    releaseFirstResponse.resolve()
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('stops only the active conversation while a background conversation continues', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const releaseFirstResponse = deferred()
  const releaseSecondResponse = deferred()
  const runId = Date.now().toString(36)
  const firstPrompt = `stop-isolation-first-${runId}`
  const secondPrompt = `stop-isolation-second-${runId}`
  const firstResponse = `stop isolation first response ${runId}`
  const secondResponse = `stop isolation second response ${runId}`
  const backend = await startMockBackend({
    responses: [
      {
        ...assistantMessageResponse('resp-stop-first', 'msg-stop-first', firstResponse),
        beforeResponse: () => releaseFirstResponse.promise
      },
      {
        ...assistantMessageResponse('resp-stop-second', 'msg-stop-second', secondResponse),
        beforeResponse: () => releaseSecondResponse.promise
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, firstPrompt)
    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await expect(
      sidebar.getByRole('button', { name: new RegExp(`^${firstPrompt}, running`) })
    ).toBeVisible()

    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await sendComposerMessage(page, secondPrompt)
    await expect(
      sidebar.getByRole('button', { name: new RegExp(`^${secondPrompt}, running`) })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await expect.poll(() => providerResponseBodies(backend)).toHaveLength(2)

    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible()
    releaseFirstResponse.resolve()

    const firstConversation = sidebar.getByRole('button', {
      name: new RegExp(`^${firstPrompt}`)
    })
    await firstConversation.click()
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: firstResponse })
    ).toBeVisible()

    const secondConversation = sidebar.getByRole('button', {
      name: new RegExp(`^${secondPrompt}`)
    })
    await secondConversation.click()
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: secondResponse })
    ).toHaveCount(0)
    expect(providerResponseBodies(backend)).toHaveLength(2)
  } finally {
    releaseFirstResponse.resolve()
    releaseSecondResponse.resolve()
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('shows upstream quota errors returned by the admin backend model provider', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [
      {
        status: 403,
        body: {
          request_id: 'req-quota-exhausted',
          code: 'PERMISSION_DENIED',
          message: 'The free quota has been exhausted.'
        }
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, '你好')

    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'The free quota has been exhausted.'
    )
    await expect(page.locator('.aui-lexical-input[contenteditable="true"]').last()).toHaveText('')
    await expect(page.locator('[data-slot="codex-sidebar"]')).not.toContainText(
      'The free quota has been exhausted.'
    )
    expect(
      backend.requests.some((request) => request.method === 'POST' && request.url === '/responses')
    ).toBe(true)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})
