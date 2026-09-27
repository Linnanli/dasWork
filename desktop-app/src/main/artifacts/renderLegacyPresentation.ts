import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ArtifactPresentationRenderResult } from '../../shared/artifactPreviewApi'

const MAX_SLIDES = 30
const MAX_PNG_BYTES = 30 * 1024 * 1024

/** Compatibility path for already-installed v1/v2 Runtime archives during rollback. */
export async function renderLegacyPresentation(
  inputPath: string,
  root: string,
  binaries: { soffice: string; pdftoppm: string },
  runProcess: (command: string, args: readonly string[]) => Promise<unknown>
): Promise<ArtifactPresentationRenderResult['slides']> {
  const outputDirectory = join(root, 'output')
  const profileDirectory = join(root, 'libreoffice-profile')
  const slidesDirectory = join(root, 'slides')
  await Promise.all([mkdir(outputDirectory), mkdir(profileDirectory), mkdir(slidesDirectory)])

  await runProcess(binaries.soffice, [
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
  ])

  const pdfPath = await findConvertedPdf(outputDirectory)
  const slidePrefix = join(slidesDirectory, 'slide')
  await runProcess(binaries.pdftoppm, [
    '-png',
    '-r',
    '144',
    '-f',
    '1',
    '-l',
    String(MAX_SLIDES + 1),
    pdfPath,
    slidePrefix
  ])
  return readRenderedSlides(slidesDirectory)
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
