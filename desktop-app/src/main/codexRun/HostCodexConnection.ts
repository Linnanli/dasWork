import {
  AppServerClient,
  CodexAppServerConnection,
  StdioTransport,
  type CodexAppServerConnectionDiagnostics,
  type InitializeCapabilities,
  type TransportContext
} from '@dascowork/codex-app-server-client'

import type { CodexAppServerLaunchOptions } from '../codexAppServerLaunch'
import { createCodexClientInfo } from '../codexClientInfo'
import { verifyCodexAppServerVersion } from './codexAppServerVersionPolicy'

const CANONICAL_CAPABILITIES = {
  experimentalApi: true,
  requestAttestation: false
} satisfies InitializeCapabilities

/**
 * Host-scoped owner of physical connection setup. Logical clients can only be
 * issued after a single fixed initialize handshake and version proof.
 */
export class HostCodexConnection {
  private connection: CodexAppServerConnection | undefined
  private ready: Promise<void> | undefined
  private initializedGeneration: number | undefined
  private hostHandlerConnection: CodexAppServerConnection | undefined
  private unregisterHostHandlers: (() => void) | undefined
  private closed = false

  constructor(
    private readonly launch: CodexAppServerLaunchOptions,
    sharedConnection?: CodexAppServerConnection,
    private readonly verifyVersion: typeof verifyCodexAppServerVersion = verifyCodexAppServerVersion
  ) {
    this.connection = sharedConnection
    if (sharedConnection) this.ensureHostHandlers(sharedConnection)
  }

  async acquire(context?: string | TransportContext): Promise<AppServerClient> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.ensureReady()
      if (!this.connection) throw new Error('Codex host connection is not available')
      const expectedGeneration = this.initializedGeneration
      const client = new AppServerClient(
        this.connection.createTransport(normalizeTransportContext(context)),
        appServerPacketLogger()
      )
      try {
        await client.connect()
        if (expectedGeneration === this.connection.getDiagnostics().generation) return client
      } catch (error) {
        await client.disconnect()
        throw error
      }
      await client.disconnect()
      this.ready = undefined
    }
    throw new Error('Codex host connection could not stabilize after transport recovery')
  }

  async acquireLease(context?: string | TransportContext): Promise<{
    client: AppServerClient
    release(): Promise<void>
  }> {
    const client = await this.acquire(context)
    return {
      client,
      release: () => client.disconnect()
    }
  }

  diagnostics(): CodexAppServerConnectionDiagnostics | undefined {
    return this.connection?.getDiagnostics()
  }

  /**
   * Reads the server's persisted terminal state after a transport interruption.
   * This stays on the host-owned connection so recovery cannot accidentally
   * create an uninitialised second app-server session.
   */
  async readTurnOutcome(
    threadId: string,
    turnId: string
  ): Promise<'completed' | 'interrupted' | 'failed' | undefined> {
    const client = await this.acquire(threadId)
    try {
      const response = await client.request<{
        thread?: { turns?: Array<{ id?: string; status?: unknown }> }
      }>('thread/read', { threadId, includeTurns: true })
      const status = response.thread?.turns?.find((turn) => turn.id === turnId)?.status
      return status === 'completed' || status === 'interrupted' || status === 'failed'
        ? status
        : undefined
    } finally {
      await client.disconnect()
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    this.unregisterHostHandlers?.()
    this.unregisterHostHandlers = undefined
    this.hostHandlerConnection = undefined
    await this.connection?.shutdown()
  }

  private async ensureReady(): Promise<void> {
    if (this.closed) throw new Error('Codex host connection is shutting down')
    const generation = this.connection?.getDiagnostics().generation
    if (!this.ready || this.initializedGeneration !== generation) {
      this.ready = this.initialize().catch((error) => {
        this.ready = undefined
        throw error
      })
    }
    return this.ready
  }

  private async initialize(): Promise<void> {
    await this.verifyVersion(this.launch)
    const connection =
      this.connection ??
      new CodexAppServerConnection({
        transportFactory: () =>
          new StdioTransport({
            command: this.launch.command,
            args: this.launch.args,
            cwd: this.launch.cwd,
            env: sanitizedCodexHostEnv(this.launch.env)
          }),
        idleTimeoutMs: 300_000
      })
    this.ensureHostHandlers(connection)
    const client = new AppServerClient(connection.createTransport(), appServerPacketLogger())
    try {
      await client.connect()
      await client.request('initialize', {
        clientInfo: createCodexClientInfo('dascowork_desktop', 'dasCowork Desktop'),
        capabilities: CANONICAL_CAPABILITIES
      })
      await client.notification('initialized')
      this.connection = connection
      this.initializedGeneration = connection.getDiagnostics().generation
    } catch (error) {
      await connection.shutdown()
      throw error
    } finally {
      await client.disconnect()
    }
  }

  private ensureHostHandlers(connection: CodexAppServerConnection): void {
    if (this.hostHandlerConnection === connection) return
    this.unregisterHostHandlers?.()
    this.unregisterHostHandlers = connection.registerHostRequestHandler(
      'currentTime/read',
      (params) => {
        if (!isCurrentTimeReadParams(params)) {
          throw new Error('currentTime/read requires a threadId.')
        }
        return { currentTimeAt: Math.floor(Date.now() / 1_000) }
      }
    )
    this.hostHandlerConnection = connection
  }
}

