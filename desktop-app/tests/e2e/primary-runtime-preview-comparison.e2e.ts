import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import {
  appRoot,
  attachDiagnostics,
  closeApp,
  collectRendererLogs,
  e2eTempRoot,
  launchApp
} from './support/app'
import { createLocalProject } from './support/chatActions'
import { startMockBackend } from './support/mockBackend'
import {
  openR07PresentationInWorkspace,
  readR07PresentationFixture,
  type R07RenderQaReceipt,
  type R07RenderedSlideMetric
} from './support/r07Presentation'
import { measureR07RenderedSlide } from './support/r07RenderMetrics'
import { captureR07PreviewSlides, type R07CapturedSlide } from './support/r07PreviewCapture'

type PreviewMigrationReport = {
  target?: unknown
  previewBaseline?: {
    target?: unknown
    legacyRuntimeRoot?: unknown
    legacyArchiveSha256?: unknown
    cacheRoot?: unknown
  }
}

type SlideComparison = {
  file: string
  legacy: R07CapturedSlide
  current: R07RenderedSlideMetric
  sameDimensions: boolean
  meanAbsoluteChannelDelta: number
  comparisonDimensions: { width: number; height: number }
}

type R07VisualArtifactReceipt = {
  schemaVersion?: unknown
  previewTrace?: {
    checksum?: unknown
  }
  renderReport?: R07RenderQaReceipt
}

const migrationReportPath =
  process.env['DASCOWORK_PRIMARY_RUNTIME_PREVIEW_MIGRATION_REPORT']?.trim()
const visualDirectory = process.env['DASCOWORK_R07_VISUAL_ARTIFACT_DIRECTORY']?.trim()
const legacyRuntimeRoot = process.env['DASCOWORK_PRIMARY_RUNTIME_ROOT']?.trim()
const comparisonTimeoutMs = 300_000

