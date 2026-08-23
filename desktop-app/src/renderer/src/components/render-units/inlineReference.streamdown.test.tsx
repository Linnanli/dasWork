// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { Streamdown, type Components, type PluginConfig } from 'streamdown'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  InlineReferenceAnchor,
  InlineReferenceCodeToken,
  InlineReferenceProvider
} from './inlineReference'
import {
  inlineReferenceCodeTagName,
  referenceInlineRehypePlugins
} from '@/lib/referenceInlineMarkdown'
import { referenceUrlTransform } from '@/lib/referenceInlineTarget'
import { resolveInlineReferenceAction } from '@/lib/referenceInlineAction'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const components = {
  a: InlineReferenceAnchor,
  [inlineReferenceCodeTagName]: InlineReferenceCodeToken
} satisfies Components
const plugins: PluginConfig = {
  code: code as unknown as PluginConfig['code'],
  math,
  mermaid,
  cjk
}
const animation = {
  animation: 'fadeIn',
  duration: 120,
  sep: 'word' as const,
  stagger: 12
}

describe('Streamdown inline references', () => {
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

  it('decorates only recognized inline-code references through the production Markdown path', async () => {
    await act(async () => {
      root.render(
        <InlineReferenceProvider value={{ canOpenLocalPaths: false, workspaceCwd: '/repo' }}>
          <Streamdown
            animated={animation}
            components={components}
            isAnimating
            mode="streaming"
            plugins={plugins}
            rehypePlugins={referenceInlineRehypePlugins}
            urlTransform={referenceUrlTransform}
          >
            {
              '[GitHub](app://github) `@src/App.tsx:5` `[Prior task](thread://thread-child)` `$review` `[unknown](unknown://target)` `ordinary code`\n\n~~~text\n@src/block.ts\n~~~\n\n[unsafe](javascript:alert(1))'
            }
          </Streamdown>
        </InlineReferenceProvider>
      )
    })

    expect(container.querySelector('[data-inline-reference-kind="app"]')).not.toBeNull()
    expect(container.querySelector('[data-inline-reference-kind="local-file"]')).not.toBeNull()
    expect(container.querySelector('[data-inline-reference-kind="conversation"]')).not.toBeNull()
    expect(container.querySelector('[data-inline-reference-kind="skill"]')).not.toBeNull()
    expect(
      container
        .querySelector('[data-inline-reference-kind="local-file"]')
        ?.getAttribute('data-interactive')
    ).toBe('false')
    const ordinaryInlineCode = Array.from(container.querySelectorAll('code')).filter(
      (code) => code.closest('pre') === null
    )
    expect(ordinaryInlineCode.map((code) => code.textContent)).toEqual([
      '[unknown](unknown://target)',
      'ordinary code'
    ])
    for (const code of ordinaryInlineCode) {
      expect(code.getAttribute('data-streamdown')).toBe('inline-code')
      expect(code.className).toBe('rounded bg-muted px-1.5 py-0.5 font-mono text-sm')
    }
    expect(container.querySelector('pre')?.textContent).toContain('@src/block.ts')
    expect(container.querySelectorAll('[data-inline-reference-kind="local-file"]')).toHaveLength(1)
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
  })

  it('keeps ordinary inline code identical to Streamdown without reference decoration', async () => {
    const markdown = 'ordinary `const value = 1`'

    await act(async () => {
      root.render(
        <div>
          <div data-testid="baseline">
            <Streamdown animated={animation} isAnimating mode="streaming" plugins={plugins}>
              {markdown}
            </Streamdown>
          </div>
          <div data-testid="enhanced">
            <InlineReferenceProvider value={{ canOpenLocalPaths: false }}>
              <Streamdown
                animated={animation}
                components={components}
                isAnimating
                mode="streaming"
                plugins={plugins}
                rehypePlugins={referenceInlineRehypePlugins}
                urlTransform={referenceUrlTransform}
              >
                {markdown}
              </Streamdown>
            </InlineReferenceProvider>
          </div>
        </div>
      )
    })

    const baselineCode = container.querySelector('[data-testid="baseline"] code')
    const enhancedCode = container.querySelector('[data-testid="enhanced"] code')
    expect(enhancedCode?.outerHTML).toBe(baselineCode?.outerHTML)
  })

  it('preserves raw local Markdown targets through Streamdown hardening', async () => {
    const execute = vi.fn()
    await act(async () => {
      root.render(
        <InlineReferenceProvider
          value={{
            canOpenLocalPaths: true,
            workspaceCwd: '/workspace',
            resolve: (descriptor) =>
              resolveInlineReferenceAction(descriptor, {
                canOpenLocalPaths: true,
                canOpenWorkspace: true,
                workspaceCwd: '/workspace'
              }),
            execute
          }}
        >
          <Streamdown
            animated={animation}
            components={components}
            isAnimating
            mode="streaming"
            plugins={plugins}
            rehypePlugins={referenceInlineRehypePlugins}
            urlTransform={referenceUrlTransform}
          >
            {
              '[relative](src/App.tsx:4) [same directory](./src/App.tsx:5) [file URL](file:///tmp/App.tsx:6) [Windows](C:/repo/src/App.tsx:7) [unsafe](javascript:alert(1))'
            }
          </Streamdown>
        </InlineReferenceProvider>
      )
    })

    const localReferences = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-inline-reference-kind="local-file"]'
      )
    )
    expect(localReferences.map((reference) => reference.textContent)).toEqual([
      'relative (line 4)',
      'same directory (line 5)',
      'file URL (line 6)',
      'Windows (line 7)'
    ])

    for (const reference of localReferences) {
      await act(async () => reference.click())
    }

    expect(execute).toHaveBeenNthCalledWith(1, {
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 4,
      mode: 'preview'
    })
    expect(execute).toHaveBeenNthCalledWith(2, {
      type: 'workspace-file',
      relativePath: 'src/App.tsx',
      line: 5,
      mode: 'preview'
    })
    expect(execute).toHaveBeenNthCalledWith(3, {
      type: 'system-file',
      line: 6,
      path: '/tmp/App.tsx'
    })
    expect(execute).toHaveBeenNthCalledWith(4, {
      type: 'system-file',
      line: 7,
      path: 'C:/repo/src/App.tsx'
    })
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
  })
})
