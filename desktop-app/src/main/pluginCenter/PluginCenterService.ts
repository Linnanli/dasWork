import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_CENTER_API_VERSION,
  PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH,
  pluginCenterAddMarketplaceResultSchema,
  pluginCenterGetPluginDetailResultSchema,
  pluginCenterInstalledPluginsResultSchema,
  pluginCenterMutationResultSchema,
  pluginCenterSnapshotResultSchema,
  type PluginCenterAddMarketplaceRequest,
  type PluginCenterAddMarketplaceResult,
  type PluginCenterApp,
  type PluginCenterChangedSection,
  type PluginCenterGetPluginDetailRequest,
  type PluginCenterGetPluginDetailResult,
  type PluginCenterHttpMcpServer,
  type PluginCenterInstalledPluginsRequest,
  type PluginCenterInstalledPluginsResult,
  type PluginCenterMcpServerInput,
  type PluginCenterMutationResult,
  type PluginCenterPlugin,
  type PluginCenterPluginDetail,
  type PluginCenterPluginMcpServer,
  type PluginCenterRequestContext,
  type PluginCenterSkill,
  type PluginCenterSnapshot,
  type PluginCenterSnapshotSection,
  type PluginCenterSnapshotRequest,
  type PluginCenterSnapshotResult,
  type PluginCenterStdioMcpServer,
  type PluginCenterUpsertMcpServerRequest
} from '../../shared/pluginCenterApi'
import { toAppMediaUrl } from '../localMediaProtocol'

type JsonRecord = Record<string, unknown>

/**
 * A deliberately narrow view of the provider client.  The renderer never gets
 * this object, raw config, config paths, or arbitrary JSON-RPC access.
 */
export type PluginCenterProvider = {
  listPluginCatalog(input: { cwd?: string; forceRefetch?: boolean }): Promise<unknown>
  listInstalledPluginsForManagement?(input: { cwd?: string }): Promise<unknown>
  readPluginDetailsForManagement?(input: { cwd?: string; forceRefetch?: boolean }): Promise<unknown>
  readPluginDetailForManagement?(input: {
    marketplacePath?: string
    remoteMarketplaceName?: string
    pluginName: string
  }): Promise<unknown>
  listSkillsForManagement(input: { cwd?: string; forceReload?: boolean }): Promise<unknown>
  readAppsForManagement?(input: { appIds: string[] }): Promise<unknown>
  listAppsForManagement(input?: { forceRefetch?: boolean }): Promise<unknown>
  readMcpManagementSnapshot(input: { cwd?: string; threadId?: string }): Promise<unknown>
  installPlugin(input: {
    marketplacePath?: string | null
    remoteMarketplaceName?: string | null
    installAttemptId?: string | null
    pluginName: string
  }): Promise<unknown>
  uninstallPlugin(input: { pluginId: string }): Promise<unknown>
  setPluginEnabled(input: { cwd?: string; pluginId: string; enabled: boolean }): Promise<unknown>
  setSkillEnabled(input: {
    path?: string | null
    name?: string | null
    enabled: boolean
  }): Promise<unknown>
  setAppEnabled(input: { cwd?: string; appId: string; enabled: boolean }): Promise<unknown>
  setMcpServerEnabled(input: {
    cwd?: string
    serverName: string
    enabled: boolean
  }): Promise<unknown>
  upsertMcpServer(input: { cwd?: string; serverName: string; value: unknown }): Promise<unknown>
  removeMcpServer(input: { cwd?: string; serverName: string }): Promise<unknown>
  addMarketplace(input: {
    source: string
    refName?: string
    sparsePaths?: string[]
  }): Promise<unknown>
}

type McpRawSnapshot = {
  config: JsonRecord
  userConfig: JsonRecord
  origins: JsonRecord
  servers: unknown[]
  pluginDetails: unknown[]
}

type SnapshotCapability = NonNullable<PluginCenterSnapshot['capabilities']>[keyof NonNullable<
  PluginCenterSnapshot['capabilities']
>]

type SafeResult<T> =
  | { ok: true; value: T }
  | { ok: false; restriction: SnapshotCapability['restriction'] }

type PluginCenterPerformanceLogger = (
  event: string,
  details: Record<string, string | number | boolean | undefined>
) => void

type SnapshotReadName =
  | 'plugin/list'
  | 'plugin/installed'
  | 'plugin-details'
  | 'skills/list'
  | 'app/list'
  | 'mcp'
type CachedReadName = 'catalog' | 'installed'

type SharedCacheEntry<T> = {
  key: string
  freshUntil: number
  gcAt: number
  promise: Promise<T>
  pending: boolean
  value?: T
}

type CacheFreshness<T> = number | ((value: T) => number)

type PluginCatalogCacheValue = {
  catalog: unknown
  degraded: boolean
  lastCompleteCatalog?: unknown
}

type PluginLocator = {
  plugin: JsonRecord
  marketplace: JsonRecord
  pluginName: string
  marketplaceName: string
  marketplacePath?: string
  remoteMarketplaceName?: string
}

type PluginLocatorResult =
  | { status: 'ready'; locator: PluginLocator }
  | { status: 'missing'; missingReason: 'not_found' | 'ambiguous' }

const ALL_SNAPSHOT_SECTIONS: PluginCenterSnapshotSection[] = ['plugins', 'skills', 'apps', 'mcp']
const CATALOG_CACHE_FRESH_MS = 6 * 60 * 60 * 1_000
const INSTALLED_CACHE_FRESH_MS = 60_000
const SHARED_CACHE_GC_MS = 5 * 60_000
const MAX_CATALOG_CWD_KEYS = 3
const REMOTE_PLUGIN_MARKETPLACE_NAME = 'openai-curated-remote'
const LEGACY_REMOTE_PLUGIN_MARKETPLACE_NAME = 'openai-curated'
const OFFICIAL_LOCAL_MARKETPLACE_NAMES = new Set(['openai-primary-runtime', 'openai-bundled'])
const REMOTE_CATALOG_FALLBACK_MESSAGE =
  '远程插件市场暂时不可用，正在显示最近一次成功加载的目录。请稍后刷新重试。'
const REMOTE_CATALOG_LOCAL_ONLY_MESSAGE =
  '远程插件市场暂时不可用，当前仅显示本地插件。请稍后刷新重试。'

/**
 * Translates the app-server catalog into the safe, product-facing Plugin
 * Center DTO.  Mutations are serialized per target so a double click cannot
 * win a race against its own readback.
 */
export class PluginCenterService {
  private readonly mutationQueues = new Map<string, Promise<unknown>>()
  private readonly pluginDetailCache = new Map<
    string,
    { expiresAt: number; promise: Promise<unknown[]> }
  >()
  private readonly singlePluginDetailCache = new Map<
    string,
    { expiresAt: number; promise: Promise<PluginCenterPluginDetail> }
  >()
  private readonly catalogCache = new Map<string, SharedCacheEntry<PluginCatalogCacheValue>>()
  private readonly installedCache = new Map<string, SharedCacheEntry<PluginCenterPlugin[]>>()
  private snapshotRequestSequence = 0

  constructor(
    private readonly dependencies: {
      provider: PluginCenterProvider
      defaultCwd: () => string | undefined
      now?: () => Date
      nowMs?: () => number
      logger?: PluginCenterPerformanceLogger
    }
  ) {}

