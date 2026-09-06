import { access } from 'node:fs/promises'

import type { UIMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import { NativeCodexRunDriver } from './NativeCodexRunDriver'

type ServerRequestRouter = {
  routeServerRequest(
    request: { method: string; id: number; params: unknown },
    input: {
      ephemeral?: boolean
      onApprovalRequest?: (kind: string, params: unknown) => Promise<unknown>
      onDynamicToolCall?: (params: unknown) => Promise<unknown>
    }
  ): Promise<unknown>
}

function router(): ServerRequestRouter {
  return new NativeCodexRunDriver({
    command: '/test/codex',
    args: ['app-server', '--listen', 'stdio://'],
    displayBinary: '/test/codex app-server --listen stdio://'
  }) as unknown as ServerRequestRouter
}

function request(method: string): { method: string; id: number; params: { marker: string } } {
  return { method, id: 1, params: { marker: method } }
}

type FakeRequest = (method: string, params: unknown) => Promise<unknown>

class FakeAppServerClient {
  readonly request: ReturnType<typeof vi.fn<FakeRequest>>
  readonly disconnect = vi.fn(async () => undefined)
  private readonly anyNotificationHandlers: Array<
    (method: string, params: unknown) => void | Promise<void>
  > = []
  private readonly transportTerminationHandlers: Array<(error: Error) => void> = []

  constructor(requestImpl: FakeRequest) {
    this.request = vi.fn(requestImpl)
  }

  onAnyNotification(
    handler: (method: string, params: unknown) => void | Promise<void>
  ): () => void {
    this.anyNotificationHandlers.push(handler)
    return () => undefined
  }

  onNotification(): () => void {
    return () => undefined
  }

  onRequest(): () => void {
    return () => undefined
  }

  onTransportTermination(handler: (error: Error) => void): () => void {
    this.transportTerminationHandlers.push(handler)
    return () => undefined
  }

  async emitNotification(method: string, params: unknown): Promise<void> {
    for (const handler of this.anyNotificationHandlers) await handler(method, params)
  }

  terminate(error: Error): void {
    for (const handler of this.transportTerminationHandlers) handler(error)
  }
}

function driverWithClient(client: FakeAppServerClient): NativeCodexRunDriver {
  return new NativeCodexRunDriver(
    {
      command: '/test/codex',
      args: ['app-server', '--listen', 'stdio://'],
      displayBinary: '/test/codex app-server --listen stdio://'
    },
    {
      acquire: vi.fn(async () => client),
      shutdown: vi.fn(async () => undefined)
    } as never
  )
}

function userMessage(parts: UIMessage['parts']): UIMessage {
  return { id: 'message-1', role: 'user', parts }
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const event of events) {
    // Drain until the driver reaches a terminal state.
    void event
  }
}

describe('NativeCodexRunDriver server-request routing', () => {
  it.each([
    ['item/commandExecution/requestApproval', 'command'],
    ['item/fileChange/requestApproval', 'file-change'],
    ['item/tool/requestUserInput', 'tool-user-input'],
    ['mcpServer/elicitation/request', 'mcp-elicitation'],
    ['item/permissions/requestApproval', 'permission-request']
  ])('routes %s through the renderer-safe %s approval handler', async (method, kind) => {
    const onApprovalRequest = vi.fn(async (receivedKind: string) => ({ receivedKind }))

    await expect(
      router().routeServerRequest(request(method), { onApprovalRequest })
    ).resolves.toEqual(
      method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
        ? { decision: { receivedKind: kind } }
        : { receivedKind: kind }
    )
    expect(onApprovalRequest).toHaveBeenCalledWith(
      kind,
      expect.objectContaining({ marker: method })
    )
  })

  it('routes dynamic tools only through the main-owned handler', async () => {
    const onDynamicToolCall = vi.fn(async () => ({ success: true, contentItems: [] }))

    await expect(
      router().routeServerRequest(request('item/tool/call'), { onDynamicToolCall })
    ).resolves.toEqual({ success: true, contentItems: [] })
  })

  it.each([
    'account/chatgptAuthTokens/refresh',
    'attestation/generate',
    'currentTime/read',
    'applyPatchApproval',
    'execCommandApproval',
    'future/server/request'
  ])('fails closed for %s', async (method) => {
    await expect(router().routeServerRequest(request(method), {})).rejects.toThrow(
      /Unsupported Codex server request/u
    )
  })

  it('never forwards approvals or dynamic tools from an ephemeral run', async () => {
    const onApprovalRequest = vi.fn(async () => 'approved')
    const onDynamicToolCall = vi.fn(async () => ({ success: true }))

    await expect(
      router().routeServerRequest(request('item/commandExecution/requestApproval'), {
        ephemeral: true,
        onApprovalRequest,
        onDynamicToolCall
      })
    ).rejects.toThrow(/ephemeral\/item\/commandExecution/u)
    expect(onApprovalRequest).not.toHaveBeenCalled()
    expect(onDynamicToolCall).not.toHaveBeenCalled()
  })
})

