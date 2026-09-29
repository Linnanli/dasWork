import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import annotationStyles from './PresentationPanel.css?raw'
import viewStyles from './PresentationHtmlView.css?raw'
import {
  createPresentationHtmlController,
  sanitizePresentationHtml,
  type PresentationHtmlController,
  type PresentationHtmlViewState
} from './presentationHtml'

interface PresentationHtmlViewProps extends PresentationHtmlViewState {
  html: string
  onSelectSlide(index: number): void
  overlay: ReactNode
  onError?(message: string): void
}

const themeProperties = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--ring'
]

export function PresentationHtmlView({
  html,
  slideIndex,
  zoom,
  layout,
  railOpen,
  toolbarHeight,
  onSelectSlide,
  overlay,
  onError
}: PresentationHtmlViewProps): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const controller = useRef<PresentationHtmlController | undefined>(undefined)
  const activeDocument = useRef<Document | undefined>(undefined)
  const state = useRef({ slideIndex, zoom, layout, railOpen, toolbarHeight })
  const callbacks = useRef({ onSelectSlide, onError })
  const [portalTarget, setPortalTarget] = useState<{ element: HTMLElement; source: string }>()
  const source = useMemo(() => {
    try {
      return { html: sanitizePresentationHtml(html, [annotationStyles, viewStyles]) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : '演示文稿网页预览无法加载。' }
    }
  }, [html])

  const copyTheme = useCallback(() => {
    const element = frame.current
    const child = element?.contentDocument
    if (!element || !child) return
    const computed = getComputedStyle(element)
    for (const property of themeProperties) {
      child.documentElement.style.setProperty(property, computed.getPropertyValue(property))
    }
    child.documentElement.style.colorScheme = computed.colorScheme
    child.body.style.fontFamily = computed.fontFamily
  }, [])

  const loaded = useCallback(() => {
    const child = frame.current?.contentDocument
    const previewSource = source.html
    if (!child || !previewSource) return
    if (activeDocument.current === child && controller.current) {
      copyTheme()
      controller.current.update(state.current)
      return
    }
    controller.current?.dispose()
    controller.current = undefined
    activeDocument.current = undefined
    try {
      copyTheme()
      const next = createPresentationHtmlController(
        child,
        (index) => callbacks.current.onSelectSlide(index),
        (element) => setPortalTarget({ element, source: previewSource })
      )
      controller.current = next
      activeDocument.current = child
      next.update(state.current)
      void next.ready.catch((error: unknown) => {
        if (controller.current !== next) return
        callbacks.current.onError?.(
          error instanceof Error ? error.message : '演示文稿网页预览无法完成加载。'
        )
      })
    } catch (error) {
      setPortalTarget(undefined)
      callbacks.current.onError?.(
        error instanceof Error ? error.message : '演示文稿网页预览无法初始化。'
      )
    }
  }, [source.html, copyTheme])

  useEffect(() => {
    if (source.error) callbacks.current.onError?.(source.error)
    return () => {
      controller.current?.dispose()
      controller.current = undefined
      activeDocument.current = undefined
    }
  }, [source])

  useLayoutEffect(() => {
    state.current = { slideIndex, zoom, layout, railOpen, toolbarHeight }
    callbacks.current = { onSelectSlide, onError }
    controller.current?.update(state.current)
  }, [slideIndex, zoom, layout, railOpen, toolbarHeight, onSelectSlide, onError])

  useEffect(() => {
    const element = frame.current
    if (!element) return
    const resize =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => controller.current?.resize())
    resize?.observe(element)
    const theme = new MutationObserver(copyTheme)
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    })
    theme.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    })
    return () => {
      resize?.disconnect()
      theme.disconnect()
    }
  }, [copyTheme, source.html])

  return (
    <>
      <iframe
        ref={frame}
        className="presentation-html-frame"
        title="演示文稿网页预览"
        sandbox="allow-same-origin"
        srcDoc={source.html ?? ''}
        onLoad={loaded}
        style={{ display: 'block', width: '100%', height: '100%', minHeight: 0, border: 0 }}
      />
      {portalTarget && portalTarget.source === source.html
        ? createPortal(overlay, portalTarget.element)
        : null}
    </>
  )
}
