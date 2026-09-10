import { AppServerClient } from './client/app-server-client'
import type { CodexTransport } from './client/transport'
import { StdioTransport } from './client/transport-stdio'
import { WebSocketTransport } from './client/transport-websocket'
import type { CodexAppServerClientSettings, TransportContext } from './client-settings'
import { CodexProviderError } from './errors'
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info'
import type { CommandExecOutputDeltaNotification } from './protocol/app-server-protocol/v2/CommandExecOutputDeltaNotification'
import type { CommandExecParams } from './protocol/app-server-protocol/v2/CommandExecParams'
import type { CommandExecResponse } from './protocol/app-server-protocol/v2/CommandExecResponse'
import type { CommandExecWriteParams } from './protocol/app-server-protocol/v2/CommandExecWriteParams'
import type { SandboxPolicy } from './protocol/app-server-protocol/v2/SandboxPolicy'
import type { CodexInitializeParams, CodexInitializeResult } from './protocol/types'
import { stripUndefined } from './utils/object'

export interface CodexCommandJsonRpcClientLike {
  connect(): Promise<void>
  disconnect(): Promise<void>
  notification(method: string, params?: unknown): Promise<void>
  onNotification(method: string, handler: (params: unknown) => void | Promise<void>): () => void
  onTransportTermination?(handler: (error: Error) => void): () => void
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
}

export interface CodexCommandClientSettings extends CodexAppServerClientSettings {
  createClient?: () => CodexCommandJsonRpcClientLike
  requestTimeoutMs?: number
  terminateRequestTimeoutMs?: number
}

export interface CodexCommandExecOptions {
  command: string[]
  cwd?: string
  env?: Record<string, string | null | undefined>
  timeoutMs?: number
  requestTimeoutMs?: number
  outputBytesCap?: number
  disableOutputCap?: boolean
  disableTimeout?: boolean
  sandboxPolicy?: SandboxPolicy
  signal?: AbortSignal
  stdin?: string | Uint8Array | ArrayBuffer
  closeStdin?: boolean
  onStdout?: (delta: string) => void
  onStderr?: (delta: string) => void
}

export interface CodexCommandExecResult extends CommandExecResponse {
  processId: string
  stdoutCapReached: boolean
  stderrCapReached: boolean
}

export interface CodexCommandWriteOptions {
  closeStdin?: boolean
}

let nextProcessId = 1

export class CodexCommandClient {
  private readonly createClient: () => CodexCommandJsonRpcClientLike
  private client: CodexCommandJsonRpcClientLike | undefined
  private readonly activeProcessIds = new Set<string>()
  private readonly transportTerminationListeners = new Set<(error: Error) => void>()
  private removeTransportTerminationHandler: (() => void) | undefined
  private connectPromise: Promise<void> | undefined
  private connected = false
  private shuttingDown = false
  private initializedServerInfo: CodexInitializeResult['serverInfo'] | undefined

  constructor(settings: CodexCommandClientSettings = {}) {
    this.createClient = settings.createClient ?? (() => createDefaultClient(settings))
    this.settings = settings
  }

  private readonly settings: CodexCommandClientSettings

  get serverInfo(): CodexInitializeResult['serverInfo'] | undefined {
    return this.initializedServerInfo
  }

  onTransportTermination(handler: (error: Error) => void): () => void {
    this.transportTerminationListeners.add(handler)
    return () => this.transportTerminationListeners.delete(handler)
  }

  async connect(): Promise<void> {
    if (this.shuttingDown) {
      throw new CodexProviderError('Command client is shut down.')
    }

    if (this.connected) {
      return
    }

    if (!this.connectPromise) {
      this.connectPromise = this.initializeConnection()
    }

    await this.connectPromise
  }

