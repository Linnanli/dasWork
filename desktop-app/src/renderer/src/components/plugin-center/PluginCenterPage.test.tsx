// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopPluginCenterApi,
  PluginCenterGetPluginDetailResult,
  PluginCenterMutationResult,
  PluginCenterSnapshot
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import { PluginCenterPage, type PluginCenterSurface } from './PluginCenterPage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  }))
})

const baseSnapshot: PluginCenterSnapshot = {
  version: PLUGIN_CENTER_API_VERSION,
  generatedAt: '2026-08-24T00:00:00.000Z',
  plugins: [
    {
      kind: 'plugin',
      id: 'plugin:github',
      name: 'github',
      displayName: 'GitHub',
      description: 'Repository tools',
      sourceKind: 'marketplace',
      marketplaceId: 'marketplace:personal',
      marketplaceName: 'Personal',
      categories: ['Developer tools'],
      tags: ['git'],
      featured: true,
      installed: false,
      enabled: false,
      canInstall: true,
      canUninstall: true,
      canToggle: true,
      skillCount: 1,
      appCount: 1,
      mcpServerCount: 1
    }
  ],
  skills: [],
  apps: [],
  mcp: { userServers: [], pluginServers: [] },
  marketplaces: []
}

function noopResizeObserverMethod(): void {
  return undefined
}

function pluginApiMock(snapshot: PluginCenterSnapshot): DesktopPluginCenterApi {
  let installedPlugins = snapshot.plugins.filter((plugin) => plugin.installed)
  return {
    getSnapshot: vi.fn(async () => ({ version: PLUGIN_CENTER_API_VERSION, snapshot })),
    getInstalledPlugins: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: '2026-08-24T00:00:00.000Z',
      plugins: installedPlugins
    })),
    getPluginDetail: vi.fn(async (input) => {
      const plugin =
        snapshot.plugins.find((candidate) => candidate.id === input.plugin.id) ??
        snapshot.plugins[0]
      return pluginDetailResult(plugin)
    }),
    getAppTools: vi.fn(async (input) => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'ready' as const,
      app: { id: input.app.id },
      tools: []
    })),
    getSkillContents: vi.fn(async (input) => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'ready' as const,
      plugin: input.plugin,
      skill: input.skill,
      contents: '# Skill'
    })),
    getRecommendedSkills: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      fetchedAt: '2026-08-30T00:00:00.000Z',
      source: 'cache' as const,
      skills: []
    })),
    addMarketplace: vi.fn(),
    installPlugin: vi.fn(async () => {
      installedPlugins = snapshot.plugins
        .filter((plugin) => plugin.id === 'plugin:github')
        .map((plugin) => ({ ...plugin, installed: true, enabled: true }))
      return {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'applied' as const,
        changedSections: ['installed' as const]
      }
    }),
    installRecommendedSkill: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'applied' as const,
      changedSections: ['skills' as const]
    })),
    uninstallPlugin: vi.fn(),
    uninstallSkill: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'applied' as const,
      changedSections: ['skills' as const]
    })),
    setPluginEnabled: vi.fn(),
    setSkillEnabled: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'applied' as const,
      changedSections: ['skills' as const]
    })),
    setAppEnabled: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'applied' as const,
      changedSections: ['apps' as const]
    })),
    setMcpServerEnabled: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'applied' as const,
      changedSections: ['mcp' as const]
    })),
    upsertMcpServer: vi.fn(),
    removeMcpServer: vi.fn()
  }
}

function pluginDetailResult(
  plugin: PluginCenterSnapshot['plugins'][number] | undefined
): PluginCenterGetPluginDetailResult {
  if (!plugin) {
    return {
      version: PLUGIN_CENTER_API_VERSION,
      status: 'missing',
      missingReason: 'not_found'
    }
  }
  return {
    version: PLUGIN_CENTER_API_VERSION,
    status: 'ready',
    detail: {
      plugin,
      mention: { path: 'plugin://marketplace:personal/github', name: 'github' },
      longDescription: 'Use GitHub tools to inspect and improve repositories.',
      capabilities: ['Repository access', 'Pull request review'],
      defaultPrompts: ['Review the current pull request'],
      screenshots: [],
      apps: [
        {
          id: 'github-app',
          name: 'GitHub App',
          description: 'Open GitHub in the browser.',
          mention: { path: 'app://github-app', name: 'GitHub App' },
          multiAccountCapability: 'unknown',
          enabled: true,
          accessible: true,
          canToggle: true
        }
      ],
      skills: [
        {
          id: 'github-review',
          name: 'GitHub review',
          description: 'Review pull requests.',
          enabled: true,
          canToggle: true
        }
      ],
      mcpServers: ['github']
    }
  }
}

