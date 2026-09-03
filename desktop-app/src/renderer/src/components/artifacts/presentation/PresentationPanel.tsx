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
import { useEffect, useRef, useState } from 'react'

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

type Props = {
  document: PresentationDocument
  navigation?: ArtifactNavigationTarget
  onOpenHyperlink?(url: string): void
  onSelectElement?(slide: PresentationSlide, element: PresentationElement): void
  annotations?: readonly ArtifactAnnotation[]
  onRequestAnnotation?(target: ArtifactAnnotationTarget): void
}

export function PresentationPanel({
  document,
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
      className={cn('presentation-panel', layout === 'stacked' && 'presentation-panel-stacked')}
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
      <div className={cn('presentation-rail-wrap', layout === 'floating' && !railOpen && 'hidden')}>
        <SlideRail
          slides={document.slides}
          selectedIndex={selectedSlideIndex}
          onSelect={selectSlide}
        />
      </div>
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
      <main className="presentation-main">
        <div className="presentation-toolbar" aria-label="演示文稿控制">
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
        {slide ? (
          <div className="presentation-stage-scroll">
            <SlideCanvas
              slide={slide}
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
        ) : (
          <p className="m-auto text-sm text-muted-foreground">演示文稿没有可显示的幻灯片。</p>
        )}
      </main>
    </div>
  )
}

function SlideRail({
  slides,
  selectedIndex,
  onSelect
}: {
  slides: readonly PresentationSlide[]
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
            {slide.elements.slice(0, 5).map((element) => (
              <span
                key={element.id}
                className="presentation-thumbnail-line"
                style={{
                  top: `${element.frame.y * 100}%`,
                  left: `${element.frame.x * 100}%`,
                  width: `${Math.max(element.frame.width * 100, 8)}%`
                }}
              />
            ))}
          </span>
          <span>{slide.number}</span>
        </button>
      ))}
    </nav>
  )
}

function SlideCanvas({
  slide,
  zoom,
  highlightedObjectId,
  onOpenHyperlink,
  onSelectElement,
  annotations,
  onRequestAnnotation,
  regionSelection,
  onRegionSelectionDone
}: {
  slide: PresentationSlide
  zoom: number
  highlightedObjectId?: string
  onOpenHyperlink?(url: string): void
  onSelectElement?(slide: PresentationSlide, element: PresentationElement): void
  annotations: readonly ArtifactAnnotation[]
  onRequestAnnotation?(target: ArtifactAnnotationTarget): void
  regionSelection: boolean
  onRegionSelectionDone(): void
}): React.JSX.Element {
  const [regionStart, setRegionStart] = useState<{ x: number; y: number }>()
  const [regionEnd, setRegionEnd] = useState<{ x: number; y: number }>()
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
      className={cn('presentation-stage', regionSelection && 'presentation-stage-selecting-region')}
      style={{ width: `${zoom}%` }}
      aria-label={`第 ${slide.number} 张幻灯片`}
      onPointerDown={(event) => {
        if (!regionSelection || event.target !== event.currentTarget) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const point = normalizedPoint(event)
        setRegionStart(point)
        setRegionEnd(point)
      }}
      onPointerMove={(event) => {
        if (regionStart) setRegionEnd(normalizedPoint(event))
      }}
      onPointerUp={finishRegion}
    >
      {slide.elements.map((element) => {
        const content =
          element.kind === 'image' && element.imageDataUrl ? (
            <img src={element.imageDataUrl} alt={element.name} draggable={false} />
          ) : element.kind === 'chart' ? (
            <span className="presentation-chart-placeholder">{element.text ?? '图表'}</span>
          ) : (
            <span>{element.text}</span>
          )
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
              height: `${element.frame.height * 100}%`,
              ...(element.fill ? { backgroundColor: element.fill } : {}),
              ...(element.color ? { color: element.color } : {})
            }}
            aria-label={element.hyperlink ? `${element.name}，打开链接` : element.name}
            onClick={() => {
              if (element.hyperlink) onOpenHyperlink?.(element.hyperlink)
              onSelectElement?.(slide, element)
              if (!element.hyperlink) {
                onRequestAnnotation?.({ kind: 'element', slideId: slide.id, objectId: element.id })
              }
            }}
          >
            {content}
          </button>
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
