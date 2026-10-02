export const WORKSPACE_DEPENDENCIES_EXPERIMENTAL_FEATURE = 'workspace_dependencies'

export type WorkspaceDependenciesExperimentalFeature = {
  name: string
  enabled: boolean
}

export type WorkspaceDependenciesFeatureGateInput = {
  productFeatureEnabled: boolean
  listExperimentalFeatures(): Promise<readonly WorkspaceDependenciesExperimentalFeature[]>
  /** The shared app-server generation; changes invalidate every cached answer. */
  connectionGeneration(): number | undefined
  timeoutMs?: number
}

/**
 * Main-owned eligibility cache for the workspace-dependencies dynamic tool.
 * A failed, timed-out, incomplete, or stale app-server query is deliberately
 * indistinguishable from a disabled feature to every caller.
 */
export class WorkspaceDependenciesFeatureGate {
  private productFeatureEnabled: boolean
  private readonly cache = new Map<string, Promise<boolean>>()
  private readonly timeoutMs: number

  constructor(private readonly input: WorkspaceDependenciesFeatureGateInput) {
    this.productFeatureEnabled = input.productFeatureEnabled
    this.timeoutMs = input.timeoutMs ?? 5_000
  }

  async isEnabled(input: { hostId: 'local' | 'remote' }): Promise<boolean> {
    if (input.hostId !== 'local' || !this.productFeatureEnabled) return false

    const generation = this.input.connectionGeneration()
    const key = cacheKey(input.hostId, generation)
    const existing = this.cache.get(key)
    if (existing) return existing

    const pending = this.readExperimentalFeature(generation)
    this.cache.set(key, pending)
    void pending.finally(() => {
      // A response from a superseded connection must never be retained for a
      // new generation. The next snapshot will issue a new, fail-closed read.
      if (this.cache.get(key) === pending && this.input.connectionGeneration() !== generation) {
        this.cache.delete(key)
      }
    })
    return pending
  }

  setProductFeatureEnabled(enabled: boolean): void {
    if (this.productFeatureEnabled === enabled) return
    this.productFeatureEnabled = enabled
    this.cache.clear()
  }

  invalidate(): void {
    this.cache.clear()
  }

  private async readExperimentalFeature(expectedGeneration: number | undefined): Promise<boolean> {
    try {
      const features = await withTimeout(
        this.input.listExperimentalFeatures(),
        this.timeoutMs,
        'experimental feature query timed out'
      )
      if (this.input.connectionGeneration() !== expectedGeneration) return false
      return features.some(
        (feature) =>
          feature.name === WORKSPACE_DEPENDENCIES_EXPERIMENTAL_FEATURE && feature.enabled === true
      )
    } catch {
      return false
    }
  }
}

function cacheKey(hostId: 'local' | 'remote', generation: number | undefined): string {
  return `${hostId}:${generation === undefined ? 'uninitialized' : generation}`
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Workspace dependencies feature timeout must be a positive integer.')
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
