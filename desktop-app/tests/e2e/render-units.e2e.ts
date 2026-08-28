import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import {
  appRoot,
  attachDiagnostics,
  closeApp,
  cleanupTempDirs,
  collectRendererLogs,
  launchApp
} from './support/app'
import { createLocalProject, sendComposerMessage, sendMessage } from './support/chatActions'
import {
  applyPatchResponse,
  assistantMessageResponse,
  deferred,
  isResponsesUrl,
  shellCommandResponse,
  startMockBackend,
  webSearchResponse
} from './support/mockBackend'
import { writeFakeChatGptAuth, writeStandaloneWebSearchConfig } from './support/authFixtures'

test('renders app-server image generation output through the full chat stream', async (
  { browserName },
  testInfo
) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      environment: {
        CODEX_APP_SERVER_BIN: join(appRoot, 'tests/e2e/support/image-generation-app-server.mjs')
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, '请生成一张测试图片。')

    const imageCard = page.locator('[data-slot="generated-image-file-unit"]')
    await expect(imageCard).toBeVisible()
    await expect(imageCard).toContainText('已生成图片')
    await expect(imageCard.getByRole('img', { name: 'a one-pixel blue test image' })).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/u
    )
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('keeps Outputs safe when local artifacts disappear and opens remote artifacts in the workspace browser', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-output-resources-'))
  const previewPath = join(projectRoot, 'preview.pdf')
  await writeFile(previewPath, '%PDF-1.4\n', 'utf8')
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'output-resources-thread',
        'output-resources-message',
        [
          '已生成以下产物：',
          '[本地预览](preview.pdf)',
          '[远程部署](https://example.test/outputs)',
          '[缺失报告](missing-report.pdf)'
        ].join('\n\n')
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Output resources ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, '生成 Outputs 回归所需的产物。')
    await expect(page.locator('[data-role="assistant"]')).toContainText('已生成以下产物')

    await page.getByRole('button', { name: '打开工作区', exact: true }).click()
    const workspaceMenu = page.getByRole('button', { name: 'Open workspace tab', exact: true })
    if (await workspaceMenu.isVisible().catch(() => false)) {
      await workspaceMenu.click()
      await page.getByRole('menuitem', { name: /^Outputs/ }).click()
    } else {
      await page.getByRole('button', { name: /^产物/ }).click()
    }

    const outputs = page.locator('[data-slot="workspace-outputs"]')
    await expect(outputs).toBeVisible()
    const cards = outputs.locator('[data-slot="end-resource-card-unit"]')
    await expect(cards).toHaveCount(2)
    await expect(outputs.getByRole('button', { name: '打开 本地预览' })).toBeEnabled()
    await expect(outputs.getByRole('button', { name: '打开 example.test' })).toBeEnabled()
    await expect(outputs).not.toContainText('缺失报告')

    await outputs.getByRole('button', { name: '打开 example.test' }).click()
    await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue(
      'https://example.test/outputs'
    )

    await unlink(previewPath)
    await page.getByRole('tab', { name: 'Outputs', exact: true }).click()
    await expect(outputs).toBeVisible()
    await expect(cards).toHaveCount(1)
    await expect(outputs).not.toContainText('本地预览')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})

