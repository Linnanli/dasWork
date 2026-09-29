import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
  MinusIcon,
  RotateCcwIcon,
  ScanIcon,
  PlusIcon,
  MessageSquarePlusIcon
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  ArtifactAnnotation,
  ArtifactAnnotationTarget
} from '../annotations/artifactAnnotationTypes'
import type { ArtifactNavigationTarget } from '../../workspace-container/workspaceOpenTargets'
import type {
  PresentationDocument,
  PresentationElement,
  PresentationSlide
} from './presentationTypes'

import './PresentationPanel.css'
import { PresentationHtmlView } from './PresentationHtmlView'

type Props = {
  document: PresentationDocument
  renderedSlides?: readonly string[]
  html?: string
  onPreviewError?(message: string): void
  navigation?: ArtifactNavigationTarget
  onOpenHyperlink?(url: string): void
  onSelectElement?(slide: PresentationSlide, element: PresentationElement): void
  annotations?: readonly ArtifactAnnotation[]
  onRequestAnnotation?(target: ArtifactAnnotationTarget): void
}

export function PresentationPanel({
  document,
  renderedSlides = [],
  html,
  onPreviewError,
  navigation,
  onOpenHyperlink,
  onSelectElement,
  annotations = [],
  onRequestAnnotation
}: Props): React.JSX.Element {
  const initialNavigation = navigation ? navigationLocation(document, navigation) : undefined
  const [requestedSlideIndex, setRequestedSlideIndex] = useState(
    () => initialNavigation?.slideIndex ?? 0
  )
  const [zoom, setZoom] = useState(100)
  const [railOpen, setRailOpen] = useState(false)
  const [regionSelection, setRegionSelection] = useState(false)
  const [highlightedObjectId, setHighlightedObjectId] = useState(initialNavigation?.objectId)
  const panelRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [toolbarHeight, setToolbarHeight] = useState(44)
  const [panelWidth, setPanelWidth] = useState(0)
  const selectedSlideIndex = Math.max(
    0,
    Math.min(requestedSlideIndex, Math.max(0, document.slides.length - 1))
  )
  const slide = document.slides[selectedSlideIndex] ?? document.slides[0]

  useEffect(() => {
    if (!highlightedObjectId) return
    const timer = window.setTimeout(() => setHighlightedObjectId(undefined), 2_000)
    return () => window.clearTimeout(timer)
  }, [highlightedObjectId])
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setPanelWidth(entry?.contentRect.width ?? 0))
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) =>
      setToolbarHeight(entry?.borderBoxSize?.[0]?.blockSize ?? toolbar.offsetHeight)
    )
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [])

  const layout = panelWidth <= 688 ? 'stacked' : panelWidth <= 748 ? 'floating' : 'rail'
  const canGoPrevious = selectedSlideIndex > 0
  const canGoNext = selectedSlideIndex < document.slides.length - 1
  const selectSlide = (index: number): void => {
    setRequestedSlideIndex(Math.max(0, Math.min(index, document.slides.length - 1)))
    setHighlightedObjectId(undefined)
  }

  return (
    <div
      ref={panelRef}
      data-slot="presentation-panel"
      data-presentation-layout={layout}
      className={cn(
        'presentation-panel',
        layout === 'stacked' && 'presentation-panel-stacked',
        html && 'presentation-panel-html'
      )}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && canGoPrevious) {
          event.preventDefault()
          selectSlide(selectedSlideIndex - 1)
        }
        if (event.key === 'ArrowRight' && canGoNext) {
          event.preventDefault()
          selectSlide(selectedSlideIndex + 1)
        }
      }}
    >
      {!html ? (
        <div
          className={cn('presentation-rail-wrap', layout === 'floating' && !railOpen && 'hidden')}
        >
          <SlideRail
            slides={document.slides}
            renderedSlides={renderedSlides}
            selectedIndex={selectedSlideIndex}
            onSelect={selectSlide}
          />
        </div>
      ) : null}
      {layout === 'floating' ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="presentation-rail-toggle"
          aria-label={railOpen ? '收起幻灯片列表' : '展开幻灯片列表'}
          onClick={() => setRailOpen((current) => !current)}
        >
          <ListIcon className="size-4" />
          幻灯片
        </Button>
      ) : null}
      <main className={html ? 'presentation-html-controls' : 'presentation-main'}>
        <div ref={toolbarRef} className="presentation-toolbar" aria-label="演示文稿控制">
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="上一页"
              disabled={!canGoPrevious}
              onClick={() => selectSlide(selectedSlideIndex - 1)}
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <span className="min-w-20 text-center text-xs text-muted-foreground" aria-live="polite">
              {slide ? `${slide.number} / ${document.slides.length}` : '0 / 0'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="下一页"
              disabled={!canGoNext}
              onClick={() => selectSlide(selectedSlideIndex + 1)}
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="缩小"
              disabled={zoom <= 50}
              onClick={() => setZoom((value) => Math.max(50, value - 10))}
            >
              <MinusIcon className="size-4" />
            </Button>
            <span className="min-w-10 text-center text-xs text-muted-foreground">{zoom}%</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="放大"
              disabled={zoom >= 200}
              onClick={() => setZoom((value) => Math.min(200, value + 10))}
            >
              <PlusIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="重置缩放"
              onClick={() => setZoom(100)}
            >
              <RotateCcwIcon className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="适应窗口"
              onClick={() => setZoom(100)}
            >
              <ScanIcon className="size-4" />
            </Button>
            {onRequestAnnotation && slide ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="为当前页添加批注"
                  onClick={() => onRequestAnnotation({ kind: 'slide', slideId: slide.id })}
                >
                  <MessageSquarePlusIcon className="size-4" />
                  批注
                </Button>
                <Button
                  type="button"
                  variant={regionSelection ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-label="选择区域批注"
                  aria-pressed={regionSelection}
                  onClick={() => setRegionSelection((current) => !current)}
                >
                  区域
                </Button>
              </>
            ) : null}
          </div>
        </div>
        {!html && slide ? (
          <div className="presentation-stage-scroll">
            <SlideCanvas
              key={slide.id}
              slide={slide}
              imageSrc={renderedSlides[selectedSlideIndex]}
              aspectRatio={document.width / document.height}
              zoom={zoom}
              highlightedObjectId={highlightedObjectId}
              onOpenHyperlink={onOpenHyperlink}
              onSelectElement={onSelectElement}
              annotations={annotations.filter(
                (annotation) => annotation.target.slideId === slide.id
              )}
              onRequestAnnotation={onRequestAnnotation}
              regionSelection={regionSelection}
              onRegionSelectionDone={() => setRegionSelection(false)}
            />
          </div>
        ) : !html ? (
          <p className="m-auto text-sm text-muted-foreground">演示文稿没有可显示的幻灯片。</p>
        ) : null}
      </main>
      {html ? (
        <PresentationHtmlView
          html={html}
          slideIndex={selectedSlideIndex}
          zoom={zoom}
          layout={layout}
          railOpen={railOpen}
          toolbarHeight={toolbarHeight}
          onSelectSlide={selectSlide}
          onError={onPreviewError}
          overlay={
            slide ? (
              <SlideCanvas
                key={slide.id}
                slide={slide}
                imageSrc={undefined}
                aspectRatio={document.width / document.height}
                zoom={100}
                overlayOnly
                highlightedObjectId={highlightedObjectId}
                onOpenHyperlink={onOpenHyperlink}
                onSelectElement={onSelectElement}
                annotations={annotations.filter(
                  (annotation) => annotation.target.slideId === slide.id
                )}
                onRequestAnnotation={onRequestAnnotation}
                regionSelection={regionSelection}
                onRegionSelectionDone={() => setRegionSelection(false)}
              />
            ) : null
          }
        />
      ) : null}
    </div>
  )
}

