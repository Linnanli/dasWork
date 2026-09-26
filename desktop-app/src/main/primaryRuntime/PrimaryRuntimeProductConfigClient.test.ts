import { generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { PrimaryRuntimeHttpClient } from './PrimaryRuntimeHttpClient'
import { PrimaryRuntimeProductConfigClient } from './PrimaryRuntimeProductConfigClient'
import { canonicalPrimaryRuntimeReleaseManifestPayload } from './PrimaryRuntimeReleaseManifest'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')

describe('PrimaryRuntimeProductConfigClient', () => {
  it('returns a verified config without committing trust before the manifest pair is verified', async () => {
    const client = new PrimaryRuntimeProductConfigClient({
      configUrl: 'https://config.example.test/v1/runtime/config.json',
      channel: 'stable',
      configPublicKeys: { 'config-2026-01': publicKey },
      allowedConfigOrigins: ['https://config.example.test'],
      allowedManifestOrigins: ['https://releases.example.test'],
      httpClient: new PrimaryRuntimeHttpClient({
        allowedOrigins: ['https://config.example.test'],
        fetchImpl: vi.fn(async () => new Response(JSON.stringify(signedConfig())))
      }),
      now: () => new Date('2026-09-10T00:00:00.000Z')
    })

    await expect(client.getConfig()).resolves.toMatchObject({ sequence: 9, channel: 'stable' })
    expect(client.configOrigin).toBe('https://config.example.test')
  })

  it('never treats a manifest-only origin as a valid product-config endpoint', () => {
    expect(
      () =>
        new PrimaryRuntimeProductConfigClient({
          configUrl: 'https://releases.example.test/v1/runtime/config.json',
          channel: 'stable',
          configPublicKeys: { 'config-2026-01': publicKey },
          allowedConfigOrigins: ['https://config.example.test'],
          allowedManifestOrigins: ['https://releases.example.test'],
          httpClient: new PrimaryRuntimeHttpClient({
            // The Main HTTP client deliberately serves both metadata roles;
            // the role-specific client must still reject this endpoint.
            allowedOrigins: ['https://config.example.test', 'https://releases.example.test']
          })
        })
    ).toThrow('config-origin allowlist')
  })
})

function signedConfig(): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 1,
    sequence: 9,
    channel: 'stable',
    manifestUrl: 'https://releases.example.test/v1/runtime/channels/stable/manifest.json',
    pollIntervalMs: 60_000,
    issuedAt: '2026-09-09T00:00:00.000Z',
    expiresAt: '2026-09-11T00:00:00.000Z',
    keyId: 'config-2026-01'
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
