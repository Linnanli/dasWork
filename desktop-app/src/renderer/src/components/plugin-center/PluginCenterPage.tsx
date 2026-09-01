import * as React from 'react'
import {
  AppWindowIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  DatabaseIcon,
  Loader2Icon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlugIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon
} from 'lucide-react'
import { toast } from 'sonner'

import type {
  DesktopPluginCenterApi,
  PluginCenterAddMarketplaceResult,
  PluginCenterApp,
  PluginCenterGetPluginDetailResult,
  PluginCenterGetRecommendedSkillsResult,
  PluginCenterMutationResult,
  PluginCenterPlugin,
  PluginCenterPluginDetail,
  PluginCenterPluginMcpServer,
  PluginCenterRecommendedSkill,
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
import { PluginCard } from './PluginCard'
import { PluginDetailSkillIcon } from './PluginDetailSkillIcon'
import { PluginImage } from './PluginImage'
import { PluginSkillCard } from './PluginSkillCard'
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
  type PluginCenterResource,
  type PluginCenterResourceSnapshot,
  type PluginCenterSupplementalSection
} from './pluginCenterDataResource'
import { PluginAppToolsDialog } from './PluginAppToolsDialog'
import { PluginDetailPage } from './PluginDetailPage'
import { PluginSkillPreviewDialog } from './PluginSkillPreviewDialog'
import { McpServerEditor, type McpServerEditorSaveInput } from './McpServerEditor'

export type PluginCenterPageKind = 'browse' | 'manage' | 'detail'
export type PluginCenterBrowseTab = 'plugins' | 'skills'
export type PluginCenterManageTab = 'plugins' | 'apps' | 'mcp' | 'skills'
export type PluginCenterTab = PluginCenterBrowseTab | PluginCenterManageTab
export type PluginCenterSkillBrowseCategory = 'personal' | 'system' | 'recommended'

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
  onTrySkill?: (input: { mention: { path: string; name: string } }) => void
}

type MutationStatus = { id: string; label: string } | null
type MutationOptions = {
  refreshInBackground?: boolean
  isSuccessful?: (result: PluginCenterMutationResult) => boolean
}

function directoryAppAsPluginDetailApp(
  app: PluginCenterApp
): PluginCenterPluginDetail['apps'][number] {
  const name = app.displayName ?? app.name
  return {
    id: app.id,
    name,
    ...(app.description ? { description: app.description } : {}),
    ...(app.installUrl ? { installUrl: app.installUrl } : {}),
    ...(app.icon ? { icon: app.icon } : {}),
    mention: { path: `app://${app.id}`, name },
    multiAccountCapability: 'unknown',
    enabled: app.enabled,
    accessible: app.accessible,
    canToggle: app.canToggle,
    ...(app.restriction ? { restriction: app.restriction } : {})
  }
}
type BrowsePluginsLoadingState = {
  catalog: boolean
  installed: boolean
}
type SelectedSkillPreview = {
  skill: Pick<
    PluginCenterSkill,
    'id' | 'name' | 'displayName' | 'description' | 'enabled' | 'canToggle'
  > & { icon?: PluginCenterPluginDetail['skills'][number]['icon'] }
  plugin?: { id: string; marketplaceId?: string }
  installPlugin?: PluginCenterPlugin
  uninstallSkill?: PluginCenterSkill
}
type ConfirmState =
  | { kind: 'plugin'; plugin: PluginCenterPlugin }
  | { kind: 'skill'; skill: PluginCenterSkill }
  | null
const FEATURED_CATEGORY_ID = '__featured__'
const CATEGORY_PREVIEW_LIMIT = 6
const MORE_PLUGIN_PREVIEW_LIMIT = 3

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

const SKILL_ACRONYMS = new Set([
  'API',
  'CI',
  'CLI',
  'CPU',
  'GH',
  'GPU',
  'IA',
  'LLM',
  'MCP',
  'PDF',
  'PR',
  'SQL',
  'TW',
  'UI',
  'URL'
])

const SKILL_WORD_MARKS = new Map([
  ['openai', 'OpenAI'],
  ['openaideveloperdocs', 'OpenAI Developer Docs'],
  ['openapi', 'OpenAPI'],
  ['github', 'GitHub'],
  ['pagerduty', 'PagerDuty'],
  ['datadog', 'DataDog'],
  ['sharepoint', 'SharePoint'],
  ['sqlite', 'SQLite'],
  ['fastapi', 'FastAPI']
])

const LOWERCASE_SKILL_TITLE_WORDS = new Set(['and', 'or', 'to', 'up', 'with'])

function skillTitle(skill: { displayName?: string; name: string }): string {
  return skill.displayName?.trim() || formatSkillName(skill.name)
}

function formatSkillName(name: string): string {
  return name
    .split(':')
    .map((segment) =>
      segment
        .replace(/[_-]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map((word, index) => formatSkillNameWord(word, index))
        .join(' ')
    )
    .join(': ')
}

function formatSkillNameWord(word: string, index: number): string {
  const acronym = word.toUpperCase()
  if (SKILL_ACRONYMS.has(acronym)) return acronym

  const lowercaseWord = word.toLowerCase()
  const brandedWord = SKILL_WORD_MARKS.get(lowercaseWord)
  if (brandedWord) return brandedWord
  if (index > 0 && LOWERCASE_SKILL_TITLE_WORDS.has(lowercaseWord)) return lowercaseWord
  return `${lowercaseWord.slice(0, 1).toUpperCase()}${lowercaseWord.slice(1)}`
}

function itemDescription(item: { description?: string }): string {
  return item.description ?? '暂无说明'
}

function matchesSearch(
  item: {
    id: string
    name: string
    displayName?: string
    description?: string
    shortDescription?: string
    tags?: string[]
  },
  search: string
): boolean {
  const query = search.trim().toLowerCase()
  if (!query) return true
  return [
    item.id,
    item.name,
    item.displayName,
    item.description,
    item.shortDescription,
    ...(item.tags ?? [])
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(query))
}

function isManagedAppVisible(app: PluginCenterApp): boolean {
  return app.accessible && app.enabled
}

function skillBrowseCategory(value: string | undefined): PluginCenterSkillBrowseCategory {
  if (value === 'system' || value === 'recommended') return value
  return 'personal'
}

function skillCategoryTitle(category: PluginCenterSkillBrowseCategory): string {
  switch (category) {
    case 'personal':
      return '个人技能'
    case 'system':
      return '系统技能'
    case 'recommended':
      return '推荐技能'
  }
}

function isPluginOwnedSkillPath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean)
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]?.toLowerCase() !== 'plugins') continue

    const cacheRoot = segments[index + 1]?.toLowerCase() === 'cache'
    const pluginIndex = index + (cacheRoot ? 3 : 1)
    if (!segments[pluginIndex]) continue

    const skillDirectoryIndex = segments.findIndex(
      (segment, segmentIndex) => segmentIndex > pluginIndex && segment.toLowerCase() === 'skills'
    )
    if (skillDirectoryIndex >= 0 && segments[skillDirectoryIndex + 1]) return true

    const remainingSegments = segments.slice(pluginIndex + 1)
    if (remainingSegments.length === 1 && remainingSegments[0]?.toLowerCase() === 'skill.md') {
      return true
    }
  }
  return false
}