  async exec(options: CodexCommandExecOptions): Promise<CodexCommandExecResult> {
    if (options.command.length === 0) {
      throw new CodexProviderError('Command argv vector cannot be empty.')
    }

    await this.connect()

    const processId = createProcessId()
    const stdout: string[] = []
    const stderr: string[] = []
    let stdoutCapReached = false
    let stderrCapReached = false
    let abortReject: ((reason: Error) => void) | undefined
    let aborted = false

    const client = this.requireClient()
    const removeOutputHandler = client.onNotification('command/exec/outputDelta', (params) => {
      const delta = asCommandOutputDelta(params)
      if (!delta || delta.processId !== processId) {
        return
      }

      const text = Buffer.from(delta.deltaBase64, 'base64').toString('utf8')
      if (delta.stream === 'stdout') {
        stdout.push(text)
        stdoutCapReached ||= delta.capReached
        options.onStdout?.(text)
        return
      }

      stderr.push(text)
      stderrCapReached ||= delta.capReached
      options.onStderr?.(text)
    })

    const removeAbortHandler = options.signal
      ? addAbortHandler(options.signal, () => {
          aborted = true
          const error = abortError()
          void this.terminate(processId).catch(() => undefined)
          abortReject?.(error)
        })
      : undefined

    this.activeProcessIds.add(processId)
    try {
      if (options.signal?.aborted) {
        throw abortError()
      }

      const execPromise = client.request<CommandExecResponse>(
        'command/exec',
        commandExecParams(processId, options),
        requestTimeoutMs(this.settings, options)
      )
      execPromise.catch(() => undefined)

      if (options.stdin !== undefined || options.closeStdin === true) {
        await this.write(processId, options.stdin, { closeStdin: options.closeStdin ?? true })
      }

      const response = await Promise.race([
        execPromise,
        new Promise<never>((_resolve, reject) => {
          abortReject = reject
        })
      ])

      return {
        processId,
        exitCode: response.exitCode,
        stdout: stdout.join('') + response.stdout,
        stderr: stderr.join('') + response.stderr,
        stdoutCapReached,
        stderrCapReached
      }
    } catch (error) {
      if (aborted) {
        throw abortError()
      }
      throw error
    } finally {
      this.activeProcessIds.delete(processId)
      removeAbortHandler?.()
      removeOutputHandler()
    }
  }

  async write(
    processId: string,
    stdin?: string | Uint8Array | ArrayBuffer,
    options: CodexCommandWriteOptions = {}
  ): Promise<void> {
    const params: CommandExecWriteParams = stripUndefined({
      processId,
      deltaBase64:
        stdin === undefined ? undefined : Buffer.from(stdinBytes(stdin)).toString('base64'),
      closeStdin: options.closeStdin
    })
    await this.requireClient().request('command/exec/write', params, this.settings.requestTimeoutMs)
  }

  async terminate(processId: string): Promise<void> {
    await this.requireClient().request(
      'command/exec/terminate',
      { processId },
      this.settings.terminateRequestTimeoutMs ?? this.settings.requestTimeoutMs ?? 5_000
    )
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const processIds = [...this.activeProcessIds]
    await Promise.all(
      processIds.map((processId) => this.terminate(processId).catch(() => undefined))
    )
    await this.disconnectCurrentClient()
    this.resetConnectionState()
  }

  private async initializeConnection(): Promise<void> {
    const client = this.createClient()
    this.client = client
    this.removeTransportTerminationHandler = client.onTransportTermination?.((error) => {
      void this.handleTransportTermination(client, error)
    })

    try {
      await client.connect()
      const result = await client.request<CodexInitializeResult>(
        'initialize',
        initializeParams(this.settings),
        this.settings.requestTimeoutMs
      )
      this.initializedServerInfo = result.serverInfo
      await client.notification('initialized')
      this.connected = true
    } catch (error) {
      await this.disconnectCurrentClient(client)
      this.resetConnectionState()
      throw error
    }
  }

  private requireClient(): CodexCommandJsonRpcClientLike {
    if (!this.client) {
      throw new CodexProviderError('Command client is not connected.')
    }
    return this.client
  }