  async getSnapshot(input: PluginCenterSnapshotRequest): Promise<PluginCenterSnapshotResult> {
    const requestId = ++this.snapshotRequestSequence
    const snapshotStartedAt = this.nowMs()
    const cwd = this.cwdFor(input)
    const sections = new Set(input.sections ?? ALL_SNAPSHOT_SECTIONS)
    const includePlugins = sections.has('plugins')
    const includeSkills = sections.has('skills')
    const includeApps = sections.has('apps')
    const includeMcp = sections.has('mcp')
    const includePluginDetails =
      input.includePluginDetails ?? (input.sections === undefined || includeSkills)
    this.logPerformance('snapshot:start', {
      requestId,
      sections: [...sections].join(','),
      includePluginDetails,
      forceRefresh: input.forceRefresh === true,
      hasCwd: Boolean(cwd),
      hasThreadId: Boolean(input.threadId)
    })
    const [
      catalogResult,
      installedResult,
      catalogPluginDetails,
      skillsResult,
      appsResult,
      mcpResult
    ] = await Promise.all([
      includePlugins
        ? this.readSnapshotSection(requestId, 'plugin/list', () =>
            this.readPluginCatalog(cwd, input.forceRefresh === true, requestId)
          )
        : Promise.resolve({ ok: true, value: {} } satisfies SafeResult<unknown>),
      includePlugins
        ? this.readSnapshotSection(requestId, 'plugin/installed', () =>
            this.readInstalledPlugins(cwd, input.forceRefresh === true, requestId)
          )
        : Promise.resolve({ ok: true, value: [] } satisfies SafeResult<PluginCenterPlugin[]>),
      includePluginDetails && this.dependencies.provider.readPluginDetailsForManagement
        ? this.readSnapshotSection(requestId, 'plugin-details', () =>
            this.readCachedPluginDetails(cwd, input.forceRefresh, requestId)
          )
        : Promise.resolve({ ok: true, value: [] } satisfies SafeResult<unknown[]>),
      includeSkills
        ? this.readSnapshotSection(requestId, 'skills/list', () =>
            this.dependencies.provider.listSkillsForManagement({
              cwd,
              forceReload: input.forceRefresh
            })
          )
        : Promise.resolve({ ok: true, value: [] } satisfies SafeResult<unknown>),
      includeApps
        ? this.readSnapshotSection(requestId, 'app/list', () =>
            this.dependencies.provider.listAppsForManagement({ forceRefetch: input.forceRefresh })
          )
        : Promise.resolve({ ok: true, value: [] } satisfies SafeResult<unknown>),
      includeMcp
        ? this.readSnapshotSection(requestId, 'mcp', () =>
            this.dependencies.provider.readMcpManagementSnapshot({
              cwd,
              threadId: input.threadId
            })
          )
        : Promise.resolve({ ok: true, value: {} } satisfies SafeResult<unknown>)
    ])
    const catalog = catalogResult.ok ? objectValue(catalogResult.value) : {}
    const mcp = mcpResult.ok
      ? normalizeMcpSnapshot(mcpResult.value)
      : { config: {}, userConfig: {}, origins: {}, servers: [], pluginDetails: [] }
    const pluginDetails = [
      ...arrayValue(catalogResult.ok && catalogPluginDetails.ok ? catalogPluginDetails.value : []),
      ...mcp.pluginDetails
    ]
    const plugins = mergePluginsWithInstalled(
      normalizePlugins(catalog, pluginDetails),
      installedResult.ok ? installedResult.value : []
    )
    let catalogUnavailableMessage: string | undefined
    if (includePlugins) {
      catalogUnavailableMessage =
        !catalogResult.ok || !catalogPluginDetails.ok
          ? '插件目录暂时不可用'
          : catalogUnavailableReason(catalog)
    }
    const snapshot: PluginCenterSnapshot = {
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      plugins,
      skills: normalizeSkills(skillsResult.ok ? skillsResult.value : [], pluginDetails, plugins),
      apps: normalizeApps(appsResult.ok ? appsResult.value : []),
      mcp: normalizeMcpForUi(mcp),
      marketplaces: normalizeMarketplaces(catalog),
      capabilities: {
        plugins: capabilityFor(catalogResult, catalogPluginDetails),
        skills: capabilityFor(skillsResult),
        apps: capabilityFor(appsResult),
        mcp: capabilityFor(mcpResult)
      },
      ...(catalogUnavailableMessage ? { catalogUnavailableReason: catalogUnavailableMessage } : {})
    }
    const result = pluginCenterSnapshotResultSchema.parse({
      version: PLUGIN_CENTER_API_VERSION,
      snapshot
    })
    this.logPerformance('snapshot:complete', {
      requestId,
      durationMs: this.nowMs() - snapshotStartedAt,
      pluginCount: snapshot.plugins.length,
      skillCount: snapshot.skills.length,
      appCount: snapshot.apps.length,
      mcpServerCount: snapshot.mcp.userServers.length + snapshot.mcp.pluginServers.length
    })
    return result
  }

  async getInstalledPlugins(
    input: PluginCenterInstalledPluginsRequest
  ): Promise<PluginCenterInstalledPluginsResult> {
    const requestId = ++this.snapshotRequestSequence
    const cwd = this.cwdFor(input)
    this.logPerformance('installed:start', {
      requestId,
      hasCwd: Boolean(cwd)
    })
    const plugins = await this.readInstalledPlugins(cwd, false, requestId)
    const result = pluginCenterInstalledPluginsResultSchema.parse({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      plugins
    })
    this.logPerformance('installed:complete', {
      requestId,
      pluginCount: plugins.length
    })
    return result
  }

