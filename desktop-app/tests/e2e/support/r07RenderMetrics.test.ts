import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'

import { appRoot, e2eTempRoot } from './app'
import { assertR07ChartLabelMetrics, measureR07RenderedSlide } from './r07RenderMetrics'

const fixtureDirectory = join(appRoot, 'tests', 'fixtures', 'presentations')
const chartLabelsMissingPath = join(fixtureDirectory, 'r07-chart-labels-missing.png')
const chartLabelsCompletePath = join(fixtureDirectory, 'r07-chart-labels-complete.png')

describe('R07 render metrics', () => {
  it('measures a real PNG and lets the R07 blank-slide threshold reject all-white output', async () => {
    const path = join(e2eTempRoot(), `r07-white-${process.pid}-${Date.now()}.png`)
    const canvas = createCanvas(960, 540)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 960, 540)
    await writeFile(path, canvas.toBuffer('image/png'))

    const metrics = await measureR07RenderedSlide(path)

    expect(metrics).toMatchObject({
      width: 960,
      height: 540,
      nonWhiteRatio: 0,
      colorBucketCount: 1
    })
    expect(metrics.nonWhiteRatio).not.toBeGreaterThan(0.01)
    expect(metrics.colorBucketCount).not.toBeGreaterThan(12)
  })

  it('rejects corrupt PNG bytes during decoding', async () => {
    const path = join(e2eTempRoot(), `r07-corrupt-${process.pid}-${Date.now()}.png`)
    await writeFile(path, Buffer.from('not a png'))

    await expect(measureR07RenderedSlide(path)).rejects.toThrow()
  })

  it('rejects a real chart preview with missing labels even though whole-slide render metrics pass', async () => {
    const metrics = await measureR07RenderedSlide(chartLabelsMissingPath, {
      includeChartLabelRatios: true
    })

    expect(metrics.nonWhiteRatio).toBeGreaterThan(0.01)
    expect(metrics.colorBucketCount).toBeGreaterThan(12)
    expect(metrics.chartLabelRatios).toMatchObject({
      category1: 0,
      legend: 0
    })
    expect(() => assertR07ChartLabelMetrics(metrics)).toThrow(/category1/u)
  })

  it('accepts a real chart preview with labels at native and 2x DPI sizes', async () => {
    const nativeMetrics = await measureR07RenderedSlide(chartLabelsCompletePath, {
      includeChartLabelRatios: true
    })
    expect(() => assertR07ChartLabelMetrics(nativeMetrics)).not.toThrow()

    const scaledPath = join(e2eTempRoot(), `r07-chart-labels-2x-${process.pid}-${Date.now()}.png`)
    await writeFile(scaledPath, await scaledPng(chartLabelsCompletePath, 2))
    const scaledMetrics = await measureR07RenderedSlide(scaledPath, {
      includeChartLabelRatios: true
    })
    expect(() => assertR07ChartLabelMetrics(scaledMetrics)).not.toThrow()
  })
})

async function scaledPng(path: string, scale: number): Promise<Buffer> {
  const image = await loadImage(await readFile(path))
  const canvas = createCanvas(image.width * scale, image.height * scale)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = false
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toBuffer('image/png')
}
