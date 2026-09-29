import { renderToString } from 'katex'

export type PresentationHtmlLayout = 'rail' | 'floating' | 'stacked'

export interface PresentationHtmlViewState {
  slideIndex: number
  zoom: number
  layout: PresentationHtmlLayout
  railOpen: boolean
  toolbarHeight: number
}

export const PRESENTATION_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const removedElements = [
  'script',
  'link',
  'base',
  'meta',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'select',
  'audio',
  'video',
  'source',
  'track',
  'portal',
  'applet',
  'template',
  'noscript',
  'canvas',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  '.sidebar-toggle',
  '.toggle-zone',
  '.page-counter',
  '.sidebar-title',
  '.file-title',
  '.slide-label',
  '.slide-notes'
].join(',')

/** Sanitize while still in inert template content, before any resources can load. */
export function sanitizePresentationHtml(html: string, styles: readonly string[] = []): string {
  const template = document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll(removedElements).forEach((element) => element.remove())
  template.content.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (
        name.startsWith('on') ||
        [
          'srcdoc',
          'srcset',
          'action',
          'formaction',
          'target',
          'download',
          'autofocus',
          'contenteditable',
          'tabindex',
          'ping',
          'background',
          'poster',
          'data',
          'codebase'
        ].includes(name)
      ) {
        element.removeAttribute(attribute.name)
      } else if (name === 'src') {
        if (
          element.localName !== 'img' ||
          !/^data:image\/[a-z0-9.+-]+[;,]/i.test(attribute.value)
        ) {
          element.removeAttribute(attribute.name)
        }
      } else if (name === 'href' || name === 'xlink:href') {
        // Only SVG-local references are useful in a static preview. Navigation is owned by the app.
        const svgReference =
          element.namespaceURI === 'http://www.w3.org/2000/svg' &&
          (['use', 'linearGradient', 'radialGradient', 'pattern', 'filter'].includes(
            element.localName
          )
            ? /^#[\w:.-]+$/.test(attribute.value)
            : element.localName === 'image' &&
              /^data:image\/[a-z0-9.+-]+[;,]/i.test(attribute.value))
        if (!svgReference) {
          element.removeAttribute(attribute.name)
        }
      }
    }
  })

  const main = template.content.querySelector('.main')
  const sidebar = template.content.querySelector('.sidebar')
  const slides = main?.querySelectorAll(':scope > .slide-container')
  const thumbs = sidebar?.querySelectorAll(':scope > .thumb')
  if (
    !main ||
    !sidebar ||
    !slides?.length ||
    slides.length !== thumbs?.length ||
    Array.from(slides).some((slide) => !slide.querySelector('.slide-wrapper > .slide')) ||
    Array.from(thumbs).some((thumb) => !thumb.querySelector('.thumb-inner'))
  ) {
    throw new Error('OfficeCLI 网页预览缺少完整的幻灯片或缩略图。')
  }

  const output = document.implementation.createHTMLDocument('演示文稿网页预览')
  const csp = output.createElement('meta')
  csp.httpEquiv = 'Content-Security-Policy'
  csp.content = PRESENTATION_PREVIEW_CSP
  output.head.prepend(csp)
  for (const element of Array.from(template.content.children)) {
    if (element.localName === 'title') element.remove()
    else if (element.localName === 'style') output.head.append(element)
  }
  output.body.replaceChildren(template.content)
  output.body.querySelectorAll<HTMLElement>('.katex-formula').forEach((formula) => {
    const expression = formula.dataset.formula
    if (!expression) return
    try {
      const rendered = output.createElement('template')
      rendered.innerHTML = renderToString(expression, {
        output: 'mathml',
        displayMode: formula.dataset.display === '1',
        trust: false,
        throwOnError: false,
        maxExpand: 1000,
        maxSize: 10
      })
      formula.replaceChildren(rendered.content)
    } catch {
      formula.textContent = expression
    }
  })
  for (const css of styles) {
    const style = output.createElement('style')
    style.textContent = css
    output.head.append(style)
  }
  output.documentElement.className = 'dascowork-presentation-preview'
  output.body.dataset.previewReady = 'false'
  return `<!DOCTYPE html>\n${output.documentElement.outerHTML}`
}