  private async handleTransportTermination(
    client: CodexCommandJsonRpcClientLike,
    error: Error
  ): Promise<void> {
    if (this.client !== client) {
      return
    }

    this.resetConnectionState()
    for (const listener of this.transportTerminationListeners) {
      try {
        listener(error)
      } catch {
        // A consumer observing a dead transport must not prevent this
        // client from releasing it and allowing a later reconnect.
      }
    }
    await this.disconnectCurrentClient(client)
  }

  private async disconnectCurrentClient(client = this.client): Promise<void> {
    this.removeTransportTerminationHandler?.()
    this.removeTransportTerminationHandler = undefined

    if (!client) {
      return
    }

    if (this.client === client) {
      this.client = undefined
    }

    await client.disconnect().catch(() => undefined)
  }

  private resetConnectionState(): void {
    this.connected = false
    this.connectPromise = undefined
    this.initializedServerInfo = undefined
  }
}

export function createCodexCommandClient(
  settings: CodexCommandClientSettings = {}
): CodexCommandClient {
  return new CodexCommandClient(settings)
}

function createDefaultClient(settings: CodexCommandClientSettings): CodexCommandJsonRpcClientLike {
  let transport: CodexTransport
  if (settings.transportFactory) {
    transport = settings.transportFactory({} satisfies TransportContext)
  } else if (settings.transport?.type === 'websocket') {
    transport = new WebSocketTransport(settings.transport.websocket)
  } else {
    transport = new StdioTransport(settings.transport?.stdio)
  }

  return new AppServerClient(
    transport,
    stripUndefined({ requestTimeoutMs: settings.requestTimeoutMs })
  )
}

function initializeParams(settings: CodexCommandClientSettings): CodexInitializeParams {
  return stripUndefined({
    clientInfo: settings.clientInfo ?? {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION
    },
    capabilities: {
      experimentalApi: settings.experimentalApi ?? true,
      requestAttestation: false
    }
  })
}

function commandExecParams(processId: string, options: CodexCommandExecOptions): CommandExecParams {
  return stripUndefined({
    command: options.command,
    processId,
    streamStdin: options.stdin !== undefined || options.closeStdin === true,
    streamStdoutStderr: true,
    timeoutMs: options.timeoutMs,
    outputBytesCap: options.outputBytesCap,
    disableOutputCap: options.disableOutputCap,
    disableTimeout: options.disableTimeout,
    cwd: options.cwd,
    env: options.env,
    sandboxPolicy: options.sandboxPolicy
  })
}

function requestTimeoutMs(
  settings: CodexCommandClientSettings,
  options: CodexCommandExecOptions
): number | undefined {
  if (options.requestTimeoutMs !== undefined) {
    return options.requestTimeoutMs
  }
  if (settings.requestTimeoutMs !== undefined) {
    return settings.requestTimeoutMs
  }
  if (options.timeoutMs !== undefined) {
    return options.timeoutMs + 1_000
  }
  return undefined
}

function asCommandOutputDelta(params: unknown): CommandExecOutputDeltaNotification | undefined {
  if (!params || typeof params !== 'object') {
    return undefined
  }

  const candidate = params as Partial<CommandExecOutputDeltaNotification>
  if (
    typeof candidate.processId !== 'string' ||
    (candidate.stream !== 'stdout' && candidate.stream !== 'stderr') ||
    typeof candidate.deltaBase64 !== 'string' ||
    typeof candidate.capReached !== 'boolean'
  ) {
    return undefined
  }

  return candidate as CommandExecOutputDeltaNotification
}

function createProcessId(): string {
  const id = nextProcessId
  nextProcessId += 1
  return `codex-command-${Date.now().toString(36)}-${id.toString(36)}`
}

function stdinBytes(stdin: string | Uint8Array | ArrayBuffer): string | Uint8Array {
  return stdin instanceof ArrayBuffer ? new Uint8Array(stdin) : stdin
}

function addAbortHandler(signal: AbortSignal, onAbort: () => void): () => void {
  signal.addEventListener('abort', onAbort, { once: true })
  return () => {
    signal.removeEventListener('abort', onAbort)
  }
}

function abortError(): Error {
  const error = new CodexProviderError('Command execution aborted.')
  error.name = 'AbortError'
  return error
}
