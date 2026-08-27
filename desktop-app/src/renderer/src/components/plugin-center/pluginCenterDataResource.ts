import type {
  DesktopPluginCenterApi,
  PluginCenterGetPluginDetailResult,
  PluginCenterPlugin,
  PluginCenterSnapshot,
  PluginCenterSnapshotSection
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'

const CATALOG_FRESH_MS = 6 * 60 * 60 * 1_000
const INSTALLED_FRESH_MS = 60_000
const SKILLS_FRESH_MS = 60_000
const APPS_FRESH_MS = 60_000
const MCP_FRESH_MS = 30_000
const PLUGIN_DETAIL_FRESH_MS = 30_000
const RESOURCE_GC_MS = 5 * 60_000
const MAX_CWD_RESOURCES = 3
const MAX_PLUGIN_DETAIL_RESOURCES = 20

type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error'
type ResourceKind = 'catalog' | 'installed' | 'detail' | PluginCenterSupplementalSection
export type PluginCenterSupplementalSection = Exclude<PluginCenterSnapshotSection, 'plugins'>
type ResourceLogEvent =
  | 'prefetch-start'
  | 'prefetch-complete'
  | 'cache-hit-fresh'
  | 'cache-hit-stale'
  | 'inflight-joined'

export type PluginCenterResourceSnapshot<T> = {
  data: T | null
  error: string | null
  status: ResourceStatus
  isRefreshing: boolean
  updatedAt: number
}

export type PluginCenterResource<T> = {
  subscribe(listener: () => void): () => void
  getSnapshot(): PluginCenterResourceSnapshot<T>
  prefetch(forceRefresh?: boolean): Promise<void>
  refresh(forceRefresh?: boolean): Promise<void>
  invalidate(): void
  release(): void
}

type ResourceStore<T> = PluginCenterResource<T> & {
  lastAccessedAt: number
  subscriberCount(): number
}

type ApiResources = {
  catalog: Map<string, ResourceStore<PluginCenterSnapshot>>
  installed: Map<string, ResourceStore<PluginCenterPlugin[]>>
  skills: Map<string, ResourceStore<PluginCenterSnapshot>>
  apps: Map<string, ResourceStore<PluginCenterSnapshot>>
  mcp: Map<string, ResourceStore<PluginCenterSnapshot>>
  details: Map<string, ResourceStore<PluginCenterGetPluginDetailResult>>
}

type InFlightRequest = {
  generation: number
  promise: Promise<void>
}

const resourcesByApi = new WeakMap<DesktopPluginCenterApi, ApiResources>()

function now(): number {
  return Date.now()
}

function normalizeCwd(cwd?: string): string {
  const trimmed = cwd?.trim()
  if (!trimmed) return ''
  return trimmed.replace(/\/+$/, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '读取插件中心失败'
}

function logResourceEvent(
  event: ResourceLogEvent,
  details: {
    kind: ResourceKind
    cacheStatus?: 'fresh' | 'stale' | 'miss'
    durationMs?: number
    hasCwd?: boolean
  }
): void {
  console.info(`[plugin-center:perf:${event}]`, {
    atMs: now(),
    ...details
  })
}

function resourcesForApi(api: DesktopPluginCenterApi): ApiResources {
  const existing = resourcesByApi.get(api)
  if (existing) return existing
  const created: ApiResources = {
    catalog: new Map(),
    installed: new Map(),
    skills: new Map(),
    apps: new Map(),
    mcp: new Map(),
    details: new Map()
  }
  resourcesByApi.set(api, created)
  return created
}

function evictOldestCwdResource<T>(
  map: Map<string, ResourceStore<T>>,
  limit = MAX_CWD_RESOURCES
): void {
  while (map.size > limit) {
    let oldestKey: string | null = null
    let oldestAccessedAt = Number.POSITIVE_INFINITY
    for (const [key, resource] of map) {
      if (resource.subscriberCount() > 0) continue
      if (resource.lastAccessedAt < oldestAccessedAt) {
        oldestKey = key
        oldestAccessedAt = resource.lastAccessedAt
      }
    }
    if (oldestKey === null) return
    map.get(oldestKey)?.release()
  }
}

function createResource<T>({
  kind,
  cwd,
  freshMs,
  load,
  onRelease
}: {
  kind: ResourceKind
  cwd?: string
  freshMs: number | ((data: T) => number)
  load(forceRefresh: boolean): Promise<T>
  onRelease(): void
}): ResourceStore<T> {
  const listeners = new Set<() => void>()
  let gcTimer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let inFlight: InFlightRequest | null = null
  let snapshot: PluginCenterResourceSnapshot<T> = {
    data: null,
    error: null,
    status: 'idle',
    isRefreshing: false,
    updatedAt: 0
  }

  function emit(): void {
    for (const listener of listeners) listener()
  }

  function isFresh(): boolean {
    if (snapshot.data === null) return false
    const freshness = typeof freshMs === 'function' ? freshMs(snapshot.data) : freshMs
    return now() - snapshot.updatedAt < freshness
  }

  function clearGcTimer(): void {
    if (gcTimer) clearTimeout(gcTimer)
    gcTimer = null
  }

  function scheduleGc(): void {
    clearGcTimer()
    gcTimer = setTimeout(() => {
      if (listeners.size === 0) onRelease()
    }, RESOURCE_GC_MS)
  }

  async function loadResource(
    forceRefresh: boolean,
    reason: 'prefetch' | 'refresh'
  ): Promise<void> {
    resource.lastAccessedAt = now()
    if (!forceRefresh && isFresh()) {
      logResourceEvent('cache-hit-fresh', { kind, cacheStatus: 'fresh', hasCwd: Boolean(cwd) })
      return
    }
    if (!forceRefresh && snapshot.data !== null) {
      logResourceEvent('cache-hit-stale', { kind, cacheStatus: 'stale', hasCwd: Boolean(cwd) })
    }
    const requestGeneration = generation
    if (inFlight?.generation === requestGeneration) {
      logResourceEvent('inflight-joined', { kind, hasCwd: Boolean(cwd) })
      await inFlight.promise
      return
    }

    const startedAt = performance.now()
    logResourceEvent('prefetch-start', {
      kind,
      cacheStatus: snapshot.data === null ? 'miss' : 'stale',
      hasCwd: Boolean(cwd)
    })
    snapshot = {
      ...snapshot,
      error: null,
      status: snapshot.data === null ? 'loading' : snapshot.status,
      isRefreshing: snapshot.data !== null || reason === 'refresh'
    }
    emit()

    const requestPromise = load(forceRefresh)
      .then((data) => {
        if (requestGeneration !== generation) return
        snapshot = {
          data,
          error: null,
          status: 'ready',
          isRefreshing: false,
          updatedAt: now()
        }
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation) return
        snapshot = {
          ...snapshot,
          error: errorMessage(error),
          status: snapshot.data === null ? 'error' : 'ready',
          isRefreshing: false
        }
      })
      .finally(() => {
        logResourceEvent('prefetch-complete', {
          kind,
          durationMs: Math.round(performance.now() - startedAt),
          hasCwd: Boolean(cwd)
        })
        if (inFlight?.promise !== requestPromise) return
        inFlight = null
        if (listeners.size === 0) scheduleGc()
        if (requestGeneration === generation) emit()
      })

    inFlight = { generation: requestGeneration, promise: requestPromise }
    await requestPromise
  }

  const resource: ResourceStore<T> = {
    lastAccessedAt: now(),
    subscriberCount() {
      return listeners.size
    },
    subscribe(listener) {
      clearGcTimer()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) scheduleGc()
      }
    },
    getSnapshot() {
      resource.lastAccessedAt = now()
      return snapshot
    },
    prefetch(forceRefresh = false) {
      return loadResource(forceRefresh, 'prefetch')
    },
    refresh(forceRefresh = false) {
      return loadResource(forceRefresh, 'refresh')
    },
    invalidate() {
      generation += 1
      snapshot = {
        ...snapshot,
        updatedAt: 0
      }
    },
    release() {
      clearGcTimer()
      listeners.clear()
      onRelease()
    }
  }

  scheduleGc()
  return resource
}

