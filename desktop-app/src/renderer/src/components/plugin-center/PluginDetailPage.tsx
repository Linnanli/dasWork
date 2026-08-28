import * as React from 'react'
import {
  AppWindowIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LockKeyholeIcon,
  Loader2Icon,
  PuzzleIcon,
  ServerIcon
} from 'lucide-react'

import type {
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
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { PluginImage } from './PluginImage'

type PluginDetailSkill = PluginCenterPluginDetail['skills'][number]
type PluginDetailApp = PluginCenterPluginDetail['apps'][number]

export function PluginDetailPage({
  detail,
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
  onOpenExternal
}: {
  detail: PluginCenterPluginDetail
  pending: boolean
  pendingAppId?: string
  pendingSkillId?: string
  onInstall: (plugin: PluginCenterPlugin) => void
  onToggle: (plugin: PluginCenterPlugin, enabled: boolean) => void
  onSkillToggle: (skill: PluginDetailSkill, enabled: boolean) => void
  onUninstall: (plugin: PluginCenterPlugin) => void
  onActivatePrompt: (prompt: string) => void
  onConnectApp: (app: PluginDetailApp) => void
  onReconnectApp: (app: PluginDetailApp) => void
  onDisconnectApp: (app: PluginDetailApp) => void
  onOpenAppTools: (app: PluginDetailApp) => void
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
        pendingAppId={pendingAppId}
        pendingSkillId={pendingSkillId}
        onConnectApp={onConnectApp}
        onReconnectApp={onReconnectApp}
        onDisconnectApp={onDisconnectApp}
        onOpenAppTools={onOpenAppTools}
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
  pendingAppId,
  pendingSkillId,
  onConnectApp,
  onReconnectApp,
  onDisconnectApp,
  onOpenAppTools,
  onSkillToggle
}: {
  detail: PluginCenterPluginDetail
  pendingAppId?: string
  pendingSkillId?: string
  onConnectApp: (app: PluginDetailApp) => void
  onReconnectApp: (app: PluginDetailApp) => void
  onDisconnectApp: (app: PluginDetailApp) => void
  onOpenAppTools: (app: PluginDetailApp) => void
  onSkillToggle: (skill: PluginDetailSkill, enabled: boolean) => void
}): React.JSX.Element | null {
  if (detail.apps.length === 0 && detail.skills.length === 0 && detail.mcpServers.length === 0) {
    return null
  }
  return (
    <section className="space-y-5">
      {detail.apps.length > 0 && (
        <IncludedSection title={`应用 ${detail.apps.length}`}>
          {detail.apps.map((app) => (
            <PluginDetailAppRow
              key={app.id}
              app={app}
              plugin={detail.plugin}
              pending={pendingAppId === app.id}
              onConnect={onConnectApp}
              onDisconnect={onDisconnectApp}
              onOpen={onOpenAppTools}
              onReconnect={onReconnectApp}
            />
          ))}
        </IncludedSection>
      )}
      {detail.skills.length > 0 && (
        <IncludedSection title={`技能 ${detail.skills.length}`}>
          {detail.skills.map((skill) => (
            <div
              key={skill.id}
              data-slot="plugin-detail-skill"
              className="group flex min-w-0 items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 transition-colors hover:bg-foreground/5"
            >
              <PluginImage
                icon={skill.icon}
                title={skill.displayName ?? skill.name}
                fallback={<SkillCubeIcon />}
                className="size-8 shrink-0 rounded-none border-0 bg-transparent object-contain"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium">
                  {skill.displayName ?? skill.name}
                </div>
                {skill.description && (
                  <p className="line-clamp-1 text-sm leading-relaxed text-muted-foreground">
                    {skill.description}
                  </p>
                )}
              </div>
              <Switch
                checked={skill.enabled}
                disabled={pendingSkillId === skill.id || !skill.canToggle}
                aria-label={`${skill.displayName ?? skill.name} ${skill.enabled ? '停用' : '启用'}`}
                title={skill.canToggle ? undefined : '请先安装并启用所属插件'}
                onCheckedChange={(enabled) => onSkillToggle(skill, enabled)}
              />
            </div>
          ))}
        </IncludedSection>
      )}
      {detail.mcpServers.length > 0 && (
        <IncludedSection title={`MCP 服务器 ${detail.mcpServers.length}`}>
          {detail.mcpServers.map((name) => (
            <div
              key={name}
              data-slot="plugin-detail-mcp-server"
              className="flex min-w-0 items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 text-base transition-colors hover:bg-foreground/5"
            >
              <ServerIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{name}</span>
            </div>
          ))}
        </IncludedSection>
      )}
    </section>
  )
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
      data-slot="plugin-detail-app"
      className="group flex min-w-0 items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 text-left transition-colors hover:bg-foreground/5"
    >
      <button
        data-slot="plugin-detail-app-open"
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 bg-transparent text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpen(app)}
      >
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
      </button>
      <div className="shrink-0">
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
