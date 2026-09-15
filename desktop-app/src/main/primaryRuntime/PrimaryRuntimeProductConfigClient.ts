import { normalizeAllowedOrigins, PrimaryRuntimeHttpClient } from './PrimaryRuntimeHttpClient'
import {
  parseAndVerifyPrimaryRuntimeProductConfig,
  productConfigTrustRecord,
  type PrimaryRuntimeProductConfigPublicKey,
  type PrimaryRuntimeVerifiedProductConfig
} from './PrimaryRuntimeProductConfig'
import type { PrimaryRuntimeTrustStateStore } from './PrimaryRuntimeTrustStateStore'

export type PrimaryRuntimeProductConfigClientInput = {
  configUrl: string
  channel: string
  configPublicKeys: Readonly<Record<string, PrimaryRuntimeProductConfigPublicKey>>
  allowedConfigOrigins: readonly string[]
  allowedManifestOrigins: readonly string[]
  httpClient: PrimaryRuntimeHttpClient
  trustState: PrimaryRuntimeTrustStateStore
  now?: () => Date
}

/** Retrieves and commits product configuration before it can influence release selection. */
export class PrimaryRuntimeProductConfigClient {
  private readonly now: () => Date
  private readonly configUrl: URL

  constructor(private readonly input: PrimaryRuntimeProductConfigClientInput) {
    if (Object.keys(input.configPublicKeys).length === 0) {
      throw new Error('Primary Runtime config keyring is empty.')
    }
    this.configUrl = new URL(input.configUrl)
    const allowedConfigOrigins = normalizeAllowedOrigins(input.allowedConfigOrigins)
    if (!allowedConfigOrigins.includes(this.configUrl.origin)) {
      throw new Error('Primary Runtime config URL is outside the config-origin allowlist.')
    }
    this.now = input.now ?? (() => new Date())
  }

  async getConfig(signal?: AbortSignal): Promise<PrimaryRuntimeVerifiedProductConfig> {
    const url = this.input.httpClient.validateUrl(this.configUrl)
    const config = await this.input.httpClient.getJson(url, { signal })
    const now = this.now()
    const verified = parseAndVerifyPrimaryRuntimeProductConfig({
      config,
      publicKeys: this.input.configPublicKeys,
      allowedConfigOrigins: this.input.allowedConfigOrigins,
      allowedManifestOrigins: this.input.allowedManifestOrigins,
      channel: this.input.channel,
      now
    })
    await this.input.trustState.accept(
      productConfigTrustRecord({ config: verified, origin: url.origin, acceptedAt: now })
    )
    return verified
  }
}
