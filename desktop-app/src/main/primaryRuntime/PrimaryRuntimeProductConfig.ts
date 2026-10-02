import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'

import { z } from 'zod'

import { canonicalPrimaryRuntimeReleaseManifestPayload } from './PrimaryRuntimeReleaseManifest'
import type { PrimaryRuntimeTrustRecord } from './PrimaryRuntimeTrustStateStore'

const productConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    channel: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
    manifestUrl: z.string().url(),
    pollIntervalMs: z
      .number()
      .int()
      .min(30_000)
      .max(7 * 24 * 60 * 60 * 1000),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    keyId: z.string().min(1),
    signature: z.string().min(1)
  })
  .strict()

export type PrimaryRuntimeProductConfig = z.infer<typeof productConfigSchema>
export type PrimaryRuntimeProductConfigPublicKey = string | KeyObject

export type PrimaryRuntimeVerifiedProductConfig = Omit<PrimaryRuntimeProductConfig, 'signature'> & {
  payloadHash: string
}

export function parseAndVerifyPrimaryRuntimeProductConfig(input: {
  config: unknown
  publicKeys: Readonly<Record<string, PrimaryRuntimeProductConfigPublicKey>>
  allowedConfigOrigins: readonly string[]
  allowedManifestOrigins: readonly string[]
  channel: string
  now: Date
}): PrimaryRuntimeVerifiedProductConfig {
  const config = productConfigSchema.parse(input.config)
  if (config.channel !== input.channel) {
    throw new Error('Primary Runtime config channel does not match the product channel.')
  }
  assertCurrentMetadata(config, input.now, 'config')
  assertAllowedUrl(config.manifestUrl, input.allowedManifestOrigins, 'manifest')
  // Config origin belongs to the request policy, while the manifest is checked
  // independently so remote config cannot expand trust to arbitrary archives.
  if (input.allowedConfigOrigins.length === 0) {
    throw new Error('Primary Runtime config trusted origin allowlist must not be empty.')
  }
  const key = input.publicKeys[config.keyId]
  if (!key) throw new Error(`Primary Runtime config uses unknown key ID: ${config.keyId}.`)
  const unsigned = Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'signature'))
  const canonical = canonicalPrimaryRuntimeReleaseManifestPayload(unsigned)
  if (
    !verify(
      null,
      Buffer.from(canonical, 'utf8'),
      publicKeyFor(key),
      decodeSignature(config.signature)
    )
  ) {
    throw new Error('Primary Runtime config signature is invalid.')
  }
  return {
    ...unsigned,
    payloadHash: createHash('sha256').update(canonical).digest('hex')
  } as PrimaryRuntimeVerifiedProductConfig
}

export function productConfigTrustRecord(input: {
  config: PrimaryRuntimeVerifiedProductConfig
  origin: string
  acceptedAt: Date
}): PrimaryRuntimeTrustRecord {
  return {
    sequence: input.config.sequence,
    payloadHash: input.config.payloadHash,
    keyId: input.config.keyId,
    acceptedAt: input.acceptedAt.toISOString(),
    origin: new URL(input.origin).origin,
    channel: input.config.channel,
    role: 'config'
  }
}

function assertCurrentMetadata(
  value: Pick<PrimaryRuntimeProductConfig, 'issuedAt' | 'expiresAt'>,
  now: Date,
  kind: string
): void {
  const issuedAt = Date.parse(value.issuedAt)
  const expiresAt = Date.parse(value.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error(`Primary Runtime ${kind} has an invalid validity window.`)
  }
  if (issuedAt > now.getTime()) throw new Error(`Primary Runtime ${kind} is not valid yet.`)
  if (expiresAt <= now.getTime()) throw new Error(`Primary Runtime ${kind} has expired.`)
}

function assertAllowedUrl(value: string, origins: readonly string[], label: string): void {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !origins.map((origin) => new URL(origin).origin).includes(url.origin)
  ) {
    throw new Error(`Primary Runtime ${label} URL is outside the trusted HTTPS origin allowlist.`)
  }
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Primary Runtime config signature is not base64.')
  }
  const signature = Buffer.from(value, 'base64')
  if (signature.byteLength === 0) throw new Error('Primary Runtime config signature is empty.')
  return signature
}

function publicKeyFor(key: PrimaryRuntimeProductConfigPublicKey): KeyObject {
  if (typeof key === 'string') return createPublicKey(key)
  if (key.type !== 'public')
    throw new Error('Primary Runtime config keyring must contain public keys.')
  return key
}
