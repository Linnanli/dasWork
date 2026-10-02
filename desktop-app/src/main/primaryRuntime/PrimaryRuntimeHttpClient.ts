const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

export type PrimaryRuntimeHttpClientInput = {
  allowedOrigins: readonly string[]
  fetchImpl?: typeof fetch
  production?: boolean
}

/**
 * Main-owned transport for config, manifests and archives. It deliberately
 * forbids redirects and validates an exact HTTPS origin before every request;
 * renderer and app-server code never receive this object or its policy.
 */
export class PrimaryRuntimeHttpClient {
  private readonly allowedOrigins: readonly string[]
  private readonly fetchImpl: typeof fetch

  constructor(input: PrimaryRuntimeHttpClientInput) {
    this.allowedOrigins = normalizeAllowedOrigins(input.allowedOrigins)
    this.fetchImpl = input.fetchImpl ?? fetch
  }

  async getJson(
    url: string | URL,
    options: { maxBytes?: number; signal?: AbortSignal } = {}
  ): Promise<unknown> {
    const response = await this.request(url, { signal: options.signal })
    const maximum = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    const advertisedLength = response.headers.get('content-length')
    if (
      advertisedLength !== null &&
      (!/^\d+$/u.test(advertisedLength) || Number(advertisedLength) > maximum)
    ) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Primary Runtime metadata exceeds the permitted size.')
    }
    const text = await readBoundedResponseText(response, maximum)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Primary Runtime metadata is not valid JSON.')
    }
  }

  async request(
    url: string | URL,
    options: { method?: 'GET' | 'HEAD'; signal?: AbortSignal } = {}
  ): Promise<Response> {
    const target = this.validateUrl(url)
    const response = await this.fetchImpl(target, {
      method: options.method ?? 'GET',
      redirect: 'error',
      ...(options.signal ? { signal: options.signal } : {})
    })
    if (!response.ok) {
      throw new Error(`Primary Runtime request failed: HTTP ${response.status}`)
    }
    return response
  }

  validateUrl(value: string | URL): URL {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      !this.allowedOrigins.includes(url.origin)
    ) {
      throw new Error('Primary Runtime URL is outside the trusted HTTPS origin allowlist.')
    }
    return url
  }
}

export function normalizeAllowedOrigins(origins: readonly string[]): readonly string[] {
  if (origins.length === 0)
    throw new Error('Primary Runtime trusted origin allowlist must not be empty.')
  return Object.freeze([
    ...new Set(
      origins.map((origin) => {
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
      })
    )
  ])
}

async function readBoundedResponseText(response: Response, maximum: number): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error('Primary Runtime metadata size limit is invalid.')
  }
  if (!response.body) {
    return ''
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximum) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Primary Runtime metadata exceeds the permitted size.')
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    reader.releaseLock()
  }
}
