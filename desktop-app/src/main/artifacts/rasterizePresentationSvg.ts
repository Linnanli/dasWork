import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Session } from 'electron'

const PREVIEW_PARTITION = 'dascowork-presentation-preview'
const MAX_DIMENSION = 4096
const MAX_PIXELS = 8_000_000
const allowedDocuments = new Set<string>()
let previewSession: Session | undefined

/** Renders OfficeCLI's browser-independent SVG using the Chromium already bundled with Electron. */
export async function rasterizePresentationSvg(
  svg: string,
  timeoutMs: number,
  chineseFontPath: string
): Promise<Buffer> {
  const { width, height } = svgDimensions(svg)
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-office-svg-'))
  const svgPath = join(directory, 'slide.svg')
  const svgUrl = pathToFileURL(svgPath).href
  let window: import('electron').BrowserWindow | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // The path comes only from the verified Main-owned Runtime dependency
    // snapshot. Embed its bytes so the isolated document needs no file or
    // network access for fonts, and keeps the deck's existing font choices.
    const font = await readFile(chineseFontPath)
    const fontStyle = `<style>@font-face{font-family:"Noto Sans CJK SC";src:url("data:font/otf;base64,${font.toString('base64')}") format("opentype");font-style:normal;font-weight:normal;}</style>`
    await writeFile(svgPath, svg.replace(/(<svg\b[^>]*>)/u, `$1${fontStyle}`))
    const electron = await import('electron')
    await electron.app.whenReady()
    const isolatedSession = getPreviewSession(electron.session)
    allowedDocuments.add(svgUrl)
    window = new electron.BrowserWindow({
      width,
      height,
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        session: isolatedSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        backgroundThrottling: false
      }
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const firstPaint = new Promise<void>((resolve) => window!.once('ready-to-show', resolve))
    const render = async (): Promise<Buffer> => {
      await window!.loadFile(svgPath)
      await firstPaint
      // Only this fixed Main-owned expression executes. Document scripts stay
      // disabled. Preserve each text style's preferred fonts, and include the
      // Runtime font as its Chinese fallback. Wait for paint after font layout.
      const fontLoaded = await window!.webContents.executeJavaScriptInIsolatedWorld(1001, [
        {
          code: `(async () => {
          for (const element of document.querySelectorAll('[style]')) {
            const family = element.style.fontFamily;
            if (family && !family.includes('Noto Sans CJK SC')) {
              element.style.fontFamily = family + ', "Noto Sans CJK SC"';
            }
          }
          const faces = await document.fonts.load('16px "Noto Sans CJK SC"', '中文');
          await document.fonts.ready;
          if (!faces.length || faces.some(face => face.status !== 'loaded')) return false;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return true;
        })()`
        }
      ])
      if (!fontLoaded)
        throw new Error('Presentation preview could not load the Runtime Chinese font.')
      const image = await window!.webContents.capturePage({ x: 0, y: 0, width, height })
      if (image.isEmpty()) throw new Error('Presentation SVG rendered an empty image.')
      return image.toPNG()
    }
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Presentation SVG rendering timed out.')),
        timeoutMs
      )
    })
    return await Promise.race([render(), timedOut])
  } finally {
    if (timer) clearTimeout(timer)
    if (window && !window.isDestroyed()) window.destroy()
    allowedDocuments.delete(svgUrl)
    await rm(directory, { recursive: true, force: true })
  }
}

function getPreviewSession(electronSession: typeof import('electron').session): Session {
  if (previewSession) return previewSession
  const isolated = electronSession.fromPartition(PREVIEW_PARTITION, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:') && !allowedDocuments.has(details.url) })
  })
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  previewSession = isolated
  return isolated
}

function svgDimensions(svg: string): { width: number; height: number } {
  const width = Number(/<svg\b[^>]*\bwidth="(\d+)"/u.exec(svg)?.[1])
  const height = Number(/<svg\b[^>]*\bheight="(\d+)"/u.exec(svg)?.[1])
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new Error('OfficeCLI returned unsupported presentation slide dimensions.')
  }
  return { width, height }
}