function isStandaloneSkill(skill: PluginCenterSkill): boolean {
  return !skill.pluginId && !isPluginOwnedSkillPath(skill.id)
}

function normalizedSkillMatchKeys(
  skill: Pick<PluginCenterSkill, 'id' | 'name' | 'displayName'> | PluginCenterRecommendedSkill
): Set<string> {
  const keys = new Set<string>()
  const displayName = 'displayName' in skill ? skill.displayName : undefined
  for (const value of [skill.id, skill.name, displayName]) {
    if (!value) continue
    const normalized = value.trim().toLocaleLowerCase()
    if (!normalized) continue
    keys.add(normalized)
    const basename = normalized.split(/[\\/]/).at(-1)
    if (basename && basename !== 'skill.md') keys.add(basename)
  }
  return keys
}

function recommendedSkillIsInstalled(
  skill: PluginCenterRecommendedSkill,
  installedSkills: PluginCenterSkill[]
): boolean {
  const recommendedKeys = normalizedSkillMatchKeys(skill)
  return installedSkills.some((installed) => {
    for (const key of normalizedSkillMatchKeys(installed)) {
      if (recommendedKeys.has(key)) return true
    }
    return false
  })
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
  recommendedSkills,
  recommendedState,
  installedPlugins,
  search,
  mutation,
  requestContext,
  api,
  runMutation,
  onMcpEdit,
  onMcpAdd,
  setConfirm,
  onManageInstalledPlugins,
  onTryPlugin,
  onOpenCategory,
  onOpenSkillCategory,
  onOpenDetails,
  onOpenSkill,
  onInstallRecommendedSkill,
  onRetryRecommendedSkills,
  browsePluginsLoading
}: {
  surface: PluginCenterSurface
  browseTab: PluginCenterBrowseTab
  manageTab: PluginCenterManageTab
  snapshot: PluginCenterSnapshot
  recommendedSkills: PluginCenterRecommendedSkill[]
  recommendedState: PluginCenterResourceSnapshot<PluginCenterGetRecommendedSkillsResult>
  installedPlugins: PluginCenterPlugin[]
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
  onMcpEdit: (server: PluginCenterUserMcpServer) => void
  onMcpAdd: () => void
  setConfirm: React.Dispatch<React.SetStateAction<ConfirmState>>
  onManageInstalledPlugins: () => void
  onTryPlugin: (plugin: PluginCenterPlugin) => void
  onOpenCategory: (category: string) => void
  onOpenSkillCategory: (category: PluginCenterSkillBrowseCategory) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
  onOpenSkill: (skill: PluginCenterSkill) => void
  onInstallRecommendedSkill: (skill: PluginCenterRecommendedSkill) => void
  onRetryRecommendedSkills: () => void
  browsePluginsLoading: BrowsePluginsLoadingState
}): React.ReactNode {
  if (surface.page === 'browse' && browseTab === 'plugins') {
    return (
      <BrowsePlugins
        plugins={snapshot.plugins.filter((item) => matchesSearch(item, search))}
        installedPlugins={installedPlugins.filter((item) => matchesSearch(item, search))}
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
        onUninstall={(plugin) => setConfirm({ kind: 'plugin', plugin })}
        onManageInstalledPlugins={onManageInstalledPlugins}
        onTryPlugin={onTryPlugin}
        onOpenCategory={onOpenCategory}
        onOpenDetails={onOpenDetails}
      />
    )
  }

  if (surface.page === 'browse') {
    return (
      <BrowseSkills
        skills={snapshot.skills}
        recommendedSkills={recommendedSkills}
        category={skillBrowseCategory(surface.category)}
        search={search}
        pendingId={mutation?.id}
        onOpenSkill={onOpenSkill}
        onCategoryChange={onOpenSkillCategory}
        onInstallRecommendedSkill={onInstallRecommendedSkill}
        recommendedState={recommendedState}
        onRetry={onRetryRecommendedSkills}
      />
    )
  }

  return (
    <ManagePanel
      tab={manageTab}
      snapshot={snapshot}
      installedPlugins={installedPlugins}
      search={search}
      pendingId={mutation?.id}
      uninstallingPluginId={mutation?.label === '卸载插件' ? mutation.id : undefined}
      onPluginToggle={(plugin, enabled) =>
        void runMutation(plugin.id, enabled ? '启用插件' : '停用插件', () =>
          api!.setPluginEnabled({ ...requestContext, plugin: { id: plugin.id }, enabled })
        )
      }
      onPluginUninstall={(plugin) => setConfirm({ kind: 'plugin', plugin })}
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
      onOpenSkill={onOpenSkill}
      onMcpToggle={(server, enabled) =>
        void runMutation(server.id, enabled ? '启用 MCP' : '停用 MCP', () =>
          api!.setMcpServerEnabled({ ...requestContext, server: { id: server.id }, enabled })
        )
      }
      onMcpEdit={onMcpEdit}
      onMcpAdd={onMcpAdd}
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
  onTryApp,
  onTrySkill
}: PluginCenterPageProps): React.JSX.Element {
  const api = React.useMemo(() => getPluginCenterApi(apiProp), [apiProp])
  const snapshotSections = React.useMemo(() => snapshotSectionsForSurface(surface), [surface])
  const isDetailSurface = surface.page === 'detail'
  const usesPluginResources = !isDetailSurface && snapshotSections.length === 0
  const needsSkillPluginContext = !isDetailSurface && snapshotSections.includes('skills')
  const skillListMode =
    surface.page === 'manage' && surface.tab === 'skills' ? ('manage' as const) : undefined
  const catalogResource = React.useMemo(
    () => (api ? getPluginCenterCatalogResource(api, cwd) : null),
    [api, cwd]
  )
  const installedResource = React.useMemo(
    () => (api ? getPluginCenterInstalledResource(api, cwd) : null),
    [api, cwd]
  )
  const skillsResource = React.useMemo(
    () => (api ? getPluginCenterSupplementalResource(api, 'skills', cwd, skillListMode) : null),
    [api, cwd, skillListMode]
  )
  const recommendedSkillsResource = React.useMemo(
    () => (api ? getPluginCenterRecommendedSkillsResource(api) : null),
    [api]
  )
  const appsResource = React.useMemo(
    () => (api ? getPluginCenterSupplementalResource(api, 'apps', cwd) : null),
    [api, cwd]
  )
  const mcpResource = React.useMemo(
    () => (api ? getPluginCenterSupplementalResource(api, 'mcp', cwd) : null),
    [api, cwd]
  )
  const detailResource = React.useMemo(
    () =>
      api && surface.page === 'detail'
        ? getPluginCenterPluginDetailResource(api, surface.pluginRef, cwd)
        : null,
    [api, cwd, surface]
  )
  const supplementalSection = activeSupplementalSection(snapshotSections)
  const catalogState = usePluginCenterResource(
    catalogResource,
    usesPluginResources || needsSkillPluginContext
  )
  const installedState = usePluginCenterResource(
    installedResource,
    usesPluginResources || needsSkillPluginContext
  )
  const skillsState = usePluginCenterResource(skillsResource, supplementalSection === 'skills')
  const recommendedSkillsState = usePluginCenterResource(
    recommendedSkillsResource,
    surface.page === 'browse' && surface.tab === 'skills'
  )
  const appsState = usePluginCenterResource(
    appsResource,
    supplementalSection === 'apps' || isDetailSurface
  )
  const mcpState = usePluginCenterResource(
    mcpResource,
    supplementalSection === 'mcp' || isDetailSurface
  )
  const detailState = usePluginCenterResource(detailResource, isDetailSurface)
  const [selectedAppId, setSelectedAppId] = React.useState<string | null>(null)
  const [selectedSkillId, setSelectedSkillId] = React.useState<string | null>(null)
  const selectedApp = React.useMemo<PluginCenterPluginDetail['apps'][number] | null>(() => {
    const result = detailState.data
    if (!selectedAppId || result?.status !== 'ready') return null
    const detailApp = result.detail.apps.find((app) => app.id === selectedAppId)
    if (detailApp) return detailApp
    const directoryApp = appsState.data?.apps.find((app) => app.id === selectedAppId)
    return directoryApp ? directoryAppAsPluginDetailApp(directoryApp) : null
  }, [appsState.data, detailState.data, selectedAppId])
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
  const installedPlugins = React.useMemo(
    () => mergeInstalledPluginsForDisplay(snapshot.plugins, installedState.data ?? []),
    [installedState.data, snapshot.plugins]
  )
  const selectedSkill = React.useMemo<SelectedSkillPreview | null>(() => {
    if (!selectedSkillId) return null

    const detail = detailState.data
    if (surface.page === 'detail' && detail?.status === 'ready') {
      const skill = detail.detail.skills.find((candidate) => candidate.id === selectedSkillId)
      if (skill) return { skill, plugin: surface.pluginRef }
    }

    const skill = snapshot.skills.find((candidate) => candidate.id === selectedSkillId)
    if (!skill) return null
    const owner = skill.pluginId
      ? snapshot.plugins.find((plugin) => plugin.id === skill.pluginId)
      : undefined
    return {
      skill,
      ...(!skill.installed && owner
        ? { plugin: { id: owner.id, marketplaceId: owner.marketplaceId }, installPlugin: owner }
        : {}),
      ...(skill.canUninstall ? { uninstallSkill: skill } : {})
    }
  }, [detailState.data, selectedSkillId, snapshot.plugins, snapshot.skills, surface])
  const skillContentsResource = React.useMemo(
    () =>
      api && selectedSkill
        ? getPluginCenterSkillContentsResource(
            api,
            selectedSkill.plugin,
            { id: selectedSkill.skill.id, name: selectedSkill.skill.name },
            cwd
          )
        : null,
    [api, cwd, selectedSkill]
  )
  const skillContentsState = usePluginCenterResource(skillContentsResource, selectedSkill !== null)
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
  const [mcpEditor, setMcpEditor] = React.useState<McpEditorState>(null)
  const [confirm, setConfirm] = React.useState<ConfirmState>(null)
  const [browseScrollTop, setBrowseScrollTop] = React.useState(0)
  const scrollViewportRef = React.useRef<HTMLDivElement>(null)
  const pluginTrialInFlightIds = React.useRef(new Set<string>())

  const editingMcpServer =
    mcpEditor?.kind === 'edit'
      ? (snapshot.mcp.userServers.find((server) => server.id === mcpEditor.serverId) ?? null)
      : null
  const activeMcpEditor = mcpEditor?.kind === 'edit' && !editingMcpServer ? null : mcpEditor
  const mcpEditorActive =
    surface.page === 'manage' && surface.tab === 'mcp' && activeMcpEditor !== null

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
        await Promise.all([
          detailResource?.refresh(forceRefresh),
          appsResource?.refresh(forceRefresh),
          mcpResource?.refresh(forceRefresh)
        ])
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
        await Promise.all([
          refreshSupplementalSections([supplementalSection], forceRefresh, false),
          ...(supplementalSection === 'skills'
            ? [recommendedSkillsResource?.refresh(forceRefresh)]
            : []),
          ...(needsSkillPluginContext
            ? [catalogResource?.refresh(forceRefresh), installedResource?.refresh(forceRefresh)]
            : [])
        ])
      }
    },
    [
      catalogResource,
      appsResource,
      detailResource,
      installedResource,
      isDetailSurface,
      mcpResource,
      needsSkillPluginContext,
      recommendedSkillsResource,
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
      if (
        changedSections.has('installed') &&
        installedResource &&
        changedItemId &&
        result.targetInstalled !== undefined
      ) {
        const targetInstalled = result.targetInstalled
        const catalogPlugin = catalogResource
          ?.getSnapshot()
          .data?.plugins.find((plugin) => plugin.id === changedItemId)
        const detail = detailResource?.getSnapshot().data
        const plugin =
          catalogPlugin ??
          (detail?.status === 'ready' && detail.detail.plugin.id === changedItemId
            ? detail.detail.plugin
            : undefined)
        installedResource.update((plugins) =>
          applyInstalledMutation(plugins, changedItemId, plugin, targetInstalled)
        )
      }
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

  const installRecommendedSkill = React.useCallback(
    async (skill: PluginCenterRecommendedSkill): Promise<void> => {
      if (!api) return
      const installed = await runMutation(`recommended-skill:${skill.id}`, '安装技能', () =>
        api.installRecommendedSkill({
          ...requestContext,
          id: skill.id,
          repoPath: skill.repoPath
        })
      )
      if (!installed) return
      recommendedSkillsResource?.invalidate()
      await recommendedSkillsResource?.refresh(true)
    },
    [api, recommendedSkillsResource, requestContext, runMutation]
  )

  const installSkillOwningPlugin = React.useCallback(
    async (plugin: PluginCenterPlugin): Promise<void> => {
      if (!api) return
      const installed = await runMutation(plugin.id, '安装插件', () =>
        api.installPlugin({
          ...requestContext,
          plugin: { id: plugin.id, marketplaceId: plugin.marketplaceId }
        })
      )
      if (installed) await refreshSupplementalSections(['skills'], true, true)
    },
    [api, refreshSupplementalSections, requestContext, runMutation]
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
      setActionError(null)
      try {
        let current = detail.detail
        const needsPreparation = !current.plugin.installed || !current.plugin.enabled
        if (needsPreparation) setMutation({ id: current.plugin.id, label: '准备插件' })
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

  const tryInstalledPlugin = React.useCallback(
    async (plugin: PluginCenterPlugin) => {
      if (!api || mutation || !plugin.enabled || pluginTrialInFlightIds.current.has(plugin.id)) {
        return
      }

      pluginTrialInFlightIds.current.add(plugin.id)
      setActionError(null)
      try {
        const result = await api.getPluginDetail({
          ...requestContext,
          plugin: { id: plugin.id, marketplaceId: plugin.marketplaceId }
        })
        if (
          result.status !== 'ready' ||
          !result.detail.plugin.installed ||
          !result.detail.plugin.enabled
        ) {
          throw new Error('插件当前不可立即试用')
        }
        onActivatePluginPrompt?.({
          mention: result.detail.mention,
          prompt: result.detail.defaultPrompts[0] ?? ''
        })
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : '无法立即试用插件'
        setActionError(message)
        toast.error(message)
      } finally {
        pluginTrialInFlightIds.current.delete(plugin.id)
      }
    },
    [api, mutation, onActivatePluginPrompt, requestContext, setActionError]
  )

  const skillPreviewDialog = selectedSkill ? (
    <PluginSkillPreviewDialog
      key={`${selectedSkill.plugin?.id ?? 'local'}:${selectedSkill.skill.id}`}
      skill={selectedSkill.skill}
      open
      state={skillContentsState}
      pending={
        mutation !== null &&
        (mutation.id === selectedSkill.skill.id || mutation.id === selectedSkill.installPlugin?.id)
      }
      onOpenChange={(open) => {
        if (!open) setSelectedSkillId(null)
      }}
      onToggle={(enabled) =>
        void runMutation(
          selectedSkill.skill.id,
          enabled ? '启用技能' : '停用技能',
          () =>
            api!.setSkillEnabled({
              ...requestContext,
              skill: { id: selectedSkill.skill.id },
              enabled
            }),
          { refreshInBackground: true }
        )
      }
      onTrySkill={() => {
        const contents = skillContentsState.data
        if (contents?.status !== 'ready' || !contents.localPath || !selectedSkill.skill.enabled) {
          return
        }
        setSelectedSkillId(null)
        onTrySkill?.({
          mention: {
            path: contents.localPath,
            name: selectedSkill.skill.displayName ?? selectedSkill.skill.name
          }
        })
      }}
      onOpenLocalPath={(path) => {
        void window.desktopApp.codex.openLocalPath({ path, ...(cwd ? { cwd } : {}) })
      }}
      onRetry={() => {
        skillContentsResource?.invalidate()
        void skillContentsResource?.refresh(true)
      }}
      {...(selectedSkill.installPlugin
        ? {
            installAction: {
              pending: mutation?.id === selectedSkill.installPlugin.id,
              onInstall: () => void installSkillOwningPlugin(selectedSkill.installPlugin!)
            }
          }
        : {})}
      {...(selectedSkill.uninstallSkill
        ? {
            uninstallAction: {
              pending: mutation?.id === selectedSkill.uninstallSkill.id,
              onUninstall: () => {
                setConfirm({ kind: 'skill', skill: selectedSkill.uninstallSkill! })
                setSelectedSkillId(null)
              }
            }
          }
        : {})}
    />
  ) : null

  const mcpEditorDialog = mcpEditorActive ? (
    <McpServerEditor
      server={activeMcpEditor.kind === 'edit' ? editingMcpServer : null}
      pending={Boolean(mutation)}
      error={actionError}
      onBack={() => {
        setActionError(null)
        setMcpEditor(null)
      }}
      onSave={(input: McpServerEditorSaveInput) => {
        void (async () => {
          const saved = await runMutation(
            input.serverId ?? input.displayName ?? 'new-mcp',
            input.serverId ? '保存 MCP' : '添加 MCP',
            () => api!.upsertMcpServer({ ...requestContext, ...input })
          )
          if (saved) setMcpEditor(null)
        })()
      }}
      onUninstall={() => {
        if (!editingMcpServer) return
        void (async () => {
          const removed = await runMutation(editingMcpServer.id, '卸载 MCP', () =>
            api!.removeMcpServer({ ...requestContext, server: { id: editingMcpServer.id } })
          )
          if (removed) setMcpEditor(null)
        })()
      }}
      onOpenDocumentation={() => void openExternal('https://modelcontextprotocol.io/introduction')}
    />
  ) : null

  const contentView =
    loading && !separatesPluginLoading ? (
      <PluginCategoriesSkeleton />
    ) : (
      // The resolver only creates element trees; callbacks are invoked by their controls.
      // eslint-disable-next-line react-hooks/refs
      resolveContentView({
        surface,
        browseTab: currentBrowseTab,
        manageTab: currentManageTab,
        snapshot,
        recommendedSkills: recommendedSkillsState.data?.skills ?? [],
        recommendedState: recommendedSkillsState,
        installedPlugins,
        search,
        mutation,
        requestContext,
        api,
        runMutation,
        onMcpEdit: (server) => setMcpEditor({ kind: 'edit', serverId: server.id }),
        onMcpAdd: () => setMcpEditor({ kind: 'new' }),
        setConfirm,
        onManageInstalledPlugins: () => navigateManage('plugins'),
        onTryPlugin: (plugin) => void tryInstalledPlugin(plugin),
        onOpenCategory: (category) => navigateBrowse('plugins', category),
        onOpenSkillCategory: (category) => navigateBrowse('skills', category),
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
        onOpenSkill: (skill) => setSelectedSkillId(skill.id),
        onInstallRecommendedSkill: (skill) => void installRecommendedSkill(skill),
        onRetryRecommendedSkills: () => {
          recommendedSkillsResource?.invalidate()
          void recommendedSkillsResource?.refresh(true)
        },
        browsePluginsLoading: { catalog: catalogLoading, installed: installedLoading }
      })
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
            {!mcpEditorActive && (error || actionError) && (
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
                directoryApps={appsState.data?.apps ?? []}
                mcpServers={mcpState.data?.mcp ?? emptySnapshot.mcp}
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
                onTry={() =>
                  onActivatePluginPrompt?.({
                    mention: readyDetail.detail.mention,
                    prompt: readyDetail.detail.defaultPrompts[0] ?? ''
                  })
                }
                onConnectApp={(app) => void connectApp(app)}
                onReconnectApp={reconnectApp}
                onDisconnectApp={disconnectApp}
                onOpenAppTools={(app) => setSelectedAppId(app.id)}
                onMcpToggle={(server, enabled) =>
                  runMutation(
                    server.id,
                    enabled ? '启用 MCP 服务器' : '停用 MCP 服务器',
                    () =>
                      api!.setMcpServerEnabled({
                        ...requestContext,
                        server: { id: server.id },
                        enabled
                      }),
                    { refreshInBackground: true }
                  )
                }
                onOpenMcpSettings={() => onSurfaceChange({ page: 'manage', tab: 'mcp' })}
                onOpenSkill={(skill) => setSelectedSkillId(skill.id)}
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
                api!.uninstallPlugin({
                  ...requestContext,
                  plugin: { id: current.plugin.id, marketplaceId: current.plugin.marketplaceId }
                })
              )
            } else if (current?.kind === 'skill') {
              void runMutation(current.skill.id, '卸载技能', () =>
                api!.uninstallSkill({
                  ...requestContext,
                  skill: { id: current.skill.id, name: current.skill.name }
                })
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
        {skillPreviewDialog}
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
            onAddMcp={() => {
              onSurfaceChange({ page: 'manage', tab: 'mcp' })
              setMcpEditor({ kind: 'new' })
            }}
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
                  <h1 className="text-xl leading-[1.2] font-normal">
                    {currentBrowseTab === 'skills' ? '技能' : '插件'}
                  </h1>
                  <p className="mt-2 text-lg leading-6 text-muted-foreground">
                    {currentBrowseTab === 'skills'
                      ? '通过任务专用技能扩展 Codex'
                      : '在你常用的工具中使用 Codex'}
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
                      {hasVisiblePluginData ? ` ${installedPlugins.length}` : ''}
                    </TabsTrigger>
                    <TabsTrigger value="apps">
                      应用
                      {loadedSections.has('apps')
                        ? ` ${snapshot.apps.filter(isManagedAppVisible).length}`
                        : ''}
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
                  aria-label={
                    surface.page === 'browse'
                      ? currentBrowseTab === 'skills'
                        ? '搜索技能'
                        : '搜索插件'
                      : '搜索当前管理项'
                  }
                  placeholder={
                    surface.page === 'browse'
                      ? currentBrowseTab === 'skills'
                        ? '搜索技能'
                        : '搜索插件'
                      : '搜索当前管理项'
                  }
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
      {mcpEditorDialog}
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
              api!.uninstallPlugin({
                ...requestContext,
                plugin: { id: current.plugin.id, marketplaceId: current.plugin.marketplaceId }
              })
            )
          } else if (current.kind === 'skill') {
            void runMutation(current.skill.id, '卸载技能', () =>
              api!.uninstallSkill({
                ...requestContext,
                skill: { id: current.skill.id, name: current.skill.name }
              })
            )
          }
        }}
      />
      {skillPreviewDialog}
      <Toaster position="top-center" richColors closeButton />
    </main>
  )
}

