// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPresentationHtmlController,
  PRESENTATION_PREVIEW_CSP,
  sanitizePresentationHtml,
  type PresentationHtmlViewState
} from './presentationHtml'

export const previewHtml = `<!DOCTYPE html><html><head>
  <style>.slide { width:720pt; height:405pt; } .shape-text { font-family:Arial; }</style>
  <script>window.previewScriptRan = true</script>
  </head><body>
  <div class="sidebar"><div class="sidebar-title">Deck</div>
    <div class="thumb"><div class="thumb-inner"></div><span class="thumb-num">1</span></div>
    <div class="thumb"><div class="thumb-inner"></div><span class="thumb-num">2</span></div>
  </div>
  <div class="main"><h1 class="file-title">Deck</h1>
    <div class="slide-container"><div class="slide-wrapper"><div class="slide" id="slide-1">
      <span class="shape-text" id="shape-1">第一页</span>
      <svg><text style="font-family:Arial">图表标签</text></svg>
    </div></div></div>
    <div class="slide-container"><div class="slide-wrapper"><div class="slide" id="slide-2">
      <span class="shape-text">Second slide</span>
    </div></div></div>
  </div></body></html>`

const initialState: PresentationHtmlViewState = {
  slideIndex: 0,
  zoom: 100,
  layout: 'rail',
  railOpen: false,
  toolbarHeight: 44
}

function loadPreview(html = previewHtml): Document {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const child = frame.contentDocument!
  child.open()
  child.write(sanitizePresentationHtml(html))
  child.close()
  Object.defineProperty(child.querySelector('.main'), 'clientWidth', {
    configurable: true,
    value: 1000
  })
  child.querySelectorAll('.thumb-inner').forEach((inner) => {
    Object.defineProperty(inner, 'clientWidth', { configurable: true, value: 180 })
  })
  return child
}

afterEach(() => document.body.replaceChildren())

describe('sanitizePresentationHtml', () => {
  it('renders formulas as native MathML without allowing URL or HTML extensions', () => {
    const expressions = [
      '\\frac{1}{2}',
      '\\href{https://example.com/track}{click}',
      '\\includegraphics{https://example.com/image.png}',
      '\\htmlClass{hostile}{x}',
      '\\sqrt{'
    ]
    const formulas = expressions
      .map((expression) => {
        const node = document.createElement('span')
        node.className = 'katex-formula'
        node.dataset.formula = expression
        return node.outerHTML
      })
      .join('')
    const parsed = new DOMParser().parseFromString(
      sanitizePresentationHtml(previewHtml.replace('第一页', `第一页${formulas}`)),
      'text/html'
    )
    const rendered = parsed.querySelectorAll('.katex-formula')
    expect(rendered[0].querySelector('math mfrac')).not.toBeNull()
    expect(rendered[0].querySelector('math')?.namespaceURI).toBe(
      'http://www.w3.org/1998/Math/MathML'
    )
    expect(parsed.querySelector('a[href], img, script, link, .hostile')).toBeNull()
    expect(rendered[4].textContent).toContain('\\sqrt{')
  })

  it('keeps the native slide/sidebar markup and embedded assets while removing execution and navigation', () => {
    const unsafe = previewHtml
      .replace(
        '<span class="shape-text" id="shape-1">第一页</span>',
        `<span class="shape-text" id="shape-1" onclick="window.top.alert(1)">第一页</span>
        <img src="https://example.com/tracker" srcset="https://example.com/tracker 2x" onerror="alert(1)">
        <img src="data:image/png;base64,aW1hZ2U=">
        <a href="javascript:alert(1)" target="_top">链接</a>
        <svg><a href="#main">SVG link</a><use href="#shape"></use><image href="data:image/png;base64,aW1hZ2U="></image></svg>
        <iframe srcdoc="unsafe"></iframe><object data="https://example.com"></object>
        <form action="https://example.com"><input autofocus></form>
        <template><script>alert(1)</script></template>`
      )
      .replace(
        '<head>',
        '<head><base href="https://example.com"><meta http-equiv="refresh" content="0;url=https://example.com"><link rel="stylesheet" href="https://example.com/style.css">'
      )
    const html = sanitizePresentationHtml(unsafe, ['.thumb { border-radius:6px }'])
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    expect(parsed.querySelectorAll('.main > .slide-container')).toHaveLength(2)
    expect(parsed.querySelectorAll('.sidebar > .thumb')).toHaveLength(2)
    expect(parsed.querySelector('script,iframe,object,form,input,template,base,link')).toBeNull()
    expect(parsed.querySelector('[onclick],[onerror],[srcdoc],[srcset],[target]')).toBeNull()
    expect(parsed.querySelector('img')?.hasAttribute('src')).toBe(false)
    expect(parsed.querySelectorAll('img')[1].getAttribute('src')).toBe(
      'data:image/png;base64,aW1hZ2U='
    )
    expect(parsed.querySelector('a')?.hasAttribute('href')).toBe(false)
    expect(parsed.querySelector('svg a')?.hasAttribute('href')).toBe(false)
    expect(parsed.querySelector('use')?.getAttribute('href')).toBe('#shape')
    expect(parsed.querySelector('svg image')?.getAttribute('href')).toContain('data:image/png')
    expect(parsed.querySelectorAll('meta')).toHaveLength(1)
    expect(parsed.querySelector('meta')?.getAttribute('content')).toBe(PRESENTATION_PREVIEW_CSP)
    expect(PRESENTATION_PREVIEW_CSP).toContain("script-src 'none'")
    expect(PRESENTATION_PREVIEW_CSP).toContain("connect-src 'none'")
    expect(html).toContain('.thumb { border-radius:6px }')
    expect(parsed.querySelector('.file-title,.sidebar-title')).toBeNull()
  })

  it('rejects missing slides or unmatched thumbnail placeholders', () => {
    expect(() => sanitizePresentationHtml('<html><body><h1>not a deck</h1></body></html>')).toThrow(
      'OfficeCLI'
    )
    expect(() =>
      sanitizePresentationHtml(
        previewHtml.replace(
          '<div class="thumb"><div class="thumb-inner"></div><span class="thumb-num">2</span></div>',
          ''
        )
      )
    ).toThrow('OfficeCLI')
  })
})

