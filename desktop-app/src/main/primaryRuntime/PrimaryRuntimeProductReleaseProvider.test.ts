import { createHash, generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { PrimaryRuntimeHttpClient } from './PrimaryRuntimeHttpClient'
import { PrimaryRuntimeProductConfigClient } from './PrimaryRuntimeProductConfigClient'
import { PrimaryRuntimeProductReleaseProvider } from './PrimaryRuntimeProductReleaseProvider'
import { SignedPrimaryRuntimeReleaseProvider } from './PrimaryRuntimeReleaseProvider'
import { canonicalPrimaryRuntimeReleaseManifestPayload } from './PrimaryRuntimeReleaseManifest'

const configKeys = generateKeyPairSync('ed25519')
const manifestKeys = generateKeyPairSync('ed25519')
const archiveBytes = new Uint8Array([1, 2, 3])
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')

const releaseBudget = {
  maxArchiveBytes: 1_000,
  maxUnpackedBytes: 2_000,
  minimumFreeDiskBytes: 5_750,
  maxColdInstallMs: 1_000,
  maxMainEventLoopDelayP99Ms: 50,
  maxMainEventLoopDelayMaxMs: 250
}

describe('PrimaryRuntimeProductReleaseProvider', () => {
  it('retries config and manifest snapshot-pair sequence mismatches before accepting trust', async () => {
    const fetchImpl = metadataFetch([
      signedConfig({ sequence: 10 }),
      signedManifest({ sequence: 9, version: 'stale-manifest' }),
      signedConfig({ sequence: 11 }),
      signedManifest({ sequence: 11, version: 'paired-runtime' })
    ])
    const trustState = trustStateStub()
    const persistHighestSequence = vi.fn(async () => undefined)
    const provider = productProvider({ fetchImpl, trustState, persistHighestSequence })

    await expect(provider.getRelease()).resolves.toMatchObject({
      version: 'paired-runtime',
      manifestSequence: 11
    })

    expect(trustState.accept).not.toHaveBeenCalled()
    expect(trustState.acceptMany).toHaveBeenCalledTimes(1)
    expect(trustState.acceptMany).toHaveBeenCalledWith([
      expect.objectContaining({ role: 'config', sequence: 11 }),
      expect.objectContaining({ role: 'manifest', sequence: 11 })
    ])
    expect(persistHighestSequence).toHaveBeenCalledWith(11)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('aborts after accepting the trust pair when the separate manifest sequence cache fails, then recovers on retry', async () => {
    const fetchImpl = metadataFetch([
      signedConfig({ sequence: 12 }),
      signedManifest({ sequence: 12, version: 'sequence-cache-failure' }),
      signedConfig({ sequence: 12 }),
      signedManifest({ sequence: 12, version: 'sequence-cache-failure' })
    ])
    const trustState = trustStateStub()
    let persistAttempts = 0
    const provider = productProvider({
      fetchImpl,
      trustState,
      persistHighestSequence: vi.fn(async () => {
        persistAttempts += 1
        if (persistAttempts === 1) throw new Error('read-only sequence cache')
      })
    })

    await expect(provider.getRelease()).rejects.toThrow('read-only sequence cache')
    expect(trustState.acceptMany).toHaveBeenCalledTimes(1)
    expect(trustState.acceptMany).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: 'config', sequence: 12 }),
      expect.objectContaining({ role: 'manifest', sequence: 12 })
    ])

    await expect(provider.getRelease()).resolves.toMatchObject({
      version: 'sequence-cache-failure',
      manifestSequence: 12
    })
    expect(trustState.acceptMany).toHaveBeenCalledTimes(2)
    expect(trustState.acceptMany).toHaveBeenLastCalledWith([
      expect.objectContaining({ role: 'config', sequence: 12 }),
      expect.objectContaining({ role: 'manifest', sequence: 12 })
    ])
  })

  it('rechecks metadata expiration immediately before committing the trust pair', async () => {
    const fetchImpl = metadataFetch([
      signedConfig({ sequence: 13, expiresAt: '2026-09-10T00:00:02.000Z' }),
      signedManifest({
        sequence: 13,
        version: 'expires-before-commit',
        expiresAt: '2026-09-10T00:00:02.000Z'
      })
    ])
    const trustState = trustStateStub()
    const commitTimes = [new Date('2026-09-10T00:00:01.000Z'), new Date('2026-09-10T00:00:03.000Z')]
    const provider = productProvider({
      fetchImpl,
      trustState,
      now: () => commitTimes.shift() ?? new Date('2026-09-10T00:00:03.000Z'),
      configNow: () => new Date('2026-09-10T00:00:01.000Z'),
      manifestNow: () => new Date('2026-09-10T00:00:01.000Z')
    })

    await expect(provider.getRelease()).rejects.toThrow('config has expired')
    expect(trustState.accept).not.toHaveBeenCalled()
    expect(trustState.acceptMany).not.toHaveBeenCalled()
  })

  it('fails without committing trust after the bounded snapshot-pair mismatch retry budget', async () => {
    const fetchImpl = metadataFetch([
      signedConfig({ sequence: 20 }),
      signedManifest({ sequence: 19, version: 'mismatch-1' }),
      signedConfig({ sequence: 21 }),
      signedManifest({ sequence: 20, version: 'mismatch-2' }),
      signedConfig({ sequence: 22 }),
      signedManifest({ sequence: 21, version: 'mismatch-3' })
    ])
    const trustState = trustStateStub()
    const provider = productProvider({ fetchImpl, trustState })

    await expect(provider.getRelease()).rejects.toThrow('snapshot pair sequence mismatch')
    expect(trustState.accept).not.toHaveBeenCalled()
    expect(trustState.acceptMany).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(6)
  })
})

