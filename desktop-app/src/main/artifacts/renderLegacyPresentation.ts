import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ArtifactPresentationRenderResult } from '../../shared/artifactPreviewApi'

const MAX_SLIDES = 30
const MAX_PNG_BYTES = 30 * 1024 * 1024

type LegacyProcessResult = {
  stdout: string
  stderr: string
}

/** Compatibility path for already-installed v1/v2 Runtime archives during rollback. */
export async function renderLegacyPresentation(
  inputPath: string,
  root: string,
  binaries: { soffice: string; pdftoppm: string },
  runProcess: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv
  ) => Promise<LegacyProcessResult>,
  options: { chineseFontPath?: string; platform?: NodeJS.Platform } = {}
): Promise<ArtifactPresentationRenderResult['slides']> {
  const outputDirectory = join(root, 'output')
  const profileDirectory = join(root, 'libreoffice-profile')
  const slidesDirectory = join(root, 'slides')
  await Promise.all([mkdir(outputDirectory), mkdir(profileDirectory), mkdir(slidesDirectory)])
  // Match the verified v2 skill's headless and Windows profile environment.
  const platform = options.platform ?? process.platform
  const environment: NodeJS.ProcessEnv = { SAL_USE_VCLPLUGIN: 'svp' }
  if (platform === 'win32') {
    const appData = join(profileDirectory, 'AppData')
    environment.USERPROFILE = profileDirectory
    environment.APPDATA = join(appData, 'Roaming')
    environment.LOCALAPPDATA = join(appData, 'Local')
    await Promise.all([
      mkdir(environment.APPDATA, { recursive: true }),
      mkdir(environment.LOCALAPPDATA, { recursive: true })
    ])
  }
  if (platform === 'linux' && options.chineseFontPath) {
    const fontDirectory = dirname(options.chineseFontPath)
    const fontCache = join(root, 'font-cache')
    const fontConfig = join(root, 'fonts.conf')
    await mkdir(fontCache)
    await writeFile(
      fontConfig,
      `<?xml version="1.0"?><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${escapeXml(fontDirectory)}</dir><cachedir>${escapeXml(fontCache)}</cachedir></fontconfig>`
    )
    environment.FONTCONFIG_FILE = fontConfig
    environment.FONTCONFIG_PATH = fontDirectory
  }

  const conversion = await runProcess(
    binaries.soffice,
    [
      '--headless',
      '--nologo',
      '--nodefault',
      '--nofirststartwizard',
      '--norestore',
      `-env:UserInstallation=${pathToFileURL(profileDirectory).toString()}`,
      '--convert-to',
      'pdf:impress_pdf_Export',
      '--outdir',
      outputDirectory,
      inputPath
    ],
    environment
  )

  const pdfPath = await findConvertedPdf(outputDirectory, inputPath, binaries.soffice, conversion)
  const slidePrefix = join(slidesDirectory, 'slide')
  await runProcess(
    binaries.pdftoppm,
    ['-png', '-r', '144', '-f', '1', '-l', String(MAX_SLIDES + 1), pdfPath, slidePrefix],
    environment
  )
  return readRenderedSlides(slidesDirectory)
}

async function findConvertedPdf(
  outputDirectory: string,
  inputPath: string,
  sofficePath: string,
  conversion: LegacyProcessResult
): Promise<string> {
  const outputFiles = await readdir(outputDirectory)
  const outputPdfs = outputFiles.filter((file) => file.toLowerCase().endsWith('.pdf')).sort()
  if (outputPdfs.length > 0) return join(outputDirectory, outputPdfs[0])

  const siblingFiles = await readdir(dirname(inputPath)).catch(() => [])
  const programDirectory = dirname(sofficePath)
  const pythonCores = (await readdir(programDirectory).catch(() => []))
    .filter((entry) => entry.startsWith('python-core-'))
    .slice(0, 2)
  const pythonLibraries = await Promise.all(
    pythonCores.map(async (core) => {
      const library = join(programDirectory, core, 'lib', 'os.py')
      const present = await stat(library)
        .then((entry) => entry.isFile())
        .catch(() => false)
      return `${core}:os.py=${present ? 'present' : 'missing'}:pathLength=${library.length}`
    })
  )

  throw new Error(
    [
      'LibreOffice did not produce a PDF for presentation preview.',
      `outputDirectory=${outputDirectory}`,
      `outputFiles=${formatDirectoryEntries(outputFiles)}`,
      `inputDirectoryFiles=${formatDirectoryEntries(siblingFiles)}`,
      `sofficePathLength=${sofficePath.length}`,
      `pythonLibraries=${pythonLibraries.join(',') || '<none>'}`,
      `stdout=${safeProcessOutput(conversion.stdout)}`,
      `stderr=${safeProcessOutput(conversion.stderr)}`
    ].join(' ')
  )
}

async function readRenderedSlides(
  slidesDirectory: string
): Promise<ArtifactPresentationRenderResult['slides']> {
  const files = await readdir(slidesDirectory)
  const slides = files
    .map((file) => ({ file, number: slideNumber(file) }))
    .filter((entry): entry is { file: string; number: number } => entry.number !== null)
    .sort((left, right) => left.number - right.number)
  if (slides.length === 0) throw new Error('Presentation renderer produced no slide images.')
  if (slides.length > MAX_SLIDES) {
    throw new Error(`Presentation preview supports at most ${MAX_SLIDES} slides.`)
  }
  for (const [index, slide] of slides.entries()) {
    if (slide.number !== index + 1) {
      throw new Error('Presentation renderer produced non-contiguous slide images.')
    }
  }

  let totalBytes = 0
  for (const { file } of slides) {
    totalBytes += (await stat(join(slidesDirectory, file))).size
    if (totalBytes > MAX_PNG_BYTES) {
      throw new Error(`Presentation preview images exceed ${MAX_PNG_BYTES} bytes.`)
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
  return match ? Number.parseInt(match[1], 10) : null
}

function formatDirectoryEntries(entries: readonly string[]): string {
  return entries.length > 0 ? entries.slice(0, 20).join(',') : '<empty>'
}

function safeProcessOutput(value: string | undefined): string {
  const trimmed = value?.trim()
  if (!trimmed) return '<empty>'
  return JSON.stringify(trimmed.slice(-1000))
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/gu, (character) => {
    const escaped: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&apos;'
    }
    return escaped[character]
  })
}
