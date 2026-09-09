import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Socket } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DynamicAppToolRegistry,
  type DynamicAppToolDefinition,
  type DesktopToolContext
} from './DynamicAppToolRegistry'
import { assertNativePipePlatformSecure, CodexAppToolsNativePipeServer } from './nativePipeServer'
import {
  encodeNativePipeFrame,
  NativePipeFrameDecoder,
  NATIVE_PIPE_MAX_FRAME_BYTES,
  type NativePipeResponse
} from './nativePipeProtocol'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CodexAppToolsNativePipeServer', () => {
  it('fails closed on Windows until named-pipe ACL enforcement exists', () => {
    expect(() => assertNativePipePlatformSecure('win32')).toThrow('ACL-protected')
  })

  it('handles fragmented and coalesced little-endian frames', async () => {
    const registry = createRegistry()
    const server = new CodexAppToolsNativePipeServer({ registry })
    const { pipePath, socketRoot } = await server.start()
    tempRoots.push(socketRoot)

    const client = await connect(pipePath)
    try {
      const listFrame = encodeNativePipeFrame({
        id: 'list',
        method: 'tools/list',
        params: { threadId: 'thread-1' }
      })
      client.write(listFrame.subarray(0, 2))
      client.write(listFrame.subarray(2))

      const firstCall = encodeNativePipeFrame({
        id: 'call-1',
        method: 'tools/call',
        params: { tool: 'echo', arguments: { value: 1 }, threadId: 'thread-1' }
      })
      const secondCall = encodeNativePipeFrame({
        id: 'call-2',
        method: 'tools/call',
        params: { tool: 'echo', arguments: { value: 2 }, threadId: 'thread-1' }
      })
      client.write(Buffer.concat([firstCall, secondCall]))

      const responses = await readResponses(client, 3)
      expect(responses).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'list',
            result: {
              tools: [
                {
                  type: 'function',
                  name: 'echo',
                  description: 'Echo input.',
                  inputSchema: { type: 'object' },
                  namespace: 'codex_app'
                }
              ]
            }
          }),
          expect.objectContaining({
            id: 'call-1',
            result: expect.objectContaining({
              success: true,
              contentItems: expect.arrayContaining([
                expect.objectContaining({ text: '{"value":1}' })
              ])
            })
          }),
          expect.objectContaining({
            id: 'call-2',
            result: expect.objectContaining({
              success: true,
              contentItems: expect.arrayContaining([
                expect.objectContaining({ text: '{"value":2}' })
              ])
            })
          })
        ])
      )
    } finally {
      client.destroy()
      await server.shutdown()
    }
  })

  it('rejects invalid JSON frames without invoking tools', async () => {
    const calls: unknown[] = []
    const registry = createRegistry({ onExecute: (value) => calls.push(value) })
    const server = new CodexAppToolsNativePipeServer({ registry })
    const { pipePath, socketRoot } = await server.start()
    tempRoots.push(socketRoot)

    const invalidClient = await connect(pipePath)
    try {
      const invalidResponses = readResponses(invalidClient, 1)
      invalidClient.write(frameFromPayload(Buffer.from('{')))
      const [invalidResponse] = await invalidResponses
      expect(invalidResponse).toMatchObject({
        id: null,
        error: { code: -32700 }
      })
      expect(calls).toEqual([])
    } finally {
      invalidClient.destroy()
    }

    await server.shutdown()
  })

  it('rejects overlimit frames without invoking tools', async () => {
    const calls: unknown[] = []
    const registry = createRegistry({ onExecute: (value) => calls.push(value) })
    const server = new CodexAppToolsNativePipeServer({ registry })
    const { pipePath, socketRoot } = await server.start()
    tempRoots.push(socketRoot)

    const overlimitClient = await connect(pipePath)
    try {
      const header = Buffer.alloc(4)
      header.writeUInt32LE(NATIVE_PIPE_MAX_FRAME_BYTES + 1, 0)
      const closed = socketClosed(overlimitClient)
      const response = readResponses(overlimitClient, 1)
      overlimitClient.end(header)
      await expect(timeoutAfter(response, 'overlimit response')).resolves.toMatchObject([
        {
          id: null,
          error: { code: -32001 }
        }
      ])
      await timeoutAfter(closed, 'overlimit client close')
      expect(calls).toEqual([])
    } finally {
      overlimitClient.destroy()
      await timeoutAfter(server.shutdown(), 'overlimit server shutdown')
    }
  })

  it('creates a private socket directory and restrictive Unix socket permissions', async () => {
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'dc-pipe-perm-'))
    tempRoots.push(root)
    await chmod(root, 0o755)

    const server = new CodexAppToolsNativePipeServer({
      registry: createRegistry(),
      socketRoot: root
    })
    const { pipePath } = await server.start()
    try {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(pipePath)).mode & 0o777).toBe(0o600)
    } finally {
      await server.shutdown()
    }
  })

  it('isolates identical request ids across socket clients', async () => {
    let releaseFirst: (() => void) | undefined
    const registry = createRegistry({
      async onExecute(value) {
        if (isRecord(value) && value.client === 'first') {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        }
        return value
      }
    })
    const server = new CodexAppToolsNativePipeServer({ registry })
    const { pipePath, socketRoot } = await server.start()
    tempRoots.push(socketRoot)

    const first = await connect(pipePath)
    const second = await connect(pipePath)
    try {
      first.write(
        encodeNativePipeFrame({
          id: 'same-id',
          method: 'tools/call',
          params: { tool: 'echo', arguments: { client: 'first' } }
        })
      )
      second.write(
        encodeNativePipeFrame({
          id: 'same-id',
          method: 'tools/call',
          params: { tool: 'echo', arguments: { client: 'second' } }
        })
      )

      const [secondResponse] = await readResponses(second, 1)
      expect(secondResponse).toMatchObject({
        id: 'same-id',
        result: { success: true, contentItems: [{ text: '{"client":"second"}' }] }
      })

      releaseFirst?.()
      const [firstResponse] = await readResponses(first, 1)
      expect(firstResponse).toMatchObject({
        id: 'same-id',
        result: { success: true, contentItems: [{ text: '{"client":"first"}' }] }
      })
    } finally {
      first.destroy()
      second.destroy()
      await server.shutdown()
    }
  })

  it('rejects duplicate active request and call ids within one client', async () => {
    let release: (() => void) | undefined
    const registry = createRegistry({
      onExecute: async (_value, context) =>
        new Promise((resolve) => {
          release = () => resolve({ pending: false })
          context.signal.addEventListener('abort', () => resolve({ cancelled: true }), {
            once: true
          })
        })
    })
    const server = new CodexAppToolsNativePipeServer({ registry })
    const { pipePath, socketRoot } = await server.start()
    tempRoots.push(socketRoot)
    const client = await connect(pipePath)
    try {
      client.write(
        encodeNativePipeFrame({
          id: 'duplicate',
          method: 'tools/call',
          params: { tool: 'echo', callId: 'call-1', arguments: {} }
        })
      )
      client.write(
        encodeNativePipeFrame({
          id: 'duplicate',
          method: 'tools/call',
          params: { tool: 'echo', callId: 'call-1', arguments: {} }
        })
      )

      const [duplicate] = await readResponses(client, 1)
      expect(duplicate).toMatchObject({
        id: 'duplicate',
        error: { code: -32600, message: expect.stringContaining('already active') }
      })
      release?.()
    } finally {
      client.destroy()
      await server.shutdown()
    }
  })

  it('cancels only matching calls from the same client and aborts on disconnect and shutdown', async () => {
    const starts: string[] = []
    const aborts: string[] = []
    const registry = createRegistry({
      async onExecute(value, context) {
        if (isRecord(value) && typeof value.name === 'string') starts.push(value.name)
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              if (isRecord(value) && typeof value.name === 'string') aborts.push(value.name)
              resolve()
            },
            { once: true }
          )
        })
        return value
      }
    })
    const server = new CodexAppToolsNativePipeServer({ registry })
    const { pipePath, socketRoot } = await server.start()
    tempRoots.push(socketRoot)

    const first = await connect(pipePath)
    const second = await connect(pipePath)
    try {
      first.write(
        encodeNativePipeFrame({
          id: 'shared-id',
          method: 'tools/call',
          params: { tool: 'echo', callId: 'first-call', arguments: { name: 'first' } }
        })
      )
      second.write(
        encodeNativePipeFrame({
          id: 'shared-id',
          method: 'tools/cancel',
          params: { id: 'shared-id' }
        })
      )

      await expect(readResponses(second, 1)).resolves.toMatchObject([
        { result: { cancelled: false } }
      ])
      expect(aborts).toEqual([])

      first.write(
        encodeNativePipeFrame({
          id: 'cancel-first',
          method: 'tools/cancel',
          params: { callId: 'first-call' }
        })
      )
      await expect(readResponses(first, 2)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'cancel-first', result: { cancelled: true } }),
          expect.objectContaining({
            id: 'shared-id',
            result: expect.objectContaining({ success: false })
          })
        ])
      )
      expect(aborts).toEqual(['first'])

      first.write(
        encodeNativePipeFrame({
          id: 'disconnect-call',
          method: 'tools/call',
          params: { tool: 'echo', arguments: { name: 'disconnect' } }
        })
      )
      await waitFor(() => starts.includes('disconnect'))
      first.destroy()
      await waitFor(() => aborts.includes('disconnect'))

      second.write(
        encodeNativePipeFrame({
          id: 'shutdown-call',
          method: 'tools/call',
          params: { tool: 'echo', arguments: { name: 'shutdown' } }
        })
      )
      await waitFor(() => starts.includes('shutdown'))
      await server.shutdown()
      await waitFor(() => aborts.includes('shutdown'))
    } finally {
      first.destroy()
      second.destroy()
      await server.shutdown()
    }
  })
})

