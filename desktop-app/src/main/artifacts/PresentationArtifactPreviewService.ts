import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  ARTIFACT_PREVIEW_API_VERSION,
  artifactPresentationRenderResultSchema,
  type ArtifactPresentationRenderResult
} from '../../shared/artifactPreviewApi'
import type { WorkspaceDependencyLoadResult } from '../primaryRuntime'
import type { ArtifactPreviewSourceService } from './ArtifactPreviewSourceService'
import { renderLegacyPresentation } from './renderLegacyPresentation'
import { rasterizePresentationSvg } from './rasterizePresentationSvg'

const PRESENTATION_RENDER_TIMEOUT_MS = 45_000
const PRESENTATION_RENDER_TOTAL_TIMEOUT_MS = 120_000
const PRESENTATION_RENDER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const PRESENTATION_RENDER_MAX_SLIDES = 30
const PRESENTATION_RENDER_MAX_PNG_BYTES = 30 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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
  rasterizeSvg?: (svg: string, timeoutMs: number) => Promise<Buffer>
  createTempDirectory?: () => Promise<string>
}

export class PresentationArtifactPreviewService {
  private readonly runProcess: ProcessRunner
  private readonly rasterizeSvg: (svg: string, timeoutMs: number) => Promise<Buffer>
  private readonly createTempDirectory: () => Promise<string>

  constructor(private readonly options: PresentationArtifactPreviewServiceOptions) {
    this.runProcess = options.runProcess ?? runProcess
    this.rasterizeSvg = options.rasterizeSvg ?? rasterizePresentationSvg
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
    const officecli = dependencies.binaries.officecli
    const legacyBinaries =
      !officecli && dependencies.binaries.soffice && dependencies.binaries.pdftoppm
        ? {
            soffice: dependencies.binaries.soffice,
            pdftoppm: dependencies.binaries.pdftoppm
          }
        : undefined
    if (!officecli && !legacyBinaries) {
      throw new Error(
        'Primary Runtime is missing the required presentation preview binary: officecli.'
      )
    }

    const root = await this.createTempDirectory()
    const deadline = Date.now() + PRESENTATION_RENDER_TOTAL_TIMEOUT_MS
    try {
      const inputPath = join(root, 'source.pptx')
      await writeFile(inputPath, Buffer.from(source.content.base64, 'base64'))
      if (legacyBinaries) {
        const slides = await renderLegacyPresentation(
          inputPath,
          root,
          legacyBinaries,
          (command, args) => this.runProcess(command, args, processOptions(root, deadline))
        )
        return artifactPresentationRenderResultSchema.parse({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId,
          generation: source.content.generation,
          slides
        })
      }

      const stats = await this.runProcess(
        officecli!,
        ['view', inputPath, 'stats', '--json'],
        processOptions(root, deadline)
      )
      const slideCount = readSlideCount(stats.stdout)
      const slides: ArtifactPresentationRenderResult['slides'] = []
      let totalPngBytes = 0
      for (let number = 1; number <= slideCount; number += 1) {
        const result = await this.runProcess(
          officecli!,
          ['view', inputPath, 'svg', '--start', String(number), '--end', String(number)],
          processOptions(root, deadline)
        )
        const png = await this.rasterizeSvg(readSlideSvg(result.stdout), remainingTime(deadline))
        if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new Error(`Presentation renderer produced an invalid PNG for slide ${number}.`)
        }
        totalPngBytes += png.byteLength
        if (totalPngBytes > PRESENTATION_RENDER_MAX_PNG_BYTES) {
          throw new Error(
            `Presentation preview images exceed ${PRESENTATION_RENDER_MAX_PNG_BYTES} bytes.`
          )
        }
        slides.push({ number, base64: png.toString('base64') })
      }

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

function readSlideCount(stdout: string): number {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('OfficeCLI returned invalid presentation statistics JSON.')
  }
  if (!value || typeof value !== 'object' || !('success' in value) || value.success !== true) {
    throw new Error('OfficeCLI could not read presentation statistics.')
  }
  const data = 'data' in value ? value.data : undefined
  const count = data && typeof data === 'object' && 'slides' in data ? data.slides : undefined
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) {
    throw new Error('OfficeCLI returned an invalid presentation slide count.')
  }
  if (count > PRESENTATION_RENDER_MAX_SLIDES) {
    throw new Error(
      `Presentation preview supports at most ${PRESENTATION_RENDER_MAX_SLIDES} slides.`
    )
  }
  return count
}

function readSlideSvg(stdout: string): string {
  const svg = stdout.trim()
  if (
    !/^<svg\s[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/u.test(svg) ||
    !svg.endsWith('</svg>')
  ) {
    throw new Error('OfficeCLI did not produce a valid presentation slide SVG.')
  }
  return svg
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('Presentation preview timed out.')
  return Math.min(remaining, PRESENTATION_RENDER_TIMEOUT_MS)
}

function processOptions(root: string, deadline: number): Parameters<ProcessRunner>[2] {
  return {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      TMPDIR: root,
      TEMP: root,
      TMP: root,
      OFFICECLI_SKIP_UPDATE: '1',
      OFFICECLI_NO_AUTO_RESIDENT: '1'
    },
    timeoutMs: remainingTime(deadline),
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