async function renderPluginCenter(
  api: DesktopPluginCenterApi,
  onSurfaceChange = vi.fn(),
  surface: PluginCenterSurface = { page: 'browse', tab: 'plugins' },
  strictMode = false,
  context: { cwd?: string; threadId?: string } = {},
  onActivatePluginPrompt?: (input: {
    mention: { path: string; name: string }
    prompt: string
  }) => void,
  onTryApp?: (input: { mention: { path: string; name: string } }) => void,
  onTrySkill?: (input: { mention: { path: string; name: string } }) => void
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  const root = createRoot(container)
  const page = (
    <PluginCenterPage
      surface={surface}
      onSurfaceChange={onSurfaceChange}
      api={api}
      cwd={context.cwd}
      threadId={context.threadId}
      onActivatePluginPrompt={onActivatePluginPrompt}
      onTryApp={onTryApp}
      onTrySkill={onTrySkill}
    />
  )
  await act(async () => {
    root.render(strictMode ? <StrictMode>{page}</StrictMode> : page)
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

class TestResizeObserver {
  static callback: ResizeObserverCallback | undefined

  constructor(callback: ResizeObserverCallback) {
    TestResizeObserver.callback = callback
  }

  disconnect(): void {
    noopResizeObserverMethod()
  }

  observe(): void {
    noopResizeObserverMethod()
  }

  unobserve(): void {
    noopResizeObserverMethod()
  }

  static trigger(): void {
    TestResizeObserver.callback?.([], {} as ResizeObserver)
  }
}

describe('PluginCenterPage', () => {
  it('fills the available application content area', async () => {
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot))
    const page = container.querySelector<HTMLElement>('[data-slot="plugin-center-page"]')

    expect(page?.className).toContain('flex-1')
    expect(page?.className).toContain('min-w-0')
  })

  it('places the reference-sized browse introduction and full-width search in the scrollable list', async () => {
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot))
    const header = container.querySelector('header')
    const scrollViewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    const intro = container.querySelector<HTMLElement>('[data-slot="plugin-center-intro"]')
    const search = container.querySelector<HTMLElement>('[data-slot="plugin-center-search"]')
    const listHeader = container.querySelector<HTMLElement>(
      '[data-slot="plugin-center-list-header"]'
    )
    const content = listHeader?.parentElement
    const heading = intro?.querySelector('h1')
    const description = intro?.querySelector('p')

    expect(header?.className).not.toContain('border-b')
    expect(header?.textContent).toContain('插件')
    expect(header?.textContent).toContain('技能')
    expect(header?.textContent).not.toContain('插件中心')
    expect(scrollViewport?.contains(intro)).toBe(true)
    expect(scrollViewport?.contains(search)).toBe(true)
    expect(content?.className).toContain('max-w-3xl')
    expect(content?.className).not.toContain('max-w-6xl')
    expect(heading?.textContent).toBe('插件')
    expect(heading?.className).toContain('text-xl')
    expect(heading?.className).toContain('leading-[1.2]')
    expect(heading?.className).toContain('font-normal')
    expect(description?.textContent).toBe('在你常用的工具中使用 Codex')
    expect(description?.className).toContain('text-lg')
    expect(description?.className).toContain('leading-6')
    expect(search?.className).toContain('w-full')
    expect(search?.className).not.toContain('max-w-sm')
  })

  it('shows the skills introduction when the skills tab is selected', async () => {
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot), vi.fn(), {
      page: 'browse',
      tab: 'skills'
    })
    const intro = container.querySelector<HTMLElement>('[data-slot="plugin-center-intro"]')

    expect(intro?.querySelector('h1')?.textContent).toBe('技能')
    expect(intro?.querySelector('p')?.textContent).toBe('通过任务专用技能扩展 Codex')
  })

  it('renders installed plugins as an icon rail and sends its settings action to manage plugins', async () => {
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    try {
      const onSurfaceChange = vi.fn()
      const installedPlugins = Array.from({ length: 8 }, (_, index) => ({
        ...baseSnapshot.plugins[0],
        id: `plugin:installed-${index}`,
        name: `installed-${index}`,
        displayName: `Installed ${index + 1}`,
        installed: true,
        enabled: true,
        icon: { kind: 'initials' as const, value: `${index + 1}` }
      }))
      const container = await renderPluginCenter(
        pluginApiMock({ ...baseSnapshot, plugins: installedPlugins }),
        onSurfaceChange
      )
      const installedSection = container.querySelector<HTMLElement>(
        '[data-slot="installed-plugins"]'
      )
      const rail = container.querySelector<HTMLElement>('[data-slot="installed-plugin-rail"]')

      expect(installedSection?.querySelectorAll('article')).toHaveLength(0)
      expect(rail?.querySelectorAll('[data-slot="installed-plugin-icon"]')).toHaveLength(8)

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-label="设置已安装插件"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSurfaceChange).toHaveBeenCalledWith({ page: 'manage', tab: 'plugins' })

      onSurfaceChange.mockClear()
      await act(async () => {
        rail
          ?.querySelector<HTMLButtonElement>('button[aria-label="查看 Installed 1 详情"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSurfaceChange).toHaveBeenCalledWith({
        page: 'detail',
        pluginRef: {
          id: 'plugin:installed-0',
          marketplaceId: 'marketplace:personal'
        },
        pluginName: 'Installed 1',
        returnTo: { tab: 'plugins', search: '', scrollTop: 0 }
      })

      Object.defineProperty(rail, 'clientWidth', { configurable: true, value: 180 })
      await act(async () => {
        TestResizeObserver.trigger()
      })

      expect(rail?.querySelectorAll('[data-slot="installed-plugin-icon"]')).toHaveLength(3)
      expect(rail?.querySelector('[data-slot="installed-plugin-overflow"]')).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('matches the reference installed-plugin count and ordering', async () => {
    const installedPlugin = {
      ...baseSnapshot.plugins[0],
      installed: true,
      enabled: true
    }
    const notion = {
      ...installedPlugin,
      id: 'notion@openai-curated-remote',
      name: 'notion',
      displayName: 'Notion',
      marketplaceId: 'personal-marketplace',
      marketplaceName: 'Personal marketplace'
    }
    const atlassianRovo = {
      ...installedPlugin,
      id: 'atlassian-rovo@openai-curated-remote',
      name: 'atlassian-rovo',
      displayName: 'Atlassian Rovo',
      marketplaceId: 'personal-marketplace',
      marketplaceName: 'Personal marketplace'
    }
    const bundled = {
      ...installedPlugin,
      id: 'plugin:bundled',
      name: 'bundled',
      displayName: 'Bundled',
      marketplaceId: 'openai-bundled',
      marketplaceName: 'openai-bundled'
    }
    const primaryRuntime = {
      ...installedPlugin,
      id: 'plugin:primary-runtime',
      name: 'primary-runtime',
      displayName: 'Primary runtime',
      marketplaceId: 'openai-primary-runtime',
      marketplaceName: 'openai-primary-runtime'
    }
    const adminDisabled = {
      ...installedPlugin,
      id: 'plugin:admin-disabled',
      name: 'admin-disabled',
      displayName: 'Admin disabled',
      restriction: {
        code: 'policy' as const,
        message: '此插件已被管理员禁用'
      }
    }
    const snapshot = {
      ...baseSnapshot,
      plugins: [bundled, adminDisabled, notion, atlassianRovo, primaryRuntime]
    }
    const api = pluginApiMock(snapshot)
    vi.mocked(api.getInstalledPlugins).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: '2026-08-24T00:00:00.000Z',
      plugins: [atlassianRovo, bundled, adminDisabled, notion, primaryRuntime]
    })
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'manage',
      tab: 'plugins'
    })

    expect(container.querySelector('[role="tab"]')?.textContent).toBe('插件 5')
    expect(
      [...container.querySelectorAll<HTMLElement>('article')].map((article) =>
        article.querySelector('h3')?.textContent?.trim()
      )
    ).toEqual(['Atlassian Rovo', 'Notion', 'Bundled', 'Primary runtime', 'Admin disabled'])
  })

  it('loads the installed rail and plugin categories with independent element-shaped skeletons', async () => {
    const catalogLoad = deferred<Awaited<ReturnType<DesktopPluginCenterApi['getSnapshot']>>>()
    const installedLoad =
      deferred<Awaited<ReturnType<DesktopPluginCenterApi['getInstalledPlugins']>>>()
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.getSnapshot).mockReturnValue(catalogLoad.promise)
    vi.mocked(api.getInstalledPlugins).mockReturnValue(installedLoad.promise)

    const container = await renderPluginCenter(api)
    const installedSkeleton = container.querySelector<HTMLElement>(
      '[data-slot="installed-plugins-skeleton"]'
    )
    const categoriesSkeleton = container.querySelector<HTMLElement>(
      '[data-slot="plugin-categories-skeleton"]'
    )

    expect(installedSkeleton).not.toBeNull()
    expect(categoriesSkeleton).not.toBeNull()
    expect(installedSkeleton?.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(2)
    expect(categoriesSkeleton?.querySelectorAll('[data-slot="plugin-card-skeleton"]')).toHaveLength(
      4
    )
    expect(container.querySelector('.h-32')).toBeNull()

    const installedPlugin = {
      ...baseSnapshot.plugins[0],
      id: 'plugin:installed',
      name: 'installed',
      displayName: 'Installed',
      installed: true,
      enabled: true
    }
    await act(async () => {
      installedLoad.resolve({
        version: PLUGIN_CENTER_API_VERSION,
        generatedAt: '2026-08-24T00:00:00.000Z',
        plugins: [installedPlugin]
      })
      await installedLoad.promise
    })

    expect(container.querySelector('[data-slot="installed-plugins-skeleton"]')).toBeNull()
    expect(container.querySelector('[data-slot="installed-plugins"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="plugin-categories-skeleton"]')).not.toBeNull()

    await act(async () => {
      catalogLoad.resolve({ version: PLUGIN_CENTER_API_VERSION, snapshot: baseSnapshot })
      await catalogLoad.promise
    })

    expect(container.querySelector('[data-slot="plugin-categories-skeleton"]')).toBeNull()
    expect(container.querySelector('[data-slot="plugin-category-featured"]')).not.toBeNull()
  })

  it('keeps the installed skeleton while ready plugin categories are already visible', async () => {
    const installedLoad =
      deferred<Awaited<ReturnType<DesktopPluginCenterApi['getInstalledPlugins']>>>()
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.getInstalledPlugins).mockReturnValue(installedLoad.promise)

    const container = await renderPluginCenter(api)

    expect(container.querySelector('[data-slot="installed-plugins-skeleton"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="plugin-categories-skeleton"]')).toBeNull()
    expect(container.querySelector('[data-slot="plugin-category-featured"]')).not.toBeNull()

    await act(async () => {
      installedLoad.resolve({
        version: PLUGIN_CENTER_API_VERSION,
        generatedAt: '2026-08-24T00:00:00.000Z',
        plugins: []
      })
      await installedLoad.promise
    })

    expect(container.querySelector('[data-slot="installed-plugins-skeleton"]')).toBeNull()
    expect(container.querySelector('[data-slot="plugin-category-featured"]')).not.toBeNull()
  })

  it('loads the real plugin snapshot and installs through the plugin API', async () => {
    const api = pluginApiMock(baseSnapshot)
    const onSurfaceChange = vi.fn()
    const container = await renderPluginCenter(api, onSurfaceChange)

    expect(api.getSnapshot).toHaveBeenNthCalledWith(1, {
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      forceRefresh: false,
      sections: ['plugins'],
      includePluginDetails: false
    })
    expect(api.getInstalledPlugins).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      forceRefresh: false
    })
    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).toContain('精选')
    expect(console.info).toHaveBeenCalledWith(
      '[plugin-center:perf:renderer-content-ready]',
      expect.objectContaining({
        atMs: expect.any(Number),
        pluginCount: 1
      })
    )

    const installButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '安装'
    )
    expect(installButton).not.toBeUndefined()

    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.installPlugin).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(2)
    expect(api.getInstalledPlugins).toHaveBeenLastCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      forceRefresh: true
    })
    expect(container.querySelector('[data-slot="installed-plugin-icon"]')).not.toBeNull()
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(onSurfaceChange).not.toHaveBeenCalled()
  })

  it('keeps a successful installation visible while the refreshed installed list is still stale', async () => {
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.getInstalledPlugins).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: '2026-08-24T00:00:00.000Z',
      plugins: []
    })
    vi.mocked(api.installPlugin).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'applied',
      changedItemId: 'plugin:github',
      changedSections: ['installed'],
      targetInstalled: true
    })
    const container = await renderPluginCenter(api)
    const installButton = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '安装'
    )

    await act(async () => {
      installButton?.click()
    })

    expect(container.querySelector('[data-slot="installed-plugin-icon"]')).not.toBeNull()
  })

  it('keeps installed marketplace plugins in their category and exposes their action menu', async () => {
    const installedPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const onSurfaceChange = vi.fn()
    const onActivatePluginPrompt = vi.fn()
    const api = pluginApiMock({ ...baseSnapshot, plugins: [installedPlugin] })
    const container = await renderPluginCenter(
      api,
      onSurfaceChange,
      { page: 'browse', tab: 'plugins' },
      false,
      {},
      onActivatePluginPrompt
    )
    const card = container.querySelector<HTMLElement>(
      '[data-slot="plugin-category-featured"] article'
    )
    const menuTrigger = card?.querySelector<HTMLButtonElement>('button[aria-label="更多插件操作"]')

    expect(card?.textContent).toContain('GitHub')
    expect(
      [...(card?.querySelectorAll<HTMLButtonElement>('button') ?? [])].some(
        (button) => button.textContent?.trim() === '安装'
      )
    ).toBe(false)
    expect(menuTrigger).not.toBeNull()

    await act(async () => {
      menuTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const menuItems = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const tryNow = menuItems.find((item) => item.textContent?.trim() === '立即试用')
    const manage = menuItems.find((item) => item.textContent?.trim() === '管理')
    const uninstall = menuItems.find((item) => item.textContent?.trim() === '卸载')

    expect(tryNow).toBeDefined()
    expect(manage).toBeDefined()
    expect(uninstall).toBeDefined()

    await act(async () => {
      tryNow?.click()
    })
    expect(api.getPluginDetail).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    expect(onActivatePluginPrompt).toHaveBeenCalledWith({
      mention: { path: 'plugin://marketplace:personal/github', name: 'github' },
      prompt: 'Review the current pull request'
    })

    await act(async () => {
      menuTrigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const manageItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === '管理'
    )
    await act(async () => {
      manageItem?.click()
    })
    expect(onSurfaceChange).toHaveBeenCalledWith({
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      pluginName: 'GitHub',
      returnTo: { tab: 'plugins', search: '', scrollTop: 0 }
    })
  })

  it('replaces the browse plugin-card menu with an uninstalling status while the uninstall is pending', async () => {
    const plugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const api = pluginApiMock({ ...baseSnapshot, plugins: [plugin] })
    const uninstallation = deferred<PluginCenterMutationResult>()
    vi.mocked(api.uninstallPlugin).mockReturnValue(uninstallation.promise)
    const container = await renderPluginCenter(api)
    const card = container.querySelector<HTMLElement>(
      '[data-slot="plugin-category-featured"] [data-slot="plugin-card"]'
    )
    const trigger = card?.querySelector<HTMLButtonElement>('button[aria-label="更多插件操作"]')

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const uninstall = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .filter((item) => item.textContent?.trim() === '卸载')
      .at(-1)
    await act(async () => {
      uninstall?.click()
    })
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => button.textContent?.trim() === '确认')
      .at(-1)

    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })

    expect(card?.querySelector('button[aria-label="更多插件操作"]')).toBeNull()
    expect(card?.querySelector('[data-slot="plugin-uninstall-status"]')?.textContent).toBe(
      '正在卸载'
    )

    await act(async () => {
      uninstallation.resolve({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'applied',
        changedSections: ['installed']
      })
      await uninstallation.promise
    })
  })

  it('shows the manage plugin menu before its switch on card hover and reuses the card uninstall flow', async () => {
    const plugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const container = await renderPluginCenter(
      pluginApiMock({ ...baseSnapshot, plugins: [plugin] }),
      vi.fn(),
      {
        page: 'manage',
        tab: 'plugins'
      }
    )
    const card = [...container.querySelectorAll<HTMLElement>('[data-slot="plugin-card"]')].find(
      (item) => item.textContent?.includes('GitHub')
    )
    const trigger = card?.querySelector<HTMLButtonElement>('button[aria-label="更多插件操作"]')
    const toggle = card?.querySelector<HTMLButtonElement>('[role="switch"]')

    expect(trigger).not.toBeNull()
    expect(toggle).not.toBeNull()
    expect(Array.from(trigger?.parentElement?.children ?? []).slice(0, 2)).toEqual([
      trigger,
      toggle
    ])
    expect(trigger?.className).toContain('opacity-0')
    expect(trigger?.className).toContain('group-hover:opacity-100')

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const uninstall = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .filter((item) => item.textContent?.trim() === '卸载')
      .at(-1)

    await act(async () => {
      uninstall?.click()
    })
    expect(
      [...document.body.querySelectorAll('[role="dialog"]')].some((dialog) =>
        dialog.textContent?.includes('卸载 GitHub？')
      )
    ).toBe(true)
  })

  it('shows Plugin Management in the installed plugin list', async () => {
    const pluginManagement = {
      ...baseSnapshot.plugins[0],
      id: 'plugin-management@openai-curated-remote',
      name: 'plugin-management',
      displayName: 'Plugin Management',
      marketplaceId: 'openai-curated-remote',
      marketplaceName: 'openai-curated-remote',
      installed: true,
      enabled: true
    }
    const container = await renderPluginCenter(
      pluginApiMock({ ...baseSnapshot, plugins: [pluginManagement] }),
      vi.fn(),
      { page: 'manage', tab: 'plugins' }
    )

    const card = [...container.querySelectorAll<HTMLElement>('[data-slot="plugin-card"]')].find(
      (item) => item.textContent?.includes('Plugin Management')
    )

    expect(card).toBeDefined()
  })

  it('hides connection status and metadata tags from managed MCP cards', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      mcp: {
        userServers: [
          {
            id: 'local-mcp',
            name: 'local-mcp',
            displayName: 'Local MCP',
            enabled: true,
            connected: true,
            authStatus: 'bearerToken',
            toolCount: 3,
            origin: 'user',
            editable: true,
            canToggle: true,
            transport: 'stdio',
            command: 'local-mcp',
            args: [],
            env: [],
            envVars: []
          }
        ],
        pluginServers: [
          {
            id: 'plugin-mcp',
            name: 'plugin-mcp',
            displayName: 'Plugin MCP',
            enabled: true,
            connected: true,
            authStatus: 'unsupported',
            toolCount: 2,
            origin: 'plugin',
            editable: false,
            canToggle: false,
            transport: 'unknown'
          }
        ]
      }
    }
    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'manage',
      tab: 'mcp'
    })
    const cards = [...container.querySelectorAll<HTMLElement>('article')]

    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).not.toContain('3 个工具')
    expect(cards[1]?.textContent).toContain('2 个工具')
    expect(cards[1]?.textContent).toContain('来自插件')
    expect(cards.every((card) => !card.textContent?.includes('已连接'))).toBe(true)
    expect(cards[0]?.textContent).not.toContain('stdio')
    expect(cards[0]?.textContent).not.toContain('user')
    expect(cards[1]?.textContent).not.toContain('unknown')
    expect(cards[1]?.textContent).not.toContain('无需认证')
  })

  it('opens the MCP editor in a dialog for add and edit actions', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      mcp: {
        userServers: [
          {
            id: 'assistant-ui',
            name: 'assistant-ui',
            displayName: 'Assistant-ui',
            enabled: true,
            connected: true,
            authStatus: 'unsupported',
            toolCount: 1,
            origin: 'user',
            editable: true,
            canToggle: true,
            transport: 'stdio',
            command: 'npx',
            args: ['-y'],
            env: [],
            envVars: []
          }
        ],
        pluginServers: []
      }
    }
    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'manage',
      tab: 'mcp'
    })
    const add = [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
      candidate.textContent?.includes('添加服务器')
    )

    await act(async () => {
      add?.click()
    })

    expect(document.body.querySelector('[data-slot="mcp-server-editor"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="plugin-center-list-header"]')).not.toBeNull()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.textContent).toContain('连接至自定义 MCP')

    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent?.includes('取消')
    )
    await act(async () => {
      cancel?.click()
    })

    const settings = container.querySelector<HTMLButtonElement>(
      'button[aria-label="打开 Assistant-ui MCP 设置"]'
    )
    await act(async () => {
      settings?.click()
    })

    expect(document.body.textContent).toContain('更新 Assistant-ui MCP')
    expect(document.body.textContent).toContain('如需切换 MCP 服务器类型，请先卸载当前配置。')
    expect(document.body.textContent).toContain('卸载')
    expect(document.body.querySelector('[role="group"][aria-label="MCP 服务器类型"]')).toBeNull()
  })

  it('replaces the manage plugin menu with an uninstalling status while the uninstall is pending', async () => {
    const plugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const api = pluginApiMock({ ...baseSnapshot, plugins: [plugin] })
    const uninstallation = deferred<PluginCenterMutationResult>()
    vi.mocked(api.uninstallPlugin).mockReturnValue(uninstallation.promise)
    const container = await renderPluginCenter(api, vi.fn(), { page: 'manage', tab: 'plugins' })
    const card = container.querySelector<HTMLElement>('[data-slot="plugin-card"]')
    const trigger = card?.querySelector<HTMLButtonElement>('button[aria-label="更多插件操作"]')

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const uninstall = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === '卸载'
    )
    await act(async () => {
      uninstall?.click()
    })
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => button.textContent?.trim() === '确认')
      .at(-1)

    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })

    expect(card?.querySelector('button[aria-label="更多插件操作"]')).toBeNull()
    expect(card?.querySelector('[data-slot="plugin-uninstall-status"]')?.textContent).toBe(
      '正在卸载'
    )

    await act(async () => {
      uninstallation.resolve({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'applied',
        changedSections: ['installed']
      })
      await uninstallation.promise
    })
  })

  it('does not show plugin preparation while loading a trial prompt', async () => {
    const installedPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const onActivatePluginPrompt = vi.fn()
    const api = pluginApiMock({ ...baseSnapshot, plugins: [installedPlugin] })
    const pendingDetail = deferred<PluginCenterGetPluginDetailResult>()
    vi.mocked(api.getPluginDetail).mockImplementation(() => pendingDetail.promise)
    const container = await renderPluginCenter(
      api,
      vi.fn(),
      { page: 'browse', tab: 'plugins' },
      false,
      {},
      onActivatePluginPrompt
    )

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="更多插件操作"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const tryNow = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .filter((item) => item.textContent?.trim() === '立即试用')
      .at(-1)

    await act(async () => {
      tryNow?.click()
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('准备插件中')

    await act(async () => {
      pendingDetail.resolve(pluginDetailResult(installedPlugin))
      await Promise.resolve()
    })
    expect(onActivatePluginPrompt).toHaveBeenCalledWith({
      mention: { path: 'plugin://marketplace:personal/github', name: 'github' },
      prompt: 'Review the current pull request'
    })
  })

  it('opens a card detail without nesting its install action, then restores the browse context', async () => {
    const onSurfaceChange = vi.fn()
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot), onSurfaceChange)
    const detailButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="查看 GitHub 详情"]'
    )

    expect(
      detailButton?.contains(container.querySelector('button[aria-label="安装 GitHub"]'))
    ).toBe(false)

    await act(async () => {
      detailButton?.click()
    })

    expect(onSurfaceChange).toHaveBeenCalledWith({
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      pluginName: 'GitHub',
      returnTo: { tab: 'plugins', search: '', scrollTop: 0 }
    })

    const detailApi = pluginApiMock(baseSnapshot)
    const detailContainer = await renderPluginCenter(detailApi, onSurfaceChange, {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      returnTo: { tab: 'plugins', category: 'Developer tools', search: 'github', scrollTop: 48 }
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(detailApi.getPluginDetail).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      forceRefresh: false
    })
    expect(
      detailContainer.querySelector('[data-slot="plugin-detail-page"]')?.textContent
    ).toContain('Pull request review')
    expect(
      detailContainer.querySelector('[data-slot="plugin-detail-breadcrumb"]')?.textContent
    ).toContain('GitHub')

    await act(async () => {
      detailContainer
        .querySelector<HTMLButtonElement>('[data-slot="plugin-detail-breadcrumb"] button')
        ?.click()
    })
    expect(onSurfaceChange).toHaveBeenLastCalledWith({
      page: 'browse',
      tab: 'plugins',
      category: 'Developer tools',
      search: 'github',
      scrollTop: 48
    })
  })

  it('matches the reference skill row and writes its enabled state', async () => {
    const api = pluginApiMock(baseSnapshot)
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    await act(async () => {
      await Promise.resolve()
    })

    const skill = container.querySelector<HTMLElement>('[data-slot="plugin-detail-skill-row"]')
    const description = skill?.querySelector('p')
    const toggle = skill?.querySelector<HTMLButtonElement>(
      'button[aria-label="GitHub review 停用"]'
    )

    expect(skill?.className).toContain('items-center')
    expect(skill?.className).not.toContain('border')
    expect(skill?.className).not.toContain('bg-card')
    expect(skill?.className).toContain('rounded-lg')
    expect(skill?.className).toContain('px-[var(--detail-page-inline-inset)]')
    expect(skill?.className).toContain('py-3')
    expect(skill?.className).toContain('transition-colors')
    expect(skill?.className).toContain('hover:bg-foreground/5')
    expect(skill?.querySelector('[data-slot="plugin-detail-skill-icon"]')).not.toBeNull()
    expect(description?.className).toContain('line-clamp-1')
    expect(description?.className).toContain('leading-relaxed')
    expect(toggle?.getAttribute('data-state')).toBe('checked')

    await act(async () => {
      toggle?.click()
    })

    expect(api.setSkillEnabled).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      skill: { id: 'github-review' },
      enabled: false
    })
  })

  it('lazily opens a skill preview without treating its inline switch as a preview action', async () => {
    const api = pluginApiMock(baseSnapshot)
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const skill = container.querySelector<HTMLElement>('[data-slot="plugin-detail-skill-row"]')
    const toggle = skill?.querySelector<HTMLButtonElement>(
      'button[aria-label="GitHub review 停用"]'
    )

    expect(api.getSkillContents).not.toHaveBeenCalled()
    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    expect(api.getSkillContents).not.toHaveBeenCalled()

    await act(async () => {
      skill?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getSkillContents).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      skill: { id: 'github-review', name: 'GitHub review' }
    })
    expect(document.body.querySelector('[data-slot="plugin-skill-preview-dialog"]')).not.toBeNull()
  })

  it('requests the managed skill projection and renders its cards', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      skills: [
        {
          id: '/workspace/skills/review/SKILL.md',
          name: 'review',
          displayName: '代码审查',
          description: '审查当前变更并提出改进建议。',
          scope: 'personal',
          sourceKind: 'personal',
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: true,
          tags: []
        }
      ]
    }
    const api = pluginApiMock(snapshot)
    const container = await renderPluginCenter(api, vi.fn(), { page: 'manage', tab: 'skills' })
    const skill = container.querySelector<HTMLElement>('[data-slot="managed-skill-card"]')
    const toggle = skill?.querySelector<HTMLButtonElement>('button[aria-label="代码审查 停用"]')

    expect(skill?.className).toContain('items-center')
    expect(skill?.className).toContain('rounded-lg')
    expect(skill?.className).toContain('px-[var(--detail-page-inline-inset)]')
    expect(skill?.className).toContain('py-3')
    expect(skill?.className).toContain('hover:bg-foreground/5')
    expect(skill?.querySelector('[data-slot="plugin-detail-skill-icon"]')).not.toBeNull()
    expect(skill?.querySelector('p')?.className).toContain('line-clamp-1')
    expect(api.getSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        sections: ['skills'],
        includePluginDetails: false,
        skillListMode: 'manage'
      })
    )

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })

    expect(api.setSkillEnabled).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      skill: { id: '/workspace/skills/review/SKILL.md' },
      enabled: false
    })
    expect(api.getSkillContents).not.toHaveBeenCalled()

    await act(async () => {
      skill?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getSkillContents).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      skill: { id: '/workspace/skills/review/SKILL.md', name: 'review' }
    })
    expect(document.body.querySelector('[data-slot="plugin-skill-preview-dialog"]')).not.toBeNull()
  })

  it('orders managed skill cards by display name, then raw name', async () => {
    const skill = (
      id: string,
      name: string,
      displayName: string
    ): PluginCenterSnapshot['skills'][number] => ({
      id,
      name,
      displayName,
      scope: 'personal' as const,
      sourceKind: 'personal' as const,
      enabled: true,
      installed: true,
      recommended: false,
      canToggle: true,
      canUninstall: false,
      tags: []
    })
    const api = pluginApiMock({
      ...baseSnapshot,
      skills: [
        skill('/skills/writer/SKILL.md', 'writer', 'Writer'),
        skill('/skills/review/SKILL.md', 'review', 'Code Review'),
        skill('/skills/alpha/SKILL.md', 'alpha', 'Alpha')
      ]
    })
    const container = await renderPluginCenter(api, vi.fn(), { page: 'manage', tab: 'skills' })

    expect(
      [...container.querySelectorAll<HTMLElement>('[data-slot="managed-skill-card"]')].map((card) =>
        card.getAttribute('aria-label')
      )
    ).toEqual(['查看技能 Alpha', '查看技能 Code Review', '查看技能 Writer'])
  })

  it('updates a plugin detail skill switch before its write completes', async () => {
    const write = deferred<PluginCenterMutationResult>()
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.setSkillEnabled).mockReturnValue(write.promise)
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="GitHub review 停用"]'
    )

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })

    expect(toggle?.getAttribute('data-state')).toBe('unchecked')
    expect(toggle?.disabled).toBe(true)
    expect(container.textContent).not.toContain('停用技能中')

    await act(async () => {
      write.resolve({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'applied',
        changedSections: ['skills']
      })
      await Promise.resolve()
    })

    expect(toggle?.getAttribute('data-state')).toBe('unchecked')
    expect(toggle?.disabled).toBe(false)
  })

  it('rolls back a plugin detail skill switch when its write fails', async () => {
    const write = deferred<PluginCenterMutationResult>()
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.setSkillEnabled).mockReturnValue(write.promise)
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="GitHub review 停用"]'
    )

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })

    expect(toggle?.getAttribute('data-state')).toBe('unchecked')

    await act(async () => {
      write.reject(new Error('无法保存技能设置'))
      await write.promise.catch(() => undefined)
      await Promise.resolve()
    })

    expect(toggle?.getAttribute('data-state')).toBe('checked')
    expect(toggle?.disabled).toBe(false)
  })

  it('uses Connect to enable an accessible disabled app without opening an external page', async () => {
    const openExternalHttpUrl = vi.fn(async () => undefined)
    vi.stubGlobal('desktopApp', { codex: { openExternalHttpUrl } })
    const installedPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const api = pluginApiMock({ ...baseSnapshot, plugins: [installedPlugin] })
    const detail = pluginDetailResult(installedPlugin)
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.apps[0] = { ...detail.detail.apps[0]!, enabled: false }
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    await act(async () => {
      await Promise.resolve()
    })

    const connect = container.querySelector<HTMLButtonElement>(
      '[data-slot="plugin-detail-app-row"] button[aria-label="连接 GitHub App"]'
    )
    expect(connect?.textContent).toContain('连接')

    await act(async () => {
      connect?.click()
    })

    expect(api.setAppEnabled).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      app: { id: 'github-app' },
      enabled: true
    })
    expect(openExternalHttpUrl).not.toHaveBeenCalled()
  })

  it('reloads cached app tools after changing the app while its dialog is closed', async () => {
    const installedPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const api = pluginApiMock({ ...baseSnapshot, plugins: [installedPlugin] })
    const detail = pluginDetailResult(installedPlugin)
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.apps[0] = { ...detail.detail.apps[0]!, enabled: false }
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const appOpen = container.querySelector<HTMLButtonElement>(
      '[data-slot="plugin-detail-app-open"]'
    )

    await act(async () => {
      appOpen?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.getAppTools).toHaveBeenCalledTimes(1)

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')?.click()
      await Promise.resolve()
    })
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-slot="plugin-detail-app-row"] button[aria-label="连接 GitHub App"]'
        )
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      appOpen?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getAppTools).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      name: 'uninstalled plugin',
      installed: false,
      accessible: true,
      enabled: true,
      restriction: undefined,
      lockLabel: undefined
    },
    {
      name: 'administrator-locked inaccessible app',
      installed: true,
      accessible: false,
      enabled: false,
      restriction: {
        code: 'policy' as const,
        message: '此应用由管理员禁用',
        editable: false
      },
      lockLabel: '此应用由管理员禁用'
    }
  ])('keeps $name action-free while its tool description remains available', async (state) => {
    const plugin = {
      ...baseSnapshot.plugins[0]!,
      installed: state.installed,
      enabled: state.installed
    }
    const api = pluginApiMock({ ...baseSnapshot, plugins: [plugin] })
    const detail = pluginDetailResult(plugin)
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.apps[0] = {
      ...detail.detail.apps[0]!,
      accessible: state.accessible,
      enabled: state.enabled,
      canToggle: !state.restriction,
      ...(state.restriction ? { restriction: state.restriction } : {})
    }
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)

    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app-row"]')
    const appOpen = app?.querySelector<HTMLButtonElement>('[data-slot="plugin-detail-app-open"]')

    expect(app?.querySelector('[aria-label^="连接 "]')).toBeNull()
    expect(app?.querySelector('[aria-label$="已连接，打开管理菜单"]')).toBeNull()
    expect(app?.querySelector('[role="switch"]')).toBeNull()
    if (state.lockLabel) {
      expect(app?.querySelector(`[aria-label="${state.lockLabel}"]`)).not.toBeNull()
    } else {
      expect(app?.querySelector('[aria-label="此应用由管理员禁用"]')).toBeNull()
    }

    await act(async () => {
      appOpen?.click()
      await Promise.resolve()
    })

    expect(api.getAppTools).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      app: { id: 'github-app' }
    })
    expect(api.setAppEnabled).not.toHaveBeenCalled()
  })

  it('lazily loads app tools in a grouped dialog without triggering it from the connected menu', async () => {
    const installedPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const api = pluginApiMock({ ...baseSnapshot, plugins: [installedPlugin] })
    vi.mocked(api.getAppTools).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'ready',
      app: { id: 'github-app' },
      tools: [
        { name: 'github.create_issue', title: '创建议题', readOnly: false, enabled: true },
        { name: 'github.search', title: '搜索', readOnly: true, enabled: false }
      ]
    })
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app-row"]')
    const appOpen = app?.querySelector<HTMLButtonElement>('[data-slot="plugin-detail-app-open"]')

    expect(appOpen?.tagName).toBe('DIV')
    expect(app?.getAttribute('role')).toBe('button')

    await act(async () => {
      appOpen?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getAppTools).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      app: { id: 'github-app' }
    })
    expect(document.body.textContent).toContain('会更改数据 1')
    expect(document.body.textContent).toContain('只读 1')

    const writeGroup = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('会更改数据 1')
    )
    expect(writeGroup?.getAttribute('aria-expanded')).toBe('true')
    await act(async () => {
      writeGroup?.click()
    })
    expect(writeGroup?.getAttribute('aria-expanded')).toBe('false')

    const connectedMenu = app?.querySelector<HTMLButtonElement>(
      'button[aria-label="GitHub App 已连接，打开管理菜单"]'
    )
    await act(async () => {
      connectedMenu?.click()
    })
    expect(api.getAppTools).toHaveBeenCalledTimes(1)
  })

  it('keeps an inaccessible app description and shows the reference connect action', async () => {
    const openExternalHttpUrl = vi.fn(async () => undefined)
    vi.stubGlobal('desktopApp', { codex: { openExternalHttpUrl } })
    const api = pluginApiMock(baseSnapshot)
    const detail = pluginDetailResult({
      ...baseSnapshot.plugins[0],
      installed: true,
      enabled: true
    })
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.apps = [
      {
        id: 'github-app',
        name: 'GitHub App',
        description: 'Open GitHub in the browser.',
        installUrl: 'https://example.test/connect-github',
        mention: { path: 'app://github-app', name: 'GitHub App' },
        multiAccountCapability: 'unknown',
        enabled: true,
        accessible: false,
        canToggle: true
      }
    ]
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)

    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app-row"]')
    const connect = app?.querySelector<HTMLButtonElement>('button[aria-label="连接 GitHub App"]')

    expect(app?.querySelector('[data-slot="plugin-detail-app-description"]')?.textContent).toBe(
      'Open GitHub in the browser.'
    )
    expect(app?.textContent).not.toContain('此应用当前不可访问或需要连接帐户')
    expect(app?.querySelector('[role="switch"]')).toBeNull()
    expect(connect?.textContent).toContain('连接')
    expect(connect?.className).toContain('rounded-lg')
    expect(connect?.className).not.toContain('rounded-full')

    await act(async () => {
      connect?.click()
      await Promise.resolve()
    })
    expect(openExternalHttpUrl).toHaveBeenCalledWith('https://example.test/connect-github')

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })
    expect(api.getPluginDetail).toHaveBeenLastCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      forceRefresh: true
    })
  })

  it.each([
    { status: 'applied' as const, opensExternalPage: true },
    { status: 'overridden' as const, opensExternalPage: false }
  ])(
    'enables an inaccessible disabled app before connecting only when the write is $status',
    async ({ status, opensExternalPage }) => {
      const openExternalHttpUrl = vi.fn(async () => undefined)
      vi.stubGlobal('desktopApp', { codex: { openExternalHttpUrl } })
      const plugin = { ...baseSnapshot.plugins[0]!, installed: true, enabled: true }
      const api = pluginApiMock({ ...baseSnapshot, plugins: [plugin] })
      vi.mocked(api.setAppEnabled).mockResolvedValue({
        version: PLUGIN_CENTER_API_VERSION,
        status,
        changedSections: ['apps']
      })
      const detail = pluginDetailResult(plugin)
      if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
      detail.detail.apps[0] = {
        ...detail.detail.apps[0]!,
        installUrl: 'https://example.test/connect-github',
        accessible: false,
        enabled: false,
        canToggle: true
      }
      vi.mocked(api.getPluginDetail).mockResolvedValue(detail)

      const container = await renderPluginCenter(api, vi.fn(), {
        page: 'detail',
        pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
      })
      const connect = container.querySelector<HTMLButtonElement>(
        '[data-slot="plugin-detail-app-row"] button[aria-label="连接 GitHub App"]'
      )

      await act(async () => {
        connect?.click()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(api.setAppEnabled).toHaveBeenCalledWith({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: undefined,
        threadId: undefined,
        app: { id: 'github-app' },
        enabled: true
      })
      if (opensExternalPage) {
        expect(openExternalHttpUrl).toHaveBeenCalledWith('https://example.test/connect-github')
      } else {
        expect(openExternalHttpUrl).not.toHaveBeenCalled()
      }
    }
  )

  it('groups detail apps by their categories when the plugin includes multiple categories', async () => {
    const api = pluginApiMock(baseSnapshot)
    const detail = pluginDetailResult(baseSnapshot.plugins[0])
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.apps = [
      {
        ...detail.detail.apps[0]!,
        id: 'codex-security-access',
        name: 'Codex Security Access',
        category: 'Security'
      },
      {
        ...detail.detail.apps[0]!,
        id: 'linear',
        name: 'Linear',
        category: 'Work tracking & coordination'
      },
      {
        ...detail.detail.apps[0]!,
        id: 'atlassian-rovo',
        name: 'Atlassian Rovo',
        category: 'Work tracking & coordination'
      },
      {
        ...detail.detail.apps[0]!,
        id: 'github',
        name: 'GitHub',
        category: 'Code hosting & security findings'
      }
    ]
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)

    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(
      Array.from(container.querySelectorAll('[data-slot="plugin-detail-app-category"]')).map(
        (category) => category.textContent
      )
    ).toEqual(['Security', 'Work tracking & coordination', 'Code hosting & security findings'])
    const appsSection = Array.from(container.querySelectorAll('h2'))
      .find((heading) => heading.textContent === '应用 4')
      ?.closest('section')
    expect(
      Array.from(appsSection?.querySelectorAll('[data-slot="plugin-detail-app-name"]') ?? []).map(
        (app) => app.textContent
      )
    ).toEqual(['Codex Security Access', 'Linear', 'Atlassian Rovo', 'GitHub'])
  })

  it('uses the reference detail-page inset across resource and information sections', async () => {
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot), vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    await act(async () => {
      await Promise.resolve()
    })

    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app-row"]')
    const detailPage = container.querySelector<HTMLElement>('[data-slot="plugin-detail-page"]')
    const appsHeading = Array.from(container.querySelectorAll('h2')).find(
      (heading) => heading.textContent === '应用 1'
    )
    const informationHeading = Array.from(container.querySelectorAll('h2')).find(
      (heading) => heading.textContent === '信息'
    )
    const icon = app?.querySelector<HTMLElement>('.size-9')
    const title = app?.querySelector<HTMLElement>('[data-slot="plugin-detail-app-name"]')
    const description = app?.querySelector<HTMLElement>(
      '[data-slot="plugin-detail-app-description"]'
    )
    const detailHeader = detailPage?.querySelector('h1')?.closest('section')
    const defaultPrompts = detailPage?.querySelector<HTMLElement>(
      'section[aria-label="默认提示词"]'
    )
    const longDescription = Array.from(detailPage?.querySelectorAll('p') ?? []).find(
      (paragraph) =>
        paragraph.textContent === 'Use GitHub tools to inspect and improve repositories.'
    )
    const mcpServer = detailPage?.querySelector<HTMLElement>(
      '[data-slot="plugin-detail-mcp-server"]'
    )
    const sectionHeadings = Array.from(detailPage?.querySelectorAll('h2') ?? []).map(
      (heading) => heading.textContent
    )

    expect(detailPage?.className).toContain('[--detail-page-inline-inset:0.5rem]')
    expect(sectionHeadings).toEqual(['应用 1', 'MCP 服务器 1', '技能 1', '信息'])
    expect(container.querySelector('[data-slot="plugin-detail-app-category"]')).toBeNull()
    expect(detailHeader?.className).toContain('px-[var(--detail-page-inline-inset)]')
    expect(defaultPrompts?.className).toContain('mx-[var(--detail-page-inline-inset)]')
    expect(longDescription?.parentElement?.className).toContain(
      'px-[var(--detail-page-inline-inset)]'
    )
    expect(app?.className).not.toContain('bg-card')
    expect(app?.className).toContain('px-[var(--detail-page-inline-inset)]')
    expect(app?.className).toContain('py-3')
    expect(appsHeading?.parentElement?.className).toContain('ps-[var(--detail-page-inline-inset)]')
    expect(app?.className).toContain('transition-colors')
    expect(app?.className).toContain('hover:bg-foreground/5')
    expect(icon?.className).toContain('rounded-lg')
    expect(icon?.className).toContain('object-contain')
    expect(title?.className).toContain('text-base')
    expect(description?.className).toContain('line-clamp-1')
    expect(description?.className).toContain('leading-relaxed')
    expect(mcpServer?.className).not.toContain('bg-card')
    expect(mcpServer?.className).not.toContain('border')
    expect(mcpServer?.className).toContain('px-[var(--detail-page-inline-inset)]')
    expect(mcpServer?.className).toContain('hover:bg-foreground/5')
    expect(informationHeading?.parentElement?.className).toContain(
      'ps-[var(--detail-page-inline-inset)]'
    )
    expect(informationHeading?.parentElement?.className).toContain('border-b')
    expect(informationHeading?.parentElement?.nextElementSibling?.className).toContain(
      'px-[var(--detail-page-inline-inset)]'
    )
  })

  it('resolves plugin MCP names to directory apps using the reference identity aliases', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      apps: [
        {
          id: 'github-app',
          name: 'GitHub',
          description: 'Repository tools',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['Codex Security', 'GitHub'],
          labels: { retrievable: 'true' },
          enabled: true,
          accessible: true,
          canToggle: true
        }
      ]
    }
    const api = pluginApiMock(snapshot)
    const detail = pluginDetailResult(snapshot.plugins[0])
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.apps[0] = { ...detail.detail.apps[0]!, name: 'GitHub' }
    detail.detail.mcpServers = ['codex-security', 'unmatched-server']
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)

    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    await act(async () => {
      await Promise.resolve()
    })

    const heading = Array.from(container.querySelectorAll('h2')).find(
      (candidate) => candidate.textContent === 'MCP 服务器 2'
    )
    const section = heading?.closest('section')

    expect(section?.textContent).toContain('GitHub')
    expect(section?.textContent).not.toContain('codex-security')
    expect(section?.textContent).toContain('unmatched-server')
    expect(section?.querySelectorAll('[data-slot="plugin-detail-app-row"]')).toHaveLength(1)
    expect(section?.querySelectorAll('[data-slot="plugin-detail-mcp-server"]')).toHaveLength(1)

    await act(async () => {
      section?.querySelector<HTMLElement>('[data-slot="plugin-detail-app-row"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.getAppTools).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      app: { id: 'github-app' }
    })
    expect(document.body.querySelector('[data-slot="plugin-app-tools-dialog"]')).not.toBeNull()
    expect(api.getSnapshot).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      forceRefresh: false,
      sections: ['apps'],
      includePluginDetails: false
    })
  })

  it('keeps configured MCP servers inline with settings and an independently writable switch', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      mcp: {
        userServers: [],
        pluginServers: [
          {
            id: 'github-mcp',
            name: 'github',
            displayName: 'GitHub',
            enabled: true,
            connected: true,
            authStatus: 'unsupported',
            toolCount: 2,
            origin: 'plugin',
            editable: false,
            canToggle: true,
            pluginId: 'plugin:github',
            pluginDisplayName: 'GitHub',
            transport: 'unknown'
          }
        ]
      }
    }
    const api = pluginApiMock(snapshot)
    const onSurfaceChange = vi.fn()
    const container = await renderPluginCenter(api, onSurfaceChange, {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    const server = container.querySelector<HTMLElement>('[data-slot="plugin-detail-mcp-server"]')
    const settings = server?.querySelector<HTMLButtonElement>(
      'button[aria-label="打开 GitHub MCP"]'
    )
    const toggle = server?.querySelector<HTMLButtonElement>('button[aria-label="GitHub 停用"]')

    expect(server?.textContent).toContain('已连接 · 2 个工具')
    expect(settings).not.toBeNull()
    expect(toggle).not.toBeNull()
    await act(async () => {
      settings?.click()
    })
    expect(onSurfaceChange).toHaveBeenCalledWith({ page: 'manage', tab: 'mcp' })

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    expect(api.setMcpServerEnabled).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      server: { id: 'github-mcp' },
      enabled: false
    })
  })

  it('uses the plugin brand color for the animated default-prompt background', async () => {
    const api = pluginApiMock(baseSnapshot)
    const detail = await api.getPluginDetail({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    if (detail.status !== 'ready') throw new Error('Expected ready plugin detail fixture')
    detail.detail.brandColor = '#123456'
    vi.mocked(api.getPluginDetail).mockResolvedValue(detail)

    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })

    const ambient = container.querySelector<HTMLElement>(
      '[data-slot="plugin-brand-ambient-background"]'
    )
    const firstBlob = ambient?.querySelector<HTMLElement>('span')

    expect(ambient).not.toBeNull()
    expect(ambient?.children).toHaveLength(3)
    expect(firstBlob?.style.backgroundColor).toBe('rgb(18, 52, 86)')
    expect(firstBlob?.className).toContain('animate-plugin-brand-drift-one')
    expect(firstBlob?.className).toContain('motion-reduce:animate-none')
  })

  it('starts a draft from a default prompt only after the plugin is ready', async () => {
    const readyPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const onActivatePluginPrompt = vi.fn()
    const container = await renderPluginCenter(
      pluginApiMock({ ...baseSnapshot, plugins: [readyPlugin] }),
      vi.fn(),
      {
        page: 'detail',
        pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
      },
      false,
      {},
      onActivatePluginPrompt
    )

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="用 GitHub 执行提示词：Review the current pull request"]'
        )
        ?.click()
    })

    expect(onActivatePluginPrompt).toHaveBeenCalledWith({
      mention: { path: 'plugin://marketplace:personal/github', name: 'github' },
      prompt: 'Review the current pull request'
    })
  })

  it('offers Try now and moves uninstall into the plugin action menu', async () => {
    const readyPlugin = { ...baseSnapshot.plugins[0], installed: true, enabled: true }
    const onActivatePluginPrompt = vi.fn()
    const container = await renderPluginCenter(
      pluginApiMock({ ...baseSnapshot, plugins: [readyPlugin] }),
      vi.fn(),
      {
        page: 'detail',
        pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
      },
      false,
      {},
      onActivatePluginPrompt
    )

    const tryButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '立即试用'
    )
    expect(tryButton).toBeDefined()
    expect(container.querySelector('button[aria-label="更多插件操作"]')).not.toBeNull()
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === '卸载'
      )
    ).toBe(false)

    await act(async () => {
      tryButton?.click()
    })
    expect(onActivatePluginPrompt).toHaveBeenCalledWith({
      mention: { path: 'plugin://marketplace:personal/github', name: 'github' },
      prompt: 'Review the current pull request'
    })

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[aria-label="更多插件操作"]')
        ?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
      await Promise.resolve()
    })
    const uninstall = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === '卸载'
    )
    expect(uninstall).toBeDefined()

    await act(async () => {
      uninstall?.click()
    })
    expect(
      [...document.body.querySelectorAll('[role="dialog"]')].some((dialog) =>
        dialog.textContent?.includes('卸载 GitHub？')
      )
    ).toBe(true)
  })

  it('matches the reference plugin-card density and visual hierarchy', async () => {
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot))
    const card = container.querySelector<HTMLElement>(
      '[data-slot="plugin-category-featured"] article'
    )
    const grid = card?.parentElement
    const icon = [...(card?.querySelectorAll<HTMLElement>('div') ?? [])].find((element) =>
      element.classList.contains('size-10')
    )
    const title = card?.querySelector('h3')
    const description = card?.querySelector('p')
    const installButton = [...(card?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === '安装'
    )

    expect(grid?.className).toContain('gap-x-6')
    expect(grid?.className).toContain('gap-y-2')
    expect(card?.className).toContain('rounded-2xl')
    expect(card?.className).toContain('p-2')
    expect(card?.className).toContain('hover:bg-foreground/5')
    expect(card?.className).not.toContain('min-h-24')
    expect(icon?.className).toContain('rounded-lg')
    expect(icon?.className).toContain('bg-transparent')
    expect(title?.className).toContain('text-base')
    expect(title?.className).toContain('font-medium')
    expect(description?.className).toContain('text-[12px]')
    expect(description?.className).toContain('text-muted-foreground')
    expect(installButton?.getAttribute('data-size')).toBe('composer')
    expect(installButton?.className).toContain('h-7')
    expect(installButton?.className).toContain('rounded-lg')
  })

  it('uses the plugin-card layout for managed applications', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      apps: [
        {
          id: 'github-app',
          name: 'github-app',
          displayName: 'GitHub App',
          description: 'Repository tools',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: true,
          accessible: true,
          canToggle: true
        }
      ]
    }
    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'manage',
      tab: 'apps'
    })
    const card = container.querySelector<HTMLElement>('[data-slot="app-card"]')
    const grid = card?.parentElement
    const icon = card?.querySelector<HTMLElement>('.size-10')
    const title = card?.querySelector('h3')
    const description = card?.querySelector('p')

    expect(card?.className).toContain('rounded-2xl')
    expect(card?.className).toContain('p-2')
    expect(card?.className).toContain('hover:bg-foreground/5')
    expect(card?.className).not.toContain('border')
    expect(card?.className).toContain('min-w-0')
    expect(grid?.className).toContain('gap-y-2')
    expect(grid?.className).toContain('grid-cols-1')
    expect(grid?.className).not.toContain('md:grid-cols-2')
    expect(icon?.className).toContain('rounded-lg')
    expect(icon?.className).toContain('bg-transparent')
    expect(title?.className).toContain('text-base')
    expect(title?.className).toContain('font-medium')
    expect(description?.className).toContain('text-[12px]')
    expect(description?.className).toContain('text-muted-foreground')
    expect(card?.textContent).not.toContain('市场')
  })

  it('shows only enabled accessible applications in the management list', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      apps: [
        {
          id: 'active-app',
          name: 'Active App',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: true,
          accessible: true,
          canToggle: true
        },
        {
          id: 'disabled-app',
          name: 'Disabled App',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: false,
          accessible: true,
          canToggle: true
        },
        {
          id: 'inaccessible-app',
          name: 'Inaccessible App',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: true,
          accessible: false,
          canToggle: true
        }
      ]
    }

    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'manage',
      tab: 'apps'
    })

    expect(container.querySelectorAll('[data-slot="app-card"]')).toHaveLength(1)
    expect(container.textContent).toContain('Active App')
    expect(container.textContent).not.toContain('Disabled App')
    expect(container.textContent).not.toContain('Inaccessible App')
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toContain(
      '应用 1'
    )
  })

  it('removes an application card after its disable write is refreshed', async () => {
    const enabledSnapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      apps: [
        {
          id: 'github-app',
          name: 'GitHub App',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: true,
          accessible: true,
          canToggle: true
        }
      ]
    }
    const disabledSnapshot: PluginCenterSnapshot = {
      ...enabledSnapshot,
      apps: enabledSnapshot.apps.map((app) => ({ ...app, enabled: false }))
    }
    const api = pluginApiMock(enabledSnapshot)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: enabledSnapshot })
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: disabledSnapshot })
    const container = await renderPluginCenter(api, vi.fn(), { page: 'manage', tab: 'apps' })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="GitHub App 停用"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.setAppEnabled).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      app: { id: 'github-app' },
      enabled: false
    })
    expect(container.querySelector('[data-slot="app-card"]')).toBeNull()
    expect(container.textContent).toContain('没有应用')
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toContain(
      '应用 0'
    )
  })

  it('uses the plugin-card layout for skill cards while preserving preview and uninstall controls', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      skills: [
        {
          id: '/workspace/skills/review/SKILL.md',
          name: 'review',
          displayName: '代码审查',
          description: '审查当前变更并提出改进建议。',
          scope: 'workspace',
          sourceKind: 'local',
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: true,
          tags: []
        }
      ]
    }
    const api = pluginApiMock(snapshot)
    vi.mocked(api.getSkillContents).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'ready',
      skill: { id: '/workspace/skills/review/SKILL.md', name: 'review' },
      contents: '# Review',
      localPath: '/workspace/skills/review/SKILL.md'
    })
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'browse',
      tab: 'skills'
    })
    const card = container.querySelector<HTMLElement>('[data-slot="skill-card"]')
    const icon = card?.querySelector<HTMLElement>('.size-10')
    const skillIcon = card?.querySelector<HTMLElement>('[data-slot="plugin-detail-skill-icon"]')
    const title = card?.querySelector('h3')
    const description = card?.querySelector('p')
    const metadata = [...(card?.querySelectorAll<HTMLElement>('div') ?? [])].find((element) =>
      element.classList.contains('mt-3')
    )

    expect(card?.className).toContain('rounded-2xl')
    expect(card?.className).toContain('p-2')
    expect(card?.className).toContain('hover:bg-foreground/5')
    expect(icon?.className).toContain('rounded-lg')
    expect(skillIcon?.getAttribute('class')).toContain('size-6')
    expect(title?.className).toContain('text-base')
    expect(description?.className).toContain('text-[12px]')
    expect(metadata).toBeUndefined()
    expect(card?.querySelector('button[role="switch"]')).toBeNull()
    expect(card?.querySelector('[aria-label="代码审查 已安装"]')).not.toBeNull()

    await act(async () => {
      card?.querySelector<HTMLButtonElement>('button')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getSkillContents).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      skill: { id: '/workspace/skills/review/SKILL.md', name: 'review' }
    })
    const previewDialog = [
      ...document.body.querySelectorAll<HTMLElement>('[data-slot="plugin-skill-preview-dialog"]')
    ].at(-1)
    expect(previewDialog).toBeDefined()
    const trySkill = [...(previewDialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === '立即试用'
    )
    expect(trySkill?.disabled).toBe(false)
    expect(previewDialog?.textContent).not.toContain('正在处理技能状态。')

    const menuTrigger = previewDialog?.querySelector<HTMLButtonElement>(
      'button[aria-label="打开技能操作菜单"]'
    )
    await act(async () => {
      menuTrigger?.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
      )
      await Promise.resolve()
    })
    const uninstall = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === '卸载技能'
    )
    expect(uninstall).not.toBeUndefined()
    await act(async () => {
      uninstall?.click()
      await Promise.resolve()
    })

    const confirmationDialog = [
      ...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')
    ].find((dialog) => dialog.textContent?.includes('卸载 代码审查？'))
    const confirm = [
      ...(confirmationDialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    ].find((button) => button.textContent?.trim() === '确认')
    expect(confirm).not.toBeUndefined()
    await act(async () => {
      confirm?.click()
      await Promise.resolve()
    })
    expect(api.uninstallSkill).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      skill: { id: '/workspace/skills/review/SKILL.md', name: 'review' }
    })
  })

  it('does not list plugin-owned recommendations in the curated skills category', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      skills: [
        {
          id: 'plugin:github:review',
          name: 'review',
          displayName: 'GitHub review',
          description: 'Review pull requests.',
          scope: 'plugin',
          sourceKind: 'marketplace',
          pluginId: 'plugin:github',
          pluginDisplayName: 'GitHub',
          enabled: false,
          installed: false,
          recommended: true,
          canToggle: false,
          canUninstall: false,
          restriction: { code: 'unavailable', message: '请先安装所属插件' },
          tags: []
        }
      ]
    }
    const api = pluginApiMock(snapshot)
    const container = await renderPluginCenter(api, vi.fn(), { page: 'browse', tab: 'skills' })
    expect(container.querySelector('[data-slot="skill-card"]')).toBeNull()
    expect(api.getSkillContents).not.toHaveBeenCalled()
    expect(api.installPlugin).not.toHaveBeenCalled()
  })

  it('only shows standalone installed skills when plugin skills use the user scope', async () => {
    const snapshot: PluginCenterSnapshot = {
      ...baseSnapshot,
      skills: [
        {
          id: '/Users/example/.agents/skills/standalone/SKILL.md',
          name: 'standalone',
          displayName: 'Standalone Skill',
          description: 'A standalone skill.',
          scope: 'personal',
          sourceKind: 'personal',
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: false,
          tags: []
        },
        {
          id: '/Users/example/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/browser/SKILL.md',
          name: 'browser:control',
          displayName: 'Plugin Cache Skill',
          description: 'A plugin skill with user scope.',
          scope: 'personal',
          sourceKind: 'personal',
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: false,
          tags: []
        },
        {
          id: 'plugin:github:review',
          name: 'review',
          displayName: 'Plugin Detail Skill',
          description: 'A plugin detail skill.',
          scope: 'plugin',
          sourceKind: 'marketplace',
          pluginId: 'plugin:github',
          enabled: true,
          installed: true,
          recommended: true,
          canToggle: true,
          canUninstall: false,
          tags: []
        },
        {
          id: '/unclassified/skills/unknown/SKILL.md',
          name: 'unknown',
          displayName: 'Unknown Path Skill',
          description: 'A skill from an unclassified path.',
          scope: 'personal',
          sourceKind: 'personal',
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: false,
          tags: []
        }
      ]
    }

    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'browse',
      tab: 'skills'
    })
    const overview = container.querySelector<HTMLElement>('[data-slot="installed-skills-overview"]')
    const category = container.querySelector<HTMLElement>('[data-slot="skill-category-grid"]')

    expect(overview?.textContent).toContain('Standalone Skill')
    expect(overview?.textContent).toContain('Unknown Path Skill')
    expect(overview?.textContent).not.toContain('Plugin Cache Skill')
    expect(overview?.textContent).not.toContain('Plugin Detail Skill')
    expect(category?.textContent).not.toContain('Plugin Cache Skill')
    expect(category?.textContent).not.toContain('Plugin Detail Skill')
  })

  it('sorts the installed overview, limits it to six cards, and keeps personal and system skills separate', async () => {
    const skills = [
      ['alpha', 'Alpha'],
      ['beta', 'Beta'],
      ['gamma', 'Gamma'],
      ['system-audit', 'System Audit'],
      ['system-shell', 'System Shell'],
      ['workspace', 'Workspace'],
      ['workflows', 'Workflows'],
      ['writing', 'Writing'],
      ['zeta', 'Zeta']
    ].map(([name, displayName]) => {
      const system = name.startsWith('system-')
      return {
        id: `/skills/${name}/SKILL.md`,
        name,
        displayName,
        description: `${displayName} skill`,
        scope: system ? ('system' as const) : ('personal' as const),
        sourceKind: system ? ('builtin' as const) : ('personal' as const),
        enabled: true,
        installed: true,
        recommended: false,
        canToggle: true,
        canUninstall: false,
        tags: []
      }
    })
    const snapshot = { ...baseSnapshot, skills }
    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'browse',
      tab: 'skills'
    })

    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="搜索技能"]')
    ).not.toBeNull()
    expect(
      container.querySelectorAll('[data-slot="installed-skills-overview"] [data-slot="skill-card"]')
    ).toHaveLength(6)
    expect(container.querySelector('[data-slot="installed-skills-summary"]')?.textContent).toBe(
      '查看 Workspace、Writing，另有 1 项'
    )
    const summary = container.querySelector<HTMLButtonElement>(
      '[data-slot="installed-skills-summary"]'
    )
    expect(summary?.className).toBe(
      'mt-4 flex min-h-[31px] w-full cursor-pointer items-center gap-3 self-start rounded-lg px-2.5 py-[5px] text-left text-[12px] leading-relaxed font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
    )
    expect(summary?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => {
      summary?.click()
      await Promise.resolve()
    })

    expect(
      container.querySelectorAll('[data-slot="installed-skills-overview"] [data-slot="skill-card"]')
    ).toHaveLength(9)
    expect(summary?.textContent).toBe('收起')
    expect(summary?.getAttribute('aria-expanded')).toBe('true')
    expect(
      container.querySelector<HTMLElement>('[data-slot="skill-category-grid"]')?.textContent
    ).toContain('Alpha')
    expect(
      container.querySelector<HTMLElement>('[data-slot="skill-category-grid"]')?.textContent
    ).not.toContain('System Audit')

    const systemContainer = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'browse',
      tab: 'skills',
      category: 'system'
    })
    const systemGrid = systemContainer.querySelector<HTMLElement>(
      '[data-slot="skill-category-grid"]'
    )
    expect(systemGrid?.textContent).toContain('System Audit')
    expect(systemGrid?.textContent).toContain('System Shell')
    expect(systemGrid?.textContent).not.toContain('Alpha')
  })

  it('formats fallback installed skill names like the reference skills page', async () => {
    const snapshot = {
      ...baseSnapshot,
      skills: [
        {
          id: '/skills/openai-api_mcp/SKILL.md',
          name: 'openai-api_mcp',
          description: 'Uses OpenAI APIs through MCP.',
          scope: 'personal' as const,
          sourceKind: 'personal' as const,
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: true,
          tags: []
        },
        {
          id: '/skills/custom/SKILL.md',
          name: 'custom-skill',
          displayName: 'Custom display name',
          description: 'Uses an explicitly configured display name.',
          scope: 'personal' as const,
          sourceKind: 'personal' as const,
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          canUninstall: true,
          tags: []
        }
      ]
    }

    const container = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'browse',
      tab: 'skills'
    })
    const overview = container.querySelector<HTMLElement>('[data-slot="installed-skills-overview"]')

    expect(overview?.textContent).toContain('OpenAI API MCP')
    expect(overview?.textContent).not.toContain('openai-api_mcp')
    expect(overview?.textContent).toContain('Custom display name')
  })

  it('installs a curated skill through its direct API instead of installing an owning plugin', async () => {
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.getRecommendedSkills).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      fetchedAt: '2026-08-30T00:00:00.000Z',
      source: 'cache',
      skills: [
        {
          id: 'writer',
          name: 'Curated Writer',
          description: 'Write clear documents.',
          repoPath: 'skills/.curated/writer'
        }
      ]
    })
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'browse',
      tab: 'skills',
      category: 'recommended'
    })
    const installButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="安装技能 Curated Writer"]'
    )

    expect(installButton?.getAttribute('data-variant')).toBe('outline')
    expect(installButton?.getAttribute('data-size')).toBe('composer')
    expect(installButton?.className).toContain('rounded-lg')
    expect(installButton?.textContent).toBe('安装')

    await act(async () => {
      installButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.installRecommendedSkill).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      id: 'writer',
      repoPath: 'skills/.curated/writer'
    })
    expect(api.installPlugin).not.toHaveBeenCalled()
  })

  it('keeps the skills page usable when the curated catalog has no cached result and supports retry', async () => {
    const api = pluginApiMock(baseSnapshot)
    vi.mocked(api.getRecommendedSkills)
      .mockRejectedValueOnce(new Error('目录暂时不可用'))
      .mockResolvedValueOnce({
        version: PLUGIN_CENTER_API_VERSION,
        fetchedAt: '2026-08-30T00:00:00.000Z',
        source: 'cache',
        skills: []
      })
    const container = await renderPluginCenter(api, vi.fn(), {
      page: 'browse',
      tab: 'skills',
      category: 'recommended'
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('无法加载推荐技能')
    expect(container.textContent).toContain('目录暂时不可用')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === '重试'
    )
    expect(retry).toBeDefined()
    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.getRecommendedSkills).toHaveBeenLastCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      forceRefresh: true
    })
  })

  it('previews six plugins per category and opens the full category view from the more row', async () => {
    const plugins = Array.from({ length: 9 }, (_, index) => ({
      ...baseSnapshot.plugins[0],
      id: `plugin:featured-${index + 1}`,
      name: `featured-${index + 1}`,
      displayName: `精选插件 ${index + 1}`,
      description: `精选插件 ${index + 1} 的说明`,
      icon: { kind: 'initials' as const, value: `${index + 1}` },
      featured: true
    }))
    const snapshot = { ...baseSnapshot, plugins }
    const onSurfaceChange = vi.fn()
    const container = await renderPluginCenter(pluginApiMock(snapshot), onSurfaceChange)
    const featuredSection = container.querySelector<HTMLElement>(
      '[data-slot="plugin-category-featured"]'
    )
    const moreRow = featuredSection?.querySelector<HTMLButtonElement>(
      '[data-slot="plugin-category-more"]'
    )

    expect(featuredSection?.querySelectorAll('article')).toHaveLength(6)
    expect(moreRow?.textContent).toContain('精选插件 7、精选插件 8、精选插件 9')
    expect(moreRow?.className).toContain('mt-4')
    expect(moreRow?.className).toContain('min-h-[31px]')
    expect(moreRow?.className).toContain('w-full')
    expect(moreRow?.className).toContain('px-2.5')
    expect(moreRow?.className).toContain('py-[5px]')
    expect(moreRow?.className).toContain('text-[12px]')
    expect(moreRow?.className).toContain('leading-relaxed')
    expect(moreRow?.className).toContain('font-normal')
    expect(moreRow?.className).not.toContain('hover:bg-')
    expect(moreRow?.querySelector('[aria-hidden="true"]')?.className).toContain('shrink-0')
    const previewIcon = moreRow?.querySelector<HTMLElement>('[aria-hidden="true"] > span')
    expect(previewIcon?.className).toContain('-ms-1.5')
    expect(previewIcon?.className).toContain('size-6')
    expect(previewIcon?.className).toContain('rounded-md')
    expect(previewIcon?.className).toContain('ring-inset')

    await act(async () => {
      moreRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSurfaceChange).toHaveBeenCalledWith({
      page: 'browse',
      tab: 'plugins',
      category: '__featured__',
      search: '',
      scrollTop: 0
    })

    const detailContainer = await renderPluginCenter(pluginApiMock(snapshot), vi.fn(), {
      page: 'browse',
      tab: 'plugins',
      category: '__featured__'
    })
    const detailSection = detailContainer.querySelector<HTMLElement>(
      '[data-slot="plugin-category-detail"]'
    )

    expect(
      detailContainer.querySelector('[data-slot="plugin-category-breadcrumb"]')?.textContent
    ).toContain('插件精选')
    expect(detailSection?.querySelectorAll('article')).toHaveLength(9)
    expect(detailContainer.querySelector('[data-slot="plugin-category-more"]')).toBeNull()
  })

  it('renders HTTPS icon URLs allowed by the renderer CSP', async () => {
    const iconUrl = 'https://cdn.example.test/plugin.png'
    const container = await renderPluginCenter(
      pluginApiMock({
        ...baseSnapshot,
        plugins: [
          {
            ...baseSnapshot.plugins[0],
            icon: { kind: 'url', value: iconUrl }
          }
        ]
      })
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe(iconUrl)
  })

  it('renders icon URLs served through the allowed app media protocol', async () => {
    const iconUrl = 'app://fs/@fs/plugins/github/icon.png'
    const container = await renderPluginCenter(
      pluginApiMock({
        ...baseSnapshot,
        plugins: [{ ...baseSnapshot.plugins[0], icon: { kind: 'url', value: iconUrl } }]
      })
    )

    expect(container.querySelector('img')?.getAttribute('src')).toBe(iconUrl)
  })

  it('uses the large skill image first and falls back to the small image or default icon', async () => {
    const smallIconUrl = 'https://cdn.example.test/review-skill-small.png'
    const largeIconUrl = 'https://cdn.example.test/review-skill-large.png'
    const container = await renderPluginCenter(
      pluginApiMock({
        ...baseSnapshot,
        skills: [
          {
            id: 'skill:review',
            name: 'review',
            displayName: '代码审查',
            description: '审查当前变更。',
            iconSmall: { kind: 'url', value: smallIconUrl },
            iconLarge: { kind: 'url', value: largeIconUrl },
            scope: 'personal',
            sourceKind: 'personal',
            enabled: true,
            installed: true,
            recommended: false,
            canToggle: true,
            canUninstall: false,
            tags: []
          },
          {
            id: 'skill:writer',
            name: 'writer',
            displayName: '文档写作',
            description: '编写项目文档。',
            iconSmall: { kind: 'url', value: smallIconUrl },
            scope: 'personal',
            sourceKind: 'personal',
            enabled: true,
            installed: true,
            recommended: false,
            canToggle: true,
            canUninstall: false,
            tags: []
          },
          {
            id: 'skill:plain',
            name: 'plain',
            displayName: '无图技能',
            description: '未提供图片。',
            scope: 'personal',
            sourceKind: 'personal',
            enabled: true,
            installed: true,
            recommended: false,
            canToggle: true,
            canUninstall: false,
            tags: []
          }
        ]
      }),
      vi.fn(),
      { page: 'browse', tab: 'skills' }
    )
    const cards = container.querySelectorAll<HTMLElement>(
      '[data-slot="installed-skills-overview"] [data-slot="skill-card"]'
    )

    expect(cards).toHaveLength(3)
    expect(cards[0]?.querySelector('img')?.getAttribute('src')).toBe(largeIconUrl)
    expect(cards[0]?.querySelector('[data-slot="plugin-detail-skill-icon"]')).toBeNull()
    expect(cards[1]?.querySelector('img')?.getAttribute('src')).toBe(smallIconUrl)
    expect(cards[2]?.querySelector('[data-slot="plugin-detail-skill-icon"]')).not.toBeNull()
  })

  it('filters the loaded snapshot and preserves old data when refresh fails', async () => {
    const api = pluginApiMock({
      ...baseSnapshot,
      plugins: [
        baseSnapshot.plugins[0],
        {
          ...baseSnapshot.plugins[0],
          id: 'plugin:slack',
          name: 'slack',
          displayName: 'Slack',
          description: 'Team chat tools',
          tags: ['chat']
        }
      ]
    })
    const container = await renderPluginCenter(api)

    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).toContain('Slack')

    vi.mocked(api.getSnapshot).mockRejectedValueOnce(new Error('network down'))

    const refreshButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="刷新插件中心"]'
    )
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('network down')
    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).toContain('Slack')

    const searchInput = container.querySelector<HTMLInputElement>('input[placeholder="搜索插件"]')
    await act(async () => {
      if (!searchInput) return
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(searchInput, 'team')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(container.textContent).not.toContain('GitHub')
    expect(container.textContent).toContain('Slack')
  })

  it('shows a retryable warning for a degraded plugin catalog', async () => {
    const degradedSnapshot = {
      ...baseSnapshot,
      catalogUnavailableReason: '远程插件市场暂时不可用，当前仅显示本地插件。请稍后刷新重试。'
    }
    const api = pluginApiMock(degradedSnapshot)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: degradedSnapshot })
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: baseSnapshot })
    const container = await renderPluginCenter(api)
    const warning = container.querySelector<HTMLElement>('[data-slot="plugin-catalog-warning"]')

    expect(warning?.textContent).toContain('当前仅显示本地插件')

    await act(async () => {
      warning
        ?.querySelector<HTMLButtonElement>('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(api.getSnapshot).toHaveBeenLastCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      sections: ['plugins'],
      includePluginDetails: false,
      forceRefresh: true
    })
    expect(container.querySelector('[data-slot="plugin-catalog-warning"]')).toBeNull()
    expect(container.textContent).toContain('GitHub')
  })

  it('does not fetch management-only data in the background while browsing plugins', async () => {
    const api = pluginApiMock(baseSnapshot)
    const container = await renderPluginCenter(api)

    expect(container.textContent).toContain('GitHub')
    expect(api.getSnapshot).toHaveBeenNthCalledWith(1, {
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      forceRefresh: false,
      sections: ['plugins'],
      includePluginDetails: false
    })
    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(1)
  })

  it('issues only one initial request and clears loading under React StrictMode', async () => {
    const api = pluginApiMock(baseSnapshot)
    const container = await renderPluginCenter(
      api,
      vi.fn(),
      { page: 'browse', tab: 'plugins' },
      true
    )

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).not.toContain('正在读取插件中心')
  })

  it('reuses the plugin catalog when the page is reopened within the cache window', async () => {
    const api = pluginApiMock(baseSnapshot)

    await renderPluginCenter(api)
    const reopened = await renderPluginCenter(api)

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(1)
    expect(reopened.textContent).toContain('GitHub')
    expect(reopened.textContent).not.toContain('正在读取插件中心')
  })

  it('does not include threadId in the shared catalog key and loads a new cwd once', async () => {
    const api = pluginApiMock(baseSnapshot)

    await renderPluginCenter(api, vi.fn(), { page: 'browse', tab: 'plugins' }, false, {
      cwd: '/repo-a',
      threadId: 'thread-a'
    })
    await renderPluginCenter(api, vi.fn(), { page: 'browse', tab: 'plugins' }, false, {
      cwd: '/repo-a',
      threadId: 'thread-b'
    })

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(1)
    expect(api.getSnapshot).toHaveBeenCalledWith(
      expect.not.objectContaining({ threadId: expect.anything() })
    )

    await renderPluginCenter(api, vi.fn(), { page: 'browse', tab: 'plugins' }, false, {
      cwd: '/repo-b',
      threadId: 'thread-b'
    })
    expect(api.getSnapshot).toHaveBeenCalledTimes(2)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['apps', 'apps', false],
    ['mcp', 'mcp', false],
    ['skills', 'skills', true]
  ] as const)(
    'loads the active %s management section',
    async (tab, section, needsPluginContext) => {
      const api = pluginApiMock(baseSnapshot)

      await renderPluginCenter(api, vi.fn(), { page: 'manage', tab })

      expect(api.getSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sections: [section] }))
      if (needsPluginContext) {
        expect(api.getSnapshot).toHaveBeenCalledWith({
          version: PLUGIN_CENTER_API_VERSION,
          cwd: undefined,
          forceRefresh: false,
          sections: ['plugins'],
          includePluginDetails: false
        })
        expect(api.getInstalledPlugins).toHaveBeenCalledTimes(1)
      } else {
        expect(api.getSnapshot).toHaveBeenCalledTimes(1)
        expect(api.getInstalledPlugins).not.toHaveBeenCalled()
      }
    }
  )

  it('keeps previously loaded management tabs when visiting the host-scoped MCP tab', async () => {
    const api = pluginApiMock({
      ...baseSnapshot,
      apps: [
        {
          id: 'github-app',
          name: 'github-app',
          displayName: 'GitHub App',
          description: 'App tools',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: true,
          accessible: true,
          canToggle: true
        }
      ]
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    const renderSurface = async (surface: PluginCenterSurface): Promise<void> => {
      await act(async () => {
        root.render(
          <PluginCenterPage
            surface={surface}
            onSurfaceChange={vi.fn()}
            api={api}
            threadId="thread-a"
          />
        )
        await Promise.resolve()
      })
    }

    await renderSurface({ page: 'manage', tab: 'apps' })
    expect(container.textContent).toContain('GitHub App')
    await renderSurface({ page: 'manage', tab: 'mcp' })
    await renderSurface({ page: 'manage', tab: 'apps' })

    expect(container.textContent).toContain('GitHub App')
    expect(
      vi
        .mocked(api.getSnapshot)
        .mock.calls.filter(([request]) => request.sections?.includes('apps'))
    ).toHaveLength(1)
    await act(async () => root.unmount())
  })

  it('keeps cached app data visible and shows background refresh progress', async () => {
    const first = {
      ...baseSnapshot,
      apps: [
        {
          id: 'github-app',
          name: 'github-app',
          displayName: 'GitHub App',
          description: 'App tools',
          sourceKind: 'marketplace' as const,
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: true,
          accessible: true,
          canToggle: true
        }
      ]
    }
    const second = {
      ...first,
      apps: first.apps.map((app) => ({ ...app, displayName: 'GitHub App Updated' }))
    }
    const refresh = deferred<{
      version: typeof PLUGIN_CENTER_API_VERSION
      snapshot: PluginCenterSnapshot
    }>()
    const api = pluginApiMock(first)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: first })
      .mockReturnValueOnce(refresh.promise)
    const container = await renderPluginCenter(api, vi.fn(), { page: 'manage', tab: 'apps' })
    const refreshButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="刷新插件中心"]'
    )

    await act(async () => {
      refreshButton?.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('GitHub App')
    expect(refreshButton?.querySelector('svg')?.className.baseVal).toContain('animate-spin')

    await act(async () => {
      refresh.resolve({ version: PLUGIN_CENTER_API_VERSION, snapshot: second })
      await refresh.promise
      await Promise.resolve()
    })

    expect(container.textContent).toContain('GitHub App Updated')
    expect(refreshButton?.querySelector('svg')?.className.baseVal).not.toContain('animate-spin')
  })

  it('keeps installed-only plugins visible when their marketplace catalog entry is unavailable', async () => {
    const api = pluginApiMock({ ...baseSnapshot, plugins: [] })
    vi.mocked(api.getInstalledPlugins).mockResolvedValueOnce({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: '2026-08-24T00:00:00.000Z',
      plugins: [{ ...baseSnapshot.plugins[0], installed: true, enabled: true }]
    })

    const container = await renderPluginCenter(api, vi.fn(), { page: 'manage', tab: 'plugins' })

    expect(container.textContent).toContain('GitHub')
    expect(container.querySelector('[data-slot="installed-plugin-icon"]')).toBeNull()
  })
})
