import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { createCanvas } from '@napi-rs/canvas'
import { expect, type Page } from '@playwright/test'
import JSZip from 'jszip'

import { appRoot, e2eTempRoot } from './app'
import {
  assertR07ChartLabelMetrics,
  measureR07RenderedSlide,
  type R07ChartLabelRatios,
  type R07RenderMetricOptions,
  type R07SlideMetrics
} from './r07RenderMetrics'

const execFile = promisify(execFileCallback)
const r07AssertionTimeoutMs = 120_000
const fixtureDirectory = join(appRoot, 'tests', 'fixtures', 'presentations')
const expectedPath = join(fixtureDirectory, 'ai-agent-security-market.expected.json')

export type R07Fact = {
  id: string
  value: string
}

export type R07PageType = {
  id: 'cover' | 'agenda' | 'summary' | 'table' | 'chart' | 'image'
  titleToken: string
}

export type R07PresentationFixture = {
  inputFile: string
  outputFile: string
  expectedPageTypes: readonly R07PageType[]
  requiredChineseFont: string
  requiredImageAltText: string
  facts: readonly R07Fact[]
  html: string
}

export type R07PresentationWorkspace = R07PresentationFixture & {
  root: string
  imageFile: string
  layoutReceiptFile: string
  renderedSlidesDirectory: string
  contactSheetFile: string
}

export type R07RenderedSlideMetric = {
  file: string
  width: number
  height: number
  nonWhiteRatio: number
  colorBucketCount: number
  chartLabelRatios?: R07ChartLabelRatios
  sha256?: string
  source?: {
    kind: 'electron-host-preview'
    artifactSourceId: string
    receiptId: string
    generation: number
    presentationSha256: string
  }
}

export type R07RenderQaReceipt = {
  schemaVersion: 'dascowork-r07-render-qa.v1'
  slides: R07RenderedSlideMetric[]
}

export async function withR07PresentationWorkspace(
  run: (workspace: R07PresentationWorkspace) => Promise<void>
): Promise<void> {
  // This workspace is passed to Runtime-owned Python and office tools on
  // Windows; keep its root short enough for the nested command arguments.
  const root = await mkdtemp(join(e2eTempRoot(), 'dsc-r07-'))
  const fixture = await readR07PresentationFixture()
  const imageFile = 'ai-agent-security-control.png'
  const workspace: R07PresentationWorkspace = {
    ...fixture,
    root,
    imageFile,
    layoutReceiptFile: 'r07-layout-receipt.json',
    renderedSlidesDirectory: 'r07-rendered-slides',
    contactSheetFile: 'r07-contact-sheet.png'
  }
  try {
    await Promise.all([
      writeFile(join(root, fixture.inputFile), fixture.html, 'utf8'),
      // This is a workspace input image, not a pre-generated presentation or
      // renderer output. The locked plugin owns the only PPTX creation path.
      writeFile(join(root, imageFile), controlFlowPng())
    ])
    await run(workspace)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function readR07PresentationFixture(): Promise<R07PresentationFixture> {
  const expected = JSON.parse(
    await readFile(expectedPath, 'utf8')
  ) as Partial<R07PresentationFixture> & { schemaVersion?: unknown }
  if (
    expected.schemaVersion !== 'dascowork-r07-presentations-expected.v2' ||
    typeof expected.inputFile !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]*\.html$/u.test(expected.inputFile) ||
    typeof expected.outputFile !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]*\.pptx$/u.test(expected.outputFile) ||
    !Array.isArray(expected.expectedPageTypes) ||
    !hasR07PageTypes(expected.expectedPageTypes) ||
    typeof expected.requiredChineseFont !== 'string' ||
    expected.requiredChineseFont.length === 0 ||
    typeof expected.requiredImageAltText !== 'string' ||
    expected.requiredImageAltText.length === 0 ||
    !Array.isArray(expected.facts) ||
    expected.facts.length < 4 ||
    !expected.facts.every(
      (fact) =>
        fact !== null &&
        typeof fact === 'object' &&
        typeof fact.id === 'string' &&
        typeof fact.value === 'string' &&
        fact.id.length > 0 &&
        fact.value.length > 0
    )
  ) {
    throw new Error('R07 presentation fixture has an invalid schema.')
  }
  return {
    inputFile: expected.inputFile,
    outputFile: expected.outputFile,
    expectedPageTypes: expected.expectedPageTypes,
    requiredChineseFont: expected.requiredChineseFont,
    requiredImageAltText: expected.requiredImageAltText,
    facts: expected.facts,
    html: await readFile(join(fixtureDirectory, expected.inputFile), 'utf8')
  }
}

