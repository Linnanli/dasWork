#!/usr/bin/env node
// Repository-owned MCP stdio bridge. See docs/specs/codex-app-tools-bridge-protocol.md.
import { createConnection } from 'node:net'

const MCP_PROTOCOL_VERSION = '2025-03-26'
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

class McpBridge {
  constructor(nativePipe) {
    this.nativePipe = nativePipe
    this.activeToolCalls = new Map()
  }

  async handle(message) {
    const request = parseMcpRequest(message)
    const isNotification = request.id === undefined

    if (request.method === 'notifications/initialized') return undefined

    if (request.method === 'notifications/cancelled') {
      await this.cancel(request.params)
      return undefined
    }

    if (request.method === 'initialize') {
      return isNotification
        ? undefined
        : success(request.id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'dascowork-codex-app-tools', version: '0.2.0' }
          })
    }

    if (request.method === 'shutdown') {
      if (!isNotification) {
        setImmediate(() => {
          this.nativePipe.close()
          process.exit(0)
        })
        return success(request.id, {})
      }
      this.nativePipe.close()
      process.exit(0)
    }

    if (request.method === 'tools/list') {
      const nativeRequest = await this.nativePipe.request(
        'tools/list',
        contextFromMcpParams(request.params)
      )
      const response = await nativeRequest.result
      return isNotification ? undefined : success(request.id, toolsListFromNative(response.result))
    }

    if (request.method === 'tools/call') {
      if (isNotification) {
        throw new McpProtocolError('tools/call must be a request.', -32600)
      }
      const call = toolCallFromMcpParams(request.params)
      const nativeRequest = await this.nativePipe.request('tools/call', call)
      const requestKey = requestIdKey(request.id)
      this.activeToolCalls.set(requestKey, nativeRequest.id)
      try {
        return success(request.id, toolResultFromNative((await nativeRequest.result).result))
      } finally {
        this.activeToolCalls.delete(requestKey)
      }
    }

    if (isNotification) return undefined
    return failure(request.id, -32601, `Unsupported MCP method: ${request.method}.`)
  }

  async cancel(params) {
    if (!isRecord(params) || !isRequestId(params.requestId)) return
    const nativeRequestId = this.activeToolCalls.get(requestIdKey(params.requestId))
    if (!nativeRequestId) return

    try {
      const cancellation = await this.nativePipe.request('tools/cancel', {
        requestId: nativeRequestId
      })
      await cancellation.result
    } catch (error) {
      reportDiagnostic('Could not cancel native tool call', error)
    }
  }
}

class NativePipeClient {
  constructor(path) {
    this.path = path
    this.socket = undefined
    this.connecting = undefined
    this.buffered = Buffer.alloc(0)
    this.pending = new Map()
    this.nextRequestId = 0
  }

  async request(method, params) {
    const socket = await this.connect()
    const id = `bridge-${++this.nextRequestId}`
    let resolveResponse
    let rejectResponse
    const result = new Promise((resolve, reject) => {
      resolveResponse = resolve
      rejectResponse = reject
    })
    this.pending.set(id, { resolve: resolveResponse, reject: rejectResponse })

    try {
      socket.write(encodeNativeFrame({ jsonrpc: '2.0', id, method, params }), (error) => {
        if (error) this.rejectRequest(id, error)
      })
    } catch (error) {
      this.rejectRequest(id, error)
    }
    return { id, result }
  }

  close() {
    const socket = this.socket
    this.socket = undefined
    this.connecting = undefined
    if (socket && !socket.destroyed) socket.destroy()
    this.rejectAll(new Error('Native Pipe connection closed.'))
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return this.socket
    if (this.connecting) return this.connecting

    this.connecting = new Promise((resolve, reject) => {
      const socket = createConnection(this.path)
      const rejectConnection = (error) => {
        socket.destroy()
        if (this.socket === socket) this.socket = undefined
        reject(new McpProtocolError('Could not connect to the desktop tool host.', -32000, error))
      }

      socket.once('error', rejectConnection)
      socket.once('connect', () => {
        socket.off('error', rejectConnection)
        this.socket = socket
        this.attach(socket)
        resolve(socket)
      })
    })

    try {
      return await this.connecting
    } finally {
      this.connecting = undefined
    }
  }

