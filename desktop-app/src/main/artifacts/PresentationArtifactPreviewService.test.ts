import { access, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ARTIFACT_PREVIEW_API_VERSION,
  ARTIFACT_PREVIEW_MAX_BYTES,
  artifactPresentationRenderResultSchema
} from '../../shared/artifactPreviewApi'
import { PresentationArtifactPreviewService } from './PresentationArtifactPreviewService'

const sourceId = 'sourceid123456789'
const tempDirectories: string[] = []
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const previewHtml =
  '<!DOCTYPE html><html><head><style>.slide{width:1920px}</style></head><body><div class="slide">中文</div></body></html>'
const fontBytes = Buffer.from('verified runtime font')
type ServiceOptions = ConstructorParameters<typeof PresentationArtifactPreviewService>[0]

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('PresentationArtifactPreviewService', () => {
  it.each([1, 30])(
    'exports %i slides in one HTML operation and embeds the Runtime font once',
    async (slideCount) => {
      const root = await tempDirectory()
      const runProcess = vi.fn(htmlRunner(slideCount))
      const service = createService({ runProcess, createTempDirectory: async () => root })

      const result = await service.render(sourceId)
      expect(result).toMatchObject({
        version: ARTIFACT_PREVIEW_API_VERSION,
        sourceId,
        generation: 7,
        slideCount
      })
      expect('html' in result).toBe(true)
      if (!('html' in result)) throw new Error('Expected HTML preview')
      expect(result.html).toContain('.slide{width:1920px}')
      expect(result.html).toContain('<div class="slide">中文</div>')
      expect(result.html.match(/data-dascowork-preview-font/gu)).toHaveLength(1)
      expect(result.html).toContain(`data:font/otf;base64,${fontBytes.toString('base64')}`)
      expect(result.html.indexOf('@font-face')).toBeLessThan(result.html.indexOf('</head>'))
      expect(runProcess).toHaveBeenCalledTimes(2)
      expect(runProcess).toHaveBeenNthCalledWith(
        1,
        '/runtime/officecli',
        ['view', join(root, 'source.pptx'), 'stats', '--json'],
        expect.objectContaining({
          cwd: root,
          maxOutputBytes: 8 * 1024 * 1024,
          env: expect.objectContaining({
            OFFICECLI_SKIP_UPDATE: '1',
            OFFICECLI_NO_AUTO_RESIDENT: '1',
            XDG_CACHE_HOME: join(root, 'xdg-cache'),
            XDG_CONFIG_HOME: join(root, 'xdg-config'),
            XDG_DATA_HOME: join(root, 'xdg-data')
          })
        })
      )
      expect(runProcess).toHaveBeenNthCalledWith(
        2,
        '/runtime/officecli',
        ['view', join(root, 'source.pptx'), 'html', '--out', join(root, 'preview.html')],
        expect.objectContaining({ timeoutMs: expect.any(Number) })
      )
      await expect(access(root)).rejects.toThrow()
    }
  )

  it('requires OfficeCLI from the healthy Primary Runtime', async () => {
    const service = createService({ binaries: {} })
    await expect(service.render(sourceId)).rejects.toThrow('preview binary: officecli')
  })

  it('requires the verified Runtime Chinese font before exporting HTML', async () => {
    const runProcess = vi.fn()
    const service = createService({ fonts: {}, runProcess })
    await expect(service.render(sourceId)).rejects.toThrow('preview font: noto-sans-cjk-sc')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('preserves the LibreOffice PNG preview path for rollback archives', async () => {
    const runProcess = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === '/runtime/soffice') {
        const outputDirectory = args[args.indexOf('--outdir') + 1]
        await writeFile(join(outputDirectory, 'source.pdf'), 'pdf')
      } else {
        const prefix = args[args.length - 1]
        await mkdir(join(prefix, '..'), { recursive: true })
        await writeFile(`${prefix}-1.png`, pngSignature)
      }
      return { stdout: '', stderr: '' }
    })
    const service = createService({
      binaries: { soffice: '/runtime/soffice', pdftoppm: '/runtime/pdftoppm' },
      fonts: {},
      runProcess
    })

    await expect(service.render(sourceId)).resolves.toMatchObject({
      generation: 7,
      slides: [{ number: 1, base64: pngSignature.toString('base64') }]
    })
    expect(runProcess).toHaveBeenCalledWith(
      '/runtime/pdftoppm',
      expect.arrayContaining(['-png', '-l', '31']),
      expect.any(Object)
    )
  })

  it('does not call the runtime for unavailable or oversized artifact bytes', async () => {
    const loadDependencies = vi.fn()
    const unavailable = new PresentationArtifactPreviewService({
      artifacts: { readBinary: async () => ({ version: 1, sourceId, unavailable: 'expired' }) },
      loadDependencies
    })
    await expect(unavailable.render(sourceId)).rejects.toThrow('Artifact source is unavailable')

    const oversized = new PresentationArtifactPreviewService({
      artifacts: {
        readBinary: async () => ({
          version: 1,
          sourceId,
          content: {
            kind: 'too-large',
            size: ARTIFACT_PREVIEW_MAX_BYTES + 1,
            limit: ARTIFACT_PREVIEW_MAX_BYTES,
            generation: 2
          }
        })
      },
      loadDependencies
    })
    await expect(oversized.render(sourceId)).rejects.toThrow('Presentation artifact is too large')
    expect(loadDependencies).not.toHaveBeenCalled()
  })

  it.each([
    'not json',
    '{"success":false}',
    '{"success":true,"data":{"slides":0}}',
    '{"success":true,"data":{"slides":1.5}}'
  ])('rejects malformed or failed statistics before exporting HTML: %s', async (stdout) => {
    const runProcess = vi.fn(async () => ({ stdout, stderr: '' }))
    await expect(createService({ runProcess }).render(sourceId)).rejects.toThrow(/OfficeCLI/)
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('rejects decks over the slide limit before exporting HTML', async () => {
    const runProcess = vi.fn(htmlRunner(31))
    await expect(createService({ runProcess }).render(sourceId)).rejects.toThrow(
      'Presentation preview supports at most 30 slides.'
    )
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed HTML and removes the temporary deck on failure', async () => {
    const root = await tempDirectory()
    const service = createService({
      runProcess: htmlRunner(1, 'not html'),
      createTempDirectory: async () => root
    })
    await expect(service.render(sourceId)).rejects.toThrow('valid presentation HTML document')
    await expect(access(root)).rejects.toThrow()
  })

  it('rejects a missing exported HTML file', async () => {
    const service = createService({
      runProcess: async () => ({
        stdout: JSON.stringify({ success: true, data: { slides: 1 } }),
        stderr: ''
      })
    })
    await expect(service.render(sourceId)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds the raw exported HTML file before reading it', async () => {
    const service = createService({
      runProcess: async (_command, args) => {
        if (!args.includes('stats')) {
          const output = args[args.indexOf('--out') + 1]
          await writeFile(output, '')
          await truncate(output, 30 * 1024 * 1024 + 1)
        }
        return { stdout: JSON.stringify({ success: true, data: { slides: 1 } }), stderr: '' }
      }
    })
    await expect(service.render(sourceId)).rejects.toThrow('HTML exceeds 31457280 bytes')
  })

  it('rejects missing, empty and oversized Runtime font bytes', async () => {
    const root = await tempDirectory()
    const fontPath = join(root, 'noto.otf')
    const service = createService({ fonts: { 'noto-sans-cjk-sc': fontPath } })
    await expect(service.render(sourceId)).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(fontPath, '')
    await expect(service.render(sourceId)).rejects.toThrow('font is empty')
    await truncate(fontPath, 32 * 1024 * 1024 + 1)
    await expect(service.render(sourceId)).rejects.toThrow('font exceeds 33554432 bytes')
  })

  it('bounds the final HTML including the single embedded font', async () => {
    const root = await tempDirectory()
    const fontPath = join(root, 'noto.otf')
    await writeFile(fontPath, '')
    await truncate(fontPath, 16 * 1024 * 1024)
    const html = previewHtml.replace('中文', 'a'.repeat(29 * 1024 * 1024))
    const service = createService({
      fonts: { 'noto-sans-cjk-sc': fontPath },
      runProcess: htmlRunner(1, html)
    })
    await expect(service.render(sourceId)).rejects.toThrow('HTML with font exceeds 50331648 bytes')
  })

  it('removes temporary files when the HTML export process fails', async () => {
    const root = await tempDirectory()
    const service = createService({
      createTempDirectory: async () => root,
      runProcess: async (_command, args) => {
        if (args.includes('html')) throw new Error('OfficeCLI export failed')
        return { stdout: JSON.stringify({ success: true, data: { slides: 1 } }), stderr: '' }
      }
    })
    await expect(service.render(sourceId)).rejects.toThrow('OfficeCLI export failed')
    await expect(access(root)).rejects.toThrow()
  })

  it('accepts only the strict HTML or legacy PNG result contract', () => {
    const common = { version: ARTIFACT_PREVIEW_API_VERSION, sourceId, generation: 7 }
    const html = { ...common, html: previewHtml, slideCount: 1 }
    const slides = { ...common, slides: [{ number: 1, base64: pngSignature.toString('base64') }] }
    expect(artifactPresentationRenderResultSchema.safeParse(html).success).toBe(true)
    expect(artifactPresentationRenderResultSchema.safeParse(slides).success).toBe(true)
    expect(
      artifactPresentationRenderResultSchema.safeParse({ ...html, slides: slides.slides }).success
    ).toBe(false)
    expect(
      artifactPresentationRenderResultSchema.safeParse({ ...html, slideCount: 31 }).success
    ).toBe(false)
    expect(artifactPresentationRenderResultSchema.safeParse({ ...html, html: '' }).success).toBe(
      false
    )
  })
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-presentation-preview-test-'))
  tempDirectories.push(directory)
  return directory
}

function htmlRunner(slideCount = 1, html = previewHtml): NonNullable<ServiceOptions['runProcess']> {
  return async (_command, args) => {
    if (args.includes('stats')) {
      return { stdout: JSON.stringify({ success: true, data: { slides: slideCount } }), stderr: '' }
    }
    const output = args[args.indexOf('--out') + 1]
    await writeFile(output, html)
    return { stdout: output, stderr: '' }
  }
}

function createService(
  input: {
    binaries?: Record<string, string>
    fonts?: Record<string, string>
    runProcess?: ServiceOptions['runProcess']
    createTempDirectory?: () => Promise<string>
  } = {}
): PresentationArtifactPreviewService {
  return new PresentationArtifactPreviewService({
    artifacts: {
      readBinary: async () => ({
        version: ARTIFACT_PREVIEW_API_VERSION,
        sourceId,
        content: {
          kind: 'binary',
          encoding: 'base64',
          base64: Buffer.from('pptx bytes').toString('base64'),
          checksum: 'a'.repeat(64),
          generation: 7
        }
      })
    },
    loadDependencies: async () => {
      let fonts = input.fonts
      if (!fonts) {
        const fontPath = join(await tempDirectory(), 'noto.otf')
        await writeFile(fontPath, fontBytes)
        fonts = { 'noto-sans-cjk-sc': fontPath }
      }
      return {
        bundleVersion: 'test-runtime',
        node: '/runtime/node',
        nodeModules: '/runtime/node_modules',
        binaries: input.binaries ?? { officecli: '/runtime/officecli' },
        fonts,
        text: ''
      }
    },
    runProcess: input.runProcess ?? htmlRunner(),
    createTempDirectory: input.createTempDirectory ?? tempDirectory
  })
}
