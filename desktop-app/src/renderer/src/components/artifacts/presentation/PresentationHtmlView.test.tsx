// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PresentationHtmlView } from './PresentationHtmlView'

// Vitest stubs CSS assets by default; exercise the same stylesheet text as the built iframe.
vi.mock('./PresentationHtmlView.css?raw', async () => {
  const { readFile } = await import('node:fs/promises')
  return {
    default: await readFile(
      'src/renderer/src/components/artifacts/presentation/PresentationHtmlView.css',
      'utf8'
    )
  }
})
vi.mock('./PresentationPanel.css?raw', async () => {
  const { readFile } = await import('node:fs/promises')
  return {
    default: await readFile(
      'src/renderer/src/components/artifacts/presentation/PresentationPanel.css',
      'utf8'
    )
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const html = `<style>.slide { width:960px; height:540px } .thumb-num { position:absolute; bottom:2px; right:4px }</style>
  <div class="sidebar"><div class="thumb"><div class="thumb-inner"></div><span class="thumb-num">1</span></div>
  <div class="thumb"><div class="thumb-inner"></div><span class="thumb-num">2</span></div></div>
  <div class="main"><div class="slide-container"><div class="slide-wrapper"><div class="slide">First</div></div></div>
  <div class="slide-container"><div class="slide-wrapper"><div class="slide">Second</div></div></div></div>
  <script>window.top.previewScriptRan = true</script>`

describe('PresentationHtmlView', () => {
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
    vi.unstubAllGlobals()
  })

  it('forwards a private-font loading failure to the host', async () => {
    const error = vi.fn()
    await act(async () =>
      root.render(
        <PresentationHtmlView
          html={html}
          slideIndex={0}
          zoom={100}
          layout="rail"
          railOpen={false}
          toolbarHeight={44}
          onSelectSlide={vi.fn()}
          overlay={null}
          onError={error}
        />
      )
    )
    const frame = container.querySelector<HTMLIFrameElement>('iframe')!
    const child = frame.contentDocument!
    await act(async () => {
      child.open()
      child.write(frame.srcdoc)
      const face = { family: 'Dascowork Preview CJK' }
      Object.defineProperty(child, 'fonts', {
        value: {
          load: vi.fn().mockRejectedValue(new Error('bad font')),
          ready: Promise.resolve(),
          [Symbol.iterator]: function* () {
            yield face
          }
        }
      })
      child.close()
      frame.dispatchEvent(new Event('load'))
    })
    expect(error).toHaveBeenCalledWith('演示文稿预览的中文字体无法加载。')
    expect(child.body.dataset.previewReady).toBe('false')
  })

  it('loads only sanitized markup in a script-free frame and portals the overlay into the selected original page', async () => {
    const select = vi.fn()
    const render = (slideIndex: number): void =>
      root.render(
        <PresentationHtmlView
          html={html}
          slideIndex={slideIndex}
          zoom={100}
          layout="rail"
          railOpen={false}
          toolbarHeight={44}
          onSelectSlide={select}
          overlay={
            <div className="presentation-stage-overlay">
              <button>批注</button>
            </div>
          }
        />
      )
    await act(async () => render(0))
    const frame = container.querySelector<HTMLIFrameElement>('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.getAttribute('title')).toBe('演示文稿网页预览')
    expect(frame.srcdoc).not.toContain('<script')
    expect(frame.srcdoc).toContain("script-src 'none'")
    const child = frame.contentDocument!
    await act(async () => {
      child.open()
      child.write(frame.srcdoc)
      child.close()
      frame.dispatchEvent(new Event('load'))
    })
    const pages = child.querySelectorAll('.main .slide-wrapper')
    expect(pages[0].querySelector('.presentation-stage-overlay')?.textContent).toBe('批注')
    expect(pages[0].querySelector('.slide .presentation-stage-overlay')).toBeNull()
    expect(child.defaultView?.getComputedStyle(child.querySelector('.thumb-num')!).position).toBe(
      'static'
    )
    expect(child.querySelector('.thumb-slide .presentation-stage-overlay')).toBeNull()
    await act(async () => render(1))
    expect(pages[0].querySelector('.presentation-stage-overlay')).toBeNull()
    expect(pages[1].querySelector('.presentation-stage-overlay')?.textContent).toBe('批注')
    expect(child.body.dataset.previewReady).toBe('true')
    await act(async () => child.querySelectorAll<HTMLElement>('.thumb')[1].click())
    expect(select).toHaveBeenCalledWith(1)
  })
})
