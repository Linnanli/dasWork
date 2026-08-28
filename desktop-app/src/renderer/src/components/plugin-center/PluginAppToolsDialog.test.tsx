// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  PluginCenterGetAppToolsResult,
  PluginCenterPluginDetail
} from '../../../../shared/pluginCenterApi'
import { PLUGIN_CENTER_API_VERSION } from '../../../../shared/pluginCenterApi'
import type { PluginCenterResourceSnapshot } from './pluginCenterDataResource'
import { PluginAppToolsDialog } from './PluginAppToolsDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const app: PluginCenterPluginDetail['apps'][number] = {
  id: 'github-app',
  name: 'GitHub App',
  description: 'Open GitHub in the browser.',
  mention: { path: 'app://github-app', name: 'GitHub App' },
  multiAccountCapability: 'unknown',
  enabled: true,
  accessible: true,
  canToggle: true
}

function resourceState(
  status: PluginCenterResourceSnapshot<PluginCenterGetAppToolsResult>['status'],
  data: PluginCenterGetAppToolsResult | null = null,
  error: string | null = null
): PluginCenterResourceSnapshot<PluginCenterGetAppToolsResult> {
  return { status, data, error, isRefreshing: false, updatedAt: 0 }
}

async function renderDialog(
  state: PluginCenterResourceSnapshot<PluginCenterGetAppToolsResult>,
  appOverride: PluginCenterPluginDetail['apps'][number] = app
): Promise<{ onRetry: ReturnType<typeof vi.fn>; onTryApp: ReturnType<typeof vi.fn> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  const onRetry = vi.fn()
  const onTryApp = vi.fn()

  await act(async () => {
    root.render(
      <PluginAppToolsDialog
        app={appOverride}
        open
        state={state}
        pending={false}
        onOpenChange={() => undefined}
        onToggle={() => undefined}
        onTryApp={onTryApp}
        onRetry={onRetry}
      />
    )
    await Promise.resolve()
  })

  return { onRetry, onTryApp }
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text)
  )
}

describe('PluginAppToolsDialog', () => {
  it('renders a stable loading state before the tool request completes', async () => {
    await renderDialog(resourceState('loading'))

    expect(document.body.querySelector('[data-slot="plugin-app-tools-loading"]')).not.toBeNull()
    expect(buttonWithText('立即试用')?.disabled).toBe(false)
  })

  it('renders missing and empty tool states without exposing raw metadata', async () => {
    await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'missing',
        app: { id: app.id },
        missingReason: 'not_found'
      })
    )

    expect(
      document.body.querySelector('[data-slot="plugin-app-tools-empty"]')?.textContent
    ).toContain('暂时无法读取工具说明')
  })

  it('offers retry after a read error and keeps Try disabled for an unavailable app', async () => {
    const { onRetry, onTryApp } = await renderDialog(
      resourceState('error', null, 'app/read 暂时失败'),
      { ...app, accessible: false, enabled: false }
    )

    const retry = buttonWithText('重试')
    const tryApp = buttonWithText('立即试用')
    expect(
      document.body.querySelector('[data-slot="plugin-app-tools-error"]')?.textContent
    ).toContain('app/read 暂时失败')
    expect(tryApp?.disabled).toBe(true)

    await act(async () => {
      retry?.click()
      tryApp?.click()
    })

    expect(onRetry).toHaveBeenCalledOnce()
    expect(onTryApp).not.toHaveBeenCalled()
  })

  it('groups read and write tools with independently collapsible sections', async () => {
    await renderDialog(
      resourceState('ready', {
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        app: { id: app.id },
        tools: [
          { name: 'github.create_issue', title: '创建议题', readOnly: false, enabled: true },
          { name: 'github.search', title: '搜索', readOnly: true, enabled: false }
        ]
      })
    )

    const writeTools = buttonWithText('会更改数据 1')
    const readTools = buttonWithText('只读 1')
    expect(writeTools?.getAttribute('aria-expanded')).toBe('true')
    expect(readTools?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      writeTools?.click()
    })

    expect(writeTools?.getAttribute('aria-expanded')).toBe('false')
    expect(readTools?.getAttribute('aria-expanded')).toBe('true')
  })
})
