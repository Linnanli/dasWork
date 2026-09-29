import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rasterizePresentationSvg } from './rasterizePresentationSvg'

type RequestHandler = (
  details: { url: string },
  callback: (response: { cancel: boolean }) => void
) => void

const electronMock = vi.hoisted(() => {
  let requestHandler: RequestHandler | undefined
  const image = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 1920, height: 1080 })),
    toPNG: vi.fn(() => Buffer.from('png'))
  }
  return {
    image,
    session: {
      webRequest: {
        onBeforeRequest: vi.fn((handler: RequestHandler) => {
          requestHandler = handler
        })
      },
      setPermissionRequestHandler: vi.fn()
    },
    nativeImage: {
      createFromDataURL: vi.fn(() => image)
    },
    request: (url: string, callback: (response: { cancel: boolean }) => void) => {
      if (!requestHandler) throw new Error('request handler was not registered')
      requestHandler({ url }, callback)
    },
    windowOptions: vi.fn(),
    setContentSize: vi.fn(),
    loadFile: vi.fn<(path: string) => Promise<void>>(async () => undefined),
    executeJavaScriptInIsolatedWorld:
      vi.fn<(world: number, scripts: Array<{ code: string }>) => Promise<string | false>>(),
    setWindowOpenHandler: vi.fn(),
    destroy: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { whenReady: async () => undefined },
  session: { fromPartition: () => electronMock.session },
  nativeImage: electronMock.nativeImage,
  BrowserWindow: class {
    constructor(options: unknown) {
      electronMock.windowOptions(options)
    }
    loadFile = electronMock.loadFile
    setContentSize = electronMock.setContentSize
    webContents = {
      executeJavaScriptInIsolatedWorld: electronMock.executeJavaScriptInIsolatedWorld,
      setWindowOpenHandler: electronMock.setWindowOpenHandler
    }
    isDestroyed = (): boolean => false
    destroy = electronMock.destroy
  }
}))

const directories: string[] = []
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"></svg>'

let activeEnvironment: IsolatedEnvironment