  async getPluginDetail(
    input: PluginCenterGetPluginDetailRequest
  ): Promise<PluginCenterGetPluginDetailResult> {
    const cwd = this.cwdFor(input)
    const located = await this.resolvePluginLocator(input)
    if (located.status === 'missing') {
      return pluginCenterGetPluginDetailResultSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'missing',
        missingReason: located.missingReason
      })
    }
    if (!this.dependencies.provider.readPluginDetailForManagement) {
      throw new Error('当前 Codex app server 不支持读取插件详情')
    }

    const key = pluginDetailCacheKey(cwd, input.plugin.id, input.plugin.marketplaceId)
    const now = this.nowMs()
    const cached = this.singlePluginDetailCache.get(key)
    let detailPromise: Promise<PluginCenterPluginDetail>
    if (!input.forceRefresh && cached && cached.expiresAt > now) {
      detailPromise = cached.promise
    } else {
      detailPromise = this.dependencies.provider
        .readPluginDetailForManagement({
          ...(located.locator.marketplacePath
            ? { marketplacePath: located.locator.marketplacePath }
            : {}),
          ...(located.locator.remoteMarketplaceName
            ? { remoteMarketplaceName: located.locator.remoteMarketplaceName }
            : {}),
          pluginName: located.locator.pluginName
        })
        .then(async (rawDetail) => {
          const appIds = arrayValue(objectValue(rawDetail).apps)
            .map((app) => stringValue(objectValue(app).id))
            .filter(Boolean)
          const provider = this.dependencies.provider
          const readAppsForManagement = provider.readAppsForManagement
          const installedPluginsPromise = safeRead(() =>
            this.readInstalledPlugins(
              cwd,
              input.forceRefresh === true,
              ++this.snapshotRequestSequence
            )
          )
          const readAppsPromise =
            readAppsForManagement && appIds.length > 0
              ? safeRead(() => readAppsForManagement.call(provider, { appIds }))
              : Promise.resolve(null)
          const [directoryAppsResult, readAppsResult, skillsResult, installedPluginsResult] =
            await Promise.all([
              safeRead(() =>
                this.dependencies.provider.listAppsForManagement({
                  forceRefetch: input.forceRefresh
                })
              ),
              readAppsPromise,
              safeRead(() =>
                this.dependencies.provider.listSkillsForManagement({
                  ...(cwd ? { cwd } : {}),
                  forceReload: input.forceRefresh
                })
              ),
              installedPluginsPromise
            ])
          const directoryApps = directoryAppsResult.ok ? directoryAppsResult.value : []
          const installedPlugin = installedPluginsResult.ok
            ? installedPluginsResult.value.find((plugin) => plugin.id === located.locator.plugin.id)
            : undefined
          return normalizePluginDetail(
            located.locator,
            rawDetail,
            readAppsResult?.ok ? readAppsResult.value : [],
            directoryApps,
            skillsResult.ok ? skillsResult.value : null,
            installedPlugin
          )
        })
      this.singlePluginDetailCache.set(key, { expiresAt: now + 30_000, promise: detailPromise })
      void detailPromise.catch(() => this.singlePluginDetailCache.delete(key))
    }

    return pluginCenterGetPluginDetailResultSchema.parse({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'ready',
      detail: await detailPromise
    })
  }

  prefetch(input: PluginCenterSnapshotRequest): void {
    const requestId = ++this.snapshotRequestSequence
    const cwd = this.cwdFor(input)
    this.logPerformance('prefetch:start', {
      requestId,
      sections: (input.sections ?? ['plugins']).join(','),
      hasCwd: Boolean(cwd)
    })
    void this.getSnapshot({
      ...input,
      sections: input.sections ?? ['plugins'],
      includePluginDetails: input.includePluginDetails ?? false,
      forceRefresh: false
    })
      .then((result) => {
        this.logPerformance('prefetch:complete', {
          requestId,
          status: 'ok',
          pluginCount: result.snapshot.plugins.length
        })
      })
      .catch(() => {
        this.logPerformance('prefetch:complete', { requestId, status: 'error' })
      })
  }

  private async readPluginCatalog(
    cwd: string | undefined,
    forceRefresh: boolean,
    requestId: number
  ): Promise<unknown> {
    const key = cacheKeyForCwd(cwd)
    const lastCompleteCatalog = this.catalogCache.get(key)?.value?.lastCompleteCatalog
    const cached = await this.readSharedCache({
      requestId,
      cache: this.catalogCache,
      kind: 'catalog',
      cwd,
      forceRefresh,
      freshForMs: (value) => (value.degraded ? 0 : CATALOG_CACHE_FRESH_MS),
      read: async (): Promise<PluginCatalogCacheValue> => {
        let catalog: unknown
        try {
          catalog = await this.dependencies.provider.listPluginCatalog({
            cwd,
            forceRefetch: forceRefresh ? true : undefined
          })
        } catch (error) {
          if (lastCompleteCatalog === undefined) throw error
          this.logPerformance('catalog:degraded', {
            requestId,
            reason: 'provider-error',
            hasFallback: true
          })
          return degradedCatalogValue(lastCompleteCatalog, lastCompleteCatalog)
        }

        if (!isRemoteCatalogDegraded(catalog)) {
          return { catalog, degraded: false, lastCompleteCatalog: catalog }
        }

        this.logPerformance('catalog:degraded', {
          requestId,
          reason: 'remote-marketplace-missing',
          hasFallback: lastCompleteCatalog !== undefined
        })
        return degradedCatalogValue(catalog, lastCompleteCatalog)
      }
    })
    return cached.catalog
  }

  private async readInstalledPlugins(
    cwd: string | undefined,
    forceRefresh: boolean,
    requestId: number
  ): Promise<PluginCenterPlugin[]> {
    return this.readSharedCache({
      requestId,
      cache: this.installedCache,
      kind: 'installed',
      cwd,
      forceRefresh,
      freshForMs: INSTALLED_CACHE_FRESH_MS,
      read: async () => {
        const raw = this.dependencies.provider.listInstalledPluginsForManagement
          ? await this.dependencies.provider.listInstalledPluginsForManagement({ cwd })
          : await this.readPluginCatalog(cwd, forceRefresh, requestId)
        return normalizePlugins(objectValue(raw), [])
          .filter((plugin) => plugin.installed)
          .map((plugin) => ({
            ...plugin,
            installed: true,
            canInstall: false,
            canUninstall: true,
            canToggle: true
          }))
      }
    })
  }

  private readSharedCache<T>({
    requestId,
    cache,
    kind,
    cwd,
    forceRefresh,
    freshForMs,
    read
  }: {
    requestId: number
    cache: Map<string, SharedCacheEntry<T>>
    kind: CachedReadName
    cwd: string | undefined
    forceRefresh: boolean
    freshForMs: CacheFreshness<T>
    read: () => Promise<T>
  }): Promise<T> {
    const key = cacheKeyForCwd(cwd)
    const now = this.nowMs()
    this.gcSharedCache(cache, now)
    const cached = cache.get(key)
    if (!forceRefresh && cached) {
      cached.gcAt = now + SHARED_CACHE_GC_MS
      if (cached.freshUntil > now) {
        this.logPerformance('cache:hit', {
          requestId,
          kind,
          status: 'fresh',
          cacheStatus: 'fresh',
          providerCallCount: 0,
          key: cacheLogKey(key)
        })
        return cached.promise
      }
      this.logPerformance('cache:hit', {
        requestId,
        kind,
        status: 'stale',
        cacheStatus: 'stale',
        providerCallCount: 0,
        key: cacheLogKey(key)
      })
      if (cached.pending) {
        this.logPerformance('cache:join-inflight', {
          requestId,
          kind,
          cacheStatus: 'inflight-joined',
          providerCallCount: 0,
          key: cacheLogKey(key)
        })
        return cached.promise
      }
      if (cached.value !== undefined) {
        return this.refreshSharedCache(cache, cached, freshForMs, read, requestId, kind)
      }
      return cached.promise
    }
    if (cached?.pending && forceRefresh) {
      this.logPerformance('cache:join-inflight', {
        requestId,
        kind,
        cacheStatus: 'inflight-joined',
        providerCallCount: 0,
        key: cacheLogKey(key)
      })
      return cached.promise
    }
    this.logPerformance('cache:miss', {
      requestId,
      kind,
      key: cacheLogKey(key),
      forceRefresh,
      cacheStatus: 'miss',
      providerCallCount: 1
    })
    const entry: SharedCacheEntry<T> = {
      key,
      freshUntil: Number.POSITIVE_INFINITY,
      gcAt: now + SHARED_CACHE_GC_MS,
      promise: read(),
      pending: true
    }
    entry.promise = entry.promise
      .then((value) => {
        entry.value = value
        entry.pending = false
        entry.freshUntil = this.nowMs() + resolveCacheFreshness(freshForMs, value)
        entry.gcAt = this.nowMs() + SHARED_CACHE_GC_MS
        return value
      })
      .catch((error) => {
        if (cache.get(key) === entry) cache.delete(key)
        throw error
      })
    cache.set(key, entry)
    this.trimCatalogCwdKeys()
    this.trimInstalledCwdKeys()
    return entry.promise
  }

  private refreshSharedCache<T>(
    cache: Map<string, SharedCacheEntry<T>>,
    entry: SharedCacheEntry<T>,
    freshForMs: CacheFreshness<T>,
    read: () => Promise<T>,
    requestId: number,
    kind: CachedReadName
  ): Promise<T> {
    if (entry.pending) return entry.promise
    this.logPerformance('cache:revalidate', {
      requestId,
      kind,
      cacheStatus: 'stale',
      providerCallCount: 1,
      key: cacheLogKey(entry.key)
    })
    entry.pending = true
    entry.promise = read()
      .then((value) => {
        entry.value = value
        entry.pending = false
        entry.freshUntil = this.nowMs() + resolveCacheFreshness(freshForMs, value)
        entry.gcAt = this.nowMs() + SHARED_CACHE_GC_MS
        return value
      })
      .catch((error) => {
        entry.pending = false
        if (entry.value === undefined && cache.get(entry.key) === entry) cache.delete(entry.key)
        throw error
      })
    entry.promise.catch(() => undefined)
    return entry.promise
  }

  private gcSharedCache<T>(cache: Map<string, SharedCacheEntry<T>>, now: number): void {
    for (const [key, entry] of cache) {
      if (entry.gcAt <= now && entry.freshUntil <= now) cache.delete(key)
    }
  }

  private trimCatalogCwdKeys(): void {
    while (this.catalogCache.size > MAX_CATALOG_CWD_KEYS) {
      const oldest = [...this.catalogCache.entries()].sort((a, b) => a[1].gcAt - b[1].gcAt)[0]
      if (!oldest) return
      this.catalogCache.delete(oldest[0])
      this.installedCache.delete(oldest[0])
    }
  }

  private trimInstalledCwdKeys(): void {
    while (this.installedCache.size > MAX_CATALOG_CWD_KEYS) {
      const oldest = [...this.installedCache.entries()].sort((a, b) => a[1].gcAt - b[1].gcAt)[0]
      if (!oldest) return
      this.installedCache.delete(oldest[0])
    }
  }

  private readCachedPluginDetails(
    cwd: string | undefined,
    forceRefetch: boolean | undefined,
    requestId: number
  ): Promise<unknown[]> {
    const key = cwd ?? ''
    const now = Date.now()
    const cached = this.pluginDetailCache.get(key)
    if (!forceRefetch && cached && cached.expiresAt > now) {
      this.logPerformance('plugin-details-cache', { requestId, hit: true })
      return cached.promise
    }
    this.logPerformance('plugin-details-cache', { requestId, hit: false })
    const promise =
      this.dependencies.provider
        .readPluginDetailsForManagement?.({
          cwd,
          forceRefetch
        })
        .then(arrayValue) ?? Promise.resolve([])
    this.pluginDetailCache.set(key, { expiresAt: now + 30_000, promise })
    void promise.catch(() => this.pluginDetailCache.delete(key))
    return promise
  }

  private async readSnapshotSection<T>(
    requestId: number,
    name: SnapshotReadName,
    read: () => Promise<T>
  ): Promise<SafeResult<T>> {
    const startedAt = this.nowMs()
    const result = await safeRead(read)
    this.logPerformance('snapshot:section', {
      requestId,
      name,
      durationMs: this.nowMs() - startedAt,
      status: result.ok ? 'ok' : 'error'
    })
    return result
  }

  private nowMs(): number {
    return (this.dependencies.nowMs ?? Date.now)()
  }

  private logPerformance(
    event: string,
    details: Record<string, string | number | boolean | undefined>
  ): void {
    this.dependencies.logger?.(event, details)
  }

  async installPlugin(
    input: PluginCenterRequestContext & { plugin: { id: string; marketplaceId?: string } }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`plugin:${input.plugin.id}`, async () => {
      const locator = await this.findPluginLocator(input)
      await this.dependencies.provider.installPlugin({
        ...(locator.marketplacePath ? { marketplacePath: locator.marketplacePath } : {}),
        ...(locator.remoteMarketplaceName
          ? { remoteMarketplaceName: locator.remoteMarketplaceName }
          : {}),
        installAttemptId: crypto.randomUUID(),
        pluginName: locator.pluginName
      })
      return this.successWithInstalledState(input, input.plugin.id, undefined, (plugins) =>
        plugins.some((plugin) => plugin.id === input.plugin.id && plugin.installed)
      )
    })
  }

  async uninstallPlugin(
    input: PluginCenterRequestContext & { plugin: { id: string } }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`plugin:${input.plugin.id}`, async () => {
      await this.dependencies.provider.uninstallPlugin({ pluginId: input.plugin.id })
      return this.successWithInstalledState(
        input,
        input.plugin.id,
        undefined,
        (plugins) => !plugins.some((plugin) => plugin.id === input.plugin.id && plugin.installed)
      )
    })
  }

  async setPluginEnabled(
    input: PluginCenterRequestContext & { plugin: { id: string }; enabled: boolean }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`plugin:${input.plugin.id}`, async () => {
      const write = await this.dependencies.provider.setPluginEnabled({
        cwd: this.cwdFor(input),
        pluginId: input.plugin.id,
        enabled: input.enabled
      })
      return this.successWithInstalledState(input, input.plugin.id, write, (plugins) =>
        plugins.some((plugin) => plugin.id === input.plugin.id && plugin.enabled === input.enabled)
      )
    })
  }

  async setSkillEnabled(
    input: PluginCenterRequestContext & { skill: { id: string }; enabled: boolean }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`skill:${input.skill.id}`, async () => {
      const snapshot = await this.getSnapshot({
        ...input,
        forceRefresh: false,
        sections: ['skills'],
        includePluginDetails: false
      })
      const skill = snapshot.snapshot.skills.find((candidate) => candidate.id === input.skill.id)
      if (!skill) throw new Error('Skill is no longer available')
      await this.dependencies.provider.setSkillEnabled({
        ...(skill.id.startsWith('/') ? { path: skill.id } : { name: skill.name }),
        enabled: input.enabled
      })
      return this.successWithSnapshot(input, input.skill.id, ['skills'], undefined, (snapshot) =>
        snapshot.skills.some(
          (candidate) => candidate.id === input.skill.id && candidate.enabled === input.enabled
        )
      )
    })
  }

  async setAppEnabled(
    input: PluginCenterRequestContext & { app: { id: string }; enabled: boolean }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`app:${input.app.id}`, async () => {
      const write = await this.dependencies.provider.setAppEnabled({
        cwd: this.cwdFor(input),
        appId: input.app.id,
        enabled: input.enabled
      })
      return this.successWithSnapshot(input, input.app.id, ['apps'], write, (snapshot) =>
        snapshot.apps.some((app) => app.id === input.app.id && app.enabled === input.enabled)
      )
    })
  }

  async setMcpServerEnabled(
    input: PluginCenterRequestContext & { server: { id: string }; enabled: boolean }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`mcp:${input.server.id}`, async () => {
      const snapshot = await this.getSnapshot({
        ...input,
        forceRefresh: false,
        sections: ['mcp'],
        includePluginDetails: false
      })
      if (
        !snapshot.snapshot.mcp.userServers.some(
          (server) => server.id === input.server.id && server.editable
        )
      ) {
        throw new Error('Only user-configured MCP servers can be changed here')
      }
      const write = await this.dependencies.provider.setMcpServerEnabled({
        cwd: this.cwdFor(input),
        serverName: input.server.id,
        enabled: input.enabled
      })
      return this.successWithSnapshot(input, input.server.id, ['mcp'], write, (snapshot) =>
        snapshot.mcp.userServers.some(
          (server) => server.id === input.server.id && server.enabled === input.enabled
        )
      )
    })
  }

  async upsertMcpServer(
    input: PluginCenterUpsertMcpServerRequest
  ): Promise<PluginCenterMutationResult> {
    const key = input.serverId ?? input.displayName ?? 'new-mcp-server'
    return this.queue(`mcp:${key}`, async () => {
      const cwd = this.cwdFor(input)
      const raw = normalizeMcpSnapshot(
        await this.dependencies.provider.readMcpManagementSnapshot({
          cwd,
          threadId: input.threadId
        })
      )
      const existingEntries = mcpConfigEntries(raw.config)
      const userEntries = mcpConfigEntries(raw.userConfig)
      const serverName =
        input.serverId ?? uniqueMcpServerName(input.displayName ?? 'mcp-server', existingEntries)
      const previous = userEntries[serverName]
      if (input.serverId && !previous) {
        if (existingEntries[serverName]) {
          throw new Error('Only user-configured MCP servers can be changed here')
        }
        throw new Error('MCP server is no longer available')
      }
      if (input.serverId && mcpOrigin(raw.origins, serverName, Boolean(previous)) !== 'user') {
        throw new Error('Only user-configured MCP servers can be changed here')
      }
      if (previous && mcpTransport(previous) !== input.server.transport) {
        throw new Error('Existing MCP server transport cannot be changed')
      }
      const value = mergeMcpServerValue(previous, input.server)
      const write = await this.dependencies.provider.upsertMcpServer({ cwd, serverName, value })
      return this.successWithSnapshot(input, serverName, ['mcp'], write, (snapshot) =>
        snapshot.mcp.userServers.some((server) =>
          server.id === serverName ? mcpServerMatchesInput(server, input.server) : false
        )
      )
    })
  }

  async removeMcpServer(
    input: PluginCenterRequestContext & { server: { id: string } }
  ): Promise<PluginCenterMutationResult> {
    return this.queue(`mcp:${input.server.id}`, async () => {
      const snapshot = await this.getSnapshot({
        ...input,
        forceRefresh: false,
        sections: ['mcp'],
        includePluginDetails: false
      })
      if (
        !snapshot.snapshot.mcp.userServers.some(
          (server) => server.id === input.server.id && server.editable
        )
      ) {
        throw new Error('Only user-configured MCP servers can be removed here')
      }
      const write = await this.dependencies.provider.removeMcpServer({
        cwd: this.cwdFor(input),
        serverName: input.server.id
      })
      return this.successWithSnapshot(
        input,
        input.server.id,
        ['mcp'],
        write,
        (snapshot) => !snapshot.mcp.userServers.some((server) => server.id === input.server.id)
      )
    })
  }

  async addMarketplace(
    input: PluginCenterAddMarketplaceRequest
  ): Promise<PluginCenterAddMarketplaceResult> {
    return this.queue(`marketplace:${input.source}`, async () => {
      const response = objectValue(
        await this.dependencies.provider.addMarketplace({
          source: input.source,
          ...(input.refName ? { refName: input.refName } : {}),
          ...(input.sparsePaths.length ? { sparsePaths: input.sparsePaths } : {})
        })
      )
      const marketplaceName = stringValue(response.marketplaceName) || input.source
      const result = {
        version: PLUGIN_CENTER_API_VERSION,
        status: booleanValue(response.alreadyAdded) ? 'unchanged' : 'applied',
        message: booleanValue(response.alreadyAdded) ? '该插件市场已存在' : '插件市场已添加',
        changedSections: ['catalog', 'installed'],
        marketplace: {
          id: marketplaceName,
          name: marketplaceName,
          source: input.source,
          ...(input.refName ? { refName: input.refName } : {}),
          sparsePaths: input.sparsePaths
        },
        alreadyAdded: booleanValue(response.alreadyAdded)
      }
      this.invalidateCatalogCaches()
      this.prefetch({ ...input, sections: ['plugins'], includePluginDetails: false })
      return pluginCenterAddMarketplaceResultSchema.parse(result)
    })
  }

  private invalidateCatalogCaches(): void {
    this.catalogCache.clear()
    this.installedCache.clear()
    this.pluginDetailCache.clear()
    this.singlePluginDetailCache.clear()
  }

  private invalidateInstalledCache(cwd: string | undefined): void {
    this.installedCache.delete(cacheKeyForCwd(cwd))
  }

  private invalidateSinglePluginDetail(cwd: string | undefined, pluginId: string): void {
    const prefix = `${cacheKeyForCwd(cwd)}\u0000${pluginId}\u0000`
    for (const key of this.singlePluginDetailCache.keys()) {
      if (key.startsWith(prefix)) this.singlePluginDetailCache.delete(key)
    }
  }

  private async successWithSnapshot(
    input: PluginCenterRequestContext,
    changedItemId: string,
    changedSections: PluginCenterChangedSection[],
    write?: unknown,
    isTargetState?: (snapshot: PluginCenterSnapshot) => boolean
  ): Promise<PluginCenterMutationResult> {
    const response = objectValue(objectValue(write).response)
    const overridden = stringValue(response.status) === 'okOverridden'
    const writeStatus = stringValue(response.status)
    const reloadFailed = stringValue(objectValue(write).reloadStatus) === 'failed'
    const snapshotSections = changedSections.flatMap((section): PluginCenterSnapshotSection[] => {
      if (section === 'skills') return ['skills']
      if (section === 'apps') return ['apps']
      if (section === 'mcp') return ['mcp']
      if (section === 'catalog' || section === 'installed') return ['plugins']
      return []
    })
    const snapshot = (
      await this.getSnapshot({
        ...input,
        forceRefresh: true,
        sections: snapshotSections,
        includePluginDetails: false
      })
    ).snapshot
    const verified = isTargetState ? isTargetState(snapshot) : true
    const status = mutationStatus({ overridden, reloadFailed, writeStatus, verified })
    this.logPerformance('mutation:readback', {
      hasChangedItemId: Boolean(changedItemId),
      changedSections: changedSections.join(','),
      readbackType: 'snapshot',
      status
    })
    return pluginCenterMutationResultSchema.parse({
      version: PLUGIN_CENTER_API_VERSION,
      status,
      ...(overridden ? { message: '设置已被更高优先级的配置覆盖' } : {}),
      ...(!overridden && reloadFailed ? { message: '配置已写入，但 MCP 运行时重载失败' } : {}),
      ...(!overridden && !reloadFailed && status === 'partial'
        ? { message: '写入已提交，但刷新后的状态与目标不一致' }
        : {}),
      changedItemId,
      changedSections
    })
  }

  private async successWithInstalledState(
    input: PluginCenterRequestContext,
    changedItemId: string,
    write: unknown,
    isTargetState: (plugins: PluginCenterPlugin[]) => boolean
  ): Promise<PluginCenterMutationResult> {
    const cwd = this.cwdFor(input)
    this.invalidateInstalledCache(cwd)
    this.invalidateSinglePluginDetail(cwd, changedItemId)
    const response = objectValue(objectValue(write).response)
    const overridden = stringValue(response.status) === 'okOverridden'
    const writeStatus = stringValue(response.status)
    const reloadFailed = stringValue(objectValue(write).reloadStatus) === 'failed'
    const plugins = await this.readInstalledPlugins(cwd, true, ++this.snapshotRequestSequence)
    const verified = isTargetState(plugins)
    const status = mutationStatus({ overridden, reloadFailed, writeStatus, verified })
    this.logPerformance('mutation:readback', {
      hasChangedItemId: Boolean(changedItemId),
      changedSections: 'installed',
      readbackType: 'installed',
      status
    })
    return pluginCenterMutationResultSchema.parse({
      version: PLUGIN_CENTER_API_VERSION,
      status,
      ...(overridden ? { message: '设置已被更高优先级的配置覆盖' } : {}),
      ...(!overridden && reloadFailed ? { message: '配置已写入，但 MCP 运行时重载失败' } : {}),
      ...(!overridden && !reloadFailed && status === 'partial'
        ? { message: '写入已提交，但刷新后的状态与目标不一致' }
        : {}),
      changedItemId,
      changedSections: ['installed']
    })
  }

  private async findPluginLocator(
    input: PluginCenterRequestContext & { plugin: { id: string; marketplaceId?: string } }
  ): Promise<PluginLocator> {
    const located = await this.resolvePluginLocator(input)
    if (located.status === 'ready') return located.locator
    throw new Error(
      located.missingReason === 'ambiguous'
        ? '插件在多个市场中存在，请从插件目录重新选择'
        : 'Plugin is no longer available from its marketplace'
    )
  }

  private async resolvePluginLocator(
    input: PluginCenterRequestContext & { plugin: { id: string; marketplaceId?: string } }
  ): Promise<PluginLocatorResult> {
    const catalog = objectValue(
      await this.readPluginCatalog(this.cwdFor(input), false, ++this.snapshotRequestSequence)
    )
    const candidates: PluginLocator[] = []
    for (const marketplace of arrayValue(catalog.marketplaces).map(objectValue)) {
      const marketplaceName = stringValue(marketplace.name)
      if (marketplaceName === LEGACY_REMOTE_PLUGIN_MARKETPLACE_NAME) continue
      if (input.plugin.marketplaceId && marketplaceName !== input.plugin.marketplaceId) continue
      for (const plugin of arrayValue(marketplace.plugins).map(objectValue)) {
        if (stringValue(plugin.id) !== input.plugin.id) continue
        const pluginName = stringValue(plugin.name)
        if (!pluginName || !marketplaceName) continue
        const marketplacePath = stringValue(marketplace.path)
        candidates.push(
          marketplacePath
            ? { plugin, marketplace, pluginName, marketplaceName, marketplacePath }
            : {
                plugin,
                marketplace,
                pluginName,
                marketplaceName,
                remoteMarketplaceName: marketplaceName
              }
        )
      }
    }
    if (candidates.length === 1) return { status: 'ready', locator: candidates[0] }
    return {
      status: 'missing',
      missingReason: candidates.length === 0 ? 'not_found' : 'ambiguous'
    }
  }

  private queue<T>(target: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueues.get(target) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    this.mutationQueues.set(target, current)
    void current
      .finally(() => {
        if (this.mutationQueues.get(target) === current) this.mutationQueues.delete(target)
      })
      .catch(() => undefined)
    return current
  }

  private cwdFor(input: { cwd?: string }): string | undefined {
    return input.cwd?.trim() || this.dependencies.defaultCwd()?.trim() || undefined
  }
}

