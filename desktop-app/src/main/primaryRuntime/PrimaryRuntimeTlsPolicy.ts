import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'

export type PrimaryRuntimeTlsPolicyInput = {
  /** Packaged builds must never trust a development CA. */
  production: boolean
  /** Absolute path to a public CA certificate used by a local development feed. */
  localTestCaPath?: string
  /** Every origin this client may contact while the local CA is active. */
  allowedOrigins: readonly string[]
  readCertificate?: (path: string) => Promise<string>
}

/**
 * Keeps a development CA inside Electron Main and limits it to loopback HTTPS
 * origins. It deliberately creates a dedicated request transport instead of
 * changing process-wide TLS settings, so Renderer and app-server traffic keep
 * using the platform trust store.
 */
export class PrimaryRuntimeTlsPolicy {
  readonly fetchImpl: typeof fetch

  private constructor(input: { ca: string; allowedOrigins: ReadonlySet<string> }) {
    this.fetchImpl = createLocalTestFetch(input)
  }

  static async create(
    input: PrimaryRuntimeTlsPolicyInput
  ): Promise<PrimaryRuntimeTlsPolicy | undefined> {
    const certificatePath = input.localTestCaPath?.trim()
    if (!certificatePath) return undefined
    if (input.production) {
      throw new Error('Production Primary Runtime downloads cannot use a local test CA.')
    }
    if (!isAbsolute(certificatePath)) {
      throw new Error('Primary Runtime local test CA path must be absolute.')
    }

    const allowedOrigins = new Set(input.allowedOrigins.map(normalizeLoopbackOrigin))
    if (allowedOrigins.size === 0) {
      throw new Error('Primary Runtime local test CA requires at least one loopback origin.')
    }

    const readCertificate =
      input.readCertificate ?? (async (path: string): Promise<string> => readFile(path, 'utf8'))
    const certificate = await readCertificate(certificatePath)
    if (!certificate.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('Primary Runtime local test CA is not a PEM certificate.')
    }
    return new PrimaryRuntimeTlsPolicy({ ca: certificate, allowedOrigins })
  }
}

function createLocalTestFetch(input: {
  ca: string
  allowedOrigins: ReadonlySet<string>
}): typeof fetch {
  return (async (resource: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(resource)
    if (!input.allowedOrigins.has(url.origin)) {
      throw new Error(
        'Primary Runtime local test CA may only contact its configured loopback feed.'
      )
    }
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error('Primary Runtime local test transport only supports GET and HEAD requests.')
    }
    if (init?.body !== undefined && init.body !== null) {
      throw new Error('Primary Runtime local test transport does not accept request bodies.')
    }
    if (init?.signal?.aborted) {
      throw new DOMException('Request aborted.', 'AbortError')
    }

    return new Promise<Response>((resolve, reject) => {
      const headers = new Headers(init?.headers)
      const request = httpsRequest(
        url,
        {
          method,
          headers: Object.fromEntries(headers.entries()),
          ca: input.ca,
          rejectUnauthorized: true,
          ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {})
        },
        (response) => {
          const responseHeaders = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) {
              for (const entry of value) responseHeaders.append(name, entry)
            } else if (value !== undefined) {
              responseHeaders.set(name, String(value))
            }
          }
          resolve(
            new Response(
              method === 'HEAD'
                ? null
                : (Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>),
              {
                status: response.statusCode ?? 500,
                statusText: response.statusMessage ?? '',
                headers: responseHeaders
              }
            )
          )
        }
      )
      const abort = (): void => {
        request.destroy(new DOMException('Request aborted.', 'AbortError'))
      }
      request.once('error', reject)
      if (init?.signal) {
        if (init.signal.aborted) {
          abort()
          return
        }
        init.signal.addEventListener('abort', abort, { once: true })
      }
      request.end()
    })
  }) as typeof fetch
}

function requestUrl(value: RequestInfo | URL): URL {
  const url =
    value instanceof URL
      ? new URL(value)
      : typeof value === 'string'
        ? new URL(value)
        : new URL(value.url)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !isLoopbackHost(url.hostname)
  ) {
    throw new Error('Primary Runtime local test CA may only trust exact loopback HTTPS origins.')
  }
  return url
}

function normalizeLoopbackOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !isLoopbackHost(url.hostname)
  ) {
    throw new Error('Primary Runtime local test CA may only trust exact loopback HTTPS origins.')
  }
  return url.origin
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1'
}