describe('NativeCodexRunDriver Goal lifecycle', () => {
  it('starts the framed first turn before setting a fresh Goal and unwraps the response', async () => {
    const methods: string[] = []
    const turnInputs: unknown[] = []
    const goal = {
      threadId: 'thread-1',
      objective: '完成迁移',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const client = new FakeAppServerClient(async (method, params) => {
      methods.push(method)
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        turnInputs.push(...((params as { input: unknown[] }).input ?? []))
        return { turnId: 'turn-1' }
      }
      if (method === 'thread/goal/set') return { goal }
      throw new Error(`Unexpected request: ${method}`)
    })
    let appliedGoal: unknown
    const run = driverWithClient(client).start({
      messages: [userMessage([{ type: 'text', text: '原始可见目标文本' }])],
      modelId: 'test-model',
      goalFirstTurnObjective: goal.objective,
      goalContinuous: true,
      signal: new AbortController().signal,
      onSessionCreated: async (session) => {
        appliedGoal = await session.setThreadGoal({ objective: goal.objective, status: 'active' })
      }
    })
    const drained = drain(run.events).catch(() => undefined)

    const session = await run.session

    expect(methods).toEqual(['thread/start', 'turn/start', 'thread/goal/set'])
    expect(turnInputs).toEqual([
      {
        type: 'text',
        text: 'Begin working toward this long-running goal.\n\nGoal:\n完成迁移',
        text_elements: []
      }
    ])
    expect(session.turnId).toBe('turn-1')
    expect(appliedGoal).toEqual(goal)

    client.terminate(new Error('test complete'))
    await drained
  })
})

describe('NativeCodexRunDriver input cleanup', () => {
  it('removes inline image files when turn/start fails', async () => {
    let temporaryPath: string | undefined
    const client = new FakeAppServerClient(async (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' } }
      if (method === 'turn/start') {
        const inputs = (params as { input: Array<Record<string, unknown>> }).input
        temporaryPath = inputs.find((input) => input.type === 'localImage')?.path as
          | string
          | undefined
        throw new Error('turn start failed')
      }
      throw new Error(`Unexpected request: ${method}`)
    })
    const run = driverWithClient(client).start({
      messages: [
        userMessage([
          { type: 'text', text: 'inspect image' },
          {
            type: 'file',
            mediaType: 'image/png',
            url: 'data:image/png;base64,aW1hZ2U='
          }
        ])
      ],
      modelId: 'test-model',
      signal: new AbortController().signal
    })
    const drained = drain(run.events)

    await expect(run.session).rejects.toThrow('turn start failed')
    await expect(drained).rejects.toThrow('turn start failed')
    expect(temporaryPath).toBeTypeOf('string')
    await expect.poll(async () => fileExists(temporaryPath!)).toBe(false)
  })
})

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
