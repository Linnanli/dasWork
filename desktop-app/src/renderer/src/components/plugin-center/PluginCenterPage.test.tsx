// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopPluginCenterApi,
  PluginCenterGetPluginDetailResult,
  PluginCenterSnapshot
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import { PluginCenterPage, type PluginCenterSurface } from './PluginCenterPage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
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
    uninstallPlugin: vi.fn(),
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
    setMcpServerEnabled: vi.fn(),
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
  onTryApp?: (input: { mention: { path: string; name: string } }) => void
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
      cwd: undefined
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
    expect(container.querySelector('[data-slot="installed-plugin-icon"]')).not.toBeNull()
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(onSurfaceChange).not.toHaveBeenCalled()
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

    const skill = container.querySelector<HTMLElement>('[data-slot="plugin-detail-skill"]')
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
      '[data-slot="plugin-detail-app"] button[aria-label="连接 GitHub App"]'
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
    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app"]')
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
    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app"]')
    const appOpen = app?.querySelector<HTMLButtonElement>('[data-slot="plugin-detail-app-open"]')

    expect(appOpen?.tagName).toBe('BUTTON')
    expect(app?.getAttribute('role')).toBeNull()

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
    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app"]')
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
        '[data-slot="plugin-detail-app"] button[aria-label="连接 GitHub App"]'
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

  it('uses the reference detail-page inset across resource and information sections', async () => {
    const container = await renderPluginCenter(pluginApiMock(baseSnapshot), vi.fn(), {
      page: 'detail',
      pluginRef: { id: 'plugin:github', marketplaceId: 'marketplace:personal' }
    })
    await act(async () => {
      await Promise.resolve()
    })

    const app = container.querySelector<HTMLElement>('[data-slot="plugin-detail-app"]')
    const detailPage = container.querySelector<HTMLElement>('[data-slot="plugin-detail-page"]')
    const appsHeading = Array.from(container.querySelectorAll('h2')).find(
      (heading) => heading.textContent === '应用 1'
    )
    const informationHeading = Array.from(container.querySelectorAll('h2')).find(
      (heading) => heading.textContent === '信息'
    )
    const icon = app?.querySelector<HTMLElement>('img, div')
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

    expect(detailPage?.className).toContain('[--detail-page-inline-inset:0.5rem]')
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
    ['apps', 'apps'],
    ['mcp', 'mcp'],
    ['skills', 'skills']
  ] as const)('loads only the active %s management section', async (tab, section) => {
    const api = pluginApiMock(baseSnapshot)

    await renderPluginCenter(api, vi.fn(), { page: 'manage', tab })

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getSnapshot).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: undefined,
      threadId: undefined,
      forceRefresh: false,
      sections: [section],
      includePluginDetails: false
    })
    expect(api.getInstalledPlugins).not.toHaveBeenCalled()
  })

  it('keeps previously loaded management tabs when visiting a thread-scoped MCP tab', async () => {
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
