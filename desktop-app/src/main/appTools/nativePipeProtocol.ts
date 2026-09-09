export const NATIVE_PIPE_MAX_FRAME_BYTES = 8 * 1024 * 1024

export type NativePipeRequestId = string | number | null

export type NativePipeMethod = 'tools/list' | 'tools/call' | 'tools/cancel'

export type NativePipeFrame = Buffer<ArrayBufferLike>

export type NativePipeRequest = {
  jsonrpc?: '2.0'
  id?: NativePipeRequestId
  method: NativePipeMethod
  params?: unknown
}

export type NativePipeErrorResponse = {
  jsonrpc: '2.0'
  id: NativePipeRequestId
  error: {
    code: number
    message: string
  }
}

export type NativePipeSuccessResponse = {
  jsonrpc: '2.0'
  id: NativePipeRequestId
  result: unknown
}

export type NativePipeResponse = NativePipeSuccessResponse | NativePipeErrorResponse

export class NativePipeProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number
  ) {
    super(message)
    this.name = 'NativePipeProtocolError'
  }
}

export class NativePipeFrameDecoder {
  private buffered: NativePipeFrame = Buffer.alloc(0)

  constructor(private readonly maxFrameBytes = NATIVE_PIPE_MAX_FRAME_BYTES) {}

  push(chunk: NativePipeFrame): NativePipeFrame[] {
    this.buffered = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk])
    const frames: NativePipeFrame[] = []

    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0)
      if (length === 0) {
        throw new NativePipeProtocolError(
          'Native pipe frame length must be greater than zero.',
          -32600
        )
      }
      if (length > this.maxFrameBytes) {
        throw new NativePipeProtocolError('Native pipe frame exceeds the 8 MiB limit.', -32001)
      }
      if (this.buffered.length < length + 4) break

      frames.push(this.buffered.subarray(4, length + 4))
      this.buffered = this.buffered.subarray(length + 4)
    }

    return frames
  }
}

export function encodeNativePipeFrame(
  message: unknown,
  maxFrameBytes = NATIVE_PIPE_MAX_FRAME_BYTES
): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  if (payload.length > maxFrameBytes) {
    throw new NativePipeProtocolError('Native pipe frame exceeds the 8 MiB limit.', -32001)
  }

  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

export function decodeNativePipeRequest(payload: NativePipeFrame): NativePipeRequest {
  let value: unknown
  try {
    value = JSON.parse(payload.toString('utf8'))
  } catch {
    throw new NativePipeProtocolError('Invalid JSON in native pipe frame.', -32700)
  }

  if (!isRecord(value) || typeof value.method !== 'string') {
    throw new NativePipeProtocolError('Invalid native pipe request.', -32600)
  }

  if (
    value.method !== 'tools/list' &&
    value.method !== 'tools/call' &&
    value.method !== 'tools/cancel'
  ) {
    throw new NativePipeProtocolError(`Unsupported native pipe method: ${value.method}.`, -32601)
  }

  const id = normalizeRequestId(value.id)
  return {
    ...(value.jsonrpc === '2.0' ? { jsonrpc: '2.0' as const } : {}),
    ...(id !== undefined ? { id } : {}),
    method: value.method,
    ...(Object.prototype.hasOwnProperty.call(value, 'params') ? { params: value.params } : {})
  }
}

export function nativePipeSuccess(
  id: NativePipeRequestId | undefined,
  result: unknown
): NativePipeSuccessResponse {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

export function nativePipeError(
  id: NativePipeRequestId | undefined,
  code: number,
  message: string
): NativePipeErrorResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export function nativePipeRequestIdKey(id: NativePipeRequestId | undefined): string {
  return id === undefined ? 'undefined:' : `${typeof id}:${String(id)}`
}

function normalizeRequestId(id: unknown): NativePipeRequestId | undefined {
  if (id === undefined) return undefined
  if (isRequestId(id)) return id
  throw new NativePipeProtocolError(
    'Native pipe request id must be a string, number, or null.',
    -32600
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRequestId(value: unknown): value is NativePipeRequestId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}
