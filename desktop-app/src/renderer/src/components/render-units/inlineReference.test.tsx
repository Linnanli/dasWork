// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { InlineReference } from './inlineReference'
import { classifyReferenceTarget } from '@/lib/referenceInlineTarget'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('InlineReference', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.desktopApp = {
      codex: {
        openLocalPath: vi.fn(async () => undefined)
      }
    } as never
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('opens a local path only when the current conversation grants local capability', async () => {
    const descriptor = classifyReferenceTarget({ href: 'src/App.tsx:4', label: 'App.tsx' })
    expect(descriptor).toBeDefined()

    await act(async () => {
      root.render(
        <InlineReference
          context={{ canOpenLocalPaths: true, workspaceCwd: '/repo' }}
          descriptor={descriptor!}
        />
      )
    })
    const button = container.querySelector<HTMLButtonElement>(
      'button[data-inline-reference-kind="local-file"]'
    )
    expect(button?.dataset.interactive).toBe('true')
    expect(button?.textContent).toBe('App.tsx (line 4)')
    await act(async () => button?.click())
    expect(window.desktopApp.codex.openLocalPath).toHaveBeenCalledWith({
      path: 'src/App.tsx',
      cwd: '/repo',
      line: 4
    })

    act(() => {
      root.render(
        <InlineReference
          context={{ canOpenLocalPaths: false, workspaceCwd: '/repo' }}
          descriptor={descriptor!}
        />
      )
    })
    const disabledToken = container.querySelector<HTMLElement>(
      '[data-inline-reference-kind="local-file"]'
    )
    expect(disabledToken?.tagName).toBe('SPAN')
    expect(disabledToken?.dataset.interactive).toBe('false')
    expect(disabledToken?.getAttribute('tabindex')).toBeNull()
  })

  it('uses a link for HTTP and an existing resolver for a conversation', async () => {
    const openExternalUrl = vi.fn()
    const external = classifyReferenceTarget({ href: 'https://example.test', label: 'Example' })
    await act(async () => {
      root.render(
        <InlineReference
          context={{ canOpenLocalPaths: true, onOpenExternalUrl: openExternalUrl }}
          descriptor={external!}
        />
      )
    })
    const link = container.querySelector<HTMLAnchorElement>(
      'a[data-inline-reference-kind="external-url"]'
    )
    expect(link?.getAttribute('href')).toBe('https://example.test/')
    await act(async () => link?.click())
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.test/')

    const openConversation = vi.fn()
    const conversation = classifyReferenceTarget({ href: 'thread://thread-child', label: 'Child' })
    act(() => {
      root.render(
        <InlineReference
          context={{ canOpenLocalPaths: true, onOpenConversation: openConversation }}
          descriptor={conversation!}
        />
      )
    })
    const button = container.querySelector<HTMLButtonElement>(
      'button[data-inline-reference-kind="conversation"]'
    )
    expect(button?.dataset.interactive).toBe('true')
    act(() => button?.click())
    expect(openConversation).toHaveBeenCalledWith('thread-child')
  })

  it('keeps agent mentions display-only without the reference agent resolver', () => {
    const openConversation = vi.fn()
    const liveAgent = classifyReferenceTarget({ href: 'agent://thread-child', label: 'Explorer' })
    const configuredAgent = classifyReferenceTarget({
      href: 'subagent://reviewer',
      label: 'Reviewer'
    })

    act(() => {
      root.render(
        <div>
          <InlineReference
            context={{ canOpenLocalPaths: true, onOpenConversation: openConversation }}
            descriptor={liveAgent!}
          />
          <InlineReference
            context={{ canOpenLocalPaths: true, onOpenConversation: openConversation }}
            descriptor={configuredAgent!}
          />
        </div>
      )
    })

    const agents = Array.from(
      container.querySelectorAll<HTMLElement>('[data-inline-reference-kind="agent"]')
    )
    expect(agents).toHaveLength(2)
    expect(agents.every((agent) => agent.tagName === 'SPAN')).toBe(true)
    expect(agents.every((agent) => agent.dataset.interactive === 'false')).toBe(true)
    agents.forEach((agent) => agent.click())
    expect(openConversation).not.toHaveBeenCalled()
  })

  it('keeps display-only semantic references out of the tab order and preserves unsafe text', () => {
    const resource = classifyReferenceTarget({
      href: 'mcp-resource://docs/app%3A%2F%2Fdocs',
      label: 'Docs resource'
    })
    act(() => {
      root.render(<InlineReference context={{ canOpenLocalPaths: true }} descriptor={resource!} />)
    })
    const token = container.querySelector<HTMLElement>(
      '[data-inline-reference-kind="mcp-resource"]'
    )
    expect(token?.tagName).toBe('SPAN')
    expect(token?.dataset.interactive).toBe('false')
    expect(token?.getAttribute('role')).toBeNull()
    expect(token?.getAttribute('tabindex')).toBeNull()

    const unsafe = classifyReferenceTarget({ href: 'javascript:alert(1)', label: 'unsafe' })
    act(() => {
      root.render(<InlineReference context={{ canOpenLocalPaths: true }} descriptor={unsafe!} />)
    })
    expect(container.querySelector('[data-inline-reference-kind="unsupported"]')?.textContent).toBe(
      'unsafe'
    )
    expect(container.querySelector('a, button')).toBeNull()
  })
})
