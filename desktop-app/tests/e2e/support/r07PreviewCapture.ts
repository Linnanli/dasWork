import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect, type Page } from '@playwright/test'

import { measureR07RenderedSlide, type R07SlideMetrics } from './r07RenderMetrics'

export type R07CapturedSlide = R07SlideMetrics & {
  file: string
  sha256: string
}

export async function captureR07PreviewSlides(input: {
  page: Page
  outputDirectory: string
}): Promise<R07CapturedSlide[]> {
  await mkdir(input.outputDirectory, { recursive: true })
  const rightPanel = input.page.locator('[data-slot="right-workspace-shell"]')
  const stageImage = rightPanel.locator('.presentation-stage-image[src^="data:image/png;base64,"]')
  const nextSlide = rightPanel.getByRole('button', { name: '下一页', exact: true })
  const slides: R07CapturedSlide[] = []
  for (let index = 0; index < 6; index += 1) {
    await expect(rightPanel.locator('[data-slot="presentation-panel"]')).toContainText(
      `${index + 1} / 6`
    )
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
    const png = pngBufferFromDataUrl(dataUrl.src)
    const file = `slide-${String(index + 1).padStart(2, '0')}.png`
    const path = join(input.outputDirectory, file)
    await writeFile(path, png, { mode: 0o600 })
    slides.push({
      file,
      ...(await measureR07RenderedSlide(path)),
      sha256: createHash('sha256').update(png).digest('hex')
    })
    if (index < 5) await nextSlide.click()
  }
  return slides
}

export function pngBufferFromDataUrl(value: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value)
  if (!match?.[1]) throw new Error('R07 preview slide is not a PNG data URL.')
  return Buffer.from(match[1], 'base64')
}