beforeEach(() => {
  vi.clearAllMocks()
  electronMock.image.isEmpty.mockReturnValue(false)
  electronMock.image.getSize.mockReturnValue({ width: 1920, height: 1080 })
  electronMock.nativeImage.createFromDataURL.mockReturnValue(electronMock.image)
  activeEnvironment = createIsolatedEnvironment()
  electronMock.executeJavaScriptInIsolatedWorld.mockImplementation((_world, scripts) =>
    activeEnvironment.run(scripts[0].code)
  )
})

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('rasterizePresentationSvg', () => {
  it('waits for Image.decode before drawing, exporting, and returning the native PNG', async () => {
    activeEnvironment.imageDecode = controlledPromise<void>()
    const rendering = rasterizePresentationSvg(svg, 5_000, await fontFixture())

    await activeEnvironment.imageDecode.started
    expect(activeEnvironment.context.fillRect).not.toHaveBeenCalled()
    expect(activeEnvironment.context.drawImage).not.toHaveBeenCalled()
    expect(activeEnvironment.canvas.toDataURL).not.toHaveBeenCalled()
    expect(electronMock.nativeImage.createFromDataURL).not.toHaveBeenCalled()

    activeEnvironment.imageDecode.resolve()
    await expect(rendering).resolves.toEqual(Buffer.from('png'))
    expect(activeEnvironment.context.fillRect).toHaveBeenCalledWith(0, 0, 1920, 1080)
    expect(activeEnvironment.context.drawImage).toHaveBeenCalledWith(
      activeEnvironment.image,
      0,
      0,
      1920,
      1080
    )
    expect(activeEnvironment.canvas.toDataURL).toHaveBeenCalledWith('image/png')
    expect(electronMock.nativeImage.createFromDataURL).toHaveBeenCalledWith(
      activeEnvironment.dataUrl
    )
    expect(electronMock.image.toPNG).toHaveBeenCalledOnce()
  })

  it('waits for fonts.ready after the style flush exposes the new layout', async () => {
    activeEnvironment.fontsReady = controlledPromise<void>()
    activeEnvironment.readyBeforeLayout = false
    activeEnvironment.readyAfterLayout = false
    const rendering = rasterizePresentationSvg(svg, 5_000, await fontFixture())

    await activeEnvironment.fontsReady.started
    expect(activeEnvironment.layoutFlushed).toBe(true)
    expect(activeEnvironment.readyBeforeLayout).toBe(false)
    expect(activeEnvironment.readyAfterLayout).toBe(true)
    expect(activeEnvironment.imageDecode.wasStarted()).toBe(false)

    activeEnvironment.fontsReady.resolve()
    await expect(rendering).resolves.toEqual(Buffer.from('png'))
    expect(activeEnvironment.imageDecode.wasStarted()).toBe(true)
  })

  it('prioritizes the private CJK face while preserving each existing Latin family', async () => {
    const htmlText = activeEnvironment.parents[0]
    const svgText = activeEnvironment.parents[1]
    const svgSpan = activeEnvironment.parents[2]

    await rasterizePresentationSvg(svg, 5_000, await fontFixture())

    expect(htmlText.style.fontFamily).toBe(
      '"Dascowork Preview CJK", Calibri, "Noto Sans CJK SC", sans-serif'
    )
    expect(svgText.style.fontFamily).toBe('"Dascowork Preview CJK", serif')
    expect(svgSpan.style.fontFamily).toBe('"Dascowork Preview CJK", Arial, serif')
  })

  it('uses an HTML canvas with a white 1920x1080 backing surface', async () => {
    await rasterizePresentationSvg(svg, 5_000, await fontFixture())

    expect(activeEnvironment.canvas.namespaceURI).toBe('http://www.w3.org/1999/xhtml')
    expect(activeEnvironment.canvas.width).toBe(1920)
    expect(activeEnvironment.canvas.height).toBe(1080)
    expect(activeEnvironment.context.fillStyle).toBe('#ffffff')
    expect(activeEnvironment.context.fillRect).toHaveBeenCalledWith(0, 0, 1920, 1080)
    expect(activeEnvironment.context.drawImage).toHaveBeenCalledWith(
      activeEnvironment.image,
      0,
      0,
      1920,
      1080
    )
  })

  it('embeds a private CJK face without giving document scripts or external resources access', async () => {
    let document = ''
    electronMock.loadFile.mockImplementationOnce(async (path) => {
      document = await readFile(path, 'utf8')
    })
    const fontPath = await fontFixture()
    await rasterizePresentationSvg(svg, 5_000, fontPath)
    expect(document).toContain('font-family:"Dascowork Preview CJK"')
    expect(document).toContain('unicode-range:')
    expect(document).toContain(
      `data:font/otf;base64,${Buffer.from('locked font bytes').toString('base64')}`
    )
    expect(document).not.toContain(fontPath)
    expect(electronMock.windowOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: '#ffffff',
        webPreferences: expect.objectContaining({
          javascript: false,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true
        })
      })
    )
    expect(electronMock.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function))
    const callback = vi.fn()
    electronMock.request('https://example.com/font.otf', callback)
    expect(callback).toHaveBeenCalledWith({ cancel: true })
    await expect(readFile(electronMock.loadFile.mock.calls[0][0])).rejects.toThrow()
  })

  it('rejects a failed font load and cleans up', async () => {
    activeEnvironment.fontFaces = []
    await expect(rasterizePresentationSvg(svg, 5_000, await fontFixture())).rejects.toThrow(
      'could not load the Runtime Chinese font'
    )
    expect(electronMock.nativeImage.createFromDataURL).not.toHaveBeenCalled()
    expect(electronMock.destroy).toHaveBeenCalledOnce()
    await expect(readFile(electronMock.loadFile.mock.calls[0][0])).rejects.toThrow()
  })

  it('rejects a decoded image failure and cleans up', async () => {
    activeEnvironment.imageDecode = controlledPromise<void>()
    const rendering = rasterizePresentationSvg(svg, 5_000, await fontFixture())
    await activeEnvironment.imageDecode.started
    activeEnvironment.imageDecode.reject(new Error('decode failed'))
    await expect(rendering).rejects.toThrow('decode failed')
    expect(electronMock.nativeImage.createFromDataURL).not.toHaveBeenCalled()
    expect(electronMock.destroy).toHaveBeenCalledOnce()
    await expect(readFile(electronMock.loadFile.mock.calls[0][0])).rejects.toThrow()
  })

  it('times out while waiting for the decoded image and cleans up', async () => {
    activeEnvironment.imageDecode = controlledPromise<void>()
    await expect(rasterizePresentationSvg(svg, 100, await fontFixture())).rejects.toThrow(
      'rendering timed out'
    )
    expect(activeEnvironment.context.drawImage).not.toHaveBeenCalled()
    expect(electronMock.destroy).toHaveBeenCalledOnce()
    await expect(readFile(electronMock.loadFile.mock.calls[0][0])).rejects.toThrow()
  })

  it.each([
    { width: 3840, height: 2160 },
    { width: 1921, height: 1080 },
    { width: 1919, height: 1080 }
  ])('accepts a decoded image with the slide aspect: %o', async (size) => {
    electronMock.image.getSize.mockReturnValueOnce(size)
    await expect(rasterizePresentationSvg(svg, 5_000, await fontFixture())).resolves.toEqual(
      Buffer.from('png')
    )
  })

  it('rejects a clipped decoded image instead of publishing it', async () => {
    electronMock.image.getSize.mockReturnValueOnce({ width: 1008, height: 681 })
    await expect(rasterizePresentationSvg(svg, 5_000, await fontFixture())).rejects.toThrow(
      'dimensions do not match the slide'
    )
    expect(electronMock.destroy).toHaveBeenCalledOnce()
  })

  it('rejects an empty native image', async () => {
    electronMock.image.isEmpty.mockReturnValueOnce(true)
    await expect(rasterizePresentationSvg(svg, 5_000, await fontFixture())).rejects.toThrow(
      'rendered an empty image'
    )
    expect(electronMock.image.toPNG).not.toHaveBeenCalled()
    expect(electronMock.destroy).toHaveBeenCalledOnce()
  })

  it.each(['<svg width="4097" height="1080"></svg>', '<svg width="4096" height="4096"></svg>'])(
    'rejects oversized slide dimensions before creating a window: %s',
    async (input) => {
      await expect(rasterizePresentationSvg(input, 100, '/runtime/noto.otf')).rejects.toThrow(
        'unsupported presentation slide dimensions'
      )
      expect(electronMock.windowOptions).not.toHaveBeenCalled()
    }
  )
})

