import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
export async function rasterizePresentationSvg(svg: string, timeoutMs: number): Promise<Buffer> {
  const { width, height } = svgDimensions(svg)
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-office-svg-'))
  const svgPath = join(directory, 'slide.svg')
  const svgUrl = pathToFileURL(svgPath).href
  let window: import('electron').BrowserWindow | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await writeFile(svgPath, svg)
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
    const render = async (): Promise<Buffer> => {
      await window!.loadFile(svgPath)
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
