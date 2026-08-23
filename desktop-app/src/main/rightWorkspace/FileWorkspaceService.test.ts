import { mkdtemp, realpath, symlink, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  FILE_WORKSPACE_API_VERSION,
  isFileWorkspacePathUnavailableResult
} from '../../shared/fileWorkspaceApi'
import {
  FileWorkspaceService,
  type FileWorkspacePathSearchProviderLike
} from './FileWorkspaceService'

const roots: string[] = []

async function createFixture(pathSearch?: FileWorkspacePathSearchProviderLike): Promise<{
  root: string
  outside: string
  service: FileWorkspaceService
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-file-workspace-')))
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-file-workspace-outside-')))
  roots.push(root, outside)
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'src', 'components'))
  await mkdir(join(root, 'target'))
  await writeFile(join(root, 'src', 'components', 'index.ts'), 'export const fixture = true\n')
  await writeFile(join(root, 'target', 'index.ts'), 'build artifact\n')
  await writeFile(join(root, 'src', 'hello.txt'), 'hello workspace\nsecond line\n')
  await writeFile(join(root, 'src', 'binary.dat'), Buffer.from([0, 1, 2, 3]))
  await writeFile(
    join(root, 'src', 'preview.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA', 'base64')
  )
  await writeFile(join(root, 'large.txt'), '0123456789')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'src', 'escape.txt'))

  return {
    root,
    outside,
    service: new FileWorkspaceService({
      resolveRoot: async (rootId) => (rootId === 'project-1' ? root : null),
      ...(pathSearch ? { pathSearch } : {})
    })
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('FileWorkspaceService', () => {
  it('lists a directory lazily with workspace-relative entries', async () => {
    const { service } = await createFixture()

    const result = await service.listDirectory({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      path: 'src'
    })
    if (isFileWorkspacePathUnavailableResult(result)) {
      throw new Error(`Expected directory listing, received ${result.unavailable}`)
    }

    expect(result.entries.map((entry) => entry.path)).toEqual([
      'src/binary.dat',
      'src/components',
      'src/escape.txt',
      'src/hello.txt',
      'src/preview.png'
    ])
    expect(result.truncated).toBe(false)
  })

  it('returns domain-level unavailable results when a directory or file no longer exists', async () => {
    const { service } = await createFixture()

    await expect(
      service.listDirectory({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'missing'
      })
    ).resolves.toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      path: 'missing',
      unavailable: 'not-found'
    })

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/missing.ts'
      })
    ).resolves.toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      path: 'src/missing.ts',
      unavailable: 'not-found'
    })

    await expect(
      service.metadata({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/missing.ts'
      })
    ).resolves.toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      path: 'src/missing.ts',
      unavailable: 'not-found'
    })
  })

  it('distinguishes an unavailable workspace root from a missing child path', async () => {
    const { service } = await createFixture()

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'missing-project',
        path: 'src/hello.txt'
      })
    ).resolves.toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'missing-project',
      path: 'src/hello.txt',
      unavailable: 'workspace-unavailable'
    })
  })

  it('returns workspace-unavailable when the resolved project directory disappeared', async () => {
    const { root, service } = await createFixture()
    await rm(root, { recursive: true, force: true })

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/hello.txt'
      })
    ).resolves.toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      path: 'src/hello.txt',
      unavailable: 'workspace-unavailable'
    })
  })

  it('rejects symlinks that escape the project root', async () => {
    const { service } = await createFixture()

    await expect(
      service.metadata({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/escape.txt'
      })
    ).rejects.toThrow('escapes')

    await expect(
      service.resolveFileForSystemOpen({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/escape.txt'
      })
    ).rejects.toThrow('escapes')
  })

  it('reads text, small binary, and too-large files with thresholds', async () => {
    const { service } = await createFixture()

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/hello.txt'
      })
    ).resolves.toMatchObject({
      content: { kind: 'text', text: 'hello workspace\nsecond line\n' }
    })

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/binary.dat'
      })
    ).resolves.toMatchObject({
      content: { kind: 'binary', base64: 'AAECAw==' }
    })

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/preview.png'
      })
    ).resolves.toMatchObject({
      content: {
        kind: 'media',
        mediaType: 'image/png',
        url: expect.stringContaining('app://fs/@fs/')
      }
    })

    await expect(
      service.readFile({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'large.txt',
        textByteLimit: 4,
        binaryByteLimit: 4
      })
    ).resolves.toMatchObject({
      content: { kind: 'too-large', binary: false, size: 10, limit: 4 }
    })
  })

  it('searches path names and text content under the selected root', async () => {
    const { service } = await createFixture()

    const result = await service.search({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      query: 'workspace',
      includeContent: true
    })

    expect(result.matches).toContainEqual({
      path: 'src/hello.txt',
      kind: 'content',
      line: 1,
      preview: 'hello workspace'
    })
  })

  it('searches nested file names without traversing build-output directories', async () => {
    const { service } = await createFixture()

    const result = await service.search({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      query: 'index.ts',
      includeContent: false
    })

    expect(result.matches).toEqual([
      { path: 'src/components/index.ts', kind: 'path', preview: 'index.ts' }
    ])
  })

  it('streams app-server fuzzy search results through one reusable session', async () => {
    let callbacks:
      | Parameters<FileWorkspacePathSearchProviderLike['createFuzzyFileSearchSession']>[0]
      | undefined
    const update = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const provider: FileWorkspacePathSearchProviderLike = {
      createFuzzyFileSearchSession: vi.fn(async (input) => {
        callbacks = input
        return { update, stop }
      })
    }
    const { root, service } = await createFixture(provider)
    const publish = vi.fn()
    const session = await service.startSearchSession(
      { version: FILE_WORKSPACE_API_VERSION, rootId: 'project-1' },
      publish
    )

    await service.updateSearchSession({
      version: FILE_WORKSPACE_API_VERSION,
      sessionId: session.sessionId,
      query: 'index'
    })
    callbacks?.onUpdated(
      [
        {
          root,
          path: 'src/components/index.ts',
          match_type: 'file',
          file_name: 'index.ts'
        },
        {
          root,
          path: 'target/index.ts',
          match_type: 'file',
          file_name: 'index.ts'
        }
      ],
      'index'
    )
    callbacks?.onUpdated(
      [
        {
          root,
          path: 'src/hello.txt',
          match_type: 'file',
          file_name: 'hello.txt'
        }
      ],
      'stale'
    )
    callbacks?.onCompleted('index')

    const publishedIndexResult = publish.mock.calls.at(-1)?.[0]

    await service.updateSearchSession({
      version: FILE_WORKSPACE_API_VERSION,
      sessionId: session.sessionId,
      query: 'hello'
    })
    expect(publish).toHaveBeenLastCalledWith(publishedIndexResult)
    callbacks?.onUpdated(
      [
        {
          root,
          path: 'src/hello.txt',
          match_type: 'file',
          file_name: 'hello.txt'
        }
      ],
      'hello'
    )
    callbacks?.onCompleted('hello')

    expect(provider.createFuzzyFileSearchSession).toHaveBeenCalledTimes(1)
    expect(update.mock.calls).toEqual([['index'], ['hello']])
    expect(publish).toHaveBeenLastCalledWith({
      version: FILE_WORKSPACE_API_VERSION,
      type: 'search-results',
      rootId: 'project-1',
      sessionId: session.sessionId,
      query: 'hello',
      matches: [{ path: 'src/hello.txt', kind: 'path', preview: 'hello.txt' }],
      complete: true
    })

    await service.updateSearchSession({
      version: FILE_WORKSPACE_API_VERSION,
      sessionId: session.sessionId,
      query: ''
    })
    callbacks?.onUpdated([], '')
    callbacks?.onCompleted('')

    expect(update.mock.calls).toEqual([['index'], ['hello'], ['']])
    expect(publish).toHaveBeenLastCalledWith({
      version: FILE_WORKSPACE_API_VERSION,
      type: 'search-results',
      rootId: 'project-1',
      sessionId: session.sessionId,
      query: '',
      matches: [],
      complete: true
    })

    await service.stopSearchSession({
      version: FILE_WORKSPACE_API_VERSION,
      sessionId: session.sessionId
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('returns unavailable roots and rejects traversal before filesystem access', async () => {
    const { service } = await createFixture()

    await expect(
      service.metadata({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'missing',
        path: 'src/hello.txt'
      })
    ).resolves.toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'missing',
      path: 'src/hello.txt',
      unavailable: 'workspace-unavailable'
    })

    await expect(
      service.metadata({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: '../secret.txt'
      })
    ).rejects.toThrow('normalized relative path')
  })
})