function mutationStatus({
  overridden,
  reloadFailed,
  writeStatus,
  verified
}: {
  overridden: boolean
  reloadFailed: boolean
  writeStatus: string
  verified: boolean
}): PluginCenterMutationResult['status'] {
  if (overridden) return 'overridden'
  if (reloadFailed) return 'partial'
  if (writeStatus && writeStatus !== 'ok') return 'partial'
  return verified ? 'applied' : 'partial'
}

function normalizePluginDetail(
  locator: PluginLocator,
  rawDetail: unknown,
  rawReadApps: unknown,
  rawDirectoryApps: unknown,
  rawInstalledSkills: unknown | null,
  installedPlugin?: PluginCenterPlugin
): PluginCenterPluginDetail {
  const detail = objectValue(rawDetail)
  const detailSummary = objectValue(detail.summary)
  if (
    stringValue(detailSummary.id) &&
    stringValue(detailSummary.id) !== stringValue(locator.plugin.id)
  ) {
    throw new Error('插件详情与请求的插件不匹配')
  }
  const catalogInterface = objectValue(locator.plugin.interface)
  const detailInterface = objectValue(detailSummary.interface)
  const interfaceInfo = Object.keys(detailInterface).length > 0 ? detailInterface : catalogInterface
  const summary = {
    ...locator.plugin,
    ...detailSummary,
    interface: interfaceInfo
  }
  const detailPlugin = normalizePlugins(
    {
      marketplaces: [{ ...locator.marketplace, plugins: [summary] }],
      featuredPluginIds: []
    },
    [detail]
  )[0]
  if (!detailPlugin) throw new Error('插件详情缺少有效的插件标识')
  const plugin = installedPlugin
    ? {
        ...detailPlugin,
        installed: true,
        enabled: installedPlugin.enabled,
        canInstall: false,
        canUninstall: true,
        canToggle: true
      }
    : detailPlugin

  const longDescription =
    detailTextValue(interfaceInfo.longDescription) ??
    detailTextValue(detail.description) ??
    detailTextValue(interfaceInfo.shortDescription)
  const developerName = displayTextValue(interfaceInfo.developerName)
  const versionLabel =
    displayTextValue(detailSummary.localVersion) || displayTextValue(detailSummary.version)
  const sourcePath = stringValue(objectValue(locator.plugin.source).path)
  const screenshots = uniqueStrings([
    ...(sourcePath
      ? arrayValue(interfaceInfo.screenshots)
          .map((value) => localPluginMediaUrl(value, sourcePath))
          .filter((value): value is string => Boolean(value))
      : []),
    ...arrayValue(interfaceInfo.screenshotUrls)
      .map(safeHttpsUrl)
      .filter((value): value is string => Boolean(value))
  ]).slice(0, 8)
  const defaultPrompts = uniqueStrings(
    arrayValue(interfaceInfo.defaultPrompt)
      .map((value) => stringValue(value).slice(0, 128))
      .filter(Boolean)
  ).slice(0, 3)
  const capabilities = uniqueStrings(
    arrayValue(interfaceInfo.capabilities).map(displayTextValue).filter(Boolean)
  ).slice(0, 30)
  const readAppsById = new Map(
    arrayValue(rawReadApps)
      .map(objectValue)
      .flatMap((app) => {
        const id = stringValue(app.id)
        return id ? [[id, app] as const] : []
      })
  )
  const directoryAppsById = new Map(
    arrayValue(rawDirectoryApps)
      .map(objectValue)
      .flatMap((app) => {
        const id = stringValue(app.id)
        return id ? [[id, app] as const] : []
      })
  )
  const apps = arrayValue(detail.apps).flatMap((value) => {
    const pluginApp = objectValue(value)
    const id = stringValue(pluginApp.id)
    const readApp = id ? readAppsById.get(id) : undefined
    const directoryApp = id ? directoryAppsById.get(id) : undefined
    if (!id) return []
    const name =
      displayTextValue(readApp?.name) ||
      displayTextValue(directoryApp?.name) ||
      displayTextValue(pluginApp.name) ||
      id
    const description =
      displayTextValue(readApp?.description) || displayTextValue(pluginApp.description)
    const icon =
      safeHttpsUrl(readApp?.iconUrlDark) ??
      safeHttpsUrl(readApp?.iconUrl) ??
      safeHttpsUrl(directoryApp?.logoUrlDark) ??
      safeHttpsUrl(directoryApp?.logoUrl) ??
      safeHttpsUrl(pluginApp.logoUrlDark) ??
      safeHttpsUrl(pluginApp.logoUrl)
    const installUrl =
      safeHttpUrl(readApp?.installUrl) ??
      safeHttpUrl(directoryApp?.installUrl) ??
      safeHttpUrl(pluginApp.installUrl)
    const category =
      displayTextValue(pluginApp.category) ||
      displayTextValue(objectValue(directoryApp?.branding).category)
    const accessible = directoryApp
      ? booleanValue(directoryApp.isAccessible)
      : booleanValue(pluginApp.isAccessible)
    return [
      {
        id,
        name,
        ...(description ? { description } : {}),
        ...(category ? { category } : {}),
        ...(installUrl ? { installUrl } : {}),
        ...(icon ? { icon: { kind: 'url' as const, value: icon } } : {}),
        enabled: directoryApp
          ? booleanValue(directoryApp.isEnabled)
          : booleanValue(pluginApp.isEnabled),
        accessible,
        canToggle: plugin.installed && plugin.canToggle && Boolean(directoryApp)
      }
    ]
  })
  const installedSkillIndex = createInstalledSkillIndex(rawInstalledSkills)
  const skills = arrayValue(detail.skills).flatMap((value) => {
    const skill = objectValue(value)
    const name = stringValue(skill.name)
    if (!name) return []
    const interfaceData = objectValue(skill.interface)
    const path = stringValue(skill.path)
    const installedSkill =
      rawInstalledSkills === null
        ? undefined
        : matchInstalledSkill(installedSkillIndex, {
            name,
            path,
            pluginName: stringValue(detailSummary.name) || locator.pluginName
          })
    const installedInterface = objectValue(installedSkill?.interface)
    const displayName =
      displayTextValue(installedInterface.displayName) ||
      displayTextValue(interfaceData.displayName)
    const description =
      displayTextValue(installedInterface.shortDescription) ||
      displayTextValue(installedSkill?.shortDescription) ||
      displayTextValue(installedSkill?.description) ||
      displayTextValue(interfaceData.shortDescription) ||
      displayTextValue(skill.short_description) ||
      displayTextValue(skill.shortDescription) ||
      displayTextValue(skill.description)
    const icon = pluginSkillIcon(detailSummary, interfaceData)
    const installedPath = stringValue(installedSkill?.path)
    const installedName = stringValue(installedSkill?.name)
    return [
      {
        id: installedPath || path || `plugin:${plugin.id}:${name}`,
        name: installedName || name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(icon ? { icon } : {}),
        enabled: installedSkill
          ? booleanValue(installedSkill.enabled)
          : booleanValue(skill.enabled),
        canToggle:
          plugin.installed &&
          plugin.canToggle &&
          (rawInstalledSkills === null || Boolean(installedSkill))
      }
    ]
  })
  const mentionId = plugin.id.includes('@')
    ? plugin.id
    : `${locator.pluginName}@${locator.marketplaceName}`
  const brandColor = safeBrandColor(interfaceInfo.brandColor)

  return {
    plugin: {
      ...plugin,
      ...(developerName ? { author: developerName } : {}),
      ...(versionLabel ? { versionLabel } : {})
    },
    mention: { path: `plugin://${mentionId}`, name: locator.pluginName },
    ...(longDescription ? { longDescription } : {}),
    capabilities,
    defaultPrompts,
    ...(brandColor ? { brandColor } : {}),
    screenshots,
    ...(safeHttpUrl(interfaceInfo.websiteUrl)
      ? { websiteUrl: safeHttpUrl(interfaceInfo.websiteUrl) }
      : {}),
    ...(safeHttpUrl(interfaceInfo.privacyPolicyUrl)
      ? { privacyPolicyUrl: safeHttpUrl(interfaceInfo.privacyPolicyUrl) }
      : {}),
    ...(safeHttpUrl(interfaceInfo.termsOfServiceUrl)
      ? { termsOfServiceUrl: safeHttpUrl(interfaceInfo.termsOfServiceUrl) }
      : {}),
    apps,
    skills,
    mcpServers: uniqueStrings(arrayValue(detail.mcpServers).map(stringValue).filter(Boolean)).slice(
      0,
      100
    )
  }
}