function supplementalFreshMs(section: PluginCenterSupplementalSection): number {
  switch (section) {
    case 'skills':
      return SKILLS_FRESH_MS
    case 'apps':
      return APPS_FRESH_MS
    case 'mcp':
      return MCP_FRESH_MS
  }
}

export function getPluginCenterSupplementalResource(
  api: DesktopPluginCenterApi,
  section: PluginCenterSupplementalSection,
  cwd?: string,
  threadId?: string
): PluginCenterResource<PluginCenterSnapshot> {
  const normalizedCwd = normalizeCwd(cwd)
  const normalizedThreadId = threadId?.trim() ?? ''
  const key = section === 'mcp' ? `${normalizedCwd}\u0000${normalizedThreadId}` : normalizedCwd
  const resources = resourcesForApi(api)
  const resourceMap = resources[section]
  const existing = resourceMap.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    kind: section,
    cwd: normalizedCwd,
    freshMs: supplementalFreshMs(section),
    load: async (forceRefresh) => {
      const result = await api.getSnapshot({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: normalizedCwd || undefined,
        threadId: section === 'mcp' ? normalizedThreadId || undefined : undefined,
        sections: [section],
        includePluginDetails: false,
        forceRefresh
      })
      return result.snapshot
    },
    onRelease: () => {
      resourceMap.delete(key)
    }
  })
  resourceMap.set(key, resource)
  evictOldestCwdResource(resourceMap)
  return resource
}

