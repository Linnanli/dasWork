import { createPublicKey, randomUUID, verify, type KeyObject } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

import type {
  PrimaryRuntimeArch,
  PrimaryRuntimePlatform,
  PrimaryRuntimeReleaseDescriptor
} from './primaryRuntimeTypes'

const MAX_MANIFEST_BYTES = 1024 * 1024

const manifestReleaseSchema = z
  .object({
    platform: z.string().min(1),
    arch: z.string().min(1),
    version: z.string().min(1),
    archiveFormat: z.literal('zip'),
    archiveUrl: z.string().url(),
    archiveSizeBytes: z.number().int().positive(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict()

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    channel: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    keyId: z.string().min(1),
    releases: z.array(manifestReleaseSchema).min(1),
    signature: z.string().min(1)
  })
  .strict()

const sequenceFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    highestSequence: z.number().int().positive()
  })
  .strict()

export type PrimaryRuntimeSignedReleaseManifest = z.infer<typeof manifestSchema>
export type PrimaryRuntimeManifestPublicKey = string | KeyObject

/**
 * Product release engineering populates this immutable keyring when a formal
 * Runtime feed is provisioned. An empty keyring is intentionally fail-closed.
 */
export const PRIMARY_RUNTIME_MANIFEST_PUBLIC_KEYS: Readonly<
  Record<string, PrimaryRuntimeManifestPublicKey>
> = Object.freeze({})

export type PrimaryRuntimeManifestSequenceStore = {
  readHighestSequence(): Promise<number | undefined>
  persistHighestSequence(sequence: number): Promise<void>
}

export type PrimaryRuntimeVerifiedRelease = PrimaryRuntimeReleaseDescriptor & {
  archiveUrl: string
  allowedOrigins: readonly string[]
  sequence: number
}

export function parseAndVerifyPrimaryRuntimeReleaseManifest(input: {
  manifest: unknown
  publicKeys: Readonly<Record<string, PrimaryRuntimeManifestPublicKey>>
  allowedOrigins: readonly string[]
  channel: string
  platform: PrimaryRuntimePlatform
  arch: PrimaryRuntimeArch
  now: Date
  highestAcceptedSequence?: number
}): PrimaryRuntimeVerifiedRelease {
  const manifest = manifestSchema.parse(input.manifest)
  if (manifest.channel !== input.channel) {
    throw new Error('Primary Runtime manifest channel does not match the configured channel.')
  }

  const issuedAt = Date.parse(manifest.issuedAt)
  const expiresAt = Date.parse(manifest.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('Primary Runtime manifest has an invalid validity window.')
  }
  const now = input.now.getTime()
  if (issuedAt > now) throw new Error('Primary Runtime manifest is not valid yet.')
  if (expiresAt <= now) throw new Error('Primary Runtime manifest has expired.')
  if (
    input.highestAcceptedSequence !== undefined &&
    manifest.sequence < input.highestAcceptedSequence
  ) {
    throw new Error('Primary Runtime manifest sequence has rolled back.')
  }

  const key = input.publicKeys[manifest.keyId]
  if (!key) throw new Error(`Primary Runtime manifest uses unknown key ID: ${manifest.keyId}.`)
  const signature = decodeBase64Signature(manifest.signature)
  const unsigned = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => key !== 'signature')
  )
  if (
    !verify(
      null,
      Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(unsigned), 'utf8'),
      publicKeyFor(key),
      signature
    )
  ) {
    throw new Error('Primary Runtime manifest signature is invalid.')
  }

  const releases = manifest.releases.filter(
    (release) => release.platform === input.platform && release.arch === input.arch
  )
  if (releases.length !== 1) {
    throw new Error(
      'Primary Runtime manifest has no unique release for this platform and architecture.'
    )
  }
  const release = releases[0]
  const archiveUrl = validateArchiveUrl(release.archiveUrl, input.allowedOrigins)
  return {
    version: release.version,
    archiveFormat: release.archiveFormat,
    archiveSizeBytes: release.archiveSizeBytes,
    archiveSha256: release.archiveSha256,
    archiveUrl: archiveUrl.toString(),
    allowedOrigins: normalizedAllowedOrigins(input.allowedOrigins),
    sequence: manifest.sequence
  }
}

