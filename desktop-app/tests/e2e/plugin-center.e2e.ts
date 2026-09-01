import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
    await expect(page.getByRole('button', { name: '预览技能 Workspace Skill' })).toBeVisible()
    await expect(page.getByRole('button', { name: '预览技能 Plugin Cache Skill' })).toHaveCount(0)
    await page.getByRole('tab', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '设置已安装插件' }).click()
    await expect(page.getByRole('tab', { name: /插件 1/ })).toHaveAttribute('data-state', 'active')
    await page.getByRole('tab', { name: /应用/ }).click()
    await expect(page.getByRole('tab', { name: '应用 0' })).toHaveAttribute('data-state', 'active')
    await expect(page.locator('[data-slot="app-card"]')).toHaveCount(0)
    await expect(page.getByText('没有应用', { exact: true })).toBeVisible()
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
    await expect(pluginCard).toBeVisible()
    await pluginCard.getByRole('button', { name: '更多插件操作' }).click()
    await expect(page.getByRole('menuitem', { name: '立即试用' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '管理' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '卸载' })).toBeVisible()

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

test('browses and directly installs cached curated skills without network access', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(
    testInfo,
    async ({ page, codexHomeDir }) => {
      await openPluginCenter(page)
      await page.getByRole('tab', { name: '技能', exact: true }).click()

      const search = page.getByRole('textbox', { name: '搜索技能' })
      await expect(search).toHaveAttribute('placeholder', '搜索技能')
      await expect(page.locator('[data-slot="installed-skills-overview"]')).toContainText(
        'Alpha Personal'
      )
      await expect(
        page.locator('[data-slot="installed-skills-overview"] [data-slot="skill-card"]')
      ).toHaveCount(6)
      await expect(page.locator('[data-slot="installed-skills-summary"]')).toHaveText(
        '查看 Workspace Skill、Writing，另有 1 项'
      )
      await expect(page.getByRole('tab', { name: '个人', exact: true })).toHaveAttribute(
        'data-state',
        'active'
      )
      await page.getByRole('tab', { name: '系统', exact: true }).click()
      const systemGrid = page.locator('[data-slot="skill-category-grid"]')
      await expect(systemGrid).toContainText('System Audit')
      await expect(systemGrid).toContainText('System Shell')
      await expect(systemGrid).not.toContainText('Workspace Skill')

      await page.getByRole('tab', { name: '推荐', exact: true }).click()
      await expect(page.getByRole('tab', { name: '推荐', exact: true })).toHaveAttribute(
        'data-state',
        'active'
      )
      await expect(page.locator('[data-slot="recommended-skill-card"]')).toHaveCount(2)
      await search.fill('curated writer')

      const curatedSkill = page
        .locator('[data-slot="recommended-skill-card"]')
        .filter({ hasText: 'E2E Curated Writer' })
      await expect(curatedSkill).toBeVisible()
      await curatedSkill.getByRole('button', { name: '安装技能 E2E Curated Writer' }).click()
      await search.fill('')

      const installedCuratedSkill = page
        .locator('[data-slot="installed-skills-overview"] [data-slot="skill-card"]')
        .filter({ hasText: 'Installed directly from the offline curated fixture.' })
      await expect(installedCuratedSkill).toContainText('E2e Writer')
      await expect(curatedSkill).toHaveCount(0)
      await expect
        .poll(async () =>
          readFile(join(codexHomeDir, 'skills', 'e2e-writer', 'SKILL.md'), 'utf8').catch(() => '')
        )
        .toContain('# E2E writer')

      await expect(page.locator('[data-slot="recommended-skill-card"]')).toHaveCount(1)
      await expect(
        page.locator('[data-slot="recommended-skill-card"]').filter({ hasText: 'Playwright' })
      ).toBeVisible()

      await page.setViewportSize({ width: 420, height: 900 })
      const width = await page.locator('body').evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      }))
      expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth + 1)
    },
    { recommendedSkills: true }
  )
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

    await page.getByRole('button', { name: '添加服务器' }).click()
    const editor = page.locator('[data-slot="mcp-server-editor"]')
    await expect(editor).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await editor.getByPlaceholder('例如：本地工具').fill('New Tools')
    await editor.getByPlaceholder('npx').fill('node')
    await editor.getByPlaceholder('参数').fill('new-tools-server.js')
    await editor.getByPlaceholder('变量名').fill('PATH')
    await editor.getByRole('button', { name: '保存' }).click()
    await expect(editor).toBeHidden()
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

