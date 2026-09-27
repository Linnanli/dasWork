import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ARTIFACT_PREVIEW_API_VERSION } from '../../shared/artifactPreviewApi'
import { PresentationArtifactPreviewService } from './PresentationArtifactPreviewService'

const sourceId = 'sourceid123456789'
const tempDirectories: string[] = []
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const slideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"></svg>'

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('PresentationArtifactPreviewService', () => {
  it('renders authorized PPTX slides through verified OfficeCLI and preserves the result contract', async () => {
    const root = await tempDirectory()
    const runProcess = vi.fn(async (_command: string, args: readonly string[]) =>
      args.includes('stats')
        ? { stdout: JSON.stringify({ success: true, data: { slides: 2 } }), stderr: '' }
        : { stdout: slideSvg, stderr: '' }
    )
    let slide = 0
    const rasterizeSvg = vi.fn(async () => Buffer.concat([pngSignature, Buffer.from([++slide])]))
    const service = createService({
      runProcess,
      rasterizeSvg,
      createTempDirectory: async () => root
    })

    await expect(service.render(sourceId)).resolves.toEqual({
      version: ARTIFACT_PREVIEW_API_VERSION,
      sourceId,
      generation: 7,
      slides: [
        { number: 1, base64: Buffer.concat([pngSignature, Buffer.from([1])]).toString('base64') },
        { number: 2, base64: Buffer.concat([pngSignature, Buffer.from([2])]).toString('base64') }
      ]
    })
    expect(runProcess).toHaveBeenCalledTimes(3)
    expect(runProcess).toHaveBeenCalledWith(
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
    expect(runProcess).toHaveBeenCalledWith(
      '/runtime/officecli',
      ['view', join(root, 'source.pptx'), 'svg', '--start', '2', '--end', '2'],
      expect.any(Object)
    )
    expect(rasterizeSvg).toHaveBeenCalledTimes(2)
    await expect(access(root)).rejects.toThrow()
  })

  it('requires OfficeCLI from the healthy Primary Runtime', async () => {
    const service = createService({ binaries: {} })
    await expect(service.render(sourceId)).rejects.toThrow(
      'Primary Runtime is missing the required presentation preview binary: officecli.'
    )
  })

  it('preserves the v2 LibreOffice preview path for rollback archives', async () => {
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
    await expect(unavailable.render(sourceId)).rejects.toThrow(
      'Artifact source is unavailable: expired'
    )

    const oversized = new PresentationArtifactPreviewService({
      artifacts: {
        readBinary: async () => ({
          version: 1,
          sourceId,
          content: { kind: 'too-large', size: 10, limit: 1, generation: 2 }
        })
      },
      loadDependencies
    })
    await expect(oversized.render(sourceId)).rejects.toThrow('Presentation artifact is too large')
    expect(loadDependencies).not.toHaveBeenCalled()
  })

  it('rejects malformed and failed OfficeCLI statistics', async () => {
    for (const stdout of [
      'not json',
      '{"success":false}',
      '{"success":true,"data":{"slides":0}}'
    ]) {
      await expect(renderWithStats(stdout)).rejects.toThrow(/OfficeCLI/)
    }
  })

  it('rejects decks over the slide limit before starting slide rendering', async () => {
    const rasterizeSvg = vi.fn()
    const service = createService({
      runProcess: async () => ({
        stdout: JSON.stringify({ success: true, data: { slides: 31 } }),
        stderr: ''
      }),
      rasterizeSvg
    })
    await expect(service.render(sourceId)).rejects.toThrow(
      'Presentation preview supports at most 30 slides.'
    )
    expect(rasterizeSvg).not.toHaveBeenCalled()
  })

  it('rejects malformed SVG, invalid PNG, and oversized PNG output', async () => {
    const badSvg = createService({
      runProcess: async (_command, args) => ({
        stdout: args.includes('stats')
          ? JSON.stringify({ success: true, data: { slides: 1 } })
          : 'not svg',
        stderr: ''
      }),
      rasterizeSvg: async () => pngSignature
    })
    await expect(badSvg.render(sourceId)).rejects.toThrow('valid presentation slide SVG')

    const invalidPng = createService({ rasterizeSvg: async () => Buffer.from('not png') })
    await expect(invalidPng.render(sourceId)).rejects.toThrow('invalid PNG')

    const oversizedPng = createService({
      rasterizeSvg: async () => Buffer.concat([pngSignature, Buffer.alloc(30 * 1024 * 1024)])
    })
    await expect(oversizedPng.render(sourceId)).rejects.toThrow(
      'Presentation preview images exceed'
    )
  })
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-presentation-preview-test-'))
  tempDirectories.push(directory)
  return directory
}

function createService(
  input: {
    binaries?: Record<string, string>
    runProcess?: NonNullable<
      ConstructorParameters<typeof PresentationArtifactPreviewService>[0]['runProcess']
    >
    rasterizeSvg?: NonNullable<
      ConstructorParameters<typeof PresentationArtifactPreviewService>[0]['rasterizeSvg']
    >
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
    loadDependencies: async () => ({
      bundleVersion: 'test-runtime',
      node: '/runtime/node',
      nodeModules: '/runtime/node_modules',
      binaries: input.binaries ?? { officecli: '/runtime/officecli' },
      fonts: {},
      text: ''
    }),
    runProcess:
      input.runProcess ??
      (async (_command, args) => ({
        stdout: args.includes('stats')
          ? JSON.stringify({ success: true, data: { slides: 1 } })
          : slideSvg,
        stderr: ''
      })),
    rasterizeSvg: input.rasterizeSvg ?? (async () => pngSignature),
    createTempDirectory: input.createTempDirectory ?? tempDirectory
  })
}

async function renderWithStats(stdout: string): Promise<void> {
  const service = createService({ runProcess: async () => ({ stdout, stderr: '' }) })
  await service.render(sourceId)
}
