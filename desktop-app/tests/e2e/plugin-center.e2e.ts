import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import {
  appRoot,
  attachDiagnostics,
  cleanupTempDirs,
  closeApp,
  collectRendererLogs,
  launchApp
} from './support/app'
import { assistantMessageResponse, startMockBackend } from './support/mockBackend'

test.describe.configure({ timeout: 90_000 })

test('opens the Plugin Center from the sidebar', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  const backend = await startMockBackend({
    responses: [assistantMessageResponse('plugin-center-models', 'plugin-center-message', 'ok')]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    const sidebar = page.locator('[data-slot="codex-sidebar"]')
    await sidebar.getByRole('button', { name: '插件', exact: true }).click()

    await expect(page.locator('[data-slot="plugin-center-page"]')).toBeVisible()
    await expect(page.getByRole('tab', { name: '插件', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: '技能', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '刷新插件中心' })).toBeVisible()
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

test('renders a non-empty Plugin Center snapshot from the app-server catalog without narrow overflow', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page, rpcLogPath }) => {
    await openPluginCenter(page)

    await expect(page.locator('[data-slot="plugin-center-page"]')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'E2E Installable Plugin' })).toBeVisible()
    await expect
      .poll(async () =>
        (await rpcMethods(rpcLogPath)).filter(
          ({ method }) => method === 'plugin/list' || method === 'plugin/read'
        )
      )
      .toEqual([expect.objectContaining({ method: 'plugin/list' })])
    await expect(page.locator('[data-slot="installed-plugin-icon"]')).toHaveCount(1)
    await expect(page.locator('[data-slot="installed-plugins"] article')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '刷新插件中心' })).toBeVisible()
    await expect(page.getByRole('button', { name: '添加' })).toBeVisible()
    await page.getByRole('tab', { name: '技能', exact: true }).click()
    await expect(page.getByText('Workspace Skill')).toBeVisible()
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '设置已安装插件' }).click()
    await expect(page.getByRole('tab', { name: /插件 1/ })).toHaveAttribute('data-state', 'active')
    await page.getByRole('tab', { name: /应用/ }).click()
    await expect(page.getByText('E2E App from app/read', { exact: true }).last()).toBeVisible()
    await expect(
      page.getByText('Short description returned by app/read.', { exact: true })
    ).toBeVisible()
    await expect(page.getByRole('switch', { name: 'E2E App from app/read 启用' })).toBeVisible()
    await expect(page.locator('[data-slot="plugin-center-page"]')).not.toContainText(
      '此应用当前不可访问或需要连接帐户'
    )
    await page.getByRole('tab', { name: /MCP/ }).click()
    await expect(page.getByText('local_tools')).toBeVisible()

    await page.setViewportSize({ width: 420, height: 900 })
    const width = await page.locator('body').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1)
  })
})

test('installs a marketplace plugin through the Plugin Center app-server RPC path', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page, rpcLogPath }) => {
    await openPluginCenter(page)
    const beforeMutation = await rpcMethods(rpcLogPath)
    const pluginListCountBefore = beforeMutation.filter(
      ({ method }) => method === 'plugin/list'
    ).length
    const installedCountBefore = beforeMutation.filter(
      ({ method }) => method === 'plugin/installed'
    ).length

    const pluginCard = page.locator('article').filter({ hasText: 'E2E Installable Plugin' })
    await pluginCard.getByRole('button', { name: '安装' }).click()
    await expect(pluginCard.getByRole('button', { name: '安装' })).toHaveCount(0)

    await expect
      .poll(() => rpcMethods(rpcLogPath))
      .toContainEqual(
        expect.objectContaining({
          method: 'plugin/install',
          params: expect.objectContaining({ pluginName: 'available-plugin' })
        })
      )
    await expect
      .poll(async () =>
        (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'plugin/list')
      )
      .toHaveLength(pluginListCountBefore)
    await expect
      .poll(async () =>
        (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'plugin/installed')
      )
      .toHaveLength(installedCountBefore + 1)
  })
})