export async function verifyR07Presentation(path: string): Promise<void> {
  const reportPath = join(dirname(path), '.r07-presentation-verification.json')
  try {
    const { stdout } = await execFile(process.execPath, [
      join(appRoot, 'scripts', 'verify-live-presentation-artifact.mjs'),
      '--input',
      path,
      '--expected',
      expectedPath,
      '--report',
      reportPath
    ])
    const report = JSON.parse(stdout) as {
      schemaVersion?: string
      status?: string
      artifact?: { sha256?: string }
      slides?: {
        count?: number
        hasTable?: boolean
        hasChart?: boolean
        hasImage?: boolean
        hasChineseFont?: boolean
      }
    }
    expect(report.schemaVersion).toBe('dascowork-live-presentation-artifact-report.v1')
    expect(report.status).toBe('passed')
    expect(report.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(report.slides?.count).toBeGreaterThanOrEqual(6)
    expect(report.slides).toMatchObject({
      hasTable: true,
      hasChart: true,
      hasImage: true,
      hasChineseFont: true
    })
  } catch (error) {
    const diagnostics = await readPptxRelationshipDiagnostics(path).catch(
      (diagnosticError: unknown) => ({
        diagnosticError:
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
      })
    )
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\nPPTX relationship diagnostics: ${JSON.stringify(diagnostics)}`)
  } finally {
    await rm(reportPath, { force: true })
  }
}

export async function verifyR07RenderedSlides(
  workspace: R07PresentationWorkspace
): Promise<R07RenderQaReceipt> {
  const renderedRoot = join(workspace.root, workspace.renderedSlidesDirectory)
  const slideFiles = (await readdir(renderedRoot))
    .filter((name) => /^slide-\d+\.png$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
  expect(slideFiles).toEqual(
    Array.from({ length: 6 }, (_, index) => `slide-${String(index + 1).padStart(2, '0')}.png`)
  )

  const metrics = await Promise.all(
    slideFiles.map(async (file) => ({
      file,
      ...(await renderedSlideMetrics(join(renderedRoot, file)))
    }))
  )
  for (const [index, metric] of metrics.entries()) {
    expect(metric, `slide-${index + 1} render should not be a blank placeholder`).toMatchObject({
      width: expect.any(Number),
      height: expect.any(Number)
    })
    expect(metric.width).toBeGreaterThanOrEqual(900)
    expect(metric.height).toBeGreaterThanOrEqual(500)
    expect(metric.nonWhiteRatio).toBeGreaterThan(0.01)
    expect(metric.colorBucketCount).toBeGreaterThan(12)
    if (metric.file === 'slide-05.png') {
      expect(() => assertR07ChartLabelMetrics(metric)).not.toThrow()
    }
  }
  return {
    schemaVersion: 'dascowork-r07-render-qa.v1',
    slides: metrics
  }
}

export async function renderedSlideMetrics(
  path: string,
  options: R07RenderMetricOptions = {}
): Promise<R07SlideMetrics> {
  return measureR07RenderedSlide(path, {
    includeChartLabelRatios: options.includeChartLabelRatios ?? basename(path) === 'slide-05.png'
  })
}

async function readPptxRelationshipDiagnostics(path: string): Promise<{
  chartParts: string[]
  mediaParts: string[]
  slides: Array<{
    path: string
    chartTags: string[]
    chartRelationshipIds: string[]
    chartRelationships: Array<{ id: string | null; target: string | null }>
    imageTags: string[]
    imageRelationshipIds: string[]
    imageRelationships: Array<{ id: string | null; target: string | null }>
    imageDescriptions: string[]
  }>
}> {
  const archive = await JSZip.loadAsync(await readFile(path))
  const paths = Object.keys(archive.files)
  const slidePaths = paths
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/u.test(entry))
    .sort((left, right) => left.localeCompare(right, 'en'))

  return {
    chartParts: paths.filter((entry) => /^ppt\/charts\/chart\d+\.xml$/u.test(entry)).sort(),
    mediaParts: paths.filter((entry) => /^ppt\/media\//u.test(entry)).sort(),
    slides: await Promise.all(
      slidePaths.map(async (slidePath) => {
        const slideXml = await archive.file(slidePath)?.async('string')
        const relationshipsPath = join('ppt', 'slides', '_rels', `${basename(slidePath)}.rels`)
        const relationshipsXml = await archive.file(relationshipsPath)?.async('string')
        const chartTags = [...(slideXml ?? '').matchAll(/<[^>]*:chart\b[^>]*>/gu)].map(
          (match) => match[0]
        )
        const chartRelationshipIds = chartTags
          .map((tag) => readXmlAttribute(tag, 'r:id'))
          .filter((id): id is string => id !== null)
        const chartRelationships = [...(relationshipsXml ?? '').matchAll(/<Relationship\b[^>]*>/gu)]
          .filter((tag) => /\/chart(?:["']|\s|$)/u.test(tag[0]))
          .map((tag) => ({
            id: readXmlAttribute(tag[0], 'Id'),
            target: readXmlAttribute(tag[0], 'Target')
          }))
        const imageTags = [...(slideXml ?? '').matchAll(/<a:blip\b[^>]*>/gu)].map(
          (match) => match[0]
        )
        const imageRelationshipIds = imageTags
          .map((tag) => readXmlAttribute(tag, 'r:embed'))
          .filter((id): id is string => id !== null)
        const imageRelationships = [...(relationshipsXml ?? '').matchAll(/<Relationship\b[^>]*>/gu)]
          .filter((tag) => /\/image(?:["']|\s|$)/u.test(tag[0]))
          .map((tag) => ({
            id: readXmlAttribute(tag[0], 'Id'),
            target: readXmlAttribute(tag[0], 'Target')
          }))
        const imageDescriptions = [...(slideXml ?? '').matchAll(/<p:cNvPr\b[^>]*>/gu)]
          .map((tag) => readXmlAttribute(tag[0], 'descr'))
          .filter((description): description is string => description !== null)

        return {
          path: slidePath,
          chartTags,
          chartRelationshipIds,
          chartRelationships,
          imageTags,
          imageRelationshipIds,
          imageRelationships,
          imageDescriptions
        }
      })
    )
  }
}

function readXmlAttribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(tag)?.[1] ?? null
}

export async function openR07PresentationInWorkspace(
  page: Page,
  outputFile: string
): Promise<void> {
  const openWorkspace = page.getByRole('button', { name: '打开工作区', exact: true })
  const closeWorkspace = page.getByRole('button', { name: '关闭工作区', exact: true })
  if (await openWorkspace.isVisible().catch(() => false)) await openWorkspace.click()
  await expect(closeWorkspace).toBeVisible({ timeout: r07AssertionTimeoutMs })

  const rightPanel = page.locator('[data-slot="right-workspace-shell"]')
  await page.getByRole('button', { name: 'Open Files', exact: true }).click()
  const presentationFile = rightPanel.getByRole('treeitem', { name: outputFile, exact: true })
  await expect(presentationFile).toBeVisible({ timeout: r07AssertionTimeoutMs })
  await presentationFile.click()
  await expect(
    rightPanel.locator(`[role="tab"][data-workspace-tab-id="artifact:workspace:${outputFile}"]`)
  ).toBeVisible()
  await expect(rightPanel.locator('[data-slot="artifact-tab-content"]')).toBeVisible()
  // Main permits up to 120 seconds for a complete multi-slide render. Wait
  // for that result rather than applying Playwright's 20-second UI default.
  await expect(rightPanel.locator('[data-slot="presentation-panel"]')).toBeVisible({
    timeout: r07AssertionTimeoutMs
  })
  await expect(rightPanel.locator('[data-slot="presentation-panel"]')).toContainText('1 / 6')
}

function hasR07PageTypes(value: unknown[]): value is R07PageType[] {
  const expectedIds = ['agenda', 'chart', 'cover', 'image', 'summary', 'table']
  return (
    value.every(
      (pageType) =>
        pageType !== null &&
        typeof pageType === 'object' &&
        expectedIds.includes((pageType as { id?: string }).id ?? '') &&
        typeof (pageType as { titleToken?: unknown }).titleToken === 'string' &&
        (pageType as { titleToken: string }).titleToken.length > 0
    ) &&
    [...value.map((pageType) => (pageType as { id: string }).id)].sort().join(',') ===
      expectedIds.join(',')
  )
}

function controlFlowPng(): Buffer {
  const canvas = createCanvas(960, 540)
  const context = canvas.getContext('2d')
  context.fillStyle = '#F8FAFC'
  context.fillRect(0, 0, 960, 540)

  context.fillStyle = '#0F172A'
  context.font = 'bold 34px sans-serif'
  context.fillText('AI Agent Tool Control Flow', 72, 72)
  context.fillStyle = '#475569'
  context.font = '22px sans-serif'
  context.fillText('Policy check -> Approval -> Isolated run -> Audit replay', 72, 112)

  const steps = [
    { title: 'Request', body: 'Intent + context', x: 70, fill: '#DBEAFE', stroke: '#2563EB' },
    { title: 'Policy', body: 'Risk + scope', x: 280, fill: '#DCFCE7', stroke: '#16A34A' },
    { title: 'Approval', body: 'High-risk tools', x: 490, fill: '#FEF3C7', stroke: '#D97706' },
    { title: 'Audit', body: 'Args + owner', x: 700, fill: '#F3E8FF', stroke: '#7E22CE' }
  ]

  for (const step of steps) {
    roundRect(context, step.x, 180, 170, 160, 18)
    context.fillStyle = step.fill
    context.fill()
    context.lineWidth = 4
    context.strokeStyle = step.stroke
    context.stroke()
    context.fillStyle = '#0F172A'
    context.font = 'bold 24px sans-serif'
    context.fillText(step.title, step.x + 26, 235)
    context.fillStyle = '#334155'
    context.font = '19px sans-serif'
    context.fillText(step.body, step.x + 20, 280)
  }

  context.strokeStyle = '#64748B'
  context.fillStyle = '#64748B'
  context.lineWidth = 5
  for (const x of [240, 450, 660]) drawArrow(context, x, 260, x + 55, 260)

  context.fillStyle = '#E2E8F0'
  roundRect(context, 155, 385, 650, 70, 16)
  context.fill()
  context.strokeStyle = '#94A3B8'
  context.lineWidth = 2
  context.stroke()
  context.fillStyle = '#1E293B'
  context.font = '20px sans-serif'
  context.fillText('Goal: block unsafe tools; keep replayable approval evidence', 188, 429)

  return canvas.toBuffer('image/png')
}

function roundRect(
  context: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
  context.closePath()
}

function drawArrow(
  context: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): void {
  context.beginPath()
  context.moveTo(fromX, fromY)
  context.lineTo(toX, toY)
  context.stroke()
  context.beginPath()
  context.moveTo(toX, toY)
  context.lineTo(toX - 16, toY - 10)
  context.lineTo(toX - 16, toY + 10)
  context.closePath()
  context.fill()
}
