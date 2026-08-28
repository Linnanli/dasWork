import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import {
  attachDiagnostics,
  cleanupTempDirs,
  closeApp,
  collectRendererLogs,
  expectAppReady,
  launchApp
} from './support/app'
import {
  createLocalProject,
  ensureLocalProjectSelected,
  sendComposerMessage
} from './support/chatActions'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

const execFile = promisify(execFileCallback)

test('uses one Composer panel for slash and @ commands without sending text', async ({
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
    await ensureLocalProjectSelected(page)

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('codex:list-mcp-servers')
      ipcMain.handle('codex:list-mcp-servers', () => ({
        version: 1,
        generatedAt: '2026-08-01T00:00:00.000Z',
        servers: [{ name: 'github', connected: true, authStatus: 'oAuth', toolCount: 2 }]
      }))
    })

    const composerInput = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await composerInput.fill('/mcp')

    const commandPanel = page.getByRole('listbox', { name: '命令' })
    await expect(commandPanel).toHaveCount(1)
    await expect(commandPanel.getByRole('option', { name: /MCP/ })).toBeVisible()

    await page.keyboard.press('Enter')
    const mcpContent = page.getByTestId('composer-suggestion-panel')
    await expect(mcpContent).toHaveCount(1)
    await expect(mcpContent).toContainText('MCP servers')
    await expect(mcpContent).toContainText('github')
    await expect(mcpContent).toContainText('2 tools')

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('composer-suggestion-panel')).toHaveCount(0)

    await composerInput.fill('/new')
    await expect(commandPanel.getByRole('option', { name: /New chat/ })).toBeVisible()
    const requestCountBeforeNewChat = backend.requests.length
    await page.keyboard.press('Enter')

    await expect.poll(() => composerInput.textContent()).toBe('')
    expect(backend.requests).toHaveLength(requestCountBeforeNewChat)

    await composerInput.fill('/goal')
    await expect(
      commandPanel.getByRole('option', { name: /目标.*设置要持续追求的目标/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.aui-lexical-placeholder').last()).toHaveText(
      '描述你的目标，定义可衡量的成果，以获得最佳效果'
    )
    await expect(page.getByRole('button', { name: '退出目标编辑' })).toBeVisible()

    await composerInput.fill('/plan')
    await expect(commandPanel.getByRole('option', { name: /计划模式.*开启计划模式/ })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.aui-lexical-placeholder').last()).toHaveText(
      '描述你的任务以生成计划…'
    )
    await expect(page.getByRole('button', { name: '关闭计划模式' })).toBeVisible()

    await page.getByRole('button', { name: '关闭计划模式' }).click()
    await expect(page.locator('.aui-lexical-placeholder').last()).toHaveText(
      '输入消息（@ 提及工具，/ 输入命令）'
    )

    await composerInput.fill('/model')
    await expect(
      commandPanel.getByRole('option', { name: /模型.*选择用于下一轮任务的模型/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-slot="model-selector-list"]')).toHaveCount(1)
    await page.keyboard.press('Escape')

    await composerInput.fill('@')
    const contextPanel = page.getByRole('listbox', { name: '添加上下文' })
    await expect(
      contextPanel.getByRole('option', { name: /目标.*设置要持续追求的目标/ })
    ).toBeVisible()
    await expect(contextPanel.getByRole('option', { name: /计划.*开启计划模式/ })).toBeVisible()
    await contextPanel.getByRole('option', { name: /目标.*设置要持续追求的目标/ }).click()
    await expect(page.locator('.aui-lexical-placeholder').last()).toHaveText(
      '描述你的目标，定义可衡量的成果，以获得最佳效果'
    )

    await composerInput.fill('@')
    await expect(contextPanel.getByRole('option', { name: /计划.*开启计划模式/ })).toBeVisible()
    await contextPanel.getByRole('option', { name: /计划.*开启计划模式/ }).click()
    await expect(page.locator('.aui-lexical-placeholder').last()).toHaveText(
      '描述你的任务以生成计划…'
    )

    expect(backend.requests).toHaveLength(requestCountBeforeNewChat)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('sends Plan as a real turn/start collaboration mode packet', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [assistantMessageResponse('plan-mode', 'plan-mode-message', 'Plan response')]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await ensureLocalProjectSelected(page)

    const composerInput = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await composerInput.fill('/plan')
    await expect(
      page.getByRole('listbox', { name: '命令' }).getByRole('option', { name: /计划模式/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await sendComposerMessage(page, '为这项工作拟定一个计划。')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Plan response')

    await expect
      .poll(() => logs.some((line) => line.includes('"debug":"turn/start"')), {
        timeout: 10_000
      })
      .toBe(true)
    const turnStartPacket = logs.findLast((line) => line.includes('"debug":"turn/start"'))
    expect(turnStartPacket).toContain('"collaborationMode":{"mode":"plan"')
    expect(turnStartPacket).toContain('"developer_instructions":null')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('sends slash-selected reasoning effort in the default collaboration mode', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('reasoning-mode', 'reasoning-mode-message', 'Reasoned response')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('codex:list-models')
      ipcMain.handle('codex:list-models', () => ({
        models: [
          {
            id: 'qwen3.7-plus',
            displayName: 'qwen3.7-plus',
            inputModalities: ['text'],
            reasoningEfforts: [{ id: 'low' }, { id: 'high' }],
            defaultReasoningEffort: 'high',
            isDefault: true
          }
        ],
        selectedModelId: 'qwen3.7-plus'
      }))
    })
    await page.reload()
    await expectAppReady(page)
    await ensureLocalProjectSelected(page)

    const composerInput = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await composerInput.fill('/reasoning')
    await expect(
      page.getByRole('listbox', { name: '命令' }).getByRole('option', { name: /推理强度/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('[data-slot="model-selector-effort"]')).toHaveCount(1)
    await page.getByRole('button', { name: 'low', exact: true }).click()
    await page.keyboard.press('Escape')

    await sendComposerMessage(page, '使用低推理强度回复。')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Reasoned response')
    await expect
      .poll(() => logs.some((line) => line.includes('"reasoning_effort":"low"')), {
        timeout: 10_000
      })
      .toBe(true)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('resumes an existing conversation Goal without adding a user turn', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'existing-goal-initial',
        'existing-goal-initial-message',
        'Initial reply'
      ),
      assistantMessageResponse(
        'existing-goal-continuation',
        'existing-goal-continuation-message',
        'Goal reply'
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await ensureLocalProjectSelected(page)
    await sendComposerMessage(page, '先创建这个已有会话。')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Initial reply')

    const turnStartCountBeforeGoal = logs.filter((line) =>
      line.includes('"debug":"turn/start"')
    ).length
    const composerInput = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await composerInput.fill('/goal')
    await expect(
      page.getByRole('listbox', { name: '命令' }).getByRole('option', { name: /目标/ })
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await composerInput.fill('继续完成这个已有任务。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()

    await expect
      .poll(() => logs.some((line) => line.includes('"method":"thread/goal/set"')), {
        timeout: 10_000
      })
      .toBe(true)
    const goalControlLogs = logs.join('\n')
    expect(goalControlLogs.indexOf('"debug":"thread/resume"')).toBeLessThan(
      goalControlLogs.indexOf('"method":"thread/goal/set"')
    )
    expect(logs.filter((line) => line.includes('"debug":"turn/start"')).length).toBe(
      turnStartCountBeforeGoal
    )
    await expect(page.getByRole('button', { name: '清除目标' })).toBeVisible()

    const goalSetCountBeforeEdit = logs.filter((line) =>
      line.includes('"method":"thread/goal/set"')
    ).length
    const userMessageCountBeforeEdit = await page.locator('[data-role="user"]').count()
    await page.getByRole('button', { name: '编辑目标' }).click()
    const goalEditor = page.getByRole('textbox', { name: '目标内容' })
    await expect(goalEditor).toHaveValue('继续完成这个已有任务。')
    await goalEditor.fill('调整为新的持续目标。')
    await page.getByRole('button', { name: '保存目标' }).click()

    await expect
      .poll(() => logs.filter((line) => line.includes('"method":"thread/goal/set"')).length, {
        timeout: 10_000
      })
      .toBe(goalSetCountBeforeEdit + 1)
    await expect(page.getByRole('textbox', { name: '目标内容' })).toHaveCount(0)
    await expect(page.locator('[data-role="user"]')).toHaveCount(userMessageCountBeforeEdit)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('submits code review from the slash command without leaking composer state', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('review-command', 'review-command-message', 'Ready to review'),
      assistantMessageResponse(
        'review-command-result',
        'review-command-result-message',
        'Code review complete.'
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined
  const projectRoot = await mkdtemp(join(tmpdir(), 'dascowork-composer-command-review-'))
  const attachmentDir = await mkdtemp(join(tmpdir(), 'dascowork-composer-command-attachment-'))
  const attachmentPath = join(attachmentDir, 'REVIEW_ATTACHMENT_MARKER_DO_NOT_SEND.txt')

  try {
    await initializeGitRepository(projectRoot)
    await writeFile(join(projectRoot, 'notes.txt'), 'review change\n', 'utf8')
    await writeFile(attachmentPath, 'This attachment must not reach the code review request.')
    app = await launchApp(backend, logs)
    await app.evaluate(
      ({ dialog }, filePaths) => {
        Object.assign(dialog, {
          showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
          showOpenDialog: async () => ({ canceled: false, filePaths, bookmarks: [] })
        })
      },
      [attachmentPath]
    )
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, `Composer review ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Prepare the code review command.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Ready to review')

    const composerInput = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await composerInput.fill('REVIEW_DRAFT_MARKER_DO_NOT_SEND')
    await composerInput.fill('')
    const addContextButton = page.getByRole('button', { name: '添加文件和更多', exact: true })
    await addContextButton.click()
    await page.getByRole('option', { name: 'Files and folders', exact: true }).click()
    await expect(page.getByRole('button', { name: 'File attachment', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Remove file', exact: true }).click()

    await composerInput.fill('/review')
    const commandPanel = page.getByRole('listbox', { name: '命令' })
    await expect(commandPanel.getByRole('option', { name: /Code review/ })).toBeVisible()
    await page.keyboard.press('Enter')

    const reviewContent = page.locator('[data-slot="composer-code-review-command-content"]')
    await expect(reviewContent).toBeVisible()
    await expect(reviewContent).toContainText('审查未提交的更改')
    await expect(reviewContent).toContainText('基于基础分支进行审查')
    await expect(reviewContent.getByRole('button')).toHaveCount(2)
    await expect(composerInput).toBeVisible()

    await reviewContent.getByRole('button', { name: '审查未提交的更改', exact: true }).click()
    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
      'Code review complete.'
    )
    await expect(reviewContent).toHaveCount(0)

    const reviewRequest = backend.requests.find(
      (request) =>
        request.method === 'POST' &&
        request.url === '/responses' &&
        request.body.includes('## Code review guidelines:')
    )
    expect(reviewRequest).toBeTruthy()
    expect(reviewRequest?.body).toContain('## My request for Codex:')
    expect(reviewRequest?.body).toContain('请检查我未提交的更改')
    expect(reviewRequest?.body).not.toContain('REVIEW_DRAFT_MARKER_DO_NOT_SEND')
    expect(reviewRequest?.body).not.toContain('REVIEW_ATTACHMENT_MARKER_DO_NOT_SEND')
    expect(reviewRequest?.body).not.toContain(attachmentPath)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([projectRoot, attachmentDir])
  }
})

async function initializeGitRepository(projectRoot: string): Promise<void> {
  await execFile('git', ['init'], { cwd: projectRoot })
  await execFile('git', ['config', 'user.email', 'e2e@example.test'], { cwd: projectRoot })
  await execFile('git', ['config', 'user.name', 'E2E'], { cwd: projectRoot })
  await writeFile(join(projectRoot, 'notes.txt'), 'initial\n', 'utf8')
  await execFile('git', ['add', 'notes.txt'], { cwd: projectRoot })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: projectRoot })
}
