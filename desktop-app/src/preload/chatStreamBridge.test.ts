import { describe, expect, it, vi } from 'vitest'

import { createVitestPlanAssertionRecorder } from '../../scripts/lib/test-plan-assertions.mjs'
import type {
  CodexChatRequest,
  CodexChatStreamCallbacks,
  CodexChatTerminalEvent,
  CodexChatStreamEvent
} from '../shared/codexIpcApi'
import { createChatStreamBridge } from './chatStreamBridge'

const { planAssert } = createVitestPlanAssertionRecorder(expect)

class FakeMessagePort {
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  peer: FakeMessagePort | undefined
  closed = false

  postMessage(message: unknown): void {
    this.peer?.onmessage?.({ data: message } as MessageEvent)
  }

  close(): void {
    this.closed = true
  }
}

function createFakeMessageChannel(): MessageChannel {
  const port1 = new FakeMessagePort()
  const port2 = new FakeMessagePort()
  port1.peer = port2
  port2.peer = port1
  return { port1, port2 } as unknown as MessageChannel
}

function createCallbacks(): CodexChatStreamCallbacks {
  return {
    onThreadBound: vi.fn(),
    onTurnLifecycle: vi.fn(),
    onChunk: vi.fn(),
    onFinish: vi.fn(),
    onAbort: vi.fn(),
    onError: vi.fn()
  }
}

function createRequest(chatId: string): CodexChatRequest {
  return {
    chatId,
    trigger: 'submit-message',
    messages: []
  }
}

