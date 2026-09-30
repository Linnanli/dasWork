import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatImageRequest } from '../../shared/chatImageApi'
import type { ResolvedExecutionTarget } from '../../shared/projects/projectTypes'
import { toAppMediaUrl } from '../localMediaProtocol'
import {
  ChatImageService,
  resolveChatImageLocalPath,
  type ChatImageSaveHost
} from './ChatImageService'

const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJwAAAABJRU5ErkJggg==',
  'base64'
)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  service: ChatImageService
  resolveExistingThreadTarget: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), 'chat-image-'))
  roots.push(root)
  const target: ResolvedExecutionTarget = {
    hostId: 'local',
    cwd: root,
    workspaceRoots: [root],
    workspaceKind: 'project'
  }
  const resolveExistingThreadTarget = vi.fn().mockResolvedValue(target)
  const service = new ChatImageService({ projectService: { resolveExistingThreadTarget } })
  return { root, service, resolveExistingThreadTarget }
}
function request(
  source: string,
  sourceKind: ChatImageRequest['sourceKind'] = 'markdown-url'
): ChatImageRequest {
  return { source, sourceKind, conversationId: 'thread-one', threadId: 'thread-one' }
}
function host(path: string | null): ChatImageSaveHost {
  return {
    isDestroyed: () => false,
    chooseSavePath: vi.fn().mockResolvedValue(path),
    downloadImage: vi.fn()
  }
}

describe('chat image local source parsing', () => {
  it.each([
    ['/images/a%20b%23%3F%E4%B8%AD.png', '/images/a b#?中.png'],
    ['/images/literal%2520.png', '/images/literal%20.png'],
    ['/images/literal%2523%253F.png', '/images/literal%23%3F.png'],
    ['sandbox:/images/a%20b.png', '/images/a b.png'],
    ['file:///images/literal%2520.png', '/images/literal%20.png']
  ])('decodes Markdown URL once: %s', (source, path) => {
    expect(
      resolveChatImageLocalPath({ source, sourceKind: 'markdown-url' }, undefined, 'darwin')
    ).toBe(path)
  })
  it('preserves percent escapes and punctuation in native filenames', () => {
    const source = '/images/a%20%23#?中.png'
    expect(
      resolveChatImageLocalPath({ source, sourceKind: 'native-path' }, undefined, 'darwin')
    ).toBe(source)
  })
  it.each([
    ['a%2Cb%3Bc.png', '/workspace/a,b;c.png'],
    ['a%252Cb%253Bc.png', '/workspace/a%2Cb%3Bc.png'],
    ['%23%3F%20%E4%B8%AD.png', '/workspace/#? 中.png']
  ])('decodes relative URL components once: %s', (source, path) => {
    expect(
      resolveChatImageLocalPath({ source, sourceKind: 'markdown-url' }, '/workspace', 'darwin')
    ).toBe(path)
  })
  it.each([
    ['C:\\images\\a%20b.png', 'native-path', 'C:\\images\\a%20b.png'],
    ['C:\\images\\literal%5C.png', 'native-path', 'C:\\images\\literal%5C.png'],
    ['C:/images/a%20b.png', 'markdown-url', 'C:\\images\\a b.png'],
    ['C:%5Cimages%5Ca%20%E4%B8%AD%23%2520.png', 'markdown-url', 'C:\\images\\a 中#%20.png'],
    ['c:%5cimages%5ca%25235c.png', 'markdown-url', 'c:\\images\\a%235c.png'],
    ['file:///C:/images/a%20%E4%B8%AD%2520.png', 'media-url', 'C:\\images\\a 中%20.png'],
    ['app://fs/@fs/C:/images/a%20b.png', 'media-url', 'C:\\images\\a b.png']
  ] as const)('handles Windows sources explicitly: %s', (source, sourceKind, path) => {
    expect(resolveChatImageLocalPath({ source, sourceKind }, undefined, 'win32')).toBe(path)
  })
  it('does not reinterpret encoded Windows separators for native paths or other platforms', () => {
    const source = 'C:%5Cimages%5Ca.png'
    expect(() =>
      resolveChatImageLocalPath({ source, sourceKind: 'native-path' }, undefined, 'win32')
    ).toThrow()
    expect(() =>
      resolveChatImageLocalPath({ source, sourceKind: 'markdown-url' }, undefined, 'darwin')
    ).toThrow()
    expect(() =>
      resolveChatImageLocalPath(
        { source: 'C:%255Cimages%255Ca.png', sourceKind: 'markdown-url' },
        undefined,
        'win32'
      )
    ).toThrow()
  })
  it.each([
    'file://server/share/a.png',
    '/bad%ZZ.png',
    'https://example.com/a.png',
    'app://-/a.png',
    'blob:unowned'
  ])('rejects invalid local addresses: %s', (source) => {
    expect(() =>
      resolveChatImageLocalPath({ source, sourceKind: 'markdown-url' }, undefined, 'darwin')
    ).toThrow()
  })
})