export function canonicalPrimaryRuntimeReleaseManifestPayload(
  value: Record<string, unknown>
): string {
  return canonicalJson(value)
}

export async function fetchPrimaryRuntimeReleaseManifest(input: {
  manifestUrl: string
  allowedOrigins: readonly string[]
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<unknown> {
  const manifestUrl = validateArchiveUrl(input.manifestUrl, input.allowedOrigins)
  const response = await (input.fetchImpl ?? fetch)(manifestUrl, {
    method: 'GET',
    redirect: 'error',
    ...(input.signal ? { signal: input.signal } : {})
  })
  if (!response.ok) {
    throw new Error(`Primary Runtime manifest request failed: HTTP ${response.status}`)
  }
  const advertisedLength = response.headers.get('content-length')
  if (
    advertisedLength !== null &&
    (!/^\d+$/u.test(advertisedLength) || Number(advertisedLength) > MAX_MANIFEST_BYTES)
  ) {
    throw new Error('Primary Runtime manifest exceeds the permitted size.')
  }
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('Primary Runtime manifest exceeds the permitted size.')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Primary Runtime manifest is not valid JSON.')
  }
}

export class FilePrimaryRuntimeManifestSequenceStore implements PrimaryRuntimeManifestSequenceStore {
  constructor(private readonly statePath: string) {}

  async readHighestSequence(): Promise<number | undefined> {
    try {
      return sequenceFileSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')))
        .highestSequence
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async persistHighestSequence(sequence: number): Promise<void> {
    const current = await this.readHighestSequence()
    if (current !== undefined && sequence <= current) return

    await mkdir(dirname(this.statePath), { recursive: true })
    const temporaryPath = `${this.statePath}.next-${randomUUID()}`
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify({ schemaVersion: 1, highestSequence: sequence })}\n`)
      await file.sync()
      await file.close()
      await rename(temporaryPath, this.statePath)
    } finally {
      await file.close().catch(() => undefined)
    }
  }
}

function validateArchiveUrl(value: string, allowedOrigins: readonly string[]): URL {
  const archiveUrl = new URL(value)
  if (
    archiveUrl.protocol !== 'https:' ||
    archiveUrl.username ||
    archiveUrl.password ||
    archiveUrl.hash
  ) {
    throw new Error(
      'Primary Runtime manifest URL must use HTTPS without credentials or a fragment.'
    )
  }
  if (!normalizedAllowedOrigins(allowedOrigins).includes(archiveUrl.origin)) {
    throw new Error('Primary Runtime manifest URL origin is not in the trusted allowlist.')
  }
  return archiveUrl
}

function normalizedAllowedOrigins(origins: readonly string[]): string[] {
  if (origins.length === 0) {
    throw new Error('Primary Runtime manifest trusted origin allowlist must not be empty.')
  }
  return [...new Set(origins.map(normalizedAllowedOrigin))]
}

function normalizedAllowedOrigin(origin: string): string {
  const url = new URL(origin)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Primary Runtime manifest trusted origins must be exact HTTPS origins.')
  }
  return url.origin
}

function decodeBase64Signature(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('Primary Runtime manifest signature is not base64.')
  }
  const signature = Buffer.from(value, 'base64')
  if (signature.byteLength === 0) throw new Error('Primary Runtime manifest signature is empty.')
  return signature
}

function publicKeyFor(key: PrimaryRuntimeManifestPublicKey): KeyObject {
  if (typeof key === 'string') return createPublicKey(key)
  if (key.type !== 'public') {
    throw new Error('Primary Runtime manifest keyring must contain public keys.')
  }
  return key
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Primary Runtime manifest has a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Primary Runtime manifest has an unsupported value.')
  }

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}
