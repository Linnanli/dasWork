import { NoSuchModelError } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'

import { CODEX_PROVIDER_ID, codexCallOptions, CodexSteerError } from '../src'
import type { JsonRpcMessage } from '../src/client/transport'
import { CodexLanguageModel } from '../src/model'
import { createCodexAppServer } from '../src/provider'
import type { CodexSession } from '../src/session'
import { MockTransport } from './helpers/mock-transport'
import { planAssertionsForTest } from './helpers/plan-assertion'

class ScriptedTransport extends MockTransport {
  pauseTurnCompletion = false
  simulateSteerTurnRace = false
  failSteerTransport = false
  completeTurnBeforeSteerRejection = false
  steerError: {
    code: number
    message: string
    data?: unknown
  } | null = null
  private steerRequestCount = 0

  completeTurn(): void {
    this.emitMessage({
      method: 'item/completed',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        itemId: 'item_1',
        itemType: 'assistantMessage'
      }
    })
    this.emitMessage({
      method: 'turn/completed',
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        status: 'completed'
      }
    })
  }

  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    await super.sendMessage(message)

    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      return
    }

    if (message.method === 'initialize') {
      this.emitMessage({
        id: message.id,
        result: { serverInfo: { name: 'codex', version: 'test' } }
      })
      return
    }

    if (message.method === 'model/list') {
      this.emitMessage({
        id: message.id,
        result: {
          data: [
            {
              id: 'gpt-5.5',
              model: 'gpt-5.5',
              upgrade: null,
              displayName: 'GPT-5.3 Codex',
              description: 'Test model',
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Default' }],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              isDefault: true
            }
          ],
          nextCursor: null
        }
      })
      return
    }

    if (message.method === 'turn/interrupt') {
      this.emitMessage({ id: message.id, result: {} })
      return
    }

    if (message.method === 'thread/goal/get') {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: { goal: null } }))
      return
    }

    if (message.method === 'thread/goal/set') {
      const params = message.params as { objective?: string; status?: string }
      queueMicrotask(() => {
        this.emitMessage({
          id: message.id,
          result: {
            goal: {
              threadId: 'thr_1',
              objective: params.objective ?? '',
              status: params.status ?? 'active',
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1
            }
          }
        })
      })
      return
    }

    if (message.method === 'thread/goal/clear') {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: { cleared: true } }))
      return
    }

    if (message.method === 'turn/steer') {
      this.steerRequestCount++

      if (this.failSteerTransport) {
        throw new Error('transport closed')
      }

      if (this.simulateSteerTurnRace && this.steerRequestCount === 1) {
        this.emitMessage({
          method: 'turn/started',
          params: { threadId: 'thr_1', turn: { id: 'turn_2' } }
        })
        queueMicrotask(() => {
          this.emitMessage({
            id: message.id,
            error: {
              code: -32600,
              message: 'expected active turn id `turn_1` but found `turn_2`'
            }
          })
        })
        return
      }

      if (this.steerError) {
        if (this.completeTurnBeforeSteerRejection) {
          this.completeTurn()
        }
        this.emitMessage({ id: message.id, error: this.steerError })
        return
      }

      const params = message.params as { expectedTurnId?: string }
      this.emitMessage({
        id: message.id,
        result: { turnId: params.expectedTurnId ?? 'turn_1' }
      })
      return
    }

    if (message.method === 'thread/start') {
      this.emitMessage({ id: message.id, result: { threadId: 'thr_1' } })
      return
    }

    if (message.method === 'turn/start') {
      this.emitMessage({ id: message.id, result: { turnId: 'turn_1' } })

      queueMicrotask(() => {
        this.emitMessage({
          method: 'turn/started',
          params: { threadId: 'thr_1', turn: { id: 'turn_1' } }
        })
        this.emitMessage({
          method: 'item/started',
          params: {
            threadId: 'thr_1',
            turnId: 'turn_1',
            itemId: 'item_1',
            itemType: 'assistantMessage'
          }
        })
        this.emitMessage({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thr_1',
            turnId: 'turn_1',
            itemId: 'item_1',
            delta: 'ok'
          }
        })

        if (!this.pauseTurnCompletion) {
          this.completeTurn()
        }
      })
    }
  }
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader()
  const parts: unknown[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    parts.push(value)
  }

  return parts
}