test('edits and uninstalls a user MCP server through the inline editor', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page, rpcLogPath }) => {
    await openPluginCenter(page)
    await page.getByRole('button', { name: '管理' }).click()
    await page.getByRole('tab', { name: /MCP/ }).click()

    const existingServer = page.locator('article').filter({ hasText: 'local_tools' })
    await existingServer.getByRole('button', { name: '打开 local_tools MCP 设置' }).click()

    const editor = page.locator('[data-slot="mcp-server-editor"]')
    await expect(editor).toBeVisible()
    await expect(page.locator('[data-slot="plugin-center-list-header"]')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor.getByRole('heading', { name: '更新 Local_tools MCP' })).toBeVisible()
    await expect(editor.getByText('如需切换 MCP 服务器类型，请先卸载当前配置。')).toBeVisible()
    await expect(editor.getByRole('button', { name: '卸载' })).toBeVisible()
    await expect(editor.getByRole('group', { name: 'MCP 服务器类型' })).toHaveCount(0)
    await expect(editor.locator('input[value="secret"]')).toHaveCount(0)

    await page.setViewportSize({ width: 1490, height: 1462 })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await editor.screenshot({ path: testInfo.outputPath('mcp-server-editor-dark.png') })
    await editor.getByPlaceholder('npx').fill(' node ')
    await editor.locator('input[placeholder="参数"]').nth(1).fill(' @scope/updated-server ')
    await editor.getByRole('button', { name: '保存' }).click()

    await expect(editor).toBeHidden()
    await expect
      .poll(() => rpcMethods(rpcLogPath))
      .toContainEqual(
        expect.objectContaining({
          method: 'config/batchWrite',
          params: expect.objectContaining({
            edits: expect.arrayContaining([
              expect.objectContaining({
                keyPath: 'mcp_servers."local_tools"',
                value: expect.objectContaining({
                  command: 'node',
                  args: ['-y', '@scope/updated-server'],
                  cwd: '/tmp/e2e-plugin-center'
                })
              })
            ])
          })
        })
      )

    await page
      .locator('article')
      .filter({ hasText: 'local_tools' })
      .getByRole('button', { name: '打开 local_tools MCP 设置' })
      .click()
    await editor.getByRole('button', { name: '卸载' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(editor).toBeHidden()
    await expect(page.locator('article').filter({ hasText: 'local_tools' })).toHaveCount(0)
  })
})

test('keeps HTTP secrets redacted and readonly MCP servers unavailable for editing', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(testInfo, async ({ page }) => {
    await openPluginCenter(page)
    await page.getByRole('button', { name: '管理' }).click()
    await page.getByRole('tab', { name: /MCP/ }).click()

    await page
      .locator('article')
      .filter({ hasText: 'remote_tools' })
      .getByRole('button', { name: '打开 remote_tools MCP 设置' })
      .click()
    const editor = page.locator('[data-slot="mcp-server-editor"]')
    await expect(editor.getByText('Bearer Token 环境变量')).toBeVisible()
    await expect(editor.getByText('从环境变量读取的请求头')).toBeVisible()
    await expect(editor.locator('input[value="REMOTE_MCP_TOKEN"]')).toBeVisible()
    await expect(editor.locator('input[value="secret"]')).toHaveCount(0)
    await editor.getByRole('button', { name: '返回' }).click()

    const readonlyServer = page.locator('article').filter({ hasText: 'managed_tools' })
    const readonlySettings = readonlyServer.getByRole('button', { name: '打开 managed_tools MCP 设置' })
    await expect(readonlySettings).toBeDisabled()
    await expect(readonlyServer.getByRole('switch')).toBeDisabled()
  })
})