type InstalledSkillIndex = {
  byPath: Map<string, JsonRecord>
  byName: Map<string, JsonRecord>
  byComparableName: Map<string, JsonRecord[]>
}

function createInstalledSkillIndex(rawSkills: unknown): InstalledSkillIndex {
  const byPath = new Map<string, JsonRecord>()
  const byName = new Map<string, JsonRecord>()
  const byComparableName = new Map<string, JsonRecord[]>()

  for (const value of arrayValue(rawSkills)) {
    const skill = objectValue(value)
    const path = stringValue(skill.path)
    const name = stringValue(skill.name)
    if (path) byPath.set(path, skill)
    if (!name) continue
    byName.set(name, skill)
    const comparableName = comparableSkillName(name)
    const matches = byComparableName.get(comparableName) ?? []
    matches.push(skill)
    byComparableName.set(comparableName, matches)
  }

  return { byPath, byName, byComparableName }
}

function matchInstalledSkill(
  index: InstalledSkillIndex,
  pluginSkill: { name: string; path: string; pluginName: string }
): JsonRecord | undefined {
  if (pluginSkill.path) {
    const pathMatch = index.byPath.get(pluginSkill.path)
    if (pathMatch) return pathMatch
  }

  const canonicalName =
    !pluginSkill.path && !pluginSkill.name.includes(':')
      ? `${pluginSkill.pluginName}:${pluginSkill.name}`
      : pluginSkill.name
  const canonicalMatch = index.byName.get(canonicalName)
  if (canonicalMatch) return canonicalMatch

  const exactMatch = index.byName.get(pluginSkill.name)
  if (exactMatch) return exactMatch

  const comparableMatches = index.byComparableName.get(comparableSkillName(pluginSkill.name)) ?? []
  return comparableMatches.length === 1 ? comparableMatches[0] : undefined
}

