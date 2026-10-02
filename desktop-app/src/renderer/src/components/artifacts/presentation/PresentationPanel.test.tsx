// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PresentationPanel } from './PresentationPanel'
import type { PresentationDocument } from './presentationTypes'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('PresentationPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('uses rendered pages for the stage and thumbnails without redrawing extracted shapes', async () => {
    const document: PresentationDocument = {
      width: 16,
      height: 9,
      slides: [
        {
          id: 'slide-1',
          number: 1,
          name: '封面',
          elements: [
            {
              id: 'shape-1',
              kind: 'shape',
              name: '可批注区域',
              frame: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
              fill: '#22ccee',
              text: '解析器不完整的文字'
            }
          ]
        },
        { id: 'slide-2', number: 2, name: '第二页', elements: [] }
      ]
    }
    const renderedSlides = ['data:image/png;base64,cGFnZTE=', 'data:image/png;base64,cGFnZTI=']

    await act(async () =>
      root.render(<PresentationPanel document={document} renderedSlides={renderedSlides} />)
    )

    expect(container.querySelector('.presentation-stage-image')?.getAttribute('src')).toBe(
      renderedSlides[0]
    )
    expect(
      Array.from(container.querySelectorAll('.presentation-thumbnail-canvas img')).map((image) =>
        image.getAttribute('src')
      )
    ).toEqual(renderedSlides)
    expect(container.textContent).not.toContain('解析器不完整的文字')
    expect(container.querySelector('.presentation-element')?.textContent).toBe('')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.click()
    })
    expect(container.querySelector('.presentation-stage-image')?.getAttribute('src')).toBe(
      renderedSlides[1]
    )
    expect(container.textContent).toContain('2 / 2')
  })
})