test('opens one plugin detail, preserves the detail action context, and creates an unsent app draft', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page, rpcLogPath }) => {
    await openPluginCenter(page)
    const turnStartCountBefore = (await rpcMethods(rpcLogPath)).filter(
      ({ method }) => method === 'turn/start'
    ).length
    const pluginCard = page
      .locator('[data-slot="plugin-card"]')
      .filter({ hasText: 'E2E Installable Plugin' })

    await pluginCard.getByRole('button', { name: '查看 E2E Installable Plugin 详情' }).click()

    const detail = page.locator('[data-slot="plugin-detail-page"]')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('Use the E2E fixture to inspect a repository.')
    await expect(detail.locator('[data-slot="plugin-detail-app-row"]')).toContainText(
      'E2E App from app/read'
    )
    await expect(detail.locator('[data-slot="plugin-detail-app-row"]')).toContainText(
      'Short description returned by app/read.'
    )
    await expect(detail.locator('[data-slot="plugin-detail-app-row"]')).not.toContainText(
      '此应用当前不可访问或需要连接帐户'
    )
    await expect(detail).not.toContainText('Find and reference emails from your inbox.')
    await expect(detail).toContainText('Repository access')
    await expect
      .poll(async () =>
        (await rpcMethods(rpcLogPath)).filter(
          ({ method, params }) =>
            method === 'plugin/read' &&
            params.remoteMarketplaceName === 'e2e-market' &&
            params.pluginName === 'available-plugin'
        )
      )
      .toHaveLength(1)
    expect(
      (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'app/read').at(-1)
    ).toEqual(expect.objectContaining({ params: { appIds: ['e2e-app'] } }))

    await page.setViewportSize({ width: 420, height: 900 })
    const width = await page.locator('body').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1)
    await page.screenshot({ path: testInfo.outputPath('plugin-detail-420x900.png') })

    await detail.getByRole('button', { name: '安装插件' }).click()
    await expect(detail).toBeVisible()
    const appCard = detail.locator('[data-slot="plugin-detail-app-row"]')
    await appCard.getByRole('button', { name: '连接 E2E App from app/read' }).click()
    await expect
      .poll(() => rpcMethods(rpcLogPath))
      .toContainEqual(
        expect.objectContaining({
          method: 'config/batchWrite',
          params: expect.objectContaining({
            edits: expect.arrayContaining([
              expect.objectContaining({ keyPath: 'apps."e2e-app".enabled', value: true })
            ])
          })
        })
      )
    const connectedMenu = appCard.getByRole('button', {
      name: 'E2E App from app/read 已连接，打开管理菜单'
    })
    await expect(connectedMenu).toBeVisible()
    await connectedMenu.click()
    await expect(page.getByRole('menuitem', { name: '重新连接' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '断开连接' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '添加账户' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: '重新连接' })).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await appCard.click()
    const toolsDialog = page.getByRole('dialog')
    await expect(toolsDialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(toolsDialog).toHaveCount(0)
    await appCard.press('Space')
    await expect(toolsDialog).toBeVisible()
    await expect(toolsDialog).toContainText('会更改数据 1')
    await expect(toolsDialog).toContainText('只读 1')
    await expect
      .poll(async () =>
        (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'app/read').at(-1)
      )
      .toEqual(expect.objectContaining({ params: { appIds: ['e2e-app'], includeTools: true } }))
    const writeTools = toolsDialog.getByRole('button', { name: /会更改数据 1/ })
    await expect(writeTools).toHaveAttribute('aria-expanded', 'true')
    await writeTools.click()
    await expect(writeTools).toHaveAttribute('aria-expanded', 'false')
    await toolsDialog.getByRole('button', { name: '立即试用' }).click()
    await expect(page.locator('[data-slot="plugin-center-page"]')).toHaveCount(0)
    await expect
      .poll(async () =>
        (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'turn/start')
      )
      .toHaveLength(turnStartCountBefore)
  })
})

