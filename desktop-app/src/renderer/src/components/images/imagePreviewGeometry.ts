export interface ImageDimensions {
  width: number
  height: number
}
export interface Point {
  x: number
  y: number
}
export const IMAGE_ZOOM_STOPS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
]

export function imageFitPercent(image: ImageDimensions, viewport: ImageDimensions): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0)
    return 100
  return Math.min(1, viewport.width / image.width, viewport.height / image.height) * 100
}

export function clampImageZoom(percent: number, fit: number): number {
  return Math.min(500, Math.max(Math.min(25, fit), percent))
}

export function imageZoomStops(fit: number): number[] {
  return [...new Set([...IMAGE_ZOOM_STOPS, fit])].sort((a, b) => a - b)
}

export function nextImageZoom(percent: number, fit: number, direction: -1 | 1): number {
  const stops = imageZoomStops(fit)
  return direction === 1
    ? (stops.find((stop) => stop > percent + 0.001) ?? 500)
    : ([...stops].reverse().find((stop) => stop < percent - 0.001) ?? Math.min(25, fit))
}

export function wheelImageZoom(percent: number, deltaY: number, fit: number): number {
  return clampImageZoom(percent * Math.exp(-deltaY / 200), fit)
}

export function imageScrollBounds(
  image: ImageDimensions,
  viewport: ImageDimensions,
  zoom: number
): Point {
  return {
    x: Math.max(0, (image.width * zoom) / 100 - viewport.width),
    y: Math.max(0, (image.height * zoom) / 100 - viewport.height)
  }
}

/** Preserve the image coordinate under the pointer, including centered small images. */
export function anchoredImageScroll(input: {
  image: ImageDimensions
  viewport: ImageDimensions
  before: number
  after: number
  scroll: Point
  anchor: Point
}): Point {
  const { image, viewport, before, after, scroll, anchor } = input
  const ratio = after / before
  const bounds = imageScrollBounds(image, viewport, after)
  const axis = (
    natural: number,
    available: number,
    previous: number,
    pointer: number,
    max: number
  ): number => {
    const oldOffset = Math.max(0, (available - (natural * before) / 100) / 2)
    const newOffset = Math.max(0, (available - (natural * after) / 100) / 2)
    return Math.min(
      max,
      Math.max(0, (previous + pointer - oldOffset) * ratio + newOffset - pointer)
    )
  }
  return {
    x: axis(image.width, viewport.width, scroll.x, anchor.x, bounds.x),
    y: axis(image.height, viewport.height, scroll.y, anchor.y, bounds.y)
  }
}
