import type {
  DesktopPluginCenterApi,
  PluginCenterGetAppToolsResult,
  PluginCenterGetPluginDetailResult,
  PluginCenterGetRecommendedSkillsResult,
  PluginCenterGetSkillContentsResult,
  PluginCenterPlugin,
  PluginCenterSkillListMode,
  PluginCenterSnapshot,
  PluginCenterSnapshotSection
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'

const CATALOG_FRESH_MS = 6 * 60 * 60 * 1_000
const INSTALLED_FRESH_MS = 60_000
const SKILLS_FRESH_MS = 60_000
const APPS_FRESH_MS = 60_000
const MCP_FRESH_MS = 5 * 60_000
const PLUGIN_DETAIL_FRESH_MS = 30_000
const APP_TOOLS_FRESH_MS = 5 * 60_000
const RECOMMENDED_SKILLS_FRESH_MS = 5 * 60_000
const RESOURCE_GC_MS = 5 * 60_000
const MAX_CWD_RESOURCES = 3
const MAX_PLUGIN_DETAIL_RESOURCES = 20
const MAX_APP_TOOLS_RESOURCES = 40
const MAX_SKILL_CONTENTS_RESOURCES = 40

type ResourceStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PluginCenterSupplementalSection = Exclude<PluginCenterSnapshotSection, 'plugins'>

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
  update(updater: (data: T) => T): void
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
  appTools: Map<string, ResourceStore<PluginCenterGetAppToolsResult>>
  skillContents: Map<string, ResourceStore<PluginCenterGetSkillContentsResult>>
  recommendedSkills: Map<string, ResourceStore<PluginCenterGetRecommendedSkillsResult>>
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

function appToolsResourceKey(appId: string, cwd?: string, threadId?: string): string {
  return `${normalizeCwd(cwd)}\u0000${threadId?.trim() ?? ''}\u0000${appId}`
}

function skillContentsResourceKey(
  plugin: { id: string; marketplaceId?: string } | undefined,
  skill: { id: string },
  cwd?: string
): string {
  return `${normalizeCwd(cwd)}\u0000${plugin?.id ?? 'local'}\u0000${plugin?.marketplaceId ?? ''}\u0000${skill.id}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '读取插件中心失败'
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
    details: new Map(),
    appTools: new Map(),
    skillContents: new Map(),
    recommendedSkills: new Map()
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
  freshMs,
  load,
  onRelease
}: {
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
    if (!forceRefresh && isFresh()) return
    const requestGeneration = generation
    if (inFlight?.generation === requestGeneration) {
      await inFlight.promise
      return
    }

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
    update(updater) {
      if (snapshot.data === null) return
      snapshot = {
        ...snapshot,
        data: updater(snapshot.data),
        error: null,
        status: 'ready',
        updatedAt: now()
      }
      emit()
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

function unavailableMcpMessage(
  snapshot: PluginCenterSnapshot,
  section: PluginCenterSupplementalSection
): string | null {
  if (section !== 'mcp') return null
  const capability = snapshot.capabilities?.mcp
  if (!capability || capability.available) return null
  return capability.restriction?.message ?? '该数据源暂时不可用'
}

export function getPluginCenterSupplementalResource(
  api: DesktopPluginCenterApi,
  section: PluginCenterSupplementalSection,
  cwd?: string,
  skillListMode?: PluginCenterSkillListMode
): PluginCenterResource<PluginCenterSnapshot> {
  const normalizedCwd = normalizeCwd(cwd)
  const normalizedSkillListMode = section === 'skills' ? skillListMode : undefined
  const key = `${normalizedCwd}\u0000${normalizedSkillListMode ?? 'default'}`
  const resources = resourcesForApi(api)
  const resourceMap = resources[section]
  const existing = resourceMap.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    freshMs: supplementalFreshMs(section),
    load: async (forceRefresh) => {
      const request = {
        version: PLUGIN_CENTER_API_VERSION,
        cwd: normalizedCwd || undefined,
        sections: [section],
        includePluginDetails: false,
        ...(normalizedSkillListMode ? { skillListMode: normalizedSkillListMode } : {}),
        forceRefresh
      }
      let result = await api.getSnapshot(request)
      let unavailableMessage = unavailableMcpMessage(result.snapshot, section)
      if (unavailableMessage && !forceRefresh) {
        result = await api.getSnapshot({ ...request, forceRefresh: true })
        unavailableMessage = unavailableMcpMessage(result.snapshot, section)
      }
      if (unavailableMessage) throw new Error(unavailableMessage)
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
    freshMs: INSTALLED_FRESH_MS,
    load: async (forceRefresh) => {
      const result = await api.getInstalledPlugins({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: key || undefined,
        forceRefresh
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

export function getPluginCenterAppToolsResource(
  api: DesktopPluginCenterApi,
  appId: string,
  cwd?: string,
  threadId?: string
): PluginCenterResource<PluginCenterGetAppToolsResult> {
  const normalizedCwd = normalizeCwd(cwd)
  const normalizedThreadId = threadId?.trim() ?? ''
  const key = appToolsResourceKey(appId, normalizedCwd, normalizedThreadId)
  const resources = resourcesForApi(api)
  const existing = resources.appTools.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    freshMs: APP_TOOLS_FRESH_MS,
    load: (forceRefresh) =>
      api.getAppTools({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: normalizedCwd || undefined,
        threadId: normalizedThreadId || undefined,
        app: { id: appId },
        ...(forceRefresh ? { forceRefresh: true } : {})
      }),
    onRelease: () => {
      resources.appTools.delete(key)
    }
  })
  resources.appTools.set(key, resource)
  evictOldestCwdResource(resources.appTools, MAX_APP_TOOLS_RESOURCES)
  return resource
}

export function getPluginCenterSkillContentsResource(
  api: DesktopPluginCenterApi,
  plugin: { id: string; marketplaceId?: string } | undefined,
  skill: { id: string; name: string },
  cwd?: string
): PluginCenterResource<PluginCenterGetSkillContentsResult> {
  const normalizedCwd = normalizeCwd(cwd)
  const key = skillContentsResourceKey(plugin, skill, normalizedCwd)
  const resources = resourcesForApi(api)
  const existing = resources.skillContents.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    freshMs: APP_TOOLS_FRESH_MS,
    load: (forceRefresh) =>
      api.getSkillContents({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: normalizedCwd || undefined,
        ...(plugin ? { plugin } : {}),
        skill,
        ...(forceRefresh ? { forceRefresh: true } : {})
      }),
    onRelease: () => {
      resources.skillContents.delete(key)
    }
  })
  resources.skillContents.set(key, resource)
  evictOldestCwdResource(resources.skillContents, MAX_SKILL_CONTENTS_RESOURCES)
  return resource
}

/** Curated skills deliberately have a separate cache from skills/list. */
export function getPluginCenterRecommendedSkillsResource(
  api: DesktopPluginCenterApi
): PluginCenterResource<PluginCenterGetRecommendedSkillsResult> {
  const key = 'global'
  const resources = resourcesForApi(api)
  const existing = resources.recommendedSkills.get(key)
  if (existing) {
    existing.lastAccessedAt = now()
    return existing
  }

  const resource = createResource({
    freshMs: RECOMMENDED_SKILLS_FRESH_MS,
    load: (forceRefresh) =>
      api.getRecommendedSkills({
        version: PLUGIN_CENTER_API_VERSION,
        forceRefresh
      }),
    onRelease: () => {
      resources.recommendedSkills.delete(key)
    }
  })
  resources.recommendedSkills.set(key, resource)
  return resource
}

export function invalidatePluginCenterAppToolsResource(
  api: DesktopPluginCenterApi,
  appId: string,
  cwd?: string,
  threadId?: string
): void {
  const key = appToolsResourceKey(appId, cwd, threadId)
  resourcesByApi.get(api)?.appTools.get(key)?.invalidate()
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
      ...(installedPlugin.installedAt !== undefined
        ? { installedAt: installedPlugin.installedAt }
        : {}),
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

const BUNDLED_PLUGIN_MARKETPLACES = new Set(['openai-bundled', 'openai-primary-runtime'])

const BROWSER_EXTENSION_PLUGIN_NAMES = new Set(['chrome', 'chrome-dev', 'chrome-internal'])
const BROWSER_EXTENSION_UNIFICATION_ENABLED = true

function pluginMarketplace(plugin: PluginCenterPlugin): string | undefined {
  return plugin.marketplaceId ?? plugin.marketplaceName
}

function isVisibleInstalledPlugin(plugin: PluginCenterPlugin): boolean {
  const marketplace = pluginMarketplace(plugin)
  if (marketplace === 'openai-bundled' && plugin.name === 'codex-app-tools') return false
  if (BROWSER_EXTENSION_UNIFICATION_ENABLED && BROWSER_EXTENSION_PLUGIN_NAMES.has(plugin.name)) {
    return false
  }
  return true
}

function installedPluginDisplayGroup(plugin: PluginCenterPlugin): number {
  if (plugin.restriction?.code === 'policy') return 2
  const marketplaceId = pluginMarketplace(plugin)
  if (marketplaceId && BUNDLED_PLUGIN_MARKETPLACES.has(marketplaceId)) return 1
  return 0
}

/**
 * Mirrors the reference app's installed-plugin visibility and stable ordering.
 * Installation time owns the primary order with installed-list order as the
 * stable fallback, then bundled and admin-disabled plugins move to the end.
 */
export function mergeInstalledPluginsForDisplay(
  catalog: PluginCenterPlugin[],
  installed: PluginCenterPlugin[]
): PluginCenterPlugin[] {
  const mergedById = new Map(
    mergePluginCatalogWithInstalled(catalog, installed).map((plugin) => [plugin.id, plugin])
  )
  const orderedInstalledById = new Map<string, PluginCenterPlugin>()
  for (const installedPlugin of installed) {
    orderedInstalledById.set(
      installedPlugin.id,
      mergedById.get(installedPlugin.id) ?? installedPlugin
    )
  }

  const plugins = Array.from(orderedInstalledById.values()).filter(
    (plugin) => plugin.installed && isVisibleInstalledPlugin(plugin)
  )

  return plugins
    .sort((left, right) => (right.installedAt ?? 0) - (left.installedAt ?? 0))
    .sort((left, right) => installedPluginDisplayGroup(left) - installedPluginDisplayGroup(right))
}