function applyInstalledMutation(
  plugins: PluginCenterPlugin[],
  pluginId: string,
  catalogPlugin: PluginCenterPlugin | undefined,
  targetInstalled: boolean
): PluginCenterPlugin[] {
  const currentIndex = plugins.findIndex((plugin) => plugin.id === pluginId)
  if (!targetInstalled) {
    return currentIndex < 0 ? plugins : plugins.filter((plugin) => plugin.id !== pluginId)
  }
  if (!catalogPlugin) return plugins

  const installedPlugin: PluginCenterPlugin = {
    ...catalogPlugin,
    installed: true,
    enabled: true,
    canInstall: false,
    canUninstall: true,
    canToggle: true,
    restriction: undefined
  }
  if (currentIndex < 0) return [...plugins, installedPlugin]
  return plugins.map((plugin, index) => (index === currentIndex ? installedPlugin : plugin))
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
      : state?.kind === 'skill'
        ? '这会删除该独立技能的本地目录，无法撤销。'
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
  if (state?.kind === 'skill') return `卸载 ${itemTitle(state.skill)}？`
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
  description,
  action
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}): React.JSX.Element {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {icon}
      </div>
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
      {action && (
        <Button type="button" size="sm" variant="outline" className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
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
  installedPlugins,
  category,
  catalogUnavailableReason,
  loading,
  pendingId,
  onInstall,
  onUninstall,
  onManageInstalledPlugins,
  onTryPlugin,
  onOpenCategory,
  onOpenDetails
}: {
  plugins: PluginCenterPlugin[]
  installedPlugins: PluginCenterPlugin[]
  category?: string
  catalogUnavailableReason?: string
  loading: BrowsePluginsLoadingState
  pendingId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onManageInstalledPlugins: () => void
  onTryPlugin: (plugin: PluginCenterPlugin) => void
  onOpenCategory: (category: string) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  const featured = plugins.filter((plugin) => plugin.featured)
  const catalogGroups = groupCatalogPlugins(plugins.filter((plugin) => !plugin.featured))

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
          onUninstall={onUninstall}
          onManage={onOpenDetails}
          onTry={onTryPlugin}
          onOpenDetails={onOpenDetails}
        />
      </BrowseSection>
    )
  }

  let installedContent: React.ReactNode = null
  if (loading.installed) {
    installedContent = <InstalledPluginsSkeleton />
  } else if (installedPlugins.length > 0) {
    installedContent = (
      <InstalledPluginsSection
        plugins={installedPlugins}
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
              onUninstall={onUninstall}
              onManage={onOpenDetails}
              onTry={onTryPlugin}
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
              onUninstall={onUninstall}
              onManage={onOpenDetails}
              onTry={onTryPlugin}
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
  onUninstall,
  onManage,
  onTry,
  onOpenDetails,
  onSeeMore
}: {
  plugins: PluginCenterPlugin[]
  pendingId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onManage: (plugin: PluginCenterPlugin) => void
  onTry: (plugin: PluginCenterPlugin) => void
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
        onUninstall={onUninstall}
        onManage={onManage}
        onTry={onTry}
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
  onUninstall,
  onManage,
  onTry,
  onOpenDetails
}: {
  plugins: PluginCenterPlugin[]
  pendingId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onManage: (plugin: PluginCenterPlugin) => void
  onTry: (plugin: PluginCenterPlugin) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
      {plugins.map((plugin) => (
        <CatalogPluginCard
          key={plugin.id}
          plugin={plugin}
          pending={pendingId === plugin.id}
          onInstall={onInstall}
          onUninstall={onUninstall}
          onManage={onManage}
          onTry={onTry}
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
  action,
  children
}: {
  title: string
  description?: string
  dataSlot?: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-slot={dataSlot}>
      <div className="mb-3 flex items-start justify-between gap-3 border-b border-border/40 px-2 pb-3">
        <div>
          <h2 className="text-lg leading-6 font-medium">{title}</h2>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

type InstallActionButtonProps = {
  pending: boolean
  disabled: boolean
  ariaLabel?: string
  title?: string
  onClick: () => void
}

function InstallActionButton({
  pending,
  disabled,
  ariaLabel,
  title,
  onClick
}: InstallActionButtonProps): React.JSX.Element {
  return (
    <Button
      variant="outline"
      size="composer"
      type="button"
      className="shrink-0 gap-1 rounded-lg px-2 text-base leading-[18px]"
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
    >
      {pending && <Loader2Icon className="size-4 animate-spin" />}
      安装
    </Button>
  )
}

function CatalogPluginCard({
  plugin,
  pending,
  uninstalling = false,
  onInstall,
  onToggle,
  onUninstall,
  onManage,
  onTry,
  onOpenDetails
}: {
  plugin: PluginCenterPlugin
  pending: boolean
  uninstalling?: boolean
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle?: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onManage?: (plugin: PluginCenterPlugin) => void
  onTry?: (plugin: PluginCenterPlugin) => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  const handleUninstall = (): void => onUninstall(plugin)
  let actions: React.ReactNode
  if (!plugin.installed) {
    actions = (
      <InstallActionButton
        pending={pending}
        disabled={pending || !plugin.canInstall}
        title={plugin.restriction?.message}
        onClick={() => onInstall(plugin)}
      />
    )
  } else if (onToggle) {
    actions = (
      <ManagePluginCardActions
        plugin={plugin}
        pending={pending}
        uninstalling={uninstalling}
        onToggle={(enabled) => onToggle(plugin, enabled)}
        onUninstall={handleUninstall}
      />
    )
  } else if (onManage && onTry) {
    actions = (
      <InstalledPluginCardActions
        plugin={plugin}
        pending={pending}
        uninstalling={pending}
        onUninstall={handleUninstall}
        onManage={() => onManage(plugin)}
        onTry={() => onTry(plugin)}
      />
    )
  }

  return (
    <PluginCard
      title={itemTitle(plugin)}
      description={itemDescription(plugin)}
      icon={
        <ItemIcon
          icon={plugin.icon}
          title={itemTitle(plugin)}
          fallback={<PuzzleIcon className="size-4" />}
          className="size-10 rounded-lg bg-transparent object-contain"
        />
      }
      actions={actions}
      ariaLabel={`查看 ${itemTitle(plugin)} 详情`}
      onClick={() => onOpenDetails(plugin)}
    />
  )
}

function ManagePluginCardActions({
  plugin,
  pending,
  uninstalling,
  onToggle,
  onUninstall
}: {
  plugin: PluginCenterPlugin
  pending: boolean
  uninstalling: boolean
  onToggle: (enabled: boolean) => void
  onUninstall: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {uninstalling ? (
        <PluginUninstallStatus />
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100"
              disabled={pending}
              aria-label="更多插件操作"
              title="更多操作"
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!plugin.canUninstall} onSelect={onUninstall}>
              卸载
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Switch
        checked={plugin.enabled}
        disabled={pending || !plugin.canToggle}
        title={plugin.restriction?.message}
        aria-label={plugin.enabled ? '停用' : '启用'}
        onCheckedChange={onToggle}
      />
    </div>
  )
}

function PluginUninstallStatus(): React.JSX.Element {
  return (
    <span data-slot="plugin-uninstall-status" className="text-xs text-muted-foreground">
      正在卸载
    </span>
  )
}

function InstalledPluginCardActions({
  plugin,
  pending,
  uninstalling,
  onUninstall,
  onManage,
  onTry
}: {
  plugin: PluginCenterPlugin
  pending: boolean
  uninstalling: boolean
  onUninstall: () => void
  onManage: () => void
  onTry: () => void
}): React.JSX.Element {
  if (uninstalling) return <PluginUninstallStatus />

  return (
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
        {plugin.enabled && (
          <DropdownMenuItem onSelect={onTry}>
            <MessageSquareIcon className="size-4" />
            立即试用
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onManage}>
          <SettingsIcon className="size-4" />
          管理
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
          disabled={!plugin.canUninstall}
          onSelect={onUninstall}
        >
          <Trash2Icon className="size-4" />
          卸载
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function BrowseSkills({
  skills,
  recommendedSkills,
  category,
  search,
  pendingId,
  onOpenSkill,
  onCategoryChange,
  onInstallRecommendedSkill,
  recommendedState,
  onRetry
}: {
  skills: PluginCenterSkill[]
  recommendedSkills: PluginCenterRecommendedSkill[]
  category: PluginCenterSkillBrowseCategory
  search: string
  pendingId?: string
  onOpenSkill: (skill: PluginCenterSkill) => void
  onCategoryChange: (category: PluginCenterSkillBrowseCategory) => void
  onInstallRecommendedSkill: (skill: PluginCenterRecommendedSkill) => void
  recommendedState: PluginCenterResourceSnapshot<PluginCenterGetRecommendedSkillsResult>
  onRetry: () => void
}): React.JSX.Element {
  const [isOverviewExpanded, setIsOverviewExpanded] = React.useState(false)
  const allInstalled = skills.filter((skill) => skill.installed)
  const installed = allInstalled
    .filter(isStandaloneSkill)
    .sort((left, right) =>
      skillTitle(left).localeCompare(skillTitle(right), undefined, { sensitivity: 'base' })
    )
  const overviewSkills = installed.filter((skill) => matchesSearch(skill, search))
  const hiddenOverviewSkills = overviewSkills.slice(6)
  const visibleOverviewSkills = isOverviewExpanded ? overviewSkills : overviewSkills.slice(0, 6)
  const categorySkills =
    category === 'system'
      ? installed.filter((skill) => skill.scope === 'system' && matchesSearch(skill, search))
      : installed.filter((skill) => skill.scope !== 'system' && matchesSearch(skill, search))
  const availableRecommendedSkills = recommendedSkills.filter(
    (skill) => !recommendedSkillIsInstalled(skill, allInstalled) && matchesSearch(skill, search)
  )
  const categoryTitle = skillCategoryTitle(category)
  const hasSearch = Boolean(search.trim())

  return (
    <div className="space-y-8">
      <BrowseSection title="已安装">
        {overviewSkills.length > 0 ? (
          <>
            <div data-slot="installed-skills-overview" className="grid gap-2 lg:grid-cols-2">
              {visibleOverviewSkills.map((skill) => (
                <InstalledSkillBrowseRow key={skill.id} skill={skill} onOpenSkill={onOpenSkill} />
              ))}
            </div>
            {hiddenOverviewSkills.length > 0 && (
              <button
                type="button"
                data-slot="installed-skills-summary"
                className="mt-4 flex min-h-[31px] w-full cursor-pointer items-center gap-3 self-start rounded-lg px-2.5 py-[5px] text-left text-[12px] leading-relaxed font-normal text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-expanded={isOverviewExpanded}
                onClick={() => setIsOverviewExpanded((expanded) => !expanded)}
              >
                {isOverviewExpanded ? '收起' : hiddenSkillSummary(hiddenOverviewSkills)}
              </button>
            )}
          </>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            {hasSearch ? '没有与搜索词匹配的已安装技能。' : '暂未安装任何技能。'}
          </p>
        )}
      </BrowseSection>

      <Tabs
        value={category}
        onValueChange={(value) => onCategoryChange(value as PluginCenterSkillBrowseCategory)}
      >
        <TabsList aria-label="技能分类">
          <TabsTrigger value="personal">个人</TabsTrigger>
          <TabsTrigger value="system">系统</TabsTrigger>
          <TabsTrigger value="recommended">推荐</TabsTrigger>
        </TabsList>
      </Tabs>

      {category === 'recommended' ? (
        <RecommendedSkillsState
          skills={availableRecommendedSkills}
          search={search}
          state={recommendedState}
          pendingId={pendingId}
          onInstall={onInstallRecommendedSkill}
          onRetry={onRetry}
        />
      ) : (
        <BrowseSection title={categoryTitle}>
          {categorySkills.length > 0 ? (
            <div data-slot="skill-category-grid" className="grid gap-2 lg:grid-cols-2">
              {categorySkills.map((skill) => (
                <InstalledSkillBrowseRow key={skill.id} skill={skill} onOpenSkill={onOpenSkill} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<SparklesIcon className="size-5" />}
              title={hasSearch ? '没有匹配的技能' : `没有${categoryTitle}`}
              description={
                hasSearch
                  ? '请尝试其他关键词，搜索会匹配名称、描述和标签。'
                  : '安装或创建技能后会显示在这里。'
              }
            />
          )}
        </BrowseSection>
      )}
    </div>
  )
}

function hiddenSkillSummary(skills: PluginCenterSkill[]): string {
  const namedSkills = skills.slice(0, 2).map(skillTitle)
  const remaining = skills.length - namedSkills.length
  return `查看 ${namedSkills.join('、')}${remaining > 0 ? `，另有 ${remaining} 项` : ''}`
}

function InstalledSkillBrowseRow({
  skill,
  onOpenSkill
}: {
  skill: PluginCenterSkill
  onOpenSkill: (skill: PluginCenterSkill) => void
}): React.JSX.Element {
  return (
    <PluginCard
      dataSlot="skill-card"
      title={skillTitle(skill)}
      description={itemDescription(skill)}
      ariaLabel={`预览技能 ${skillTitle(skill)}`}
      onClick={() => onOpenSkill(skill)}
      icon={
        <PluginImage
          icon={skill.iconLarge ?? skill.iconSmall}
          title={skillTitle(skill)}
          fallback={<PluginDetailSkillIcon />}
          className="size-10 shrink-0 rounded-lg border-0 bg-transparent object-contain"
        />
      }
      actions={
        <span aria-label={`${skillTitle(skill)} 已安装`} title="已安装">
          <CheckIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
      }
    />
  )
}

function RecommendedSkillsState({
  skills,
  search,
  state,
  pendingId,
  onInstall,
  onRetry
}: {
  skills: PluginCenterRecommendedSkill[]
  search: string
  state: PluginCenterResourceSnapshot<PluginCenterGetRecommendedSkillsResult>
  pendingId?: string
  onInstall: (skill: PluginCenterRecommendedSkill) => void
  onRetry: () => void
}): React.JSX.Element {
  const initialLoading = isInitialResourceLoading(state)
  const hasSearch = Boolean(search.trim())
  if (initialLoading) return <SkillBrowseLoading label="正在加载推荐技能" />
  if (state.data === null && state.error) {
    return (
      <EmptyState
        icon={<CircleAlertIcon className="size-5" />}
        title="无法加载推荐技能"
        description={state.error}
        action={{ label: '重试', onClick: onRetry }}
      />
    )
  }

  return (
    <BrowseSection title="推荐技能" description="由精选目录提供，可直接安装到你的个人技能中。">
      {state.data?.error && (
        <div
          data-slot="recommended-skills-warning"
          className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
        >
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-muted-foreground">{state.data.error}</span>
        </div>
      )}
      {skills.length > 0 ? (
        <div data-slot="recommended-skills-grid" className="grid gap-2 lg:grid-cols-2">
          {skills.map((skill) => (
            <RecommendedSkillBrowseRow
              key={skill.id}
              skill={skill}
              pending={pendingId === `recommended-skill:${skill.id}`}
              onInstall={onInstall}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<SparklesIcon className="size-5" />}
          title={hasSearch ? '没有匹配的推荐技能' : '暂无推荐技能'}
          description={hasSearch ? '请尝试其他关键词。' : '已安装的推荐技能不会重复显示在这里。'}
        />
      )}
    </BrowseSection>
  )
}

function SkillBrowseLoading({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {label}
    </div>
  )
}

function RecommendedSkillBrowseRow({
  skill,
  pending,
  onInstall
}: {
  skill: PluginCenterRecommendedSkill
  pending: boolean
  onInstall: (skill: PluginCenterRecommendedSkill) => void
}): React.JSX.Element {
  const description = skill.shortDescription ?? skill.description ?? '暂无说明'
  return (
    <PluginCard
      dataSlot="recommended-skill-card"
      title={skill.name}
      description={description}
      icon={
        <PluginImage
          icon={skill.iconLarge ?? skill.iconSmall}
          title={skill.name}
          fallback={<PluginDetailSkillIcon />}
          className="size-10 shrink-0 rounded-lg border-0 bg-transparent object-contain"
        />
      }
      actions={
        <InstallActionButton
          pending={pending}
          disabled={pending}
          ariaLabel={`安装技能 ${skill.name}`}
          onClick={() => onInstall(skill)}
        />
      }
    />
  )
}

function ManagedSkillCard({
  skill,
  pending,
  onOpenSkill,
  onToggle
}: {
  skill: PluginCenterSkill
  pending: boolean
  onOpenSkill: (skill: PluginCenterSkill) => void
  onToggle: (skill: PluginCenterSkill, enabled: boolean) => Promise<boolean>
}): React.JSX.Element {
  const title = skillTitle(skill)
  return (
    <PluginSkillCard
      dataSlot="managed-skill-card"
      ariaLabel={`查看技能 ${title}`}
      title={title}
      description={skill.description}
      icon={skill.iconLarge ?? skill.iconSmall}
      enabled={skill.enabled}
      canToggle={skill.canToggle}
      pending={pending}
      disabledMessage={skill.restriction?.message}
      onOpen={() => onOpenSkill(skill)}
      onToggle={(enabled) => onToggle(skill, enabled)}
    />
  )
}

function ManagePanel({
  tab,
  snapshot,
  installedPlugins,
  search,
  pendingId,
  uninstallingPluginId,
  onPluginToggle,
  onPluginUninstall,
  onAppToggle,
  onSkillToggle,
  onOpenSkill,
  onMcpToggle,
  onMcpEdit,
  onMcpAdd,
  onOpenDetails
}: {
  tab: PluginCenterManageTab
  snapshot: PluginCenterSnapshot
  installedPlugins: PluginCenterPlugin[]
  search: string
  pendingId?: string
  uninstallingPluginId?: string
  onPluginToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onPluginUninstall: (plugin: PluginCenterPlugin) => void
  onAppToggle: (app: PluginCenterApp, enabled: boolean) => void
  onSkillToggle: (skill: PluginCenterSkill, enabled: boolean) => Promise<boolean>
  onOpenSkill: (skill: PluginCenterSkill) => void
  onMcpToggle: (server: PluginCenterUserMcpServer, enabled: boolean) => void
  onMcpEdit: (server: PluginCenterUserMcpServer) => void
  onMcpAdd: () => void
  onOpenDetails: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  if (tab === 'plugins') {
    const plugins = installedPlugins.filter((plugin) => matchesSearch(plugin, search))
    return plugins.length ? (
      <div className="grid gap-3">
        {plugins.map((plugin) => (
          <CatalogPluginCard
            key={plugin.id}
            plugin={plugin}
            pending={pendingId === plugin.id}
            uninstalling={uninstallingPluginId === plugin.id}
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
    const apps = snapshot.apps.filter(
      (app) => isManagedAppVisible(app) && matchesSearch(app, search)
    )
    return apps.length ? (
      <div className="grid min-w-0 grid-cols-1 gap-y-2">
        {apps.map((app) => (
          <AppRow key={app.id} app={app} pending={pendingId === app.id} onToggle={onAppToggle} />
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
    const skills = snapshot.skills
      .filter((skill) => matchesSearch(skill, search))
      .sort(
        (left, right) =>
          skillTitle(left).localeCompare(skillTitle(right)) || left.name.localeCompare(right.name)
      )
    return skills.length ? (
      <div className="grid gap-2 [--detail-page-inline-inset:0.5rem]">
        {skills.map((skill) => (
          <ManagedSkillCard
            key={skill.id}
            skill={skill}
            pending={pendingId === skill.id}
            onOpenSkill={onOpenSkill}
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
      onAdd={onMcpAdd}
    />
  )
}

function AppRow({
  app,
  pending,
  onToggle
}: {
  app: PluginCenterApp
  pending: boolean
  onToggle: (app: PluginCenterApp, enabled: boolean) => void
}): React.JSX.Element {
  return (
    <PluginCard
      dataSlot="app-card"
      className="min-w-0"
      title={itemTitle(app)}
      description={itemDescription(app)}
      icon={
        <ItemIcon
          icon={app.icon}
          title={itemTitle(app)}
          fallback={<AppWindowIcon className="size-4" />}
          className="size-10 rounded-lg bg-transparent object-contain"
        />
      }
      actions={
        <Switch
          checked={app.enabled}
          disabled={pending || !app.canToggle}
          title={app.restriction?.message}
          aria-label={`${itemTitle(app)} 停用`}
          onCheckedChange={(enabled) => onToggle(app, enabled)}
        />
      }
    />
  )
}

function McpPanel({
  userServers,
  pluginServers,
  pendingId,
  onToggle,
  onEdit,
  onAdd
}: {
  userServers: PluginCenterUserMcpServer[]
  pluginServers: PluginCenterPluginMcpServer[]
  pendingId?: string
  onToggle: (server: PluginCenterUserMcpServer, enabled: boolean) => void
  onEdit: (server: PluginCenterUserMcpServer) => void
  onAdd: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-7">
      <BrowseSection
        title="普通服务器"
        action={
          <Button type="button" size="sm" onClick={onAdd}>
            <PlusIcon className="size-4" />
            添加服务器
          </Button>
        }
      >
        {userServers.length > 0 ? (
          <div className="grid gap-2">
            {userServers.map((server) => (
              <McpUserRow
                key={server.id}
                server={server}
                pending={pendingId === server.id}
                onToggle={onToggle}
                onEdit={onEdit}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">暂无普通服务器。</p>
        )}
      </BrowseSection>
      <BrowseSection title="来自插件">
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
  onEdit
}: {
  server: PluginCenterUserMcpServer
  pending: boolean
  onToggle: (server: PluginCenterUserMcpServer, enabled: boolean) => void
  onEdit: (server: PluginCenterUserMcpServer) => void
}): React.JSX.Element {
  return (
    <article className="flex items-center gap-3 rounded-lg border bg-card p-3">
      <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <PlugIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{server.displayName ?? server.name}</div>
      </div>
      <Switch
        checked={server.enabled}
        disabled={pending || !server.editable}
        title={server.restriction?.message}
        aria-label={`${server.displayName ?? server.name} ${server.enabled ? '停用' : '启用'}`}
        onCheckedChange={(enabled) => onToggle(server, enabled)}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        disabled={pending || !server.editable}
        aria-label={`打开 ${server.displayName ?? server.name} MCP 设置`}
        title="设置"
        onClick={() => {
          if (server.origin === 'user' && server.editable) onEdit(server)
        }}
      >
        <SettingsIcon className="size-4" />
      </Button>
    </article>
  )
}

function McpPluginRow({ server }: { server: PluginCenterPluginMcpServer }): React.JSX.Element {
  const pluginName = server.pluginDisplayName ?? server.pluginId
  return (
    <article className="flex items-center gap-3 rounded-lg border bg-card p-3 opacity-90">
      <div className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <PlugIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{server.displayName ?? server.name}</div>
        <p className="truncate text-sm text-muted-foreground">
          {pluginName ? `来自 ${pluginName}` : '来自插件'} · {server.toolCount} 个工具
        </p>
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

type McpEditorState = { kind: 'new' } | { kind: 'edit'; serverId: string } | null

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
