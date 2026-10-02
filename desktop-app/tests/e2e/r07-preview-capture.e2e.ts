import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createCanvas } from '@napi-rs/canvas'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import * as esbuild from 'esbuild'
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

test('captureR07PreviewSlides keeps real artifact preview navigation stable across parent focus rerenders', async () => {
  const tempRoot = await mkdtemp(join(e2eTempRoot(), 'dsc-r07-real-capture-'))
  const outputDirectory = join(tempRoot, 'workspace', 'visual-artifacts', 'slides')
  let app: ElectronApplication | undefined
  try {
    const slides = createSlideFixtures()
    const bundlePath = join(tempRoot, 'real-artifact-preview.js')
    const mainPath = join(tempRoot, 'main.cjs')
    const htmlPath = join(tempRoot, 'preview.html')
    await mkdir(join(tempRoot, 'workspace'), { recursive: true })
    await writeRealArtifactPreviewBundle({ bundlePath, entryPath: join(tempRoot, 'entry.tsx') })
    await writeFile(mainPath, electronMainSource(htmlPath), { mode: 0o600 })
    await writeFile(htmlPath, realArtifactPreviewHtml({ bundlePath, slides }), { mode: 0o600 })

    app = await electron.launch({
      executablePath: electronExecutable,
      args: [mainPath],
      cwd: tempRoot,
      timeout: 30_000
    })
    const page = await app.firstWindow()
    await page.waitForSelector('[data-slot="artifact-tab-content"][data-artifact-source-id]')
    const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
    await expect(rightPanel.locator('[data-slot="presentation-panel"]')).toContainText('1 / 6')
    await expect(
      rightPanel.locator('.presentation-stage-image[src^="data:image/png;base64,"]')
    ).toBeVisible()
    const diagnosticsBeforeCapture = await page.evaluate(() => window.r07ArtifactPreviewDiagnostics)

    const captures = await captureR07PreviewSlides({ page, outputDirectory })

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
      expect(capture.nonWhiteRatio).toBeGreaterThan(0.05)
      expect(capture.colorBucketCount).toBeGreaterThan(8)
    }

    const diagnostics = await page.evaluate(() => window.r07ArtifactPreviewDiagnostics)
    expect(diagnostics).toMatchObject({
      focusCount: 1,
      runtimeChanges: 1,
      registerWorkspaceSourceCalls: 1,
      openWithSystemCalls: 0,
      externalUrlCalls: 0
    })
    expect(diagnostics.metadataCalls).toBe(diagnosticsBeforeCapture.metadataCalls)
    expect(diagnostics.readBinaryCalls).toBe(diagnosticsBeforeCapture.readBinaryCalls)
    expect(diagnostics.renderPresentationCalls).toBe(
      diagnosticsBeforeCapture.renderPresentationCalls
    )
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

async function writeRealArtifactPreviewBundle({
  bundlePath,
  entryPath
}: {
  bundlePath: string
  entryPath: string
}): Promise<void> {
  await writeFile(entryPath, realArtifactPreviewEntrySource(), { mode: 0o600 })
  const rendererRoot = resolve(__dirname, '../../src/renderer/src')
  const appRoot = resolve(__dirname, '../..')
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
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'r07-real-artifact-preview-test-aliases',
        setup(build) {
          build.onResolve({ filter: /\.css\?(?:inline|raw)$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path.replace(/\?(?:inline|raw)$/u, '')),
            namespace: 'r07-inline-css'
          }))
          build.onLoad({ filter: /.*/, namespace: 'r07-inline-css' }, async (args) => ({
            loader: 'text',
            contents: await readFile(args.path, 'utf8')
          }))
          build.onResolve({ filter: /^@\// }, (args) => ({
            path: resolveModulePath(resolve(rendererRoot, args.path.slice(2)))
          }))
          build.onResolve({ filter: /PresentationRendererAdapter$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path),
            namespace: 'r07-presentation-renderer-adapter'
          }))
          build.onLoad({ filter: /.*/, namespace: 'r07-presentation-renderer-adapter' }, () => ({
            loader: 'ts',
            contents: `
export function parsePresentationInWorker() {
  return Promise.resolve({
    document: {
      width: 16,
      height: 9,
      slides: Array.from({ length: 6 }, (_, index) => ({
        id: 'slide-' + String(index + 1),
        number: index + 1,
        name: '幻灯片 ' + String(index + 1),
        elements: []
      }))
    },
    warnings: []
  })
}
export function clearPresentationCache() {}
`
          }))
          build.onResolve({ filter: /ArtifactConversationBridge$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path),
            namespace: 'r07-artifact-conversation-bridge'
          }))
          build.onLoad({ filter: /.*/, namespace: 'r07-artifact-conversation-bridge' }, () => ({
            loader: 'tsx',
            resolveDir: appRoot,
            contents: `
import React from 'react'
export function ArtifactConversationBridgeProvider({ children }) {
  return <>{children}</>
}
export function useArtifactConversationBridge() {
  return {
    available: false,
    register: () => () => {},
    addToComposer: async () => {},
    directSubmit: async () => {}
  }
}
`
          }))
        }
      }
    ]
  })
}

