import { describe, expect, it } from 'vitest'
import {
  anchoredImageScroll,
  clampImageZoom,
  imageFitPercent,
  imageScrollBounds,
  imageZoomStops,
  nextImageZoom,
  wheelImageZoom
} from './imagePreviewGeometry'

describe('image preview geometry', () => {
  it('fits to both axes without enlarging the original image', () => {
    expect(imageFitPercent({ width: 3000, height: 2000 }, { width: 900, height: 500 })).toBe(25)
    expect(imageFitPercent({ width: 200, height: 100 }, { width: 900, height: 500 })).toBe(100)
  })

  it('inserts small and fractional fit values into the reference zoom stops', () => {
    const fit = 12.5
    expect(imageZoomStops(fit)).toEqual([
      12.5, 25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
    ])
    expect(nextImageZoom(fit, fit, 1)).toBe(25)
    expect(nextImageZoom(25, fit, -1)).toBe(fit)
    expect(imageZoomStops(33).filter((stop) => stop === 33)).toHaveLength(1)
  })

  it('respects fit-dependent minimum and 500% maximum for buttons and wheel', () => {
    expect(clampImageZoom(1, 12)).toBe(12)
    expect(clampImageZoom(1, 75)).toBe(25)
    expect(nextImageZoom(500, 75, 1)).toBe(500)
    expect(wheelImageZoom(100, -200, 30)).toBeCloseTo(100 * Math.E)
    expect(wheelImageZoom(400, -2000, 30)).toBe(500)
    expect(wheelImageZoom(100, 2000, 10)).toBe(10)
  })

  it('preserves a pointer image coordinate to sub-pixel precision', () => {
    const image = { width: 2000, height: 1500 }
    const viewport = { width: 800, height: 600 }
    const scroll = { x: 250, y: 100 }
    const anchor = { x: 300, y: 250 }
    const after = anchoredImageScroll({ image, viewport, before: 100, after: 175, scroll, anchor })
    expect((after.x + anchor.x) / 1.75).toBeCloseTo(scroll.x + anchor.x, 8)
    expect((after.y + anchor.y) / 1.75).toBeCloseTo(scroll.y + anchor.y, 8)
  })

  it('accounts for centered images when zooming from fit to overflow', () => {
    const next = anchoredImageScroll({
      image: { width: 1000, height: 1000 },
      viewport: { width: 800, height: 600 },
      before: 50,
      after: 100,
      scroll: { x: 0, y: 0 },
      anchor: { x: 400, y: 300 }
    })
    expect(next).toEqual({ x: 100, y: 200 })
  })

  it('clamps anchor corrections to the accessible image edges', () => {
    const image = { width: 1000, height: 1000 }
    const viewport = { width: 800, height: 600 }
    const next = anchoredImageScroll({
      image,
      viewport,
      before: 100,
      after: 25,
      scroll: { x: 200, y: 400 },
      anchor: { x: 750, y: 550 }
    })
    expect(next).toEqual({ x: 0, y: 0 })
    expect(imageScrollBounds(image, viewport, 200)).toEqual({ x: 1200, y: 1400 })
  })
})
