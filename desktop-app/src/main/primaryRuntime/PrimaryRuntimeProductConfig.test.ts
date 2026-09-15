import { generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { PrimaryRuntimeHttpClient } from './PrimaryRuntimeHttpClient'
import {
  parseAndVerifyPrimaryRuntimeProductConfig,
  productConfigTrustRecord
} from './PrimaryRuntimeProductConfig'
import { canonicalPrimaryRuntimeReleaseManifestPayload } from './PrimaryRuntimeReleaseManifest'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const now = new Date('2026-09-10T00:00:00.000Z')

describe('Primary Runtime product config', () => {
  it('verifies a signed config within its separate config and manifest trust domains', () => {
    const config = signedConfig()
    const verified = parseAndVerifyPrimaryRuntimeProductConfig({
      config,
      publicKeys: { 'config-2026-01': publicKey },
      allowedConfigOrigins: ['https://config.example.test'],
      allowedManifestOrigins: ['https://releases.example.test'],
      channel: 'stable',
      now
    })

    expect(verified).toMatchObject({
      sequence: 3,
      channel: 'stable',
      manifestUrl: 'https://releases.example.test/v1/manifest.json'
    })
    expect(
      productConfigTrustRecord({
        config: verified,
        origin: 'https://config.example.test/v1/config.json',
        acceptedAt: now
      })
    ).toMatchObject({
      role: 'config',
      sequence: 3,
      origin: 'https://config.example.test'
    })
  })

  it('rejects tampering, expired config, a wrong key role, and an untrusted manifest origin', () => {
    const config = signedConfig()
    const input = {
      publicKeys: { 'config-2026-01': publicKey },
      allowedConfigOrigins: ['https://config.example.test'],
      allowedManifestOrigins: ['https://releases.example.test'],
      channel: 'stable',
      now
    }
    expect(() =>
      parseAndVerifyPrimaryRuntimeProductConfig({
        ...input,
        config: { ...config, channel: 'beta' }
      })
    ).toThrow('channel')
    expect(() =>
      parseAndVerifyPrimaryRuntimeProductConfig({
        ...input,
        config: { ...config, expiresAt: '2026-09-09T12:00:00.000Z' }
      })
    ).toThrow('expired')
    expect(() =>
      parseAndVerifyPrimaryRuntimeProductConfig({
        ...input,
        config: { ...config, keyId: 'manifest-2026-01' }
      })
    ).toThrow('unknown key')
    expect(() =>
      parseAndVerifyPrimaryRuntimeProductConfig({
        ...input,
        config: { ...config, manifestUrl: 'https://mirror.example.test/manifest.json' }
      })
    ).toThrow('allowlist')
  })
})

describe('PrimaryRuntimeHttpClient', () => {
  it('uses an exact HTTPS origin, blocks redirects, and bounds JSON metadata', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}'))
    const client = new PrimaryRuntimeHttpClient({
      allowedOrigins: ['https://feed.example.test'],
      fetchImpl
    })

    await expect(client.getJson('https://feed.example.test/v1/config.json')).resolves.toEqual({
      ok: true
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://feed.example.test/v1/config.json'),
      expect.objectContaining({ redirect: 'error' })
    )
    expect(() => client.validateUrl('http://feed.example.test/v1/config.json')).toThrow('allowlist')
    expect(() => client.validateUrl('https://feed.example.test.evil/v1/config.json')).toThrow(
      'allowlist'
    )
  })
})

function signedConfig(): Record<string, unknown> {
  const unsigned = {
    schemaVersion: 1,
    sequence: 3,
    channel: 'stable',
    manifestUrl: 'https://releases.example.test/v1/manifest.json',
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
