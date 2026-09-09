import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  canonicalPrimaryRuntimeReleaseManifestPayload,
  fetchPrimaryRuntimeReleaseManifest,
  FilePrimaryRuntimeManifestSequenceStore,
  parseAndVerifyPrimaryRuntimeReleaseManifest
} from './PrimaryRuntimeReleaseManifest'

const directories: string[] = []
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const now = new Date('2026-09-07T00:00:00.000Z')

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('Primary Runtime signed release manifest', () => {
  it('accepts one signed, current, platform-specific release', () => {
    const manifest = signedManifest()

    expect(
      parseAndVerifyPrimaryRuntimeReleaseManifest({
        manifest,
        publicKeys: { 'release-2026-01': publicKey },
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        now,
        highestAcceptedSequence: 41
      })
    ).toMatchObject({
      version: '2026.09.07',
      archiveFormat: 'zip',
      archiveSizeBytes: 3,
      sequence: 42,
      archiveUrl: 'https://releases.example.test/runtime.zip'
    })
  })

  it('rejects modified, expired, unknown-key, and replayed manifests', () => {
    const manifest = signedManifest()

    expect(() =>
      parseAndVerifyPrimaryRuntimeReleaseManifest({
        manifest: { ...manifest, channel: 'beta' },
        publicKeys: { 'release-2026-01': publicKey },
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        now
      })
    ).toThrow('channel')
    expect(() =>
      parseAndVerifyPrimaryRuntimeReleaseManifest({
        manifest: {
          ...manifest,
          releases: [
            { ...(manifest.releases as Record<string, unknown>[])[0], version: 'tampered' }
          ]
        },
        publicKeys: { 'release-2026-01': publicKey },
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        now
      })
    ).toThrow('signature is invalid')
    expect(() =>
      parseAndVerifyPrimaryRuntimeReleaseManifest({
        manifest: { ...manifest, expiresAt: '2026-09-06T12:00:00.000Z' },
        publicKeys: { 'release-2026-01': publicKey },
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        now
      })
    ).toThrow('expired')
    expect(() =>
      parseAndVerifyPrimaryRuntimeReleaseManifest({
        manifest: { ...manifest, keyId: 'unknown' },
        publicKeys: { 'release-2026-01': publicKey },
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        now
      })
    ).toThrow('unknown key ID')
    expect(() =>
      parseAndVerifyPrimaryRuntimeReleaseManifest({
        manifest,
        publicKeys: { 'release-2026-01': publicKey },
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        platform: process.platform,
        arch: process.arch,
        now,
        highestAcceptedSequence: 43
      })
    ).toThrow('rolled back')
  })

  it('rejects oversized manifest responses and persists only monotonic sequences', async () => {
    await expect(
      fetchPrimaryRuntimeReleaseManifest({
        manifestUrl: 'https://releases.example.test/manifest.json',
        allowedOrigins: ['https://releases.example.test'],
        fetchImpl: vi.fn(
          async () => new Response('{}', { headers: { 'content-length': '1048577' } })
        )
      })
    ).rejects.toThrow('permitted size')

    const root = await mkdtemp(join(tmpdir(), 'primary-runtime-manifest-sequence-'))
    directories.push(root)
    const store = new FilePrimaryRuntimeManifestSequenceStore(join(root, 'sequence.json'))
    await store.persistHighestSequence(42)
    await store.persistHighestSequence(41)
    expect(await store.readHighestSequence()).toBe(42)
  })
})

function signedManifest(): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 1,
    sequence: 42,
    channel: 'stable',
    issuedAt: '2026-09-06T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
    keyId: 'release-2026-01',
    releases: [
      {
        platform: process.platform,
        arch: process.arch,
        version: '2026.09.07',
        archiveFormat: 'zip',
        archiveUrl: 'https://releases.example.test/runtime.zip',
        archiveSizeBytes: 3,
        archiveSha256: 'a'.repeat(64)
      }
    ]
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(unsigned), 'utf8'),
      privateKey
    ).toString('base64')
  }
}
