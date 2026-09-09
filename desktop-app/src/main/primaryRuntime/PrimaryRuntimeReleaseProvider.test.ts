import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  SignedPrimaryRuntimeReleaseProvider,
  TrustedPrimaryRuntimeReleaseProvider
} from './PrimaryRuntimeReleaseProvider'
import { canonicalPrimaryRuntimeReleaseManifestPayload } from './PrimaryRuntimeReleaseManifest'

const directories: string[] = []
const archiveBytes = new Uint8Array([1, 2, 3])
const release = {
  version: '2026.09.06',
  archiveFormat: 'zip' as const,
  archiveSizeBytes: archiveBytes.byteLength,
  archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
  archiveUrl: 'https://releases.example.test/runtime.zip',
  allowedOrigins: ['https://releases.example.test']
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('TrustedPrimaryRuntimeReleaseProvider', () => {
  it('streams the exact configured descriptor to a verified archive file and blocks redirects', async () => {
    const fetchImpl = vi.fn(async () => new Response(archiveBytes))
    const provider = new TrustedPrimaryRuntimeReleaseProvider(release, fetchImpl)
    const destinationPath = await fixtureArchivePath()

    await expect(provider.getRelease()).resolves.toEqual({
      version: release.version,
      archiveFormat: 'zip',
      archiveSizeBytes: archiveBytes.byteLength,
      archiveSha256: release.archiveSha256
    })
    await expect(
      provider.downloadArchive(
        await provider.getRelease(),
        destinationPath,
        new AbortController().signal
      )
    ).resolves.toEqual({
      path: destinationPath,
      sizeBytes: archiveBytes.byteLength,
      sha256: release.archiveSha256
    })
    await expect(readFile(destinationPath)).resolves.toEqual(Buffer.from(archiveBytes))
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL(release.archiveUrl),
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    )
    await expect(
      provider.downloadArchive(
        { ...(await provider.getRelease()), version: 'unexpected' },
        await fixtureArchivePath(),
        new AbortController().signal
      )
    ).rejects.toThrow('does not match')
  })

  it('removes incomplete archive files after an oversized or invalid response', async () => {
    const destinationPath = await fixtureArchivePath()
    const oversized = new TrustedPrimaryRuntimeReleaseProvider(
      release,
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4])))
    )
    await expect(
      oversized.downloadArchive(
        await oversized.getRelease(),
        destinationPath,
        new AbortController().signal
      )
    ).rejects.toThrow('exceeds the trusted release size')
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a non-HTTPS release source', () => {
    expect(
      () =>
        new TrustedPrimaryRuntimeReleaseProvider({
          ...release,
          archiveUrl: 'http://localhost/runtime.zip'
        })
    ).toThrow('HTTPS')
  })

  it('rejects release URLs outside the exact trusted origin allowlist', () => {
    expect(
      () =>
        new TrustedPrimaryRuntimeReleaseProvider({
          ...release,
          archiveUrl: 'https://mirror.example.test/runtime.zip'
        })
    ).toThrow('not in the trusted allowlist')
    expect(
      () =>
        new TrustedPrimaryRuntimeReleaseProvider({
          ...release,
          allowedOrigins: ['https://releases.example.test/path']
        })
    ).toThrow('exact HTTPS origins')
  })

  it('rejects an advertised length mismatch before it writes the archive', async () => {
    const provider = new TrustedPrimaryRuntimeReleaseProvider(
      release,
      vi.fn(async () => new Response(archiveBytes, { headers: { 'content-length': '4' } }))
    )
    await expect(
      provider.downloadArchive(
        await provider.getRelease(),
        await fixtureArchivePath(),
        new AbortController().signal
      )
    ).rejects.toThrow('Content-Length')
  })

  it('downloads only an archive selected by a verified signed manifest', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const unsigned = {
      schemaVersion: 1,
      sequence: 7,
      channel: 'stable',
      issuedAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-08T00:00:00.000Z',
      keyId: 'release-key',
      releases: [
        {
          platform: process.platform,
          arch: process.arch,
          version: release.version,
          archiveFormat: 'zip',
          archiveUrl: release.archiveUrl,
          archiveSizeBytes: archiveBytes.byteLength,
          archiveSha256: release.archiveSha256
        }
      ]
    }
    const manifest = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(unsigned), 'utf8'),
        privateKey
      ).toString('base64')
    }
    let highestSequence: number | undefined
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(new Response(archiveBytes))
    const provider = new SignedPrimaryRuntimeReleaseProvider({
      manifestUrl: 'https://releases.example.test/manifest.json',
      allowedOrigins: ['https://releases.example.test'],
      channel: 'stable',
      publicKeys: { 'release-key': publicKey },
      sequenceStore: {
        async readHighestSequence() {
          return highestSequence
        },
        async persistHighestSequence(sequence) {
          highestSequence = sequence
        }
      },
      now: () => new Date('2026-09-07T00:00:00.000Z'),
      fetchImpl
    })

    const descriptor = await provider.getRelease()
    await expect(
      provider.downloadArchive(descriptor, await fixtureArchivePath(), new AbortController().signal)
    ).resolves.toMatchObject({ sha256: release.archiveSha256 })
    expect(highestSequence).toBe(7)
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      new URL('https://releases.example.test/manifest.json'),
      expect.objectContaining({ redirect: 'error' })
    )
  })
})

async function fixtureArchivePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primary-runtime-release-provider-'))
  directories.push(root)
  return join(root, 'downloads', 'runtime.zip')
}