test('renders completed code-comment directives as one expandable review card', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const responseText = [
    '检查完成，共发现以下问题。',
    '::code-comment{title="[P2] 第三个问题" body="第三条完整说明" file="desktop-app/src/third.ts" start=30}',
    '::code-comment{title="[P0] 首要问题" body="第一条完整说明" file="desktop-app/src/first.ts" start=10 end=12}',
    '::code-comment{title="[P1] 第二个问题" body="第二条完整说明" file="desktop-app/src/second.ts" start=20}',
    '::code-comment{title="[P3] 第四个问题" body="第四条完整说明" file="desktop-app/src/fourth.ts" start=40}',
    '::code-comment{title="无优先级问题" body="第五条完整说明" file="desktop-app/src/fifth.ts" start=50}'
  ].join('\n')
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('resp-review-comments', 'msg-review-comments', responseText)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, '检查未提交更改。')

    const assistant = page.locator('[data-role="assistant"]').filter({ hasText: '检查完成' })
    const card = assistant.locator('[data-slot="review-comments-unit"]')
    await expect(card).toBeVisible()
    await expect(card).toContainText('5 comments')
    await expect(assistant).not.toContainText('::code-comment')
    await expect(card).toContainText('首要问题')
    await expect(card).toContainText('第二个问题')
    await expect(card).toContainText('第三个问题')
    await expect(card).not.toContainText('第四个问题')
    const expandButton = card.getByRole('button', { name: '再显示 2 条评论' })
    await expect(expandButton).toHaveAttribute('aria-expanded', 'false')
    await expandButton.click()
    await expect(card).toContainText('第四个问题')
    await expect(card).toContainText('无优先级问题')
    await expect(card.getByRole('button', { name: '收起评论' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('renders semantic inline references through the real assistant Markdown flow', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const responseText = [
    '[GitHub](app://github)',
    '普通文字 [source](desktop-app/src/renderer/src/App.tsx:42) 普通文字',
    '[External docs](https://example.test/docs)',
    '[Docs resource](mcp-resource://docs/app%3A%2F%2Fdocs%2F1)',
    '`@desktop-app/src/renderer/src/App.tsx:42`',
    '[unsafe](javascript:alert(1))'
  ].join('\n\n')
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('resp-inline-references', 'msg-inline-references', responseText)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, '展示链接参考。')

    const assistant = page.locator('[data-role="assistant"]').filter({ hasText: 'GitHub' })
    await expect(assistant).toBeVisible()
    const appToken = assistant.locator('[data-inline-reference-kind="app"]')
    await expect(appToken).toBeVisible()
    await expect(appToken).toHaveAttribute('data-interactive', 'false')

    const fileToken = assistant.locator('[data-inline-reference-kind="local-file"]').first()
    await expect(fileToken).toBeVisible()
    await expect(fileToken).toHaveAttribute('data-interactive', 'true')
    await expect(fileToken).toContainText('source (line 42)')
    await expect(fileToken.locator('[data-file-icon="react"]')).toBeVisible()

    const inlineAlignment = await fileToken.evaluate((token) => {
      const content = token.querySelector<HTMLElement>('[data-slot="inline-reference-content"]')
      const icon = content?.querySelector<SVGElement>('svg')
      const label = content?.querySelector<HTMLElement>('[data-slot="inline-reference-label"]')
      const paragraph = token.parentElement
      const textWalker = paragraph
        ? document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
        : undefined
      let ordinaryText = textWalker?.nextNode()
      while (
        ordinaryText &&
        (token.contains(ordinaryText.parentElement) ||
          !ordinaryText.textContent?.includes('普通文字'))
      ) {
        ordinaryText = textWalker?.nextNode()
      }
      const labelText = label?.firstChild

      if (!content || !icon || !label || !ordinaryText || !labelText) return undefined

      const ordinaryRange = document.createRange()
      ordinaryRange.selectNodeContents(ordinaryText)
      const labelRange = document.createRange()
      labelRange.selectNodeContents(labelText)
      const iconRect = icon.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      const ordinaryTextRect = ordinaryRange.getBoundingClientRect()
      const labelTextRect = labelRange.getBoundingClientRect()

      return {
        iconCenter: iconRect.top + iconRect.height / 2,
        labelCenter: labelRect.top + labelRect.height / 2,
        labelTextBottom: labelTextRect.bottom,
        ordinaryTextBottom: ordinaryTextRect.bottom
      }
    })
    if (!inlineAlignment) throw new Error('Expected measurable inline reference geometry')
    expect(Math.abs(inlineAlignment.iconCenter - inlineAlignment.labelCenter)).toBeLessThanOrEqual(
      1
    )
    expect(
      Math.abs(inlineAlignment.labelTextBottom - inlineAlignment.ordinaryTextBottom)
    ).toBeLessThanOrEqual(1)

    const externalLink = assistant.locator('a[data-inline-reference-kind="external-url"]')
    await expect(externalLink).toHaveAttribute('href', 'https://example.test/docs')
    const resourceToken = assistant.locator('[data-inline-reference-kind="mcp-resource"]')
    await expect(resourceToken).toHaveAttribute('data-interactive', 'false')
    expect(await resourceToken.getAttribute('tabindex')).toBeNull()
    await expect(assistant.locator('a[href^="javascript:"]')).toHaveCount(0)

    await appToken.hover()
    await expect(page.getByRole('tooltip')).toContainText('app://github')

    await fileToken.focus()
    await expect(
      page
        .locator('[role="tooltip"]')
        .filter({ hasText: 'desktop-app/src/renderer/src/App.tsx:42' })
    ).toContainText('desktop-app/src/renderer/src/App.tsx:42')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('renders web search and exploration render units through the real desktop chat flow', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const query = 'render unit parity e2e'
  const backend = await startMockBackend({
    modelApiBasePath: '/api/codex',
    modelProvider: 'OpenAI',
    responses: [
      webSearchResponse('resp-web-search-tool', 'web-run-1', query),
      shellCommandResponse('resp-exploration-tool', 'call-read-package', {
        command: 'cat package.json',
        timeout_ms: 5000
      }),
      assistantMessageResponse(
        'resp-render-unit-final',
        'msg-render-unit-final',
        'Web search and exploration render units complete'
      )
    ],
    searchResponses: [{ encrypted_output: 'ciphertext', output: 'Search result' }]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      configureCodexHome: async (codexHomeDir) => {
        await writeStandaloneWebSearchConfig(codexHomeDir, backend)
        await writeFakeChatGptAuth(codexHomeDir)
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, '搜索 render unit parity，然后总结。')

    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'Web search and exploration render units complete'
    )
    const completedReasoningTrigger = page.locator('[data-slot="reasoning-group-trigger"]').last()
    await expect(completedReasoningTrigger).toContainText('已处理')
    await completedReasoningTrigger.click()

    const activityGroup = page.locator(
      '[data-slot="tool-group-unit"][data-tool-group-kind="composite"]'
    )
    await expect(activityGroup).toBeVisible()
    await expect(activityGroup).toContainText('已搜索')
    await expect(activityGroup).toContainText('已读取')

    await activityGroup.locator('[data-slot="tool-group-trigger"]').click()
    await expect(page.locator('[data-slot="web-search-details"]')).toContainText(query)
    await expect(page.locator('[data-slot="web-search-details"]')).toContainText('已搜索网页')
    await expect(activityGroup).toContainText('package.json')
    const searchRequest = backend.requests.find(
      (request) => request.method === 'POST' && request.url === '/api/codex/alpha/search'
    )
    expect(searchRequest).toBeDefined()
    if (!searchRequest) throw new Error('Expected standalone web search request')

    const searchBody = JSON.parse(searchRequest.body) as {
      commands?: { search_query?: Array<{ q?: string }> }
    }
    expect(searchBody.commands?.search_query?.[0]?.q).toBe(query)
    expect(
      backend.requests.filter((request) => request.method === 'POST' && isResponsesUrl(request.url))
    ).toHaveLength(3)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('renders live turn status and a completed turn-diff card through the desktop chat flow', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-e2e-turn-diff-'))
  await writeFile(join(projectRoot, 'notes.txt'), 'before\n', 'utf8')

  const patch = `*** Begin Patch
*** Update File: notes.txt
@@
-before
+after from e2e
*** End Patch
`
  const releaseFinalResponse = deferred()
  const backend = await startMockBackend({
    responses: [
      applyPatchResponse('resp-turn-diff-patch', 'call-turn-diff-patch', patch),
      {
        ...assistantMessageResponse(
          'resp-turn-diff-final',
          'msg-turn-diff-final',
          'Turn diff render unit complete'
        ),
        beforeResponse: () => releaseFinalResponse.promise
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await expect(page.locator('body')).toContainText('qwen3.7-plus')
    const projectName = `E2E Turn Diff ${Date.now().toString(36)}`
    await createLocalProject(page, projectName, projectRoot)
    await expect(page.locator('[data-slot="composer-project-card"]')).toContainText(projectName)

    await sendComposerMessage(page, '更新 notes.txt，并展示这次文件变更。')

    const panel = page.locator('[data-slot="server-request-panel"]')
    const approvalAppeared = await panel
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (approvalAppeared) {
      await expect(panel).toContainText('是否允许 ChatGPT 编辑以下文件？')
      await expect(panel).toContainText('notes.txt')
      await panel.getByRole('button', { name: '允许一次', exact: true }).click()
      await expect(panel).toBeHidden()
    }

    const statusCard = page.locator('[data-slot="composer-turn-status-card"]')
    await expect(statusCard).toBeVisible()
    await expect(statusCard).toContainText('1 个文件已更改')
    await expect(statusCard).toContainText('+1')
    await expect(statusCard).toContainText('-1')
    await expect(page.locator('[data-slot="turn-diff-entry-unit"]')).toHaveCount(0)

    const composer = page.locator('[data-slot="aui_composer-shell"]')
    const [statusBox, composerBox] = await Promise.all([
      statusCard.boundingBox(),
      composer.boundingBox()
    ])
    expect(statusBox).not.toBeNull()
    expect(composerBox).not.toBeNull()
    if (!statusBox || !composerBox) throw new Error('Expected status card and composer bounds')
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(composerBox.y)
    expect(
      Math.abs(statusBox.x + statusBox.width / 2 - (composerBox.x + composerBox.width / 2))
    ).toBeLessThan(2)

    releaseFinalResponse.resolve()
    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'Turn diff render unit complete'
    )
    await expect(statusCard).toHaveCount(0)
    const completedDiff = page.locator('[data-slot="turn-diff-entry-unit"]')
    await expect(completedDiff).toBeVisible()
    await expect(page.locator('[data-slot="completed-turn-diff"]')).toHaveCount(0)
    await expect(
      page.locator('[data-slot="reasoning-group-content"] [data-slot="turn-diff-entry-unit"]')
    ).toHaveCount(0)
    await expect(completedDiff).toContainText('已编辑 1 个文件')
    await expect(completedDiff).toContainText('notes.txt')
    await expect(
      completedDiff.getByRole('button', { name: '审核', exact: true }).first()
    ).toBeVisible()
    const completedAssistant = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: 'Turn diff render unit complete' })
    await expect(completedAssistant).toBeVisible()
    expect(
      await completedAssistant.evaluate((assistant) => {
        const finalAnswer = Array.from(
          assistant.querySelectorAll<HTMLElement>('[data-slot="assistant-render-text"]')
        ).find((element) => element.textContent?.includes('Turn diff render unit complete'))
        const diff = assistant.querySelector('[data-slot="turn-diff-entry-unit"]')
        return Boolean(
          finalAnswer &&
          diff &&
          finalAnswer.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING
        )
      })
    ).toBe(true)
    await expect
      .poll(() => readFile(join(projectRoot, 'notes.txt'), 'utf8'))
      .toBe('after from e2e\n')
    expect(
      backend.requests.filter((request) => request.method === 'POST' && isResponsesUrl(request.url))
    ).toHaveLength(2)
  } finally {
    releaseFinalResponse.resolve()
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot])
  }
})
