import * as React from 'react'
import {
  AppWindowIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LockKeyholeIcon,
  Loader2Icon,
  PuzzleIcon,
  ServerIcon,
  SettingsIcon
} from 'lucide-react'

import type {
  PluginCenterApp,
  PluginCenterMcpSnapshot,
  PluginCenterPlugin,
  PluginCenterPluginDetail
} from '../../../../shared/pluginCenterApi'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { OptimisticSkillSwitch } from './OptimisticSkillSwitch'
import { PluginImage } from './PluginImage'

type PluginDetailSkill = PluginCenterPluginDetail['skills'][number]
type PluginDetailApp = PluginCenterPluginDetail['apps'][number]
type PluginDetailAppGroup = { category: string; apps: PluginDetailApp[] }
type PluginDetailMcpServer =
  | PluginCenterMcpSnapshot['userServers'][number]
  | PluginCenterMcpSnapshot['pluginServers'][number]

export function PluginDetailPage({
  detail,
  directoryApps,
  mcpServers,
  pending,
  pendingAppId,
  pendingSkillId,
  onInstall,
  onToggle,
  onSkillToggle,
  onUninstall,
  onActivatePrompt,
  onConnectApp,
  onReconnectApp,
  onDisconnectApp,
  onOpenAppTools,
  onMcpToggle,
  onOpenMcpSettings,
  onOpenSkill,
  onOpenExternal
}: {
  detail: PluginCenterPluginDetail
  directoryApps: PluginCenterApp[]
  mcpServers: PluginCenterMcpSnapshot
  pending: boolean
  pendingAppId?: string
  pendingSkillId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onSkillToggle: (skill: PluginDetailSkill, enabled: boolean) => Promise<boolean>
  onUninstall: (plugin: PluginCenterPlugin) => void
  onActivatePrompt: (prompt: string) => void
  onConnectApp: (app: PluginDetailApp) => void
  onReconnectApp: (app: PluginDetailApp) => void
  onDisconnectApp: (app: PluginDetailApp) => void
  onOpenAppTools: (app: PluginDetailApp) => void
  onMcpToggle: (server: PluginDetailMcpServer, enabled: boolean) => Promise<boolean>
  onOpenMcpSettings: () => void
  onOpenSkill: (skill: PluginDetailSkill) => void
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const plugin = detail.plugin
  const title = plugin.displayName ?? plugin.name
  const description = plugin.description ?? '此插件未提供简短说明。'

  return (
    <article data-slot="plugin-detail-page" className="pb-8 [--detail-page-inline-inset:0.5rem]">
      <section className="flex flex-col gap-4 px-[var(--detail-page-inline-inset)] py-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <PluginImage
            icon={plugin.icon}
            title={title}
            fallback={<PuzzleIcon className="size-7" />}
            className="size-[60px] shrink-0 rounded-xl"
          />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-medium">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <PluginActions
          plugin={plugin}
          pending={pending}
          onInstall={onInstall}
          onToggle={onToggle}
          onUninstall={onUninstall}
        />
      </section>

      {detail.defaultPrompts.length > 0 && (
        <section className="mx-[var(--detail-page-inline-inset)] mb-8" aria-label="默认提示词">
          <div
            className="relative overflow-hidden rounded-2xl px-4 py-8 sm:px-8"
            style={detail.brandColor ? { backgroundColor: detail.brandColor } : undefined}
          >
            {detail.screenshots[0] && (
              <img
                src={detail.screenshots[0]}
                alt=""
                className="pointer-events-none absolute inset-0 size-full object-cover"
                draggable={false}
              />
            )}
            <div className="absolute inset-0 bg-background/70" />
            <PluginBrandAmbientBackground color={detail.brandColor} />
            <div className="relative z-10 mx-auto flex w-full max-w-[640px] flex-col items-center gap-4">
              {detail.defaultPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  type="button"
                  variant="secondary"
                  className="h-auto min-h-0 w-full max-w-[77%] justify-start gap-1.5 rounded-2xl bg-secondary/75 py-2 pe-1.5 ps-2 text-left text-base shadow-none hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
                  disabled={pending}
                  aria-label={`用 ${title} 执行提示词：${prompt}`}
                  onClick={() => onActivatePrompt(prompt)}
                >
                  {pending ? (
                    <Loader2Icon className="size-5 shrink-0 animate-spin" />
                  ) : (
                    <PluginImage
                      icon={plugin.icon}
                      title={title}
                      fallback={<PuzzleIcon className="size-4" />}
                      className="size-5 shrink-0 rounded-none border-0 bg-transparent object-contain"
                    />
                  )}
                  <span
                    className="shrink-0 font-medium"
                    style={detail.brandColor ? { color: detail.brandColor } : undefined}
                  >
                    {title}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{prompt}</span>
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground">
                    <ArrowRightIcon className="size-4" />
                  </span>
                </Button>
              ))}
            </div>
          </div>
        </section>
      )}

      {detail.longDescription && (
        <section className="mb-8 px-[var(--detail-page-inline-inset)]">
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/90">
            {detail.longDescription}
          </p>
        </section>
      )}

      <Includes
        detail={detail}
        directoryApps={directoryApps}
        mcpServers={mcpServers}
        pendingAppId={pendingAppId}
        pendingSkillId={pendingSkillId}
        onConnectApp={onConnectApp}
        onReconnectApp={onReconnectApp}
        onDisconnectApp={onDisconnectApp}
        onOpenAppTools={onOpenAppTools}
        onMcpToggle={onMcpToggle}
        onOpenMcpSettings={onOpenMcpSettings}
        onOpenSkill={onOpenSkill}
        onSkillToggle={onSkillToggle}
      />
      <Information detail={detail} onOpenExternal={onOpenExternal} />
      {detail.apps.length > 0 && (
        <section className="mt-8 border-t px-[var(--detail-page-inline-inset)] pt-6 text-sm leading-6 text-muted-foreground">
          插件或其包含的应用可能会获得完成请求所需的上下文。数据使用方式受开发者提供的
          隐私政策和服务条款约束。
        </section>
      )}
    </article>
  )
}