describe('createCodexAppServer', () => {
  it('creates provider with v3 specification and language model factory', () => {
    const provider = createCodexAppServer({
      clientInfo: { name: 'test', version: '0.1.0' },
      experimentalApi: true
    })

    expect(provider.specificationVersion).toBe('v3')

    const model = provider.languageModel('gpt-5.5')
    expect(model).toBeInstanceOf(CodexLanguageModel)
    expect(model.specificationVersion).toBe('v3')
    expect(model.provider).toBe(CODEX_PROVIDER_ID)
    expect(model.modelId).toBe('gpt-5.5')
    expect(model.supportedUrls).toEqual({
      'image/*': [/^file:/],
      'application/vnd.dascowork.local-file': [/^file:/],
      'application/vnd.dascowork.local-folder': [/^file:/]
    })
  })

  it('supports callable provider and chat alias', () => {
    const provider = createCodexAppServer()

    const viaCall = provider('gpt-5.5')
    const viaChat = provider.chat('gpt-5.5')

    expect(viaCall).toBeInstanceOf(CodexLanguageModel)
    expect(viaChat).toBeInstanceOf(CodexLanguageModel)
  })

  it('starts a thread without starting a turn', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true,
      defaultThreadSettings: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write'
      }
    })

    const result = await provider.startThread({
      modelId: 'gpt-5.5',
      system: 'Be concise.',
      callOptions: {
        cwd: '/repo',
        runtimeWorkspaceRoots: ['/repo']
      }
    })

    expect(result).toEqual({ threadId: 'thr_1' })

    const methods = transport.sentMessages
      .filter((message) => 'method' in message)
      .map((message) => message.method)
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start'])

    const threadStart = transport.sentMessages.find(
      (message) => 'method' in message && message.method === 'thread/start'
    )
    expect(threadStart).toMatchObject({
      method: 'thread/start',
      params: {
        model: 'gpt-5.5',
        developerInstructions: 'Be concise.',
        cwd: '/repo',
        runtimeWorkspaceRoots: ['/repo'],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write'
      }
    })
  })

  it('throws NoSuchModelError for embedding and image models', () => {
    const provider = createCodexAppServer()

    expect(() => provider.embeddingModel('embed-model')).toThrowError(NoSuchModelError)
    expect(() => provider.imageModel('image-model')).toThrowError(NoSuchModelError)
  })

  it('uses separate persistent pools by default', async () => {
    const transports: ScriptedTransport[] = []
    let factoryCalls = 0
    const factory = () => {
      factoryCalls++
      const transport = new ScriptedTransport()
      transports.push(transport)
      return transport
    }

    const providerOne = createCodexAppServer({
      transportFactory: factory,
      persistent: { poolSize: 1 },
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })
    const providerTwo = createCodexAppServer({
      transportFactory: factory,
      persistent: { poolSize: 1 },
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    try {
      const modelOne = providerOne.languageModel('gpt-5.5')
      const modelTwo = providerTwo.languageModel('gpt-5.5')

      const { stream: streamOne } = await modelOne.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }]
      })
      await readAll(streamOne)

      const { stream: streamTwo } = await modelTwo.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }]
      })
      await readAll(streamTwo)

      const initializeCount = transports
        .flatMap((transport) => transport.sentMessages)
        .filter((msg) => 'method' in msg && msg.method === 'initialize').length

      expect(factoryCalls).toBe(2)
      expect(initializeCount).toBe(2)
    } finally {
      await providerOne.shutdown()
      await providerTwo.shutdown()
    }
  })

  it('shares a global persistent pool when configured', async () => {
    const transports: ScriptedTransport[] = []
    let factoryCalls = 0
    const factory = () => {
      factoryCalls++
      const transport = new ScriptedTransport()
      transports.push(transport)
      return transport
    }

    const providerOne = createCodexAppServer({
      transportFactory: factory,
      persistent: { scope: 'global', key: 'provider-test-shared', poolSize: 1 },
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })
    const providerTwo = createCodexAppServer({
      transportFactory: factory,
      persistent: { scope: 'global', key: 'provider-test-shared', poolSize: 1 },
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    try {
      const modelOne = providerOne.languageModel('gpt-5.5')
      const modelTwo = providerTwo.languageModel('gpt-5.5')

      const { stream: streamOne } = await modelOne.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }]
      })
      await readAll(streamOne)

      await providerOne.shutdown()

      const { stream: streamTwo } = await modelTwo.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'second' }] }]
      })
      await readAll(streamTwo)

      const initializeCount = transports
        .flatMap((transport) => transport.sentMessages)
        .filter((msg) => 'method' in msg && msg.method === 'initialize').length

      expect(factoryCalls).toBe(1)
      expect(initializeCount).toBe(1)
    } finally {
      await providerTwo.shutdown()
    }
  })

  it('listModels returns models via model/list RPC', async () => {
    const provider = createCodexAppServer({
      transportFactory: () => new ScriptedTransport(),
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const models = await provider.listModels()

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'gpt-5.5',
      displayName: 'GPT-5.3 Codex',
      isDefault: true,
      inputModalities: ['text', 'image']
    })
  })

  it('onSessionCreated provides active session with threadId and turnId', async () => {
    const transport = new ScriptedTransport()
    let capturedSession: CodexSession | null = null
    let wasActiveDuringCallback = false

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
        wasActiveDuringCallback = session.isActive()
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await readAll(stream)

    expect(capturedSession).not.toBeNull()
    expect(capturedSession!.threadId).toBe('thr_1')
    expect(capturedSession!.turnId).toBe('turn_1')
    expect(wasActiveDuringCallback).toBe(true)
  })

  it('session.injectMessage sends turn/start RPC to the live connection', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })

    // Wait for session to be created (turn/start completes in microtask)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(capturedSession).not.toBeNull()
    expect(capturedSession!.isActive()).toBe(true)

    await capturedSession!.injectMessage('Also add error handling')

    // injectMessage uses turn/start — the server routes it through steer_input
    // when a turn is active. Find the second turn/start (first is the initial turn).
    const turnStartMessages = transport.sentMessages.filter(
      (msg): msg is { method: string; params?: unknown } =>
        'method' in msg && msg.method === 'turn/start'
    )
    expect(turnStartMessages).toHaveLength(2)
    expect(turnStartMessages[1]?.params).toMatchObject({
      threadId: 'thr_1',
      input: [{ type: 'text', text: 'Also add error handling', text_elements: [] }]
    })

    // Complete the turn so the stream closes cleanly
    transport.completeTurn()
    await readAll(stream)
  })

  it('awaits Goal mutation on the session that created the first turn', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    let resolveSavedObjective!: (objective: string) => void
    const savedObjective = new Promise<string>((resolve) => {
      resolveSavedObjective = resolve
    })
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: async (session) => {
        if (!session.setThreadGoal) {
          throw new Error('Expected the provider session to support Goal mutations.')
        }
        const goal = await session.setThreadGoal({
          objective: 'finish the reference parity work',
          status: 'active'
        })
        resolveSavedObjective(goal.objective)
      }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'finish the reference parity work' }] }
      ]
    })
    const streamed = readAll(stream)
    await expect(savedObjective).resolves.toBe('finish the reference parity work')
    transport.emitMessage({
      method: 'thread/goal/cleared',
      params: { threadId: 'thr_1' }
    })
    transport.completeTurn()
    await streamed

    const methods = transport.sentMessages
      .filter((message): message is { method: string; params?: unknown } => 'method' in message)
      .map((message) => message.method)
    expect(methods).toContain('thread/start')
    expect(methods).toContain('turn/start')
    expect(methods).toContain('thread/goal/set')
    expect(methods.indexOf('turn/start')).toBeLessThan(methods.indexOf('thread/goal/set'))
  })

  it('per-call onSessionCreated takes precedence over the provider fallback', async () => {
    const transport = new ScriptedTransport()
    const fallbackCallback = vi.fn()
    const callCallback = vi.fn()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: fallbackCallback
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: codexCallOptions({ onSessionCreated: callCallback })
    })
    await readAll(stream)

    expect(callCallback).toHaveBeenCalledOnce()
    expect(callCallback.mock.calls[0]?.[0]).toMatchObject({
      threadId: 'thr_1',
      turnId: 'turn_1'
    })
    expect(fallbackCallback).not.toHaveBeenCalled()
  })

  it('session.steerPrompt maps the prompt and sends only turn/steer', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      providerOptions: codexCallOptions({
        onSessionCreated: (session) => {
          capturedSession = session
        }
      })
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(capturedSession).not.toBeNull()

    const turnStartCountBeforeSteer = transport.sentMessages.filter(
      (message) => 'method' in message && message.method === 'turn/start'
    ).length
    const result = await capturedSession!.steerPrompt(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Focus on the provider tests' },
            {
              type: 'file',
              mediaType: 'application/vnd.dascowork.local-file',
              data: new URL('file:///tmp/provider.ts'),
              filename: 'provider.ts'
            },
            {
              type: 'file',
              mediaType: 'image/png',
              data: new URL('https://example.test/screenshot.png')
            }
          ]
        }
      ],
      { clientUserMessageId: 'follow-up-1' }
    )

    expect(result).toEqual({ turnId: 'turn_1' })
    const steerMessages = transport.sentMessages.filter(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/steer'
    )
    expect(steerMessages).toHaveLength(1)
    const steerParams = steerMessages[0]?.params as {
      input: Array<{ type: string; text?: string; url?: string }>
    }
    expect(steerParams).toMatchObject({
      threadId: 'thr_1',
      clientUserMessageId: 'follow-up-1',
      expectedTurnId: 'turn_1',
      input: [
        {
          type: 'text',
          text_elements: []
        },
        { type: 'image', url: 'https://example.test/screenshot.png' }
      ]
    })
    expect(steerParams.input[0]?.text).toContain('/tmp/provider.ts')
    expect(
      transport.sentMessages.filter(
        (message) => 'method' in message && message.method === 'turn/start'
      )
    ).toHaveLength(turnStartCountBeforeSteer)

    transport.completeTurn()
    await readAll(stream)
  })

  it('B02 retries once with the latest turn id after an expected-turn mismatch', async () => {
    const assertB02 = planAssertionsForTest('B02')
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    transport.simulateSteerTurnRace = true
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const steerResult = await capturedSession!.steerPrompt(
      [{ role: 'user', content: [{ type: 'text', text: 'race' }] }],
      { clientUserMessageId: 'follow-up-race' }
    )

    const steerMessages = transport.sentMessages.filter(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/steer'
    )
    await assertB02('claim、接受与队列结算至多一次', () => expect(steerMessages).toHaveLength(2))
    await assertB02('正确的恢复、暂停或拒绝状态', () => {
      expect(steerResult).toEqual({ turnId: 'turn_2' })
      expect(
        steerMessages.map(
          (message) => (message.params as { expectedTurnId: string }).expectedTurnId
        )
      ).toEqual(['turn_1', 'turn_2'])
    })

    transport.completeTurn()
    await readAll(stream)
    await assertB02('terminal 和 active run 不被竞态覆盖', () =>
      expect(capturedSession!.isActive()).toBe(false)
    )
  })

  it('session.steerPrompt classifies unsupported active turns', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    transport.steerError = {
      code: -32600,
      message: 'cannot steer a review turn',
      data: {
        message: 'cannot steer a review turn',
        codexErrorInfo: {
          activeTurnNotSteerable: { turnKind: 'review' }
        },
        additionalDetails: null
      }
    }
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const error = await capturedSession!
      .steerPrompt([{ role: 'user', content: [{ type: 'text', text: 'review steer' }] }], {
        clientUserMessageId: 'follow-up-review'
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CodexSteerError)
    expect(error).toMatchObject({ code: 'unsupported_active_turn_kind' })

    transport.completeTurn()
    await readAll(stream)
  })

  it('session.steerPrompt surfaces the JSON-RPC rejection after turn completion marks the session inactive', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    transport.completeTurnBeforeSteerRejection = true
    transport.steerError = {
      code: -32042,
      message: 'server rejected steer'
    }
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(
      capturedSession!.steerPrompt(
        [{ role: 'user', content: [{ type: 'text', text: 'reject this steer' }] }],
        { clientUserMessageId: 'follow-up-rejected' }
      )
    ).rejects.toMatchObject({
      code: 'app_server_rejected',
      message: 'server rejected steer'
    })
    expect(
      transport.sentMessages.filter(
        (message) => 'method' in message && message.method === 'turn/steer'
      )
    ).toHaveLength(1)

    await readAll(stream)
  })

  it('session.steerPrompt marks transport failures as an unknown delivery result', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    transport.failSteerTransport = true
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const error = await capturedSession!
      .steerPrompt([{ role: 'user', content: [{ type: 'text', text: 'uncertain steer' }] }], {
        clientUserMessageId: 'follow-up-unknown'
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CodexSteerError)
    expect(error).toMatchObject({ code: 'steer_result_unknown' })

    transport.completeTurn()
    await readAll(stream)
  })

  it('session.interrupt sends turn/interrupt RPC to the live connection', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(capturedSession).not.toBeNull()

    await capturedSession!.interrupt()

    const interruptMessage = transport.sentMessages.find(
      (msg): msg is { method: string; params?: unknown } =>
        'method' in msg && msg.method === 'turn/interrupt'
    )
    expect(interruptMessage?.params).toMatchObject({
      threadId: 'thr_1',
      turnId: 'turn_1'
    })

    // Complete the turn so the stream closes cleanly
    transport.completeTurn()
    await readAll(stream)
  })

  it('session.interrupt sends at most one RPC for concurrent requests to the same turn', async () => {
    const transport = new ScriptedTransport()
    transport.pauseTurnCompletion = true
    let capturedSession: CodexSession | null = null

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })

    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await Promise.all([capturedSession!.interrupt(), capturedSession!.interrupt()])

    expect(
      transport.sentMessages.filter(
        (message) => 'method' in message && message.method === 'turn/interrupt'
      )
    ).toHaveLength(1)

    transport.completeTurn()
    await readAll(stream)
  })

  it('session.interrupt does not retry the same turn after an RPC rejection', async () => {
    class InterruptRejectingTransport extends ScriptedTransport {
      override async sendMessage(message: JsonRpcMessage): Promise<void> {
        if (
          'id' in message &&
          message.id !== undefined &&
          'method' in message &&
          message.method === 'turn/interrupt'
        ) {
          await MockTransport.prototype.sendMessage.call(this, message)
          this.emitMessage({
            id: message.id,
            error: { code: -32000, message: 'interrupt rejected' }
          })
          return
        }
        await super.sendMessage(message)
      }
    }

    const transport = new InterruptRejectingTransport()
    transport.pauseTurnCompletion = true
    let capturedSession: CodexSession | null = null
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        capturedSession = session
      }
    })
    const model = provider.languageModel('gpt-5.5')
    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(capturedSession!.interrupt()).rejects.toThrow('interrupt rejected')
    await expect(capturedSession!.interrupt()).rejects.toThrow('interrupt rejected')

    expect(
      transport.sentMessages.filter(
        (message) => 'method' in message && message.method === 'turn/interrupt'
      )
    ).toHaveLength(1)

    transport.completeTurn()
    await readAll(stream)
  })

  it('throws when reusing a global key with different pool settings', async () => {
    const providerOne = createCodexAppServer({
      transportFactory: () => new ScriptedTransport(),
      persistent: {
        scope: 'global',
        key: 'provider-test-mismatch',
        poolSize: 1,
        idleTimeoutMs: 60_000
      },
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    try {
      expect(() =>
        createCodexAppServer({
          transportFactory: () => new ScriptedTransport(),
          persistent: {
            scope: 'global',
            key: 'provider-test-mismatch',
            poolSize: 2,
            idleTimeoutMs: 60_000
          }
        })
      ).toThrow(/already exists with different settings/i)
    } finally {
      await providerOne.shutdown()
    }
  })
})
