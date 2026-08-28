// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/render-units/renderUnitDetails', () => ({
  SourceReferenceCards: ({
    sources
  }: {
    sources: readonly { title: string; usageCount: number }[]
  }) => (
    <div data-slot="workspace-source-references">
      {sources.map((source) => `${source.title}:${source.usageCount}`)}
    </div>
  )
}))

import { SourcesWorkspace } from './SourcesWorkspace'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('SourcesWorkspace', () => {
  it('shows aggregated sources and their usage count', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() =>
      root?.render(
        <SourcesWorkspace
          sources={[
            {
              id: 'source-one',
              sourceType: 'url',
              title: '产品文档',
              url: 'https://example.test/docs',
              usageCount: 2
            }
          ]}
        />
      )
    )

    expect(container.querySelector('[data-slot="workspace-sources"]')?.textContent).toContain(
      '产品文档:2'
    )
  })

  it('explains when the full conversation has no sources', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() => root?.render(<SourcesWorkspace sources={[]} />))

    expect(container.textContent).toContain('还没有可显示的来源')
  })

  it('renders non-navigable task activity separately from citation cards', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() =>
      root?.render(
        <SourcesWorkspace
          sources={[
            {
              id: 'file:/workspace/brief.md',
              sourceType: 'file',
              title: 'brief.md',
              filename: '/workspace/brief.md',
              detail: '用户提供的文件',
              usageCount: 1
            },
            {
              id: 'web-search:Codex',
              sourceType: 'web-search',
              title: 'Web 搜索：Codex',
              detail: '搜索词',
              usageCount: 2
            },
            {
              id: 'mcp:app:github',
              sourceType: 'app',
              title: 'GitHub',
              detail: 'github · read_issue',
              usageCount: 1
            }
          ]}
        />
      )
    )

    const activity = container.querySelector('[data-slot="workspace-source-activity"]')
    expect(activity?.textContent).toContain('brief.md')
    expect(activity?.textContent).toContain('Web 搜索：Codex')
    expect(activity?.textContent).toContain('GitHub')
    expect(activity?.textContent).toContain('2 次')
    expect(container.querySelector('[data-slot="workspace-source-references"]')).toBeNull()
  })

  it('opens only observed ui:// MCP Apps through an explicit user action', () => {
    const onOpenMcpApp = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() =>
      root?.render(
        <SourcesWorkspace
          onOpenMcpApp={onOpenMcpApp}
          sources={[
            {
              id: 'mcp:app:calendar:ui://calendar/app.html',
              sourceType: 'app',
              title: 'Calendar',
              mcpServer: 'calendar',
              resourceUri: 'ui://calendar/app.html',
              usageCount: 1
            },
            {
              id: 'mcp:app:legacy',
              sourceType: 'app',
              title: 'Legacy App',
              mcpServer: 'legacy',
              resourceUri: 'app://legacy',
              usageCount: 1
            }
          ]}
        />
      )
    )

    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    act(() => (buttons[0] as HTMLButtonElement).click())
    expect(onOpenMcpApp).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServer: 'calendar', resourceUri: 'ui://calendar/app.html' })
    )
  })
})