test('uses the plugin/read app description when the app-server does not support app/read', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(
    testInfo,
    async ({ page, rpcLogPath }) => {
      await openPluginCenter(page)
      const pluginCard = page
        .locator('[data-slot="plugin-card"]')
        .filter({ hasText: 'E2E Installable Plugin' })

      await pluginCard.getByRole('button', { name: '查看 E2E Installable Plugin 详情' }).click()

      const appCard = page.locator('[data-slot="plugin-detail-app-row"]')
      await expect(appCard).toContainText('Find and reference emails from your inbox.')
      await expect(appCard).not.toContainText('App returned by app/list.')
      expect(
        (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'app/read').at(-1)
      ).toEqual(expect.objectContaining({ params: { appIds: ['e2e-app'] } }))
    },
    { appReadUnsupported: true }
  )
})

test('adds a marketplace through the Plugin Center app-server RPC path', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page, rpcLogPath }) => {
    await openPluginCenter(page)

    await page.getByRole('button', { name: '添加' }).click()
    await page.getByRole('menuitem', { name: '添加插件市场' }).click()
    const dialog = page.getByRole('dialog', { name: '添加插件市场' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('来源').fill('owner/e2e-marketplace')
    await dialog.getByLabel('Git 引用').fill('main')
    await dialog.getByLabel('稀疏路径').fill('plugins')
    await dialog.getByRole('button', { name: '添加' }).click()
    await expect(dialog).toBeHidden()

    await expect
      .poll(() => rpcMethods(rpcLogPath))
      .toContainEqual(
        expect.objectContaining({
          method: 'marketplace/add',
          params: {
            source: 'owner/e2e-marketplace',
            refName: 'main',
            sparsePaths: ['plugins']
          }
        })
      )
  })
})

test('uses the prewarmed delayed 2917-plugin catalog for ten warm opens', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(
    testInfo,
    async ({ page, rpcLogPath }) => {
      await expect
        .poll(async () =>
          (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'plugin/list')
        )
        .toHaveLength(1)
      await page.waitForTimeout(5_200)

      const durations: number[] = []
      const sidebar = page.locator('[data-slot="codex-sidebar"]')
      for (let index = 0; index < 10; index += 1) {
        await sidebar.getByRole('button', { name: '新对话', exact: true }).click()
        await expect(page.locator('[data-slot="plugin-center-page"]')).toHaveCount(0)
        const startedAt = Date.now()
        await sidebar.getByRole('button', { name: '插件', exact: true }).click()
        await expect(page.getByRole('heading', { name: 'E2E Installable Plugin' })).toBeVisible()
        durations.push(Date.now() - startedAt)
      }

      await expect
        .poll(async () =>
          (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'plugin/list')
        )
        .toHaveLength(1)

      expect(percentile(durations, 95)).toBeLessThan(300)
    },
    { pluginListDelayMs: 5_000, extraPluginCount: 2_915 }
  )
})

test('joins the page open to an in-flight app prewarm plugin/list request', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(
    testInfo,
    async ({ page, rpcLogPath }) => {
      await expect
        .poll(async () =>
          (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'plugin/list')
        )
        .toHaveLength(1)

      await openPluginCenter(page)
      await expect(page.getByRole('heading', { name: 'E2E Installable Plugin' })).toBeVisible({
        timeout: 7_000
      })

      await expect
        .poll(async () =>
          (await rpcMethods(rpcLogPath)).filter(({ method }) => method === 'plugin/list')
        )
        .toHaveLength(1)
    },
    { pluginListDelayMs: 5_000 }
  )
})

test('keeps the previous plugin list visible while a forced refresh is delayed', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(
    testInfo,
    async ({ page }) => {
      await openPluginCenter(page)
      await expect(page.getByRole('heading', { name: 'E2E Installable Plugin' })).toBeVisible()

      await page.getByRole('button', { name: '刷新插件中心' }).click()

      await expect(page.getByRole('heading', { name: 'E2E Installable Plugin' })).toBeVisible()
      await expect(page.locator('[data-slot="plugin-center-page"]')).not.toContainText(
        '正在读取插件中心'
      )
    },
    { pluginListDelayMs: 1_000 }
  )
})

