import { once } from 'node:events'
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'

export type MockRequest = {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

export type MockBackend = {
  baseUrl: string
  requests: MockRequest[]
  close(): Promise<void>
}

export type MockBackendOptions = {
  responses: ResponsesStep[]
  searchResponses?: unknown[]
  modelApiBasePath?: string
  modelProvider?: string
  capabilities?: string[]
}

export type ResponsesStreamTermination = 'complete' | 'disconnect' | 'hang' | 'close-before-headers'

export type ResponsesStreamStep = {
  events: ResponseEvent[]
  beforeResponse?: () => void | Promise<void>
  beforeEvent?: (event: ResponseEvent, index: number) => void | Promise<void>
  rawSse?: readonly string[]
  termination?: ResponsesStreamTermination
}

export type ResponsesErrorStep = {
  status: number
  body: unknown
  beforeResponse?: () => void | Promise<void>
}

export type ResponsesStep = ResponsesStreamStep | ResponsesErrorStep

export type ResponseEvent = {
  type: string
  [key: string]: unknown
}

export async function startMockBackend(options: MockBackendOptions): Promise<MockBackend> {
  const requests: MockRequest[] = []
  const responses = [...options.responses]
  const searchResponses = [...(options.searchResponses ?? [])]
  const activeResponses = new Set<ServerResponse>()
  const server = createServer(async (request, response) => {
    activeResponses.add(response)
    response.once('close', () => activeResponses.delete(response))
    const capturedRequest: MockRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body: ''
    }
    requests.push(capturedRequest)

    const body = await readRequestBody(request)
    capturedRequest.body = body

    if (request.method === 'GET' && request.url?.startsWith('/api/client-models')) {
      writeJson(response, [
        {
          model_id: 'qwen3.7-plus',
          display_name: 'qwen3.7-plus',
          description: null,
          provider: options.modelProvider ?? 'qwen',
          is_default: true,
          capabilities: options.capabilities ?? ['text'],
          api_base_url: `${serverBaseUrl(server)}${options.modelApiBasePath ?? ''}`,
          api_key: 'sk-e2e-test-key',
          api_format: 'openai',
          source: 'admin'
        }
      ])
      return
    }

    if (request.method === 'GET' && (request.url === '/v1/models' || request.url === '/models')) {
      writeJson(response, {
        object: 'list',
        data: [{ id: 'qwen3.7-plus', object: 'model', created: 0, owned_by: 'qwen' }]
      })
      return
    }

    if (request.method === 'POST' && request.url === '/api/codex/alpha/search') {
      writeJson(
        response,
        searchResponses.shift() ?? { encrypted_output: 'ciphertext', output: 'Search result' }
      )
      return
    }

    if (request.method === 'POST' && isResponsesUrl(request.url)) {
      const nextResponse = responses.shift()
      if (!nextResponse) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'No scripted /responses payload remaining' }))
        return
      }
      await nextResponse.beforeResponse?.()
      if ('status' in nextResponse) {
        response.writeHead(nextResponse.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(nextResponse.body))
        return
      }
      await writeResponsesStream(response, nextResponse)
      return
    }

    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: `Unhandled ${request.method} ${request.url}` }))
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  return {
    baseUrl: serverBaseUrl(server),
    requests,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        for (const response of activeResponses) response.destroy()
        server.close((error) => (error ? rejectClose(error) : resolveClose()))
      })
  }
}

export function isResponsesUrl(url: string | undefined): boolean {
  return url === '/responses' || url === '/api/codex/responses'
}

export function assistantMessageResponse(
  responseId: string,
  messageId: string,
  text: string
): ResponsesStreamStep {
  return {
    events: [
      responseCreated(responseId),
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: messageId,
          content: [{ type: 'output_text', text }]
        }
      },
      responseCompleted(responseId)
    ]
  }
}

export function disconnectingResponse(responseId: string): ResponsesStreamStep {
  return {
    events: [responseCreated(responseId)],
    termination: 'disconnect'
  }
}

export function assistantMessageAndShellCommandResponse(
  responseId: string,
  messageId: string,
  text: string,
  callId: string,
  args: Record<string, unknown>,
  options: { phase?: 'commentary' | 'final_answer' } = {}
): ResponsesStreamStep {
  return {
    events: [
      responseCreated(responseId),
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: messageId,
          content: [{ type: 'output_text', text }],
          ...(options.phase ? { phase: options.phase } : {})
        }
      },
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: callId,
          name: 'shell_command',
          arguments: JSON.stringify(args)
        }
      },
      responseCompleted(responseId)
    ]
  }
}

