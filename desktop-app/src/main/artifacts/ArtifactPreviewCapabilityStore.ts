import { randomUUID } from 'node:crypto'

import type { ArtifactPreviewFileIdentity } from '../../shared/artifactPreviewApi'

type Capability = {
  absolutePath: string
  identity: ArtifactPreviewFileIdentity
  expiresAt: number
}

/** Separate picker capability for previewing an attachment without consuming its send token. */
export class ArtifactPreviewCapabilityStore {
  private readonly capabilities = new Map<string, Capability>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 30 * 60 * 1000
  ) {}

  issue(absolutePath: string, identity: ArtifactPreviewFileIdentity): string {
    this.deleteExpired()
    const token = randomUUID().replaceAll('-', '')
    this.capabilities.set(token, { absolutePath, identity, expiresAt: this.now() + this.ttlMs })
    return token
  }

  redeem(token: string): { absolutePath: string; identity: ArtifactPreviewFileIdentity } {
    this.deleteExpired()
    const capability = this.capabilities.get(token)
    if (!capability) throw new Error('Artifact preview is not authorized by the file picker.')
    this.capabilities.delete(token)
    return { absolutePath: capability.absolutePath, identity: capability.identity }
  }

  private deleteExpired(): void {
    const now = this.now()
    for (const [token, capability] of this.capabilities) {
      if (capability.expiresAt <= now) this.capabilities.delete(token)
    }
  }
}