test('writes and reloads MCP config through the Plugin Center app-server RPC path', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page, rpcLogPath }) => {
    await openPluginCenter(page)
    await page.getByRole('button', { name: '管理' }).click()
    await page.getByRole('tab', { name: /MCP/ }).click()

    const existingServer = page.locator('article').filter({ hasText: 'local_tools' })
    await existingServer.getByRole('switch', { name: 'local_tools 停用' }).click()
    await expect(existingServer.getByRole('switch', { name: 'local_tools 启用' })).toBeVisible()

    await page.getByRole('button', { name: '添加' }).click()
    await page.getByRole('menuitem', { name: '添加 MCP 服务器' }).click()
    const dialog = page.getByRole('dialog', { name: '添加 MCP 服务器' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('显示名称').fill('New Tools')
    await dialog.getByLabel('Command to launch').fill('node')
    await dialog.getByLabel('Arguments').fill('new-tools-server.js')
    await dialog.getByLabel('Environment variable passthrough').fill('PATH')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('new_tools')).toBeVisible()

    await expect
      .poll(() => rpcMethods(rpcLogPath))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'config/batchWrite',
            params: expect.objectContaining({
              edits: expect.arrayContaining([
                expect.objectContaining({
                  keyPath: 'mcp_servers."local_tools".enabled',
                  value: false
                })
              ])
            })
          }),
          expect.objectContaining({ method: 'config/mcpServer/reload' }),
          expect.objectContaining({
            method: 'config/batchWrite',
            params: expect.objectContaining({
              edits: expect.arrayContaining([
                expect.objectContaining({
                  keyPath: 'mcp_servers."new_tools"',
                  value: expect.objectContaining({
                    command: 'node',
                    args: ['new-tools-server.js'],
                    env_vars: [{ name: 'PATH', source: 'local' }],
                    enabled: true
                  })
                })
              ])
            })
          })
        ])
      )
  })
})

type PluginCenterRunInput = {
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>
  rpcLogPath: string
}

type PluginCenterServerOptions = {
  pluginListDelayMs?: number
  extraPluginCount?: number
  appReadUnsupported?: boolean
}

async function withPluginCenterServer(
  testInfo: Parameters<typeof attachDiagnostics>[0],
  run: (input: PluginCenterRunInput) => Promise<void>,
  options: PluginCenterServerOptions = {}
): Promise<void> {
  const serverStateDir = await mkdtemp(join(tmpdir(), 'dascowork-e2e-plugin-center-'))
  const rpcLogPath = join(serverStateDir, 'rpc.log')
  const statePath = join(serverStateDir, 'state.json')
  const backend = await startMockBackend({
    responses: [assistantMessageResponse('plugin-center-models', 'plugin-center-message', 'ok')]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      environment: {
        CODEX_APP_SERVER_BIN: join(appRoot, 'tests/e2e/support/plugin-center-app-server.mjs'),
        DASCOWORK_E2E_PLUGIN_CENTER_RPC_LOG_PATH: rpcLogPath,
        DASCOWORK_E2E_PLUGIN_CENTER_STATE_PATH: statePath,
        DASCOWORK_E2E_PLUGIN_CENTER_APP_READ_UNSUPPORTED: options.appReadUnsupported ? '1' : '0',
        DASCOWORK_E2E_PLUGIN_CENTER_LIST_DELAY_MS: String(options.pluginListDelayMs ?? 0),
        DASCOWORK_E2E_PLUGIN_CENTER_EXTRA_PLUGIN_COUNT: String(options.extraPluginCount ?? 0)
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await run({ page, rpcLogPath })
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([serverStateDir])
  }
}

async function openPluginCenter(
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>
): Promise<void> {
  await page.locator('[data-slot="codex-sidebar"]').getByRole('button', { name: '插件' }).click()
  await expect(page.locator('[data-slot="plugin-center-page"]')).toBeVisible()
}

async function rpcMethods(rpcLogPath: string): Promise<Array<{ method: string; params: unknown }>> {
  try {
    const content = await readFile(rpcLogPath, 'utf8')
    return content
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0
}
