// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginCenterPluginDetail } from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import type { PluginCenterResourceSnapshot } from './pluginCenterDataResource'
import {
  PluginSkillPreviewDialog,
  type PluginSkillPreviewContentsResult
} from './PluginSkillPreviewDialog'
import { cleanSkillMarkdown } from './pluginSkillPreviewMarkdown'

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-slot="streamdown">{children}</div>
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const skill: PluginCenterPluginDetail['skills'][number] = {
  id: 'skill:writer',
  name: 'writer',
  displayName: 'Writer',
  description: 'Draft focused text.',
  enabled: true,
  canToggle: true
}
const pluginRef = { id: 'plugin:writer', marketplaceId: 'marketplace:personal' }
const skillRef = { id: skill.id, name: skill.name }

function resourceState(
  status: PluginCenterResourceSnapshot<PluginSkillPreviewContentsResult>['status'],
  data: PluginSkillPreviewContentsResult | null = null,
  error: string | null = null
): PluginCenterResourceSnapshot<PluginSkillPreviewContentsResult> {
  return { status, data, error, isRefreshing: false, updatedAt: 0 }
}

async function renderDialog(
  state: PluginCenterResourceSnapshot<PluginSkillPreviewContentsResult>,
  skillOverride: PluginCenterPluginDetail['skills'][number] = skill
): Promise<{
  onRetry: ReturnType<typeof vi.fn>
  onTrySkill: ReturnType<typeof vi.fn>
  onOpenLocalPath: ReturnType<typeof vi.fn>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const onRetry = vi.fn()
  const onTrySkill = vi.fn()
  const onOpenLocalPath = vi.fn()

  await act(async () => {
    root.render(
      <PluginSkillPreviewDialog
        skill={skillOverride}
        open
        state={state}
        pending={false}
        onOpenChange={() => undefined}
        onToggle={() => undefined}
        onTrySkill={onTrySkill}
        onOpenLocalPath={onOpenLocalPath}
        onRetry={onRetry}
      />
    )
    await Promise.resolve()
  })

  return { onRetry, onTrySkill, onOpenLocalPath }
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text)
  )
}

function menuItemWithText(text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes(text)
  )
}

describe('PluginSkillPreviewDialog', () => {
  it('cleans frontmatter and a repeated first heading before rendering', async () => {
    await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        plugin: pluginRef,
        skill: skillRef,
        contents: '---\ntitle: Writer\n---\n# Writer\n\nUse short sentences.',
        localPath: '/tmp/SKILL.md'
      })
    )

    const markdown = document.body.querySelector('[data-slot="streamdown"]')?.textContent
    expect(document.body.querySelector('[data-slot="plugin-skill-preview-dialog"]')).not.toBeNull()
    expect(markdown).toBe('Use short sentences.')
  })

  it('keeps the raw markdown available for copy', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        plugin: pluginRef,
        skill: skillRef,
        contents: '---\ntitle: Writer\n---\n# Writer\n\nUse short sentences.',
        localPath: '/tmp/SKILL.md'
      })
    )

    await act(async () => {
      openDropdownMenu('打开技能操作菜单')
      await Promise.resolve()
    })
    await act(async () => {
      menuItemWithText('复制 Markdown')?.click()
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith(
      '---\ntitle: Writer\n---\n# Writer\n\nUse short sentences.'
    )
  })

  it('fires Try now and opens the trusted local skill file path', async () => {
    const { onTrySkill, onOpenLocalPath } = await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        plugin: pluginRef,
        skill: skillRef,
        contents: '# Writer\n\nUse short sentences.',
        localPath: '/tmp/SKILL.md'
      })
    )

    await act(async () => {
      buttonWithText('立即试用')?.click()
    })
    await act(async () => {
      openDropdownMenu('打开技能操作菜单')
      await Promise.resolve()
    })
    await act(async () => {
      menuItemWithText('打开本地文件')?.click()
      await Promise.resolve()
    })

    expect(onTrySkill).toHaveBeenCalledOnce()
    expect(onOpenLocalPath).toHaveBeenCalledWith('/tmp/SKILL.md')
  })

  it('offers retry after a read error and shows Close when no local skill path is trusted', async () => {
    const { onRetry } = await renderDialog(resourceState('error', null, 'skill/read 暂时失败'), {
      ...skill,
      enabled: false
    })

    const retry = buttonWithText('重试')
    const close = buttonWithText('关闭')
    expect(
      document.body.querySelector('[data-slot="plugin-skill-preview-error"]')?.textContent
    ).toContain('skill/read 暂时失败')
    expect(close).not.toBeUndefined()

    await act(async () => {
      retry?.click()
    })

    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('requires an enabled skill before trying a trusted local skill file', async () => {
    const { onTrySkill } = await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        plugin: pluginRef,
        skill: skillRef,
        contents: '# Writer',
        localPath: '/tmp/SKILL.md'
      }),
      { ...skill, enabled: false }
    )

    const trySkill = buttonWithText('立即试用')
    expect(trySkill?.disabled).toBe(true)

    await act(async () => {
      trySkill?.click()
    })

    expect(onTrySkill).not.toHaveBeenCalled()
  })

  it('renders loading and missing states', async () => {
    await renderDialog(resourceState('loading'))
    expect(document.body.querySelector('[data-slot="plugin-skill-preview-loading"]')).not.toBeNull()

    roots.splice(0).forEach((root) => root.unmount())
    document.body.replaceChildren()
    await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'missing',
        plugin: pluginRef,
        skill: skillRef,
        missingReason: 'not_found'
      })
    )
    expect(
      document.body.querySelector('[data-slot="plugin-skill-preview-empty"]')?.textContent
    ).toContain('暂时无法读取说明')
  })
})

function openDropdownMenu(ariaLabel: string): void {
  const trigger = document.body.querySelector<HTMLButtonElement>(
    `button[aria-label="${ariaLabel}"]`
  )
  trigger?.dispatchEvent(
    new MouseEvent('pointerdown', {
      bubbles: true,
      button: 0,
      ctrlKey: false
    })
  )
}

describe('cleanSkillMarkdown', () => {
  it('preserves a distinct first heading', () => {
    expect(cleanSkillMarkdown('# Different\n\nBody', 'Writer')).toBe('# Different\n\nBody')
  })
})