interface SlideGeometry {
  slide: HTMLElement
  wrapper: HTMLElement
  container: HTMLElement
  thumb: HTMLElement
  thumbnail: HTMLElement
  width: number
  height: number
}

function pixels(value: string): number {
  const number = Number.parseFloat(value)
  return value.endsWith('pt') ? (number * 4) / 3 : number
}

function applyCjkFont(slide: HTMLElement): void {
  const document = slide.ownerDocument
  const walker = document.createTreeWalker(slide, 4 /* SHOW_TEXT */)
  const parents = new Set<HTMLElement | SVGElement>()
  while (walker.nextNode()) {
    if (
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
        walker.currentNode.textContent ?? ''
      )
    ) {
      const parent = walker.currentNode.parentElement
      if (parent && 'style' in parent) parents.add(parent as HTMLElement | SVGElement)
      const formula = parent?.closest<HTMLElement>('.katex-formula')
      if (formula) parents.add(formula)
    }
  }
  for (const parent of parents) {
    const previous =
      document.defaultView?.getComputedStyle(parent).fontFamily ?? parent.style.fontFamily
    parent.style.fontFamily = `'Dascowork Preview CJK'${previous ? `, ${previous}` : ''}`
  }
}

export interface PresentationHtmlController {
  update(state: PresentationHtmlViewState): void
  resize(): void
  dispose(): void
  ready: Promise<void>
}

function cloneThumbnailSlide(slide: HTMLElement, index: number): HTMLElement {
  const thumbnail = slide.cloneNode(true) as HTMLElement
  thumbnail.className = 'thumb-slide'
  thumbnail.dataset.thumbnailScope = String(index)
  thumbnail.style.transform = ''
  thumbnail.querySelectorAll('.presentation-stage-overlay').forEach((element) => element.remove())
  const idMap = new Map<string, string>()
  let suffix = 0
  const elements = [thumbnail, ...thumbnail.querySelectorAll<HTMLElement | SVGElement>('*')]
  for (const element of elements) {
    const originalId = element.getAttribute('id')
    if (!originalId) continue
    let nextId: string
    do {
      nextId = `dascowork-thumbnail-${index}-${suffix++}`
    } while (slide.ownerDocument.getElementById(nextId))
    if (!idMap.has(originalId)) idMap.set(originalId, nextId)
    element.id = nextId
  }
  const replaceUrls = (value: string): string =>
    value.replace(/url\(\s*(['"]?)#([^\s)'"]+)\1\s*\)/g, (match, _quote: string, id: string) => {
      const next = idMap.get(id)
      return next ? `url(#${next})` : match
    })
  const urlAttributes = new Set([
    'style',
    'fill',
    'stroke',
    'filter',
    'clip-path',
    'mask',
    'marker-start',
    'marker-mid',
    'marker-end'
  ])
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (urlAttributes.has(attribute.name)) {
        element.setAttribute(attribute.name, replaceUrls(attribute.value))
      } else if (attribute.name === 'href' || attribute.name === 'xlink:href') {
        const next = idMap.get(attribute.value.slice(1))
        if (attribute.value.startsWith('#') && next)
          element.setAttribute(attribute.name, `#${next}`)
      } else if (attribute.name === 'aria-labelledby' || attribute.name === 'aria-describedby') {
        element.setAttribute(
          attribute.name,
          attribute.value
            .split(/\s+/)
            .map((id) => idMap.get(id) ?? id)
            .join(' ')
        )
      }
    }
    if (element.localName === 'style') {
      // SVG styles are document-wide. Scope copied rules so their remapped URLs cannot restyle originals.
      const stylesheet = slide.ownerDocument.createElement('style')
      stylesheet.textContent = element.textContent
      slide.ownerDocument.head.append(stylesheet)
      const scopedRules = (rules: CSSRuleList): string =>
        Array.from(rules)
          .map((rule) => {
            if ('selectorText' in rule && 'style' in rule) {
              const styleRule = rule as CSSStyleRule
              const selectors = styleRule.selectorText.replace(
                /#([\w-]+)/g,
                (match, id: string) => {
                  const next = idMap.get(id)
                  return next ? `#${next}` : match
                }
              )
              return `[data-thumbnail-scope="${index}"] :is(${selectors}) { ${replaceUrls(styleRule.style.cssText)} }`
            }
            if ('cssRules' in rule && rule.type !== 7 /* KEYFRAMES_RULE */) {
              const grouping = rule as CSSGroupingRule
              return `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${scopedRules(grouping.cssRules)}}`
            }
            return ''
          })
          .join('\n')
      try {
        element.textContent = stylesheet.sheet ? scopedRules(stylesheet.sheet.cssRules) : ''
      } finally {
        stylesheet.remove()
      }
    }
  }
  return thumbnail
}