type ControlledPromise<T> = Promise<T> & {
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: unknown) => void
  started: Promise<void>
  wasStarted: () => boolean
}

type TextParent = {
  localName: string
  namespaceURI: string
  style: { fontFamily: string }
  closest: (selector: string) => object | null
}

type CanvasContext = {
  fillStyle: string
  fillRect: ReturnType<typeof vi.fn>
  drawImage: ReturnType<typeof vi.fn>
}

type CanvasElement = {
  namespaceURI: string
  width: number
  height: number
  getContext: (kind: string) => CanvasContext | null
  toDataURL: ReturnType<typeof vi.fn>
}

type IsolatedEnvironment = {
  canvas: CanvasElement
  context: CanvasContext
  dataUrl: string
  fontFaces: Array<{ status: string }>
  fontsReady: ControlledPromise<void>
  image: { src: string; decode: () => Promise<void> }
  imageDecode: ControlledPromise<void>
  layoutFlushed: boolean
  parents: TextParent[]
  readyAfterLayout: boolean
  readyBeforeLayout: boolean
  run: (code: string) => Promise<string | false>
}

function controlledPromise<T>(): ControlledPromise<T> {
  let started = false
  let markStarted!: () => void
  const startedPromise = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  }) as ControlledPromise<T>
  promise.resolve = (value) => {
    resolve(value)
  }
  promise.reject = (error) => {
    reject(error)
  }
  promise.started = startedPromise
  promise.wasStarted = () => started
  return new Proxy(promise, {
    get(target, prop, receiver) {
      if (prop === 'then') {
        started = true
        markStarted()
        return target.then.bind(target)
      }
      if (prop === 'catch') return target.catch.bind(target)
      if (prop === 'finally') return target.finally.bind(target)
      return Reflect.get(target, prop, receiver)
    }
  }) as ControlledPromise<T>
}

