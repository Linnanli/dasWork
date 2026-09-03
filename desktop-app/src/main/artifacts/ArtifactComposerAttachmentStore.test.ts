import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { ArtifactComposerAttachmentStore } from './ArtifactComposerAttachmentStore'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('ArtifactComposerAttachmentStore', () => {
  it('keeps paths out of the renderer reference and resolves only an unchanged source', async () => {
    const directory = await fixtureDirectory()
    const path = join(directory, 'deck.pptx')
    await writeFile(path, 'first version')
    const metadata = await stat(path)
    const store = new ArtifactComposerAttachmentStore()
    const attachment = store.issue({
      sourceId: 'source-id-12345678',
      absolutePath: path,
      identity: {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs
      },
      label: 'deck.pptx'
    })

    expect(JSON.stringify(attachment)).not.toContain(path)
    expect(attachment.url).toMatch(/^dascowork-artifact:\/\//u)

    const restored = await store.restoreInMessages([
      {
        id: 'user-1',
        role: 'user',
        parts: [
          {
            type: 'file',
            url: attachment.url,
            mediaType: 'application/vnd.dascowork.local-file',
            filename: 'deck.pptx'
          }
        ]
      }
    ])
    expect(restored[0]?.parts[0]).toMatchObject({ url: pathToFileURL(path).href })

    await writeFile(path, 'a changed presentation')
    await expect(
      store.restoreInMessages([
        {
          id: 'user-2',
          role: 'user',
          parts: [
            {
              type: 'file',
              url: attachment.url,
              mediaType: 'application/vnd.dascowork.local-file'
            }
          ]
        }
      ])
    ).rejects.toThrow('source has changed')
  })

  it('expires opaque attachment references', async () => {
    let now = 1_000
    const store = new ArtifactComposerAttachmentStore(() => now, 10)
    const attachment = store.issue({
      sourceId: 'source-id-12345678',
      absolutePath: '/private/unread/deck.pptx',
      identity: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
      label: 'deck.pptx'
    })
    now = 1_011

    await expect(
      store.restoreInMessages([
        {
          id: 'user-1',
          role: 'user',
          parts: [
            {
              type: 'file',
              url: attachment.url,
              mediaType: 'application/vnd.dascowork.local-file'
            }
          ]
        }
      ])
    ).rejects.toThrow('unavailable')
  })
})

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-artifact-attachment-'))
  directories.push(directory)
  return directory
}
