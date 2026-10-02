import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import * as esbuild from 'esbuild'
import electronExecutable from 'electron'

import type { PresentationDocument } from '../../src/renderer/src/components/artifacts/presentation/presentationTypes'
import { e2eTempRoot } from './support/app'
import { captureR07PreviewSlides } from './support/r07PreviewCapture'

test('HTML presentation keeps native thumbnails, single-page navigation and annotations under production CSP', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  const root = await mkdtemp(join(e2eTempRoot(), 'dsc-html-ppt-'))
  let app: ElectronApplication | undefined
  try {
    const bundlePath = join(root, 'preview.js')
    const htmlPath = join(root, 'preview.html')
    const mainPath = join(root, 'main.cjs')
    await bundlePresentationPanel(root, bundlePath)
    const productionHtml = await readFile(
      resolve(__dirname, '../../src/renderer/index.html'),
      'utf8'
    )
    const csp = productionHtml.match(/content="(default-src[^"]+)"/u)?.[1]
    if (!csp) throw new Error('Production renderer CSP was not found.')
    await writeFile(
      htmlPath,
      `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <link rel="stylesheet" href="./preview.css">
      <style>
        :root { --background: #fff; --foreground: #202124; --border: #ddd; --ring: #2563eb; --muted: #eef2ff; --muted-foreground: #667085; }
        body { margin: 0; font-family: Arial, sans-serif; }
        #root, [data-slot="right-workspace-shell"] { width: 1080px; height: 680px; }
        button { min-height: 28px; }
      </style>
      </head><body><div id="root"></div><script src="./preview.js"></script></body></html>`
    )
    await writeFile(
      mainPath,
      `const { app, BrowserWindow } = require('electron');
      app.whenReady().then(() => {
        const window = new BrowserWindow({ width: 1120, height: 760, show: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
        window.loadFile(${JSON.stringify(htmlPath)});
      });`
    )
    app = await electron.launch({ executablePath: electronExecutable, args: [mainPath], cwd: root })
    const page = await app.firstWindow()
    const remoteRequests: string[] = []
    const remoteResponses: string[] = []
    const remoteFailures: Array<{ url: string; error: string | undefined }> = []
    page.on('request', (request) => {
      if (/^https?:/u.test(request.url())) remoteRequests.push(request.url())
    })
    page.on('response', (response) => {
      if (/^https?:/u.test(response.url())) remoteResponses.push(response.url())
    })
    page.on('requestfailed', (request) => {
      if (/^https?:/u.test(request.url())) {
        remoteFailures.push({ url: request.url(), error: request.failure()?.errorText })
      }
    })
    const panel = page.locator('[data-slot="presentation-panel"]')
    const frameElement = panel.locator('iframe.presentation-html-frame')
    const frame = frameElement.contentFrame()
    await expect(frameElement).toHaveAttribute('sandbox', 'allow-same-origin')
    await expect(frame.locator('body')).toHaveAttribute('data-preview-ready', 'true')
    await expect(panel).toHaveAttribute('data-presentation-layout', 'rail')
    await expect(frame.locator('.sidebar > .thumb')).toHaveCount(6)
    await expect(frame.locator('.sidebar .thumb-slide')).toHaveCount(6)
    await expect(panel.locator('.presentation-stage-image')).toHaveCount(0)
    await expect(frame.locator('.main > .slide-container:visible')).toHaveCount(1)
    await expect(frame.locator('.main > .slide-container:visible')).toContainText('Slide 1')
    const sidebarWidth = await frame
      .locator('.sidebar')
      .evaluate((element) => element.getBoundingClientRect().width)
    expect(sidebarWidth).toBe(220)
    const dataImage = frame.locator('.main > .slide-container:visible img')
    await expect
      .poll(() =>
        dataImage.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)
      )
      .toBe(true)
    await expect(frame.locator('.main > .slide-container:visible .slide')).toHaveCSS(
      'background-color',
      'rgb(255, 255, 255)'
    )
    await expect(
      frame.locator('.main > .slide-container:visible .katex-formula math mfrac')
    ).toBeVisible()

    await frame.locator('.sidebar > .thumb').nth(2).click()
    await expect(panel).toContainText('3 / 6')
    await expect(frame.locator('.main > .slide-container:visible')).toContainText('Slide 3')
    await expect(frame.locator('.main > .slide-container:visible')).toHaveCount(1)
    await frame.locator('.sidebar > .thumb').nth(2).press('ArrowRight')
    await expect(panel).toContainText('4 / 6')
    await panel.getByRole('button', { name: '上一页', exact: true }).click()
    await expect(panel).toContainText('3 / 6')

    const activeSlide = frame.locator('.main > .slide-container:visible .slide-wrapper > .slide')
    const initialWidth = await activeSlide.evaluate((slide) => slide.getBoundingClientRect().width)
    await panel.getByRole('button', { name: '放大', exact: true }).click()
    await expect(panel).toContainText('110%')
    await expect
      .poll(() => activeSlide.evaluate((slide) => slide.getBoundingClientRect().width))
      .toBeGreaterThan(initialWidth)
    await panel.getByRole('button', { name: '适应窗口', exact: true }).click()
    await expect(panel).toContainText('100%')

    await panel.getByRole('button', { name: '为当前页添加批注', exact: true }).click()
    await frame.getByRole('button', { name: 'Shape 3', exact: true }).click()
    await frame.getByRole('button', { name: 'Link 3，打开链接', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.presentationHtmlDiagnostics))
      .toMatchObject({
        annotations: [
          { kind: 'slide', slideId: 'slide-3' },
          { kind: 'element', slideId: 'slide-3', objectId: 'shape-3' }
        ],
        links: ['https://example.com/slide-3'],
        selectedElements: ['shape-3', 'link-3']
      })
    await expect(frame.locator('.presentation-annotation-marker')).toHaveCount(1)
    const marker = frame.locator('.presentation-annotation-marker')
    await expect
      .poll(() => marker.evaluate((element) => element.getBoundingClientRect().width))
      .toBeCloseTo(20, 0)
    for (let step = 0; step < 5; step += 1) {
      await panel.getByRole('button', { name: '缩小', exact: true }).click()
    }
    await expect(panel).toContainText('50%')
    await expect
      .poll(() => marker.evaluate((element) => element.getBoundingClientRect().width))
      .toBeCloseTo(20, 0)
    await panel.getByRole('button', { name: '重置缩放', exact: true }).click()
    await panel.getByRole('button', { name: '选择区域批注', exact: true }).click()
    const overlay = frame.locator('.main > .slide-container:visible .presentation-stage-overlay')
    const bounds = await overlay.boundingBox()
    if (!bounds) throw new Error('Annotation overlay has no bounds.')
    // Electron's CDP mouse routing stalls even for a plain sandbox iframe drag without
    // event handlers. Dispatch PointerEvents for drag geometry; other interactions use native input.
    await overlay.evaluate((stage) => {
      const rectangle = stage.getBoundingClientRect()
      for (const [type, fraction] of [
        ['pointerdown', 0.6],
        ['pointermove', 0.8],
        ['pointerup', 0.8]
      ] as const) {
        stage.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 77,
            pointerType: 'mouse',
            clientX: rectangle.left + rectangle.width * fraction,
            clientY: rectangle.top + rectangle.height * fraction
          })
        )
      }
    })
    await expect
      .poll(() => page.evaluate(() => window.presentationHtmlDiagnostics.annotations.length))
      .toBe(3)
    const region = await page.evaluate(() => window.presentationHtmlDiagnostics.annotations[2])
    expect(region).toMatchObject({ kind: 'region', slideId: 'slide-3' })
    expect(region.x!).toBeCloseTo(0.6, 1)
    expect(region.y!).toBeCloseTo(0.6, 1)
    expect(region.width!).toBeCloseTo(0.2, 1)
    expect(region.height!).toBeCloseTo(0.2, 1)
    await panel.getByRole('button', { name: '选择区域批注', exact: true }).click()
    const frameBounds = await frameElement.boundingBox()
    if (!frameBounds) throw new Error('Preview frame has no bounds.')
    await overlay.evaluate((stage) => {
      const rectangle = stage.getBoundingClientRect()
      stage.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 78,
          pointerType: 'mouse',
          clientX: rectangle.left + rectangle.width * 0.8,
          clientY: rectangle.top + rectangle.height * 0.8
        })
      )
    })
    await page.evaluate(
      ({ x, y }) => {
        for (const type of ['pointermove', 'pointerup']) {
          document.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              pointerId: 78,
              pointerType: 'mouse',
              clientX: x,
              clientY: y
            })
          )
        }
      },
      { x: frameBounds.x + frameBounds.width + 10, y: frameBounds.y + frameBounds.height + 10 }
    )
    await expect
      .poll(() => page.evaluate(() => window.presentationHtmlDiagnostics.annotations.length))
      .toBe(4)
    const outsideRegion = await page.evaluate(
      () => window.presentationHtmlDiagnostics.annotations[3]
    )
    expect(outsideRegion).toMatchObject({ kind: 'region', slideId: 'slide-3' })
    expect(outsideRegion.x!).toBeCloseTo(0.8, 1)
    expect(outsideRegion.y!).toBeCloseTo(0.8, 1)
    expect(outsideRegion.width!).toBeCloseTo(0.2, 1)
    expect(outsideRegion.height!).toBeCloseTo(0.2, 1)

    // Prove the browser policy still blocks resources/scripts added after sanitization.
    expect(remoteRequests).toEqual([])
    await frame.locator('body').evaluate((body) => {
      const script = body.ownerDocument.createElement('script')
      script.textContent = 'parent.presentationHtmlDiagnostics.injectedScriptRan = true'
      body.appendChild(script)
      const image = body.ownerDocument.createElement('img')
      image.src = 'https://preview-resource.invalid/policy-probe.png'
      body.appendChild(image)
    })
    expect(await page.evaluate(() => window.presentationHtmlDiagnostics.injectedScriptRan)).toBe(
      false
    )
    expect(await page.evaluate(() => window.presentationHtmlDiagnostics.sourceScriptRan)).toBe(
      false
    )
    await expect
      .poll(() => remoteFailures)
      .toEqual([
        {
          url: 'https://preview-resource.invalid/policy-probe.png',
          error: expect.stringMatching(/^(?:csp|net::ERR_BLOCKED_BY_CSP)$/u)
        }
      ])
    expect(remoteResponses).toEqual([])
    await frame.locator('body').evaluate((body) => {
      body
        .querySelectorAll('script, img[src="https://preview-resource.invalid/policy-probe.png"]')
        .forEach((element) => element.remove())
    })
    const wideScreenshot = testInfo.outputPath('html-presentation-wide.png')
    await panel.screenshot({ path: wideScreenshot })
    await testInfo.attach('html-presentation-wide', {
      path: wideScreenshot,
      contentType: 'image/png'
    })

    await page.locator('[data-slot="right-workspace-shell"]').evaluate((element: HTMLElement) => {
      element.style.width = '720px'
    })
    await expect(panel).toHaveAttribute('data-presentation-layout', 'floating')
    await expect(frame.locator('.sidebar')).toBeHidden()
    await panel.getByRole('button', { name: '展开幻灯片列表', exact: true }).click()
    await expect(frame.locator('.sidebar')).toBeVisible()
    await frame.locator('.sidebar > .thumb').nth(1).click()
    await expect(panel).toContainText('2 / 6')
    await panel.getByRole('button', { name: '收起幻灯片列表', exact: true }).click()
    await expect(frame.locator('.sidebar')).toBeHidden()
    await page.locator('[data-slot="right-workspace-shell"]').evaluate((element: HTMLElement) => {
      element.style.width = '640px'
    })
    await expect(panel).toHaveAttribute('data-presentation-layout', 'stacked')
    await expect(frame.locator('.sidebar')).toBeVisible()
    await expect(frame.locator('.main > .slide-container:visible')).toContainText('Slide 2')
    const narrowScreenshot = testInfo.outputPath('html-presentation-narrow.png')
    await panel.screenshot({ path: narrowScreenshot })
    await testInfo.attach('html-presentation-narrow', {
      path: narrowScreenshot,
      contentType: 'image/png'
    })

    await page.locator('[data-slot="right-workspace-shell"]').evaluate((element: HTMLElement) => {
      element.style.width = '1080px'
    })
    await expect(panel).toHaveAttribute('data-presentation-layout', 'rail')
    await frame.locator('.sidebar > .thumb').first().click()
    const captures = await captureR07PreviewSlides({
      page,
      outputDirectory: join(root, 'captures')
    })
    expect(captures).toHaveLength(6)
    expect(new Set(captures.map((capture) => capture.sha256)).size).toBe(6)
    expect(
      captures.every(
        (capture) => capture.width > 500 && capture.height > 250 && capture.nonWhiteRatio > 0.05
      )
    ).toBe(true)
    expect(remoteRequests).toEqual(['https://preview-resource.invalid/policy-probe.png'])
    expect(remoteResponses).toEqual([])
    expect(await page.evaluate(() => window.presentationHtmlDiagnostics.errors)).toEqual([])
  } finally {
    await app?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

async function bundlePresentationPanel(root: string, bundlePath: string): Promise<void> {
  const rendererRoot = resolve(__dirname, '../../src/renderer/src')
  const appRoot = resolve(__dirname, '../..')
  const entryPath = join(root, 'entry.tsx')
  await writeFile(
    entryPath,
    `import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { PresentationPanel } from ${JSON.stringify(join(rendererRoot, 'components/artifacts/presentation/PresentationPanel.tsx'))};
    window.presentationHtmlDiagnostics = { annotations: [], selectedElements: [], links: [], errors: [], injectedScriptRan: false, sourceScriptRan: false };
    const document = ${JSON.stringify(presentationDocument())};
    createRoot(window.document.getElementById('root')).render(<aside data-slot="right-workspace-shell">
      <PresentationPanel document={document} html={${JSON.stringify(officeHtmlFixture())}}
        annotations={[{ id: 'annotation-3', sourceId: 'source-1', generation: 1, target: { kind: 'element', slideId: 'slide-3', objectId: 'shape-3' }, body: 'Existing note', status: 'saved', createdAt: 1, updatedAt: 1 }]}
        onPreviewError={(message) => window.presentationHtmlDiagnostics.errors.push(message)}
        onRequestAnnotation={(target) => window.presentationHtmlDiagnostics.annotations.push(target)}
        onSelectElement={(_, element) => window.presentationHtmlDiagnostics.selectedElements.push(element.id)}
        onOpenHyperlink={(url) => window.presentationHtmlDiagnostics.links.push(url)} />
    </aside>);`
  )
  await esbuild.build({
    entryPoints: [entryPath],
    outfile: bundlePath,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    absWorkingDir: appRoot,
    nodePaths: [join(appRoot, 'node_modules')],
    plugins: [
      {
        name: 'presentation-test-imports',
        setup(build) {
          build.onResolve({ filter: /\.css\?(?:inline|raw)$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.replace(/\?(?:inline|raw)$/u, '')),
            namespace: 'inline-css'
          }))
          build.onLoad({ filter: /.*/, namespace: 'inline-css' }, async (args) => ({
            loader: 'text',
            contents: await readFile(args.path, 'utf8')
          }))
          build.onResolve({ filter: /^@\// }, (args) => ({
            path: resolveModulePath(resolve(rendererRoot, args.path.slice(2)))
          }))
        }
      }
    ]
  })
}

