import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ImageOffIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
  XIcon
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  imageFileToDataUrl,
  useChatImageSource,
  chatImageSourceKey,
  type ChatImageDescriptor
} from './chatImageSource'
import {
  anchoredImageScroll,
  clampImageZoom,
  imageFitPercent,
  imageScrollBounds,
  nextImageZoom,
  wheelImageZoom,
  type ImageDimensions,
  type Point
} from './imagePreviewGeometry'

export interface ImagePreviewDialogProps {
  images: readonly ChatImageDescriptor[]
  initialIndex?: number
  trigger?: HTMLElement | null
  onClose: () => void
}

interface PreviewControls {
  zoomBy: (direction: -1 | 1) => void
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  )
}

export function ImagePreviewDialog({
  images,
  initialIndex = 0,
  trigger,
  onClose
}: ImagePreviewDialogProps): ReactElement {
  const [index, setIndex] = useState(Math.max(0, Math.min(images.length - 1, initialIndex)))
  const controlsRef = useRef<PreviewControls | null>(null)
  const image = images[index]
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-slot="image-preview-dialog"
        showCloseButton={false}
        aria-describedby={undefined}
        className="inset-0 top-0 left-0 flex h-dvh w-dvw max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-black/90 p-0 text-white shadow-none sm:max-w-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (trigger?.isConnected) trigger.focus()
        }}
        onKeyDown={(event) => {
          if (isEditable(event.target)) return
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            setIndex((value) => Math.max(0, value - 1))
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault()
            setIndex((value) => Math.min(images.length - 1, value + 1))
          }
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            controlsRef.current?.zoomBy(1)
          }
          if (event.key === '-') {
            event.preventDefault()
            controlsRef.current?.zoomBy(-1)
          }
        }}
      >
        <DialogTitle className="sr-only">图片预览</DialogTitle>
        <button
          type="button"
          aria-label="关闭图片预览"
          onClick={onClose}
          className="absolute top-3 right-3 z-20 rounded-full bg-black/60 p-2 hover:bg-white/20 focus-visible:outline-2"
        >
          <XIcon className="size-5" />
        </button>
        {images.length > 1 && (
          <>
            <button
              type="button"
              aria-label="上一张图片"
              disabled={index === 0}
              onClick={() => setIndex((value) => value - 1)}
              className="absolute top-1/2 left-3 z-20 rounded-full bg-black/60 p-2 disabled:opacity-30"
            >
              <ChevronLeftIcon className="size-6" />
            </button>
            <button
              type="button"
              aria-label="下一张图片"
              disabled={index === images.length - 1}
              onClick={() => setIndex((value) => value + 1)}
              className="absolute top-1/2 right-3 z-20 rounded-full bg-black/60 p-2 disabled:opacity-30"
            >
              <ChevronRightIcon className="size-6" />
            </button>
          </>
        )}
        {image && (
          <ActiveImagePreview
            key={`${image.id}:${chatImageSourceKey(image)}`}
            image={image}
            controlsRef={controlsRef}
            position={images.length > 1 ? `${index + 1} / ${images.length}` : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ActiveImagePreview({
  image,
  controlsRef,
  position
}: {
  image: ChatImageDescriptor
  controlsRef: React.RefObject<PreviewControls | null>
  position?: string
}): ReactElement {
  const source = useChatImageSource(image)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [natural, setNatural] = useState<ImageDimensions>({ width: 0, height: 0 })
  const [viewport, setViewport] = useState<ImageDimensions>({
    width: window.innerWidth,
    height: Math.max(1, window.innerHeight - 112)
  })
  const [zoom, setZoom] = useState({ percent: 100, fitting: true })
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const pendingScroll = useRef<Point | null>(null)
  const pointers = useRef(new Map<number, Point>())
  const mounted = useRef(true)
  const fit = imageFitPercent(natural, viewport)
  const percent = zoom.fitting ? fit : clampImageZoom(zoom.percent, fit)
  const loaded = natural.width > 0 && source.status === 'ready'

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = (): void =>
      setViewport({
        width: element.clientWidth || window.innerWidth,
        height: element.clientHeight || Math.max(1, window.innerHeight - 112)
      })
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const bounds = imageScrollBounds(natural, viewport, percent)
    const desired =
      pendingScroll.current ??
      (zoom.fitting ? { x: 0, y: 0 } : { x: element.scrollLeft, y: element.scrollTop })
    element.scrollLeft = Math.min(bounds.x, Math.max(0, desired.x))
    element.scrollTop = Math.min(bounds.y, Math.max(0, desired.y))
    pendingScroll.current = null
  }, [natural, viewport, percent, zoom.fitting])

  const changeZoom = useCallback(
    (next: number, anchor?: Point) => {
      const element = viewportRef.current
      if (!element || natural.width === 0) return
      const after = clampImageZoom(next, fit)
      pendingScroll.current = anchoredImageScroll({
        image: natural,
        viewport,
        before: percent,
        after,
        scroll: { x: element.scrollLeft, y: element.scrollTop },
        anchor: anchor ?? { x: viewport.width / 2, y: viewport.height / 2 }
      })
      setZoom({ percent: after, fitting: false })
    },
    [fit, natural, percent, viewport]
  )
  const zoomBy = useCallback(
    (direction: -1 | 1) => changeZoom(nextImageZoom(percent, fit, direction)),
    [changeZoom, fit, percent]
  )
  useLayoutEffect(() => {
    controlsRef.current = { zoomBy }
    return () => {
      controlsRef.current = null
    }
  }, [controlsRef, zoomBy])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const wheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || !loaded) return
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      changeZoom(wheelImageZoom(percent, event.deltaY, fit), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [changeZoom, fit, loaded, percent])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveMessage(null)
    try {
      const result = await window.desktopApp.codex.saveImage({
        source: image.file ? await imageFileToDataUrl(image.file) : image.source,
        sourceKind: image.file ? 'media-url' : image.sourceKind,
        conversationId: image.conversationId,
        threadId: image.threadId,
        fileName: image.file?.name || source.fileName
      })
      if (!mounted.current) return
      if (result.status === 'failed') setSaveMessage(result.message)
      else if (result.status === 'saved') setSaveMessage('图片已保存')
    } catch (error) {
      if (mounted.current) setSaveMessage(error instanceof Error ? error.message : '图片保存失败')
    } finally {
      if (mounted.current) setSaving(false)
    }
  }

  return (
    <>
      <div className="h-14 shrink-0 px-16 py-4 text-center text-sm text-white/80">
        {image.title || image.alt || source.fileName || '图片'}
        {position && <span className="ml-3 text-white/60">{position}</span>}
      </div>
      <div
        ref={viewportRef}
        data-slot="image-preview-viewport"
        className="min-h-0 flex-1 overflow-auto overscroll-contain"
        style={{ touchAction: 'none', cursor: loaded ? 'grab' : undefined }}
        onPointerDown={(event) => {
          if (!loaded || event.button !== 0) return
          event.preventDefault()
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId)
          if (!previous) return
          const oldPoints = [...pointers.current.values()]
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          const nextPoints = [...pointers.current.values()]
          if (nextPoints.length >= 2) {
            const oldDistance = Math.hypot(
              oldPoints[0].x - oldPoints[1].x,
              oldPoints[0].y - oldPoints[1].y
            )
            const nextDistance = Math.hypot(
              nextPoints[0].x - nextPoints[1].x,
              nextPoints[0].y - nextPoints[1].y
            )
            const rect = event.currentTarget.getBoundingClientRect()
            if (oldDistance > 0)
              changeZoom((percent * nextDistance) / oldDistance, {
                x: (nextPoints[0].x + nextPoints[1].x) / 2 - rect.left,
                y: (nextPoints[0].y + nextPoints[1].y) / 2 - rect.top
              })
          } else {
            const bounds = imageScrollBounds(natural, viewport, percent)
            event.currentTarget.scrollLeft = Math.min(
              bounds.x,
              Math.max(0, event.currentTarget.scrollLeft + previous.x - event.clientX)
            )
            event.currentTarget.scrollTop = Math.min(
              bounds.y,
              Math.max(0, event.currentTarget.scrollTop + previous.y - event.clientY)
            )
          }
        }}
        onPointerUp={(event) => pointers.current.delete(event.pointerId)}
        onPointerCancel={(event) => pointers.current.delete(event.pointerId)}
        onLostPointerCapture={(event) => pointers.current.delete(event.pointerId)}
      >
        <div
          className="flex items-center justify-center"
          style={{
            width: Math.max(viewport.width, (natural.width * percent) / 100),
            height: Math.max(viewport.height, (natural.height * percent) / 100)
          }}
        >
          {source.status === 'unavailable' ? (
            <div
              role="img"
              aria-label="图片不可用"
              className="flex items-center gap-2 text-white/70"
              title={source.reason}
            >
              <ImageOffIcon className="size-6" />
              {image.alt || '图片不可用'}
            </div>
          ) : source.displaySrc ? (
            <img
              data-slot="image-preview-image"
              src={source.displaySrc}
              alt={image.alt || ''}
              draggable={false}
              className="max-w-none shrink-0 object-contain"
              style={
                loaded
                  ? {
                      width: (natural.width * percent) / 100,
                      height: (natural.height * percent) / 100
                    }
                  : { maxWidth: viewport.width, maxHeight: viewport.height }
              }
              onLoad={(event) => {
                setNatural({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight
                })
                source.onLoad()
              }}
              onError={source.onError}
            />
          ) : (
            <LoaderCircleIcon className="size-6 animate-spin" aria-label="图片加载中" />
          )}
        </div>
      </div>
      <div className="relative flex h-14 shrink-0 items-center justify-center gap-3">
        <div className="flex items-center gap-1 rounded-full bg-white/15 px-2 py-1">
          <button
            type="button"
            aria-label="缩小图片"
            disabled={!loaded || percent <= Math.min(25, fit)}
            onClick={() => zoomBy(-1)}
            className="rounded-full p-2 disabled:opacity-30"
          >
            <MinusIcon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="适应窗口"
            data-slot="image-preview-zoom-percent"
            disabled={!loaded}
            onClick={() => setZoom({ percent: fit, fitting: true })}
            className="min-w-14 px-2 text-sm tabular-nums"
          >
            {Math.round(percent)}%
          </button>
          <button
            type="button"
            aria-label="放大图片"
            disabled={!loaded || percent >= 500}
            onClick={() => zoomBy(1)}
            className="rounded-full p-2 disabled:opacity-30"
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
        <button
          type="button"
          aria-label="保存图片"
          disabled={saving || !loaded}
          onClick={() => void save()}
          className="rounded-full bg-white/15 p-3 disabled:opacity-30"
        >
          {saving ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <DownloadIcon className="size-4" />
          )}
        </button>
        {saveMessage && (
          <span
            role="status"
            className="absolute right-3 bottom-2 max-w-[35%] text-xs text-white/80"
          >
            {saveMessage}
          </span>
        )}
      </div>
    </>
  )
}
