import * as React from 'react'
import {
  AppWindowIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  DatabaseIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PlugIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon
} from 'lucide-react'
import { toast } from 'sonner'

import type {
  DesktopPluginCenterApi,
  PluginCenterAddMarketplaceResult,
  PluginCenterApp,
  PluginCenterGetPluginDetailResult,
  PluginCenterMcpServerInput,
  PluginCenterMutationResult,
  PluginCenterNamedSecretPatch,
  PluginCenterPlugin,
  PluginCenterPluginDetail,
  PluginCenterPluginMcpServer,
  PluginCenterRequestContext,
  PluginCenterSnapshotSection,
  PluginCenterSkill,
  PluginCenterSnapshot,
  PluginCenterUserMcpServer
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Toaster } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { OptimisticSkillSwitch } from './OptimisticSkillSwitch'
import { PluginImage } from './PluginImage'
import {
  getPluginCenterCatalogResource,
  getPluginCenterAppToolsResource,
  getPluginCenterInstalledResource,
  getPluginCenterPluginDetailResource,
  getPluginCenterSupplementalResource,
  invalidatePluginCenterAppToolsResource,
  mergePluginCatalogWithInstalled,
  type PluginCenterResource,
  type PluginCenterResourceSnapshot,
  type PluginCenterSupplementalSection
} from './pluginCenterDataResource'
import { PluginAppToolsDialog } from './PluginAppToolsDialog'
import { PluginDetailPage } from './PluginDetailPage'

export type PluginCenterPageKind = 'browse' | 'manage' | 'detail'
export type PluginCenterBrowseTab = 'plugins' | 'skills'
export type PluginCenterManageTab = 'plugins' | 'apps' | 'mcp' | 'skills'
export type PluginCenterTab = PluginCenterBrowseTab | PluginCenterManageTab

export type PluginCenterBrowseContext = {
  tab: PluginCenterBrowseTab
  category?: string
  search?: string
  scrollTop?: number
}

export type PluginCenterSurface =
  | ({ page: 'browse' } & PluginCenterBrowseContext)
  | { page: 'manage'; tab: PluginCenterManageTab }
  | {
      page: 'detail'
      pluginRef: { id: string; marketplaceId?: string }
      pluginName?: string
      returnTo?: PluginCenterBrowseContext
    }

export type PluginCenterPageProps = {
  surface: PluginCenterSurface
  onSurfaceChange: (surface: PluginCenterSurface) => void
  cwd?: string
  threadId?: string
  api?: DesktopPluginCenterApi
  onActivatePluginPrompt?: (input: {
    mention: { path: string; name: string }
    prompt: string
  }) => void
  onTryApp?: (input: { mention: { path: string; name: string } }) => void
}

type MutationStatus = { id: string; label: string } | null
type MutationOptions = {
  refreshInBackground?: boolean
  isSuccessful?: (result: PluginCenterMutationResult) => boolean
}
type BrowsePluginsLoadingState = {
  catalog: boolean
  installed: boolean
}
type ConfirmState =
  | { kind: 'plugin'; plugin: PluginCenterPlugin }
  | { kind: 'mcp'; server: PluginCenterUserMcpServer }
  | null
const FEATURED_CATEGORY_ID = '__featured__'
const CATEGORY_PREVIEW_LIMIT = 6
const MORE_PLUGIN_PREVIEW_LIMIT = 3

function logPluginCenterPerformance(
  event: string,
  details: Record<string, string | number | boolean>
): void {
  console.info(`[plugin-center:perf:${event}]`, { atMs: Date.now(), ...details })
}

const emptySnapshot: PluginCenterSnapshot = {
  version: PLUGIN_CENTER_API_VERSION,
  generatedAt: new Date(0).toISOString(),
  plugins: [],
  skills: [],
  apps: [],
  mcp: { userServers: [], pluginServers: [] },
  marketplaces: []
}

function mergeSnapshotCapabilities(
  current: PluginCenterSnapshot['capabilities'],
  incoming: PluginCenterSnapshot['capabilities'],
  included: Set<PluginCenterSnapshotSection>
): PluginCenterSnapshot['capabilities'] {
  if (!incoming) return current

  return {
    plugins: included.has('plugins') ? incoming.plugins : (current?.plugins ?? incoming.plugins),
    skills: included.has('skills') ? incoming.skills : (current?.skills ?? incoming.skills),
    apps: included.has('apps') ? incoming.apps : (current?.apps ?? incoming.apps),
    mcp: included.has('mcp') ? incoming.mcp : (current?.mcp ?? incoming.mcp)
  }
}

function mergeSnapshotSections(
  current: PluginCenterSnapshot,
  incoming: PluginCenterSnapshot,
  sections: PluginCenterSnapshotSection[]
): PluginCenterSnapshot {
  const included = new Set(sections)
  const capabilities = mergeSnapshotCapabilities(
    current.capabilities,
    incoming.capabilities,
    included
  )
  const merged: PluginCenterSnapshot = {
    ...current,
    generatedAt: incoming.generatedAt,
    plugins: included.has('plugins') ? incoming.plugins : current.plugins,
    skills: included.has('skills') ? incoming.skills : current.skills,
    apps: included.has('apps') ? incoming.apps : current.apps,
    mcp: included.has('mcp') ? incoming.mcp : current.mcp,
    marketplaces: included.has('plugins') ? incoming.marketplaces : current.marketplaces,
    ...(capabilities ? { capabilities } : {})
  }

  if (included.has('plugins')) {
    if (incoming.catalogUnavailableReason) {
      merged.catalogUnavailableReason = incoming.catalogUnavailableReason
    } else {
      delete merged.catalogUnavailableReason
    }
  }

  return merged
}

function getPluginCenterApi(api?: DesktopPluginCenterApi): DesktopPluginCenterApi | null {
  if (api) return api
  const desktopApp = window.desktopApp as typeof window.desktopApp & {
    plugins?: DesktopPluginCenterApi
  }
  return desktopApp.plugins ?? null
}

function itemTitle(item: { displayName?: string; name: string }): string {
  return item.displayName ?? item.name
}

function itemDescription(item: { description?: string }): string {
  return item.description ?? '暂无说明'
}

function matchesSearch(
  item: { id: string; name: string; displayName?: string; description?: string; tags?: string[] },
  search: string
): boolean {
  const query = search.trim().toLowerCase()
  if (!query) return true
  return [item.id, item.name, item.displayName, item.description, ...(item.tags ?? [])]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query))
}

function sourceLabel(sourceKind: string): string {
  switch (sourceKind) {
    case 'builtin':
      return '内置'
    case 'personal':
      return '个人'
    case 'marketplace':
      return '市场'
    case 'local':
      return '本地'
    default:
      return '未知来源'
  }
}

function scopeLabel(scope: PluginCenterSkill['scope']): string {
  switch (scope) {
    case 'personal':
      return '个人'
    case 'workspace':
      return '工作区'
    case 'project':
      return '项目'
    case 'plugin':
      return '插件'
    case 'system':
      return '系统'
    default:
      return '未知'
  }
}

function authLabel(status: string): string {
  switch (status) {
    case 'notLoggedIn':
      return '未登录'
    case 'bearerToken':
      return 'Token'
    case 'oAuth':
      return 'OAuth'
    case 'unsupported':
      return '无需认证'
    default:
      return '认证未知'
  }
}

function resolveManageTab(tab: PluginCenterTab): PluginCenterManageTab {
  if (tab === 'apps' || tab === 'mcp' || tab === 'skills') return tab
  return 'plugins'
}

function snapshotSectionsForSurface(surface: PluginCenterSurface): PluginCenterSnapshotSection[] {
  if (surface.page === 'detail') return []
  if (surface.page === 'browse') return surface.tab === 'skills' ? ['skills'] : []
  if (surface.tab === 'apps' || surface.tab === 'mcp' || surface.tab === 'skills') {
    return [surface.tab]
  }
  return []
}

function resolveContentView({
  surface,
  browseTab,
  manageTab,
  snapshot,
  search,
  mutation,
  requestContext,
  api,
  runMutation,
  setMcpDialog,
  setConfirm,
  onManageInstalledPlugins,
  onConnectApp,
  onOpenCategory,
  onOpenDetails,
  browsePluginsLoading
}: {
  surface: PluginCenterSurface
  browseTab: PluginCenterBrowseTab
  manageTab: PluginCenterManageTab
  snapshot: PluginCenterSnapshot
  search: string
  mutation: MutationStatus
  requestContext: PluginCenterRequestContext
  api: DesktopPluginCenterApi | null
  runMutation: (
    id: string,
    label: string,
    action: () => Promise<PluginCenterMutationResult>,
    options?: MutationOptions
  ) => Promise<boolean>
  setMcpDialog: React.Dispatch<React.SetStateAction<McpDialogState>>
  setConfirm: React.Dispatch<React.SetStateAction<ConfirmState>>
  onManageInstalledPlugins: () => void
  onConnectApp: (app: PluginCenterApp) => void
  onOpenCategory: (category: string) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
  browsePluginsLoading: BrowsePluginsLoadingState
}): React.ReactNode {
  if (surface.page === 'browse' && browseTab === 'plugins') {
    return (
      <BrowsePlugins
        plugins={snapshot.plugins.filter((item) => matchesSearch(item, search))}
        category={surface.category}
        catalogUnavailableReason={snapshot.catalogUnavailableReason}
        loading={browsePluginsLoading}
        pendingId={mutation?.id}
        onInstall={(plugin) =>
          void runMutation(plugin.id, '安装插件', () =>
            api!.installPlugin({
              ...requestContext,
              plugin: { id: plugin.id, marketplaceId: plugin.marketplaceId }
            })
          )
        }
        onToggle={(plugin, enabled) =>
          void runMutation(plugin.id, enabled ? '启用插件' : '停用插件', () =>
            api!.setPluginEnabled({ ...requestContext, plugin: { id: plugin.id }, enabled })
          )
        }
        onUninstall={(plugin) => setConfirm({ kind: 'plugin', plugin })}
        onManageInstalledPlugins={onManageInstalledPlugins}
        onOpenCategory={onOpenCategory}
        onOpenDetails={onOpenDetails}
      />
    )
  }

  if (surface.page === 'browse') {
    return (
      <BrowseSkills
        skills={snapshot.skills.filter((item) => matchesSearch(item, search))}
        pendingId={mutation?.id}
        onToggle={(skill, enabled) =>
          runMutation(
            skill.id,
            enabled ? '启用技能' : '停用技能',
            () => api!.setSkillEnabled({ ...requestContext, skill: { id: skill.id }, enabled }),
            { refreshInBackground: true }
          )
        }
      />
    )
  }

  return (
    <ManagePanel
      tab={manageTab}
      snapshot={snapshot}
      search={search}
      pendingId={mutation?.id}
      onPluginToggle={(plugin, enabled) =>
        void runMutation(plugin.id, enabled ? '启用插件' : '停用插件', () =>
          api!.setPluginEnabled({ ...requestContext, plugin: { id: plugin.id }, enabled })
        )
      }
      onPluginUninstall={(plugin) => setConfirm({ kind: 'plugin', plugin })}
      onConnectApp={onConnectApp}
      onAppToggle={(app, enabled) =>
        void runMutation(app.id, enabled ? '启用应用' : '停用应用', () =>
          api!.setAppEnabled({ ...requestContext, app: { id: app.id }, enabled })
        )
      }
      onSkillToggle={(skill, enabled) =>
        runMutation(
          skill.id,
          enabled ? '启用技能' : '停用技能',
          () => api!.setSkillEnabled({ ...requestContext, skill: { id: skill.id }, enabled }),
          { refreshInBackground: true }
        )
      }
      onMcpToggle={(server, enabled) =>
        void runMutation(server.id, enabled ? '启用 MCP' : '停用 MCP', () =>
          api!.setMcpServerEnabled({ ...requestContext, server: { id: server.id }, enabled })
        )
      }
      onMcpEdit={(server) => setMcpDialog({ open: true, server })}
      onMcpRemove={(server) => setConfirm({ kind: 'mcp', server })}
      onOpenDetails={onOpenDetails}
    />
  )
}

