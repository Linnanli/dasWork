import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import {
  attachDiagnostics,
  closeApp,
  cleanupTempDirs,
  collectRendererLogs,
  launchApp
} from './support/app'
import { sendComposerMessage, sendMessage } from './support/chatActions'
import {
  assistantMessageResponse,
  dynamicFunctionCallResponse,
  functionCallOutputCount,
  functionCallOutputText,
  providerResponseBodies,
  startMockBackend
} from './support/mockBackend'

test('AT-E2E-01 routes a real app-server MCP call through the desktop registry', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const runtimeRoot = await createRuntimeFixture()
  const callId = 'call-load-workspace-dependencies'
  const backend = await startMockBackend({
    responses: [
      dynamicFunctionCallResponse(
        'resp-app-tools-call',
        callId,
        'load_workspace_dependencies',
        {},
        { namespace: 'codex_app' }
      ),
      assistantMessageResponse(
        'resp-app-tools-final',
        'msg-app-tools-final',
        'Desktop runtime dependencies were loaded through the app tool.'
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      environment: {
        // This is deliberately empty. The production app must launch its
        // normal `codex app-server --listen stdio://` command, not a test RPC
        // implementation.
        CODEX_APP_SERVER_BIN: undefined,
        DASCOWORK_PRIMARY_RUNTIME_ROOT: runtimeRoot
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    await sendMessage(page, 'Load the local workspace dependencies now.')

    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'Desktop runtime dependencies were loaded through the app tool.'
    )

    const providerBodies = providerResponseBodies(backend)
    expect(providerBodies).toHaveLength(2)
    expect(functionCallOutputCount(providerBodies, callId)).toBe(1)
    const resultText = functionCallOutputText(providerBodies[1], callId)
    expect(resultText).toBeTruthy()
    const result = JSON.parse(resultText!) as {
      root?: string
      node?: string
      nodePackages?: Array<{ name?: string; path?: string }>
    }
    expect(result.root).toBe(runtimeRoot)
    expect(result.node).toBeInsideRuntime(runtimeRoot)
    expect(result.nodePackages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '@oai/artifact-tool',
          path: expect.toBeInsideRuntime(runtimeRoot)
        })
      ])
    )

    const firstRequest = providerBodies[0] as {
      tools?: Array<{ name?: string; tools?: unknown[] }>
    }
    expect(firstRequest.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'codex_app',
          tools: expect.arrayContaining([
            expect.objectContaining({
              name: 'load_workspace_dependencies',
              parameters: expect.objectContaining({ type: 'object' })
            })
          ])
        })
      ])
    )
    const toolGroup = page.locator('[data-slot="tool-group-unit"][data-tool-group-kind="dynamic"]')
    await expect(toolGroup).toContainText('已加载工作区依赖')
    await toolGroup.locator('[data-slot="tool-group-trigger"]').click()
    await toolGroup.locator('[data-slot="tool-fallback-trigger"]').click()
    await expect(toolGroup.locator('[data-slot="tool-fallback-args"]')).toContainText('{}')
    await expect(toolGroup.locator('[data-slot="tool-fallback-result"]')).toContainText(
      '@oai/artifact-tool'
    )
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(runtimeRoot, { recursive: true, force: true })
  }
})

test('AT-E2E-01 keeps a resumed thread on its original capability snapshot', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const initialRuntimeRoot = await createRuntimeFixture()
  const changedRuntimeRoot = await mkdtemp(join(tmpdir(), 'dascowork-app-tools-runtime-missing-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'dascowork-app-tools-user-data-'))
  const codexHomeDir = await mkdtemp(join(tmpdir(), 'dascowork-app-tools-codex-home-'))
  const backend = await startMockBackend({
    responses: [
      assistantMessageResponse(
        'resp-first-thread',
        'msg-first-thread',
        'Initial thread completed.'
      ),
      assistantMessageResponse(
        'resp-resumed-thread',
        'msg-resumed-thread',
        'Resumed thread completed.'
      ),
      assistantMessageResponse('resp-new-thread', 'msg-new-thread', 'New thread completed.')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      userDataDir,
      codexHomeDir,
      preserveDataDirectories: true,
      environment: {
        CODEX_APP_SERVER_BIN: undefined,
        DASCOWORK_PRIMARY_RUNTIME_ROOT: initialRuntimeRoot
      }
    })
    let page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await sendMessage(page, 'Create the thread with the initial desktop capability snapshot.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Initial thread completed.')

    const originalThreadId = await conversationId(page)
    expect(originalThreadId).toBeTruthy()

    await closeApp(app)
    app = undefined

    app = await launchApp(backend, logs, {
      userDataDir,
      codexHomeDir,
      preserveDataDirectories: true,
      environment: {
        CODEX_APP_SERVER_BIN: undefined,
        DASCOWORK_PRIMARY_RUNTIME_ROOT: changedRuntimeRoot
      }
    })
    page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await openPersistedConversation(page, originalThreadId!)
    await sendComposerMessage(page, 'Resume the original thread after the runtime changed.')
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: 'Resumed thread completed.' })
    ).toHaveCount(1)

    const resumeParams = outboundRequestParams(logs, 'thread/resume').at(-1)
    expect(resumeParams).toBeDefined()
    expect(resumeParams).not.toHaveProperty('dynamicTools')
    expect(resumeParams).not.toHaveProperty('developerInstructions')
    expect(resumeParams?.config).not.toHaveProperty('mcp_servers')

    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: '新对话', exact: true })
      .click()
    await sendComposerMessage(page, 'Start a new thread after the runtime changed.')
    await expect(
      page.locator('[data-role="assistant"]').filter({ hasText: 'New thread completed.' })
    ).toHaveCount(1)

    const newThreadParams = outboundRequestParams(logs, 'thread/start').at(-1)
    expect(newThreadParams).toBeDefined()
    expect(dynamicToolNames(newThreadParams)).toContain('read_thread_terminal')
    expect(dynamicToolNames(newThreadParams)).not.toContain('load_workspace_dependencies')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([initialRuntimeRoot, changedRuntimeRoot, userDataDir, codexHomeDir])
  }
})

