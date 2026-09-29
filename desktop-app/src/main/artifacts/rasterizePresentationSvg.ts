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
    const fontStyle = `<style>@font-face{font-family:"Dascowork Preview CJK";src:url("data:font/otf;base64,${font.toString('base64')}") format("opentype");font-style:normal;font-weight:400;unicode-range:U+2E80-33FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FF00-FFEF,U+20000-2FA1F;}</style>`
    await writeFile(svgPath, svg.replace(/(<svg\b[^>]*>)/u, `$1${fontStyle}`))
    const electron = await import('electron')
    await electron.app.whenReady()
    const isolatedSession = getPreviewSession(electron.session)
    allowedDocuments.add(svgUrl)
    window = new electron.BrowserWindow({
      width,
      height,
      useContentSize: true,
      enableLargerThanScreen: true,
      show: false,
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
    const render = async (): Promise<Buffer> => {
      await window!.loadFile(svgPath)
      // Native window creation can fit the initial bounds to a small desktop.
      // Restore the slide viewport after the hidden window has initialized.
      window!.setContentSize(width, height)
      // Only this fixed Main-owned expression executes. Document scripts stay
      // disabled. The private face owns only CJK code points, so a system font
      // cannot swallow Chinese glyphs and Latin text keeps its preferred face.
      const rendered = await window!.webContents.executeJavaScriptInIsolatedWorld(1001, [
        {
          code: `(async () => {
          const elements = new Set();
          const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode());) {
            const element = node.parentElement;
            if (!element || !node.textContent.trim()) continue;
            if (element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
                element.localName !== 'style' && element.localName !== 'script' ||
                element.namespaceURI === 'http://www.w3.org/2000/svg' && element.closest('text')) {
              elements.add(element);
            }
          }
          const families = [...elements].map(element => [element, getComputedStyle(element).fontFamily]);
          for (const [element, family] of families) {
            element.style.fontFamily = '"Dascowork Preview CJK", ' + family;
          }
          const faces = await document.fonts.load('16px "Dascowork Preview CJK"', '中文');
          // Flush changed text styles so fonts.ready covers their actual layout,
          // including font sizes and synthesized weights used by this slide.
          document.documentElement.getBoundingClientRect();
          await document.fonts.ready;
          if (!faces.length || faces.some(face => face.status !== 'loaded')) return false;
          // Decode the complete SVG as an image. Canvas export synchronizes its
          // pixels without depending on a hidden window's compositor frames.
          const image = new Image();
          image.src = 'data:image/svg+xml;charset=utf-8,' +
            encodeURIComponent(new XMLSerializer().serializeToString(document.documentElement));
          await image.decode();
          const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
          canvas.width = ${width};
          canvas.height = ${height};
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Presentation preview could not create a canvas.');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png');
        })()`
        }
      ])
      if (rendered === false)
        throw new Error('Presentation preview could not load the Runtime Chinese font.')
      if (typeof rendered !== 'string' || !rendered.startsWith('data:image/png;base64,'))
        throw new Error('Presentation preview could not produce a decoded SVG image.')
      const image = electron.nativeImage.createFromDataURL(rendered)
      if (image.isEmpty()) throw new Error('Presentation SVG rendered an empty image.')
      const size = image.getSize()
      if (!matchesSlideCaptureSize(size.width, size.height, width, height)) {
        throw new Error(
          `Presentation SVG capture dimensions do not match the slide: ${size.width}x${size.height}, expected aspect ${width}x${height}.`
        )
      }
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

function matchesSlideCaptureSize(
  capturedWidth: number,
  capturedHeight: number,
  slideWidth: number,
  slideHeight: number
): boolean {
  if (capturedWidth < slideWidth - 1 || capturedHeight < slideHeight - 1) return false
  const roundingTolerance =
    1 / capturedWidth + 1 / capturedHeight + 1 / slideWidth + 1 / slideHeight
  return (
    Math.abs(Math.log(capturedWidth / capturedHeight / (slideWidth / slideHeight))) <=
    roundingTolerance
  )
}
