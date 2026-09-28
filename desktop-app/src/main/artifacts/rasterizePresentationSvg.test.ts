import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rasterizePresentationSvg } from './rasterizePresentationSvg'

const electronMock = vi.hoisted(() => {
  const session = {
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionRequestHandler: vi.fn()
  }
  return {
    session,
    windowOptions: vi.fn(),
    loadFile: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    executeJavaScriptInIsolatedWorld: vi.fn<
      (world: number, scripts: unknown[]) => Promise<boolean>
    >(async () => true),
    capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png') })),
    once: vi.fn<(event: string, listener: () => void) => void>(),
    destroy: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { whenReady: async () => undefined },
  session: { fromPartition: () => electronMock.session },
  BrowserWindow: class {
    constructor(options: unknown) {
      electronMock.windowOptions(options)
    }
    loadFile = electronMock.loadFile
    once = electronMock.once
    webContents = {
      executeJavaScriptInIsolatedWorld: electronMock.executeJavaScriptInIsolatedWorld,
      capturePage: electronMock.capturePage,
      setWindowOpenHandler: vi.fn()
    }
    isDestroyed = (): boolean => false
    destroy = electronMock.destroy
  }
}))

const directories: string[] = []
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"></svg>'

beforeEach(() => {
  electronMock.capturePage.mockClear()
  electronMock.loadFile.mockClear()
  electronMock.windowOptions.mockClear()
  electronMock.destroy.mockClear()
  electronMock.once.mockReset().mockImplementation((_event, listener) => listener())
  electronMock.executeJavaScriptInIsolatedWorld.mockReset().mockResolvedValue(true)
})

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('rasterizePresentationSvg', () => {
  it('rejects oversized SVG dimensions before creating an Electron window', async () => {
    await expect(
      rasterizePresentationSvg('<svg width="4097" height="1080"></svg>', 100, '/runtime/noto.otf')
    ).rejects.toThrow('unsupported presentation slide dimensions')
    await expect(
      rasterizePresentationSvg('<svg width="4096" height="4096"></svg>', 100, '/runtime/noto.otf')
    ).rejects.toThrow('unsupported presentation slide dimensions')
    expect(electronMock.windowOptions).not.toHaveBeenCalled()
  })

  it('embeds the Runtime font and waits for its layout before capturing with scripts disabled', async () => {
    const fontPath = await fontFixture()
    let releaseFont!: (loaded: boolean) => void
    electronMock.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseFont = resolve))
    )
    const rendering = rasterizePresentationSvg(svg, 5_000, fontPath)
    await vi.waitFor(() => expect(electronMock.executeJavaScriptInIsolatedWorld).toHaveBeenCalled())
    expect(electronMock.capturePage).not.toHaveBeenCalled()
    const svgPath = electronMock.loadFile.mock.calls[0][0]
    const document = await readFile(svgPath, 'utf8')
    expect(document).toContain(
      `data:font/otf;base64,${Buffer.from('locked font bytes').toString('base64')}`
    )
    expect(document).not.toContain(fontPath)
    expect(electronMock.windowOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          javascript: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true
        })
      })
    )
    releaseFont(true)
    await expect(rendering).resolves.toEqual(Buffer.from('png'))
    expect(electronMock.capturePage).toHaveBeenCalledOnce()
    expect(electronMock.destroy).toHaveBeenCalledOnce()
    await expect(readFile(svgPath)).rejects.toThrow()
    const onRequest = electronMock.session.webRequest.onBeforeRequest.mock.calls[0][0]
    const callback = vi.fn()
    onRequest({ url: 'https://example.com/font.otf' }, callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })

  it('waits for the hidden window first paint before loading fonts and capturing', async () => {
    let releasePaint!: () => void
    electronMock.once.mockImplementationOnce((_event, listener) => (releasePaint = listener))
    const rendering = rasterizePresentationSvg(svg, 5_000, await fontFixture())
    await vi.waitFor(() => expect(electronMock.loadFile).toHaveBeenCalled())
    expect(electronMock.once).toHaveBeenCalledWith('ready-to-show', expect.any(Function))
    expect(electronMock.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
    expect(electronMock.capturePage).not.toHaveBeenCalled()
    releasePaint()
    await expect(rendering).resolves.toEqual(Buffer.from('png'))
  })

  it('includes the Runtime fallback and waits for two frames after font layout', async () => {
    const elements = [
      { style: { fontFamily: 'Aptos' } },
      { style: { fontFamily: '"Noto Sans CJK SC"' } },
      { style: { fontFamily: '' } }
    ]
    const document = {
      querySelectorAll: () => elements,
      fonts: {
        load: async () => [{ status: 'loaded' }],
        ready: Promise.resolve()
      }
    }
    const frames: Array<() => void> = []
    electronMock.executeJavaScriptInIsolatedWorld.mockImplementationOnce((_world, scripts) => {
      const [{ code }] = scripts as Array<{ code: string }>
      return new Function('document', 'requestAnimationFrame', `return ${code}`)(
        document,
        (callback: () => void) => frames.push(callback)
      ) as Promise<boolean>
    })
    const rendering = rasterizePresentationSvg(svg, 5_000, await fontFixture())
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(elements[0].style.fontFamily).toBe('Aptos, "Noto Sans CJK SC"')
    expect(elements[1].style.fontFamily).toBe('"Noto Sans CJK SC"')
    expect(elements[2].style.fontFamily).toBe('')
    expect(electronMock.capturePage).not.toHaveBeenCalled()
    frames.shift()!()
    expect(electronMock.capturePage).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
    frames.shift()!()
    await expect(rendering).resolves.toEqual(Buffer.from('png'))
  })

  it('rejects a failed font load before capture and removes the temporary SVG', async () => {
    electronMock.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce(false)
    await expect(rasterizePresentationSvg(svg, 5_000, await fontFixture())).rejects.toThrow(
      'could not load the Runtime Chinese font'
    )
    expect(electronMock.capturePage).not.toHaveBeenCalled()
    expect(electronMock.destroy).toHaveBeenCalledOnce()
    await expect(readFile(electronMock.loadFile.mock.calls[0][0])).rejects.toThrow()
  })
})

async function fontFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-svg-font-test-'))
  directories.push(directory)
  const path = join(directory, 'runtime.otf')
  await writeFile(path, 'locked font bytes')
  return path
}