describe('createPresentationHtmlController', () => {
  it('remaps thumbnail SVG definitions and local references without changing original IDs or styles', () => {
    const asset = `<svg><defs><linearGradient id="paint"><stop offset="0" stop-color="red"></stop></linearGradient>
      <clipPath id="chart-clip"><rect width="10" height="10"></rect></clipPath></defs>
      <style>.chart-fill { fill:url(#paint) }</style>
      <rect id="chart-bar" class="chart-fill" fill="url(#paint)" style="clip-path:url('#chart-clip')"></rect>
      <use href="#chart-bar"></use></svg>`
    const child = loadPreview(previewHtml.replace('第一页', `第一页${asset}`))
    const controller = createPresentationHtmlController(child, vi.fn(), vi.fn())
    const original = child.querySelector('.main .slide')!
    const clone = child.querySelector('.thumb-slide')!
    const gradient = clone.querySelector('linearGradient')!
    const clip = clone.querySelector('clipPath')!
    const bar = clone.querySelector('.chart-fill')!
    expect(original.querySelector('linearGradient')?.id).toBe('paint')
    expect(original.querySelector('clipPath')?.id).toBe('chart-clip')
    expect(original.querySelector('style')?.textContent).toContain('fill:url(#paint)')
    expect(gradient.id).not.toBe('paint')
    expect(clip.id).not.toBe('chart-clip')
    expect(bar.getAttribute('fill')).toBe(`url(#${gradient.id})`)
    expect(bar.getAttribute('style')).toContain(`url(#${clip.id})`)
    expect(clone.querySelector('use')?.getAttribute('href')).toBe(`#${bar.id}`)
    expect(clone.querySelector('style')?.textContent).toContain('[data-thumbnail-scope="0"]')
    expect(clone.querySelector('style')?.textContent).toContain(`url(#${gradient.id})`)
    const ids = Array.from(child.querySelectorAll('[id]')).map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    controller.dispose()
  })

  it('waits for the private CJK face and reports failure instead of marking a broken preview ready', async () => {
    const child = loadPreview()
    const face = { family: '"Dascowork Preview CJK"', status: 'loaded' }
    const load = vi.fn().mockResolvedValue([face])
    const fonts = {
      load,
      ready: Promise.resolve(),
      [Symbol.iterator]: function* () {
        yield face
      }
    }
    Object.defineProperty(child, 'fonts', { configurable: true, value: fonts })
    const controller = createPresentationHtmlController(child, vi.fn(), vi.fn())
    await controller.ready
    expect(load).toHaveBeenCalledWith('16px "Dascowork Preview CJK"', '中文')
    expect(child.body.dataset.previewReady).toBe('true')
    controller.dispose()

    const broken = loadPreview()
    Object.defineProperty(broken, 'fonts', {
      value: { ...fonts, load: vi.fn().mockRejectedValue(new Error('font decode error')) }
    })
    const brokenController = createPresentationHtmlController(broken, vi.fn(), vi.fn())
    await expect(brokenController.ready).rejects.toThrow('中文字体无法加载')
    expect(broken.body.dataset.previewReady).toBe('false')
    brokenController.dispose()
  })

  it('clones thumbnails once, remaps duplicate IDs, and switches/scales original pages without copying overlays', async () => {
    const child = loadPreview()
    const select = vi.fn()
    const host = vi.fn()
    const controller = createPresentationHtmlController(child, select, host)
    const thumbs = Array.from(child.querySelectorAll<HTMLElement>('.thumb-slide'))
    const originals = Array.from(child.querySelectorAll<HTMLElement>('.main .slide'))
    expect(thumbs).toHaveLength(2)
    const ids = Array.from(child.querySelectorAll('[id]')).map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(originals[0].id).toBe('slide-1')
    expect(originals[0].querySelector<HTMLElement>('.shape-text')?.style.fontFamily).toContain(
      'Dascowork Preview CJK'
    )
    expect(thumbs[0].querySelector<HTMLElement>('.shape-text')?.style.fontFamily).toContain(
      'Dascowork Preview CJK'
    )
    expect(originals[0].querySelector<SVGElement>('text')?.style.fontFamily).toContain(
      'Dascowork Preview CJK'
    )
    const overlay = child.createElement('div')
    overlay.className = 'presentation-stage-overlay'
    originals[0].parentElement!.append(overlay)
    controller.update({
      ...initialState,
      slideIndex: 1,
      zoom: 200,
      layout: 'floating',
      railOpen: true,
      toolbarHeight: 72
    })
    expect(child.querySelectorAll<HTMLElement>('.slide-container')[0].hidden).toBe(true)
    expect(child.querySelectorAll<HTMLElement>('.slide-container')[1].hidden).toBe(false)
    expect(originals[1].style.transform).toBe('scale(2)')
    expect(originals[1].parentElement?.style.width).toBe('1920px')
    expect(child.querySelectorAll('.thumb-slide')[0]).toBe(thumbs[0])
    expect(child.querySelector('.thumb-slide .presentation-stage-overlay')).toBeNull()
    expect(host).toHaveBeenLastCalledWith(originals[1].parentElement)
    expect(child.body.dataset.layout).toBe('floating')
    expect(child.body.classList.contains('rail-open')).toBe(true)
    expect(child.body.style.getPropertyValue('--presentation-toolbar-height')).toBe('72px')
    expect(child.querySelector('.thumb[aria-current="page"] .thumb-num')?.textContent).toBe('2')
    expect(thumbs[0].style.transform).toBe('scale(0.1875)')
    await controller.ready
    expect(child.body.dataset.previewReady).toBe('true')
    controller.dispose()
  })

  it('routes clicks and bounded keyboard navigation to the host and removes listeners on disposal', () => {
    const child = loadPreview()
    const select = vi.fn()
    const controller = createPresentationHtmlController(child, select, vi.fn())
    const second = child.querySelectorAll<HTMLElement>('.thumb')[1]
    second.click()
    expect(select).toHaveBeenLastCalledWith(1)
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(select).toHaveBeenLastCalledWith(1)
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(select).toHaveBeenLastCalledWith(0)
    controller.update({ ...initialState, slideIndex: 1 })
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(select).toHaveBeenLastCalledWith(1)
    const calls = select.mock.calls.length
    const overlay = child.createElement('div')
    overlay.className = 'presentation-stage-overlay'
    child.querySelector('.main .slide')!.append(overlay)
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(select).toHaveBeenCalledTimes(calls)
    controller.dispose()
    second.click()
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(select).toHaveBeenCalledTimes(calls)
  })
})
