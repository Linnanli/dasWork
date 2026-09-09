import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PrimaryRuntimeReleaseDescriptor } from './primaryRuntimeTypes'
import {
  fetchPrimaryRuntimeReleaseManifest,
  parseAndVerifyPrimaryRuntimeReleaseManifest,
  type PrimaryRuntimeManifestPublicKey,
  type PrimaryRuntimeManifestSequenceStore
} from './PrimaryRuntimeReleaseManifest'

export type PrimaryRuntimeReleaseProvider = {
  getRelease(): Promise<PrimaryRuntimeReleaseDescriptor | null>
  downloadArchive(
    descriptor: PrimaryRuntimeReleaseDescriptor,
    destinationPath: string,
    signal: AbortSignal
  ): Promise<PrimaryRuntimeDownloadedArchive>
}

export type PrimaryRuntimeDownloadedArchive = {
  path: string
  sizeBytes: number
  sha256: string
}

export type TrustedPrimaryRuntimeRelease = PrimaryRuntimeReleaseDescriptor & {
  archiveUrl: string
  allowedOrigins: readonly string[]
}

/**
 * A main-process-only provider for an explicitly configured, immutable
 * release. It deliberately has no discovery endpoint or fallback URL: a
 * release is trusted only when its URL, version, size and digest were supplied
 * together by the desktop runtime configuration.
 */
export class TrustedPrimaryRuntimeReleaseProvider implements PrimaryRuntimeReleaseProvider {
  private readonly descriptor: PrimaryRuntimeReleaseDescriptor
  private readonly archiveUrl: URL

  constructor(
    release: TrustedPrimaryRuntimeRelease,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const archiveUrl = new URL(release.archiveUrl)
    if (
      archiveUrl.protocol !== 'https:' ||
      archiveUrl.username ||
      archiveUrl.password ||
      archiveUrl.hash
    ) {
      throw new Error(
        'Primary Runtime release URL must use HTTPS without credentials or a fragment.'
      )
    }
    const allowedOrigins = normalizedAllowedOrigins(release.allowedOrigins)
    if (!allowedOrigins.includes(archiveUrl.origin)) {
      throw new Error('Primary Runtime release URL origin is not in the trusted allowlist.')
    }
    this.archiveUrl = archiveUrl
    this.descriptor = {
      version: release.version,
      archiveFormat: release.archiveFormat,
      archiveSizeBytes: release.archiveSizeBytes,
      archiveSha256: release.archiveSha256
    }
  }

  async getRelease(): Promise<PrimaryRuntimeReleaseDescriptor> {
    return { ...this.descriptor }
  }

  async downloadArchive(
    descriptor: PrimaryRuntimeReleaseDescriptor,
    destinationPath: string,
    signal: AbortSignal
  ): Promise<PrimaryRuntimeDownloadedArchive> {
    if (!sameDescriptor(descriptor, this.descriptor)) {
      throw new Error('Primary Runtime release descriptor does not match the trusted release.')
    }
    const response = await this.fetchImpl(this.archiveUrl, {
      method: 'GET',
      redirect: 'error',
      signal
    })
    if (!response.ok) {
      throw new Error(`Primary Runtime archive download failed: HTTP ${response.status}`)
    }
    const advertisedLength = response.headers.get('content-length')
    if (
      advertisedLength !== null &&
      (!/^\d+$/u.test(advertisedLength) || Number(advertisedLength) !== descriptor.archiveSizeBytes)
    ) {
      throw new Error('Primary Runtime archive Content-Length does not match the trusted release.')
    }
    if (!response.body) {
      throw new Error('Primary Runtime archive response has no body.')
    }

    await mkdir(dirname(destinationPath), { recursive: true })
    const temporaryPath = `${destinationPath}.part-${randomUUID()}`
    const handle = await open(temporaryPath, 'wx', 0o600)
    const reader = response.body.getReader()
    const sha256 = createHash('sha256')
    let bytesWritten = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        throwIfAborted(signal)
        if (bytesWritten + value.byteLength > descriptor.archiveSizeBytes) {
          throw new Error('Primary Runtime archive exceeds the trusted release size.')
        }
        await writeAll(handle, value)
        sha256.update(value)
        bytesWritten += value.byteLength
      }
      if (bytesWritten !== descriptor.archiveSizeBytes) {
        throw new Error('Primary Runtime archive is shorter than the trusted release size.')
      }
      const digest = sha256.digest('hex')
      if (digest !== descriptor.archiveSha256) {
        throw new Error('Primary Runtime archive SHA256 does not match the trusted release.')
      }
      await handle.sync()
      await handle.close()
      await rename(temporaryPath, destinationPath)
      await chmod(destinationPath, 0o400)
      return { path: destinationPath, sizeBytes: bytesWritten, sha256: digest }
    } finally {
      await handle.close().catch(() => undefined)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
      await rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }
}