describe('createChatStreamBridge', () => {
  it('exposes the main-owned active-run descriptor for local recovery', async () => {
    const descriptor = {
      runId: 'run-local',
      conversationId: 'local-conversation',
      runKind: 'single-turn',
      lastSequence: 2
    } as const
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: () => undefined,
      getActiveRun: async (conversationId) =>
        conversationId === descriptor.conversationId ? descriptor : null
    })

    await expect(bridge.getActiveRun?.('local-conversation')).resolves.toEqual(descriptor)
    await expect(bridge.getActiveRun?.('unknown-conversation')).resolves.toBeNull()
  })

  it('attaches a replacement port only when the main process reports a live turn', async () => {
    const attachedPorts: MessagePort[] = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'recovered-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: () => undefined,
      hasActiveRun: async (conversationId) => conversationId === 'thread-live',
      postAttach: (_conversationId, _streamId, port) => attachedPorts.push(port)
    })

    await expect(bridge.attachChatStream!('thread-missing', callbacks)).resolves.toBeNull()
    await expect(bridge.attachChatStream!('thread-live', callbacks)).resolves.toBe(
      'recovered-stream'
    )
    expect(attachedPorts).toHaveLength(1)

    attachedPorts[0].postMessage({ type: 'thread-bound', threadId: 'thread-live' })
    attachedPorts[0].postMessage({
      type: 'chunk',
      chunk: { type: 'text-start', id: 'replayed-text' }
    } satisfies CodexChatStreamEvent)

    expect(callbacks.onThreadBound).toHaveBeenCalledWith('thread-live')
    expect(callbacks.onChunk).toHaveBeenCalledWith({ type: 'text-start', id: 'replayed-text' })
  })

  it('forwards the sanitized applied mode acknowledgement', () => {
    const startedPorts: MessagePort[] = []
    const callbacks = createCallbacks()
    callbacks.onModeApplied = vi.fn()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'mode-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port)
    })

    bridge.startChatStream(createRequest('chat-mode'), callbacks)
    startedPorts[0].postMessage({
      type: 'mode-applied',
      threadId: 'thread-mode',
      modeKind: 'plan'
    } satisfies CodexChatStreamEvent)

    expect(callbacks.onModeApplied).toHaveBeenCalledWith('thread-mode', 'plan')
  })

  it('keeps an initial no-active-run attach as a normal null result', async () => {
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'recovered-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: () => undefined,
      getActiveRun: async () => null,
      postAttach: vi.fn()
    })

    await expect(bridge.attachChatStream!('thread-missing', callbacks)).resolves.toBeNull()

    expect(callbacks.onError).not.toHaveBeenCalled()
    expect(callbacks.onFinish).not.toHaveBeenCalled()
  })

  it('uses the main-issued run identity when attaching a replacement port', async () => {
    let attachedRunId: string | undefined
    const bridge = createChatStreamBridge({
      createStreamId: () => 'recovered-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: () => undefined,
      getActiveRun: async () => ({
        runId: 'run-current',
        conversationId: 'thread-live',
        runKind: 'single-turn',
        threadId: 'thread-live',
        lastSequence: 4
      }),
      postAttach: (_conversationId, _streamId, _port, runId) => {
        attachedRunId = runId
      }
    })

    await bridge.attachChatStream!('thread-live', createCallbacks())

    expect(attachedRunId).toBe('run-current')
  })

  it('deduplicates replayed envelopes and reattaches from the last acknowledged sequence gap', async () => {
    const startedPorts: MessagePort[] = []
    const attachedPorts: MessagePort[] = []
    const attached: Array<{ runId: string | undefined; afterSequence: number | undefined }> = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'sequenced-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port),
      getActiveRun: async () => ({
        runId: 'run-1',
        conversationId: 'chat-1',
        runKind: 'single-turn',
        lastSequence: 3
      }),
      postAttach: (_conversationId, _streamId, port, runId, afterSequence) => {
        attachedPorts.push(port)
        attached.push({ runId, afterSequence })
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    const port = startedPorts[0]
    const first = {
      runId: 'run-1',
      sequence: 1,
      event: { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } }
    } as const
    port.postMessage(first)
    port.postMessage(first)
    port.postMessage({
      runId: 'run-1',
      sequence: 3,
      event: { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', delta: 'lost' } }
    })
    await Promise.resolve()

    expect(attached).toEqual([{ runId: 'run-1', afterSequence: 1 }])
    attachedPorts[0].postMessage({
      runId: 'run-1',
      sequence: 2,
      event: { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', delta: 'replayed' } }
    })
    attachedPorts[0].postMessage({
      runId: 'run-1',
      sequence: 3,
      event: { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', delta: 'continued' } }
    })

    expect(callbacks.onChunk).toHaveBeenCalledTimes(3)
    expect(callbacks.onChunk).toHaveBeenLastCalledWith({
      type: 'text-delta',
      id: 'text-1',
      delta: 'continued'
    })
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('surfaces an explicit resync-required event instead of pretending the stream is contiguous', () => {
    const startedPorts: MessagePort[] = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'overflowed-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port)
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPorts[0].postMessage({
      runId: 'run-1',
      sequence: 24_001,
      event: { type: 'resync-required', reason: 'journal-overflow' }
    })

    expect(callbacks.onError).toHaveBeenCalledWith({
      code: 'journal-unavailable',
      message: '恢复日志已超出可补发范围，请等待任务结束后重新打开任务。'
    })
  })

  it('reattaches a failed MessagePort once from the last acknowledged sequence', async () => {
    const startedPorts: MessagePort[] = []
    const attachedPorts: MessagePort[] = []
    const attached: Array<{ runId: string | undefined; afterSequence: number | undefined }> = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'recovering-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port),
      getActiveRun: async () => ({
        runId: 'run-current',
        conversationId: 'chat-1',
        runKind: 'single-turn',
        lastSequence: 2
      }),
      postAttach: (_conversationId, _streamId, port, runId, afterSequence) => {
        attachedPorts.push(port)
        attached.push({ runId, afterSequence })
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPorts[0].postMessage({
      runId: 'run-current',
      sequence: 1,
      event: { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } }
    })
    ;(startedPorts[0] as unknown as FakeMessagePort).peer?.onmessageerror?.({} as MessageEvent)
    await Promise.resolve()

    expect(attached).toEqual([{ runId: 'run-current', afterSequence: 1 }])

    startedPorts[0].postMessage({
      runId: 'run-current',
      sequence: 2,
      event: { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', delta: 'late' } }
    })
    expect(callbacks.onChunk).toHaveBeenCalledTimes(1)

    attachedPorts[0].postMessage({
      runId: 'run-current',
      sequence: 2,
      event: { type: 'chunk', chunk: { type: 'text-delta', id: 'text-1', delta: 'replayed' } }
    })
    expect(callbacks.onChunk).toHaveBeenLastCalledWith({
      type: 'text-delta',
      id: 'text-1',
      delta: 'replayed'
    })
  })

  it('reports a typed recovery failure when a port-faulted active run has disappeared', async () => {
    const startedPorts: MessagePort[] = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'recovering-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port),
      getActiveRun: async () => null,
      postAttach: vi.fn()
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPorts[0].postMessage({
      runId: 'run-current',
      sequence: 1,
      event: { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } }
    })
    ;(startedPorts[0] as unknown as FakeMessagePort).peer?.onmessageerror?.({} as MessageEvent)
    await Promise.resolve()

    expect(callbacks.onChunk).toHaveBeenCalledWith({ type: 'text-start', id: 'text-1' })
    expect(callbacks.onError).toHaveBeenCalledWith({
      code: 'run-unavailable',
      message: '任务已不在运行，无法自动恢复。'
    })
    expect(callbacks.onFinish).not.toHaveBeenCalled()
  })

  it('reports a transient-safe failure when port reattachment throws', async () => {
    const startedPorts: MessagePort[] = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'recovering-stream',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port),
      getActiveRun: async () => ({
        runId: 'run-current',
        conversationId: 'chat-1',
        runKind: 'single-turn',
        lastSequence: 1
      }),
      postAttach: () => {
        throw new Error('electron IPC disconnected')
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPorts[0].postMessage({
      runId: 'run-current',
      sequence: 1,
      event: { type: 'chunk', chunk: { type: 'text-start', id: 'text-1' } }
    })
    ;(startedPorts[0] as unknown as FakeMessagePort).peer?.onmessageerror?.({} as MessageEvent)
    await Promise.resolve()

    expect(callbacks.onError).toHaveBeenCalledWith({
      code: 'transport-unavailable',
      message: '任务连接暂时中断，正在自动重连。'
    })
  })

  it('dispatches thread bindings and terminal events on their own message channels', () => {
    const startedPorts: MessagePort[] = []
    const controlMessages: unknown[] = []
    let nextId = 0
    const bridge = createChatStreamBridge({
      createStreamId: () => `stream-${++nextId}`,
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port)
    })
    const firstCallbacks = createCallbacks()
    const secondCallbacks = createCallbacks()

    bridge.startChatStream(createRequest('chat-1'), firstCallbacks)
    bridge.startChatStream(createRequest('chat-2'), secondCallbacks)
    ;(startedPorts[0] as unknown as FakeMessagePort).onmessage = (event) => {
      controlMessages.push(event.data)
    }
    startedPorts[0].postMessage({ type: 'thread-bound', threadId: 'thread-1' })
    startedPorts[1].postMessage({
      type: 'turn-lifecycle',
      event: {
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-2',
        turnId: 'turn-2'
      }
    } satisfies CodexChatStreamEvent)
    startedPorts[0].postMessage({ type: 'finish', threadId: 'thread-1' })
    startedPorts[1].postMessage({
      type: 'chunk',
      chunk: { type: 'text-start', id: 'text-2' }
    } satisfies CodexChatStreamEvent)

    expect(firstCallbacks.onThreadBound).toHaveBeenCalledWith('thread-1')
    expect(controlMessages).toContainEqual({
      type: 'thread-bound-ack',
      threadId: 'thread-1'
    })
    expect(firstCallbacks.onFinish).toHaveBeenCalledWith('thread-1')
    expect(secondCallbacks.onThreadBound).not.toHaveBeenCalled()
    expect(secondCallbacks.onTurnLifecycle).toHaveBeenCalledWith({
      type: 'turn-started',
      sequence: 1,
      threadId: 'thread-2',
      turnId: 'turn-2'
    })
    expect(secondCallbacks.onChunk).toHaveBeenCalledWith({ type: 'text-start', id: 'text-2' })
    expect((startedPorts[0] as unknown as FakeMessagePort).peer?.closed).toBe(true)
    expect((startedPorts[1] as unknown as FakeMessagePort).peer?.closed).toBe(false)
  })

  it('waits for the authoritative aborted event after requesting abort', () => {
    let startedPort: MessagePort | undefined
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      }
    })
    let abortMessages = 0

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    ;(startedPort as unknown as FakeMessagePort).onmessage = (event) => {
      if ((event.data as { type?: string }).type === 'abort') abortMessages += 1
    }
    bridge.abortChatStream('stream-1')
    bridge.abortChatStream('stream-1')

    expect(abortMessages).toBe(1)
    expect(callbacks.onAbort).not.toHaveBeenCalled()
    expect((startedPort as unknown as FakeMessagePort).peer?.closed).toBe(false)

    startedPort?.postMessage({ type: 'aborted' })

    expect(callbacks.onAbort).toHaveBeenCalledTimes(1)
    expect((startedPort as unknown as FakeMessagePort).peer?.closed).toBe(true)

    startedPort?.postMessage({ type: 'aborted' })

    expect(callbacks.onAbort).toHaveBeenCalledTimes(1)
  })

  it('reports every active stream before a renderer unload closes its ports', () => {
    const detached: Array<{ streamId: string; chatId: string }> = []
    let nextId = 0
    const bridge = createChatStreamBridge({
      createStreamId: () => `stream-${++nextId}`,
      createMessageChannel: createFakeMessageChannel,
      postStart: () => undefined,
      postDetached: (streamId, request) => detached.push({ streamId, chatId: request.chatId })
    })

    bridge.startChatStream(createRequest('chat-a'), createCallbacks())
    bridge.startChatStream(createRequest('chat-b'), createCallbacks())
    bridge.detachActiveStreams()

    expect(detached).toEqual([
      { streamId: 'stream-1', chatId: 'chat-a' },
      { streamId: 'stream-2', chatId: 'chat-b' }
    ])
  })

  it.each([
    {
      terminal: { type: 'finish', threadId: 'thread-1' } satisfies CodexChatStreamEvent,
      callback: 'onFinish' as const,
      expectedArgument: 'thread-1'
    },
    {
      terminal: { type: 'error', error: 'provider failed' } satisfies CodexChatStreamEvent,
      callback: 'onError' as const,
      expectedArgument: 'provider failed'
    }
  ])(
    'uses main $terminal.type as the terminal result when it races with abort',
    ({ terminal, callback, expectedArgument }) => {
      let startedPort: MessagePort | undefined
      const callbacks = createCallbacks()
      const bridge = createChatStreamBridge({
        createStreamId: () => 'stream-1',
        createMessageChannel: createFakeMessageChannel,
        postStart: (_request, _streamId, port) => {
          startedPort = port
        }
      })

      bridge.startChatStream(createRequest('chat-1'), callbacks)
      bridge.abortChatStream('stream-1')

      expect(callbacks.onAbort).not.toHaveBeenCalled()
      startedPort?.postMessage(terminal)

      expect(callbacks[callback]).toHaveBeenCalledWith(expectedArgument)
      expect(callbacks.onAbort).not.toHaveBeenCalled()
      expect((startedPort as unknown as FakeMessagePort).peer?.closed).toBe(true)
    }
  )

  it('keeps canonical lifecycle acknowledgements while suppressing render chunks after abort', () => {
    let startedPort: MessagePort | undefined
    const controlMessages: unknown[] = []
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    ;(startedPort as unknown as FakeMessagePort).onmessage = (event) => {
      controlMessages.push(event.data)
    }
    bridge.abortChatStream('stream-1')
    startedPort?.postMessage({ type: 'thread-bound', threadId: 'thread-1' })
    startedPort?.postMessage({
      type: 'turn-lifecycle',
      event: {
        type: 'item-completed',
        sequence: 4,
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'server-user-1',
        itemType: 'userMessage',
        clientUserMessageId: 'follow-up-1'
      }
    } satisfies CodexChatStreamEvent)
    startedPort?.postMessage({
      type: 'chunk',
      chunk: { type: 'text-start', id: 'text-1' }
    } satisfies CodexChatStreamEvent)

    expect(callbacks.onThreadBound).not.toHaveBeenCalled()
    expect(controlMessages).toContainEqual({
      type: 'thread-bound-ack',
      threadId: 'thread-1'
    })
    expect(callbacks.onTurnLifecycle).toHaveBeenCalledWith({
      type: 'item-completed',
      sequence: 4,
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'server-user-1',
      itemType: 'userMessage',
      clientUserMessageId: 'follow-up-1'
    })
    expect(callbacks.onChunk).not.toHaveBeenCalled()
    expect((startedPort as unknown as FakeMessagePort).peer?.closed).toBe(false)
  })

  it('removes a finished stream before invoking its callback', () => {
    let startedPort: MessagePort | undefined
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      }
    })
    vi.mocked(callbacks.onFinish).mockImplementation(() => bridge.abortChatStream('stream-1'))

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPort?.postMessage({ type: 'finish', threadId: 'thread-1' })

    expect(callbacks.onFinish).toHaveBeenCalledTimes(1)
    expect(callbacks.onAbort).not.toHaveBeenCalled()
  })

  it('keeps stopping streams open until main settles them, then releases them', () => {
    const startedPorts: MessagePort[] = []
    let nextId = 0
    const bridge = createChatStreamBridge({
      createStreamId: () => `stream-${++nextId}`,
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => startedPorts.push(port)
    })
    const callbacks = Array.from({ length: 12 }, () => createCallbacks())

    callbacks.forEach((streamCallbacks, index) => {
      bridge.startChatStream(createRequest(`chat-${index}`), streamCallbacks)
      bridge.abortChatStream(`stream-${index + 1}`)
    })

    expect(
      startedPorts.every((port) => (port as unknown as FakeMessagePort).peer?.closed === false)
    ).toBe(true)
    callbacks.forEach((streamCallbacks) => {
      expect(streamCallbacks.onAbort).not.toHaveBeenCalled()
    })

    startedPorts.forEach((port) => port.postMessage({ type: 'aborted' }))
    expect(
      startedPorts.every((port) => (port as unknown as FakeMessagePort).peer?.closed === true)
    ).toBe(true)
    callbacks.forEach((streamCallbacks) => {
      expect(streamCallbacks.onAbort).toHaveBeenCalledTimes(1)
    })
  })

  it('G11 finish-first ignores late aborted, error, and duplicate finish terminals', async () => {
    let startedPort: MessagePort | undefined
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPort?.postMessage({ type: 'finish', threadId: 'thread-first' })
    startedPort?.postMessage({ type: 'aborted' })
    startedPort?.postMessage({ type: 'error', error: 'late error' })
    startedPort?.postMessage({ type: 'finish', threadId: 'thread-duplicate' })

    expect(callbacks.onFinish).toHaveBeenCalledTimes(1)
    expect(callbacks.onFinish).toHaveBeenCalledWith('thread-first')
    expect(callbacks.onAbort).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    await planAssert({
      scenarioId: 'G11',
      assertionId: '错误、取消、完成竞态只进入单终态',
      assertion: () => expect(callbacks.onFinish).toHaveBeenCalledTimes(1)
    })
    await planAssert({
      scenarioId: 'G11',
      assertionId: '资源、并发和终态无残留',
      assertion: () => {
        expect(callbacks.onAbort).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
      }
    })
  })

  it('G11 aborted-first ignores late finish, error, and duplicate aborted terminals', async () => {
    let startedPort: MessagePort | undefined
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPort?.postMessage({ type: 'aborted' })
    startedPort?.postMessage({ type: 'finish', threadId: 'thread-late' })
    startedPort?.postMessage({ type: 'error', error: 'late error' })
    startedPort?.postMessage({ type: 'aborted' })

    expect(callbacks.onAbort).toHaveBeenCalledTimes(1)
    expect(callbacks.onFinish).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
    await planAssert({
      scenarioId: 'G11',
      assertionId: '错误、取消、完成竞态只进入单终态',
      assertion: () => expect(callbacks.onAbort).toHaveBeenCalledTimes(1)
    })
    await planAssert({
      scenarioId: 'G11',
      assertionId: '资源、并发和终态无残留',
      assertion: () => {
        expect(callbacks.onFinish).not.toHaveBeenCalled()
        expect(callbacks.onError).not.toHaveBeenCalled()
      }
    })
  })

  it('G11 error-first ignores late finish, aborted, and duplicate error terminals', async () => {
    let startedPort: MessagePort | undefined
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    startedPort?.postMessage({ type: 'error', error: 'first error' })
    startedPort?.postMessage({ type: 'finish', threadId: 'thread-late' })
    startedPort?.postMessage({ type: 'aborted' })
    startedPort?.postMessage({ type: 'error', error: 'duplicate error' })

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).toHaveBeenCalledWith('first error')
    expect(callbacks.onFinish).not.toHaveBeenCalled()
    expect(callbacks.onAbort).not.toHaveBeenCalled()
    await planAssert({
      scenarioId: 'G11',
      assertionId: '错误、取消、完成竞态只进入单终态',
      assertion: () => expect(callbacks.onError).toHaveBeenCalledTimes(1)
    })
    await planAssert({
      scenarioId: 'G11',
      assertionId: '资源、并发和终态无残留',
      assertion: () => {
        expect(callbacks.onFinish).not.toHaveBeenCalled()
        expect(callbacks.onAbort).not.toHaveBeenCalled()
      }
    })
  })

  it('C22/G11 uses the IPC terminal fallback exactly once after the MessagePort fails', async () => {
    let startedPort: MessagePort | undefined
    let terminalListener:
      ((fallback: { streamId: string; terminal: CodexChatTerminalEvent }) => void) | undefined
    const callbacks = createCallbacks()
    const bridge = createChatStreamBridge({
      createStreamId: () => 'stream-1',
      createMessageChannel: createFakeMessageChannel,
      postStart: (_request, _streamId, port) => {
        startedPort = port
      },
      subscribeTerminal: (listener) => {
        terminalListener = listener
        return () => undefined
      }
    })

    bridge.startChatStream(createRequest('chat-1'), callbacks)
    ;(startedPort as unknown as FakeMessagePort).peer?.onmessageerror?.({} as MessageEvent)
    terminalListener?.({
      streamId: 'stream-1',
      terminal: { type: 'error', error: 'The chat connection was interrupted before completion.' }
    })
    startedPort?.postMessage({ type: 'aborted' })

    expect(callbacks.onError).toHaveBeenCalledTimes(1)
    expect(callbacks.onError).toHaveBeenCalledWith(
      'The chat connection was interrupted before completion.'
    )
    expect(callbacks.onAbort).not.toHaveBeenCalled()
    await planAssert({
      scenarioId: 'C22',
      assertionId: '保留可见内容并显示单一终态',
      assertion: () =>
        expect(callbacks.onError).toHaveBeenCalledWith(
          'The chat connection was interrupted before completion.'
        )
    })
    await planAssert({
      scenarioId: 'C22',
      assertionId: 'terminal 只结算一次且 Composer 恢复',
      assertion: () => expect(callbacks.onError).toHaveBeenCalledTimes(1)
    })
    await planAssert({
      scenarioId: 'C22',
      assertionId: '无自动重试、额外请求或迟到事件应用',
      assertion: () => expect(callbacks.onAbort).not.toHaveBeenCalled()
    })
  })

  it('C22 lets a healthy MessagePort drain chunks and its terminal before a fallback terminal', () => {
    vi.useFakeTimers()
    try {
      let startedPort: MessagePort | undefined
      let terminalListener:
        ((fallback: { streamId: string; terminal: CodexChatTerminalEvent }) => void) | undefined
      const callbacks = createCallbacks()
      const bridge = createChatStreamBridge({
        createStreamId: () => 'stream-1',
        createMessageChannel: createFakeMessageChannel,
        postStart: (_request, _streamId, port) => {
          startedPort = port
        },
        subscribeTerminal: (listener) => {
          terminalListener = listener
          return () => undefined
        }
      })

      bridge.startChatStream(createRequest('chat-1'), callbacks)
      terminalListener?.({
        streamId: 'stream-1',
        terminal: { type: 'finish', threadId: 'thread-1' }
      })
      startedPort?.postMessage({
        type: 'chunk',
        chunk: { type: 'text-start', id: 'text-1' }
      } satisfies CodexChatStreamEvent)
      startedPort?.postMessage({ type: 'finish', threadId: 'thread-1' })
      vi.advanceTimersByTime(1_000)

      expect(callbacks.onChunk).toHaveBeenCalledWith({ type: 'text-start', id: 'text-1' })
      expect(callbacks.onFinish).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('C22 waits for the canonical IPC terminal after a broken MessagePort', async () => {
    vi.useFakeTimers()
    try {
      let startedPort: MessagePort | undefined
      let terminalListener:
        ((fallback: { streamId: string; terminal: CodexChatTerminalEvent }) => void) | undefined
      const callbacks = createCallbacks()
      const bridge = createChatStreamBridge({
        createStreamId: () => 'stream-1',
        createMessageChannel: createFakeMessageChannel,
        postStart: (_request, _streamId, port) => {
          startedPort = port
        },
        subscribeTerminal: (listener) => {
          terminalListener = listener
          return () => undefined
        }
      })

      bridge.startChatStream(createRequest('chat-1'), callbacks)
      ;(startedPort as unknown as FakeMessagePort).peer?.onmessageerror?.({} as MessageEvent)
      vi.advanceTimersByTime(1_000)
      expect(callbacks.onError).not.toHaveBeenCalled()
      terminalListener?.({
        streamId: 'stream-1',
        terminal: { type: 'finish', threadId: 'thread-1' }
      })

      expect(callbacks.onFinish).toHaveBeenCalledTimes(1)
      expect(callbacks.onFinish).toHaveBeenCalledWith('thread-1')
      await planAssert({
        scenarioId: 'C22',
        assertionId: '保留可见内容并显示单一终态',
        assertion: () => expect(callbacks.onFinish).toHaveBeenCalledWith('thread-1')
      })
      await planAssert({
        scenarioId: 'C22',
        assertionId: 'terminal 只结算一次且 Composer 恢复',
        assertion: () => expect(callbacks.onFinish).toHaveBeenCalledTimes(1)
      })
      await planAssert({
        scenarioId: 'C22',
        assertionId: '无自动重试、额外请求或迟到事件应用',
        assertion: () => expect(callbacks.onError).not.toHaveBeenCalled()
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