function comparableSkillName(value: string): string {
  const unqualifiedName = value.split(':').at(-1) ?? value
  return unqualifiedName
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, '')
}

function normalizePlugins(catalog: JsonRecord, pluginDetails: unknown[]): PluginCenterPlugin[] {
  const featured = new Set(arrayValue(catalog.featuredPluginIds).map(stringValue).filter(Boolean))
  const detailsByPluginId = new Map<string, JsonRecord[]>()
  for (const detail of pluginDetails.map(objectValue)) {
    const id = stringValue(objectValue(detail.summary).id)
    if (!id) continue
    detailsByPluginId.set(id, [...(detailsByPluginId.get(id) ?? []), detail])
  }
  const plugins = arrayValue(catalog.marketplaces).flatMap((rawMarketplace) => {
    const marketplace = objectValue(rawMarketplace)
    const marketplaceId = stringValue(marketplace.name)
    if (marketplaceId === LEGACY_REMOTE_PLUGIN_MARKETPLACE_NAME) return []
    return arrayValue(marketplace.plugins).map((rawPlugin) => {
      const plugin = objectValue(rawPlugin)
      const interfaceInfo = objectValue(plugin.interface)
      const id = requiredString(plugin.id, 'plugin id')
      const name = stringValue(plugin.name) || id
      const availability = stringValue(plugin.availability)
      const installPolicy = stringValue(plugin.installPolicy)
      const available = availability === 'AVAILABLE' || availability.length === 0
      const allowed = installPolicy !== 'NOT_AVAILABLE' && available
      const details = detailsByPluginId.get(id) ?? []
      const iconUrl = pluginIconUrl(
        plugin,
        interfaceInfo,
        objectValue(objectValue(details[0]).summary)
      )
      const displayName = displayTextValue(interfaceInfo.displayName)
      const description = displayTextValue(interfaceInfo.shortDescription)
      const versionLabel = displayTextValue(plugin.version)
      return {
        kind: 'plugin' as const,
        id,
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(iconUrl ? { icon: { kind: 'url' as const, value: iconUrl } } : {}),
        sourceKind: sourceKind(plugin.source),
        ...(marketplaceId ? { marketplaceId, marketplaceName: marketplaceId } : {}),
        categories: stringValue(interfaceInfo.category)
          ? [stringValue(interfaceInfo.category)]
          : [],
        tags: arrayValue(plugin.keywords).map(stringValue).filter(Boolean),
        featured: featured.has(id),
        installed: booleanValue(plugin.installed),
        enabled: booleanValue(plugin.enabled),
        canInstall: allowed && !booleanValue(plugin.installed),
        canUninstall: booleanValue(plugin.installed),
        canToggle: booleanValue(plugin.installed),
        skillCount: details.reduce((count, detail) => count + arrayValue(detail.skills).length, 0),
        appCount: details.reduce((count, detail) => count + arrayValue(detail.apps).length, 0),
        mcpServerCount: new Set(
          details.flatMap((detail) =>
            arrayValue(detail.mcpServers).map(stringValue).filter(Boolean)
          )
        ).size,
        ...(!allowed
          ? {
              restriction: {
                code:
                  availability === 'DISABLED_BY_ADMIN'
                    ? ('policy' as const)
                    : ('unavailable' as const),
                message:
                  availability === 'DISABLED_BY_ADMIN'
                    ? '此插件已被管理员禁用'
                    : '此插件当前不可安装'
              }
            }
          : {}),
        ...(versionLabel ? { versionLabel } : {})
      }
    })
  })
  return uniquePlugins(plugins)
}

function uniquePlugins(plugins: PluginCenterPlugin[]): PluginCenterPlugin[] {
  const pluginsById = new Map<string, PluginCenterPlugin>()
  for (const plugin of plugins) {
    const existing = pluginsById.get(plugin.id)
    if (!existing || (!existing.installed && plugin.installed)) {
      pluginsById.set(plugin.id, plugin)
    }
  }
  return [...pluginsById.values()]
}

function mergePluginsWithInstalled(
  catalogPlugins: PluginCenterPlugin[],
  installedPlugins: PluginCenterPlugin[]
): PluginCenterPlugin[] {
  const installedById = new Map(installedPlugins.map((plugin) => [plugin.id, plugin]))
  const merged = catalogPlugins.map((plugin) => {
    const installed = installedById.get(plugin.id)
    if (!installed) {
      return {
        ...plugin,
        installed: false,
        enabled: false,
        canInstall: plugin.canInstall,
        canUninstall: false,
        canToggle: false
      }
    }
    return {
      ...plugin,
      installed: true,
      enabled: installed.enabled,
      canInstall: false,
      canUninstall: true,
      canToggle: true
    }
  })
  const catalogIds = new Set(catalogPlugins.map((plugin) => plugin.id))
  for (const plugin of installedPlugins) {
    if (catalogIds.has(plugin.id)) continue
    merged.push(plugin)
  }
  return uniquePlugins(merged)
}

function normalizeSkills(
  raw: unknown,
  pluginDetails: unknown[],
  plugins: PluginCenterPlugin[]
): PluginCenterSkill[] {
  const skills: PluginCenterSkill[] = arrayValue(raw)
    .map(objectValue)
    .map((skill): PluginCenterSkill => {
      const path = stringValue(skill.path)
      const name = stringValue(skill.name) || path
      const scope = stringValue(skill.scope)
      const displayName = displayTextValue(skill.shortDescription)
      const description = displayTextValue(skill.description)
      return {
        id: path || name,
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        scope: normalizeSkillScope(scope),
        sourceKind: scope === 'system' ? 'builtin' : 'personal',
        enabled: booleanValue(skill.enabled),
        installed: true,
        recommended: false,
        canToggle: true,
        tags: []
      }
    })
  const existingSkillIds = new Set(skills.map((skill) => skill.id))
  for (const rawDetail of pluginDetails) {
    const detail = objectValue(rawDetail)
    const summary = objectValue(detail.summary)
    const pluginId = stringValue(summary.id)
    if (!pluginId) continue
    const pluginDisplayName =
      displayTextValue(objectValue(summary.interface).displayName) || displayTextValue(summary.name)
    const owningPlugin = plugins.find((plugin) => plugin.id === pluginId)
    for (const rawSkill of arrayValue(detail.skills)) {
      const skill = objectValue(rawSkill)
      const name = stringValue(skill.name)
      if (!name) continue
      const path = stringValue(skill.path)
      const id = path || `plugin:${pluginId}:${name}`
      const existingIndex = skills.findIndex((candidate) => candidate.id === id)
      if (existingIndex >= 0) {
        skills[existingIndex] = {
          ...skills[existingIndex],
          recommended: true,
          pluginId,
          pluginDisplayName
        }
        continue
      }
      if (existingSkillIds.has(id)) continue
      const interfaceInfo = objectValue(skill.interface)
      const installed = owningPlugin?.installed === true
      const displayName = displayTextValue(interfaceInfo.displayName)
      const description = displayTextValue(skill.description)
      skills.push({
        id,
        name,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        scope: 'plugin',
        sourceKind: 'marketplace',
        pluginId,
        ...(pluginDisplayName ? { pluginDisplayName } : {}),
        enabled: installed && booleanValue(skill.enabled),
        installed,
        recommended: true,
        canToggle: installed,
        tags: [],
        ...(!installed
          ? {
              restriction: {
                code: 'unavailable' as const,
                message: '请先安装所属插件'
              }
            }
          : {})
      })
      existingSkillIds.add(id)
    }
  }
  return skills
}

function normalizeApps(raw: unknown): PluginCenterApp[] {
  return arrayValue(raw)
    .map(objectValue)
    .map((app) => {
      const logo = safeHttpsUrl(app.logoUrlDark) ?? safeHttpsUrl(app.logoUrl)
      const accessible = booleanValue(app.isAccessible)
      const description = displayTextValue(app.description)
      return {
        id: requiredString(app.id, 'app id'),
        name: stringValue(app.name) || requiredString(app.id, 'app id'),
        ...(description ? { description } : {}),
        ...(logo ? { icon: { kind: 'url' as const, value: logo } } : {}),
        sourceKind: 'marketplace',
        pluginIds: [],
        pluginDisplayNames: arrayValue(app.pluginDisplayNames).map(stringValue).filter(Boolean),
        enabled: booleanValue(app.isEnabled),
        accessible,
        canToggle: true,
        ...(safeHttpUrl(app.installUrl) ? { installUrl: safeHttpUrl(app.installUrl) } : {})
      }
    })
}