function PluginBrandAmbientBackground({ color }: { color?: string }): React.JSX.Element | null {
  if (!color) return null

  const colors = [
    color,
    `color-mix(in oklch, ${color} 72%, var(--background))`,
    `color-mix(in oklch, ${color} 58%, var(--foreground))`
  ]

  return (
    <div
      data-slot="plugin-brand-ambient-background"
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-40"
      aria-hidden="true"
    >
      <span
        className="absolute -top-[42%] -left-[18%] size-[78%] rounded-full blur-3xl animate-plugin-brand-drift-one motion-reduce:animate-none"
        style={{ backgroundColor: colors[0] }}
      />
      <span
        className="absolute -right-[20%] -bottom-[62%] size-[86%] rounded-full blur-3xl animate-plugin-brand-drift-two motion-reduce:animate-none"
        style={{ backgroundColor: colors[1] }}
      />
      <span
        className="absolute left-[22%] -bottom-[74%] size-[82%] rounded-full blur-3xl animate-plugin-brand-drift-three motion-reduce:animate-none"
        style={{ backgroundColor: colors[2] }}
      />
    </div>
  )
}

function PluginActions({
  plugin,
  pending,
  onInstall,
  onToggle,
  onUninstall
}: {
  plugin: PluginCenterPlugin
  pending: boolean
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
}): React.JSX.Element {
  if (!plugin.installed) {
    return (
      <Button
        type="button"
        className="shrink-0"
        disabled={pending || !plugin.canInstall}
        title={plugin.restriction?.message}
        onClick={() => onInstall(plugin)}
      >
        {pending && <Loader2Icon className="size-4 animate-spin" />}
        安装插件
      </Button>
    )
  }
  return (
    <div className="flex flex-wrap gap-2 sm:justify-end">
      <Button
        type="button"
        variant="outline"
        disabled={pending || !plugin.canToggle}
        title={plugin.restriction?.message}
        onClick={() => onToggle(plugin, !plugin.enabled)}
      >
        {pending && <Loader2Icon className="size-4 animate-spin" />}
        {plugin.enabled ? '停用' : '启用'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        disabled={pending || !plugin.canUninstall}
        onClick={() => onUninstall(plugin)}
      >
        卸载
      </Button>
    </div>
  )
}

function Includes({
  detail,
  directoryApps,
  mcpServers: mcpSnapshot,
  pendingAppId,
  pendingSkillId,
  onConnectApp,
  onReconnectApp,
  onDisconnectApp,
  onOpenAppTools,
  onMcpToggle,
  onOpenMcpSettings,
  onOpenSkill,
  onSkillToggle
}: {
  detail: PluginCenterPluginDetail
  directoryApps: PluginCenterApp[]
  mcpServers: PluginCenterMcpSnapshot
  pendingAppId?: string
  pendingSkillId?: string
  onConnectApp: (app: PluginDetailApp) => void
  onReconnectApp: (app: PluginDetailApp) => void
  onDisconnectApp: (app: PluginDetailApp) => void
  onOpenAppTools: (app: PluginDetailApp) => void
  onMcpToggle: (server: PluginDetailMcpServer, enabled: boolean) => Promise<boolean>
  onOpenMcpSettings: () => void
  onOpenSkill: (skill: PluginDetailSkill) => void
  onSkillToggle: (skill: PluginDetailSkill, enabled: boolean) => Promise<boolean>
}): React.JSX.Element | null {
  if (detail.apps.length === 0 && detail.skills.length === 0 && detail.mcpServers.length === 0) {
    return null
  }
  const appGroups = groupAppsByCategory(detail.apps)
  const hasMultipleAppCategories = appGroups.length > 1
  const mcpServers = resolvePluginMcpServers(directoryApps, detail, detail.mcpServers, mcpSnapshot)
  return (
    <section className="space-y-5">
      {detail.apps.length > 0 && (
        <IncludedSection title={`应用 ${detail.apps.length}`}>
          <div className="flex flex-col gap-3">
            {appGroups.map((group, index) => (
              <div
                key={group.category}
                className={cn(
                  'flex flex-col gap-2',
                  hasMultipleAppCategories && index > 0 && 'pt-2'
                )}
              >
                {hasMultipleAppCategories && (
                  <div
                    data-slot="plugin-detail-app-category"
                    className="px-[var(--detail-page-inline-inset)] text-sm text-muted-foreground"
                  >
                    {group.category}
                  </div>
                )}
                <ExpandableIncludedList
                  items={group.apps}
                  getItemKey={(app) => app.id}
                  getItemPreview={(app) => app.name}
                  renderItem={(app) => (
                    <PluginDetailAppRow
                      app={app}
                      plugin={detail.plugin}
                      pending={pendingAppId === app.id}
                      onConnect={onConnectApp}
                      onDisconnect={onDisconnectApp}
                      onOpen={onOpenAppTools}
                      onReconnect={onReconnectApp}
                    />
                  )}
                />
              </div>
            ))}
          </div>
        </IncludedSection>
      )}
      {detail.mcpServers.length > 0 && (
        <IncludedSection title={`MCP 服务器 ${detail.mcpServers.length}`}>
          <ExpandableIncludedList
            items={mcpServers}
            getItemKey={(server) => (server.kind === 'app' ? server.app.id : server.name)}
            getItemPreview={(server) => (server.kind === 'app' ? server.app.name : server.name)}
            renderItem={(server) => {
              if (server.kind === 'app') {
                return (
                  <PluginDetailAppRow
                    app={server.app}
                    plugin={detail.plugin}
                    pending={pendingAppId === server.app.id}
                    onConnect={onConnectApp}
                    onDisconnect={onDisconnectApp}
                    onOpen={onOpenAppTools}
                    onReconnect={onReconnectApp}
                  />
                )
              }
              return (
                <PluginMcpServerRow
                  server={server.server}
                  name={server.name}
                  pending={pendingAppId === server.server?.id}
                  onToggle={onMcpToggle}
                  onOpenSettings={onOpenMcpSettings}
                />
              )
            }}
          />
        </IncludedSection>
      )}
      {detail.skills.length > 0 && (
        <IncludedSection title={`技能 ${detail.skills.length}`}>
          <ExpandableIncludedList
            items={detail.skills}
            getItemKey={(skill) => skill.id}
            getItemPreview={(skill) => skill.displayName ?? skill.name}
            renderItem={(skill) => (
              <PreviewableCapabilityRow
                dataSlot="plugin-detail-skill-row"
                ariaLabel={`查看技能 ${skill.displayName ?? skill.name}`}
                onOpen={() => onOpenSkill(skill)}
                icon={
                  <PluginImage
                    icon={skill.icon}
                    title={skill.displayName ?? skill.name}
                    fallback={<SkillCubeIcon />}
                    className="size-8 shrink-0 rounded-none border-0 bg-transparent object-contain"
                  />
                }
                title={skill.displayName ?? skill.name}
                description={skill.description}
                actions={
                  <div onClick={stopCapabilityPreview} onKeyDown={stopCapabilityPreview}>
                    <OptimisticSkillSwitch
                      enabled={skill.enabled}
                      disabled={pendingSkillId === skill.id || !skill.canToggle}
                      getAriaLabel={(enabled) =>
                        `${skill.displayName ?? skill.name} ${enabled ? '停用' : '启用'}`
                      }
                      title={skill.canToggle ? undefined : '请先安装并启用所属插件'}
                      onToggle={(enabled) => onSkillToggle(skill, enabled)}
                    />
                  </div>
                }
              />
            )}
          />
        </IncludedSection>
      )}
    </section>
  )
}

function groupAppsByCategory(apps: PluginDetailApp[]): PluginDetailAppGroup[] {
  const groups = new Map<string, PluginDetailApp[]>()
  for (const app of apps) {
    const category = app.category?.trim() || '其他'
    const group = groups.get(category)
    if (group) {
      group.push(app)
    } else {
      groups.set(category, [app])
    }
  }
  return Array.from(groups, ([category, groupedApps]) => ({ category, apps: groupedApps }))
}

type ResolvedPluginMcpServer =
  | { kind: 'app'; app: PluginDetailApp }
  | { kind: 'config'; name: string; server?: PluginDetailMcpServer }

function resolvePluginMcpServers(
  apps: PluginCenterApp[],
  detail: PluginCenterPluginDetail,
  pluginServerNames: string[],
  mcpSnapshot: PluginCenterMcpSnapshot
): ResolvedPluginMcpServer[] {
  const configuredServers = [...mcpSnapshot.userServers, ...mcpSnapshot.pluginServers]
  return pluginServerNames.map((name) => {
    const app =
      findMatchingApp(detail.apps, name) ?? directoryAppAsDetailApp(findMatchingApp(apps, name))
    const server = findMatchingMcpServer(configuredServers, name)
    return app ? { kind: 'app', app } : { kind: 'config', name, ...(server ? { server } : {}) }
  })
}

function findMatchingApp<T extends { id: string; name: string }>(
  apps: T[],
  serverName: string
): T | null {
  const normalizedServerName = normalizeMcpIdentity(serverName)
  return (
    apps.find((app) => appAliases(app).some((candidate) => candidate === normalizedServerName)) ??
    null
  )
}

function appAliases(app: { id: string; name: string }): string[] {
  const aliases = [app.id, app.name]
  if ('pluginDisplayNames' in app && Array.isArray(app.pluginDisplayNames)) {
    aliases.push(...app.pluginDisplayNames)
  }
  if ('labels' in app && app.labels && typeof app.labels === 'object') {
    aliases.push(...Object.keys(app.labels), ...Object.values(app.labels))
  }
  return aliases.map(normalizeMcpIdentity)
}

function findMatchingMcpServer(
  servers: PluginDetailMcpServer[],
  serverName: string
): PluginDetailMcpServer | null {
  const normalizedServerName = normalizeMcpIdentity(serverName)
  return (
    servers.find(
      (server) =>
        normalizeMcpIdentity(server.id) === normalizedServerName ||
        normalizeMcpIdentity(server.name) === normalizedServerName
    ) ?? null
  )
}

function directoryAppAsDetailApp(app: PluginCenterApp | null): PluginDetailApp | null {
  if (!app) return null
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

function normalizeMcpIdentity(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^connector[_-]/, '')
    .replace(/^mcp[_-]/, '')
    .replace(/[\s_-]+/g, '')
}

function PluginDetailAppRow({
  app,
  plugin,
  pending,
  onConnect,
  onDisconnect,
  onOpen,
  onReconnect
}: {
  app: PluginDetailApp
  plugin: PluginCenterPlugin
  pending: boolean
  onConnect: (app: PluginDetailApp) => void
  onDisconnect: (app: PluginDetailApp) => void
  onOpen: (app: PluginDetailApp) => void
  onReconnect: (app: PluginDetailApp) => void
}): React.JSX.Element {
  const blocked = app.restriction?.editable === false
  const hasConnectedMenu = plugin.installed && app.accessible && app.enabled

  return (
    <div
      data-slot="plugin-detail-app-row"
      role="button"
      tabIndex={0}
      aria-label={`查看应用 ${app.name}`}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpen(app)}
      onKeyDown={(event) => handleCapabilityRowKeyDown(event, () => onOpen(app))}
    >
      <div data-slot="plugin-detail-app-open" className="flex min-w-0 flex-1 items-center gap-3">
        <PluginImage
          icon={app.icon ?? plugin.icon}
          title={app.name}
          fallback={<AppWindowIcon className="size-4" />}
          className="size-9 shrink-0 rounded-lg border bg-transparent object-contain"
        />
        <span className="min-w-0 flex-1">
          <span data-slot="plugin-detail-app-name" className="block truncate text-base font-medium">
            {app.name}
          </span>
          <span
            data-slot="plugin-detail-app-description"
            className="block line-clamp-1 text-sm leading-relaxed text-muted-foreground"
          >
            {app.description ?? '此应用未提供简短说明。'}
          </span>
        </span>
      </div>
      <div className="shrink-0" onClick={stopCapabilityPreview} onKeyDown={stopCapabilityPreview}>
        {!plugin.installed && null}
        {plugin.installed && !app.accessible && blocked && (
          <span
            className="flex size-8 items-center justify-center text-muted-foreground"
            title={app.restriction?.message}
            aria-label={app.restriction?.message ?? '此应用已锁定'}
          >
            <LockKeyholeIcon className="size-4" />
          </span>
        )}
        {hasConnectedMenu && (
          <ConnectedAppMenu
            app={app}
            pending={pending}
            onDisconnect={onDisconnect}
            onReconnect={onReconnect}
          />
        )}
        {plugin.installed && !hasConnectedMenu && !(blocked && !app.accessible) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-lg px-4"
            disabled={pending || blocked || (!app.accessible && !app.installUrl)}
            aria-label={`连接 ${app.name}`}
            title={app.restriction?.message}
            onClick={() => onConnect(app)}
          >
            {pending && <Loader2Icon className="size-3.5 animate-spin" />}
            连接
          </Button>
        )}
      </div>
    </div>
  )
}