test('keeps inline MCP input after a failed write and allows one retry', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')

  await withPluginCenterServer(
    testInfo,
    async ({ page }) => {
      await openPluginCenter(page)
      await page.getByRole('button', { name: '管理' }).click()
      await page.getByRole('tab', { name: /MCP/ }).click()
      await page.getByRole('button', { name: '添加服务器' }).click()

      const editor = page.locator('[data-slot="mcp-server-editor"]')
      await editor.getByPlaceholder('例如：本地工具').fill('Retry tools')
      await editor.getByPlaceholder('npx').fill('node')
      await editor.getByRole('button', { name: '保存' }).click()

      await expect(editor).toBeVisible()
      await expect(editor.getByText('插件中心操作失败，请刷新后重试。')).toBeVisible()
      await expect(editor.locator('input[value="Retry tools"]')).toBeVisible()
      await expect(editor.locator('input[value="node"]')).toBeVisible()

      await editor.getByRole('button', { name: '保存' }).click()
      await expect(editor).toBeHidden()
      await expect(page.getByText('retry_tools')).toBeVisible()
    },
    { mcpWriteFailures: 1 }
  )
})

type PluginCenterRunInput = {
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>
  rpcLogPath: string
  codexHomeDir: string
}

type PluginCenterServerOptions = {
  pluginListDelayMs?: number
  extraPluginCount?: number
  appReadUnsupported?: boolean
  recommendedSkills?: boolean
  mcpWriteDelayMs?: number
  mcpWriteFailures?: number
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
  let codexHomeDir: string | undefined

  try {
    app = await launchApp(backend, logs, {
      configureCodexHome: async (directory) => {
        codexHomeDir = directory
        if (options.recommendedSkills) await writeOfflineRecommendedSkillsFixture(directory)
      },
      environment: {
        CODEX_APP_SERVER_BIN: join(appRoot, 'tests/e2e/support/plugin-center-app-server.mjs'),
        DASCOWORK_E2E_PLUGIN_CENTER_RPC_LOG_PATH: rpcLogPath,
        DASCOWORK_E2E_PLUGIN_CENTER_STATE_PATH: statePath,
        DASCOWORK_E2E_PLUGIN_CENTER_APP_READ_UNSUPPORTED: options.appReadUnsupported ? '1' : '0',
        DASCOWORK_E2E_PLUGIN_CENTER_LIST_DELAY_MS: String(options.pluginListDelayMs ?? 0),
        DASCOWORK_E2E_PLUGIN_CENTER_EXTRA_PLUGIN_COUNT: String(options.extraPluginCount ?? 0),
        DASCOWORK_E2E_PLUGIN_CENTER_MCP_WRITE_DELAY_MS: String(options.mcpWriteDelayMs ?? 0),
        DASCOWORK_E2E_PLUGIN_CENTER_MCP_WRITE_FAILURES: String(options.mcpWriteFailures ?? 0)
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    if (!codexHomeDir) throw new Error('E2E CODEX_HOME was not configured')
    await run({ page, rpcLogPath, codexHomeDir })
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await cleanupTempDirs([serverStateDir])
  }
}

async function writeOfflineRecommendedSkillsFixture(codexHomeDir: string): Promise<void> {
  const curatedRoot = join(codexHomeDir, 'vendor_imports', 'skills', 'skills')
  const fixtures = [
    {
      id: 'e2e-writer',
      name: 'E2E Curated Writer',
      description: 'Offline E2E curated skill',
      shortDescription: 'A network-free curated skill fixture.',
      repoPath: 'skills/.curated/e2e-writer',
      contents: '# E2E writer'
    },
    {
      id: 'playwright',
      name: 'Playwright',
      description: 'Automate real browsers',
      shortDescription: 'Automate real browsers',
      repoPath: 'skills/.experimental/playwright',
      contents: '# Playwright'
    }
  ]

  await Promise.all(
    fixtures.map(async (fixture) => {
      const skillDirectory = join(curatedRoot, fixture.repoPath.replace(/^skills\//, ''))
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(
        join(skillDirectory, 'SKILL.md'),
        [
          '---',
          `name: ${fixture.id}`,
          `description: ${fixture.description}`,
          '---',
          '',
          fixture.contents
        ].join('\n')
      )
    })
  )
  await writeFile(
    join(codexHomeDir, 'vendor_imports', 'skills-curated-cache.json'),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      skills: fixtures.map(({ id, name, description, shortDescription, repoPath }) => ({
        id,
        name,
        description,
        shortDescription,
        repoPath
      }))
    })
  )
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
