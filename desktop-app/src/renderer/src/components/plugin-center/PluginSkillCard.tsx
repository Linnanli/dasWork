import * as React from 'react'

import type { PluginCenterIcon } from '../../../../shared/pluginCenterApi'
import { OptimisticSkillSwitch } from './OptimisticSkillSwitch'
import { PluginDetailSkillIcon } from './PluginDetailSkillIcon'
import { PluginImage } from './PluginImage'

type PluginSkillCardProps = {
  dataSlot: string
  ariaLabel: string
  icon?: PluginCenterIcon
  title: string
  description?: string
  enabled: boolean
  canToggle: boolean
  pending: boolean
  disabledMessage?: string
  onOpen: () => void
  onToggle: (enabled: boolean) => Promise<boolean>
}

/**
 * The shared skill row used wherever an installed skill can be previewed and toggled.
 * Keeping the complete row here prevents the management view and plugin details from
 * drifting in their keyboard behavior, switch handling, and visual treatment.
 */
export function PluginSkillCard({
  dataSlot,
  ariaLabel,
  icon,
  title,
  description,
  enabled,
  canToggle,
  pending,
  disabledMessage = '请先安装并启用所属插件',
  onOpen,
  onToggle
}: PluginSkillCardProps): React.JSX.Element {
  return (
    <div
      data-slot={dataSlot}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg px-[var(--detail-page-inline-inset)] py-3 transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onOpen}
      onKeyDown={(event) => handleSkillCardKeyDown(event, onOpen)}
    >
      <PluginImage
        icon={icon}
        title={title}
        fallback={<PluginDetailSkillIcon />}
        className="size-8 shrink-0 rounded-none border-0 bg-transparent object-contain"
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-medium">{title}</div>
        {description && (
          <p className="line-clamp-1 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0" onClick={stopSkillCardOpen} onKeyDown={stopSkillCardOpen}>
        <OptimisticSkillSwitch
          enabled={enabled}
          disabled={pending || !canToggle}
          getAriaLabel={(nextEnabled) => `${title} ${nextEnabled ? '停用' : '启用'}`}
          title={canToggle ? undefined : disabledMessage}
          onToggle={onToggle}
        />
      </div>
    </div>
  )
}

function handleSkillCardKeyDown(event: React.KeyboardEvent<HTMLElement>, onOpen: () => void): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  onOpen()
}

function stopSkillCardOpen(event: React.SyntheticEvent): void {
  event.stopPropagation()
}