function PluginMcpServerRow({
  name,
  server,
  pending,
  onToggle,
  onOpenSettings
}: {
  name: string
  server?: PluginDetailMcpServer
  pending: boolean
  onToggle: (server: PluginDetailMcpServer, enabled: boolean) => Promise<boolean>
  onOpenSettings: () => void
}): React.JSX.Element {
  const serverName = server?.displayName ?? server?.name ?? name
  const connected = server?.connected === true
  const details = server
    ? `${connected ? '已连接' : '未连接'}${server.toolCount > 0 ? ` · ${server.toolCount} 个工具` : ''}`
    : '尚未设置'
  const canToggle = server?.canToggle === true

  return (
    <div
      data-slot="plugin-detail-mcp-server"
      className="flex min-w-0 items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 text-base transition-colors hover:bg-foreground/5"
    >
      <ServerIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{serverName}</div>
        <div className="truncate text-sm text-muted-foreground">{details}</div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`${server ? '打开' : '设置'} ${serverName} MCP`}
        title={server ? '打开设置' : '设置 MCP'}
        onClick={onOpenSettings}
      >
        <SettingsIcon className="size-4" />
      </Button>
      {server && (
        <OptimisticMcpSwitch server={server} disabled={pending || !canToggle} onToggle={onToggle} />
      )}
    </div>
  )
}