function parseMultilineList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((part) => part.trim())
        .filter(Boolean)
    )
  ]
}

function parseArgs(value: string): string[] {
  return value
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
}

function parseKeyValues(value: string): Array<{ name: string; value: string }> {
  return value
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=')
      if (index < 0) return null
      const name = line.slice(0, index).trim()
      const secretValue = line.slice(index + 1).trim()
      if (!name || !secretValue) return null
      return { name, value: secretValue }
    })
    .filter((entry): entry is { name: string; value: string } => entry !== null)
}

function buildSecretPatches(
  actions: SecretActions,
  setValues: Array<{ name: string; value: string }>
): PluginCenterNamedSecretPatch[] {
  const patches = Object.entries(actions).map<PluginCenterNamedSecretPatch>(([name, action]) => ({
    name,
    value: { action }
  }))
  for (const entry of setValues) {
    const index = patches.findIndex((patch) => patch.name === entry.name)
    const patch = { name: entry.name, value: { action: 'set' as const, value: entry.value } }
    if (index >= 0) patches[index] = patch
    else patches.push(patch)
  }
  return patches
}

function secretKeepActions(
  entries: Array<{ name: string; hasValue: boolean; editable: boolean }>
): SecretActions {
  return Object.fromEntries(entries.map((entry) => [entry.name, 'keep' as const]))
}

function initialMcpFormKey(editing: PluginCenterUserMcpServer | null): string {
  if (!editing) return ''
  if (editing.transport === 'stdio') {
    return JSON.stringify({
      transport: 'stdio',
      displayName: editing.displayName ?? editing.name,
      command: editing.command ?? '',
      args: editing.args.join('\n'),
      cwd: editing.cwd ?? '',
      envVars: editing.envVars
        .filter((entry) => entry.editable)
        .map((entry) => entry.name)
        .join('\n'),
      envSecretActions: secretKeepActions(editing.env)
    })
  }
  return JSON.stringify({
    transport: 'streamable-http',
    displayName: editing.displayName ?? editing.name,
    url: editing.url ?? '',
    bearerTokenEnvVar: editing.bearerTokenEnvVar ?? '',
    envHttpHeaders: editing.envHttpHeaders
      .map((entry) => `${entry.name}=${entry.envVarName}`)
      .join('\n'),
    httpSecretActions: secretKeepActions(editing.httpHeaders)
  })
}

const emptyResourceSnapshot = {
  data: null,
  error: null,
  status: 'idle',
  isRefreshing: false,
  updatedAt: 0
} as const

function usePluginCenterResource<T>(
  resource: PluginCenterResource<T> | null,
  enabled: boolean
): PluginCenterResourceSnapshot<T> {
  const subscribe = React.useCallback(
    (listener: () => void) => {
      if (!enabled || !resource) return () => undefined
      return resource.subscribe(listener)
    },
    [enabled, resource]
  )
  const getSnapshot = React.useCallback(
    () => resource?.getSnapshot() ?? emptyResourceSnapshot,
    [resource]
  )
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  React.useEffect(() => {
    if (!enabled || !resource) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void resource.prefetch()
    })
    return () => {
      cancelled = true
    }
  }, [enabled, resource])

  return snapshot
}

function activeSupplementalSection(
  sections: PluginCenterSnapshotSection[]
): PluginCenterSupplementalSection | null {
  for (const section of sections) {
    if (section !== 'plugins') return section
  }
  return null
}

function isInitialResourceLoading<T>(state: PluginCenterResourceSnapshot<T>): boolean {
  return state.data === null && (state.status === 'idle' || state.status === 'loading')
}