export function getPluginCenterCatalogResource(
  api: DesktopPluginCenterApi,
  cwd?: string
): PluginCenterResource<PluginCenterSnapshot> {
  const key = normalizeCwd(cwd)
  const resources = resourcesForApi(api)
  const existing = resources.catalog.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource<PluginCenterSnapshot>({
    kind: 'catalog',
    cwd: key,
    freshMs: (snapshot) => (snapshot.catalogUnavailableReason ? 0 : CATALOG_FRESH_MS),
    load: async (forceRefresh) => {
      const result = await api.getSnapshot({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: key || undefined,
        sections: ['plugins'],
        includePluginDetails: false,
        forceRefresh
      })
      return result.snapshot
    },
    onRelease: () => {
      resources.catalog.delete(key)
    }
  })
  resources.catalog.set(key, resource)
  evictOldestCwdResource(resources.catalog)
  return resource
}

export function getPluginCenterInstalledResource(
  api: DesktopPluginCenterApi,
  cwd?: string
): PluginCenterResource<PluginCenterPlugin[]> {
  const key = normalizeCwd(cwd)
  const resources = resourcesForApi(api)
  const existing = resources.installed.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    kind: 'installed',
    cwd: key,
    freshMs: INSTALLED_FRESH_MS,
    load: async () => {
      const result = await api.getInstalledPlugins({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: key || undefined
      })
      return result.plugins
    },
    onRelease: () => {
      resources.installed.delete(key)
    }
  })
  resources.installed.set(key, resource)
  evictOldestCwdResource(resources.installed)
  return resource
}

export function getPluginCenterPluginDetailResource(
  api: DesktopPluginCenterApi,
  plugin: { id: string; marketplaceId?: string },
  cwd?: string
): PluginCenterResource<PluginCenterGetPluginDetailResult> {
  const normalizedCwd = normalizeCwd(cwd)
  const key = `${normalizedCwd}\u0000${plugin.id}\u0000${plugin.marketplaceId ?? ''}`
  const resources = resourcesForApi(api)
  const existing = resources.details.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    kind: 'detail',
    cwd: normalizedCwd,
    freshMs: PLUGIN_DETAIL_FRESH_MS,
    load: (forceRefresh) =>
      api.getPluginDetail({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: normalizedCwd || undefined,
        plugin,
        forceRefresh
      }),
    onRelease: () => {
      resources.details.delete(key)
    }
  })
  resources.details.set(key, resource)
  evictOldestCwdResource(resources.details, MAX_PLUGIN_DETAIL_RESOURCES)
  return resource
}

export async function prefetchPluginCenterData(
  api: DesktopPluginCenterApi | null,
  cwd?: string
): Promise<void> {
  if (!api) return
  const catalog = getPluginCenterCatalogResource(api, cwd)
  const installed = getPluginCenterInstalledResource(api, cwd)
  await Promise.all([catalog.prefetch(), installed.prefetch()])
}

export function subscribePluginCenterData(
  api: DesktopPluginCenterApi | null,
  cwd: string | undefined,
  listener: () => void
): () => void {
  if (!api) return () => undefined
  const unsubscribeCatalog = getPluginCenterCatalogResource(api, cwd).subscribe(listener)
  const unsubscribeInstalled = getPluginCenterInstalledResource(api, cwd).subscribe(listener)
  return () => {
    unsubscribeCatalog()
    unsubscribeInstalled()
  }
}

export function mergePluginCatalogWithInstalled(
  catalog: PluginCenterPlugin[],
  installed: PluginCenterPlugin[]
): PluginCenterPlugin[] {
  const installedById = new Map(installed.map((plugin) => [plugin.id, plugin]))
  const merged = catalog.map((plugin) => {
    const installedPlugin = installedById.get(plugin.id)
    if (!installedPlugin) {
      return {
        ...plugin,
        installed: false,
        enabled: false,
        canInstall: plugin.restriction ? false : true,
        canToggle: false,
        canUninstall: false
      }
    }
    installedById.delete(plugin.id)
    return {
      ...plugin,
      installed: installedPlugin.installed,
      enabled: installedPlugin.enabled,
      canInstall: installedPlugin.canInstall,
      canToggle: installedPlugin.canToggle,
      canUninstall: installedPlugin.canUninstall,
      restriction: installedPlugin.restriction
    }
  })

  for (const plugin of installedById.values()) {
    merged.push({
      ...plugin,
      restriction:
        plugin.restriction ??
        ({
          code: 'unavailable',
          message: '所属插件市场当前不可用'
        } as const)
    })
  }
  return merged
}
