import { copyFile, stat, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  chatImageRequestSchema,
  chatImageSaveRequestSchema,
  isChatImageMimeType,
  parseChatImageDataUrl,
  type ChatImageRequest,
  type ChatImageResolveResult,
  type ChatImageSaveRequest,
  type ChatImageSaveResult
} from '../../shared/chatImageApi'
import { isExternalHttpUrl, isSafeLocalOpenPath } from '../../shared/codexIpcApi'
import { mediaTypeForPath, resolveAppMediaPath, toAppMediaUrl } from '../localMediaProtocol'
import { resolveLocalOpenPath } from '../localPathOpen'
import type { ProjectService } from '../projects/ProjectService'
import type { ResolvedExecutionTarget } from '../../shared/projects/projectTypes'

export type ChatImageSaveHost = {
  isDestroyed(): boolean
  chooseSavePath(fileName: string): Promise<string | null>
  downloadImage(url: string, fileName?: string): Promise<ChatImageSaveResult>
}

type FileStat = { isFile(): boolean }
type LocalImage = { kind: 'local'; path: string; displaySrc: string; fileName: string }
type ImageSource =
  | LocalImage
  | { kind: 'data'; displaySrc: string; mimeType: string; bytes: Buffer }
  | { kind: 'http'; displaySrc: string }

export type ChatImageServiceOptions = {
  projectService: Pick<ProjectService, 'resolveExistingThreadTarget'>
  platform?: NodeJS.Platform
  statFile?: (path: string) => Promise<FileStat>
  copyImage?: (source: string, destination: string) => Promise<void>
  writeImage?: (path: string, bytes: Buffer) => Promise<void>
}

export class ChatImageService {
  private readonly bindings = new Map<string, string>()
  private readonly platform: NodeJS.Platform
  private readonly statFile: (path: string) => Promise<FileStat>

  constructor(private readonly options: ChatImageServiceOptions) {
    this.platform = options.platform ?? process.platform
    this.statFile = options.statFile ?? stat
  }

  bindThread(conversationId: string, threadId: string): void {
    this.bindings.set(conversationId, threadId)
  }

  async resolveImageSource(input: ChatImageRequest): Promise<ChatImageResolveResult> {
    try {
      const source = await this.resolve(chatImageRequestSchema.parse(input))
      return {
        status: 'available',
        displaySrc: source.displaySrc,
        ...(source.kind === 'local' ? { fileName: source.fileName } : {})
      }
    } catch (error) {
      return { status: 'unavailable', reason: errorMessage(error) }
    }
  }

  async saveImage(
    input: ChatImageSaveRequest,
    host: ChatImageSaveHost
  ): Promise<ChatImageSaveResult> {
    try {
      const request = chatImageSaveRequestSchema.parse(input)
      const source = await this.resolve(request)
      if (host.isDestroyed()) throw new Error('图片窗口已关闭')
      if (source.kind === 'http')
        return await host.downloadImage(source.displaySrc, request.fileName)

      const fileName =
        request.fileName ??
        (source.kind === 'local' ? source.fileName : `image.${extensionForMime(source.mimeType)}`)
      const path = await host.chooseSavePath(fileName)
      if (!path) return { status: 'cancelled' }
      if (host.isDestroyed()) throw new Error('图片窗口已关闭')
      if (source.kind === 'local') {
        // Recheck after the dialog; a file may have disappeared while it was open.
        if (!(await this.statFile(source.path)).isFile()) throw new Error('图片文件不可用')
        await (this.options.copyImage ?? copyFile)(source.path, path)
      } else {
        await (this.options.writeImage ?? writeFile)(path, source.bytes)
      }
      return { status: 'saved', path }
    } catch (error) {
      return { status: 'failed', message: errorMessage(error) }
    }
  }

  private async resolve(request: ChatImageRequest): Promise<ImageSource> {
    const { source } = request
    if (request.sourceKind !== 'native-path' && isExternalHttpUrl(source)) {
      return { kind: 'http', displaySrc: new URL(source).href }
    }
    if (request.sourceKind !== 'native-path' && source.startsWith('data:')) {
      const data = parseChatImageDataUrl(source)
      if (!data) throw new Error('图片数据格式无效')
      const bytes =
        data.encoding === 'base64' ? Buffer.from(data.data, 'base64') : decodeDataBytes(data.data)
      return { kind: 'data', displaySrc: source, mimeType: data.mimeType, bytes }
    }

    const target = await this.targetForRequest(request)
    if (target && target.hostId !== 'local') throw new Error('暂不支持读取远程宿主图片')
    const path = resolveChatImageLocalPath(request, target?.cwd ?? undefined, this.platform)
    const mimeType = mediaTypeForPath(path, this.platform)
    if (!mimeType || !isChatImageMimeType(mimeType)) throw new Error('不支持的图片类型')
    if (!(await this.statFile(path)).isFile()) throw new Error('图片来源不是文件')
    const displaySrc = toAppMediaUrl(path, this.platform)
    if (!displaySrc) throw new Error('图片地址无效')
    return {
      kind: 'local',
      path,
      displaySrc,
      fileName: (this.platform === 'win32' ? win32 : posix).basename(path)
    }
  }