export function shellCommandResponse(
  responseId: string,
  callId: string,
  args: Record<string, unknown>
): ResponsesStreamStep {
  return dynamicFunctionCallResponse(responseId, callId, 'shell_command', args)
}

/**
 * Emits a standard Responses API function call.  Keep this helper at the
 * model HTTP boundary: Electron, the app-server, and desktop tool registry
 * remain the production implementations in E2E tests.
 */
export function dynamicFunctionCallResponse(
  responseId: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  options: { namespace?: string } = {}
): ResponsesStreamStep {
  return {
    events: [
      responseCreated(responseId),
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: callId,
          ...(options.namespace ? { namespace: options.namespace } : {}),
          name,
          arguments: JSON.stringify(args)
        }
      },
      responseCompleted(responseId)
    ]
  }
}

export function applyPatchResponse(
  responseId: string,
  callId: string,
  patch: string
): ResponsesStreamStep {
  return shellCommandResponse(responseId, callId, {
    command: `apply_patch <<'EOF'\n${patch}\nEOF`
  })
}

export function webSearchResponse(
  responseId: string,
  callId: string,
  query: string
): ResponsesStreamStep {
  return {
    events: [
      responseCreated(responseId),
      {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: callId,
          namespace: 'web',
          name: 'run',
          arguments: JSON.stringify({
            search_query: [{ q: query }]
          })
        }
      },
      responseCompleted(responseId)
    ]
  }
}

export function providerResponseBodies(backend: MockBackend): unknown[] {
  return backend.requests
    .filter((request) => request.method === 'POST' && isResponsesUrl(request.url))
    .flatMap((request) => {
      if (!request.body.trim()) return []
      try {
        return [JSON.parse(request.body) as unknown]
      } catch (error) {
        if (error instanceof SyntaxError) return []
        throw error
      }
    })
}

export function functionCallOutputText(providerBody: unknown, callId: string): string | undefined {
  if (!isRecord(providerBody) || !Array.isArray(providerBody.input)) return undefined
  const outputItem = providerBody.input.find(
    (item) => isRecord(item) && item.type === 'function_call_output' && item.call_id === callId
  )
  if (!isRecord(outputItem) || typeof outputItem.output !== 'string') return undefined
  return outputItem.output
}

export function functionCallOutputCount(providerBodies: unknown[], callId: string): number {
  return providerBodies.reduce((count, providerBody) => {
    if (!isRecord(providerBody) || !Array.isArray(providerBody.input)) return count
    return (
      count +
      providerBody.input.filter(
        (item) => isRecord(item) && item.type === 'function_call_output' && item.call_id === callId
      ).length
    )
  }, 0)
}

export function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function serverBaseUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock backend is not listening')
  return `http://127.0.0.1:${address.port}`
}

function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*'
  })
  response.end(JSON.stringify(payload))
}

async function writeResponsesStream(
  response: ServerResponse,
  step: ResponsesStreamStep
): Promise<void> {
  if (step.termination === 'close-before-headers') {
    response.destroy()
    return
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  for (const [index, event] of step.events.entries()) {
    await step.beforeEvent?.(event, index)
    await writeSse(response, event)
  }
  for (const rawSse of step.rawSse ?? []) await writeResponseChunk(response, rawSse)

  switch (step.termination ?? 'complete') {
    case 'complete':
      response.end()
      return
    case 'disconnect':
      response.destroy()
      return
    case 'hang':
      return
  }
}

export function responseCreated(responseId: string): ResponseEvent {
  return {
    type: 'response.created',
    response: { id: responseId }
  }
}

export function responseCompleted(responseId: string): ResponseEvent {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2
      }
    }
  }
}

function writeSse(response: ServerResponse, payload: ResponseEvent): Promise<void> {
  return writeResponseChunk(
    response,
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`
  )
}

function writeResponseChunk(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.resolve()

  return new Promise((resolveWrite, rejectWrite) => {
    response.write(chunk, (error) => {
      if (!error || response.destroyed) {
        resolveWrite()
        return
      }
      rejectWrite(error)
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    request.on('end', () => resolveRead(Buffer.concat(chunks).toString('utf8')))
    request.on('error', rejectRead)
  })
}