describe('chat image service', () => {
  it('validates an encoded Windows Markdown path before creating its app media URL', async () => {
    const statFile = vi.fn().mockResolvedValue({ isFile: () => true })
    const service = new ChatImageService({
      platform: 'win32',
      statFile,
      projectService: { resolveExistingThreadTarget: vi.fn().mockResolvedValue(null) }
    })
    expect(
      await service.resolveImageSource({
        source: 'C:%5Cimages%5Ca%20%E4%B8%AD%23%2520.png',
        sourceKind: 'markdown-url'
      })
    ).toEqual({
      status: 'available',
      displaySrc: 'app://fs/@fs/C:/images/a%20%E4%B8%AD%23%2520.png',
      fileName: 'a 中#%20.png'
    })
    expect(statFile).toHaveBeenCalledWith('C:\\images\\a 中#%20.png')
  })
  it('checks real files and returns the existing streaming media URL for all local forms', async () => {
    const { root, service } = await fixture()
    const path = join(root, '空 格#?%20.png')
    await writeFile(path, bytes)
    const encoded = encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F')
    for (const input of [
      request(encoded),
      request(`sandbox:${encoded}`),
      request(pathToFileURL(path).href, 'media-url'),
      request(path, 'native-path'),
      request(toAppMediaUrl(path)!, 'media-url')
    ]) {
      expect(await service.resolveImageSource(input)).toEqual({
        status: 'available',
        displaySrc: toAppMediaUrl(path),
        fileName: '空 格#?%20.png'
      })
    }
  })
  it('uses the owning thread target without active-project fallback', async () => {
    const { root, service, resolveExistingThreadTarget } = await fixture()
    await writeFile(join(root, 'same.png'), bytes)
    expect((await service.resolveImageSource(request('same.png'))).status).toBe('available')
    expect(resolveExistingThreadTarget).toHaveBeenCalledWith({
      conversationId: 'thread-one',
      threadId: 'thread-one',
      allowActiveProjectFallback: false
    })
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'same.png'), bytes)
    resolveExistingThreadTarget.mockResolvedValueOnce({ hostId: 'local', cwd: other })
    expect(
      await service.resolveImageSource({
        ...request('same.png'),
        conversationId: 'thread-two',
        threadId: 'thread-two'
      })
    ).toMatchObject({ displaySrc: toAppMediaUrl(join(other, 'same.png')) })
  })
  it('rejects an unbound conversation/thread mismatch but accepts a Main-owned binding', async () => {
    const { root, service, resolveExistingThreadTarget } = await fixture()
    await writeFile(join(root, 'same.png'), bytes)
    const input = { ...request('same.png'), conversationId: 'draft' }
    expect(await service.resolveImageSource(input)).toEqual({
      status: 'unavailable',
      reason: '图片不属于指定任务'
    })
    expect(resolveExistingThreadTarget).not.toHaveBeenCalled()
    service.bindThread('draft', 'thread-one')
    expect((await service.resolveImageSource(input)).status).toBe('available')
    expect(await service.resolveImageSource({ ...input, threadId: 'other-thread' })).toMatchObject({
      status: 'unavailable'
    })
  })
  it('rejects no-thread relative paths, traversal, directories, missing images and non-images', async () => {
    const { root, service } = await fixture()
    expect(
      await service.resolveImageSource({ source: 'same.png', sourceKind: 'markdown-url' })
    ).toMatchObject({ status: 'unavailable' })
    expect(await service.resolveImageSource(request('../outside.png'))).toMatchObject({
      status: 'unavailable'
    })
    await mkdir(join(root, 'directory.png'))
    await writeFile(join(root, 'notes.pdf'), bytes)
    for (const name of ['directory.png', 'missing.png', 'notes.pdf']) {
      expect(await service.resolveImageSource(request(name))).toMatchObject({
        status: 'unavailable'
      })
    }
    expect(
      await service.resolveImageSource(request('app://fs/@fs' + root + '/notes.pdf', 'media-url'))
    ).toMatchObject({ status: 'unavailable' })
  })
  it('allows a picked absolute media image before the draft has a thread', async () => {
    const { root, service, resolveExistingThreadTarget } = await fixture()
    const path = join(root, 'draft.png')
    await writeFile(path, bytes)
    resolveExistingThreadTarget.mockResolvedValue(null)
    expect(
      await service.resolveImageSource({
        source: toAppMediaUrl(path)!,
        sourceKind: 'media-url',
        conversationId: 'draft'
      })
    ).toMatchObject({ status: 'available' })
    expect(resolveExistingThreadTarget).toHaveBeenLastCalledWith({
      conversationId: 'draft',
      threadId: undefined,
      allowActiveProjectFallback: false
    })
    expect(
      await service.resolveImageSource({
        source: 'draft.png',
        sourceKind: 'markdown-url',
        conversationId: 'draft'
      })
    ).toMatchObject({ status: 'unavailable' })
  })
  it('rejects a remote task even when its path exists locally', async () => {
    const { root, service, resolveExistingThreadTarget } = await fixture()
    const path = join(root, 'same.png')
    await writeFile(path, bytes)
    resolveExistingThreadTarget.mockResolvedValue({ hostId: 'ssh:test', cwd: root })
    expect(await service.resolveImageSource(request(path, 'native-path'))).toEqual({
      status: 'unavailable',
      reason: '暂不支持读取远程宿主图片'
    })
  })
  it('resolves validated HTTP/data sources and rejects arbitrary blob/non-image data', async () => {
    const { service } = await fixture()
    const data = 'data:image/png;base64,' + bytes.toString('base64')
    expect(await service.resolveImageSource(request(data, 'media-url'))).toEqual({
      status: 'available',
      displaySrc: data
    })
    expect(
      await service.resolveImageSource(request('https://example.com/image.png', 'media-url'))
    ).toEqual({ status: 'available', displaySrc: 'https://example.com/image.png' })
    for (const source of [
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png;base64,???',
      'data:image/svg+xml,%XX',
      'blob:app://-/unowned'
    ]) {
      expect(await service.resolveImageSource(request(source, 'media-url'))).toMatchObject({
        status: 'unavailable'
      })
    }
  })
  it('copies original local bytes and preserves data URL bytes when saving', async () => {
    const { root, service } = await fixture()
    const source = join(root, '空 格%20.png')
    await writeFile(source, bytes)
    const localSave = join(root, 'saved-local.png')
    const dataSave = join(root, 'saved-data.png')
    expect(await service.saveImage(request(source, 'native-path'), host(localSave))).toEqual({
      status: 'saved',
      path: localSave
    })
    expect(await readFile(localSave)).toEqual(bytes)
    expect(
      await service.saveImage(
        request('data:image/png;base64,' + bytes.toString('base64'), 'media-url'),
        host(dataSave)
      )
    ).toEqual({ status: 'saved', path: dataSave })
    expect(await readFile(dataSave)).toEqual(bytes)
    const encodedSave = join(root, 'saved-percent.png')
    const encoded = [...bytes].map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('')
    expect(
      (
        await service.saveImage(
          request('data:image/png,' + encoded, 'media-url'),
          host(encodedSave)
        )
      ).status
    ).toBe('saved')
    expect(await readFile(encodedSave)).toEqual(bytes)
  })
  it('reports cancellation and failed copy, and refuses writes after owner destruction', async () => {
    const { root, service } = await fixture()
    const source = join(root, 'same.png')
    await writeFile(source, bytes)
    expect(await service.saveImage(request(source, 'native-path'), host(null))).toEqual({
      status: 'cancelled'
    })
    expect(
      (
        await service.saveImage(
          request(source, 'native-path'),
          host(join(root, 'absent', 'saved.png'))
        )
      ).status
    ).toBe('failed')
    const saveHost = host(join(root, 'saved.png'))
    saveHost.chooseSavePath = async () => {
      saveHost.isDestroyed = () => true
      return join(root, 'saved.png')
    }
    expect(await service.saveImage(request(source, 'native-path'), saveHost)).toEqual({
      status: 'failed',
      message: '图片窗口已关闭'
    })
  })
})