function OptimisticMcpSwitch({
  server,
  disabled,
  onToggle
}: {
  server: PluginDetailMcpServer
  disabled: boolean
  onToggle: (server: PluginDetailMcpServer, enabled: boolean) => Promise<boolean>
}): React.JSX.Element {
  const disabledReason = server.restriction?.message ?? '此 MCP 服务器不可修改'

  return (
    <div onClick={stopCapabilityPreview} onKeyDown={stopCapabilityPreview}>
      <CapabilityTooltip enabled={disabled} message={disabledReason}>
        <OptimisticSkillSwitch
          enabled={server.enabled}
          disabled={disabled}
          getAriaLabel={(enabled) =>
            `${server.displayName ?? server.name} ${enabled ? '停用' : '启用'}`
          }
          onToggle={(enabled) => onToggle(server, enabled)}
        />
      </CapabilityTooltip>
    </div>
  )
}

function CapabilityTooltip({
  enabled,
  message,
  children
}: {
  enabled: boolean
  message: string
  children: React.ReactElement
}): React.JSX.Element {
  if (!enabled) return children
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{children}</span>
        </TooltipTrigger>
        <TooltipContent>{message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function ExpandableIncludedList<T>({
  items,
  getItemKey,
  getItemPreview,
  renderItem
}: {
  items: T[]
  getItemKey: (item: T) => string
  getItemPreview: (item: T) => string
  renderItem: (item: T) => React.ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false)
  const visibleItems = expanded ? items : items.slice(0, 5)
  const hiddenItems = items.slice(5)

  return (
    <div className="flex flex-col gap-1">
      {visibleItems.map((item) => (
        <React.Fragment key={getItemKey(item)}>{renderItem(item)}</React.Fragment>
      ))}
      {hiddenItems.length > 0 && (
        <button
          type="button"
          className="flex min-h-10 items-center gap-2 rounded-lg px-[var(--detail-page-inline-inset)] text-left text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <ChevronDownIcon
            className={cn('size-4 transition-transform', expanded && 'rotate-180')}
          />
          <span>{expanded ? '收起' : `查看更多 ${hiddenItems.length} 项`}</span>
          {!expanded && (
            <span className="min-w-0 truncate text-xs">
              {hiddenItems.slice(0, 3).map(getItemPreview).join('、')}
            </span>
          )}
        </button>
      )}
    </div>
  )
}

function PreviewableCapabilityRow({
  dataSlot,
  ariaLabel,
  icon,
  title,
  description,
  actions,
  onOpen
}: {
  dataSlot: string
  ariaLabel: string
  icon: React.ReactNode
  title: string
  description?: string
  actions?: React.ReactNode
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div
      data-slot={dataSlot}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
      onKeyDown={(event) => handleCapabilityRowKeyDown(event, onOpen)}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium">{title}</div>
        {description && (
          <p className="line-clamp-1 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions}
    </div>
  )
}

function handleCapabilityRowKeyDown(
  event: React.KeyboardEvent<HTMLElement>,
  onOpen: () => void
): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  onOpen()
}

function stopCapabilityPreview(event: React.SyntheticEvent): void {
  event.stopPropagation()
}

function ConnectedAppMenu({
  app,
  pending,
  onDisconnect,
  onReconnect
}: {
  app: PluginDetailApp
  pending: boolean
  onDisconnect: (app: PluginDetailApp) => void
  onReconnect: (app: PluginDetailApp) => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-lg px-3"
          disabled={pending}
          aria-label={`${app.name} 已连接，打开管理菜单`}
        >
          {pending ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <span className="size-2 rounded-full bg-emerald-500" />
          )}
          已连接
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!app.installUrl} onSelect={() => onReconnect(app)}>
          重新连接
        </DropdownMenuItem>
        {app.multiAccountCapability === 'supported' && (
          <DropdownMenuItem disabled={!app.settingsUrl} onSelect={() => onDisconnect(app)}>
            添加账户
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!app.settingsUrl}
          className="text-destructive focus:text-destructive"
          onSelect={() => onDisconnect(app)}
        >
          断开连接
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SkillCubeIcon(): React.JSX.Element {
  return (
    <svg
      data-slot="plugin-detail-skill-icon"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-6"
    >
      <path
        fill="#F7D57C"
        d="M10.56 11.133v11.939h-.035a2.318 2.318 0 0 1-1.288-.412l-4.175-2.85a2.555 2.555 0 0 1-.787-.876A2.392 2.392 0 0 1 4 17.81V7.96c0-.374.08-.725.242-1.052l6.318 4.226Z"
      />
      <path
        fill="#FF8082"
        d="M19.725 5.447A2.2 2.2 0 0 1 20 6.522v9.862c0 .409-.104.796-.313 1.163-.2.366-.48.658-.837.875l-7 4.3c-.399.243-.828.36-1.29.35V11.121l9.144-5.711.02.037Z"
      />
      <path
        fill="#9279D8"
        d="M20 16.384c0 .409-.104.796-.313 1.163-.2.366-.48.658-.837.875l-7 4.3c-.399.243-.828.36-1.29.35v-5.75l9.144-5.71c.01.01.296-.175.296-.175v4.947Z"
      />
      <path
        fill="#C1ACFF"
        d="M10.56 17.335v5.737h-.035a2.318 2.318 0 0 1-1.288-.412l-4.175-2.85a2.555 2.555 0 0 1-.787-.876A2.392 2.392 0 0 1 4 17.81v-4.84l6.56 4.366Z"
      />
      <path
        fill="#FBC484"
        d="M4.242 6.907a2.285 2.285 0 0 1 .896-.985L12.1 1.646c.4-.25.834-.37 1.3-.362.467 0 .896.132 1.287.399l4.288 2.925c.312.216.554.484.728.8l-9.143 5.712v.012L4.242 6.907Z"
      />
    </svg>
  )
}

function IncludedSection({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <DetailSectionHeading>{title}</DetailSectionHeading>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function DetailSectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center justify-between border-b pb-2 pe-0.5 ps-[var(--detail-page-inline-inset)]">
      <h2 className="text-lg font-medium">{children}</h2>
    </div>
  )
}

function Information({
  detail,
  onOpenExternal
}: {
  detail: PluginCenterPluginDetail
  onOpenExternal: (url: string) => void
}): React.JSX.Element {
  const rows = [
    detail.capabilities.length > 0
      ? { label: '功能', value: detail.capabilities.join('、') }
      : null,
    detail.plugin.author ? { label: '开发者', value: detail.plugin.author } : null,
    detail.plugin.categories[0] ? { label: '类别', value: detail.plugin.categories[0] } : null,
    detail.plugin.versionLabel ? { label: '版本', value: detail.plugin.versionLabel } : null
  ].filter((row): row is { label: string; value: string } => row !== null)

  return (
    <section className={cn('mt-8', rows.length === 0 && 'mt-6')}>
      <DetailSectionHeading>信息</DetailSectionHeading>
      <dl className="space-y-3 px-[var(--detail-page-inline-inset)] text-sm">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
          <dt className="text-muted-foreground">网站</dt>
          <dd>
            {detail.websiteUrl ? (
              <ExternalButton
                url={detail.websiteUrl}
                label="打开网站"
                iconOnly
                onOpen={onOpenExternal}
              />
            ) : (
              '不可用'
            )}
          </dd>
        </div>
        {detail.privacyPolicyUrl && (
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">隐私政策</dt>
            <dd>
              <ExternalButton
                url={detail.privacyPolicyUrl}
                label="打开隐私政策"
                iconOnly
                onOpen={onOpenExternal}
              />
            </dd>
          </div>
        )}
        {detail.termsOfServiceUrl && (
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt className="text-muted-foreground">服务条款</dt>
            <dd>
              <ExternalButton
                url={detail.termsOfServiceUrl}
                label="打开服务条款"
                iconOnly
                onOpen={onOpenExternal}
              />
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}

function ExternalButton({
  url,
  label,
  iconOnly = false,
  onOpen
}: {
  url: string
  label: string
  iconOnly?: boolean
  onOpen: (url: string) => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={iconOnly ? 'ghost' : 'link'}
      size={iconOnly ? 'icon-xs' : 'sm'}
      className={iconOnly ? undefined : 'h-auto px-0 text-sm'}
      aria-label={label}
      title={iconOnly ? label : undefined}
      onClick={() => onOpen(url)}
    >
      {!iconOnly && label}
      <ExternalLinkIcon className="size-3.5" />
    </Button>
  )
}
