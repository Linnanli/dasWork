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

  it('executes a workspace file action only when the resolver grants one', async () => {
    const descriptor = classifyReferenceTarget({ href: 'src/App.tsx:4', label: 'App.tsx' })
    expect(descriptor).toBeDefined()
    const execute = vi.fn()

    await act(async () => {
      root.render(
        <InlineReference
          context={{
            canOpenLocalPaths: true,
            resolve: () => ({
              type: 'workspace-file',
              relativePath: 'src/App.tsx',
              line: 4,
              mode: 'preview'
            }),
            execute
          }}
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
    expect(execute).toHaveBeenCalledWith({
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 4,
      mode: 'preview'
    })

    act(() => {
      root.render(
        <InlineReference
          context={{
            canOpenLocalPaths: false,
            resolve: () => ({ type: 'display-only', reason: 'local-access-unavailable' }),
            execute
          }}
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

  it('uses an anchor for HTTP and executes unified browser/conversation actions', async () => {
    const execute = vi.fn()
    const external = classifyReferenceTarget({ href: 'https://example.test', label: 'Example' })
    await act(async () => {
      root.render(
        <InlineReference
          context={{
            canOpenLocalPaths: true,
            resolve: () => ({ type: 'workspace-browser', url: 'https://example.test/' }),
            execute
          }}
          descriptor={external!}
        />
      )
    })
    const link = container.querySelector<HTMLAnchorElement>(
      'a[data-inline-reference-kind="external-url"]'
    )
    expect(link?.getAttribute('href')).toBe('https://example.test/')
    await act(async () => link?.click())
    expect(execute).toHaveBeenCalledWith({
      type: 'workspace-browser',
      url: 'https://example.test/'
    })

    execute.mockClear()
    const conversation = classifyReferenceTarget({ href: 'thread://thread-child', label: 'Child' })
    act(() => {
      root.render(
        <InlineReference
          context={{
            canOpenLocalPaths: true,
            resolve: () => ({ type: 'conversation', conversationId: 'thread-child' }),
            execute
          }}
          descriptor={conversation!}
        />
      )
    })
    const button = container.querySelector<HTMLButtonElement>(
      'button[data-inline-reference-kind="conversation"]'
    )
    expect(button?.dataset.interactive).toBe('true')
    act(() => button?.click())
    expect(execute).toHaveBeenCalledWith({ type: 'conversation', conversationId: 'thread-child' })
  })

  it('keeps modified URL clicks native and only pins file references on a double click', () => {
    const execute = vi.fn()
    const external = classifyReferenceTarget({ href: 'https://example.test', label: 'Example' })
    const file = classifyReferenceTarget({ href: 'src/App.tsx:4', label: 'App.tsx' })
    const conversation = classifyReferenceTarget({ href: 'thread://thread-child', label: 'Child' })

    act(() => {
      root.render(
        <>
          <InlineReference
            context={{
              canOpenLocalPaths: true,
              resolve: () => ({ type: 'workspace-browser', url: 'https://example.test/' }),
              execute
            }}
            descriptor={external!}
          />
          <InlineReference
            context={{
              canOpenLocalPaths: true,
              resolve: () => ({
                type: 'workspace-file',
                relativePath: 'src/App.tsx',
                line: 4,
                mode: 'preview'
              }),
              execute
            }}
            descriptor={file!}
          />
          <InlineReference
            context={{
              canOpenLocalPaths: true,
              resolve: () => ({ type: 'conversation', conversationId: 'thread-child' }),
              execute
            }}
            descriptor={conversation!}
          />
        </>
      )
    })

    const link = container.querySelector<HTMLAnchorElement>(
      'a[data-inline-reference-kind="external-url"]'
    )
    const button = container.querySelector<HTMLButtonElement>(
      'button[data-inline-reference-kind="local-file"]'
    )
    const conversationButton = container.querySelector<HTMLButtonElement>(
      'button[data-inline-reference-kind="conversation"]'
    )
    expect(link).not.toBeNull()
    expect(button).not.toBeNull()
    expect(conversationButton).not.toBeNull()

    act(() => {
      link?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })
      )
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      button?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      conversationButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      conversationButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      conversationButton?.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true })
      )
    })

    expect(execute.mock.calls).toEqual([
      [
        {
          type: 'workspace-file',
          relativePath: 'src/App.tsx',
          line: 4,
          mode: 'preview'
        }
      ],
      [
        {
          type: 'workspace-file',
          relativePath: 'src/App.tsx',
          line: 4,
          mode: 'preview'
        }
      ],
      [
        {
          type: 'workspace-file',
          relativePath: 'src/App.tsx',
          line: 4,
          mode: 'pinned'
        }
      ],
      [{ type: 'conversation', conversationId: 'thread-child' }],
      [{ type: 'conversation', conversationId: 'thread-child' }]
    ])
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
