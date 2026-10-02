import type { PrimaryRuntimeReleaseDescriptor } from './primaryRuntimeTypes'
import { productConfigTrustRecord } from './PrimaryRuntimeProductConfig'
import { PrimaryRuntimeProductConfigClient } from './PrimaryRuntimeProductConfigClient'
import {
  SignedPrimaryRuntimeReleaseProvider,
  type PrimaryRuntimeDownloadProgress,
  type PrimaryRuntimeDownloadedArchive,
  type PrimaryRuntimeReleaseProvider
} from './PrimaryRuntimeReleaseProvider'
import type {
  PrimaryRuntimeTrustRecord,
  PrimaryRuntimeTrustStateStore
} from './PrimaryRuntimeTrustStateStore'

const MAX_METADATA_PAIR_ATTEMPTS = 3

/**
 * Resolves each release through signed product config before consuming the
 * channel manifest. It has no direct archive fallback, so a bad config cannot
 * silently bypass key roles, origin checks, or anti-equivocation state.
 */
export class PrimaryRuntimeProductReleaseProvider implements PrimaryRuntimeReleaseProvider {
  private activeProvider: PrimaryRuntimeReleaseProvider | undefined
  private lastPollIntervalMs: number | undefined

  constructor(
    private readonly input: {
      configClient: PrimaryRuntimeProductConfigClient
      trustState: PrimaryRuntimeTrustStateStore
      now?: () => Date
      createManifestProvider(
        config: Awaited<ReturnType<PrimaryRuntimeProductConfigClient['getConfig']>>
      ): SignedPrimaryRuntimeReleaseProvider
    }
  ) {}

  async getRelease(): Promise<PrimaryRuntimeReleaseDescriptor> {
    let lastMismatch: Error | undefined
    for (let attempt = 1; attempt <= MAX_METADATA_PAIR_ATTEMPTS; attempt += 1) {
      const verifiedAt = this.now()
      const config = await this.input.configClient.getConfig()
      this.lastPollIntervalMs = config.pollIntervalMs
      const provider = this.input.createManifestProvider(config)
      const verifiedManifest = await provider.getVerifiedRelease({
        acceptTrust: false,
        acceptedAt: verifiedAt
      })
      if (config.sequence !== verifiedManifest.trustRecord.sequence) {
        lastMismatch = new Error(
          `Primary Runtime snapshot pair sequence mismatch: config ${config.sequence}, manifest ${verifiedManifest.trustRecord.sequence}.`
        )
        continue
      }

      const acceptedAt = this.now()
      assertMetadataCurrent('config', config, acceptedAt)
      assertMetadataCurrent('manifest', verifiedManifest, acceptedAt)
      await this.acceptTrustPair([
        productConfigTrustRecord({
          config,
          origin: this.input.configClient.configOrigin,
          acceptedAt
        }),
        {
          ...verifiedManifest.trustRecord,
          acceptedAt: acceptedAt.toISOString()
        }
      ])
      await verifiedManifest.persistHighestSequence()
      this.activeProvider = provider
      return verifiedManifest.descriptor
    }

    throw (
      lastMismatch ??
      new Error('Primary Runtime product config and manifest snapshot pair could not be verified.')
    )
  }

  pollIntervalMs(fallback: number): number {
    return this.lastPollIntervalMs ?? fallback
  }

  async downloadArchive(
    descriptor: PrimaryRuntimeReleaseDescriptor,
    destinationPath: string,
    signal: AbortSignal,
    onProgress?: (progress: PrimaryRuntimeDownloadProgress) => void
  ): Promise<PrimaryRuntimeDownloadedArchive> {
    if (!this.activeProvider) {
      throw new Error(
        'Primary Runtime archive was requested before signed product config selection.'
      )
    }
    return this.activeProvider.downloadArchive(descriptor, destinationPath, signal, onProgress)
  }

  private now(): Date {
    return this.input.now?.() ?? new Date()
  }

  private async acceptTrustPair(records: readonly PrimaryRuntimeTrustRecord[]): Promise<void> {
    if (!this.input.trustState.acceptMany) {
      throw new Error('Primary Runtime trust store cannot atomically accept metadata pairs.')
    }
    await this.input.trustState.acceptMany(records)
  }
}

function assertMetadataCurrent(
  label: 'config' | 'manifest',
  value: { issuedAt: string; expiresAt: string },
  now: Date
): void {
  const issuedAt = Date.parse(value.issuedAt)
  const expiresAt = Date.parse(value.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error(`Primary Runtime ${label} has an invalid validity window.`)
  }
  if (issuedAt > now.getTime()) throw new Error(`Primary Runtime ${label} is not valid yet.`)
  if (expiresAt <= now.getTime()) throw new Error(`Primary Runtime ${label} has expired.`)
}