function productProvider(input: {
  fetchImpl: typeof fetch
  trustState: ReturnType<typeof trustStateStub>
  persistHighestSequence?: (sequence: number) => Promise<void>
  now?: () => Date
  configNow?: () => Date
  manifestNow?: () => Date
}): PrimaryRuntimeProductReleaseProvider {
  const httpClient = new PrimaryRuntimeHttpClient({
    allowedOrigins: ['https://config.example.test', 'https://releases.example.test'],
    fetchImpl: input.fetchImpl
  })
  return new PrimaryRuntimeProductReleaseProvider({
    configClient: new PrimaryRuntimeProductConfigClient({
      configUrl: 'https://config.example.test/v1/runtime/config.json',
      channel: 'stable',
      configPublicKeys: { 'config-key': configKeys.publicKey },
      allowedConfigOrigins: ['https://config.example.test'],
      allowedManifestOrigins: ['https://releases.example.test'],
      httpClient,
      now: input.configNow ?? (() => new Date('2026-09-10T00:00:00.000Z'))
    }),
    trustState: input.trustState,
    now: input.now ?? (() => new Date('2026-09-10T00:00:00.000Z')),
    createManifestProvider: (config) =>
      new SignedPrimaryRuntimeReleaseProvider({
        manifestUrl: config.manifestUrl,
        allowedOrigins: ['https://releases.example.test'],
        channel: 'stable',
        publicKeys: { 'manifest-key': manifestKeys.publicKey },
        sequenceStore: {
          readHighestSequence: vi.fn(async () => undefined),
          persistHighestSequence: input.persistHighestSequence ?? vi.fn(async () => undefined)
        },
        trustState: input.trustState,
        httpClient,
        now: input.manifestNow ?? (() => new Date('2026-09-10T00:00:00.000Z'))
      })
  })
}

function trustStateStub(): {
  read: ReturnType<typeof vi.fn<() => Promise<undefined>>>
  accept: ReturnType<typeof vi.fn<() => Promise<void>>>
  acceptMany: ReturnType<typeof vi.fn<() => Promise<void>>>
} {
  return {
    read: vi.fn(async () => undefined),
    accept: vi.fn(async () => undefined),
    acceptMany: vi.fn(async () => undefined)
  }
}

function metadataFetch(responses: readonly Record<string, unknown>[]): typeof fetch {
  let index = 0
  return vi.fn(async () => {
    const response = responses[index]
    index += 1
    if (!response) return new Response('missing fixture', { status: 500 })
    return new Response(JSON.stringify(response))
  })
}

function signedConfig(input: { sequence: number; expiresAt?: string }): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 1,
    sequence: input.sequence,
    channel: 'stable',
    manifestUrl: 'https://releases.example.test/v1/runtime/manifest.json',
    pollIntervalMs: 60_000,
    issuedAt: '2026-09-09T00:00:00.000Z',
    expiresAt: input.expiresAt ?? '2026-09-11T00:00:00.000Z',
    keyId: 'config-key'
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(unsigned), 'utf8'),
      configKeys.privateKey
    ).toString('base64')
  }
}

function signedManifest(input: {
  sequence: number
  version: string
  expiresAt?: string
}): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 1,
    sequence: input.sequence,
    channel: 'stable',
    issuedAt: '2026-09-09T00:00:00.000Z',
    expiresAt: input.expiresAt ?? '2026-09-11T00:00:00.000Z',
    keyId: 'manifest-key',
    releases: [
      {
        platform: process.platform,
        arch: process.arch,
        version: input.version,
        archiveFormat: 'zip',
        archiveUrl: 'https://releases.example.test/runtime.zip',
        archiveSizeBytes: archiveBytes.byteLength,
        archiveSha256,
        budget: releaseBudget
      }
    ]
  }
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(unsigned), 'utf8'),
      manifestKeys.privateKey
    ).toString('base64')
  }
}