  private async targetForRequest(
    request: ChatImageRequest
  ): Promise<ResolvedExecutionTarget | null> {
    const boundThread = request.conversationId
      ? this.bindings.get(request.conversationId)
      : undefined
    if (
      request.conversationId &&
      request.threadId &&
      request.conversationId !== request.threadId &&
      boundThread !== request.threadId
    ) {
      throw new Error('图片不属于指定任务')
    }
    // An unbound composer ID is not necessarily an app-server thread. Let the
    // project service inspect its saved assignment without attempting thread/read.
    const threadId = request.threadId ?? boundThread
    if (!threadId && !request.conversationId) return null
    const target = await this.options.projectService.resolveExistingThreadTarget({
      conversationId: request.conversationId ?? threadId!,
      threadId,
      allowActiveProjectFallback: false
    })
    if (!target && (request.threadId || boundThread))
      throw new Error('无法确定图片所属任务的工作目录')
    return target
  }
}

export function resolveChatImageLocalPath(
  request: Pick<ChatImageRequest, 'source' | 'sourceKind'>,
  cwd: string | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  const { source, sourceKind } = request
  const pathApi = platform === 'win32' ? win32 : posix
  let path: string
  if (source.startsWith('app:')) {
    const mediaPath = resolveAppMediaPath(source, platform)
    if (!mediaPath) throw new Error('图片媒体地址无效')
    return mediaPath
  }
  if (sourceKind === 'native-path') {
    path = source
  } else if (source.startsWith('file:')) {
    const url = new URL(source)
    if (url.host && url.host !== 'localhost') throw new Error('不支持的 file URL 宿主')
    if (url.search || url.hash) throw new Error('file URL 中的文件名必须使用 URL 编码')
    if (platform === 'win32') {
      if (/%2f|%5c/iu.test(url.pathname)) throw new Error('file URL 包含编码的路径分隔符')
      path = decodeURIComponent(url.pathname)
        .replace(/^\/([A-Za-z]:)/u, '$1')
        .replaceAll('/', '\\')
    } else {
      path = fileURLToPath(url)
    }
  } else {
    const rawPath = source.startsWith('sandbox:') ? source.slice('sandbox:'.length) : source
    const encodedWindowsAbsolute =
      platform === 'win32' && sourceKind === 'markdown-url' && /^[A-Za-z]:%5c/iu.test(rawPath)
    const rawAbsolute = pathApi.isAbsolute(rawPath) || encodedWindowsAbsolute
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(rawPath) &&
      !/^[A-Za-z]:[\\/]/u.test(rawPath) &&
      !encodedWindowsAbsolute
    ) {
      throw new Error('不支持的图片来源')
    }
    // The reference preserves URI separators in absolute URLs; relative URL
    // components decode all encoded filename characters before joining the cwd.
    path =
      sourceKind === 'markdown-url'
        ? rawAbsolute
          ? decodeURI(rawPath.replace(/%23/giu, '#').replace(/%3f/giu, '?'))
          : decodeURIComponent(rawPath)
        : rawPath
    if (sourceKind === 'markdown-url' && !rawAbsolute && pathApi.isAbsolute(path)) {
      throw new Error('相对图片地址不能转换为绝对路径')
    }
  }
  if (!path || path.includes('\0') || /^(?:\\\\|\/\/)/u.test(path)) {
    throw new Error('图片路径无效')
  }
  if (isSafeLocalOpenPath(path) && pathApi.isAbsolute(path)) return pathApi.normalize(path)
  if (pathApi.isAbsolute(path) || /^[A-Za-z]:/u.test(path))
    throw new Error('图片路径不属于当前系统')
  if (!cwd) throw new Error('相对图片地址需要所属任务的工作目录')
  return resolveLocalOpenPath({ path, cwd })
}

function decodeDataBytes(value: string): Buffer {
  // Percent escapes encode bytes, including non-UTF8 binary data URLs.
  const bytes: number[] = []
  for (let index = 0; index < value.length; ) {
    if (value[index] === '%') {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 3), 16))
      index += 3
    } else {
      const codePoint = value.codePointAt(index)!
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint)))
      index += codePoint > 0xffff ? 2 : 1
    }
  }
  return Buffer.from(bytes)
}

function extensionForMime(mimeType: string): string {
  return (
    { 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico' }[mimeType] ??
    mimeType.slice('image/'.length)
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '图片文件不存在'
  return error instanceof Error ? error.message : '图片不可用'
}
