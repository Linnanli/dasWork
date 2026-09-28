import { readFile } from 'node:fs/promises'

import { createCanvas, loadImage } from '@napi-rs/canvas'

export type R07SlideMetrics = {
  width: number
  height: number
  nonWhiteRatio: number
  colorBucketCount: number
}

export async function measureR07RenderedSlide(path: string): Promise<R07SlideMetrics> {
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
    colorBucketCount: buckets.size
  }
}
