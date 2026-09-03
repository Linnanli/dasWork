import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactPreviewSourceManifest } from './ArtifactPreviewSourceManifest'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('ArtifactPreviewSourceManifest', () => {
  it('persists only valid, non-expired local preview identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dascowork-artifact-manifest-'))
    directories.push(directory)
    const manifest = new ArtifactPreviewSourceManifest(join(directory, 'sources.json'))
    manifest.upsert({
      sourceId: 'source-id-12345678',
      absolutePath: '/private/allowed/deck.pptx',
      identity: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      expiresAt: 4_000_000_000_000
    })
    manifest.upsert({
      sourceId: 'expired-source-1234',
      absolutePath: '/private/allowed/old.pptx',
      identity: { dev: 1, ino: 3, size: 3, mtimeMs: 4 },
      expiresAt: 3_000_000_000_000
    })

    expect(manifest.load(3_500_000_000_000)).toEqual([
      expect.objectContaining({
        sourceId: 'source-id-12345678',
        absolutePath: '/private/allowed/deck.pptx'
      })
    ])
    manifest.remove('source-id-12345678')
    expect(manifest.load(3_500_000_000_000)).toEqual([])
  })
})