function realArtifactPreviewEntrySource(): string {
  return `
import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ArtifactTabContent } from ${JSON.stringify(
    resolve(__dirname, '../../src/renderer/src/components/artifacts/ArtifactTabContent.tsx')
  )}
import { artifactTabDescriptor } from ${JSON.stringify(
    resolve(__dirname, '../../src/renderer/src/components/artifacts/artifactTabDescriptor.ts')
  )}

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Missing #root.')

function App() {
  const [runtime, setRuntimeState] = useState(undefined)
  const [focusCount, setFocusCount] = useState(0)
  const tab = {
    id: 'artifact:r07',
    kind: 'artifact',
    title: 'R07 Preview Fixture.pptx',
    isPreview: true,
    isClosable: true,
    props: {
      artifactType: 'slides',
      importKind: 'pptx',
      source: { kind: 'workspace-file', relativePath: 'R07 Preview Fixture.pptx' },
      openSource: 'file-workspace',
      focusCount
    }
  }
  const artifact = useMemo(() => artifactTabDescriptor(tab), [tab])
  const target = { conversationId: 'conversation-r07' }
  const onRuntimeChange = (nextRuntime) => {
      window.r07ArtifactPreviewDiagnostics.runtimeChanges += 1
      setRuntimeState(nextRuntime)
  }
  if (!artifact) throw new Error('Artifact descriptor was not created.')
  return (
    <aside
      data-slot="right-workspace-shell"
      style={{ width: 1120, height: 720 }}
      onFocusCapture={() => {
        window.r07ArtifactPreviewDiagnostics.focusCount += 1
        setFocusCount((current) => current + 1)
      }}
    >
      <ArtifactTabContent
        artifact={artifact}
        workspaceId="workspace-r07"
        target={target}
        runtime={runtime}
        onRuntimeChange={onRuntimeChange}
      />
    </aside>
  )
}

createRoot(rootElement).render(<App />)
`
}

function resolveModulePath(pathWithoutExtension: string): string {
  const candidates = [
    pathWithoutExtension,
    `${pathWithoutExtension}.ts`,
    `${pathWithoutExtension}.tsx`,
    `${pathWithoutExtension}.js`,
    `${pathWithoutExtension}.jsx`,
    join(pathWithoutExtension, 'index.ts'),
    join(pathWithoutExtension, 'index.tsx'),
    join(pathWithoutExtension, 'index.js'),
    join(pathWithoutExtension, 'index.jsx')
  ]
  const match = candidates.find((candidate) => existsSync(candidate))
  if (!match) throw new Error(`Unable to resolve renderer import ${pathWithoutExtension}`)
  return match
}

