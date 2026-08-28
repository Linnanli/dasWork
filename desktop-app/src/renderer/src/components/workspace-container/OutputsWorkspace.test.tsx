// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/render-units/renderUnitDetails', () => ({
  EndResourceCards: ({ resources }: { resources: readonly { title: string }[] }) => (
    <div data-slot="workspace-output-resources">{resources.map((resource) => resource.title)}</div>
  )
}))

import { OutputsWorkspace } from './OutputsWorkspace'

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('OutputsWorkspace', () => {
  it('shows aggregated resources with the existing safe resource cards', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() =>
      root?.render(
        <OutputsWorkspace
          canOpenLocalPaths
          onCreateOutput={vi.fn()}
          resources={[
            {
              id: 'file:out/report.pdf',
              type: 'file',
              title: 'report.pdf',
              path: 'out/report.pdf',
              cwd: '/workspace'
            }
          ]}
        />
      )
    )

    expect(container.querySelector('[data-slot="workspace-outputs"]')?.textContent).toContain(
      'report.pdf'
    )
  })

  it('explains when the full conversation has no outputs', () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() =>
      root?.render(<OutputsWorkspace canOpenLocalPaths onCreateOutput={vi.fn()} resources={[]} />)
    )

    expect(container.textContent).toContain('还没有生成可打开的产物')
  })

  it('starts a new editable task for each supported output kind', () => {
    const onCreateOutput = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    act(() =>
      root?.render(
        <OutputsWorkspace canOpenLocalPaths onCreateOutput={onCreateOutput} resources={[]} />
      )
    )

    const documentButton = container.querySelector<HTMLButtonElement>('[aria-label="创建文档任务"]')
    const websiteButton = container.querySelector<HTMLButtonElement>('[aria-label="创建网站任务"]')
    act(() => documentButton?.click())
    act(() => websiteButton?.click())

    expect(onCreateOutput).toHaveBeenNthCalledWith(1, 'document')
    expect(onCreateOutput).toHaveBeenNthCalledWith(2, 'website')
    expect(container.textContent).toContain('发送前可以修改')
  })
})
