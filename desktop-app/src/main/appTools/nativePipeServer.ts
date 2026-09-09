import { createServer, type Server, type Socket } from 'node:net'
import { chmod, mkdir, mkdtemp, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type {
  DesktopToolContext,
  DynamicAppToolRegistry,
  DynamicToolCall
} from './DynamicAppToolRegistry'
import {
  decodeNativePipeRequest,
  encodeNativePipeFrame,
  NativePipeFrameDecoder,
  NativePipeProtocolError,
  nativePipeError,
  nativePipeRequestIdKey,
  nativePipeSuccess,
  type NativePipeRequest,
  type NativePipeRequestId,
  NATIVE_PIPE_MAX_FRAME_BYTES
} from './nativePipeProtocol'

type NativePipeServerOptions = {
  registry: DynamicAppToolRegistry
  socketRoot?: string
  context?: DesktopToolContext
  maxFrameBytes?: number
  onUnavailable?: (error: Error) => void
}

type ActiveToolCall = {
  requestId: NativePipeRequestId | undefined
  requestKey: string
  callId?: string
  controller: AbortController
}

type NativePipeClientSession = {
  socket: Socket
  decoder: NativePipeFrameDecoder
  callsByRequestId: Map<string, ActiveToolCall>
  callsByCallId: Map<string, ActiveToolCall>
}

export type CodexAppToolsNativePipeServerStartResult = {
  pipePath: string
  socketRoot: string
}

export class CodexAppToolsNativePipeServer {
  private server: Server | undefined
  private pipePath: string | undefined
  private socketRoot: string | undefined
  private ownsSocketRoot = false
  private readonly sessions = new Set<NativePipeClientSession>()
  private readonly maxFrameBytes: number
  private readonly context: DesktopToolContext

  constructor(private readonly options: NativePipeServerOptions) {
    this.maxFrameBytes = options.maxFrameBytes ?? NATIVE_PIPE_MAX_FRAME_BYTES
    this.context = options.context ?? { hostId: 'local' }
  }

  async start(): Promise<CodexAppToolsNativePipeServerStartResult> {
    if (this.server && this.pipePath && this.socketRoot) {
      return { pipePath: this.pipePath, socketRoot: this.socketRoot }
    }
    assertNativePipePlatformSecure()

    const socketRoot = await this.prepareSocketRoot()
    const pipePath = this.createPipePath(socketRoot)
    const server = createServer((socket) => this.attach(socket))
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }

        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(pipePath)
      })

      if (process.platform !== 'win32') {
        await waitForSocketPath(pipePath)
        await chmod(pipePath, 0o600)
      }
    } catch (error) {
      await closeServer(server)
      if (process.platform !== 'win32') await unlink(pipePath).catch(() => undefined)
      if (this.ownsSocketRoot) await rm(socketRoot, { recursive: true, force: true })
      this.ownsSocketRoot = false
      throw error
    }

    server.on('error', (error) => this.options.onUnavailable?.(error))
    this.server = server
    this.pipePath = pipePath
    this.socketRoot = socketRoot
    return { pipePath, socketRoot }
  }

  async shutdown(): Promise<void> {
    const server = this.server
    const pipePath = this.pipePath
    const socketRoot = this.socketRoot
    const ownsSocketRoot = this.ownsSocketRoot

    this.server = undefined
    this.pipePath = undefined
    this.socketRoot = undefined
    this.ownsSocketRoot = false

    for (const session of this.sessions) {
      this.abortSession(session, new Error('Native pipe server is shutting down.'))
      session.socket.destroy()
    }
    this.sessions.clear()

    if (server) {
      await closeServer(server)
    }

    if (pipePath && process.platform !== 'win32') {
      await unlink(pipePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
    if (socketRoot && ownsSocketRoot) {
      await rm(socketRoot, { recursive: true, force: true })
    }
  }

  private async prepareSocketRoot(): Promise<string> {
    if (this.options.socketRoot) {
      await mkdir(this.options.socketRoot, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') await chmod(this.options.socketRoot, 0o700)
      this.ownsSocketRoot = false
      return this.options.socketRoot
    }

    if (process.platform === 'win32') {
      const root = `dascowork-codex-app-tools-${process.pid}-${Date.now()}`
      this.ownsSocketRoot = false
      return root
    }

    const root = await mkdtemp(join(tmpdir(), 'dc-app-tools-'))
    await chmod(root, 0o700)
    this.ownsSocketRoot = true
    return root
  }

  private createPipePath(socketRoot: string): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\${socketRoot}`
    }
    return join(socketRoot, 'c.sock')
  }

  private attach(socket: Socket): void {
    const session: NativePipeClientSession = {
      socket,
      decoder: new NativePipeFrameDecoder(this.maxFrameBytes),
      callsByRequestId: new Map(),
      callsByCallId: new Map()
    }

    this.sessions.add(session)

    socket.on('data', (chunk) => {
      try {
        const frames = session.decoder.push(chunk)
        for (const frame of frames) {
          void this.handleFrame(session, frame)
        }
      } catch (error) {
        this.handleFatalProtocolError(session, error)
      }
    })

    socket.once('close', () => {
      this.abortSession(session, new Error('Native pipe client disconnected.'))
      this.sessions.delete(session)
    })
    socket.once('error', () => {
      this.abortSession(session, new Error('Native pipe client disconnected.'))
      this.sessions.delete(session)
    })
  }

  private async handleFrame(session: NativePipeClientSession, frame: Buffer): Promise<void> {
    let request: NativePipeRequest
    try {
      request = decodeNativePipeRequest(frame)
    } catch (error) {
      this.writeResponse(
        session,
        error instanceof NativePipeProtocolError
          ? nativePipeError(undefined, error.code, error.message)
          : nativePipeError(undefined, -32600, 'Invalid native pipe request.')
      )
      return
    }

    try {
      if (request.method === 'tools/list') {
        const context = contextFromParams(request.params, this.context)
        const tools = await this.options.registry.pipeProjection(context)
        this.writeResponse(session, nativePipeSuccess(request.id, { tools }))
        return
      }

      if (request.method === 'tools/cancel') {
        this.writeResponse(
          session,
          nativePipeSuccess(request.id, { cancelled: this.cancelCall(session, request.params) })
        )
        return
      }

      await this.handleToolCall(session, request)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Native pipe request failed.'
      this.writeResponse(session, nativePipeError(request.id, -32000, message))
    }
  }

  private async handleToolCall(
    session: NativePipeClientSession,
    request: NativePipeRequest
  ): Promise<void> {
    const controller = new AbortController()
    const requestKey = nativePipeRequestIdKey(request.id)
    const call = toolCallFromParams(request.params)
    if (session.callsByRequestId.has(requestKey)) {
      this.writeResponse(
        session,
        nativePipeError(
          request.id,
          -32600,
          'Native pipe request id is already active for this client.'
        )
      )
      return
    }
    if (call.callId && session.callsByCallId.has(call.callId)) {
      this.writeResponse(
        session,
        nativePipeError(
          request.id,
          -32600,
          'Native pipe call id is already active for this client.'
        )
      )
      return
    }
    const activeCall: ActiveToolCall = {
      requestId: request.id,
      requestKey,
      ...(call.callId ? { callId: call.callId } : {}),
      controller
    }

    session.callsByRequestId.set(requestKey, activeCall)
    if (activeCall.callId) session.callsByCallId.set(activeCall.callId, activeCall)

    try {
      const result = await this.options.registry.dispatch(call, controller.signal)
      this.writeResponse(session, nativePipeSuccess(request.id, result))
    } finally {
      session.callsByRequestId.delete(requestKey)
      if (activeCall.callId) session.callsByCallId.delete(activeCall.callId)
    }
  }

  private cancelCall(session: NativePipeClientSession, params: unknown): boolean {
    const target = cancelTargetFromParams(params)
    if (!target) return false

    const call =
      target.kind === 'callId'
        ? session.callsByCallId.get(target.value)
        : session.callsByRequestId.get(nativePipeRequestIdKey(target.value))

    if (!call) return false
    call.controller.abort(new Error('Native pipe tool call was cancelled.'))
    return true
  }

  private abortSession(session: NativePipeClientSession, reason: Error): void {
    for (const call of session.callsByRequestId.values()) {
      call.controller.abort(reason)
    }
    session.callsByRequestId.clear()
    session.callsByCallId.clear()
  }

  private handleFatalProtocolError(session: NativePipeClientSession, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Native pipe protocol error.'
    this.abortSession(session, new Error(message))
    this.writeFinalResponse(session, nativePipeError(undefined, -32001, message))
  }

  private writeResponse(session: NativePipeClientSession, response: unknown): void {
    if (session.socket.destroyed || !session.socket.writable) return

    try {
      session.socket.write(encodeNativePipeFrame(response, this.maxFrameBytes))
    } catch {
      session.socket.destroy()
    }
  }

  private writeFinalResponse(session: NativePipeClientSession, response: unknown): void {
    if (session.socket.destroyed) return
    if (!session.socket.writable) {
      session.socket.destroy()
      return
    }

    try {
      session.socket.end(encodeNativePipeFrame(response, this.maxFrameBytes), () =>
        session.socket.destroy()
      )
    } catch {
      session.socket.destroy()
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => (error ? reject(error) : resolve()))
  }).catch((error) => {
    if (!(error instanceof Error) || !error.message.includes('Server is not running')) throw error
  })
}

export function assertNativePipePlatformSecure(platform = process.platform): void {
  if (platform === 'win32') {
    throw new Error(
      'Codex App Tools Pipe is unavailable on Windows until an ACL-protected named-pipe transport is available.'
    )
  }
}

function toolCallFromParams(params: unknown): DynamicToolCall {
  if (!isRecord(params)) {
    return { namespace: 'codex_app' }
  }

  return {
    namespace: typeof params.namespace === 'string' ? params.namespace : 'codex_app',
    tool:
      typeof params.tool === 'string'
        ? params.tool
        : typeof params.name === 'string'
          ? params.name
          : undefined,
    toolName: typeof params.toolName === 'string' ? params.toolName : undefined,
    arguments: params.arguments,
    input: params.input,
    threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    turnId: typeof params.turnId === 'string' ? params.turnId : undefined,
    callId: typeof params.callId === 'string' ? params.callId : undefined
  }
}

function contextFromParams(params: unknown, fallback: DesktopToolContext): DesktopToolContext {
  if (!isRecord(params)) return fallback

  return {
    ...fallback,
    ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
    ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
    ...(typeof params.callId === 'string' ? { callId: params.callId } : {})
  }
}

function cancelTargetFromParams(
  params: unknown
):
  | { kind: 'requestId'; value: NativePipeRequestId | undefined }
  | { kind: 'callId'; value: string }
  | undefined {
  if (!isRecord(params)) return undefined
  if (typeof params.callId === 'string') return { kind: 'callId', value: params.callId }
  if (Object.prototype.hasOwnProperty.call(params, 'requestId')) {
    return { kind: 'requestId', value: toRequestId(params.requestId) }
  }
  if (Object.prototype.hasOwnProperty.call(params, 'id')) {
    return { kind: 'requestId', value: toRequestId(params.id) }
  }
  return undefined
}

function toRequestId(value: unknown): NativePipeRequestId | undefined {
  return isRequestId(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRequestId(value: unknown): value is NativePipeRequestId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

async function waitForSocketPath(path: string): Promise<void> {
  const startedAt = Date.now()
  while (true) {
    try {
      await stat(path)
      return
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT' ||
        Date.now() - startedAt > 500
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}