function normalizeTransportContext(
  context: string | TransportContext | undefined
): TransportContext {
  return typeof context === 'string' ? { threadId: context } : (context ?? {})
}

function isCurrentTimeReadParams(value: unknown): value is { threadId: string } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { threadId?: unknown }).threadId === 'string'
  )
}

function appServerPacketLogger(): { onPacket?: (packet: unknown) => void } {
  if (process.env.CODEX_ASP_DEBUG_PACKETS !== '1') return {}
  return {
    onPacket: (packet) =>
      console.debug('[codex packet]', JSON.stringify(redactAppServerDebugPacket(packet)))
  }
}

/**
 * Packet logging is diagnostic-only. It must remain useful for protocol event
 * assertions without ever copying provider credentials into desktop logs.
 */
export function redactAppServerDebugPacket(packet: unknown): unknown {
  if (Array.isArray(packet)) return packet.map(redactAppServerDebugPacket)
  if (typeof packet === 'string') return redactAppServerDebugText(packet)
  if (!packet || typeof packet !== 'object') return packet

  if (isDebugPacket(packet)) {
    return {
      ...packet,
      message: redactAppServerProtocolMessage(packet.message)
    }
  }
  if (isAppServerProtocolMessage(packet)) return redactAppServerProtocolMessage(packet)

  return redactAppServerDebugPayload(packet)
}

function redactAppServerProtocolMessage(message: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message).map(([key, value]) => {
      if (key === 'method' || key === 'id' || key === 'jsonrpc') return [key, value]
      return [key, redactAppServerDebugPayload(value)]
    })
  )
}

function redactAppServerDebugPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAppServerDebugPayload)
  if (typeof value === 'string') return redactAppServerDebugText(value)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveDebugPayloadKey(key) ? '[redacted]' : redactAppServerDebugPayload(entry)
    ])
  )
}

function isDebugPacket(
  value: object
): value is { direction: unknown; message: Record<string, unknown> } {
  const packet = value as Record<string, unknown>
  return typeof packet.direction === 'string' && isAppServerProtocolMessage(packet.message)
}

function isAppServerProtocolMessage(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).method === 'string'
  )
}

function isSensitiveDebugPayloadKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/gu, '').toLowerCase()
  return (
    normalized === 'headers' ||
    normalized.includes('authorization') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('cookie') ||
    normalized.includes('providerheaders') ||
    (normalized.includes('api') && normalized.includes('key')) ||
    normalized === 'input' ||
    normalized === 'inputs' ||
    normalized === 'prompt' ||
    normalized === 'prompts' ||
    normalized === 'developerinstructions' ||
    normalized === 'instructions' ||
    normalized === 'arguments' ||
    normalized === 'args' ||
    normalized === 'content' ||
    normalized === 'contentitems' ||
    normalized === 'text' ||
    normalized === 'delta' ||
    normalized === 'message' ||
    normalized === 'command' ||
    normalized === 'commandline' ||
    normalized === 'patch' ||
    normalized === 'diff'
  )
}

function redactAppServerDebugText(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactAppServerDebugPacket(JSON.parse(trimmed)))
    } catch {
      // Fall through to text redaction for a malformed structured payload.
    }
  }

  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(
      /(["']?(?:api[_-]?key|authorization|proxy[_-]?authorization|[a-z0-9_-]*token|[a-z0-9_-]*secret|credential|password|cookie|provider[_-]?headers?)["']?\s*[:=]\s*["']?)[^"',&\s;}]+/giu,
      '$1[redacted]'
    )
}

function sanitizedCodexHostEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const sanitized = Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[0] !== 'CODEX_CI' &&
        entry[0] !== 'CODEX_THREAD_ID' &&
        entry[0] !== 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
    )
  )
  const appendLocalhost = (value: string | undefined): string => {
    const hosts = new Set(
      (value ?? '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    )
    for (const host of ['localhost', '127.0.0.1', '::1']) hosts.add(host)
    return [...hosts].join(',')
  }
  return {
    ...sanitized,
    NO_PROXY: appendLocalhost(sanitized.NO_PROXY ?? sanitized.no_proxy),
    no_proxy: appendLocalhost(sanitized.no_proxy ?? sanitized.NO_PROXY)
  }
}
