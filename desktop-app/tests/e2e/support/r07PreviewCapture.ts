import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, type Page } from '@playwright/test'
import { createCanvas, loadImage } from '@napi-rs/canvas'

import { measureR07RenderedSlide, type R07SlideMetrics } from './r07RenderMetrics'

export type R07CapturedSlide = R07SlideMetrics & {
  file: string
  sha256: string
}

export async function captureR07PreviewSlides(input: {
  page: Page
  outputDirectory: string
}): Promise<R07CapturedSlide[]> {
  const rightPanel = input.page.locator('[data-slot="right-workspace-shell"]')
  const stageImage = rightPanel.locator('.presentation-stage-image[src^="data:image/png;base64,"]')
  const htmlFrame = rightPanel.locator('iframe.presentation-html-frame')
  const htmlPreview = (await htmlFrame.count()) > 0
  const frame = htmlFrame.contentFrame()
  const nextSlide = rightPanel.getByRole('button', { name: '下一页', exact: true })
  const captures: { file: string; png: Buffer }[] = []
  for (let index = 0; index < 6; index += 1) {
    await expect(rightPanel.locator('[data-slot="presentation-panel"]')).toContainText(
      `${index + 1} / 6`
    )
    let png: Buffer
    if (htmlPreview) {
      await expect(frame.locator('body')).toHaveAttribute('data-preview-ready', 'true', {
        timeout: 120_000
      })
      await expect(frame.locator('.main > .slide-container:visible')).toHaveCount(1)
      const slide = frame.locator('.main > .slide-container:visible .slide-wrapper > .slide')
      await expect(slide).toBeVisible()
      // QA captures the displayed HTML; the application itself does not generate PNG previews.
      png = await slide.screenshot({ animations: 'disabled' })
    } else {
      await expect(stageImage).toBeVisible({ timeout: 120_000 })
      await expect
        .poll(
          async () =>
            stageImage.evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth >= 900 && image.naturalHeight >= 500
            ),
          { timeout: 120_000 }
        )
        .toBe(true)
      const dataUrl = await stageImage.evaluate((image: HTMLImageElement) => ({
        src: image.src,
        width: image.naturalWidth,
        height: image.naturalHeight,
        complete: image.complete
      }))
      expect(dataUrl.complete).toBe(true)
      expect(dataUrl.width).toBeGreaterThanOrEqual(900)
      expect(dataUrl.height).toBeGreaterThanOrEqual(500)
      png = pngBufferFromDataUrl(dataUrl.src)
    }
    const file = `slide-${String(index + 1).padStart(2, '0')}.png`
    captures.push({ file, png })
    if (index < 5) await nextSlide.click()
  }
  // The destination can be inside the watched workspace. Writing while
  // navigating would refresh the artifact panel and reset its current page.
  await mkdir(input.outputDirectory, { recursive: true })
  return Promise.all(
    captures.map(async ({ file, png }) => {
      const path = join(input.outputDirectory, file)
      await writeFile(path, png, { mode: 0o600 })
      return {
        file,
        ...(await measureR07RenderedSlide(path)),
        sha256: createHash('sha256').update(png).digest('hex')
      }
    })
  )
}

export function pngBufferFromDataUrl(value: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value)
  if (!match?.[1]) throw new Error('R07 preview slide is not a PNG data URL.')
  return Buffer.from(match[1], 'base64')
}

export async function writeR07ContactSheet(input: {
  slides: readonly R07CapturedSlide[]
  outputDirectory: string
  outputPath: string
}): Promise<void> {
  const thumbnailWidth = 320
  const thumbnailHeight = 180
  const padding = 12
  const labelHeight = 24
  const columns = 3
  const cellWidth = thumbnailWidth + padding * 2
  const cellHeight = thumbnailHeight + padding * 2 + labelHeight
  const canvas = createCanvas(
    cellWidth * columns,
    cellHeight * Math.ceil(input.slides.length / columns)
  )
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = '16px sans-serif'
  const images = await Promise.all(
    input.slides.map(async (slide) =>
      loadImage(await readFile(join(input.outputDirectory, slide.file)))
    )
  )
  images.forEach((image, index) => {
    const left = (index % columns) * cellWidth + padding
    const top = Math.floor(index / columns) * cellHeight + padding
    context.fillStyle = '#202124'
    context.fillText(`Slide ${index + 1}`, left, top + 16)
    context.drawImage(image, left, top + labelHeight, thumbnailWidth, thumbnailHeight)
  })
  await writeFile(input.outputPath, canvas.toBuffer('image/png'), { mode: 0o600 })
}
