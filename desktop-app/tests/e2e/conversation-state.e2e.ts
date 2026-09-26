import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import { planAssert } from '../../scripts/lib/test-plan-assertions.mjs'
import { conversationDraftStorageKey } from '../../src/renderer/src/runtime/ConversationDraftStore'

import {
  attachDiagnostics,
  cleanupTempDirs,
  closeApp,
  collectRendererLogs,
  launchApp
} from './support/app'
import { sendComposerMessage, sendMessage } from './support/chatActions'
import {
  assistantMessageResponse,
  deferred,
  providerResponseBodies,
  responseCreated,
  startMockBackend
} from './support/mockBackend'

const transcriptRecoveryStorageKey = 'das-cowork.transcript-recovery.v1'

test('restores per-thread drafts after restart but keeps scroll restoration session-only', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const userDataDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-persistent-user-data-'))
  const codexHomeDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-persistent-codex-home-'))
  const runId = Date.now().toString(36)
  const firstPrompt = `state-first-${runId}`
  const secondPrompt = `state-second-${runId}`
  const firstDraft = `unsent first draft ${runId}`
  const secondDraft = `unsent second draft ${runId}`
  const firstTail = `state first response tail ${runId}`
  const longFirstResponse = `${Array.from(
    { length: 120 },
    (_, index) => `Paragraph ${index + 1}: multi-conversation scroll state ${runId}.`
  ).join('\n\n')}\n\n${firstTail}`
  const secondResponse = `state second response ${runId}`
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse('resp-state-first', 'msg-state-first', longFirstResponse),
      assistantMessageResponse('resp-state-second', 'msg-state-second', secondResponse)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  const launchPersistentApp = (): Promise<ElectronApplication> =>
    launchApp(backend, logs, {
      userDataDir,
      codexHomeDir,
      preserveDataDirectories: true
    })

  try {
    app = await launchPersistentApp()
    let page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, firstPrompt)
    await expect(page.locator('[data-role="assistant"]')).toContainText(firstTail)

    let sidebar = page.locator('[data-slot="codex-sidebar"]')
    await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
    await sendComposerMessage(page, secondPrompt)
    await expect(page.locator('[data-role="assistant"]')).toContainText(secondResponse)

    let contextPanel = await searchComposerContext(page, firstPrompt)
    await expect(contextPanel.getByRole('option').filter({ hasText: firstPrompt })).toHaveCount(1)
    await expect(contextPanel.getByRole('option').filter({ hasText: secondPrompt })).toHaveCount(0)
    await page.keyboard.press('Escape')

    let input = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await input.fill(secondDraft)
    await expectDraftStorageToContain(page, secondDraft)

    await sidebar.getByRole('button', { name: new RegExp(`^${firstPrompt}`) }).click()
    contextPanel = await searchComposerContext(page, secondPrompt)
    await expect(contextPanel.getByRole('option').filter({ hasText: secondPrompt })).toHaveCount(1)
    await expect(contextPanel.getByRole('option').filter({ hasText: firstPrompt })).toHaveCount(0)
    await page.keyboard.press('Escape')
    input = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await input.fill(firstDraft)
    await expectDraftStorageToContain(page, firstDraft)

    let viewport = page.locator('[data-slot="aui_thread-viewport"]')
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(300)
    const scrollTarget = await viewport.evaluate((element) => {
      const target = Math.min(180, element.scrollHeight - element.clientHeight - 80)
      element.style.scrollBehavior = 'auto'
      element.scrollTop = target
      return target
    })
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(scrollTarget)
    const savedScrollTop = await viewport.evaluate((element) => element.scrollTop)

    await sidebar.getByRole('button', { name: new RegExp(`^${secondPrompt}`) }).click()
    await expect(input).toHaveText(secondDraft)
    await sidebar.getByRole('button', { name: new RegExp(`^${firstPrompt}`) }).click()
    await expect(input).toHaveText(firstDraft)
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(savedScrollTop - 40)
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollTop))
      .toBeLessThan(savedScrollTop + 40)

    await closeApp(app)
    app = undefined

    app = await launchPersistentApp()
    page = await app.firstWindow()
    collectRendererLogs(page, logs)
    sidebar = page.locator('[data-slot="codex-sidebar"]')
    input = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    viewport = page.locator('[data-slot="aui_thread-viewport"]')

    await sidebar.getByRole('button', { name: new RegExp(`^${secondPrompt}`) }).click()
    await expect(input).toHaveText(secondDraft)
    await sidebar.getByRole('button', { name: new RegExp(`^${firstPrompt}`) }).click()
    await expect(input).toHaveText(firstDraft)
    await expect(page.locator('[data-role="assistant"]')).toContainText(firstTail)

    await expect
      .poll(() =>
        viewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop
        )
      )
      .toBeLessThan(40)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([userDataDir, codexHomeDir])
  }
})