function presentationDocument(): PresentationDocument {
  return {
    width: 16,
    height: 9,
    slides: Array.from({ length: 6 }, (_, index) => {
      const number = index + 1
      return {
        id: `slide-${number}`,
        number,
        name: `Slide ${number}`,
        elements: [
          {
            id: `shape-${number}`,
            name: `Shape ${number}`,
            kind: 'shape',
            frame: { x: 0.1, y: 0.15, width: 0.25, height: 0.25 }
          },
          {
            id: `link-${number}`,
            name: `Link ${number}`,
            kind: 'text',
            hyperlink: `https://example.com/slide-${number}`,
            frame: { x: 0.55, y: 0.15, width: 0.25, height: 0.25 }
          }
        ]
      }
    })
  }
}

function officeHtmlFixture(): string {
  const slides = Array.from({ length: 6 }, (_, index) => {
    const number = index + 1
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="white"/><rect x="96" y="81" width="240" height="135" fill="hsl(${index * 50} 70% 45%)"/><rect x="528" y="81" width="240" height="135" fill="#38bdf8"/><text x="80" y="390" font-size="60" fill="#202124">Slide ${number}</text></svg>`
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
    return `<div class="slide-container" id="slide-${number}"><div class="slide-wrapper"><div class="slide" style="width:960px;height:540px;background:white;position:relative"><img alt="Slide ${number}" src="${dataUrl}" style="width:960px;height:540px"><span style="position:absolute;top:30px;left:80px;font-size:32px">Slide ${number}</span><span class="katex-formula" data-formula="\\frac{a}{b}" style="position:absolute;top:280px;left:600px;font-size:28px"></span></div></div></div>`
  })
  return `<!doctype html><html><head><style>
    body { margin: 0; display:flex; background:#1a1a2e; }
    .sidebar { width:180px; overflow:auto; } .thumb-inner { position:relative; overflow:hidden; }
    .main { flex:1; overflow:auto; } .slide-container { position:relative; }
  </style><link rel="stylesheet" href="https://preview-resource.invalid/source.css"></head><body>
    <div class="sidebar">${slides.map((_, index) => `<div class="thumb" data-slide="${index + 1}"><div class="thumb-inner"></div><span class="thumb-num">${index + 1}</span></div>`).join('')}</div>
    <div class="main">${slides.join('')}</div>
    <script>parent.presentationHtmlDiagnostics.sourceScriptRan = true</script>
    <img src="https://preview-resource.invalid/source.png" onerror="parent.presentationHtmlDiagnostics.sourceScriptRan = true">
    </body></html>`
}

function resolveModulePath(path: string): string {
  const match = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.jsx`,
    join(path, 'index.ts'),
    join(path, 'index.tsx')
  ].find(existsSync)
  if (!match) throw new Error(`Unable to resolve renderer import ${path}`)
  return match
}

declare global {
  interface Window {
    presentationHtmlDiagnostics: {
      annotations: Array<{
        kind: string
        slideId: string
        objectId?: string
        x?: number
        y?: number
        width?: number
        height?: number
      }>
      selectedElements: string[]
      links: string[]
      errors: string[]
      injectedScriptRan: boolean
      sourceScriptRan: boolean
    }
  }
}