function realArtifactPreviewHtml({
  bundlePath,
  slides
}: {
  bundlePath: string
  slides: SlideFixture[]
}): string {
  const renderedSlides = slides.map((slide, index) => ({
    number: index + 1,
    base64: slide.dataUrl.replace(/^data:image\/png;base64,/u, '')
  }))
  const sourceId = 'r07-source-0001'
  const checksum = createHash('sha256')
    .update(slides.map((slide) => slide.sha256).join(':'))
    .digest('hex')
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>R07 Real Artifact Preview Fixture</title>
    <style>
      body { margin: 0; font-family: Arial, sans-serif; background: #f8fafc; }
      [data-slot="artifact-tab-content"] { height: 720px; }
      [data-slot="presentation-panel"] { display: grid; grid-template-columns: 128px 1fr; width: 1040px; height: 620px; }
      .presentation-main { min-width: 0; }
      .presentation-toolbar { display: flex; justify-content: space-between; padding: 8px; }
      .presentation-stage-scroll { padding: 12px; }
      .presentation-stage { position: relative; width: 960px; }
      .presentation-stage-image { width: 960px; height: 540px; object-fit: contain; background: #fff; }
      .presentation-rail { display: grid; gap: 4px; }
      .presentation-thumbnail img { width: 96px; }
      button { min-width: 32px; min-height: 28px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      window.r07ArtifactPreviewDiagnostics = {
        focusCount: 0,
        runtimeChanges: 0,
        registerWorkspaceSourceCalls: 0,
        metadataCalls: 0,
        readBinaryCalls: 0,
        renderPresentationCalls: 0,
        openWithSystemCalls: 0,
        externalUrlCalls: 0
      }
      const sourceId = ${JSON.stringify(sourceId)}
      const metadata = {
        name: 'R07 Preview Fixture.pptx',
        generation: 1,
        size: 1024,
        mtimeMs: 1700000000000
      }
      const binary = {
        kind: 'binary',
        encoding: 'base64',
        generation: 1,
        checksum: ${JSON.stringify(checksum)},
        base64: btoa('pptx fixture bytes')
      }
      const renderedSlides = ${JSON.stringify(renderedSlides)}
      const listeners = { files: [], artifacts: [] }
      window.desktopApp = {
        codex: {
          openExternalHttpUrl: async () => {
            window.r07ArtifactPreviewDiagnostics.externalUrlCalls += 1
          }
        },
        workspace: {
          files: {
            prepareRoot: async () => ({ rootId: 'workspace-r07-root' }),
            onEvent: (listener) => {
              listeners.files.push(listener)
              return () => {
                listeners.files = listeners.files.filter((item) => item !== listener)
              }
            }
          },
          artifacts: {
            registerWorkspaceSource: async () => {
              window.r07ArtifactPreviewDiagnostics.registerWorkspaceSourceCalls += 1
              return { version: 1, sourceId, metadata }
            },
            metadata: async (request) => {
              if (request.sourceId !== sourceId) throw new Error('Unexpected metadata source.')
              window.r07ArtifactPreviewDiagnostics.metadataCalls += 1
              return { version: 1, sourceId, metadata }
            },
            readBinary: async (request) => {
              if (request.sourceId !== sourceId) throw new Error('Unexpected binary source.')
              window.r07ArtifactPreviewDiagnostics.readBinaryCalls += 1
              return { version: 1, sourceId, content: binary }
            },
            renderPresentation: async (request) => {
              if (request.sourceId !== sourceId) throw new Error('Unexpected render source.')
              window.r07ArtifactPreviewDiagnostics.renderPresentationCalls += 1
              return { version: 1, sourceId, generation: 1, slides: renderedSlides }
            },
            openWithSystem: async () => {
              window.r07ArtifactPreviewDiagnostics.openWithSystemCalls += 1
            },
            release: async () => {},
            onEvent: (listener) => {
              listeners.artifacts.push(listener)
              return () => {
                listeners.artifacts = listeners.artifacts.filter((item) => item !== listener)
              }
            }
          }
        }
      }
    </script>
    <script src="${bundlePath.replace(/"/g, '&quot;')}"></script>
  </body>
</html>
`
}

declare global {
  interface Window {
    r07ArtifactPreviewDiagnostics: {
      focusCount: number
      runtimeChanges: number
      registerWorkspaceSourceCalls: number
      metadataCalls: number
      readBinaryCalls: number
      renderPresentationCalls: number
      openWithSystemCalls: number
      externalUrlCalls: number
    }
  }
}
