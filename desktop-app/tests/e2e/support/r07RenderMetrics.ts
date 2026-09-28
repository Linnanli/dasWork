import { readFile } from 'node:fs/promises'

import { createCanvas, loadImage } from '@napi-rs/canvas'

export type R07SlideMetrics = {
  width: number
  height: number
  nonWhiteRatio: number
  colorBucketCount: number
  chartLabelRatios?: R07ChartLabelRatios
}

export type R07ChartLabelRatios = {
  category1: number
  category2: number
  legend: number
}

export type R07RenderMetricOptions = {
  includeChartLabelRatios?: boolean
}

const r07ChartLabelRegions: Record<
  keyof R07ChartLabelRatios,
  readonly [number, number, number, number]
> = {
  category1: [0.15, 0.692, 0.36, 0.721],
  category2: [0.45, 0.692, 0.63, 0.721],
  legend: [0.36, 0.72, 0.43, 0.742]
}

const r07ChartLabelMinimums: R07ChartLabelRatios = {
  category1: 0.003,
  category2: 0.003,
  legend: 0.001
}

export async function measureR07RenderedSlide(
  path: string,
  options: R07RenderMetricOptions = {}
): Promise<R07SlideMetrics> {
  const image = await loadImage(await readFile(path))
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, image.width, image.height)
  const buckets = new Set<string>()
  let nonWhite = 0
  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    if (red < 245 || green < 245 || blue < 245) nonWhite += 1
    buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`)
  }
  return {
    width: image.width,
    height: image.height,
    nonWhiteRatio: nonWhite / (image.width * image.height),
    colorBucketCount: buckets.size,
    ...(options.includeChartLabelRatios
      ? { chartLabelRatios: measureR07ChartLabelRatios(data, image.width, image.height) }
      : {})
  }
}

export function assertR07ChartLabelMetrics(metrics: R07SlideMetrics): void {
  const ratios = metrics.chartLabelRatios
  if (!ratios) throw new Error('R07 chart label metrics were not measured.')
  for (const key of Object.keys(r07ChartLabelMinimums) as Array<keyof R07ChartLabelRatios>) {
    const ratio = ratios[key]
    const minimum = r07ChartLabelMinimums[key]
    if (ratio <= minimum) {
      throw new Error(
        `R07 chart label region ${key} has too few dark text pixels: ${ratio} <= ${minimum}.`
      )
    }
  }
}

function measureR07ChartLabelRatios(
  data: Uint8ClampedArray,
  width: number,
  height: number
): R07ChartLabelRatios {
  return {
    category1: measureDarkPixelRatio(data, width, height, r07ChartLabelRegions.category1),
    category2: measureDarkPixelRatio(data, width, height, r07ChartLabelRegions.category2),
    legend: measureDarkPixelRatio(data, width, height, r07ChartLabelRegions.legend)
  }
}

function measureDarkPixelRatio(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: readonly [number, number, number, number]
): number {
  const left = Math.max(0, Math.floor(region[0] * width))
  const top = Math.max(0, Math.floor(region[1] * height))
  const right = Math.min(width, Math.ceil(region[2] * width))
  const bottom = Math.min(height, Math.ceil(region[3] * height))
  let dark = 0
  let total = 0
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * width + x) * 4
      const alpha = data[offset + 3] ?? 0
      const red = data[offset] ?? 0
      const green = data[offset + 1] ?? 0
      const blue = data[offset + 2] ?? 0
      total += 1
      if (alpha > 128 && red < 80 && green < 80 && blue < 80) dark += 1
    }
  }
  return total === 0 ? 0 : dark / total
}
