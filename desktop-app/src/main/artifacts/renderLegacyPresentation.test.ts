import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderLegacyPresentation } from './renderLegacyPresentation'

const tempDirectories: string[] = []
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('renderLegacyPresentation', () => {
  it('uses the verified legacy Impress PDF export filter and reads the declared output directory', async () => {
    const root = await tempDirectory()
    const inputPath = join(root, 'source.pptx')
    await writeFile(inputPath, 'pptx')
    const runProcess = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === '/runtime/soffice') {
        expect(args).toContain('pdf:impress_pdf_Export')
        const outputDirectory = args[args.indexOf('--outdir') + 1]
        await writeFile(join(outputDirectory, 'source.pdf'), 'pdf')
        return { stdout: 'convert ok', stderr: '' }
      }
      const prefix = args.at(-1)
      expect(args).toContain(join(root, 'output', 'source.pdf'))
      if (typeof prefix !== 'string') throw new Error('missing slide prefix')
      await mkdir(dirname(prefix), { recursive: true })
      await writeFile(`${prefix}-1.png`, pngSignature)
      return { stdout: '', stderr: '' }
    })

    await expect(
      renderLegacyPresentation(
        inputPath,
        root,
        { soffice: '/runtime/soffice', pdftoppm: '/runtime/pdftoppm' },
        runProcess
      )
    ).resolves.toEqual([{ number: 1, base64: pngSignature.toString('base64') }])
    expect(runProcess).toHaveBeenCalledWith(
      '/runtime/pdftoppm',
      expect.arrayContaining([join(root, 'output', 'source.pdf')]),
      expect.objectContaining({ SAL_USE_VCLPLUGIN: 'svp' })
    )
  })

  it('uses the verified v2 Windows profile environment for legacy conversion', async () => {
    const root = await tempDirectory()
    const runProcess = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await expect(
      renderLegacyPresentation(
        join(root, 'source.pptx'),
        root,
        { soffice: 'soffice.com', pdftoppm: 'pdftoppm.exe' },
        runProcess,
        { platform: 'win32' }
      )
    ).rejects.toThrow('did not produce a PDF')
    expect(runProcess).toHaveBeenCalledWith('soffice.com', expect.any(Array), {
      SAL_USE_VCLPLUGIN: 'svp',
      USERPROFILE: join(root, 'libreoffice-profile'),
      APPDATA: join(root, 'libreoffice-profile', 'AppData', 'Roaming'),
      LOCALAPPDATA: join(root, 'libreoffice-profile', 'AppData', 'Local')
    })
  })

  it('includes the trusted Runtime font in Linux legacy rendering with an isolated font cache', async () => {
    const root = await tempDirectory()
    const fontDirectory = join(root, 'noto&font')
    const runProcess = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await expect(
      renderLegacyPresentation(
        join(root, 'source.pptx'),
        root,
        { soffice: 'soffice', pdftoppm: 'pdftoppm' },
        runProcess,
        { platform: 'linux', chineseFontPath: join(fontDirectory, 'Noto.otf') }
      )
    ).rejects.toThrow('did not produce a PDF')
    const config = await readFile(join(root, 'fonts.conf'), 'utf8')
    expect(config).toContain(`<dir>${fontDirectory.replace('&', '&amp;')}</dir>`)
    expect(config).toContain(`<cachedir>${join(root, 'font-cache')}</cachedir>`)
    expect(runProcess).toHaveBeenCalledWith('soffice', expect.any(Array), {
      SAL_USE_VCLPLUGIN: 'svp',
      FONTCONFIG_FILE: join(root, 'fonts.conf'),
      FONTCONFIG_PATH: fontDirectory
    })
  })

  it('reports LibreOffice output and directory entries when conversion produces no PDF', async () => {
    const root = await tempDirectory()
    const inputPath = join(root, 'source.pptx')
    await writeFile(inputPath, 'pptx')
    await writeFile(join(root, 'note.txt'), 'diagnostic marker')

    const promise = renderLegacyPresentation(
      inputPath,
      root,
      { soffice: '/runtime/soffice', pdftoppm: '/runtime/pdftoppm' },
      async () => ({ stdout: 'no export happened', stderr: 'warn only' })
    )

    await expect(promise).rejects.toThrow(/note\.txt/u)
    await expect(promise).rejects.toThrow(/no export happened/u)
    await expect(promise).rejects.toThrow(/warn only/u)
  })

  it('reports the embedded Python library presence and path length on a failed export', async () => {
    const root = await tempDirectory()
    const programDirectory = join(root, 'program')
    const libraryDirectory = join(programDirectory, 'python-core-test', 'lib')
    await mkdir(libraryDirectory, { recursive: true })
    await writeFile(join(libraryDirectory, 'os.py'), '# Runtime stdlib landmark')
    const promise = renderLegacyPresentation(
      join(root, 'source.pptx'),
      root,
      { soffice: join(programDirectory, 'soffice.com'), pdftoppm: 'pdftoppm.exe' },
      async () => ({
        stdout: '',
        stderr: 'Could not find platform independent libraries <prefix>'
      }),
      { platform: 'win32' }
    )
    await expect(promise).rejects.toThrow('python-core-test:os.py=present:pathLength=')
    await expect(promise).rejects.toThrow('sofficePathLength=')
  })
})

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-legacy-preview-test-'))
  tempDirectories.push(directory)
  return directory
}
