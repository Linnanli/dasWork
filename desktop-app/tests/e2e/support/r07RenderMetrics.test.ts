import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'

import { e2eTempRoot } from './app'
import { measureR07RenderedSlide } from './r07RenderMetrics'

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
})
