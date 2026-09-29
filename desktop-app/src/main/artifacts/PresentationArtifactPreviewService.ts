import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
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

const PRESENTATION_RENDER_TIMEOUT_MS = 45_000
const PRESENTATION_RENDER_TOTAL_TIMEOUT_MS = 120_000
const PRESENTATION_RENDER_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const PRESENTATION_RENDER_MAX_SLIDES = 30
const PRESENTATION_RENDER_MAX_HTML_BYTES = 30 * 1024 * 1024
const PRESENTATION_RENDER_MAX_FONT_BYTES = 32 * 1024 * 1024
const PRESENTATION_RENDER_MAX_RESULT_BYTES = 48 * 1024 * 1024

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
    const chineseFont = dependencies.fonts['noto-sans-cjk-sc']
    if (officecli && !chineseFont) {
      throw new Error(
        'Primary Runtime is missing the required presentation preview font: noto-sans-cjk-sc.'
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
          (command, args, environment) =>
            this.runProcess(command, args, processOptions(root, deadline, environment)),
          { chineseFontPath: chineseFont }
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
      const htmlPath = join(root, 'preview.html')
      await this.runProcess(
        officecli!,
        ['view', inputPath, 'html', '--out', htmlPath],
        processOptions(root, deadline)
      )
      const html = await readPresentationHtml(htmlPath, chineseFont!)
      remainingTime(deadline)

      return artifactPresentationRenderResultSchema.parse({
        version: ARTIFACT_PREVIEW_API_VERSION,
        sourceId,
        generation: source.content.generation,
        html,
        slideCount
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

async function readPresentationHtml(htmlPath: string, fontPath: string): Promise<string> {
  const html = (
    await readBoundedFile(htmlPath, PRESENTATION_RENDER_MAX_HTML_BYTES, 'Presentation preview HTML')
  ).toString('utf8')
  if (
    !/^\s*<!doctype html>/iu.test(html) ||
    !/<html\b/iu.test(html) ||
    !/<head\b/iu.test(html) ||
    !/<\/head\s*>/iu.test(html) ||
    !/<body\b/iu.test(html) ||
    !/<\/body\s*>\s*<\/html\s*>\s*$/iu.test(html)
  ) {
    throw new Error('OfficeCLI did not produce a valid presentation HTML document.')
  }
  // The verified Runtime font is embedded once for the entire deck. The isolated
  // renderer prepends this private CJK face while preserving each text's Latin font.
  const font = await readBoundedFile(
    fontPath,
    PRESENTATION_RENDER_MAX_FONT_BYTES,
    'Presentation preview font'
  )
  if (!font.byteLength) throw new Error('Presentation preview font is empty.')
  const fontStyle = `<style data-dascowork-preview-font>@font-face{font-family:"Dascowork Preview CJK";src:url("data:font/otf;base64,${font.toString('base64')}") format("opentype");font-style:normal;font-weight:400;unicode-range:U+2E80-33FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF,U+20000-2FA1F;}</style>`
  const result = html.replace(/<\/head\s*>/iu, `${fontStyle}</head>`)
  if (Buffer.byteLength(result) > PRESENTATION_RENDER_MAX_RESULT_BYTES) {
    throw new Error(
      `Presentation preview HTML with font exceeds ${PRESENTATION_RENDER_MAX_RESULT_BYTES} bytes.`
    )
  }
  return result
}

async function readBoundedFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error(`${label} is not a regular file.`)
    if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`)
    // Read at most the inspected size plus one byte, so file growth cannot turn
    // the output limit into an unbounded read.
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > info.size) throw new Error(`${label} changed while reading.`)
    return buffer.subarray(0, length)
  } finally {
    await file.close()
  }
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('Presentation preview timed out.')
  return Math.min(remaining, PRESENTATION_RENDER_TIMEOUT_MS)
}

function processOptions(
  root: string,
  deadline: number,
  environment: NodeJS.ProcessEnv = {}
): Parameters<ProcessRunner>[2] {
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
      OFFICECLI_NO_AUTO_RESIDENT: '1',
      ...environment
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