function normalizeMarketplaces(catalog: JsonRecord): PluginCenterSnapshot['marketplaces'] {
  return arrayValue(catalog.marketplaces)
    .map(objectValue)
    .flatMap((marketplace) => {
      const name = stringValue(marketplace.name)
      if (!name || name === LEGACY_REMOTE_PLUGIN_MARKETPLACE_NAME) return []
      const path = stringValue(marketplace.path)
      return [{ id: name, name, source: path || name, sparsePaths: [] }]
    })
}

function catalogUnavailableReason(catalog: JsonRecord): string | undefined {
  const errors = arrayValue(catalog.marketplaceLoadErrors).map(objectValue)
  if (errors.length > 0) return displayTextValue(errors[0]?.message) || '部分插件市场不可用'
  return arrayValue(catalog.marketplaces).length === 0 ? '暂无可用插件市场' : undefined
}

function isRemoteCatalogDegraded(rawCatalog: unknown): boolean {
  const marketplaces = arrayValue(objectValue(rawCatalog).marketplaces).map(objectValue)
  const hasOfficialLocalMarketplace = marketplaces.some((marketplace) =>
    OFFICIAL_LOCAL_MARKETPLACE_NAMES.has(stringValue(marketplace.name))
  )
  if (!hasOfficialLocalMarketplace) return false

  return !marketplaces.some(
    (marketplace) =>
      stringValue(marketplace.name) === REMOTE_PLUGIN_MARKETPLACE_NAME &&
      arrayValue(marketplace.plugins).length > 0
  )
}

function degradedCatalogValue(
  catalog: unknown,
  lastCompleteCatalog?: unknown
): PluginCatalogCacheValue {
  const hasFallback = lastCompleteCatalog !== undefined
  const visibleCatalog = hasFallback ? lastCompleteCatalog : catalog
  const message = hasFallback ? REMOTE_CATALOG_FALLBACK_MESSAGE : REMOTE_CATALOG_LOCAL_ONLY_MESSAGE
  const normalizedCatalog = objectValue(visibleCatalog)
  return {
    catalog: {
      ...normalizedCatalog,
      marketplaceLoadErrors: [
        {
          marketplacePath: REMOTE_PLUGIN_MARKETPLACE_NAME,
          message
        },
        ...arrayValue(normalizedCatalog.marketplaceLoadErrors)
      ]
    },
    degraded: true,
    ...(hasFallback ? { lastCompleteCatalog } : {})
  }
}

function resolveCacheFreshness<T>(freshness: CacheFreshness<T>, value: T): number {
  return typeof freshness === 'function' ? freshness(value) : freshness
}

function cacheKeyForCwd(cwd: string | undefined): string {
  const value = cwd?.trim()
  if (!value) return ''
  return resolve(value)
}

function pluginDetailCacheKey(
  cwd: string | undefined,
  pluginId: string,
  marketplaceId: string | undefined
): string {
  return `${cacheKeyForCwd(cwd)}\u0000${pluginId}\u0000${marketplaceId ?? ''}`
}

function cacheLogKey(key: string): string {
  if (!key) return 'global'
  return `cwd:${key.length}`
}

function normalizeMcpSnapshot(raw: unknown): McpRawSnapshot {
  const source = objectValue(raw)
  const configResponse = objectValue(source.config)
  return {
    config: objectValue(configResponse.config),
    userConfig: userConfigFromReadResponse(configResponse),
    origins: objectValue(configResponse.origins),
    servers: arrayValue(source.servers),
    pluginDetails: arrayValue(source.pluginDetails)
  }
}

function normalizeMcpForUi(raw: McpRawSnapshot): PluginCenterSnapshot['mcp'] {
  const statuses = new Map(
    raw.servers.map(objectValue).map((server) => [stringValue(server.name), server] as const)
  )
  const pluginServers: PluginCenterPluginMcpServer[] = []
  for (const rawDetail of raw.pluginDetails) {
    const detail = objectValue(rawDetail)
    const summary = objectValue(detail.summary)
    const pluginId = stringValue(summary.id)
    if (!pluginId) continue
    const pluginDisplayName =
      displayTextValue(objectValue(summary.interface).displayName) || displayTextValue(summary.name)
    for (const name of arrayValue(detail.mcpServers).map(stringValue).filter(Boolean)) {
      const status = statuses.get(name) ?? {}
      pluginServers.push({
        id: name,
        name,
        enabled: booleanValue(summary.enabled),
        connected: booleanValue(status.connected),
        authStatus: normalizeAuthStatus(status.authStatus),
        toolCount: nonNegativeInteger(status.toolCount),
        origin: 'plugin' as const,
        editable: false as const,
        pluginId,
        ...(pluginDisplayName ? { pluginDisplayName } : {}),
        transport: 'unknown' as const
      })
    }
  }
  const pluginServerNames = new Set(pluginServers.map((server) => server.id))
  const userServers: PluginCenterSnapshot['mcp']['userServers'] = []
  const userEntries = mcpConfigEntries(raw.userConfig)
  for (const [id, value] of Object.entries(mcpConfigEntries(raw.config))) {
    if (pluginServerNames.has(id)) continue
    const status = statuses.get(id) ?? {}
    const enabled = value.enabled !== false
    const origin = mcpOrigin(raw.origins, id, Boolean(userEntries[id]))
    const editable = origin === 'user'
    const restriction = editable
      ? undefined
      : { code: 'readonly' as const, message: '此 MCP 服务器来自不可写配置层' }
    if (typeof value.url === 'string') {
      const server: PluginCenterHttpMcpServer = {
        id,
        name: id,
        enabled,
        connected: booleanValue(status.connected),
        authStatus: normalizeAuthStatus(status.authStatus),
        toolCount: nonNegativeInteger(status.toolCount),
        origin,
        editable,
        transport: 'streamable-http',
        ...(safeHttpUrl(value.url) ? { url: safeHttpUrl(value.url) } : {}),
        ...(stringValue(value.bearer_token_env_var)
          ? { bearerTokenEnvVar: stringValue(value.bearer_token_env_var) }
          : {}),
        httpHeaders: secretMetadata(value.http_headers),
        envHttpHeaders: envHeaderMetadata(value.env_http_headers),
        ...(restriction ? { restriction } : {})
      }
      userServers.push(server)
      continue
    }
    const server: PluginCenterStdioMcpServer = {
      id,
      name: id,
      enabled,
      connected: booleanValue(status.connected),
      authStatus: normalizeAuthStatus(status.authStatus),
      toolCount: nonNegativeInteger(status.toolCount),
      origin,
      editable,
      transport: 'stdio',
      ...(stringValue(value.command) ? { command: stringValue(value.command) } : {}),
      args: arrayValue(value.args).map(stringValue).filter(Boolean),
      ...(stringValue(value.cwd) ? { cwd: stringValue(value.cwd) } : {}),
      env: secretMetadata(value.env),
      envVars: envVarMetadata(value.env_vars, editable),
      ...(restriction ? { restriction } : {})
    }
    userServers.push(server)
  }
  return { userServers, pluginServers }
}

function mcpConfigEntries(config: JsonRecord): Record<string, JsonRecord> {
  const entries = objectValue(config.mcp_servers)
  return Object.fromEntries(
    Object.entries(entries).flatMap(([name, value]) => {
      const entry = objectValue(value)
      return Object.keys(entry).length > 0 ? [[name, entry]] : []
    })
  )
}

function userConfigFromReadResponse(response: JsonRecord): JsonRecord {
  const userLayer = arrayValue(response.layers)
    .map(objectValue)
    .find((layer) => stringValue(objectValue(layer.name).type) === 'user')
  return objectValue(userLayer?.config)
}

function mergeMcpServerValue(
  previous: JsonRecord | undefined,
  input: PluginCenterMcpServerInput
): JsonRecord {
  const next: JsonRecord = { ...(previous ?? {}), enabled: previous?.enabled ?? true }
  if (input.transport === 'stdio') {
    delete next.url
    delete next.bearer_token_env_var
    delete next.http_headers
    delete next.env_http_headers
    next.command = input.command
    setOptional(next, 'args', input.args.length ? input.args : undefined)
    setOptional(next, 'cwd', input.cwd)
    next.env = applySecretPatches(objectValue(previous?.env), input.env)
    setOptional(next, 'env_vars', mergeEnvVars(previous?.env_vars, input.envVars))
  } else {
    delete next.command
    delete next.args
    delete next.cwd
    delete next.env
    delete next.env_vars
    next.url = input.url
    setOptional(next, 'bearer_token_env_var', input.bearerTokenEnvVar)
    next.http_headers = applySecretPatches(objectValue(previous?.http_headers), input.httpHeaders)
    next.env_http_headers = Object.fromEntries(
      input.envHttpHeaders.map((header) => [header.name, header.envVarName])
    )
  }
  return next
}

function mcpTransport(value: JsonRecord): PluginCenterMcpServerInput['transport'] {
  return typeof value.url === 'string' ? 'streamable-http' : 'stdio'
}

function applySecretPatches(
  previous: JsonRecord,
  patches: Array<{ name: string; value: { action: 'keep' | 'set' | 'remove'; value?: string } }>
): JsonRecord {
  const next = { ...previous }
  for (const patch of patches) {
    if (patch.value.action === 'remove') delete next[patch.name]
    if (patch.value.action === 'set') next[patch.name] = patch.value.value ?? ''
  }
  return next
}