/** All preview behavior runs in the host; the frame never executes document scripts. */
export function createPresentationHtmlController(
  document: Document,
  onSelectSlide: (index: number) => void,
  onSlideHost: (wrapper: HTMLElement) => void
): PresentationHtmlController {
  const main = document.querySelector<HTMLElement>('.main')
  const sidebar = document.querySelector<HTMLElement>('.sidebar')
  if (!main || !sidebar) throw new Error('演示文稿网页预览无法初始化。')
  const containers = Array.from(main.querySelectorAll<HTMLElement>(':scope > .slide-container'))
  const thumbs = Array.from(sidebar.querySelectorAll<HTMLElement>(':scope > .thumb'))
  if (!containers.length || containers.length !== thumbs.length) {
    throw new Error('演示文稿网页预览的页数不一致。')
  }

  const pages: SlideGeometry[] = containers.map((container, index) => {
    const slide = container.querySelector<HTMLElement>('.slide-wrapper > .slide')
    const inner = thumbs[index].querySelector<HTMLElement>('.thumb-inner')
    if (!slide || !inner || !slide.parentElement)
      throw new Error('演示文稿网页预览的页面结构不完整。')
    const style = document.defaultView?.getComputedStyle(slide)
    const width = slide.offsetWidth || pixels(style?.width ?? slide.style.width)
    const height = slide.offsetHeight || pixels(style?.height ?? slide.style.height)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error('演示文稿网页预览的页面尺寸无效。')
    }
    slide.style.width = `${width}px`
    slide.style.height = `${height}px`
    applyCjkFont(slide)
    const thumbnail = cloneThumbnailSlide(slide, index)
    inner.replaceChildren(thumbnail)
    inner.style.aspectRatio = `${width} / ${height}`
    inner.setAttribute('aria-hidden', 'true')
    const thumb = thumbs[index]
    thumb.setAttribute('role', 'button')
    thumb.tabIndex = 0
    thumb.setAttribute('aria-label', `第 ${index + 1} 页`)
    return { slide, wrapper: slide.parentElement, container, thumb, thumbnail, width, height }
  })
  sidebar.setAttribute('role', 'navigation')
  sidebar.setAttribute('aria-label', '幻灯片列表')

  let state: PresentationHtmlViewState = {
    slideIndex: 0,
    zoom: 100,
    layout: 'rail',
    railOpen: false,
    toolbarHeight: 44
  }
  let selectedSlide: HTMLElement | undefined
  let disposed = false
  const resize = (): void => {
    if (disposed) return
    const availableWidth = Math.max(320, main.clientWidth - 40)
    const zoom = Number.isFinite(state.zoom) ? Math.max(50, Math.min(200, state.zoom)) / 100 : 1
    for (const page of pages) {
      if (!page.container.hidden) {
        const scale = Math.max(320, availableWidth * zoom) / page.width
        page.slide.style.transform = `scale(${scale})`
        page.slide.style.transformOrigin = 'top left'
        page.wrapper.style.width = `${page.width * scale}px`
        page.wrapper.style.height = `${page.height * scale}px`
      }
      const thumbnailWidth = page.thumbnail.parentElement?.clientWidth ?? 0
      if (thumbnailWidth > 0) {
        page.thumbnail.style.transform = `scale(${thumbnailWidth / page.width})`
        page.thumbnail.style.transformOrigin = 'top left'
      }
    }
  }
  const update = (next: PresentationHtmlViewState): void => {
    if (disposed) return
    state = { ...next, slideIndex: Math.max(0, Math.min(pages.length - 1, next.slideIndex)) }
    document.body.dataset.layout = state.layout
    document.body.classList.toggle('rail-open', state.railOpen)
    document.body.style.setProperty(
      '--presentation-toolbar-height',
      `${Math.max(0, state.toolbarHeight)}px`
    )
    for (const [index, page] of pages.entries()) {
      const selected = index === state.slideIndex
      page.container.hidden = !selected
      page.thumb.classList.toggle('active', selected)
      if (selected) page.thumb.setAttribute('aria-current', 'page')
      else page.thumb.removeAttribute('aria-current')
    }
    const page = pages[state.slideIndex]
    if (selectedSlide !== page.wrapper) {
      selectedSlide = page.wrapper
      onSlideHost(page.wrapper)
      main.scrollTop = 0
      main.scrollLeft = 0
    }
    resize()
  }
  const thumbIndex = (target: EventTarget | null): number => {
    if (!target || !('nodeType' in target)) return -1
    return pages.findIndex((page) => page.thumb.contains(target as Node))
  }
  const click = (event: MouseEvent): void => {
    const index = thumbIndex(event.target)
    if (index >= 0) onSelectSlide(index)
  }
  const keydown = (event: KeyboardEvent): void => {
    const target = event.target as Element | null
    // React handles keyboard events on its own annotation overlay.
    if (target?.closest?.('.presentation-stage-overlay, input, textarea, [contenteditable]')) return
    const index = thumbIndex(event.target)
    let next: number | undefined
    if ((event.key === 'Enter' || event.key === ' ') && index >= 0) next = index
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = state.slideIndex + 1
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = state.slideIndex - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = pages.length - 1
    if (next === undefined) return
    event.preventDefault()
    event.stopPropagation()
    onSelectSlide(Math.max(0, Math.min(pages.length - 1, next)))
  }
  sidebar.addEventListener('click', click)
  document.addEventListener('keydown', keydown)
  update(state)

  const imagesReady = Array.from(document.images).map(async (image) => {
    if (image.complete) return
    if (typeof image.decode === 'function') {
      await image.decode().catch(() => undefined)
    } else {
      await new Promise<void>((resolve) => {
        image.addEventListener('load', () => resolve(), { once: true })
        image.addEventListener('error', () => resolve(), { once: true })
      })
    }
  })
  const fontReady = async (): Promise<void> => {
    const fonts = document.fonts
    if (!fonts) return
    const hasPrivateFace = Array.from(fonts).some(
      (face) => face.family.replace(/["']/g, '') === 'Dascowork Preview CJK'
    )
    if (hasPrivateFace) {
      let loaded: FontFace[]
      try {
        loaded = await fonts.load('16px "Dascowork Preview CJK"', '中文')
      } catch {
        throw new Error('演示文稿预览的中文字体无法加载。')
      }
      if (!loaded.length || loaded.some((face) => face.status !== 'loaded')) {
        throw new Error('演示文稿预览的中文字体无法加载。')
      }
    }
    await fonts.ready
  }
  const ready = Promise.all([fontReady(), ...imagesReady]).then(() => {
    if (disposed) return
    resize()
    document.body.dataset.previewReady = 'true'
  })
  return {
    update,
    resize,
    ready,
    dispose: () => {
      disposed = true
      sidebar.removeEventListener('click', click)
      document.removeEventListener('keydown', keydown)
    }
  }
}