function createRegistry(
  options: {
    onExecute?: (
      value: unknown,
      context: DesktopToolContext & { signal: AbortSignal }
    ) => unknown | Promise<unknown>
  } = {}
): DynamicAppToolRegistry {
  const registry = new DynamicAppToolRegistry({ timeoutMs: 1000 })
  const definition: DynamicAppToolDefinition = {
    namespace: 'codex_app',
    name: 'echo',
    description: 'Echo input.',
    inputSchema: { type: 'object' },
    exposure: { native: true, pipe: true },
    availability: async () => ({ state: 'available' }),
    async execute(context, argumentsValue) {
      const result = options.onExecute
        ? await options.onExecute(argumentsValue, context)
        : argumentsValue
      return {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }]
      }
    }
  }
  registry.register(definition)
  return registry
}

async function connect(path: string): Promise<Socket> {
  const socket = new Socket()
  socket.connect(path)
  await once(socket, 'connect')
  return socket
}

function frameFromPayload(payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

async function readResponses(socket: Socket, count: number): Promise<NativePipeResponse[]> {
  const decoder = new NativePipeFrameDecoder()
  const responses: NativePipeResponse[] = []

  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      try {
        for (const frame of decoder.push(chunk)) {
          responses.push(JSON.parse(frame.toString('utf8')) as NativePipeResponse)
        }
        if (responses.length >= count) cleanup(resolve)
      } catch (error) {
        cleanup(() => reject(error))
      }
    }
    const onError = (error: Error): void => cleanup(() => reject(error))
    const cleanup = (done: (value: NativePipeResponse[]) => void): void => {
      socket.off('data', onData)
      socket.off('error', onError)
      done(responses)
    }

    socket.on('data', onData)
    socket.once('error', onError)
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > 1000)
      throw new Error('Timed out waiting for native pipe condition.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function timeoutAfter<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 1000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function socketClosed(socket: Socket): Promise<void> {
  if (socket.destroyed) return

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('end', onClose)
      socket.off('close', onClose)
      socket.off('error', onError)
    }
    const onClose = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    socket.once('end', onClose)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
