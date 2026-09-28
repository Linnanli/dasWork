import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import electronExecutable from 'electron'

import { e2eTempRoot } from './support/app'
import { measureR07RenderedSlide } from './support/r07RenderMetrics'
import { captureR07PreviewSlides } from './support/r07PreviewCapture'

type SlideFixture = {
  file: string
  dataUrl: string
  sha256: string
}

test('captureR07PreviewSlides writes preview PNGs only after all six slides are captured', async () => {
  const tempRoot = await mkdtemp(join(e2eTempRoot(), 'dsc-r07-capture-'))
  const outputDirectory = join(tempRoot, 'workspace', 'visual-artifacts', 'slides')
  let app: ElectronApplication | undefined
  try {
    const slides = createSlideFixtures()
    const mainPath = join(tempRoot, 'main.cjs')
    const htmlPath = join(tempRoot, 'preview.html')
    await mkdir(join(tempRoot, 'workspace'), { recursive: true })
    await writeFile(mainPath, electronMainSource(htmlPath), { mode: 0o600 })
    await writeFile(htmlPath, previewHtml(slides), { mode: 0o600 })

    app = await electron.launch({
      executablePath: electronExecutable,
      args: [mainPath],
      cwd: tempRoot,
      timeout: 30_000
    })
    const page = await app.firstWindow()
    const outputChecks: boolean[] = []
    await page.exposeFunction('r07CaptureOutputExists', () => {
      const exists = existsSync(outputDirectory)
      outputChecks.push(exists)
      return exists
    })

    const captures = await captureR07PreviewSlides({ page, outputDirectory })

    expect(outputChecks).toEqual([false, false, false, false, false])
    expect(captures).toHaveLength(6)
    for (const [index, capture] of captures.entries()) {
      const expected = slides[index]
      expect(capture.file).toBe(expected.file)
      expect(capture.sha256).toBe(expected.sha256)
      const path = join(outputDirectory, expected.file)
      expect(
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      ).toBe(expected.sha256)
      expect(await measureR07RenderedSlide(path)).toMatchObject({
        width: 960,
        height: 540,
        nonWhiteRatio: capture.nonWhiteRatio,
        colorBucketCount: capture.colorBucketCount
      })
      expect(capture.nonWhiteRatio).toBeGreaterThan(0.05)
      expect(capture.colorBucketCount).toBeGreaterThan(8)
    }
  } finally {
    await app?.close().catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})

function createSlideFixtures(): SlideFixture[] {
  return Array.from({ length: 6 }, (_, index) => {
    const canvas = createCanvas(960, 540)
    const context = canvas.getContext('2d')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 960, 540)
    context.fillStyle = `hsl(${index * 48}, 70%, 42%)`
    context.fillRect(52 + index * 8, 48 + index * 5, 430, 182)
    context.fillStyle = `hsl(${(index * 48 + 180) % 360}, 78%, 46%)`
    context.fillRect(528 - index * 6, 96 + index * 10, 300, 288)
    context.fillStyle = '#202124'
    context.font = '700 64px Arial'
    context.fillText(`R07-${index + 1}`, 76, 332)
    context.fillStyle = '#5f6368'
    context.font = '36px Arial'
    context.fillText(`fixture ${index + 1}`, 92 + index * 4, 405)
    context.strokeStyle = '#111827'
    context.lineWidth = 10
    context.strokeRect(24 + index * 3, 24 + index * 2, 912 - index * 6, 492 - index * 4)
    const png = canvas.toBuffer('image/png')
    return {
      file: `slide-${String(index + 1).padStart(2, '0')}.png`,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      sha256: createHash('sha256').update(png).digest('hex')
    }
  })
}

function electronMainSource(htmlPath: string): string {
  return `
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    show: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false
    }
  })
  window.loadFile(${JSON.stringify(htmlPath)})
})
`
}

function previewHtml(slides: SlideFixture[]): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>R07 Capture Regression Fixture</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; background: #f8fafc; }
      [data-slot="right-workspace-shell"] { padding: 24px; }
      [data-slot="presentation-panel"] { display: grid; gap: 16px; width: 960px; }
      .presentation-stage-image { width: 960px; height: 540px; object-fit: contain; background: #fff; }
      button { width: 96px; height: 36px; }
    </style>
  </head>
  <body>
    <main data-slot="right-workspace-shell">
      <section data-slot="presentation-panel">
        <div id="counter"></div>
        <img class="presentation-stage-image" alt="R07 slide preview" />
        <button type="button" id="next">下一页</button>
      </section>
    </main>
    <script>
      const slides = ${JSON.stringify(slides.map((slide) => slide.dataUrl))}
      let index = 0
      const counter = document.querySelector('#counter')
      const image = document.querySelector('.presentation-stage-image')
      const next = document.querySelector('#next')
      function render() {
        counter.textContent = String(index + 1) + ' / ' + String(slides.length)
        image.src = slides[index]
      }
      next.addEventListener('click', async () => {
        const outputExists = await window.r07CaptureOutputExists()
        if (outputExists) {
          index = 0
        } else {
          index = Math.min(index + 1, slides.length - 1)
        }
        render()
      })
      render()
    </script>
  </body>
</html>
`
}