async function createRuntimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dascowork-app-tools-runtime-'))
  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@oai', 'artifact-tool'), { recursive: true })
  await writeFile(join(root, 'bin', 'node'), '#!/bin/sh\n')
  await writeFile(join(root, 'node_modules', '@oai', 'artifact-tool', 'index.js'), 'export {}\n')
  await writeFile(
    join(root, 'node_modules', '@oai', 'artifact-tool', 'package.json'),
    JSON.stringify({ name: '@oai/artifact-tool', version: '1.0.0', main: './index.js' })
  )
  await writeFile(
    join(root, 'runtime.json'),
    JSON.stringify({
      bundleFormatVersion: 1,
      bundleVersion: 'e2e-fixture',
      target: { platform: process.platform, arch: process.arch },
      node: { path: 'bin/node', version: '22.0.0' },
      nodePackages: [
        {
          name: '@oai/artifact-tool',
          version: '1.0.0',
          path: 'node_modules/@oai/artifact-tool'
        }
      ]
    })
  )
  await chmod(join(root, 'bin', 'node'), 0o755)
  return realpath(root)
}

async function conversationId(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>
): Promise<string | undefined> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = await window.desktopApp.conversations.getConversationList()
        return result.conversations.at(0)?.threadId ?? result.conversations.at(0)?.id
      })
    )
    .toBeTruthy()
  return page.evaluate(async () => {
    const result = await window.desktopApp.conversations.getConversationList()
    return result.conversations.at(0)?.threadId ?? result.conversations.at(0)?.id
  })
}

async function openPersistedConversation(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>,
  conversationId: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        const result = await window.desktopApp.conversations.getConversationList()
        return result.conversations.find(
          (conversation) => conversation.id === id || conversation.threadId === id
        )?.title
      }, conversationId)
    )
    .toBeTruthy()
  const title = await page.evaluate(async (id) => {
    const result = await window.desktopApp.conversations.getConversationList()
    return result.conversations.find(
      (conversation) => conversation.id === id || conversation.threadId === id
    )?.title
  }, conversationId)
  expect(title).toBeTruthy()
  await page
    .locator('[data-slot="codex-sidebar"]')
    .getByRole('button', { name: title!, exact: true })
    .click()
}

function outboundRequestParams(
  logs: readonly string[],
  method: string
): Array<Record<string, unknown>> {
  return logs.flatMap((line) => {
    const marker = '[codex packet] '
    const index = line.indexOf(marker)
    if (index < 0) return []

    try {
      const packet = JSON.parse(line.slice(index + marker.length)) as {
        direction?: unknown
        message?: { method?: unknown; params?: unknown }
      }
      if (
        packet.direction !== 'outbound' ||
        packet.message?.method !== method ||
        !packet.message.params ||
        typeof packet.message.params !== 'object' ||
        Array.isArray(packet.message.params)
      ) {
        return []
      }
      return [packet.message.params]
    } catch {
      return []
    }
  })
}

function dynamicToolNames(params: Record<string, unknown> | undefined): string[] {
  const dynamicTools = params?.dynamicTools
  if (!Array.isArray(dynamicTools)) return []
  return dynamicTools.flatMap((namespace) => {
    if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) return []
    const tools = (namespace as { tools?: unknown }).tools
    if (!Array.isArray(tools)) return []
    return tools.flatMap((tool) =>
      tool &&
      typeof tool === 'object' &&
      !Array.isArray(tool) &&
      typeof (tool as { name?: unknown }).name === 'string'
        ? [(tool as { name: string }).name]
        : []
    )
  })
}

expect.extend({
  toBeInsideRuntime(received: unknown, root: string) {
    if (typeof received !== 'string') {
      return { pass: false, message: () => `Expected a runtime path, received ${String(received)}` }
    }
    const difference = relative(root, received)
    const pass = difference === '' || (!difference.startsWith('..') && !difference.startsWith('/'))
    return {
      pass,
      message: () => `Expected ${received} to be inside ${root}`
    }
  }
})

declare module '@playwright/test' {
  interface Matchers<R, T> {
    toBeInsideRuntime(root: string): T extends string ? R : R
  }
}
