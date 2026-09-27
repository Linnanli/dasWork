import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ARTIFACT_PREVIEW_API_VERSION,
  artifactPresentationRenderResultSchema,
  type ArtifactPresentationRenderResult
} from '../../shared/artifactPreviewApi'
import type { WorkspaceDependencyLoadResult } from '../primaryRuntime'
import type { ArtifactPreviewSourceService } from './ArtifactPreviewSourceService'

const PRESENTATION_RENDER_TIMEOUT_MS = 45_000
const PRESENTATION_RENDER_MAX_OUTPUT_BYTES = 64 * 1024
const PRESENTATION_RENDER_MAX_SLIDES = 30
const PRESENTATION_RENDER_SLIDE_PROBE_LIMIT = PRESENTATION_RENDER_MAX_SLIDES + 1
const PRESENTATION_RENDER_MAX_PNG_BYTES = 30 * 1024 * 1024

type ProcessResult = {
  stdout: string
  stderr: string
}

type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    maxOutputBytes: number
  }
) => Promise<ProcessResult>

export type PresentationArtifactPreviewServiceOptions = {
  artifacts: Pick<ArtifactPreviewSourceService, 'readBinary'>
  loadDependencies(): Promise<WorkspaceDependencyLoadResult>
  runProcess?: ProcessRunner
  createTempDirectory?: () => Promise<string>
}

export class PresentationArtifactPreviewService {
  private readonly runProcess: ProcessRunner
  private readonly createTempDirectory: () => Promise<string>

  constructor(private readonly options: PresentationArtifactPreviewServiceOptions) {
    this.runProcess = options.runProcess ?? runProcess
    this.createTempDirectory =
      options.createTempDirectory ?? (() => mkdtemp(join(tmpdir(), 'dascowork-presentation-')))
  }

  async render(sourceId: string): Promise<ArtifactPresentationRenderResult> {
    const source = await this.options.artifacts.readBinary(sourceId)
    if ('unavailable' in source) {
      throw new Error(`Artifact source is unavailable: ${source.unavailable}`)
    }
    if (source.content.kind === 'too-large') {
      throw new Error(
        `Presentation artifact is too large to render (${source.content.size} bytes, limit ${source.content.limit} bytes).`
      )
    }

    const dependencies = await this.options.loadDependencies()
    const soffice = dependencies.binaries.soffice
    const pdftoppm = dependencies.binaries.pdftoppm
    if (!soffice || !pdftoppm) {
      throw new Error(
        'Primary Runtime is missing required presentation preview binaries: soffice, pdftoppm.'
      )
    }

    const root = await this.createTempDirectory()
    try {
      const inputPath = join(root, 'source.pptx')
      const outputDirectory = join(root, 'output')
      const profileDirectory = join(root, 'libreoffice-profile')
      const slidesDirectory = join(root, 'slides')
      await Promise.all([mkdir(outputDirectory), mkdir(profileDirectory), mkdir(slidesDirectory)])
      await writeFile(inputPath, Buffer.from(source.content.base64, 'base64'))

      await this.runProcess(
        soffice,
        [
          '--headless',
          '--nologo',
          '--nodefault',
          '--nofirststartwizard',
          '--norestore',
          `-env:UserInstallation=${pathToFileURL(profileDirectory).toString()}`,
          '--convert-to',
          'pdf',
          '--outdir',
          outputDirectory,
          inputPath
        ],
        processOptions(root)
      )

      const pdfPath = await findConvertedPdf(outputDirectory)
      const slidePrefix = join(slidesDirectory, 'slide')
      await this.runProcess(
        pdftoppm,
        [
          '-png',
          '-r',
          '144',
          '-f',
          '1',
          '-l',
          String(PRESENTATION_RENDER_SLIDE_PROBE_LIMIT),
          pdfPath,
          slidePrefix
        ],
        processOptions(root)
      )

      const slides = await readRenderedSlides(slidesDirectory)
      if (slides.length === 0) throw new Error('Presentation renderer produced no slide images.')

      return artifactPresentationRenderResultSchema.parse({
        version: ARTIFACT_PREVIEW_API_VERSION,
        sourceId,
        generation: source.content.generation,
        slides
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function findConvertedPdf(outputDirectory: string): Promise<string> {
  const files = await readdir(outputDirectory)
  const pdfs = files.filter((file) => file.toLowerCase().endsWith('.pdf')).sort()
  if (pdfs.length === 0)
    throw new Error('LibreOffice did not produce a PDF for presentation preview.')
  return join(outputDirectory, pdfs[0])
}

async function readRenderedSlides(
  slidesDirectory: string
): Promise<ArtifactPresentationRenderResult['slides']> {
  const files = await readdir(slidesDirectory)
  const slides = files
    .map((file) => ({ file, number: slideNumber(file) }))
    .filter((entry): entry is { file: string; number: number } => entry.number !== null)
    .sort((left, right) => left.number - right.number)

  if (slides.length > PRESENTATION_RENDER_MAX_SLIDES) {
    throw new Error(
      `Presentation preview supports at most ${PRESENTATION_RENDER_MAX_SLIDES} slides.`
    )
  }

  for (const [index, slide] of slides.entries()) {
    if (slide.number !== index + 1) {
      throw new Error('Presentation renderer produced non-contiguous slide images.')
    }
  }

  let totalBytes = 0
  for (const { file } of slides) {
    totalBytes += (await stat(join(slidesDirectory, file))).size
    if (totalBytes > PRESENTATION_RENDER_MAX_PNG_BYTES) {
      throw new Error(
        `Presentation preview images exceed ${PRESENTATION_RENDER_MAX_PNG_BYTES} bytes.`
      )
    }
  }

  return Promise.all(
    slides.map(async ({ file, number }) => ({
      number,
      base64: (await readFile(join(slidesDirectory, file))).toString('base64')
    }))
  )
}

function slideNumber(file: string): number | null {
  const match = /^slide-(\d+)\.png$/u.exec(file)
  if (!match) return null
  return Number.parseInt(match[1], 10)
}

function processOptions(root: string): Parameters<ProcessRunner>[2] {
  return {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      TMPDIR: root,
      TEMP: root,
      TMP: root
    },
    timeoutMs: PRESENTATION_RENDER_TIMEOUT_MS,
    maxOutputBytes: PRESENTATION_RENDER_MAX_OUTPUT_BYTES
  }
}

function runProcess(
  command: string,
  args: readonly string[],
  options: Parameters<ProcessRunner>[2]
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    const invocationId = randomUUID()
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(
        new Error(`${basename(command)} timed out while rendering presentation (${invocationId}).`)
      )
    }, options.timeoutMs)
    const collect = (chunk: Buffer, current: string): string => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next) > options.maxOutputBytes) {
        child.kill('SIGKILL')
        throw new Error(`${basename(command)} exceeded presentation render output limit.`)
      }
      return next
    }
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdout = collect(chunk, stdout)
      } catch (error) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        stderr = collect(chunk, stderr)
      } catch (error) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      }
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (exitCode === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          `${basename(command)} failed while rendering presentation with exit code ${exitCode ?? 'unknown'}: ${stderr || stdout}`.trim()
        )
      )
    })
  })
}
