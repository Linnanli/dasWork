import { mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ARTIFACT_PREVIEW_API_VERSION,
  ARTIFACT_PREVIEW_MAX_BYTES,
  isArtifactPreviewUnavailableResult,
  type ArtifactPreviewFileIdentity
} from '../../shared/artifactPreviewApi'
import {
  ArtifactPreviewSourceService,
  WorkspaceUnavailableError,
  type ArtifactPreviewResolvedWorkspaceFile
} from './ArtifactPreviewSourceService'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('ArtifactPreviewSourceService', () => {
  it('uses opaque source ids and does not expose the native local path', async () => {
    const directory = await fixtureDirectory()
    const path = join(directory, 'deck.pptx')
    await writeFile(path, 'pptx bytes')
    const service = createService(directory)

    const result = await service.registerAuthorizedLocalSource({
      version: ARTIFACT_PREVIEW_API_VERSION,
      capabilityToken: 'valid-preview-capability-token'
    })

    expect(result.sourceId).toMatch(/^[A-Za-z0-9_-]{16,}$/u)
    expect(JSON.stringify(result)).not.toContain(path)
    expect(result.metadata.name).toBe('deck.pptx')
  })

  it('mints a separate opaque composer reference after revalidating the source', async () => {
    const directory = await fixtureDirectory()
    await writeFile(join(directory, 'deck.pptx'), 'pptx bytes')
    const service = createService(directory)
    const registered = await service.registerWorkspaceSource({
      version: ARTIFACT_PREVIEW_API_VERSION,
      rootId: 'workspace-1',
      path: 'deck.pptx'
    })

    const result = await service.createComposerAttachment(registered.sourceId)
    expect(result).toMatchObject({
      sourceId: registered.sourceId,
      attachment: {
        sourceId: registered.sourceId,
        label: 'deck.pptx',
        url: expect.stringMatching(/^dascowork-artifact:\/\//u)
      }
    })
  })

  it('performs a bounded limit + 1 read even when the file grew after metadata', async () => {
    const directory = await fixtureDirectory()
    const path = join(directory, 'deck.pptx')
    await writeFile(path, 'initial')
    const service = createService(directory)
    const registered = await service.registerWorkspaceSource({
      version: ARTIFACT_PREVIEW_API_VERSION,
      rootId: 'workspace-1',
      path: 'deck.pptx'
    })

    // This reproduces the stat/read TOCTOU boundary: registration observes a
    // small file, then a later read must still never load the entire larger file.
    await writeFile(path, Buffer.alloc(ARTIFACT_PREVIEW_MAX_BYTES + 1, 0x61))
    const result = await service.readBinary(registered.sourceId)

    expect('content' in result && result.content).toMatchObject({
      kind: 'too-large',
      size: ARTIFACT_PREVIEW_MAX_BYTES + 1,
      limit: ARTIFACT_PREVIEW_MAX_BYTES,
      generation: 1
    })
  })

  it('invalidates an authorized local source when the file identity changes', async () => {
    const directory = await fixtureDirectory()
    const path = join(directory, 'deck.pptx')
    const replacement = join(directory, 'replacement.pptx')
    await writeFile(path, 'first')
    const service = createService(directory)
    const registered = await service.registerAuthorizedLocalSource({
      version: ARTIFACT_PREVIEW_API_VERSION,
      capabilityToken: 'valid-preview-capability-token'
    })
    await writeFile(replacement, 'second')
    await rename(replacement, path)

    const result = await service.metadata(registered.sourceId)
    expect(isArtifactPreviewUnavailableResult(result) && result.unavailable).toBe(
      'identity-changed'
    )
  })

  it('treats a missing workspace root as unavailable instead of accepting an arbitrary path', async () => {
    const service = new ArtifactPreviewSourceService({
      resolveWorkspaceFile: async () => {
        throw new WorkspaceUnavailableError()
      },
      redeemAuthorizedLocalPreview: async () => {
        throw new Error('not used')
      }
    })
    await expect(
      service.registerWorkspaceSource({
        version: ARTIFACT_PREVIEW_API_VERSION,
        rootId: 'missing-root',
        path: 'deck.pptx'
      })
    ).rejects.toBeInstanceOf(WorkspaceUnavailableError)
  })

  it('does not retain an expired source capability', async () => {
    const directory = await fixtureDirectory()
    const path = join(directory, 'deck.pptx')
    await writeFile(path, 'pptx bytes')
    let now = 100
    const service = createService(directory, () => now, 10)
    const registered = await service.registerWorkspaceSource({
      version: ARTIFACT_PREVIEW_API_VERSION,
      rootId: 'workspace-1',
      path: 'deck.pptx'
    })
    now = 111

    const result = await service.readBinary(registered.sourceId)
    expect(isArtifactPreviewUnavailableResult(result) && result.unavailable).toBe('expired')
  })

  it('depends on the workspace resolver to reject symlink escapes before issuing a source', async () => {
    const directory = await fixtureDirectory()
    const outside = await fixtureDirectory()
    await writeFile(join(outside, 'secret.pptx'), 'secret')
    await symlink(join(outside, 'secret.pptx'), join(directory, 'escaped.pptx'))
    const service = new ArtifactPreviewSourceService({
      resolveWorkspaceFile: async () => {
        throw new Error('Workspace path escapes the project root.')
      },
      redeemAuthorizedLocalPreview: async () => {
        throw new Error('not used')
      }
    })

    await expect(
      service.registerWorkspaceSource({
        version: ARTIFACT_PREVIEW_API_VERSION,
        rootId: 'workspace-1',
        path: 'escaped.pptx'
      })
    ).rejects.toThrow('escapes the project root')
  })
})

function createService(
  directory: string,
  now?: () => number,
  ttlMs?: number
): ArtifactPreviewSourceService {
  return new ArtifactPreviewSourceService({
    resolveWorkspaceFile: async ({
      rootId,
      path
    }): Promise<ArtifactPreviewResolvedWorkspaceFile> => {
      if (rootId !== 'workspace-1') throw new WorkspaceUnavailableError()
      const absolutePath = join(directory, path)
      return { absolutePath, relativePath: path, identity: await identity(absolutePath) }
    },
    redeemAuthorizedLocalPreview: async () => {
      const absolutePath = join(directory, 'deck.pptx')
      return { absolutePath, identity: await identity(absolutePath) }
    },
    issueComposerAttachment: ({ sourceId, label }) => ({
      sourceId,
      label,
      url: `dascowork-artifact://${sourceId}/attachment-id-12345678`
    }),
    ...(now ? { now } : {}),
    ...(ttlMs ? { ttlMs } : {})
  })
}

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-artifact-preview-'))
  directories.push(directory)
  return directory
}

async function identity(path: string): Promise<ArtifactPreviewFileIdentity> {
  const value = await stat(path)
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs }
}
