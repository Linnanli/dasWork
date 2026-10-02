import type { PrimaryRuntimeDiagnostic, PrimaryRuntimeManifest } from './primaryRuntimeTypes'

export type PrimaryRuntimeLoaderFeatureGate = {
  isEnabled(input: { hostId: 'local' | 'remote' }): Promise<boolean>
  invalidate?(): void
}

export type PrimaryRuntimeCapabilityPolicyInput = {
  /** Product-owned static feature; disabled must not query app-server. */
  productFeatureEnabled: boolean
  /** Main-owned app-server feature lookup. Omit only for isolated unit fixtures. */
  loaderFeatureGate?: PrimaryRuntimeLoaderFeatureGate
}

export type PrimaryRuntimeCapabilityState = {
  revision: string
  runtimeStatus: PrimaryRuntimeDiagnostic['status']
  bundleVersion?: string
  runtimeFormatVersion?: PrimaryRuntimeManifest['bundleFormatVersion']
  runtimePluginsSynchronized: boolean
  loaderPublished: boolean
  workspaceInstructionsEnabled: boolean
  presentationsEligible: boolean
}

/**
 * Main-owned observation cache for Runtime-derived capabilities. It does not
 * gate thread creation or participate in Runtime/plugin publication.
 */
export class PrimaryRuntimeCapabilityPolicy {
  private revision = 0
  private committed: PrimaryRuntimeCapabilityState
  private readonly productFeatureEnabled: boolean
  private loaderFeatureGate: PrimaryRuntimeLoaderFeatureGate | undefined

  constructor(input: boolean | PrimaryRuntimeCapabilityPolicyInput) {
    this.productFeatureEnabled = typeof input === 'boolean' ? input : input.productFeatureEnabled
    this.loaderFeatureGate = typeof input === 'boolean' ? undefined : input.loaderFeatureGate
    this.committed = this.makeState(
      { status: this.productFeatureEnabled ? 'missing' : 'unsupported', issues: [] },
      false
    )
  }

  async snapshot(
    input: { hostId?: 'local' | 'remote' } = {}
  ): Promise<PrimaryRuntimeCapabilityState> {
    const loaderFeatureEnabled = await this.loaderFeatureEnabled(input.hostId ?? 'local')
    return withLoaderEligibility(this.committed, loaderFeatureEnabled)
  }

  update(input: {
    diagnostic: PrimaryRuntimeDiagnostic
    runtimePluginsSynchronized: boolean
  }): PrimaryRuntimeCapabilityState {
    this.revision += 1
    this.committed = this.makeState(input.diagnostic, input.runtimePluginsSynchronized)
    return { ...this.committed }
  }

  /** Called when the product config or host connection changes. */
  invalidateLoaderFeatureCache(): void {
    this.loaderFeatureGate?.invalidate?.()
    this.revision += 1
    this.committed = {
      ...this.committed,
      revision: `primary-runtime-capabilities-${this.revision}`
    }
  }

  /** Completes Main wiring once the shared app-server connection is available. */
  setLoaderFeatureGate(featureGate: PrimaryRuntimeLoaderFeatureGate | undefined): void {
    if (this.loaderFeatureGate === featureGate) return
    this.loaderFeatureGate = featureGate
    this.invalidateLoaderFeatureCache()
  }

  private makeState(
    diagnostic: PrimaryRuntimeDiagnostic,
    runtimePluginsSynchronized: boolean
  ): PrimaryRuntimeCapabilityState {
    // `snapshot()` is authoritative whenever an app-server feature gate is
    // installed. Keeping this optimistic value only preserves the synchronous
    // update API used by Runtime/plugin state changes.
    const loaderFeatureEnabled = this.productFeatureEnabled && !this.loaderFeatureGate
    const runtimeReady = diagnostic.status === 'ready'
    const runtimeFormatVersion = diagnostic.manifest?.bundleFormatVersion
    const loaderPublished = canPublishLoader(
      {
        runtimeStatus: diagnostic.status,
        ...(runtimeFormatVersion ? { runtimeFormatVersion } : {}),
        runtimePluginsSynchronized
      },
      loaderFeatureEnabled
    )
    return {
      revision: `primary-runtime-capabilities-${this.revision}`,
      runtimeStatus: diagnostic.status,
      ...(diagnostic.manifest ? { bundleVersion: diagnostic.manifest.bundleVersion } : {}),
      ...(runtimeFormatVersion ? { runtimeFormatVersion } : {}),
      runtimePluginsSynchronized,
      loaderPublished,
      workspaceInstructionsEnabled: loaderPublished && runtimeReady,
      presentationsEligible: runtimeReady && runtimePluginsSynchronized
    }
  }

  private async loaderFeatureEnabled(hostId: 'local' | 'remote'): Promise<boolean> {
    if (hostId !== 'local' || !this.productFeatureEnabled) return false
    return this.loaderFeatureGate ? this.loaderFeatureGate.isEnabled({ hostId }) : true
  }
}

function withLoaderEligibility(
  state: PrimaryRuntimeCapabilityState,
  loaderFeatureEnabled: boolean
): PrimaryRuntimeCapabilityState {
  const loaderPublished = canPublishLoader(state, loaderFeatureEnabled)
  return {
    ...state,
    loaderPublished,
    workspaceInstructionsEnabled: loaderPublished && state.runtimeStatus === 'ready'
  }
}

function canPublishLoader(
  state: Pick<
    PrimaryRuntimeCapabilityState,
    'runtimeStatus' | 'runtimeFormatVersion' | 'runtimePluginsSynchronized'
  >,
  loaderFeatureEnabled: boolean
): boolean {
  if (!loaderFeatureEnabled) return false
  if (state.runtimeFormatVersion !== 3) return true
  return state.runtimeStatus === 'ready' && state.runtimePluginsSynchronized
}