function SlideRail({
  slides,
  renderedSlides,
  selectedIndex,
  onSelect
}: {
  slides: readonly PresentationSlide[]
  renderedSlides: readonly string[]
  selectedIndex: number
  onSelect(index: number): void
}): React.JSX.Element {
  return (
    <nav className="presentation-rail" aria-label="幻灯片列表">
      {slides.map((slide, index) => (
        <button
          key={slide.id}
          type="button"
          className={cn('presentation-thumbnail', index === selectedIndex && 'selected')}
          aria-label={`第 ${slide.number} 页`}
          aria-current={index === selectedIndex ? 'page' : undefined}
          onClick={() => onSelect(index)}
        >
          <span className="presentation-thumbnail-canvas" aria-hidden="true">
            <img src={renderedSlides[index]} alt="" draggable={false} />
          </span>
          <span>{slide.number}</span>
        </button>
      ))}
    </nav>
  )
}

function SlideCanvas({
  slide,
  imageSrc,
  aspectRatio,
  zoom,
  highlightedObjectId,
  onOpenHyperlink,
  onSelectElement,
  annotations,
  onRequestAnnotation,
  regionSelection,
  overlayOnly = false,
  onRegionSelectionDone
}: {
  slide: PresentationSlide
  imageSrc: string | undefined
  aspectRatio: number
  zoom: number
  highlightedObjectId?: string
  onOpenHyperlink?(url: string): void
  onSelectElement?(slide: PresentationSlide, element: PresentationElement): void
  annotations: readonly ArtifactAnnotation[]
  onRequestAnnotation?(target: ArtifactAnnotationTarget): void
  regionSelection: boolean
  overlayOnly?: boolean
  onRegionSelectionDone(): void
}): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const [regionStart, setRegionStart] = useState<{ x: number; y: number }>()
  const [regionEnd, setRegionEnd] = useState<{ x: number; y: number }>()
  const activeRegion = useRef<
    | {
        pointerId: number
        start: { x: number; y: number }
      }
    | undefined
  >(undefined)
  const regionCallbacks = useRef({ onRequestAnnotation, onRegionSelectionDone })
  useLayoutEffect(() => {
    regionCallbacks.current = { onRequestAnnotation, onRegionSelectionDone }
  }, [onRequestAnnotation, onRegionSelectionDone])

  // Native pointer capture in an iframe can stall Electron's mouse routing.
  // Track the drag in both documents instead, including release outside the frame.
  useEffect(() => {
    const stage = stageRef.current
    if (!overlayOnly || !stage) return
    const childDocument = stage.ownerDocument
    const frameElement = childDocument.defaultView?.frameElement
    const parentDocument = frameElement?.ownerDocument
    const point = (event: PointerEvent, inParent: boolean): { x: number; y: number } => {
      const rect = stage.getBoundingClientRect()
      const frame = inParent ? frameElement?.getBoundingClientRect() : undefined
      return {
        x: Math.max(0, Math.min(1, (event.clientX - (frame?.left ?? 0) - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - (frame?.top ?? 0) - rect.top) / rect.height))
      }
    }
    const clear = (): void => {
      activeRegion.current = undefined
      setRegionStart(undefined)
      setRegionEnd(undefined)
      regionCallbacks.current.onRegionSelectionDone()
    }
    const move = (event: PointerEvent, inParent: boolean): void => {
      const region = activeRegion.current
      if (!region || event.pointerId !== region.pointerId) return
      setRegionEnd(point(event, inParent))
    }
    const finish = (event: PointerEvent, inParent: boolean): void => {
      const region = activeRegion.current
      if (!region || event.pointerId !== region.pointerId) return
      const end = point(event, inParent)
      const x = Math.min(region.start.x, end.x)
      const y = Math.min(region.start.y, end.y)
      const width = Math.abs(region.start.x - end.x)
      const height = Math.abs(region.start.y - end.y)
      clear()
      if (width >= 0.02 && height >= 0.02) {
        regionCallbacks.current.onRequestAnnotation?.({
          kind: 'region',
          slideId: slide.id,
          x,
          y,
          width,
          height
        })
      }
    }
    const cancel = (): void => {
      if (activeRegion.current) clear()
    }
    const childMove = (event: PointerEvent): void => move(event, false)
    const childUp = (event: PointerEvent): void => finish(event, false)
    const parentMove = (event: PointerEvent): void => move(event, true)
    const parentUp = (event: PointerEvent): void => finish(event, true)
    childDocument.addEventListener('pointermove', childMove)
    childDocument.addEventListener('pointerup', childUp)
    childDocument.addEventListener('pointercancel', cancel)
    parentDocument?.addEventListener('pointermove', parentMove)
    parentDocument?.addEventListener('pointerup', parentUp)
    parentDocument?.addEventListener('pointercancel', cancel)
    const topWindow = parentDocument?.defaultView ?? childDocument.defaultView
    const blur = (): void => {
      // Focusing the iframe can blur the parent window while the app still has focus.
      if (!topWindow?.document.hasFocus()) cancel()
    }
    topWindow?.addEventListener('blur', blur)
    return () => {
      childDocument.removeEventListener('pointermove', childMove)
      childDocument.removeEventListener('pointerup', childUp)
      childDocument.removeEventListener('pointercancel', cancel)
      parentDocument?.removeEventListener('pointermove', parentMove)
      parentDocument?.removeEventListener('pointerup', parentUp)
      parentDocument?.removeEventListener('pointercancel', cancel)
      topWindow?.removeEventListener('blur', blur)
      activeRegion.current = undefined
    }
  }, [overlayOnly, slide.id])

  const normalizedPoint = (event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    }
  }
  const finishRegion = (): void => {
    if (!regionStart || !regionEnd) return
    const x = Math.min(regionStart.x, regionEnd.x)
    const y = Math.min(regionStart.y, regionEnd.y)
    const width = Math.abs(regionStart.x - regionEnd.x)
    const height = Math.abs(regionStart.y - regionEnd.y)
    setRegionStart(undefined)
    setRegionEnd(undefined)
    onRegionSelectionDone()
    if (width < 0.02 || height < 0.02) return
    onRequestAnnotation?.({ kind: 'region', slideId: slide.id, x, y, width, height })
  }
  return (
    <div
      ref={stageRef}
      className={cn(
        'presentation-stage',
        overlayOnly && 'presentation-stage-overlay',
        regionSelection && 'presentation-stage-selecting-region'
      )}
      style={overlayOnly ? undefined : { width: `${zoom}%`, aspectRatio }}
      aria-label={`第 ${slide.number} 张幻灯片`}
      onPointerDown={(event) => {
        if (!regionSelection || event.target !== event.currentTarget) return
        const point = normalizedPoint(event)
        if (overlayOnly) {
          activeRegion.current = { pointerId: event.pointerId, start: point }
        } else {
          event.currentTarget.setPointerCapture(event.pointerId)
        }
        setRegionStart(point)
        setRegionEnd(point)
      }}
      onPointerMove={(event) => {
        if (!overlayOnly && regionStart) setRegionEnd(normalizedPoint(event))
      }}
      onPointerUp={overlayOnly ? undefined : finishRegion}
    >
      {imageSrc ? (
        <img
          className="presentation-stage-image"
          src={imageSrc}
          alt={`${slide.name}预览`}
          draggable={false}
        />
      ) : null}
      {slide.elements.map((element) => {
        return (
          <button
            key={element.id}
            type="button"
            className={cn(
              'presentation-element',
              `presentation-element-${element.kind}`,
              highlightedObjectId === element.id && 'highlighted'
            )}
            style={{
              left: `${element.frame.x * 100}%`,
              top: `${element.frame.y * 100}%`,
              width: `${element.frame.width * 100}%`,
              height: `${element.frame.height * 100}%`
            }}
            aria-label={element.hyperlink ? `${element.name}，打开链接` : element.name}
            onClick={() => {
              if (element.hyperlink) onOpenHyperlink?.(element.hyperlink)
              onSelectElement?.(slide, element)
              if (!element.hyperlink) {
                onRequestAnnotation?.({ kind: 'element', slideId: slide.id, objectId: element.id })
              }
            }}
          ></button>
        )
      })}
      {annotations.map((annotation, index) => {
        const frame = annotationFrame(annotation, slide)
        return frame ? (
          <span
            key={annotation.id}
            className="presentation-annotation-marker"
            style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%` }}
            aria-label={`批注 ${index + 1}`}
            title={annotation.body}
          >
            {index + 1}
          </span>
        ) : null
      })}
      {regionStart && regionEnd ? (
        <span
          aria-hidden="true"
          className="presentation-region-selection"
          style={{
            left: `${Math.min(regionStart.x, regionEnd.x) * 100}%`,
            top: `${Math.min(regionStart.y, regionEnd.y) * 100}%`,
            width: `${Math.abs(regionStart.x - regionEnd.x) * 100}%`,
            height: `${Math.abs(regionStart.y - regionEnd.y) * 100}%`
          }}
        />
      ) : null}
    </div>
  )
}

function annotationFrame(
  annotation: ArtifactAnnotation,
  slide: PresentationSlide
): PresentationElement['frame'] | undefined {
  const target = annotation.target
  switch (target.kind) {
    case 'slide':
      return { x: 0.01, y: 0.01, width: 0, height: 0 }
    case 'region':
      return target
    case 'element':
      return slide.elements.find((element) => element.id === target.objectId)?.frame
  }
}

function navigationLocation(
  document: PresentationDocument,
  target: ArtifactNavigationTarget
): { slideIndex: number; objectId?: string } | undefined {
  if (target.slideId) {
    const slideIndex = document.slides.findIndex((slide) => slide.id === target.slideId)
    if (slideIndex >= 0) return { slideIndex, objectId: target.objectId }
  }
  if (target.slideNumber) {
    const slideIndex = document.slides.findIndex((slide) => slide.number === target.slideNumber)
    if (slideIndex >= 0) return { slideIndex, objectId: target.objectId }
  }
  if (target.objectId) {
    const slideIndex = document.slides.findIndex((slide) =>
      slide.elements.some((element) => element.id === target.objectId)
    )
    if (slideIndex >= 0) return { slideIndex, objectId: target.objectId }
  }
  return undefined
}