  attach(socket) {
    socket.on('data', (chunk) => {
      try {
        this.consume(chunk)
      } catch (error) {
        this.closeWithError(
          error instanceof Error
            ? error
            : new McpProtocolError('Invalid response from desktop tool host.', -32000)
        )
      }
    })
    socket.once('error', () =>
      this.closeWithError(new McpProtocolError('Desktop tool host connection failed.', -32000))
    )
    socket.once('close', () =>
      this.closeWithError(new McpProtocolError('Desktop tool host connection closed.', -32000))
    )
  }

  consume(chunk) {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    while (this.buffered.length >= 4) {
      const size = this.buffered.readUInt32LE(0)
      if (size === 0 || size > MAX_MESSAGE_BYTES) {
        throw new McpProtocolError('Desktop tool host frame is outside the permitted size.', -32001)
      }
      if (this.buffered.length < size + 4) return

      const payload = this.buffered.subarray(4, size + 4)
      this.buffered = this.buffered.subarray(size + 4)
      this.consumeResponse(payload)
    }
  }

  consumeResponse(payload) {
    let response
    try {
      response = JSON.parse(payload.toString('utf8'))
    } catch {
      throw new McpProtocolError('Desktop tool host returned invalid JSON.', -32000)
    }
    if (!isRecord(response) || !isRequestId(response.id)) {
      throw new McpProtocolError('Desktop tool host returned an invalid response.', -32000)
    }

    const key = String(response.id)
    const pending = this.pending.get(key)
    if (!pending) return
    this.pending.delete(key)

    if (isRecord(response.error)) {
      pending.reject(
        new McpProtocolError(
          typeof response.error.message === 'string'
            ? response.error.message
            : 'Desktop tool host request failed.',
          typeof response.error.code === 'number' ? response.error.code : -32000
        )
      )
      return
    }
    if (!Object.hasOwn(response, 'result')) {
      pending.reject(new McpProtocolError('Desktop tool host returned no result.', -32000))
      return
    }
    pending.resolve(response)
  }

  rejectRequest(id, error) {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.reject(error instanceof Error ? error : new Error(String(error)))
  }

  closeWithError(error) {
    if (this.socket && !this.socket.destroyed) this.socket.destroy()
    this.socket = undefined
    this.connecting = undefined
    this.rejectAll(error)
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function startStdio(bridge) {
  let buffered = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffered += chunk
    if (Buffer.byteLength(buffered, 'utf8') > MAX_MESSAGE_BYTES && !buffered.includes('\n')) {
      writeMessage(failure(null, -32001, 'MCP message exceeds the 8 MiB limit.'))
      buffered = ''
      return
    }

    while (true) {
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (!line) continue
      if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) {
        writeMessage(failure(null, -32001, 'MCP message exceeds the 8 MiB limit.'))
        continue
      }
      void handleLine(bridge, line)
    }
  })
  process.stdin.once('end', () => bridge.nativePipe.close())
}

async function handleLine(bridge, line) {
  let message
  try {
    message = JSON.parse(line)
    const response = await bridge.handle(message)
    if (response) writeMessage(response)
  } catch (error) {
    const protocolError =
      error instanceof McpProtocolError
        ? error
        : error instanceof SyntaxError
          ? new McpProtocolError('Invalid MCP JSON.', -32700, error)
          : new McpProtocolError('MCP request failed.', -32000, error)
    writeMessage(
      failure(
        protocolError.id ?? requestIdFromMessage(message) ?? null,
        protocolError.code,
        protocolError.message
      )
    )
  }
}