test('M09/E12/F16 @recovery restores app-server history and delivers a queued follow-up once', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(120_000)

  const userDataDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-recovery-user-data-'))
  const codexHomeDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-recovery-codex-home-'))
  const releaseFailure = deferred()
  const prompt = `recovery-turn-${Date.now().toString(36)}`
  const queuedText = `recovery-queued-${Date.now().toString(36)}`
  const partialText = 'This canonical text must remain after restart.'
  const queuedResponseText = 'The unclaimed queued follow-up was sent exactly once after restart.'
  const backend = await startMockBackend({
    responses: [
      {
        events: [
          responseCreated('resp-recovery-failure'),
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              id: 'msg-recovery-failure',
              content: [{ type: 'output_text', text: '' }]
            }
          },
          { type: 'response.output_text.delta', delta: partialText },
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: 'msg-recovery-failure',
              content: [{ type: 'output_text', text: partialText }]
            }
          },
          { type: 'response.future.test-gate', payload: { stage: 'before-disconnect' } }
        ],
        beforeEvent: (_event, index) => (index === 4 ? releaseFailure.promise : undefined),
        termination: 'disconnect'
      },
      assistantMessageResponse('resp-recovery-queued', 'msg-recovery-queued', queuedResponseText)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined
  const launchPersistentApp = (): Promise<ElectronApplication> =>
    launchApp(backend, logs, {
      userDataDir,
      codexHomeDir,
      preserveDataDirectories: true
    })

  try {
    app = await launchPersistentApp()
    let page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, prompt)
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: partialText })
    ).toHaveCount(1)
    const input = page.locator('.aui-lexical-input[contenteditable="true"]').last()
    await input.fill(queuedText)
    await page.getByRole('button', { name: '将追问加入队列' }).click()
    await expect(
      page.locator('[data-slot="queued-follow-up-row"]').filter({ hasText: queuedText })
    ).toHaveCount(1)
    const queuedStateBeforeRestart = await readFollowUpQueueState(page)
    const queuedItemId = queuedStateBeforeRestart.items[0]?.id
    expect(queuedStateBeforeRestart.items).toEqual([
      {
        id: queuedItemId,
        status: 'queued',
        text: queuedText,
        lease: null
      }
    ])

    releaseFailure.resolve()
    await planAssert({
      scenarioId: 'M09',
      assertionId: '最终 UI 状态',
      assertion: async () => {
        await expect(page.locator('[data-slot="aui_assistant-message-error"]')).toHaveCount(1)
        await expect(
          page.locator('[data-role="assistant"]').filter({ hasText: partialText })
        ).toHaveCount(1)
      }
    })
    await planAssert({
      scenarioId: 'M09',
      assertionId: 'provider 请求数量',
      assertion: () => expect.poll(() => providerResponseBodies(backend).length).toBe(2)
    })
    await planAssert({
      scenarioId: 'M09',
      assertionId: 'turn started 数量',
      assertion: () =>
        expect
          .poll(() => logs.filter((line) => line.includes('"method":"turn/started"')).length)
          .toBe(2)
    })
    await planAssert({
      scenarioId: 'M09',
      assertionId: 'terminal 类型和次数',
      assertion: async () => {
        await expect
          .poll(() => logs.filter((line) => line.includes('"method":"turn/completed"')).length)
          .toBe(2)
        expect(logs.some((line) => line.includes('"status":"failed"'))).toBe(true)
        expect(logs.some((line) => line.includes('"status":"completed"'))).toBe(true)
      }
    })
    await planAssert({
      scenarioId: 'M09',
      assertionId: 'tool/approval 执行数量',
      assertion: async () => {
        await expect(page.locator('[data-slot="tool-group-unit"]')).toHaveCount(0)
        await expect(page.locator('[data-slot="server-request-panel"] article')).toHaveCount(0)
        expect(
          providerResponseBodies(backend).every(
            (body) => !JSON.stringify(body).includes('function_call_output')
          )
        ).toBe(true)
      }
    })
    await expect
      .poll(() =>
        page.evaluate(
          (key) => window.localStorage.getItem(key)?.includes('"terminalByTurnId"') ?? false,
          transcriptRecoveryStorageKey
        )
      )
      .toBe(false)
    await expect
      .poll(() =>
        page.evaluate(
          ({ key, expectedText }) =>
            window.localStorage.getItem(key)?.includes(expectedText) ?? false,
          { key: transcriptRecoveryStorageKey, expectedText: partialText }
        )
      )
      .toBe(false)

    await closeApp(app)
    app = undefined
    app = await launchPersistentApp()
    page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: new RegExp(`^${prompt}`) })
      .click()

    await planAssert({
      scenarioId: 'E12',
      assertionId: '重启从持久化状态恢复',
      assertion: () =>
        expect(
          page.locator('[data-role="assistant"]').filter({ hasText: partialText })
        ).toHaveCount(1)
    })
    await planAssert({
      scenarioId: 'F16',
      assertionId: '历史与已显示内容保留',
      assertion: () =>
        expect(
          page.locator('[data-role="assistant"]').filter({ hasText: partialText })
        ).toHaveCount(1)
    })
    await planAssert({
      scenarioId: 'F16',
      assertionId: '错误、取消与重试 UI 正确',
      assertion: () =>
        expect(page.locator('[data-slot="aui_assistant-message-error"]')).toHaveCount(0)
    })
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: queuedResponseText })
    ).toHaveCount(1)
    await expect(page.locator('[data-role="user"]').filter({ hasText: queuedText })).toHaveCount(1)
    const recoveredQueueState = await readFollowUpQueueState(
      page,
      queuedStateBeforeRestart.conversationKey
    )
    await planAssert({
      scenarioId: 'E12',
      assertionId: '队列顺序、revision、lease 与消费状态正确',
      assertion: async () => {
        await expect(page.locator('[data-slot="queued-follow-up-row"]')).toHaveCount(0)
        expect(queuedItemId).toBeTruthy()
        expect(queuedStateBeforeRestart.items).toEqual([
          {
            id: queuedItemId,
            status: 'queued',
            text: queuedText,
            lease: null
          }
        ])
        expect(recoveredQueueState.conversationKey).toBe(queuedStateBeforeRestart.conversationKey)
        expect(recoveredQueueState.items).toEqual([])
        expect(recoveredQueueState.revision).toBe(queuedStateBeforeRestart.revision + 2)
      }
    })
    await planAssert({
      scenarioId: 'M09',
      assertionId: '队列状态、顺序与 revision',
      assertion: async () => {
        await expect(page.locator('[data-slot="queued-follow-up-row"]')).toHaveCount(0)
        expect(recoveredQueueState).toEqual({
          conversationKey: queuedStateBeforeRestart.conversationKey,
          revision: queuedStateBeforeRestart.revision + 2,
          items: []
        })
      }
    })
    await planAssert({
      scenarioId: 'E12',
      assertionId: '不能重复 claim 或自动重发',
      assertion: async () => {
        await expect.poll(() => providerResponseBodies(backend).length).toBe(2)
        expect(providerResponseBodies(backend)[1]).toEqual(
          expect.objectContaining({ input: expect.any(Array) })
        )
        expect(JSON.stringify(providerResponseBodies(backend)[1])).toContain(queuedText)
        await expect
          .poll(() => logs.filter((line) => line.includes('"method":"turn/started"')).length)
          .toBe(2)
        await expect
          .poll(() => logs.filter((line) => line.includes('"method":"turn/completed"')).length)
          .toBe(2)
        await expect(
          page.locator('[data-role="user"]').filter({ hasText: queuedText })
        ).toHaveCount(1)
      }
    })
    expect(
      logs.some(
        (line) =>
          line.includes('"method":"turn/completed"') && line.includes('"status":"completed"')
      )
    ).toBe(true)
    await planAssert({
      scenarioId: 'F16',
      assertionId: '可访问性、脱敏和 Composer 状态正确',
      assertion: () =>
        expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
    })
    await planAssert({
      scenarioId: 'M09',
      assertionId: 'renderer/page 健康',
      assertion: async () => {
        const expectedDisconnectErrors = logs.filter(
          (line) =>
            line.startsWith('[renderer:pageerror]') &&
            line.includes('stream disconnected before completion')
        )
        expect(expectedDisconnectErrors).toHaveLength(1)
        expect(
          logs.filter(
            (line) =>
              line.startsWith('[renderer:pageerror]') &&
              !line.includes('stream disconnected before completion')
          )
        ).toEqual([])
        expect(logs.filter((line) => /unhandled rejection/i.test(line))).toEqual([])
        await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
        await expect(
          page.locator('.aui-lexical-input[contenteditable="true"]').last()
        ).toBeEditable()
      }
    })
  } finally {
    releaseFailure.resolve()
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([userDataDir, codexHomeDir])
  }
})