export function PluginCenterPage({
  surface,
  onSurfaceChange,
  cwd,
  threadId,
  api: apiProp,
  onActivatePluginPrompt,
  onTryApp
}: PluginCenterPageProps): React.JSX.Element {
  const api = React.useMemo(() => getPluginCenterApi(apiProp), [apiProp])
  const snapshotSections = React.useMemo(() => snapshotSectionsForSurface(surface), [surface])
  const isDetailSurface = surface.page === 'detail'
  const usesPluginResources = !isDetailSurface && snapshotSections.length === 0
  const catalogResource = React.useMemo(
    () => (api ? getPluginCenterCatalogResource(api, cwd) : null),
    [api, cwd]
  )
  const installedResource = React.useMemo(
    () => (api ? getPluginCenterInstalledResource(api, cwd) : null),
    [api, cwd]
  )
  const skillsResource = React.useMemo(
    () => (api ? getPluginCenterSupplementalResource(api, 'skills', cwd) : null),
    [api, cwd]
  )
  const appsResource = React.useMemo(
    () => (api ? getPluginCenterSupplementalResource(api, 'apps', cwd) : null),
    [api, cwd]
  )
  const mcpResource = React.useMemo(
    () => (api ? getPluginCenterSupplementalResource(api, 'mcp', cwd, threadId) : null),
    [api, cwd, threadId]
  )
  const detailResource = React.useMemo(
    () =>
      api && surface.page === 'detail'
        ? getPluginCenterPluginDetailResource(api, surface.pluginRef, cwd)
        : null,
    [api, cwd, surface]
  )
  const supplementalSection = activeSupplementalSection(snapshotSections)
  const catalogState = usePluginCenterResource(catalogResource, usesPluginResources)
  const installedState = usePluginCenterResource(installedResource, usesPluginResources)
  const skillsState = usePluginCenterResource(skillsResource, supplementalSection === 'skills')
  const appsState = usePluginCenterResource(appsResource, supplementalSection === 'apps')
  const mcpState = usePluginCenterResource(mcpResource, supplementalSection === 'mcp')
  const detailState = usePluginCenterResource(detailResource, isDetailSurface)
  const [selectedAppId, setSelectedAppId] = React.useState<string | null>(null)
  const selectedApp = React.useMemo<PluginCenterPluginDetail['apps'][number] | null>(() => {
    const result = detailState.data
    if (!selectedAppId || result?.status !== 'ready') return null
    return result.detail.apps.find((app) => app.id === selectedAppId) ?? null
  }, [detailState.data, selectedAppId])
  const appToolsResource = React.useMemo(
    () =>
      api && selectedApp
        ? getPluginCenterAppToolsResource(api, selectedApp.id, cwd, threadId)
        : null,
    [api, cwd, selectedApp, threadId]
  )
  const appToolsState = usePluginCenterResource(appToolsResource, selectedApp !== null)
  const supplementalSnapshot = React.useMemo(() => {
    let merged = emptySnapshot
    if (skillsState.data) merged = mergeSnapshotSections(merged, skillsState.data, ['skills'])
    if (appsState.data) merged = mergeSnapshotSections(merged, appsState.data, ['apps'])
    if (mcpState.data) merged = mergeSnapshotSections(merged, mcpState.data, ['mcp'])
    return merged
  }, [appsState.data, mcpState.data, skillsState.data])
  const loadedSections = React.useMemo(() => {
    const loaded = new Set<PluginCenterSnapshotSection>()
    if (skillsState.data) loaded.add('skills')
    if (appsState.data) loaded.add('apps')
    if (mcpState.data) loaded.add('mcp')
    return loaded
  }, [appsState.data, mcpState.data, skillsState.data])
  let supplementalState: PluginCenterResourceSnapshot<PluginCenterSnapshot> = emptyResourceSnapshot
  switch (supplementalSection) {
    case 'skills':
      supplementalState = skillsState
      break
    case 'apps':
      supplementalState = appsState
      break
    case 'mcp':
      supplementalState = mcpState
      break
  }
  const snapshot = React.useMemo<PluginCenterSnapshot>(() => {
    const catalog = catalogState.data
    const plugins =
      installedState.data === null
        ? (catalog?.plugins ?? [])
        : mergePluginCatalogWithInstalled(catalog?.plugins ?? [], installedState.data)
    return {
      ...supplementalSnapshot,
      generatedAt: catalog?.generatedAt ?? supplementalSnapshot.generatedAt,
      plugins,
      marketplaces: catalog?.marketplaces ?? supplementalSnapshot.marketplaces,
      ...(catalog?.catalogUnavailableReason
        ? { catalogUnavailableReason: catalog.catalogUnavailableReason }
        : {})
    }
  }, [catalogState.data, installedState.data, supplementalSnapshot])
  const hasVisiblePluginData = catalogState.data !== null || (installedState.data?.length ?? 0) > 0
  const catalogLoading = isInitialResourceLoading(catalogState)
  const installedLoading = isInitialResourceLoading(installedState)
  let loading = isInitialResourceLoading(supplementalState)
  let refreshing = supplementalState.isRefreshing
  let error = supplementalState.error
  if (usesPluginResources) {
    loading = catalogLoading || installedLoading
    refreshing = catalogState.isRefreshing || installedState.isRefreshing
    error = catalogState.error ?? installedState.error
  }
  if (isDetailSurface) {
    loading = isInitialResourceLoading(detailState)
    refreshing = detailState.isRefreshing
    error = detailState.error
  }
  const [manageSearch, setManageSearch] = React.useState('')
  const [browseSearchDraft, setBrowseSearchDraft] = React.useState(
    surface.page === 'browse' ? (surface.search ?? '') : ''
  )
  const search = surface.page === 'browse' ? (surface.search ?? browseSearchDraft) : manageSearch
  const [mutation, setMutation] = React.useState<MutationStatus>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(false)
  const [mcpDialog, setMcpDialog] = React.useState<McpDialogState>({ open: false, server: null })
  const [confirm, setConfirm] = React.useState<ConfirmState>(null)
  const [browseScrollTop, setBrowseScrollTop] = React.useState(0)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)

  const requestContext = React.useMemo<PluginCenterRequestContext>(
    () => ({ version: PLUGIN_CENTER_API_VERSION, cwd, threadId }),
    [cwd, threadId]
  )

  const supplementalResourceForSection = React.useCallback(
    (
      section: PluginCenterSupplementalSection
    ): PluginCenterResource<PluginCenterSnapshot> | null => {
      switch (section) {
        case 'skills':
          return skillsResource
        case 'apps':
          return appsResource
        case 'mcp':
          return mcpResource
      }
    },
    [appsResource, mcpResource, skillsResource]
  )

  const refreshSupplementalSections = React.useCallback(
    async (
      sections: PluginCenterSupplementalSection[],
      forceRefresh: boolean,
      invalidate: boolean
    ): Promise<void> => {
      const readbacks: Promise<void>[] = []
      for (const section of sections) {
        const resource = supplementalResourceForSection(section)
        if (!resource) continue
        if (invalidate) resource.invalidate()
        readbacks.push(resource.refresh(forceRefresh))
      }
      await Promise.all(readbacks)
    },
    [supplementalResourceForSection]
  )

  const refresh = React.useCallback(
    async (forceRefresh = true): Promise<void> => {
      if (isDetailSurface) {
        await detailResource?.refresh(forceRefresh)
        return
      }
      if (usesPluginResources) {
        await Promise.all([
          catalogResource?.refresh(forceRefresh),
          installedResource?.refresh(forceRefresh)
        ])
        return
      }
      if (supplementalSection) {
        await refreshSupplementalSections([supplementalSection], forceRefresh, false)
      }
    },
    [
      catalogResource,
      detailResource,
      installedResource,
      isDetailSurface,
      refreshSupplementalSections,
      supplementalSection,
      usesPluginResources
    ]
  )

  const applyMutationResult = React.useCallback(
    async (result: PluginCenterMutationResult, fallbackChangedItemId?: string): Promise<void> => {
      const changedSections = new Set(result.changedSections)
      const changedItemId = result.changedItemId ?? fallbackChangedItemId
      const readbacks: Promise<void>[] = []
      if (changedSections.has('installed') && installedResource) {
        installedResource.invalidate()
        readbacks.push(installedResource.refresh(true))
      }
      if (changedSections.has('catalog') && catalogResource) {
        catalogResource.invalidate()
        void catalogResource.refresh(true)
      }
      if (detailResource) {
        detailResource.invalidate()
        readbacks.push(detailResource.refresh(true))
      }
      if (changedSections.has('apps') && api && changedItemId) {
        invalidatePluginCenterAppToolsResource(api, changedItemId, cwd, threadId)
        if (appToolsResource && selectedAppId === changedItemId) {
          readbacks.push(appToolsResource.refresh(true))
        }
      }
      const supplementalSections: PluginCenterSupplementalSection[] = []
      for (const section of changedSections) {
        if (section === 'skills' || section === 'apps' || section === 'mcp') {
          supplementalSections.push(section)
        }
      }
      if (supplementalSections.length > 0) {
        readbacks.push(refreshSupplementalSections(supplementalSections, true, true))
      }
      await Promise.all(readbacks)
    },
    [
      appToolsResource,
      api,
      catalogResource,
      cwd,
      detailResource,
      installedResource,
      refreshSupplementalSections,
      selectedAppId,
      threadId
    ]
  )

  const rendererStartedAt = React.useRef<number | null>(null)
  const contentReadyLogged = React.useRef(false)
  React.useEffect(() => {
    rendererStartedAt.current = performance.now()
    contentReadyLogged.current = false
    logPluginCenterPerformance('renderer-start', {
      sections: usesPluginResources ? 'catalog,installed' : snapshotSections.join(','),
      includePluginDetails: false,
      forceRefresh: false,
      hasCwd: Boolean(cwd),
      hasThreadId: Boolean(threadId)
    })
  }, [cwd, snapshotSections, threadId, usesPluginResources])
  React.useEffect(() => {
    if (loading || contentReadyLogged.current) return
    contentReadyLogged.current = true
    const startedAt = rendererStartedAt.current ?? performance.now()
    logPluginCenterPerformance('renderer-content-ready', {
      durationMs: Math.round(performance.now() - startedAt),
      pluginCount: snapshot.plugins.length,
      skillCount: snapshot.skills.length,
      appCount: snapshot.apps.length,
      mcpServerCount: snapshot.mcp.userServers.length + snapshot.mcp.pluginServers.length,
      hasCwd: Boolean(cwd),
      hasThreadId: Boolean(threadId)
    })
  }, [cwd, loading, snapshot, threadId])

  const runMutation = React.useCallback(
    async (
      id: string,
      label: string,
      action: () => Promise<PluginCenterMutationResult>,
      options: MutationOptions = {}
    ): Promise<boolean> => {
      if (!api) return false
      setMutation({ id, label })
      setActionError(null)
      try {
        const result = await action()
        if (options.refreshInBackground) {
          void applyMutationResult(result, id)
        } else {
          await applyMutationResult(result, id)
        }
        if (result.status === 'overridden' || result.status === 'partial') {
          toast.warning(result.message ?? `${label}需要重新确认`)
        } else {
          toast.success(result.message ?? `${label}完成`)
        }
        return options.isSuccessful?.(result) ?? true
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : `${label}失败`
        setActionError(message)
        toast.error(message)
        return false
      } finally {
        setMutation(null)
      }
    },
    [api, applyMutationResult, setActionError, setMutation]
  )

  const openExternal = React.useCallback(async (url: string): Promise<boolean> => {
    try {
      await window.desktopApp.codex.openExternalHttpUrl(url)
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法打开安全外链'
      toast.error(message)
      return false
    }
  }, [])

  const [awaitingAppConnectionId, setAwaitingAppConnectionId] = React.useState<string | null>(null)
  const openAppExternal = React.useCallback(
    async (app: { id: string }, url: string): Promise<void> => {
      if (await openExternal(url)) setAwaitingAppConnectionId(app.id)
    },
    [openExternal]
  )
  const connectApp = React.useCallback(
    async (app: PluginCenterPluginDetail['apps'][number]): Promise<void> => {
      if (app.accessible) {
        if (!app.enabled) {
          await runMutation(app.id, '启用应用', () =>
            api!.setAppEnabled({ ...requestContext, app: { id: app.id }, enabled: true })
          )
        }
        return
      }
      if (app.restriction?.editable === false || !app.installUrl) return
      if (!app.enabled && app.canToggle) {
        const enabled = await runMutation(
          app.id,
          '启用应用',
          () => api!.setAppEnabled({ ...requestContext, app: { id: app.id }, enabled: true }),
          { isSuccessful: (result) => result.status === 'applied' }
        )
        if (!enabled) return
      }
      await openAppExternal(app, app.installUrl)
    },
    [api, openAppExternal, requestContext, runMutation]
  )

  const reconnectApp = React.useCallback(
    (app: PluginCenterPluginDetail['apps'][number]): void => {
      if (app.installUrl) void openAppExternal(app, app.installUrl)
    },
    [openAppExternal]
  )

  const disconnectApp = React.useCallback(
    (app: PluginCenterPluginDetail['apps'][number]): void => {
      if (app.settingsUrl) void openAppExternal(app, app.settingsUrl)
    },
    [openAppExternal]
  )

  React.useEffect(() => {
    const refreshAfterConnection = (): void => {
      if (!awaitingAppConnectionId) return
      if (api) {
        invalidatePluginCenterAppToolsResource(api, awaitingAppConnectionId, cwd, threadId)
      }
      setAwaitingAppConnectionId(null)
      void refresh(true)
    }
    window.addEventListener('focus', refreshAfterConnection)
    return () => window.removeEventListener('focus', refreshAfterConnection)
  }, [api, awaitingAppConnectionId, cwd, refresh, threadId])

  const browseContext: PluginCenterBrowseContext =
    surface.page === 'browse'
      ? {
          tab: surface.tab,
          ...(surface.category ? { category: surface.category } : {}),
          search: surface.search ?? '',
          scrollTop: surface.scrollTop ?? 0
        }
      : { tab: 'plugins', search: '', scrollTop: 0 }
  const navigateBrowse = (
    tab: PluginCenterBrowseTab,
    category?: string,
    search = browseContext.search ?? ''
  ): void => {
    onSurfaceChange({
      page: 'browse',
      tab,
      ...(category ? { category } : {}),
      search,
      scrollTop: 0
    })
  }
  const navigateManage = (tab: PluginCenterManageTab): void => {
    onSurfaceChange({ page: 'manage', tab })
  }
  const currentBrowseTab: PluginCenterBrowseTab =
    surface.page === 'browse' && surface.tab === 'skills' ? 'skills' : 'plugins'
  const currentManageTab = surface.page === 'manage' ? resolveManageTab(surface.tab) : 'plugins'
  const selectedCategoryTitle = categoryTitle(
    surface.page === 'browse' ? surface.category : undefined
  )
  let headerNavigation: React.ReactNode = null
  if (surface.page === 'browse' && surface.category && currentBrowseTab === 'plugins') {
    headerNavigation = (
      <nav data-slot="plugin-category-breadcrumb" className="flex items-center gap-2 text-sm">
        <button
          type="button"
          className="font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => navigateBrowse('plugins')}
        >
          插件
        </button>
        <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium">{selectedCategoryTitle}</span>
      </nav>
    )
  } else if (surface.page === 'browse') {
    headerNavigation = (
      <Tabs
        value={currentBrowseTab}
        onValueChange={(value) => navigateBrowse(value as PluginCenterBrowseTab)}
      >
        <TabsList>
          <TabsTrigger value="plugins">插件</TabsTrigger>
          <TabsTrigger value="skills">技能</TabsTrigger>
        </TabsList>
      </Tabs>
    )
  }
  const separatesPluginLoading = surface.page === 'browse' && currentBrowseTab === 'plugins'
  const catalogWarning =
    usesPluginResources && hasVisiblePluginData && !error
      ? snapshot.catalogUnavailableReason
      : undefined
  const contentView =
    loading && !separatesPluginLoading ? (
      <PluginCategoriesSkeleton />
    ) : (
      resolveContentView({
        surface,
        browseTab: currentBrowseTab,
        manageTab: currentManageTab,
        snapshot,
        search,
        mutation,
        requestContext,
        api,
        runMutation,
        setMcpDialog,
        setConfirm,
        onManageInstalledPlugins: () => navigateManage('plugins'),
        onConnectApp: (app) => {
          if (app.installUrl) void openAppExternal(app, app.installUrl)
        },
        onOpenCategory: (category) => navigateBrowse('plugins', category),
        onOpenDetails: (plugin) =>
          onSurfaceChange({
            page: 'detail',
            pluginRef: { id: plugin.id, marketplaceId: plugin.marketplaceId },
            pluginName: itemTitle(plugin),
            returnTo: {
              ...browseContext,
              scrollTop: browseScrollTop
            }
          }),
        browsePluginsLoading: { catalog: catalogLoading, installed: installedLoading }
      })
    )

  React.useEffect(() => {
    if (surface.page !== 'browse') return
    const scrollTop = surface.scrollTop ?? 0
    const frame = window.requestAnimationFrame(() => {
      scrollViewportRef.current?.scrollTo?.({ top: scrollTop })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [surface])

  const ensurePluginReadyForPrompt = React.useCallback(
    async (detail: PluginCenterGetPluginDetailResult & { status: 'ready' }, prompt: string) => {
      if (!api || mutation) return
      setMutation({ id: detail.detail.plugin.id, label: '准备插件' })
      setActionError(null)
      try {
        let current = detail.detail
        if (!current.plugin.installed) {
          await applyMutationResult(
            await api.installPlugin({
              ...requestContext,
              plugin: {
                id: current.plugin.id,
                marketplaceId: current.plugin.marketplaceId
              }
            })
          )
          const refreshed = detailResource?.getSnapshot().data
          if (refreshed?.status === 'ready') current = refreshed.detail
        }
        if (!current.plugin.installed) throw new Error('插件安装后未能确认状态')
        if (!current.plugin.enabled) {
          await applyMutationResult(
            await api.setPluginEnabled({
              ...requestContext,
              plugin: { id: current.plugin.id },
              enabled: true
            })
          )
          const refreshed = detailResource?.getSnapshot().data
          if (refreshed?.status === 'ready') current = refreshed.detail
        }
        if (!current.plugin.enabled) throw new Error('插件启用后未能确认状态')
        onActivatePluginPrompt?.({ mention: current.mention, prompt })
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : '准备插件失败'
        setActionError(message)
        toast.error(message)
      } finally {
        setMutation(null)
      }
    },
    [
      api,
      applyMutationResult,
      detailResource,
      mutation,
      onActivatePluginPrompt,
      requestContext,
      setActionError,
      setMutation
    ]
  )

  if (isDetailSurface) {
    const detailResult = detailState.data
    const returnTo = surface.returnTo ?? { tab: 'plugins' as const, search: '', scrollTop: 0 }
    const returnToBrowse = (): void => onSurfaceChange({ page: 'browse', ...returnTo })
    const readyDetail = detailResult?.status === 'ready' ? detailResult : null
    return (
      <main
        data-slot="plugin-center-page"
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
      >
        <header className="flex h-14 shrink-0 items-center justify-between px-5">
          <nav
            data-slot="plugin-detail-breadcrumb"
            className="flex min-w-0 items-center gap-2 text-sm"
          >
            <button
              type="button"
              className="font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={returnToBrowse}
            >
              插件
            </button>
            <ChevronRightIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate font-medium">
              {surface.pluginName ??
                readyDetail?.detail.plugin.displayName ??
                readyDetail?.detail.plugin.name ??
                surface.pluginRef.id}
            </span>
          </nav>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="刷新插件详情"
            title="刷新插件详情"
            disabled={loading || Boolean(mutation)}
            onClick={() => void refresh(true)}
          >
            <RefreshCwIcon className={cn('size-4', (loading || refreshing) && 'animate-spin')} />
          </Button>
        </header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto w-full max-w-3xl px-6">
            {(error || actionError) && (
              <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span>{actionError ?? error}</span>
              </div>
            )}
            {loading && <PluginDetailSkeleton />}
            {!loading && !error && detailResult?.status === 'missing' && (
              <EmptyState
                icon={<PuzzleIcon className="size-5" />}
                title="未找到插件"
                description={
                  detailResult.missingReason === 'ambiguous'
                    ? '该插件在多个市场中存在，请返回目录后重新选择。'
                    : '该插件已不在当前插件市场中。'
                }
              />
            )}
            {!loading && !error && readyDetail && (
              <PluginDetailPage
                detail={readyDetail.detail}
                pending={mutation?.id === readyDetail.detail.plugin.id}
                pendingAppId={mutation?.id ?? awaitingAppConnectionId ?? undefined}
                pendingSkillId={mutation?.id}
                onInstall={(plugin) =>
                  void runMutation(plugin.id, '安装插件', () =>
                    api!.installPlugin({
                      ...requestContext,
                      plugin: { id: plugin.id, marketplaceId: plugin.marketplaceId }
                    })
                  )
                }
                onToggle={(plugin, enabled) =>
                  void runMutation(plugin.id, enabled ? '启用插件' : '停用插件', () =>
                    api!.setPluginEnabled({ ...requestContext, plugin: { id: plugin.id }, enabled })
                  )
                }
                onSkillToggle={(skill, enabled) =>
                  runMutation(
                    skill.id,
                    enabled ? '启用技能' : '停用技能',
                    () =>
                      api!.setSkillEnabled({ ...requestContext, skill: { id: skill.id }, enabled }),
                    { refreshInBackground: true }
                  )
                }
                onUninstall={(plugin) => setConfirm({ kind: 'plugin', plugin })}
                onActivatePrompt={(prompt) => void ensurePluginReadyForPrompt(readyDetail, prompt)}
                onConnectApp={(app) => void connectApp(app)}
                onReconnectApp={reconnectApp}
                onDisconnectApp={disconnectApp}
                onOpenAppTools={(app) => setSelectedAppId(app.id)}
                onOpenExternal={(url) => void openExternal(url)}
              />
            )}
          </div>
        </ScrollArea>
        <ConfirmDialog
          state={confirm}
          onOpenChange={(open) => {
            if (!open) setConfirm(null)
          }}
          onConfirm={() => {
            const current = confirm
            setConfirm(null)
            if (current?.kind === 'plugin') {
              void runMutation(current.plugin.id, '卸载插件', () =>
                api!.uninstallPlugin({ ...requestContext, plugin: { id: current.plugin.id } })
              )
            }
          }}
        />
        {selectedApp && (
          <PluginAppToolsDialog
            key={selectedApp.id}
            app={selectedApp}
            open
            state={appToolsState}
            pending={mutation?.id === selectedApp.id || awaitingAppConnectionId === selectedApp.id}
            onOpenChange={(open) => {
              if (!open) setSelectedAppId(null)
            }}
            onToggle={(enabled) =>
              void runMutation(selectedApp.id, enabled ? '启用应用' : '停用应用', () =>
                api!.setAppEnabled({ ...requestContext, app: { id: selectedApp.id }, enabled })
              )
            }
            onTryApp={() => {
              if (!selectedApp.accessible || !selectedApp.enabled) {
                return
              }
              setSelectedAppId(null)
              onTryApp?.({ mention: selectedApp.mention })
            }}
            onRetry={() => {
              appToolsResource?.invalidate()
              void appToolsResource?.refresh(true)
            }}
          />
        )}
        <Toaster position="top-center" richColors closeButton />
      </main>
    )
  }

  return (
    <main
      data-slot="plugin-center-page"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
    >
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        {headerNavigation}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="刷新插件中心"
            title="刷新插件中心"
            disabled={loading || Boolean(mutation)}
            onClick={() => void refresh(true)}
          >
            <RefreshCwIcon className={cn('size-4', (loading || refreshing) && 'animate-spin')} />
          </Button>
          <Button
            variant={surface.page === 'manage' ? 'secondary' : 'ghost'}
            size="sm"
            type="button"
            aria-label="管理插件中心"
            title="管理"
            onClick={() => navigateManage(currentManageTab)}
          >
            <SettingsIcon className="size-4" />
            管理
          </Button>
          <AddMenu
            onAddMarketplace={() => setMarketplaceOpen(true)}
            onAddMcp={() => setMcpDialog({ open: true, server: null })}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <ScrollArea
          className="min-h-0 flex-1"
          viewportRef={scrollViewportRef}
          onViewportScroll={(event) => setBrowseScrollTop(event.currentTarget.scrollTop)}
        >
          <div className="mx-auto w-full max-w-3xl px-6 pb-8">
            <div data-slot="plugin-center-list-header" className="pt-6 pb-6">
              {surface.page === 'browse' && (
                <div data-slot="plugin-center-intro" className="mb-6">
                  <h1 className="text-xl leading-[1.2] font-normal">插件</h1>
                  <p className="mt-2 text-lg leading-6 text-muted-foreground">
                    在你常用的工具中使用 Codex
                  </p>
                </div>
              )}
              {surface.page === 'manage' && (
                <Tabs
                  value={currentManageTab}
                  onValueChange={(value) => navigateManage(value as PluginCenterManageTab)}
                  className="mb-4"
                >
                  <TabsList>
                    <TabsTrigger value="plugins">
                      插件
                      {hasVisiblePluginData
                        ? ` ${snapshot.plugins.filter((item) => item.installed).length}`
                        : ''}
                    </TabsTrigger>
                    <TabsTrigger value="apps">
                      应用{loadedSections.has('apps') ? ` ${snapshot.apps.length}` : ''}
                    </TabsTrigger>
                    <TabsTrigger value="mcp">
                      MCP
                      {loadedSections.has('mcp')
                        ? ` ${snapshot.mcp.userServers.length + snapshot.mcp.pluginServers.length}`
                        : ''}
                    </TabsTrigger>
                    <TabsTrigger value="skills">
                      技能{loadedSections.has('skills') ? ` ${snapshot.skills.length}` : ''}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              <div data-slot="plugin-center-search" className="relative w-full">
                <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => {
                    const nextSearch = event.target.value
                    if (surface.page === 'browse') {
                      setBrowseSearchDraft(nextSearch)
                      onSurfaceChange({
                        page: 'browse',
                        tab: surface.tab,
                        ...(surface.category ? { category: surface.category } : {}),
                        search: nextSearch,
                        scrollTop: 0
                      })
                    } else {
                      setManageSearch(nextSearch)
                    }
                  }}
                  className="h-8 rounded-full pl-9 text-base"
                  placeholder={surface.page === 'browse' ? '搜索插件' : '搜索当前管理项'}
                />
              </div>
            </div>

            {(error || actionError) && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span>{actionError ?? error}</span>
              </div>
            )}

            {catalogWarning && (
              <div
                data-slot="plugin-catalog-warning"
                className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
              >
                <CircleAlertIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="min-w-0 flex-1 text-muted-foreground">{catalogWarning}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={refreshing}
                  onClick={() => void refresh(true)}
                >
                  重试
                </Button>
              </div>
            )}

            {mutation && (
              <div className="mb-3 flex items-center gap-2 rounded-md border bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                <span>{mutation.label}中</span>
              </div>
            )}

            {contentView}
          </div>
        </ScrollArea>
      </div>

      <MarketplaceDialog
        open={marketplaceOpen}
        onOpenChange={setMarketplaceOpen}
        onSubmit={async (input) => {
          if (!api) throw new Error('插件中心 API 尚未接入')
          const result = await api.addMarketplace({ ...requestContext, ...input })
          await applyMutationResult(result)
          if (result.alreadyAdded) {
            toast.info(result.message ?? '该插件市场已存在')
          } else {
            toast.success(result.message ?? '插件市场已添加')
          }
          return result
        }}
      />
      <McpServerDialog
        state={mcpDialog}
        onOpenChange={(open) => setMcpDialog((current) => ({ ...current, open }))}
        onSubmit={async (serverId, displayName, server) => {
          await runMutation(
            serverId ?? displayName ?? 'new-mcp',
            serverId ? '保存 MCP' : '新增 MCP',
            () => api!.upsertMcpServer({ ...requestContext, serverId, displayName, server })
          )
        }}
      />
      <ConfirmDialog
        state={confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        onConfirm={() => {
          const current = confirm
          setConfirm(null)
          if (!current) return
          if (current.kind === 'plugin') {
            void runMutation(current.plugin.id, '卸载插件', () =>
              api!.uninstallPlugin({ ...requestContext, plugin: { id: current.plugin.id } })
            )
          } else {
            void runMutation(current.server.id, '删除 MCP', () =>
              api!.removeMcpServer({ ...requestContext, server: { id: current.server.id } })
            )
          }
        }}
      />
      <Toaster position="top-center" richColors closeButton />
    </main>
  )
}

function AddMenu({
  onAddMarketplace,
  onAddMcp
}: {
  onAddMarketplace: () => void
  onAddMcp: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" type="button">
          <PlusIcon className="size-4" />
          添加
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onAddMarketplace}>
          <DatabaseIcon className="size-4" />
          添加插件市场
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAddMcp}>
          <PlugIcon className="size-4" />
          添加 MCP 服务器
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ConfirmDialog({
  state,
  onOpenChange,
  onConfirm
}: {
  state: ConfirmState
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}): React.JSX.Element {
  const title = confirmTitle(state)
  const description =
    state?.kind === 'plugin'
      ? '卸载后会刷新插件和技能目录。'
      : '删除后会刷新 MCP 配置；如果其他配置层仍提供同名服务器，会以只读项显示。'

  return (
    <Dialog open={Boolean(state)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">
              取消
            </Button>
          </DialogClose>
          <Button variant="destructive" type="button" onClick={onConfirm}>
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function confirmTitle(state: ConfirmState): string {
  if (state?.kind === 'plugin') return `卸载 ${itemTitle(state.plugin)}？`
  if (state?.kind === 'mcp') return `删除 ${state.server.displayName ?? state.server.name}？`
  return '确认操作'
}

function InstalledPluginsSkeleton(): React.JSX.Element {
  return (
    <section
      data-slot="installed-plugins-skeleton"
      className="flex flex-col gap-3"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-2 pb-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="size-8 rounded-md" />
      </div>
      <div className="flex h-11 w-full items-center justify-between px-2">
        {Array.from({ length: 8 }).map((_, index) => (
          <Skeleton key={index} className="size-9 shrink-0 rounded-lg" />
        ))}
      </div>
    </section>
  )
}

function PluginCategoriesSkeleton(): React.JSX.Element {
  return (
    <div data-slot="plugin-categories-skeleton" className="space-y-8" aria-hidden="true">
      {Array.from({ length: 2 }).map((_, sectionIndex) => (
        <section key={sectionIndex}>
          <div className="mb-3 border-b border-border/40 px-2 pb-3">
            <Skeleton className="h-6 w-24" />
          </div>
          <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
            {Array.from({ length: 2 }).map((__, cardIndex) => (
              <PluginCardSkeleton key={cardIndex} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function PluginDetailSkeleton(): React.JSX.Element {
  return (
    <div data-slot="plugin-detail-skeleton" className="space-y-6 py-6" aria-hidden="true">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Skeleton className="size-[60px] rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-36 w-full rounded-2xl" />
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  )
}

function PluginCardSkeleton(): React.JSX.Element {
  return (
    <article data-slot="plugin-card-skeleton" className="flex items-center gap-3 rounded-2xl p-2">
      <Skeleton className="size-10 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <Skeleton className="h-7 w-12 shrink-0 rounded-lg" />
    </article>
  )
}

function EmptyState({
  icon,
  title,
  description
}: {
  icon: React.ReactNode
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function ItemIcon({
  icon,
  title,
  fallback,
  className
}: {
  icon?: { kind: string; value: string }
  title: string
  fallback: React.ReactNode
  className?: string
}): React.JSX.Element {
  return <PluginImage icon={icon} title={title} fallback={fallback} className={className} />
}

function BrowsePlugins({
  plugins,
  category,
  catalogUnavailableReason,
  loading,
  pendingId,
  onInstall,
  onToggle,
  onUninstall,
  onManageInstalledPlugins,
  onOpenCategory,
  onOpenDetails
}: {
  plugins: PluginCenterPlugin[]
  category?: string
  catalogUnavailableReason?: string
  loading: BrowsePluginsLoadingState
  pendingId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onManageInstalledPlugins: () => void
  onOpenCategory: (category: string) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  const installed = plugins.filter((plugin) => plugin.installed)
  const featured = plugins.filter((plugin) => plugin.featured && !plugin.installed)
  const catalogGroups = groupCatalogPlugins(
    plugins.filter((plugin) => !plugin.installed && !plugin.featured)
  )

  if (!loading.catalog && !loading.installed && plugins.length === 0) {
    return (
      <EmptyState
        icon={<PuzzleIcon className="size-5" />}
        title={catalogUnavailableReason ? '暂无可用插件市场' : '没有匹配的插件'}
        description={
          catalogUnavailableReason ?? '当前快照没有返回可浏览插件。请添加插件市场或调整搜索条件。'
        }
      />
    )
  }

  if (category) {
    if (loading.catalog) return <PluginCategoriesSkeleton />

    const categoryPlugins = pluginsForCategory(plugins, category)
    if (categoryPlugins.length === 0) {
      return (
        <EmptyState
          icon={<PuzzleIcon className="size-5" />}
          title="没有匹配的插件"
          description="当前分类没有符合搜索条件的插件。"
        />
      )
    }

    return (
      <BrowseSection title={categoryTitle(category)} dataSlot="plugin-category-detail">
        <PluginCardGrid
          plugins={categoryPlugins}
          pendingId={pendingId}
          onInstall={onInstall}
          onToggle={onToggle}
          onUninstall={onUninstall}
          onOpenDetails={onOpenDetails}
        />
      </BrowseSection>
    )
  }

  let installedContent: React.ReactNode = null
  if (loading.installed) {
    installedContent = <InstalledPluginsSkeleton />
  } else if (installed.length > 0) {
    installedContent = (
      <InstalledPluginsSection
        plugins={installed}
        onManage={onManageInstalledPlugins}
        onOpenDetails={onOpenDetails}
      />
    )
  }

  let catalogContent: React.ReactNode = <PluginCategoriesSkeleton />
  if (!loading.catalog) {
    catalogContent = (
      <>
        {featured.length > 0 && (
          <BrowseSection title="精选" dataSlot="plugin-category-featured">
            <PluginCategoryPreview
              plugins={featured}
              pendingId={pendingId}
              onInstall={onInstall}
              onToggle={onToggle}
              onUninstall={onUninstall}
              onOpenDetails={onOpenDetails}
              onSeeMore={() => onOpenCategory(FEATURED_CATEGORY_ID)}
            />
          </BrowseSection>
        )}
        {catalogGroups.map(([category, categoryPlugins]) => (
          <BrowseSection key={category} title={category} dataSlot={`plugin-category-${category}`}>
            <PluginCategoryPreview
              plugins={categoryPlugins}
              pendingId={pendingId}
              onInstall={onInstall}
              onToggle={onToggle}
              onUninstall={onUninstall}
              onOpenDetails={onOpenDetails}
              onSeeMore={() => onOpenCategory(category)}
            />
          </BrowseSection>
        ))}
      </>
    )
  }

  return (
    <div className="space-y-8">
      {installedContent}
      {catalogContent}
    </div>
  )
}

const INSTALLED_PLUGIN_TILE_WIDTH = 44

function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = React.useRef<T>(null)
  const [width, setWidth] = React.useState<number | null>(null)

  React.useEffect(() => {
    const element = ref.current
    if (!element) return

    const updateWidth = (): void => {
      setWidth(element.clientWidth || null)
    }

    updateWidth()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

function installedPluginVisibleCount(pluginCount: number, containerWidth: number | null): number {
  if (containerWidth === null) return pluginCount
  const availableTileCount = Math.max(1, Math.floor(containerWidth / INSTALLED_PLUGIN_TILE_WIDTH))
  return availableTileCount >= pluginCount ? pluginCount : availableTileCount - 1
}

function InstalledPluginsSection({
  plugins,
  onManage,
  onOpenDetails
}: {
  plugins: PluginCenterPlugin[]
  onManage: () => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  const [railRef, railWidth] = useElementWidth<HTMLDivElement>()
  const visibleCount = installedPluginVisibleCount(plugins.length, railWidth)
  const visiblePlugins = plugins.slice(0, visibleCount)
  const hiddenPlugins = plugins.slice(visibleCount)

  return (
    <section data-slot="installed-plugins" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-2 pb-2">
        <h2 className="text-lg leading-6 font-medium">已安装</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          aria-label="设置已安装插件"
          title="设置"
          onClick={onManage}
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>
      <div
        ref={railRef}
        data-slot="installed-plugin-rail"
        className="flex h-11 w-full justify-between overflow-visible px-2"
      >
        {visiblePlugins.map((plugin) => (
          <InstalledPluginRailIcon key={plugin.id} plugin={plugin} onOpenDetails={onOpenDetails} />
        ))}
        {hiddenPlugins.length > 0 && (
          <button
            data-slot="installed-plugin-overflow"
            type="button"
            className="group relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
            aria-label={`还有 ${hiddenPlugins.length} 个已安装插件`}
            title={`还有 ${hiddenPlugins.length} 个已安装插件`}
            onClick={onManage}
          >
            <span className="grid size-9 grid-cols-2 gap-0.5 overflow-hidden rounded-lg bg-card p-1 shadow-lg ring-1 ring-border ring-inset">
              {hiddenPlugins.slice(0, 4).map((plugin) => (
                <span
                  key={plugin.id}
                  className="flex size-[13px] items-center justify-center overflow-hidden rounded-[4px] bg-muted ring-1 ring-border ring-inset"
                >
                  <ItemIcon
                    icon={plugin.icon}
                    title={itemTitle(plugin)}
                    fallback={<PuzzleIcon className="size-2 text-muted-foreground" />}
                    className="size-full rounded-[4px] border-0 bg-transparent object-contain shadow-none ring-0"
                  />
                </span>
              ))}
            </span>
          </button>
        )}
      </div>
    </section>
  )
}

function InstalledPluginRailIcon({
  plugin,
  onOpenDetails
}: {
  plugin: PluginCenterPlugin
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-slot="installed-plugin-icon"
      className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`查看 ${itemTitle(plugin)} 详情`}
      title={`查看 ${itemTitle(plugin)} 详情`}
      onClick={() => onOpenDetails(plugin)}
    >
      <ItemIcon
        icon={plugin.icon}
        title={itemTitle(plugin)}
        fallback={<PuzzleIcon className="size-4" />}
        className="rounded-lg border-0 bg-card object-contain shadow-lg ring-1 ring-border ring-inset"
      />
    </button>
  )
}

function groupCatalogPlugins(
  plugins: PluginCenterPlugin[]
): Array<[category: string, plugins: PluginCenterPlugin[]]> {
  const groups = new Map<string, PluginCenterPlugin[]>()
  for (const plugin of plugins) {
    const category = plugin.categories[0] ?? `${sourceLabel(plugin.sourceKind)}插件`
    groups.set(category, [...(groups.get(category) ?? []), plugin])
  }
  return [...groups.entries()]
}

function categoryTitle(category: string | undefined): string {
  if (category === FEATURED_CATEGORY_ID) return '精选'
  return category ?? '插件'
}

function pluginsForCategory(plugins: PluginCenterPlugin[], category: string): PluginCenterPlugin[] {
  if (category === FEATURED_CATEGORY_ID) {
    return plugins.filter((plugin) => plugin.featured)
  }
  return plugins.filter((plugin) => plugin.categories[0] === category)
}

function shouldShowCategoryMoreRow(pluginCount: number): boolean {
  return pluginCount - CATEGORY_PREVIEW_LIMIT >= MORE_PLUGIN_PREVIEW_LIMIT
}

function PluginCategoryPreview({
  plugins,
  pendingId,
  onInstall,
  onToggle,
  onUninstall,
  onOpenDetails,
  onSeeMore
}: {
  plugins: PluginCenterPlugin[]
  pendingId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
  onSeeMore: () => void
}): React.JSX.Element {
  const showMore = shouldShowCategoryMoreRow(plugins.length)
  const visiblePlugins = showMore ? plugins.slice(0, CATEGORY_PREVIEW_LIMIT) : plugins
  const hiddenPlugins = showMore ? plugins.slice(CATEGORY_PREVIEW_LIMIT) : []

  return (
    <div className="flex flex-col">
      <PluginCardGrid
        plugins={visiblePlugins}
        pendingId={pendingId}
        onInstall={onInstall}
        onToggle={onToggle}
        onUninstall={onUninstall}
        onOpenDetails={onOpenDetails}
      />
      {hiddenPlugins.length > 0 && (
        <PluginCategoryMoreRow plugins={hiddenPlugins} onClick={onSeeMore} />
      )}
    </div>
  )
}

function PluginCategoryMoreRow({
  plugins,
  onClick
}: {
  plugins: PluginCenterPlugin[]
  onClick: () => void
}): React.JSX.Element {
  const previewPlugins = plugins.slice(0, MORE_PLUGIN_PREVIEW_LIMIT)
  const pluginNames = previewPlugins.map(itemTitle).join('、')

  return (
    <button
      data-slot="plugin-category-more"
      type="button"
      className="mt-4 flex min-h-[31px] w-full cursor-pointer items-center gap-3 self-start rounded-lg px-2.5 py-[5px] text-left text-[12px] leading-relaxed font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`查看 ${pluginNames} 等更多插件`}
      onClick={onClick}
    >
      <span className="flex shrink-0 items-center" aria-hidden="true">
        {previewPlugins.map((plugin) => (
          <span
            key={plugin.id}
            className="-ms-1.5 flex size-6 items-center justify-center overflow-hidden rounded-md bg-card text-black ring-1 ring-border ring-inset first:ms-0 dark:text-gray-200"
          >
            <ItemIcon
              icon={plugin.icon}
              title={itemTitle(plugin)}
              fallback={<PuzzleIcon className="size-4 text-muted-foreground" />}
              className="size-6 rounded-md border-0 bg-transparent shadow-none"
            />
          </span>
        ))}
      </span>
      <span>查看 {pluginNames} 等更多插件</span>
    </button>
  )
}

function PluginCardGrid({
  plugins,
  pendingId,
  onInstall,
  onToggle,
  onUninstall,
  onOpenDetails
}: {
  plugins: PluginCenterPlugin[]
  pendingId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
      {plugins.map((plugin) => (
        <PluginCard
          key={plugin.id}
          plugin={plugin}
          pending={pendingId === plugin.id}
          onInstall={onInstall}
          onToggle={onToggle}
          onUninstall={onUninstall}
          onOpenDetails={onOpenDetails}
        />
      ))}
    </div>
  )
}

function BrowseSection({
  title,
  description,
  dataSlot,
  children
}: {
  title: string
  description?: string
  dataSlot?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-slot={dataSlot}>
      <div className="mb-3 border-b border-border/40 px-2 pb-3">
        <h2 className="text-lg leading-6 font-medium">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function PluginCard({
  plugin,
  pending,
  onInstall,
  onToggle,
  onUninstall,
  onOpenDetails
}: {
  plugin: PluginCenterPlugin
  pending: boolean
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  return (
    <article
      data-slot="plugin-card"
      className="group flex rounded-2xl p-2 transition-colors hover:bg-foreground/5"
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`查看 ${itemTitle(plugin)} 详情`}
        onClick={() => onOpenDetails(plugin)}
      >
        <ItemIcon
          icon={plugin.icon}
          title={itemTitle(plugin)}
          fallback={<PuzzleIcon className="size-4" />}
          className="size-10 rounded-lg bg-transparent object-contain"
        />
        <span className="min-w-0 flex-1">
          <h3 className="truncate text-base font-medium text-foreground">{itemTitle(plugin)}</h3>
          <p className="truncate text-[12px] leading-relaxed font-normal text-muted-foreground">
            {itemDescription(plugin)}
          </p>
        </span>
      </button>
      <div className="ml-3 flex shrink-0 items-center">
        {plugin.installed ? (
          <ItemActions
            enabled={plugin.enabled}
            canToggle={plugin.canToggle}
            canUninstall={plugin.canUninstall}
            pending={pending}
            restriction={plugin.restriction?.message}
            onToggle={(enabled) => onToggle(plugin, enabled)}
            onUninstall={() => onUninstall(plugin)}
            compact
          />
        ) : (
          <Button
            variant="outline"
            size="composer"
            type="button"
            className="shrink-0 gap-1 rounded-lg px-2 text-base leading-[18px]"
            disabled={pending || !plugin.canInstall}
            title={plugin.restriction?.message}
            onClick={() => onInstall(plugin)}
          >
            {pending && <Loader2Icon className="size-4 animate-spin" />}
            安装
          </Button>
        )}
      </div>
    </article>
  )
}

function ItemActions({
  enabled,
  canToggle,
  canUninstall,
  pending,
  restriction,
  onToggle,
  onUninstall,
  compact = false
}: {
  enabled: boolean
  canToggle: boolean
  canUninstall: boolean
  pending: boolean
  restriction?: string
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
  compact?: boolean
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {!compact && (
        <Switch
          checked={enabled}
          disabled={pending || !canToggle}
          title={restriction}
          aria-label={enabled ? '停用' : '启用'}
          onCheckedChange={onToggle}
        />
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            disabled={pending}
            aria-label="更多插件操作"
            title="更多操作"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {compact && (
            <DropdownMenuItem disabled={!canToggle} onSelect={() => onToggle(!enabled)}>
              {enabled ? '停用' : '启用'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!canUninstall} onSelect={onUninstall}>
            卸载
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ItemMeta({ values }: { values: Array<string | undefined> }): React.JSX.Element {
  const compactValues = values.filter((value): value is string => Boolean(value))
  if (compactValues.length === 0) return <></>
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {compactValues.map((value) => (
        <span key={value} className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {value}
        </span>
      ))}
    </div>
  )
}

function BrowseSkills({
  skills,
  pendingId,
  onToggle
}: {
  skills: PluginCenterSkill[]
  pendingId?: string
  onToggle: (skill: PluginCenterSkill, enabled: boolean) => Promise<boolean>
}): React.JSX.Element {
  if (skills.length === 0) {
    return (
      <EmptyState
        icon={<SparklesIcon className="size-5" />}
        title="没有匹配的技能"
        description="当前快照没有返回可浏览技能。请刷新、添加市场或调整搜索条件。"
      />
    )
  }
  const installed = skills.filter((skill) => skill.installed)
  const recommended = skills.filter((skill) => skill.recommended)

  return (
    <div className="space-y-8">
      <BrowseSection title="已安装技能" description="来自真实 skills/list 快照。">
        <div className="grid gap-2 lg:grid-cols-2">
          {installed.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              pending={pendingId === skill.id}
              onToggle={onToggle}
            />
          ))}
        </div>
      </BrowseSection>
      <BrowseSection title="推荐来源" description="只展示后端返回的真实推荐技能。">
        {recommended.length > 0 ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {recommended.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                pending={pendingId === skill.id}
                onToggle={onToggle}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无推荐技能。</p>
        )}
      </BrowseSection>
    </div>
  )
}

function SkillRow({
  skill,
  pending,
  onToggle
}: {
  skill: PluginCenterSkill
  pending: boolean
  onToggle: (skill: PluginCenterSkill, enabled: boolean) => Promise<boolean>
}): React.JSX.Element {
  return (
    <article className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <SparklesIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{itemTitle(skill)}</div>
        <p className="truncate text-sm text-muted-foreground">{itemDescription(skill)}</p>
        <ItemMeta
          values={[scopeLabel(skill.scope), skill.pluginDisplayName, sourceLabel(skill.sourceKind)]}
        />
      </div>
      <OptimisticSkillSwitch
        enabled={skill.enabled}
        disabled={pending || !skill.canToggle}
        getAriaLabel={(enabled) => `${itemTitle(skill)} ${enabled ? '停用' : '启用'}`}
        title={skill.restriction?.message}
        onToggle={(enabled) => onToggle(skill, enabled)}
      />
    </article>
  )
}

function ManagePanel({
  tab,
  snapshot,
  search,
  pendingId,
  onPluginToggle,
  onPluginUninstall,
  onConnectApp,
  onAppToggle,
  onSkillToggle,
  onMcpToggle,
  onMcpEdit,
  onMcpRemove,
  onOpenDetails
}: {
  tab: PluginCenterManageTab
  snapshot: PluginCenterSnapshot
  search: string
  pendingId?: string
  onPluginToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onPluginUninstall: (plugin: PluginCenterPlugin) => void
  onConnectApp: (app: PluginCenterApp) => void
  onAppToggle: (app: PluginCenterApp, enabled: boolean) => void
  onSkillToggle: (skill: PluginCenterSkill, enabled: boolean) => Promise<boolean>
  onMcpToggle: (server: PluginCenterUserMcpServer, enabled: boolean) => void
  onMcpEdit: (server: PluginCenterUserMcpServer) => void
  onMcpRemove: (server: PluginCenterUserMcpServer) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  if (tab === 'plugins') {
    const plugins = snapshot.plugins
      .filter((plugin) => plugin.installed)
      .filter((plugin) => matchesSearch(plugin, search))
    return plugins.length ? (
      <div className="grid gap-3">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            pending={pendingId === plugin.id}
            onInstall={() => undefined}
            onToggle={onPluginToggle}
            onUninstall={onPluginUninstall}
            onOpenDetails={onOpenDetails}
          />
        ))}
      </div>
    ) : (
      <EmptyState
        icon={<PuzzleIcon className="size-5" />}
        title="没有插件"
        description="暂无匹配的已安装插件。"
      />
    )
  }
  if (tab === 'apps') {
    const apps = snapshot.apps.filter((app) => matchesSearch(app, search))
    return apps.length ? (
      <div className="grid gap-2">
        {apps.map((app) => (
          <AppRow
            key={app.id}
            app={app}
            pending={pendingId === app.id}
            onConnect={onConnectApp}
            onToggle={onAppToggle}
          />
        ))}
      </div>
    ) : (
      <EmptyState
        icon={<AppWindowIcon className="size-5" />}
        title="没有应用"
        description="暂无匹配应用。"
      />
    )
  }
  if (tab === 'skills') {
    const skills = snapshot.skills.filter((skill) => matchesSearch(skill, search))
    return skills.length ? (
      <div className="grid gap-2">
        {skills.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            pending={pendingId === skill.id}
            onToggle={onSkillToggle}
          />
        ))}
      </div>
    ) : (
      <EmptyState
        icon={<SparklesIcon className="size-5" />}
        title="没有技能"
        description="暂无匹配技能。"
      />
    )
  }
  return (
    <McpPanel
      userServers={snapshot.mcp.userServers.filter((server) => matchesSearch(server, search))}
      pluginServers={snapshot.mcp.pluginServers.filter((server) => matchesSearch(server, search))}
      pendingId={pendingId}
      onToggle={onMcpToggle}
      onEdit={onMcpEdit}
      onRemove={onMcpRemove}
    />
  )
}

function AppRow({
  app,
  pending,
  onConnect,
  onToggle
}: {
  app: PluginCenterApp
  pending: boolean
  onConnect: (app: PluginCenterApp) => void
  onToggle: (app: PluginCenterApp, enabled: boolean) => void
}): React.JSX.Element {
  const needsConnection = !app.accessible && Boolean(app.installUrl)
  return (
    <article className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <ItemIcon
        icon={app.icon}
        title={itemTitle(app)}
        fallback={<AppWindowIcon className="size-4" />}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{itemTitle(app)}</div>
        <p className="truncate text-sm text-muted-foreground">{itemDescription(app)}</p>
        <ItemMeta values={[sourceLabel(app.sourceKind), ...app.pluginDisplayNames]} />
      </div>
      {app.accessible && (
        <Switch
          checked={app.enabled}
          disabled={pending || !app.canToggle}
          title={app.restriction?.message}
          aria-label={`${itemTitle(app)} ${app.enabled ? '停用' : '启用'}`}
          onCheckedChange={(enabled) => onToggle(app, enabled)}
        />
      )}
      {needsConnection && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full px-4"
          disabled={pending || Boolean(app.restriction)}
          aria-label={`连接 ${itemTitle(app)}`}
          title={app.restriction?.message}
          onClick={() => onConnect(app)}
        >
          连接
        </Button>
      )}
    </article>
  )
}

function McpPanel({
  userServers,
  pluginServers,
  pendingId,
  onToggle,
  onEdit,
  onRemove
}: {
  userServers: PluginCenterUserMcpServer[]
  pluginServers: PluginCenterPluginMcpServer[]
  pendingId?: string
  onToggle: (server: PluginCenterUserMcpServer, enabled: boolean) => void
  onEdit: (server: PluginCenterUserMcpServer) => void
  onRemove: (server: PluginCenterUserMcpServer) => void
}): React.JSX.Element {
  if (userServers.length === 0 && pluginServers.length === 0) {
    return (
      <EmptyState
        icon={<PlugIcon className="size-5" />}
        title="没有 MCP 服务器"
        description="暂无匹配的普通或插件提供 MCP。"
      />
    )
  }
  return (
    <div className="space-y-7">
      <BrowseSection title="普通服务器" description="可编辑的用户级 MCP 配置。">
        {userServers.length > 0 ? (
          <div className="grid gap-2">
            {userServers.map((server) => (
              <McpUserRow
                key={server.id}
                server={server}
                pending={pendingId === server.id}
                onToggle={onToggle}
                onEdit={onEdit}
                onRemove={onRemove}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无普通服务器。</p>
        )}
      </BrowseSection>
      <BrowseSection title="来自插件" description="由所属插件控制，不能在此处单独编辑。">
        {pluginServers.length > 0 ? (
          <div className="grid gap-2">
            {pluginServers.map((server) => (
              <McpPluginRow key={server.id} server={server} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无插件提供的 MCP。</p>
        )}
      </BrowseSection>
    </div>
  )
}

function McpUserRow({
  server,
  pending,
  onToggle,
  onEdit,
  onRemove
}: {
  server: PluginCenterUserMcpServer
  pending: boolean
  onToggle: (server: PluginCenterUserMcpServer, enabled: boolean) => void
  onEdit: (server: PluginCenterUserMcpServer) => void
  onRemove: (server: PluginCenterUserMcpServer) => void
}): React.JSX.Element {
  return (
    <article className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <PlugIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{server.displayName ?? server.name}</div>
        <p className="truncate text-sm text-muted-foreground">
          {server.connected ? '已连接' : '未连接'} · {server.toolCount} 个工具 ·{' '}
          {authLabel(server.authStatus)}
        </p>
        <ItemMeta values={[server.transport, server.origin, server.restriction?.message]} />
      </div>
      <Switch
        checked={server.enabled}
        disabled={pending || !server.editable}
        title={server.restriction?.message}
        aria-label={`${server.displayName ?? server.name} ${server.enabled ? '停用' : '启用'}`}
        onCheckedChange={(enabled) => onToggle(server, enabled)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            disabled={pending || !server.editable}
            aria-label={`${server.displayName ?? server.name} 更多 MCP 操作`}
            title="更多操作"
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onEdit(server)}>编辑</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onRemove(server)}>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </article>
  )
}

function McpPluginRow({ server }: { server: PluginCenterPluginMcpServer }): React.JSX.Element {
  return (
    <article className="flex items-center gap-3 rounded-lg border bg-card p-3 opacity-90">
      <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <PlugIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{server.displayName ?? server.name}</div>
        <p className="truncate text-sm text-muted-foreground">
          来自 {server.pluginDisplayName ?? server.pluginId} ·{' '}
          {server.connected ? '已连接' : '未连接'} · {server.toolCount} 个工具
        </p>
        <ItemMeta values={[server.transport, authLabel(server.authStatus)]} />
      </div>
      <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">只读</span>
    </article>
  )
}

function MarketplaceDialog({
  open,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: {
    source: string
    refName?: string
    sparsePaths: string[]
  }) => Promise<PluginCenterAddMarketplaceResult>
}): React.JSX.Element {
  const [source, setSource] = React.useState('')
  const [refName, setRefName] = React.useState('')
  const [sparsePaths, setSparsePaths] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        source: source.trim(),
        refName: refName.trim() || undefined,
        sparsePaths: parseMultilineList(sparsePaths)
      })
      onOpenChange(false)
      setSource('')
      setRefName('')
      setSparsePaths('')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '添加插件市场失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>添加插件市场</DialogTitle>
          <DialogDescription>添加后会重新读取真实插件和技能目录。</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="来源" required>
            <Input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="owner/repo、Git URL 或本地绝对路径"
            />
          </Field>
          <Field label="Git 引用">
            <Input
              value={refName}
              onChange={(event) => setRefName(event.target.value)}
              placeholder="main、tag 或 commit，可选"
            />
          </Field>
          <Field label="稀疏路径">
            <Textarea
              value={sparsePaths}
              onChange={(event) => setSparsePaths(event.target.value)}
              placeholder="每行一个路径，也可用逗号分隔"
            />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button" disabled={submitting}>
              取消
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={!source.trim() || submitting}
            onClick={() => void submit()}
          >
            {submitting && <Loader2Icon className="size-4 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type McpDialogState = {
  open: boolean
  server: PluginCenterUserMcpServer | null
}

type SecretActions = Record<string, 'keep' | 'remove'>

function McpServerDialog({
  state,
  onOpenChange,
  onSubmit
}: {
  state: McpDialogState
  onOpenChange: (open: boolean) => void
  onSubmit: (
    serverId: string | undefined,
    displayName: string | undefined,
    server: PluginCenterMcpServerInput
  ) => Promise<void>
}): React.JSX.Element {
  const editing = state.server
  const [transport, setTransport] = React.useState<'stdio' | 'streamable-http'>('stdio')
  const [displayName, setDisplayName] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [args, setArgs] = React.useState('')
  const [cwd, setCwd] = React.useState('')
  const [env, setEnv] = React.useState('')
  const [envVars, setEnvVars] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [bearerTokenEnvVar, setBearerTokenEnvVar] = React.useState('')
  const [httpHeaders, setHttpHeaders] = React.useState('')
  const [envHttpHeaders, setEnvHttpHeaders] = React.useState('')
  const [envSecretActions, setEnvSecretActions] = React.useState<SecretActions>({})
  const [httpSecretActions, setHttpSecretActions] = React.useState<SecretActions>({})
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!state.open) return
    const server = state.server
    queueMicrotask(() => {
      setTransport(server?.transport === 'streamable-http' ? 'streamable-http' : 'stdio')
      setDisplayName(server?.displayName ?? server?.name ?? '')
      setCommand(server?.transport === 'stdio' ? (server.command ?? '') : '')
      setArgs(server?.transport === 'stdio' ? server.args.join('\n') : '')
      setCwd(server?.transport === 'stdio' ? (server.cwd ?? '') : '')
      setEnv('')
      setEnvVars(
        server?.transport === 'stdio'
          ? server.envVars
              .filter((entry) => entry.editable)
              .map((entry) => entry.name)
              .join('\n')
          : ''
      )
      setUrl(server?.transport === 'streamable-http' ? (server.url ?? '') : '')
      setBearerTokenEnvVar(
        server?.transport === 'streamable-http' ? (server.bearerTokenEnvVar ?? '') : ''
      )
      setHttpHeaders('')
      setEnvHttpHeaders(
        server?.transport === 'streamable-http'
          ? server.envHttpHeaders.map((entry) => `${entry.name}=${entry.envVarName}`).join('\n')
          : ''
      )
      setEnvSecretActions(server?.transport === 'stdio' ? secretKeepActions(server.env) : {})
      setHttpSecretActions(
        server?.transport === 'streamable-http' ? secretKeepActions(server.httpHeaders) : {}
      )
      setError(null)
    })
  }, [state.open, state.server])

  const trimmedDisplayName = displayName.trim()
  const initialForm = initialMcpFormKey(editing)
  const currentForm =
    transport === 'stdio'
      ? JSON.stringify({
          transport,
          displayName: trimmedDisplayName,
          command: command.trim(),
          args: parseArgs(args).join('\n'),
          cwd: cwd.trim(),
          envVars: parseMultilineList(envVars).join('\n'),
          env: parseKeyValues(env),
          envSecretActions
        })
      : JSON.stringify({
          transport,
          displayName: trimmedDisplayName,
          url: url.trim(),
          bearerTokenEnvVar: bearerTokenEnvVar.trim(),
          httpHeaders: parseKeyValues(httpHeaders),
          envHttpHeaders: parseKeyValues(envHttpHeaders),
          httpSecretActions
        })
  const isDirty = !editing || currentForm !== initialForm
  const isValid =
    Boolean(editing || trimmedDisplayName) &&
    (transport === 'stdio' ? command.trim().length > 0 : url.trim().length > 0)

  const submit = async (): Promise<void> => {
    setSubmitting(true)
    setError(null)
    try {
      let server: PluginCenterMcpServerInput
      if (transport === 'stdio') {
        const newSecretValues = parseKeyValues(env)
        server = {
          transport,
          command: command.trim(),
          args: parseArgs(args),
          cwd: cwd.trim() || undefined,
          env: buildSecretPatches(envSecretActions, newSecretValues),
          envVars: parseMultilineList(envVars)
        }
      } else {
        const newHeaderValues = parseKeyValues(httpHeaders)
        server = {
          transport,
          url: url.trim(),
          bearerTokenEnvVar: bearerTokenEnvVar.trim() || undefined,
          httpHeaders: buildSecretPatches(httpSecretActions, newHeaderValues),
          envHttpHeaders: parseKeyValues(envHttpHeaders).map((entry) => ({
            name: entry.name,
            envVarName: entry.value
          }))
        }
      }
      await onSubmit(editing?.id, displayName.trim() || undefined, server)
      onOpenChange(false)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '保存 MCP 失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={state.open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-5rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑 MCP 服务器' : '添加 MCP 服务器'}</DialogTitle>
          <DialogDescription>
            {editing
              ? '名称和传输类型保持不变，只保存可见字段。'
              : '新增配置默认启用，保存后会刷新 MCP 状态。'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="显示名称" required={!editing}>
            <Input
              value={displayName}
              disabled={Boolean(editing)}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button
              type="button"
              variant={transport === 'stdio' ? 'secondary' : 'outline'}
              disabled={Boolean(editing)}
              onClick={() => setTransport('stdio')}
            >
              STDIO
            </Button>
            <Button
              type="button"
              variant={transport === 'streamable-http' ? 'secondary' : 'outline'}
              disabled={Boolean(editing)}
              onClick={() => setTransport('streamable-http')}
            >
              Streamable HTTP
            </Button>
          </div>
          {transport === 'stdio' ? (
            <>
              <Field label="Command to launch" required>
                <Input value={command} onChange={(event) => setCommand(event.target.value)} />
              </Field>
              <Field label="Arguments">
                <Textarea
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="每行一个参数"
                />
              </Field>
              <Field label="Environment variables">
                {editing?.transport === 'stdio' && editing.env.length > 0 ? (
                  <SecretPatchList
                    entries={editing.env}
                    actions={envSecretActions}
                    onChange={setEnvSecretActions}
                  />
                ) : null}
                <Textarea
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                  placeholder="新增或更新：KEY=value"
                />
              </Field>
              <Field label="Environment variable passthrough">
                {editing?.transport === 'stdio' &&
                editing.envVars.some((entry) => !entry.editable) ? (
                  <p className="text-xs text-muted-foreground">
                    只读 passthrough：
                    {editing.envVars
                      .filter((entry) => !entry.editable)
                      .map((entry) => entry.name)
                      .join('、')}
                  </p>
                ) : null}
                <Textarea
                  value={envVars}
                  onChange={(event) => setEnvVars(event.target.value)}
                  placeholder="每行一个变量名"
                />
              </Field>
              <Field label="Working directory">
                <Input value={cwd} onChange={(event) => setCwd(event.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL" required>
                <Input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </Field>
              <Field label="Bearer token env var">
                <Input
                  value={bearerTokenEnvVar}
                  onChange={(event) => setBearerTokenEnvVar(event.target.value)}
                  placeholder="TOKEN_ENV_NAME"
                />
              </Field>
              <Field label="Headers">
                {editing?.transport === 'streamable-http' && editing.httpHeaders.length > 0 ? (
                  <SecretPatchList
                    entries={editing.httpHeaders}
                    actions={httpSecretActions}
                    onChange={setHttpSecretActions}
                  />
                ) : null}
                <Textarea
                  value={httpHeaders}
                  onChange={(event) => setHttpHeaders(event.target.value)}
                  placeholder="Header-Name=value"
                />
              </Field>
              <Field label="Headers from environment variables">
                <Textarea
                  value={envHttpHeaders}
                  onChange={(event) => setEnvHttpHeaders(event.target.value)}
                  placeholder="Header-Name=ENV_VAR_NAME"
                />
              </Field>
            </>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button" disabled={submitting}>
              取消
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={!isValid || !isDirty || submitting}
            onClick={() => void submit()}
          >
            {submitting && <Loader2Icon className="size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SecretPatchList({
  entries,
  actions,
  onChange
}: {
  entries: Array<{ name: string; hasValue: boolean; editable: boolean }>
  actions: SecretActions
  onChange: (actions: SecretActions) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-1 rounded-md border bg-muted/30 p-2">
      {entries.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-2 text-xs">
          <span className="min-w-0 truncate">
            {entry.name} · {entry.hasValue ? '已有值' : '空值'}
          </span>
          <div className="flex shrink-0 gap-1">
            <Button
              type="button"
              size="xs"
              variant={actions[entry.name] !== 'remove' ? 'secondary' : 'ghost'}
              disabled={!entry.editable}
              onClick={() => onChange({ ...actions, [entry.name]: 'keep' })}
            >
              keep
            </Button>
            <Button
              type="button"
              size="xs"
              variant={actions[entry.name] === 'remove' ? 'destructive' : 'ghost'}
              disabled={!entry.editable}
              onClick={() => onChange({ ...actions, [entry.name]: 'remove' })}
            >
              remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

function Field({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="grid gap-2 text-sm">
      <span className="text-muted-foreground">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      {children}
    </label>
  )
}

export function PluginCenterDivider(): React.JSX.Element {
  return <Separator className="my-1" />
}
