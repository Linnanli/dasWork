import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DesktopPluginCenterApi,
  PluginCenterInstalledPluginsResult,
  PluginCenterPlugin,
  PluginCenterSnapshot
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import {
  getPluginCenterCatalogResource,
  getPluginCenterInstalledResource,
  getPluginCenterPluginDetailResource,
  getPluginCenterSupplementalResource,
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

function createApi(snapshotResult = snapshot([githubPlugin])): TestPluginCenterApi {
  return {
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
    addMarketplace: vi.fn(),
    installPlugin: vi.fn(),
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
    expect(api.getSnapshot).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: '/repo',
      sections: ['plugins'],
      includePluginDetails: false,
      forceRefresh: false
    })
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
    expect(api.getPluginDetail).toHaveBeenCalledWith({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: '/repo',
      plugin: { id: 'plugin:github', marketplaceId: 'marketplace:personal' },
      forceRefresh: false
    })
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

  it.each([
    ['skills', 60_001],
    ['apps', 60_001],
    ['mcp', 30_001]
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
      const resource = getPluginCenterSupplementalResource(api, section, '/repo', 'thread-a')

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

  it('keys MCP data by thread while sharing skills and apps across threads', () => {
    const api = createApi()

    expect(getPluginCenterSupplementalResource(api, 'skills', '/repo', 'thread-a')).toBe(
      getPluginCenterSupplementalResource(api, 'skills', '/repo', 'thread-b')
    )
    expect(getPluginCenterSupplementalResource(api, 'apps', '/repo', 'thread-a')).toBe(
      getPluginCenterSupplementalResource(api, 'apps', '/repo', 'thread-b')
    )
    expect(getPluginCenterSupplementalResource(api, 'mcp', '/repo', 'thread-a')).not.toBe(
      getPluginCenterSupplementalResource(api, 'mcp', '/repo', 'thread-b')
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
})
