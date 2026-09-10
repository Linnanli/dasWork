import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopPluginCenterApi,
  PluginCenterGetAppToolsResult,
  PluginCenterGetSkillContentsResult,
  PluginCenterInstalledPluginsResult,
  PluginCenterPlugin,
  PluginCenterSnapshot
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import {
  getPluginCenterCatalogResource,
  getPluginCenterAppToolsResource,
  getPluginCenterInstalledResource,
  getPluginCenterPluginDetailResource,
  getPluginCenterRecommendedSkillsResource,
  getPluginCenterSkillContentsResource,
  getPluginCenterSupplementalResource,
  invalidatePluginCenterAppToolsResource,
  mergeInstalledPluginsForDisplay,
  mergePluginCatalogWithInstalled,
  prefetchPluginCenterData,
  subscribePluginCenterData
} from './pluginCenterDataResource'

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

type TestPluginCenterApi = DesktopPluginCenterApi & {
  getInstalledPlugins(input: {
    version: typeof PLUGIN_CENTER_API_VERSION
    cwd?: string
    forceRefresh?: boolean
  }): Promise<PluginCenterInstalledPluginsResult>
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const githubPlugin: PluginCenterPlugin = {
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
  canToggle: true
}

function snapshot(plugins: PluginCenterPlugin[]): PluginCenterSnapshot {
  return {
    version: PLUGIN_CENTER_API_VERSION,
    generatedAt: new Date(Date.now()).toISOString(),
    plugins,
    skills: [],
    apps: [],
    mcp: { userServers: [], pluginServers: [] },
    marketplaces: []
  }
}

function mcpSnapshot(
  available: boolean,
  options: {
    message?: string
    userServers?: PluginCenterSnapshot['mcp']['userServers']
  } = {}
): PluginCenterSnapshot {
  return {
    ...snapshot([]),
    mcp: { userServers: options.userServers ?? [], pluginServers: [] },
    capabilities: {
      plugins: { available: true },
      skills: { available: true },
      apps: { available: true },
      mcp: available
        ? { available: true }
        : {
            available: false,
            restriction: {
              code: 'error',
              message: options.message ?? '该数据源暂时不可用'
            }
          }
    }
  }
}

function createApi(snapshotResult = snapshot([githubPlugin])): TestPluginCenterApi {
  return {
    cancelRequest: vi.fn(),
    getSnapshot: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      snapshot: snapshotResult
    })),
    getInstalledPlugins: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: new Date(Date.now()).toISOString(),
      plugins: []
    })),
    getPluginDetail: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'missing' as const,
      missingReason: 'not_found' as const
    })),
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
      contents: '# GitHub review\nUse GitHub.'
    })),
    getRecommendedSkills: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      fetchedAt: new Date(Date.now()).toISOString(),
      source: 'cache' as const,
      skills: []
    })),
    addMarketplace: vi.fn(),
    installPlugin: vi.fn(),
    installRecommendedSkill: vi.fn(),
    uninstallPlugin: vi.fn(),
    setPluginEnabled: vi.fn(),
    setSkillEnabled: vi.fn(),
    setAppEnabled: vi.fn(),
    setMcpServerEnabled: vi.fn(),
    upsertMcpServer: vi.fn(),
    removeMcpServer: vi.fn()
  } as unknown as TestPluginCenterApi
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pluginCenterDataResource', () => {
  it('caches plugin catalog by api identity and canonical cwd without thread context', async () => {
    const api = createApi()
    const resource = getPluginCenterCatalogResource(api, '/repo/')

    await resource.prefetch()
    await resource.prefetch()

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getSnapshot).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        sections: ['plugins'],
        includePluginDetails: false,
        forceRefresh: false
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(resource.getSnapshot().data?.plugins).toHaveLength(1)
  })

  it('keeps stale catalog data visible while a refresh is in flight', async () => {
    const first = snapshot([githubPlugin])
    const second = snapshot([{ ...githubPlugin, displayName: 'GitHub Updated' }])
    const refresh = deferred<{
      version: typeof PLUGIN_CENTER_API_VERSION
      snapshot: PluginCenterSnapshot
    }>()
    const api = createApi(first)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: first })
      .mockReturnValueOnce(refresh.promise)
    const resource = getPluginCenterCatalogResource(api, '/repo')

    await resource.prefetch()
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1_000 + 1)
    const refreshPromise = resource.refresh()
    await Promise.resolve()

    expect(resource.getSnapshot()).toMatchObject({
      data: first,
      error: null,
      status: 'ready',
      isRefreshing: true
    })

    refresh.resolve({ version: PLUGIN_CENTER_API_VERSION, snapshot: second })
    await refreshPromise
    expect(resource.getSnapshot().data?.plugins[0]?.displayName).toBe('GitHub Updated')
  })

  it('preserves stale catalog data when refresh fails', async () => {
    const first = snapshot([githubPlugin])
    const api = createApi(first)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: first })
      .mockRejectedValueOnce(new Error('network failed'))
    const resource = getPluginCenterCatalogResource(api, '/repo')

    await resource.prefetch()
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1_000 + 1)
    await resource.refresh()

    expect(resource.getSnapshot()).toMatchObject({
      data: first,
      error: 'network failed',
      status: 'ready',
      isRefreshing: false
    })
  })

  it('immediately revalidates a degraded catalog instead of caching it for six hours', async () => {
    const degraded = {
      ...snapshot([githubPlugin]),
      catalogUnavailableReason: '远程插件市场暂时不可用，当前仅显示本地插件。请稍后刷新重试。'
    }
    const recovered = snapshot([{ ...githubPlugin, displayName: 'GitHub Recovered' }])
    const api = createApi(degraded)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: degraded })
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: recovered })
    const resource = getPluginCenterCatalogResource(api, '/repo')

    await resource.prefetch()
    await resource.prefetch()

    expect(api.getSnapshot).toHaveBeenCalledTimes(2)
    expect(resource.getSnapshot().data?.plugins[0]?.displayName).toBe('GitHub Recovered')
    expect(resource.getSnapshot().data?.catalogUnavailableReason).toBeUndefined()
  })

  it('joins concurrent catalog requests into one plugin/list call', async () => {
    const pending = deferred<{
      version: typeof PLUGIN_CENTER_API_VERSION
      snapshot: PluginCenterSnapshot
    }>()
    const api = createApi()
    vi.mocked(api.getSnapshot).mockReturnValue(pending.promise)
    const resource = getPluginCenterCatalogResource(api, '/repo')

    const first = resource.prefetch()
    const second = resource.prefetch()
    await Promise.resolve()

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    pending.resolve({ version: PLUGIN_CENTER_API_VERSION, snapshot: snapshot([githubPlugin]) })
    await Promise.all([first, second])
  })

  it('aborts an in-flight read when the resource is released', async () => {
    const pending = deferred<{
      version: typeof PLUGIN_CENTER_API_VERSION
      snapshot: PluginCenterSnapshot
    }>()
    const api = createApi()
    let signal: AbortSignal | undefined
    vi.mocked(api.getSnapshot).mockImplementation(async (_input, options) => {
      signal = options?.signal
      return pending.promise
    })
    const resource = getPluginCenterCatalogResource(api, '/repo')

    const loading = resource.prefetch()
    await Promise.resolve()
    resource.release()

    expect(signal?.aborted).toBe(true)
    expect(api.cancelRequest).toHaveBeenCalledWith(expect.any(String))
    pending.resolve({ version: PLUGIN_CENTER_API_VERSION, snapshot: snapshot([githubPlugin]) })
    await loading
  })

  it('caches installed plugins independently for one minute', async () => {
    const installed = { ...githubPlugin, installed: true, enabled: true }
    const api = createApi()
    vi.mocked(api.getInstalledPlugins).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: new Date(Date.now()).toISOString(),
      plugins: [installed]
    })
    const resource = getPluginCenterInstalledResource(api, '/repo')

    await resource.prefetch()
    await resource.prefetch()
    vi.setSystemTime(Date.now() + 60_001)
    await resource.prefetch()

    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(2)
    expect(api.getSnapshot).not.toHaveBeenCalled()
    expect(resource.getSnapshot().data).toEqual([installed])
  })

  it('passes force refresh through when reloading installed plugins', async () => {
    const api = createApi()
    const resource = getPluginCenterInstalledResource(api, '/repo')

    await resource.refresh(true)

    expect(api.getInstalledPlugins).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        forceRefresh: true
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('reads one plugin detail by its exact locator and caches it for thirty seconds', async () => {
    const api = createApi()
    const resource = getPluginCenterPluginDetailResource(
      api,
      { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      '/repo/'
    )

    await resource.prefetch()
    await resource.prefetch()

    expect(api.getPluginDetail).toHaveBeenCalledTimes(1)
    expect(api.getPluginDetail).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
        forceRefresh: false
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('lazily reads one app tool list per cwd, thread, and app identity for five minutes', async () => {
    const api = createApi()
    vi.mocked(api.getAppTools).mockResolvedValue({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'ready',
      app: { id: 'github-app' },
      tools: [{ name: 'github.search', enabled: true, readOnly: true }]
    } satisfies PluginCenterGetAppToolsResult)
    const resource = getPluginCenterAppToolsResource(api, 'github-app', '/repo/', 'thread-a')

    await resource.prefetch()
    await resource.prefetch()

    expect(api.getAppTools).toHaveBeenCalledTimes(1)
    expect(api.getAppTools).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        threadId: 'thread-a',
        app: { id: 'github-app' }
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(resource.getSnapshot().data).toMatchObject({
      status: 'ready',
      tools: [{ name: 'github.search' }]
    })

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
    await resource.prefetch()
    expect(api.getAppTools).toHaveBeenCalledTimes(2)
  })

  it('invalidates one cached app tool list by cwd, thread, and app identity', async () => {
    const api = createApi()
    const resource = getPluginCenterAppToolsResource(api, 'github-app', '/repo/', 'thread-a')

    await resource.prefetch()
    invalidatePluginCenterAppToolsResource(api, 'github-app', '/repo', 'thread-a')
    await resource.prefetch()

    expect(api.getAppTools).toHaveBeenCalledTimes(2)
  })

  it('lazily reads one trusted skill preview per plugin, skill, and cwd', async () => {
    const api = createApi()
    const resource = getPluginCenterSkillContentsResource(
      api,
      { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      { id: 'github-review', name: 'GitHub review' },
      '/repo/'
    )

    await resource.prefetch()
    await resource.prefetch()

    expect(api.getSkillContents).toHaveBeenCalledTimes(1)
    expect(api.getSkillContents).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
        skill: { id: 'github-review', name: 'GitHub review' }
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(resource.getSnapshot().data).toMatchObject({
      status: 'ready',
      contents: '# GitHub review\nUse GitHub.'
    } satisfies Partial<PluginCenterGetSkillContentsResult>)
  })

  it('caches recommended skills for five minutes and passes force refresh through', async () => {
    const api = createApi()
    const resource = getPluginCenterRecommendedSkillsResource(api)

    await resource.prefetch()
    await resource.prefetch()
    expect(api.getRecommendedSkills).toHaveBeenCalledTimes(1)
    expect(api.getRecommendedSkills).toHaveBeenLastCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        forceRefresh: false
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    await resource.refresh(true)
    expect(api.getRecommendedSkills).toHaveBeenCalledTimes(2)
    expect(api.getRecommendedSkills).toHaveBeenLastCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        forceRefresh: true
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('ignores an older installed-state response after invalidation starts a readback', async () => {
    const oldRequest = deferred<PluginCenterInstalledPluginsResult>()
    const readbackRequest = deferred<PluginCenterInstalledPluginsResult>()
    const installed = { ...githubPlugin, installed: true, enabled: true }
    const api = createApi()
    vi.mocked(api.getInstalledPlugins)
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(readbackRequest.promise)
    const resource = getPluginCenterInstalledResource(api, '/repo')

    const initialLoad = resource.prefetch()
    resource.invalidate()
    const readback = resource.refresh(true)

    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(2)
    readbackRequest.resolve({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: new Date(Date.now()).toISOString(),
      plugins: [installed]
    })
    await readback
    oldRequest.resolve({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: new Date(Date.now()).toISOString(),
      plugins: []
    })
    await initialLoad

    expect(resource.getSnapshot()).toMatchObject({
      data: [installed],
      error: null,
      status: 'ready',
      isRefreshing: false
    })
  })

  it('lazily reads a local skill preview without inventing plugin context', async () => {
    const api = createApi()
    const resource = getPluginCenterSkillContentsResource(
      api,
      undefined,
      { id: '/skills/writer/SKILL.md', name: 'writer' },
      '/repo/'
    )

    await resource.prefetch()

    expect(api.getSkillContents).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        skill: { id: '/skills/writer/SKILL.md', name: 'writer' }
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it.each([
    ['skills', 60_001],
    ['apps', 60_001],
    ['mcp', 5 * 60_000 + 1]
  ] as const)(
    'keeps stale %s data visible while refreshing after its ttl',
    async (section, ttlMs) => {
      const first = { ...snapshot([]), generatedAt: 'first' }
      const second = { ...snapshot([]), generatedAt: 'second' }
      const refresh = deferred<{
        version: typeof PLUGIN_CENTER_API_VERSION
        snapshot: PluginCenterSnapshot
      }>()
      const api = createApi(first)
      vi.mocked(api.getSnapshot)
        .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: first })
        .mockReturnValueOnce(refresh.promise)
      const resource = getPluginCenterSupplementalResource(api, section, '/repo')

      await resource.prefetch()
      await resource.prefetch()
      expect(api.getSnapshot).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + ttlMs)
      const refreshPromise = resource.prefetch()
      await Promise.resolve()

      expect(resource.getSnapshot()).toMatchObject({
        data: first,
        error: null,
        status: 'ready',
        isRefreshing: true
      })
      expect(api.getSnapshot).toHaveBeenCalledTimes(2)

      refresh.resolve({ version: PLUGIN_CENTER_API_VERSION, snapshot: second })
      await refreshPromise
      expect(resource.getSnapshot()).toMatchObject({
        data: second,
        error: null,
        status: 'ready',
        isRefreshing: false
      })
    }
  )

  it('retries an unavailable MCP snapshot instead of caching it as an empty list', async () => {
    const unavailable = mcpSnapshot(false)
    const recovered = mcpSnapshot(true, {
      userServers: [
        {
          id: 'local',
          name: 'local',
          enabled: true,
          connected: false,
          authStatus: 'unknown',
          toolCount: 0,
          origin: 'user',
          editable: true,
          canToggle: true,
          transport: 'stdio',
          command: 'local-mcp',
          args: [],
          env: [],
          envVars: []
        }
      ]
    })
    const api = createApi(unavailable)
    vi.mocked(api.getSnapshot)
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: unavailable })
      .mockResolvedValueOnce({ version: PLUGIN_CENTER_API_VERSION, snapshot: recovered })
    const resource = getPluginCenterSupplementalResource(api, 'mcp', '/repo')

    await resource.prefetch()

    expect(api.getSnapshot).toHaveBeenCalledTimes(2)
    expect(api.getSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sections: ['mcp'], forceRefresh: true }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(resource.getSnapshot()).toMatchObject({
      status: 'ready',
      error: null,
      data: { mcp: { userServers: [{ id: 'local' }] } }
    })
  })

  it('reports an unavailable MCP snapshot as an error instead of a valid empty list', async () => {
    const unavailable = mcpSnapshot(false, { message: 'MCP 暂时不可用' })
    const api = createApi(unavailable)
    const resource = getPluginCenterSupplementalResource(api, 'mcp', '/repo')

    await resource.prefetch()

    expect(resource.getSnapshot()).toMatchObject({
      data: null,
      status: 'error',
      error: 'MCP 暂时不可用'
    })
  })

  it('shares supplemental data by cwd without a thread-scoped MCP cache', async () => {
    const api = createApi()

    const resource = getPluginCenterSupplementalResource(api, 'mcp', '/repo')
    expect(resource).toBe(getPluginCenterSupplementalResource(api, 'mcp', '/repo/'))

    await resource.prefetch()

    expect(api.getSnapshot).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        sections: ['mcp'],
        includePluginDetails: false,
        forceRefresh: false
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('uses a separate, filtered resource for managed skills', async () => {
    const api = createApi()
    const browseResource = getPluginCenterSupplementalResource(api, 'skills', '/repo')
    const managedResource = getPluginCenterSupplementalResource(api, 'skills', '/repo', 'manage')

    expect(managedResource).not.toBe(browseResource)

    await managedResource.prefetch()

    expect(api.getSnapshot).toHaveBeenCalledWith(
      {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        sections: ['skills'],
        includePluginDetails: false,
        skillListMode: 'manage',
        forceRefresh: false
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('prefetches catalog and installed state together and keeps both subscribed', async () => {
    const api = createApi()
    const listener = vi.fn()
    const unsubscribe = subscribePluginCenterData(api, '/repo', listener)

    await prefetchPluginCenterData(api, '/repo')

    expect(api.getSnapshot).toHaveBeenCalledTimes(1)
    expect(api.getInstalledPlugins).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('evicts cwd resources beyond the three most recent cwd keys', () => {
    const api = createApi()
    const first = getPluginCenterCatalogResource(api, '/repo-a')
    getPluginCenterCatalogResource(api, '/repo-b')
    getPluginCenterCatalogResource(api, '/repo-c')
    getPluginCenterCatalogResource(api, '/repo-d')

    expect(getPluginCenterCatalogResource(api, '/repo-a')).not.toBe(first)
  })

  it('garbage collects a resource five minutes after its last subscriber leaves', () => {
    const api = createApi()
    const first = getPluginCenterCatalogResource(api, '/repo')
    const unsubscribe = first.subscribe(vi.fn())

    unsubscribe()
    vi.advanceTimersByTime(5 * 60 * 1_000)

    expect(getPluginCenterCatalogResource(api, '/repo')).not.toBe(first)
  })

  it('garbage collects a resource that was never subscribed', () => {
    const api = createApi()
    const first = getPluginCenterCatalogResource(api, '/repo-never-subscribed')

    vi.advanceTimersByTime(5 * 60 * 1_000)

    expect(getPluginCenterCatalogResource(api, '/repo-never-subscribed')).not.toBe(first)
  })

  it('merges installed state over catalog data and appends installed-only plugins', () => {
    const installed = {
      ...githubPlugin,
      installed: true,
      enabled: true,
      canInstall: false,
      canToggle: false,
      canUninstall: false
    }
    const localOnly = {
      ...githubPlugin,
      id: 'plugin:local-only',
      name: 'local-only',
      displayName: 'Local Only',
      installed: true,
      enabled: true
    }

    expect(mergePluginCatalogWithInstalled([githubPlugin], [installed, localOnly])).toEqual([
      {
        ...githubPlugin,
        installed: true,
        enabled: true,
        canInstall: false,
        canToggle: false,
        canUninstall: false,
        restriction: undefined
      },
      {
        ...localOnly,
        restriction: {
          code: 'unavailable',
          message: '所属插件市场当前不可用'
        }
      }
    ])
  })

  it('clears stale catalog installation flags when installed state is empty', () => {
    const staleInstalledCatalogPlugin = {
      ...githubPlugin,
      installed: true,
      enabled: true,
      canInstall: false,
      canToggle: true,
      canUninstall: true
    }

    expect(mergePluginCatalogWithInstalled([staleInstalledCatalogPlugin], [])).toEqual([
      {
        ...staleInstalledCatalogPlugin,
        installed: false,
        enabled: false,
        canInstall: true,
        canToggle: false,
        canUninstall: false
      }
    ])
  })

  it('sorts installed plugins by installation time before applying the reference grouping', () => {
    const notion = {
      ...githubPlugin,
      id: 'notion@openai-curated-remote',
      name: 'notion',
      displayName: 'Notion',
      marketplaceId: 'personal-marketplace',
      marketplaceName: 'Personal marketplace',
      installed: true,
      enabled: true,
      installedAt: 200
    }
    const atlassianRovo = {
      ...notion,
      id: 'atlassian-rovo@openai-curated-remote',
      name: 'atlassian-rovo',
      displayName: 'Atlassian Rovo',
      installedAt: 300
    }
    const bundled = {
      ...notion,
      id: 'plugin:bundled',
      name: 'bundled',
      installedAt: 500,
      marketplaceId: 'openai-bundled',
      marketplaceName: 'openai-bundled'
    }
    const primaryRuntime = {
      ...notion,
      id: 'plugin:primary-runtime',
      name: 'primary-runtime',
      installedAt: 400,
      marketplaceId: 'openai-primary-runtime',
      marketplaceName: 'openai-primary-runtime'
    }
    const adminDisabled = {
      ...notion,
      id: 'plugin:admin-disabled',
      name: 'admin-disabled',
      installedAt: 600,
      restriction: {
        code: 'policy' as const,
        message: '此插件已被管理员禁用'
      }
    }
    const installedOnly = {
      ...notion,
      id: 'plugin:installed-only',
      name: 'installed-only',
      installedAt: 100
    }

    const result = mergeInstalledPluginsForDisplay(
      [bundled, adminDisabled, notion, atlassianRovo, primaryRuntime],
      [atlassianRovo, bundled, adminDisabled, notion, primaryRuntime, notion, installedOnly]
    )

    expect(result).toHaveLength(6)
    expect(result.map((plugin) => plugin.id)).toEqual([
      'atlassian-rovo@openai-curated-remote',
      'notion@openai-curated-remote',
      'plugin:installed-only',
      'plugin:bundled',
      'plugin:primary-runtime',
      'plugin:admin-disabled'
    ])
  })

  it('uses installed-list order as the stable fallback when installation times tie', () => {
    const first = {
      ...githubPlugin,
      id: 'plugin:first',
      name: 'first',
      displayName: 'First',
      installed: true,
      enabled: true
    }
    const second = {
      ...first,
      id: 'plugin:second',
      name: 'second',
      displayName: 'Second'
    }
    const third = {
      ...first,
      id: 'plugin:third',
      name: 'third',
      displayName: 'Third'
    }

    const result = mergeInstalledPluginsForDisplay([third, first, second], [first, second, third])

    expect(result.map((plugin) => plugin.id)).toEqual([
      'plugin:first',
      'plugin:second',
      'plugin:third'
    ])
  })

  it('matches the reference installed-plugin sequence without hard-coded remote hiding', () => {
    const installedPlugin = ({
      id,
      name,
      displayName,
      marketplaceId,
      installedAt
    }: {
      id: string
      name: string
      displayName: string
      marketplaceId: string
      installedAt?: number
    }): PluginCenterPlugin => ({
      ...githubPlugin,
      id,
      name,
      displayName,
      marketplaceId,
      marketplaceName: marketplaceId,
      installed: true,
      enabled: true,
      ...(installedAt !== undefined ? { installedAt } : {})
    })
    const remoteMarketplace = 'openai-curated-remote'
    const remote = [
      installedPlugin({
        id: `gmail@${remoteMarketplace}`,
        name: 'gmail',
        displayName: 'Gmail',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_062_387
      }),
      installedPlugin({
        id: `notion@${remoteMarketplace}`,
        name: 'notion',
        displayName: 'Notion',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_008_087
      }),
      installedPlugin({
        id: `google-calendar@${remoteMarketplace}`,
        name: 'google-calendar',
        displayName: 'Google Calendar',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_002_069
      }),
      installedPlugin({
        id: `granola@${remoteMarketplace}`,
        name: 'granola',
        displayName: 'Granola',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_002_051
      }),
      installedPlugin({
        id: `atlassian-rovo@${remoteMarketplace}`,
        name: 'atlassian-rovo',
        displayName: 'Atlassian Rovo',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_001_985
      }),
      installedPlugin({
        id: `teams@${remoteMarketplace}`,
        name: 'teams',
        displayName: 'Teams',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_001_957
      }),
      installedPlugin({
        id: `canva@${remoteMarketplace}`,
        name: 'canva',
        displayName: 'Canva',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_001_264
      }),
      installedPlugin({
        id: `outlook-email@${remoteMarketplace}`,
        name: 'outlook-email',
        displayName: 'Outlook Email',
        marketplaceId: remoteMarketplace,
        installedAt: 1_788_001_245
      }),
      installedPlugin({
        id: `google-drive@${remoteMarketplace}`,
        name: 'google-drive',
        displayName: 'Google Drive',
        marketplaceId: remoteMarketplace,
        installedAt: 1_787_722_519
      }),
      installedPlugin({
        id: `codex-security@${remoteMarketplace}`,
        name: 'codex-security',
        displayName: 'Codex Security',
        marketplaceId: remoteMarketplace,
        installedAt: 1_786_528_283
      }),
      installedPlugin({
        id: `slack@${remoteMarketplace}`,
        name: 'slack',
        displayName: 'Slack',
        marketplaceId: remoteMarketplace,
        installedAt: 1_782_811_708
      })
    ]
    const builtIn = [
      ['documents', 'Documents', 'openai-primary-runtime'],
      ['pdf', 'PDF', 'openai-primary-runtime'],
      ['spreadsheets', 'Spreadsheets', 'openai-primary-runtime'],
      ['presentations', 'Presentations', 'openai-primary-runtime'],
      ['template-creator', 'Template Creator', 'openai-primary-runtime'],
      ['sites', 'Sites', 'openai-bundled'],
      ['visualize', 'Visualize', 'openai-bundled']
    ].map(([name, displayName, marketplaceId]) =>
      installedPlugin({
        id: `${name}@${marketplaceId}`,
        name,
        displayName,
        marketplaceId
      })
    )
    const bundledVisibilityCases = [
      ['codex-app-tools', 'Codex App Tools', 'openai-bundled'],
      ['browser', 'Browser', 'openai-bundled'],
      ['chrome', 'Chrome', 'openai-bundled']
    ].map(([name, displayName, marketplaceId]) =>
      installedPlugin({
        id: `${name}@${marketplaceId}`,
        name,
        displayName,
        marketplaceId
      })
    )
    const visibleRemote = [
      ['github', 'GitHub'],
      ['openai-templates', 'OpenAI Templates'],
      ['plugin-management', 'Plugin Management']
    ].map(([name, displayName]) =>
      installedPlugin({
        id: `${name}@${remoteMarketplace}`,
        name,
        displayName,
        marketplaceId: remoteMarketplace
      })
    )
    const catalog = [
      ...builtIn.slice(0, 5),
      ...bundledVisibilityCases,
      ...builtIn.slice(5),
      ...remote,
      ...visibleRemote
    ]

    const result = mergeInstalledPluginsForDisplay(catalog, [
      ...bundledVisibilityCases,
      ...remote,
      ...visibleRemote,
      ...builtIn
    ])

    expect(result.map((plugin) => plugin.displayName)).toEqual([
      'Gmail',
      'Notion',
      'Google Calendar',
      'Granola',
      'Atlassian Rovo',
      'Teams',
      'Canva',
      'Outlook Email',
      'Google Drive',
      'Codex Security',
      'Slack',
      'GitHub',
      'OpenAI Templates',
      'Plugin Management',
      'Browser',
      'Documents',
      'PDF',
      'Spreadsheets',
      'Presentations',
      'Template Creator',
      'Sites',
      'Visualize'
    ])
  })
})