function createIsolatedEnvironment(): IsolatedEnvironment {
  const dataUrl = `data:image/png;base64,${Buffer.from('canvas png').toString('base64')}`
  const context: CanvasContext = {
    fillStyle: '',
    fillRect: vi.fn(),
    drawImage: vi.fn()
  }
  const canvas: CanvasElement = {
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    width: 0,
    height: 0,
    getContext: vi.fn((kind: string) => (kind === '2d' ? context : null)),
    toDataURL: vi.fn(() => dataUrl)
  }
  const env: IsolatedEnvironment = {
    canvas,
    context,
    dataUrl,
    fontFaces: [{ status: 'loaded' }],
    fontsReady: controlledPromise<void>(),
    image: { src: '', decode: () => env.imageDecode },
    imageDecode: controlledPromise<void>(),
    layoutFlushed: false,
    parents: [
      textParent('span', 'Calibri, "Noto Sans CJK SC", sans-serif'),
      textParent('text', 'serif'),
      textParent('tspan', 'Arial, serif')
    ],
    readyAfterLayout: false,
    readyBeforeLayout: false,
    run: async (code) => {
      const nodes = env.parents.flatMap((parentElement) => [
        { parentElement, textContent: '中文' },
        { parentElement, textContent: 'Latin' }
      ])
      const document = {
        documentElement: {
          getBoundingClientRect: () => {
            env.layoutFlushed = true
            return {}
          }
        },
        createElementNS: (namespaceURI: string, localName: string) => {
          if (namespaceURI !== 'http://www.w3.org/1999/xhtml' || localName !== 'canvas') {
            throw new Error(`unexpected element ${namespaceURI}:${localName}`)
          }
          canvas.namespaceURI = namespaceURI
          return canvas
        },
        createTreeWalker: () => ({
          nextNode: () => nodes.shift()
        }),
        fonts: {
          load: vi.fn(async () => env.fontFaces),
          get ready() {
            if (env.layoutFlushed) {
              env.readyAfterLayout = true
            } else {
              env.readyBeforeLayout = true
            }
            return env.fontsReady
          }
        }
      }
      class TestImage {
        src = ''
        decode = (): Promise<void> => env.imageDecode
        constructor() {
          env.image = this
        }
      }
      class TestXMLSerializer {
        serializeToString(value: unknown): string {
          expect(value).toBe(document.documentElement)
          return '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"></svg>'
        }
      }
      const result = new Function(
        'document',
        'NodeFilter',
        'getComputedStyle',
        'Image',
        'XMLSerializer',
        `return ${code}`
      )(
        document,
        { SHOW_TEXT: 4 },
        (element: TextParent) => ({ fontFamily: element.style.fontFamily }),
        TestImage,
        TestXMLSerializer
      )
      return result as Promise<string | false>
    }
  }
  env.fontsReady.resolve()
  env.imageDecode.resolve()
  return env
}

function textParent(localName: string, fontFamily: string): TextParent {
  return {
    localName,
    namespaceURI:
      localName === 'span' ? 'http://www.w3.org/1999/xhtml' : 'http://www.w3.org/2000/svg',
    style: { fontFamily },
    closest: (selector: string) =>
      selector === 'text' && (localName === 'text' || localName === 'tspan') ? {} : null
  }
}

async function fontFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-svg-font-test-'))
  directories.push(directory)
  const path = join(directory, 'runtime.otf')
  await writeFile(path, 'locked font bytes')
  return path
}