export type SignedPrimaryRuntimeReleaseProviderInput = {
  manifestUrl: string
  allowedOrigins: readonly string[]
  channel: string
  publicKeys: Readonly<Record<string, PrimaryRuntimeManifestPublicKey>>
  sequenceStore: PrimaryRuntimeManifestSequenceStore
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
  now?: () => Date
  fetchImpl?: typeof fetch
}

/**
 * Fetches a signed product manifest, rejects stale or replayed metadata, then
 * delegates archive streaming to the same immutable-descriptor downloader used
 * by explicit development and enterprise overrides.
 */
export class SignedPrimaryRuntimeReleaseProvider implements PrimaryRuntimeReleaseProvider {
  private readonly platform: NodeJS.Platform
  private readonly arch: NodeJS.Architecture
  private readonly now: () => Date
  private readonly fetchImpl: typeof fetch
  private archiveProvider: TrustedPrimaryRuntimeReleaseProvider | undefined
  private descriptor: PrimaryRuntimeReleaseDescriptor | undefined

  constructor(private readonly input: SignedPrimaryRuntimeReleaseProviderInput) {
    if (Object.keys(input.publicKeys).length === 0) {
      throw new Error('Primary Runtime manifest keyring is empty.')
    }
    this.platform = input.platform ?? process.platform
    this.arch = input.arch ?? process.arch
    this.now = input.now ?? (() => new Date())
    this.fetchImpl = input.fetchImpl ?? fetch
  }

  async getRelease(): Promise<PrimaryRuntimeReleaseDescriptor> {
    const manifest = await fetchPrimaryRuntimeReleaseManifest({
      manifestUrl: this.input.manifestUrl,
      allowedOrigins: this.input.allowedOrigins,
      fetchImpl: this.fetchImpl
    })
    const verified = parseAndVerifyPrimaryRuntimeReleaseManifest({
      manifest,
      publicKeys: this.input.publicKeys,
      allowedOrigins: this.input.allowedOrigins,
      channel: this.input.channel,
      platform: this.platform,
      arch: this.arch,
      now: this.now(),
      highestAcceptedSequence: await this.input.sequenceStore.readHighestSequence()
    })
    await this.input.sequenceStore.persistHighestSequence(verified.sequence)

    this.descriptor = {
      version: verified.version,
      archiveFormat: verified.archiveFormat,
      archiveSizeBytes: verified.archiveSizeBytes,
      archiveSha256: verified.archiveSha256
    }
    this.archiveProvider = new TrustedPrimaryRuntimeReleaseProvider(
      {
        ...this.descriptor,
        archiveUrl: verified.archiveUrl,
        allowedOrigins: verified.allowedOrigins
      },
      this.fetchImpl
    )
    return { ...this.descriptor }
  }

  async downloadArchive(
    descriptor: PrimaryRuntimeReleaseDescriptor,
    destinationPath: string,
    signal: AbortSignal
  ): Promise<PrimaryRuntimeDownloadedArchive> {
    if (!this.archiveProvider || !this.descriptor || !sameDescriptor(descriptor, this.descriptor)) {
      throw new Error('Primary Runtime release descriptor does not match the verified manifest.')
    }
    return this.archiveProvider.downloadArchive(descriptor, destinationPath, signal)
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) throw new Error('Primary Runtime archive write made no progress.')
    offset += bytesWritten
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Primary Runtime installation was cancelled.', 'AbortError')
  }
}

function normalizedAllowedOrigins(origins: readonly string[]): string[] {
  if (origins.length === 0) {
    throw new Error('Primary Runtime trusted origin allowlist must not be empty.')
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
    throw new Error('Primary Runtime trusted origins must be exact HTTPS origins.')
  }
  return url.origin
}

function sameDescriptor(
  left: PrimaryRuntimeReleaseDescriptor,
  right: PrimaryRuntimeReleaseDescriptor
): boolean {
  return (
    left.version === right.version &&
    left.archiveFormat === right.archiveFormat &&
    left.archiveSizeBytes === right.archiveSizeBytes &&
    left.archiveSha256 === right.archiveSha256
  )
}
