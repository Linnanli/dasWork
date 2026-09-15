import type { PrimaryRuntimeReleaseDescriptor } from './primaryRuntimeTypes'
import { PrimaryRuntimeProductConfigClient } from './PrimaryRuntimeProductConfigClient'
import {
  SignedPrimaryRuntimeReleaseProvider,
  type PrimaryRuntimeDownloadProgress,
  type PrimaryRuntimeDownloadedArchive,
  type PrimaryRuntimeReleaseProvider
} from './PrimaryRuntimeReleaseProvider'

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
      createManifestProvider(
        config: Awaited<ReturnType<PrimaryRuntimeProductConfigClient['getConfig']>>
      ): SignedPrimaryRuntimeReleaseProvider
    }
  ) {}

  async getRelease(): Promise<PrimaryRuntimeReleaseDescriptor> {
    const config = await this.input.configClient.getConfig()
    this.lastPollIntervalMs = config.pollIntervalMs
    const provider = this.input.createManifestProvider(config)
    const descriptor = await provider.getRelease()
    this.activeProvider = provider
    return descriptor
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
}