test('OFFICECLI-RUNTIME compares legacy v2 preview PNGs against OfficeCLI preview artifacts', async ({
  browserName
}, testInfo) => {
  test.setTimeout(comparisonTimeoutMs)
  expect(browserName).toBe('chromium')
  if (!migrationReportPath || !visualDirectory || !legacyRuntimeRoot) {
    throw new Error(
      'Preview comparison requires DASCOWORK_PRIMARY_RUNTIME_PREVIEW_MIGRATION_REPORT, DASCOWORK_R07_VISUAL_ARTIFACT_DIRECTORY, and DASCOWORK_PRIMARY_RUNTIME_ROOT.'
    )
  }

  const fixture = await readR07PresentationFixture()
  const migrationReport = JSON.parse(
    await readFile(migrationReportPath, 'utf8')
  ) as PreviewMigrationReport
  const baseline = validatePreviewBaseline(migrationReport, legacyRuntimeRoot)
  const sourceDeck = join(visualDirectory, fixture.outputFile)
  const sourceDeckShaBefore = await sha256File(sourceDeck)
  const currentReceipt = JSON.parse(
    await readFile(join(visualDirectory, 'r07-preview-render-receipt.json'), 'utf8')
  ) as R07VisualArtifactReceipt
  const currentSlides = await validateCurrentVisualArtifacts({
    receipt: currentReceipt,
    sourceDeckSha256: sourceDeckShaBefore,
    visualDirectory
  })

  const workspaceRoot = await mkdtemp(join(e2eTempRoot(), 'dsc-r07-preview-'))
  const backend = await startMockBackend({ responses: [] })
  const logs: string[] = []
  let app: ElectronApplication | undefined
  try {
    await copyFile(sourceDeck, join(workspaceRoot, fixture.outputFile))
    app = await launchApp(backend, logs, {
      cwd: workspaceRoot,
      launchTimeoutMs: 90_000,
      args: [appRoot],
      environment: primaryRuntimePreviewComparisonEnvironment(legacyRuntimeRoot)
    })
    const launchedRuntimeRoot = await app.evaluate(
      () => process.env['DASCOWORK_PRIMARY_RUNTIME_ROOT'] ?? null
    )
    expect(launchedRuntimeRoot).toBe(legacyRuntimeRoot)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, 'Primary Runtime preview comparison', workspaceRoot)
    await openR07PresentationInWorkspace(page, fixture.outputFile)

    const legacySlidesDirectory = join(visualDirectory, 'legacy-slides')
    const legacySlides = await captureR07PreviewSlides({
      page,
      outputDirectory: legacySlidesDirectory
    })
    assertRenderableSlides(legacySlides)
    assertRenderableSlides(currentSlides)

    const comparisons = await comparePreviewSlides({
      legacySlides,
      currentSlides,
      visualDirectory
    })
    await writeComparisonContactSheet({
      visualDirectory,
      comparisons
    })
    await writeFile(
      join(visualDirectory, 'r07-preview-comparison-report.json'),
      `${JSON.stringify(
        {
          schemaVersion: 'dascowork-r07-preview-comparison.v1',
          migrationReport: {
            path: migrationReportPath,
            previewBaseline: baseline
          },
          deck: {
            path: sourceDeck,
            sha256: sourceDeckShaBefore
          },
          legacyRuntimeEvidence: {
            source: 'electron-main-process-env',
            expectedPrimaryRuntimeRoot: legacyRuntimeRoot,
            observedPrimaryRuntimeRoot: launchedRuntimeRoot,
            legacyArchiveSha256: baseline.legacyArchiveSha256,
            previewRendererBoundary:
              'The renderPresentation IPC result does not expose the preview renderer runtime identity; this comparison binds the legacy preview run to Electron Main launch env and the verified migration previewBaseline.'
          },
          legacySlidesDirectory,
          currentSlidesDirectory: join(visualDirectory, 'slides'),
          contactSheet: join(visualDirectory, 'r07-preview-comparison-contact-sheet.png'),
          visualAcceptance: {
            status: 'pending',
            accepted: false,
            requiredReview:
              'Inspect all six full-size slide pairs for Chinese text, layout, tables and charts before accepting A6. Capture success and pixel deltas do not establish visual acceptance.'
          },
          comparisons
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )

    expect(await sha256File(sourceDeck)).toBe(sourceDeckShaBefore)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

async function validateCurrentVisualArtifacts(input: {
  receipt: R07VisualArtifactReceipt
  sourceDeckSha256: string
  visualDirectory: string
}): Promise<R07RenderedSlideMetric[]> {
  if (
    input.receipt.schemaVersion !== 'dascowork-r07-visual-artifacts.v1' ||
    input.receipt.previewTrace?.checksum !== input.sourceDeckSha256 ||
    input.receipt.renderReport?.schemaVersion !== 'dascowork-r07-render-qa.v1'
  ) {
    throw new Error('R07 visual artifact receipt is not bound to the current deck.')
  }

  const slides = input.receipt.renderReport.slides
  assertRenderableSlides(slides)
  await Promise.all(
    slides.map(async (slide) => {
      if (
        slide.source?.kind !== 'electron-host-preview' ||
        slide.source.presentationSha256 !== input.sourceDeckSha256
      ) {
        throw new Error(`R07 current slide ${slide.file} is not bound to the current deck.`)
      }
      const pngPath = join(input.visualDirectory, 'slides', slide.file)
      const [sha256, metrics] = await Promise.all([
        sha256File(pngPath),
        measureR07RenderedSlide(pngPath)
      ])
      expect(sha256).toBe(slide.sha256)
      expect(metrics).toMatchObject({
        width: slide.width,
        height: slide.height,
        nonWhiteRatio: slide.nonWhiteRatio,
        colorBucketCount: slide.colorBucketCount
      })
    })
  )
  return slides
}

function validatePreviewBaseline(
  report: PreviewMigrationReport,
  expectedLegacyRuntimeRoot: string
): { legacyRuntimeRoot: string; legacyArchiveSha256: string; cacheRoot: string; target?: string } {
  const baseline = report.previewBaseline
  if (
    !baseline ||
    typeof baseline.legacyRuntimeRoot !== 'string' ||
    baseline.legacyRuntimeRoot !== expectedLegacyRuntimeRoot ||
    typeof baseline.legacyArchiveSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(baseline.legacyArchiveSha256) ||
    typeof baseline.cacheRoot !== 'string' ||
    baseline.cacheRoot.length === 0
  ) {
    throw new Error('Preview comparison migration report does not bind a verified legacy v2 cache.')
  }
  const target = typeof baseline.target === 'string' ? baseline.target : reportTarget(report)
  if (target && target !== currentNativeTarget()) {
    throw new Error(`Preview comparison target ${target} does not match ${currentNativeTarget()}.`)
  }
  return {
    legacyRuntimeRoot: baseline.legacyRuntimeRoot,
    legacyArchiveSha256: baseline.legacyArchiveSha256,
    cacheRoot: baseline.cacheRoot,
    ...(target ? { target } : {})
  }
}

function reportTarget(report: PreviewMigrationReport): string | undefined {
  return typeof report.target === 'string' ? report.target : undefined
}

function currentNativeTarget(): string {
  return `${process.platform}-${process.arch}`
}

function primaryRuntimePreviewComparisonEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    CODEX_APP_SERVER_BIN: undefined,
    DASCOWORK_APP_TOOLS_LIVE_TRACE_REPORT: undefined,
    DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: undefined,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: undefined,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH: undefined,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: undefined,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_E2E: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_HOST: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_PORT: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_STAGED_ROOT: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CA: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_CERT: undefined,
    DASCOWORK_PRIMARY_RUNTIME_FEED_TLS_KEY: undefined,
    DASCOWORK_PRIMARY_RUNTIME_PACKAGED_APP_EXECUTABLE: undefined,
    DASCOWORK_PRIMARY_RUNTIME_PACKAGED_ASSET_RECEIPT: undefined,
    DASCOWORK_PRIMARY_RUNTIME_PACKAGED_E2E_LOCAL_CA_PATH: undefined,
    DASCOWORK_PRIMARY_RUNTIME_ROOT: root
  }
}

function assertRenderableSlides(slides: readonly R07RenderedSlideMetric[]): void {
  expect(slides.map((slide) => slide.file)).toEqual(
    Array.from({ length: 6 }, (_, index) => `slide-${String(index + 1).padStart(2, '0')}.png`)
  )
  for (const slide of slides) {
    expect(slide.width).toBeGreaterThanOrEqual(900)
    expect(slide.height).toBeGreaterThanOrEqual(500)
    expect(slide.nonWhiteRatio).toBeGreaterThan(0.01)
    expect(slide.colorBucketCount).toBeGreaterThan(12)
  }
}

async function comparePreviewSlides(input: {
  legacySlides: readonly R07CapturedSlide[]
  currentSlides: readonly R07RenderedSlideMetric[]
  visualDirectory: string
}): Promise<SlideComparison[]> {
  return Promise.all(
    input.legacySlides.map(async (legacy, index) => {
      const current = input.currentSlides[index]
      if (!current || current.file !== legacy.file) {
        throw new Error(`Missing current preview slide for ${legacy.file}.`)
      }
      const sameDimensions = legacy.width === current.width && legacy.height === current.height
      // Different pixel densities may round the same slide edges by one pixel.
      const roundingTolerance =
        1 / legacy.width + 1 / legacy.height + 1 / current.width + 1 / current.height
      expect(
        Math.abs(Math.log(legacy.width / legacy.height / (current.width / current.height)))
      ).toBeLessThanOrEqual(roundingTolerance)
      return {
        file: legacy.file,
        legacy,
        current,
        sameDimensions,
        comparisonDimensions: { width: legacy.width, height: legacy.height },
        meanAbsoluteChannelDelta: await meanAbsoluteChannelDelta(
          join(input.visualDirectory, 'legacy-slides', legacy.file),
          join(input.visualDirectory, 'slides', current.file)
        )
      }
    })
  )
}

async function meanAbsoluteChannelDelta(leftPath: string, rightPath: string): Promise<number> {
  const [left, right] = await Promise.all([loadImage(leftPath), loadImage(rightPath)])
  const canvas = createCanvas(left.width, left.height)
  const context = canvas.getContext('2d')
  context.drawImage(left, 0, 0)
  const leftData = context.getImageData(0, 0, left.width, left.height).data
  context.clearRect(0, 0, left.width, left.height)
  context.drawImage(right, 0, 0, left.width, left.height)
  const rightData = context.getImageData(0, 0, right.width, right.height).data
  let total = 0
  for (let offset = 0; offset < leftData.length; offset += 4) {
    total += Math.abs((leftData[offset] ?? 0) - (rightData[offset] ?? 0))
    total += Math.abs((leftData[offset + 1] ?? 0) - (rightData[offset + 1] ?? 0))
    total += Math.abs((leftData[offset + 2] ?? 0) - (rightData[offset + 2] ?? 0))
  }
  return total / (left.width * left.height * 3)
}

async function writeComparisonContactSheet(input: {
  visualDirectory: string
  comparisons: readonly SlideComparison[]
}): Promise<void> {
  const cellWidth = 320
  const cellHeight = 180
  const labelHeight = 24
  const gap = 12
  const columns = 3
  const width = columns * cellWidth + (columns + 1) * gap
  const rowHeight = cellHeight + labelHeight + gap
  const height = input.comparisons.length * rowHeight + gap
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.font = '14px sans-serif'
  for (const [index, comparison] of input.comparisons.entries()) {
    const y = gap + index * rowHeight
    await drawLabeledImage(context, {
      path: join(input.visualDirectory, 'legacy-slides', comparison.file),
      label: `${comparison.file} legacy v2`,
      x: gap,
      y,
      width: cellWidth,
      height: cellHeight,
      labelHeight
    })
    await drawLabeledImage(context, {
      path: join(input.visualDirectory, 'slides', comparison.file),
      label: `${comparison.file} OfficeCLI`,
      x: gap * 2 + cellWidth,
      y,
      width: cellWidth,
      height: cellHeight,
      labelHeight
    })
    await drawDifferenceImage(context, {
      leftPath: join(input.visualDirectory, 'legacy-slides', comparison.file),
      rightPath: join(input.visualDirectory, 'slides', comparison.file),
      label: `${comparison.file} delta ${comparison.meanAbsoluteChannelDelta?.toFixed(2) ?? 'n/a'}`,
      x: gap * 3 + cellWidth * 2,
      y,
      width: cellWidth,
      height: cellHeight,
      labelHeight
    })
  }
  await writeFile(
    join(input.visualDirectory, 'r07-preview-comparison-contact-sheet.png'),
    canvas.toBuffer('image/png'),
    { mode: 0o600 }
  )
}

async function drawLabeledImage(
  context: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  input: {
    path: string
    label: string
    x: number
    y: number
    width: number
    height: number
    labelHeight: number
  }
): Promise<void> {
  const image = await loadImage(input.path)
  context.drawImage(image, input.x, input.y + input.labelHeight, input.width, input.height)
  context.fillStyle = '#111111'
  context.fillText(input.label, input.x, input.y + 16)
}

async function drawDifferenceImage(
  context: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  input: {
    leftPath: string
    rightPath: string
    label: string
    x: number
    y: number
    width: number
    height: number
    labelHeight: number
  }
): Promise<void> {
  const [left, right] = await Promise.all([loadImage(input.leftPath), loadImage(input.rightPath)])
  context.fillStyle = '#111111'
  context.fillText(input.label, input.x, input.y + 16)
  if (left.width !== right.width || left.height !== right.height) {
    context.fillStyle = '#f3f4f6'
    context.fillRect(input.x, input.y + input.labelHeight, input.width, input.height)
    context.fillStyle = '#991b1b'
    context.fillText('dimension mismatch', input.x + 12, input.y + input.labelHeight + 32)
    return
  }
  const diffCanvas = createCanvas(left.width, left.height)
  const diffContext = diffCanvas.getContext('2d')
  diffContext.drawImage(left, 0, 0)
  const leftData = diffContext.getImageData(0, 0, left.width, left.height)
  diffContext.clearRect(0, 0, left.width, left.height)
  diffContext.drawImage(right, 0, 0)
  const rightData = diffContext.getImageData(0, 0, right.width, right.height).data
  for (let offset = 0; offset < leftData.data.length; offset += 4) {
    leftData.data[offset] = Math.abs((leftData.data[offset] ?? 0) - (rightData[offset] ?? 0))
    leftData.data[offset + 1] = Math.abs(
      (leftData.data[offset + 1] ?? 0) - (rightData[offset + 1] ?? 0)
    )
    leftData.data[offset + 2] = Math.abs(
      (leftData.data[offset + 2] ?? 0) - (rightData[offset + 2] ?? 0)
    )
    leftData.data[offset + 3] = 255
  }
  diffContext.putImageData(leftData, 0, 0)
  context.drawImage(diffCanvas, input.x, input.y + input.labelHeight, input.width, input.height)
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