function parseMcpRequest(value) {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') {
    throw new McpProtocolError('Invalid MCP request.', -32600)
  }
  if (Object.hasOwn(value, 'id') && !isRequestId(value.id)) {
    throw new McpProtocolError('MCP request id must be a string, number, or null.', -32600)
  }
  return {
    id: Object.hasOwn(value, 'id') ? value.id : undefined,
    method: value.method,
    params: value.params
  }
}

function contextFromMcpParams(params) {
  const meta = isRecord(params) && isRecord(params._meta) ? params._meta : {}
  return compact({
    threadId: stringOrUndefined(meta['openai/threadId']),
    turnId: stringOrUndefined(meta['openai/turnId']),
    callId: stringOrUndefined(meta['openai/toolCallId'])
  })
}

function toolCallFromMcpParams(params) {
  if (!isRecord(params) || typeof params.name !== 'string' || !params.name) {
    throw new McpProtocolError('tools/call requires a non-empty tool name.', -32600)
  }
  const context = contextFromMcpParams(params)
  return {
    namespace: 'codex_app',
    name: params.name,
    arguments: Object.hasOwn(params, 'arguments') ? params.arguments : {},
    ...context
  }
}

function toolsListFromNative(value) {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new McpProtocolError('Desktop tool host returned an invalid tools list.', -32000)
  }
  return {
    tools: value.tools.map((tool) => {
      if (
        !isRecord(tool) ||
        typeof tool.name !== 'string' ||
        !tool.name ||
        !isRecord(tool.inputSchema)
      ) {
        throw new McpProtocolError('Desktop tool host returned an invalid tool definition.', -32000)
      }
      return {
        name: tool.name,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema
      }
    })
  }
}

function toolResultFromNative(value) {
  if (!isRecord(value) || typeof value.success !== 'boolean' || !Array.isArray(value.contentItems)) {
    throw new McpProtocolError('Desktop tool host returned an invalid tool result.', -32000)
  }

  const content = []
  for (const item of value.contentItems) {
    if (!isRecord(item)) {
      throw new McpProtocolError('Desktop tool host returned an invalid content item.', -32000)
    }
    if (item.type === 'inputText' && typeof item.text === 'string') {
      content.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type === 'inputImage' && typeof item.imageUrl === 'string') {
      const image = parseDataImage(item.imageUrl)
      if (!image) {
        return {
          content: [{ type: 'text', text: 'Desktop tool returned an unsupported image URL.' }],
          isError: true
        }
      }
      content.push(image)
      continue
    }
    throw new McpProtocolError('Desktop tool host returned an unsupported content item.', -32000)
  }
  return { content, isError: !value.success }
}

function parseDataImage(value) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/]+=*)$/iu.exec(value)
  return match ? { type: 'image', mimeType: match[1], data: match[2] } : undefined
}

function encodeNativeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.length === 0 || payload.length > MAX_MESSAGE_BYTES) {
    throw new McpProtocolError('Native Pipe message exceeds the 8 MiB limit.', -32001)
  }
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

function success(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function requestIdKey(value) {
  return `${typeof value}:${String(value)}`
}

function requestIdFromMessage(value) {
  return isRecord(value) && Object.hasOwn(value, 'id') && isRequestId(value.id)
    ? value.id
    : undefined
}

function stringOrUndefined(value) {
  return typeof value === 'string' ? value : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRequestId(value) {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function reportDiagnostic(prefix, error) {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${prefix}: ${detail}\n`)
}

class McpProtocolError extends Error {
  constructor(message, code, cause, id) {
    super(message, cause ? { cause } : undefined)
    this.name = 'McpProtocolError'
    this.code = code
    this.id = id
  }
}

function main() {
  const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH
  if (!pipePath) {
    process.stderr.write('CODEX_APP_TOOLS_PIPE_PATH is required.\n')
    process.exitCode = 1
    return
  }

  const nativePipe = new NativePipeClient(pipePath)
  startStdio(new McpBridge(nativePipe))
}

main()