function mcpServerMatchesInput(
  server: PluginCenterStdioMcpServer | PluginCenterHttpMcpServer,
  input: PluginCenterMcpServerInput
): boolean {
  if (server.transport !== input.transport) return false
  if (server.transport === 'stdio' && input.transport === 'stdio') {
    return (
      server.command === input.command &&
      orderedStringsEqual(server.args, input.args) &&
      (server.cwd ?? undefined) === (input.cwd ?? undefined) &&
      secretPatchesMatch(server.env, input.env) &&
      stringSetsEqual(
        server.envVars.filter((entry) => entry.editable).map((entry) => entry.name),
        input.envVars
      )
    )
  }
  if (server.transport === 'streamable-http' && input.transport === 'streamable-http') {
    return (
      server.url === input.url &&
      (server.bearerTokenEnvVar ?? undefined) === (input.bearerTokenEnvVar ?? undefined) &&
      secretPatchesMatch(server.httpHeaders, input.httpHeaders) &&
      keyValueSetsEqual(server.envHttpHeaders, input.envHttpHeaders)
    )
  }
  return false
}

function secretPatchesMatch(
  metadata: Array<{ name: string; hasValue: boolean }>,
  patches: Array<{ name: string; value: { action: 'keep' | 'set' | 'remove' } }>
): boolean {
  const byName = new Map(metadata.map((entry) => [entry.name, entry]))
  return patches.every((patch) => {
    const entry = byName.get(patch.name)
    if (patch.value.action === 'remove') return entry === undefined
    if (patch.value.action === 'set') return entry?.hasValue === true
    return entry !== undefined
  })
}

function orderedStringsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function stringSetsEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  )
}

function keyValueSetsEqual(
  left: Array<{ name: string; envVarName: string }>,
  right: Array<{ name: string; envVarName: string }>
): boolean {
  return (
    left.length === right.length &&
    left.every((entry) =>
      right.some(
        (candidate) => candidate.name === entry.name && candidate.envVarName === entry.envVarName
      )
    )
  )
}

function uniqueMcpServerName(displayName: string, entries: Record<string, JsonRecord>): string {
  const base =
    displayName
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/[-_]{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'mcp-server'
  let candidate = base
  let suffix = 2
  while (entries[candidate]) candidate = `${base}-${suffix++}`
  return candidate
}

function secretMetadata(
  value: unknown
): Array<{ name: string; hasValue: boolean; editable: boolean }> {
  return Object.entries(objectValue(value)).map(([name, item]) => ({
    name,
    hasValue: typeof item === 'string' && item.length > 0,
    editable: true
  }))
}

function envVarMetadata(
  value: unknown,
  editable: boolean
): Array<{ name: string; source?: 'local' | 'remote'; editable: boolean }> {
  return arrayValue(value).flatMap((item) => {
    if (typeof item === 'string') {
      const name = stringValue(item)
      return name ? [{ name, source: 'local' as const, editable }] : []
    }
    const entry = objectValue(item)
    const name = stringValue(entry.name)
    if (!name) return []
    const source = stringValue(entry.source) === 'remote' ? ('remote' as const) : ('local' as const)
    return [{ name, source, editable: editable && source === 'local' }]
  })
}

function mergeEnvVars(previous: unknown, localNames: string[]): unknown[] | undefined {
  const remoteEntries = arrayValue(previous).filter((item) => {
    if (typeof item === 'string') return false
    return stringValue(objectValue(item).source) === 'remote'
  })
  const next = [
    ...remoteEntries,
    ...localNames
      .map((name) => name.trim())
      .filter(Boolean)
      .filter((name) =>
        remoteEntries.every((entry) => stringValue(objectValue(entry).name) !== name)
      )
      .map((name) => ({ name, source: 'local' as const }))
  ]
  return next.length ? next : undefined
}

function envHeaderMetadata(
  value: unknown
): Array<{ name: string; envVarName: string; editable: boolean }> {
  return Object.entries(objectValue(value)).flatMap(([name, envVarName]) => {
    const normalized = stringValue(envVarName)
    return normalized ? [{ name, envVarName: normalized, editable: true }] : []
  })
}

function mcpOrigin(
  origins: JsonRecord,
  serverId: string,
  hasUserEntry: boolean
): PluginCenterStdioMcpServer['origin'] {
  const serverKey = configPathKey(['mcp_servers', serverId])
  const enabledKey = configPathKey(['mcp_servers', serverId, 'enabled'])
  const metadata = objectValue(origins[serverKey] ?? origins[enabledKey])
  const sourceType = stringValue(objectValue(metadata.name).type)
  switch (sourceType) {
    case 'user':
      return hasUserEntry ? 'user' : 'project'
    case 'project':
      return 'project'
    case 'system':
    case 'packagedDefaults':
      return 'system'
    case 'enterpriseManaged':
    case 'mdm':
    case 'legacyManagedConfigTomlFromFile':
    case 'legacyManagedConfigTomlFromMdm':
    case 'sessionFlags':
      return 'managed'
    default:
      return hasUserEntry ? 'user' : 'project'
  }
}

function pluginIconUrl(
  plugin: JsonRecord,
  interfaceInfo: JsonRecord,
  detailSummary: JsonRecord
): string | undefined {
  const source = objectValue(plugin.source)
  const sourcePath = stringValue(source.path)
  if (stringValue(source.type) === 'local' && sourcePath) {
    return (
      localPluginMediaUrl(interfaceInfo.logoDark, sourcePath) ??
      localPluginMediaUrl(interfaceInfo.logo, sourcePath) ??
      localPluginMediaUrl(interfaceInfo.composerIcon, sourcePath) ??
      localPluginMediaUrl(objectValue(detailSummary.interface).logoDark, sourcePath) ??
      localPluginMediaUrl(objectValue(detailSummary.interface).logo, sourcePath) ??
      localPluginMediaUrl(objectValue(detailSummary.interface).composerIcon, sourcePath)
    )
  }
  return (
    safeHttpsUrl(interfaceInfo.logoUrlDark) ??
    safeHttpsUrl(interfaceInfo.logoUrl) ??
    safeHttpsUrl(interfaceInfo.composerIconUrl)
  )
}

function pluginSkillIcon(
  detailSummary: JsonRecord,
  interfaceInfo: JsonRecord
): { kind: 'url'; value: string } | undefined {
  const source = objectValue(detailSummary.source)
  const sourcePath = stringValue(source.path)
  const icon = interfaceInfo.iconSmall ?? interfaceInfo.iconLarge

  if (stringValue(source.type) === 'local' && sourcePath) {
    const value = localPluginMediaUrl(icon, sourcePath)
    return value ? { kind: 'url', value } : undefined
  }

  const value = safeHttpsUrl(icon)
  return value ? { kind: 'url', value } : undefined
}

function localPluginMediaUrl(value: unknown, sourcePath: string): string | undefined {
  const rawPath = stringValue(value)
  if (!rawPath) return undefined
  const candidatePath = pathFromFileUrl(rawPath) ?? rawPath
  const root = resolve(sourcePath)
  const absolutePath = isAbsolute(candidatePath)
    ? resolve(candidatePath)
    : resolve(root, candidatePath)
  const relativePath = relative(root, absolutePath)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined
  }
  return toAppMediaUrl(absolutePath) ?? undefined
}

function pathFromFileUrl(value: string): string | undefined {
  if (!value.startsWith('file:')) return undefined
  try {
    return fileURLToPath(value)
  } catch {
    return undefined
  }
}

function sourceKind(source: unknown): PluginCenterPlugin['sourceKind'] {
  const type = stringValue(objectValue(source).type)
  if (type === 'local') return 'local'
  if (type === 'remote') return 'marketplace'
  return 'unknown'
}

function configPathKey(segments: string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 || segment === 'enabled' ? segment : JSON.stringify(segment)
    )
    .join('.')
}

function normalizeSkillScope(scope: string): PluginCenterSkill['scope'] {
  switch (scope) {
    case 'user':
      return 'personal'
    case 'repo':
      return 'project'
    case 'system':
      return 'system'
    default:
      return 'unknown'
  }
}

function normalizeAuthStatus(value: unknown): PluginCenterStdioMcpServer['authStatus'] {
  const status = stringValue(value)
  return status === 'unsupported' ||
    status === 'notLoggedIn' ||
    status === 'bearerToken' ||
    status === 'oAuth'
    ? status
    : 'unknown'
}

async function safeRead<T>(read: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await read() }
  } catch {
    return {
      ok: false,
      restriction: {
        code: 'error',
        message: '该数据源暂时不可用'
      }
    }
  }
}

function capabilityFor(...results: SafeResult<unknown>[]): SnapshotCapability {
  const failed = results.find((result) => !result.ok)
  return failed ? { available: false, restriction: failed.restriction } : { available: true }
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function displayTextValue(value: unknown): string {
  return stringValue(value).slice(0, PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH)
}

function detailTextValue(value: unknown): string | undefined {
  const text = stringValue(value).slice(0, 5_000)
  return text || undefined
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function safeBrandColor(value: unknown): string | undefined {
  const color = stringValue(value)
  return /^(?:#[0-9a-fA-F]{3,8}|rgba?\([^()]{1,80}\))$/.test(color) ? color : undefined
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value)
  if (!result) throw new Error(`Invalid ${label} from Codex app server`)
  return result
}

function safeHttpUrl(value: unknown): string | undefined {
  const candidate = stringValue(value)
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function safeHttpsUrl(value: unknown): string | undefined {
  const url = safeHttpUrl(value)
  return url?.startsWith('https:') ? url : undefined
}

function setOptional(target: JsonRecord, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') delete target[key]
  else target[key] = value
}