async function readFollowUpQueueState(
  page: Page,
  knownConversationKey?: string
): Promise<{
  conversationKey: string
  revision: number
  items: Array<{
    id: string
    status: string
    text: string
    lease: { operation: string; owner: string } | null
  }>
}> {
  return page.evaluate(async (persistedConversationKey) => {
    const conversationKey =
      persistedConversationKey ??
      document
        .querySelector('[data-slot="queued-follow-up-list"]')
        ?.getAttribute('data-conversation-key')
    if (!conversationKey)
      throw new Error('The active conversation has no follow-up queue identity.')
    const state = await window.desktopApp.followUps.getState(conversationKey)
    return {
      conversationKey,
      revision: state.revision,
      items: state.items.map((item) => ({
        id: item.id,
        status: item.status,
        text: item.message.text,
        lease: item.lease ? { operation: item.lease.operation, owner: item.lease.owner } : null
      }))
    }
  }, knownConversationKey)
}

async function searchComposerContext(page: Page, query: string): Promise<Locator> {
  await page.getByRole('button', { name: '添加文件和更多', exact: true }).click()
  const panel = page.getByRole('listbox', { name: '添加上下文' })
  await expect(panel).toBeVisible()
  await page.locator('.aui-lexical-input[contenteditable="true"]').last().fill(query)
  return panel
}

async function expectDraftStorageToContain(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  draft: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        ({ key, expectedDraft }) =>
          window.localStorage.getItem(key)?.includes(expectedDraft) ?? false,
        { key: conversationDraftStorageKey, expectedDraft: draft }
      )
    )
    .toBe(true)
}
