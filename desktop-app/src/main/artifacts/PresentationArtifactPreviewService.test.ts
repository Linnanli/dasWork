import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ARTIFACT_PREVIEW_API_VERSION } from '../../shared/artifactPreviewApi'
import { PresentationArtifactPreviewService } from './PresentationArtifactPreviewService'

const tempDirectories: string[] = []
const sourceId = 'sourceid123456789'

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('PresentationArtifactPreviewService', () => {
  it('renders an authorized artifact source through Primary Runtime binaries', async () => {
    const root = await tempDirectory()
    const runProcess = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === '/runtime/soffice') {
        const outdir = args[args.indexOf('--outdir') + 1]
        await writeFile(join(outdir, 'source.pdf'), 'pdf bytes')
        return { stdout: '', stderr: '' }
      }
      if (command === '/runtime/pdftoppm') {
        const prefix = args[args.length - 1]
        await mkdir(dirname(prefix), { recursive: true })
        await writeFile(`${prefix}-1.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
        await writeFile(`${prefix}-2.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]))
        return { stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command ${command}`)
    })
    const service = new PresentationArtifactPreviewService({
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
      loadDependencies: async () => ({
        bundleVersion: 'test-runtime',
        node: '/runtime/node',
        nodeModules: '/runtime/node_modules',
        binaries: { soffice: '/runtime/soffice', pdftoppm: '/runtime/pdftoppm' },
        fonts: {},
        text: ''
      }),
      runProcess,
      createTempDirectory: async () => root
    })

    await expect(service.render(sourceId)).resolves.toEqual({
      version: ARTIFACT_PREVIEW_API_VERSION,
      sourceId,
      generation: 7,
      slides: [
        { number: 1, base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString('base64') },
        { number: 2, base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]).toString('base64') }
      ]
    })
    expect(runProcess).toHaveBeenCalledWith(
      '/runtime/soffice',
      expect.arrayContaining(['--headless', '--convert-to', 'pdf', '--outdir']),
      expect.objectContaining({ cwd: root, timeoutMs: 45_000, maxOutputBytes: 64 * 1024 })
    )
    expect(runProcess).toHaveBeenCalledWith(
      '/runtime/pdftoppm',
      expect.arrayContaining(['-png', '-f', '1', '-l', '31']),
      expect.objectContaining({ cwd: root })
    )
    await expect(access(root)).rejects.toThrow()
  })

  it('fails clearly when the Primary Runtime lacks required render binaries', async () => {
    const service = new PresentationArtifactPreviewService({
      artifacts: {
        readBinary: async () => ({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId,
          content: {
            kind: 'binary',
            encoding: 'base64',
            base64: Buffer.from('pptx bytes').toString('base64'),
            checksum: 'a'.repeat(64),
            generation: 1
          }
        })
      },
      loadDependencies: async () => ({
        bundleVersion: 'test-runtime',
        node: '/runtime/node',
        nodeModules: '/runtime/node_modules',
        binaries: { soffice: '/runtime/soffice' },
        fonts: {},
        text: ''
      })
    })

    await expect(service.render(sourceId)).rejects.toThrow(
      'Primary Runtime is missing required presentation preview binaries: soffice, pdftoppm.'
    )
  })

  it('does not call the runtime for unavailable or oversized artifact bytes', async () => {
    const loadDependencies = vi.fn()
    const unavailable = new PresentationArtifactPreviewService({
      artifacts: {
        readBinary: async () => ({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId,
          unavailable: 'expired'
        })
      },
      loadDependencies
    })
    await expect(unavailable.render(sourceId)).rejects.toThrow(
      'Artifact source is unavailable: expired'
    )

    const oversized = new PresentationArtifactPreviewService({
      artifacts: {
        readBinary: async () => ({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId,
          content: { kind: 'too-large', size: 10, limit: 1, generation: 2 }
        })
      },
      loadDependencies
    })
    await expect(oversized.render(sourceId)).rejects.toThrow('Presentation artifact is too large')
    expect(loadDependencies).not.toHaveBeenCalled()
  })

  it('fails instead of silently truncating decks over the slide limit', async () => {
    const service = createRenderingService(async (args) => {
      const prefix = args[args.length - 1]
      for (let slide = 1; slide <= 31; slide += 1) {
        await writeFile(`${prefix}-${slide}.png`, Buffer.from([slide]))
      }
    })

    await expect(service.render(sourceId)).rejects.toThrow(
      'Presentation preview supports at most 30 slides.'
    )
  })

  it('requires contiguous slide images from the renderer', async () => {
    const service = createRenderingService(async (args) => {
      const prefix = args[args.length - 1]
      await writeFile(`${prefix}-1.png`, Buffer.from([1]))
      await writeFile(`${prefix}-3.png`, Buffer.from([3]))
    })

    await expect(service.render(sourceId)).rejects.toThrow(
      'Presentation renderer produced non-contiguous slide images.'
    )
  })

  it('caps total PNG bytes before base64 encoding for IPC', async () => {
    const service = createRenderingService(async (args) => {
      const prefix = args[args.length - 1]
      await writeFile(`${prefix}-1.png`, Buffer.alloc(30 * 1024 * 1024 + 1, 0x89))
    })

    await expect(service.render(sourceId)).rejects.toThrow('Presentation preview images exceed')
  })
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-presentation-preview-test-'))
  tempDirectories.push(directory)
  return directory
}

function createRenderingService(
  writeSlides: (args: readonly string[]) => Promise<void>
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
          generation: 1
        }
      })
    },
    loadDependencies: async () => ({
      bundleVersion: 'test-runtime',
      node: '/runtime/node',
      nodeModules: '/runtime/node_modules',
      binaries: { soffice: '/runtime/soffice', pdftoppm: '/runtime/pdftoppm' },
      fonts: {},
      text: ''
    }),
    runProcess: async (command, args) => {
      if (command === '/runtime/soffice') {
        const outdir = args[args.indexOf('--outdir') + 1]
        await writeFile(join(outdir, 'source.pdf'), '')
      } else {
        await mkdir(dirname(args[args.length - 1]), { recursive: true })
        await writeSlides(args)
      }
      return { stdout: '', stderr: '' }
    },
    createTempDirectory: tempDirectory
  })
}
