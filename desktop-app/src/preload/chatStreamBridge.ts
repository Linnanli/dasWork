import type {
  CodexChatRequest,
  CodexChatRecoverySnapshot,
  CodexChatRunDescriptor,
  CodexChatStreamFailure,
  CodexChatTerminalFallback,
  CodexChatStreamCallbacks,
  CodexChatStreamEnvelope,
  CodexChatStreamEvent,
  DesktopCodexChatApi
} from '../shared/codexIpcApi'

type ActiveChatStream = {
  request: CodexChatRequest
  port: MessagePort
  abortRequested: boolean
  portFaulted: boolean
  fallbackTimer: ReturnType<typeof setTimeout> | undefined
  fallbackTerminal: CodexChatTerminalFallback['terminal'] | undefined
  runId: string | undefined
  lastSequence: number | undefined
  reconnectAttempted: boolean
}

export type ChatStreamBridgeDependencies = {
  createStreamId(): string
  createMessageChannel(): MessageChannel
  postStart(request: CodexChatRequest, streamId: string, port: MessagePort): void
  hasActiveRun?(conversationId: string): Promise<boolean>
  getActiveRun?(conversationId: string): Promise<CodexChatRunDescriptor | null>
  getActiveRuns?(): Promise<CodexChatRunDescriptor[]>
  getActiveSnapshot?(conversationId: string): Promise<CodexChatRecoverySnapshot | null>
  postAttach?(
    conversationId: string,
    streamId: string,
    port: MessagePort,
    runId?: string,
    afterSequence?: number
  ): void
  postDetached?(streamId: string, request: CodexChatRequest): void
  subscribeTerminal?(listener: (fallback: CodexChatTerminalFallback) => void): () => void
  scheduleTimeout?(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>
  clearTimeout?(timer: ReturnType<typeof setTimeout>): void
}

const MESSAGE_PORT_TERMINAL_TIMEOUT_MS = 1_000

export type ChatStreamBridge = DesktopCodexChatApi & {
  detachActiveStreams(): void
}

export function createChatStreamBridge(
  dependencies: ChatStreamBridgeDependencies
): ChatStreamBridge {
  const activeStreams = new Map<string, ActiveChatStream>()
  const callbacksByStreamId = new Map<string, CodexChatStreamCallbacks>()
  const scheduleTimeout = dependencies.scheduleTimeout ?? setTimeout
  const clearTimer = dependencies.clearTimeout ?? clearTimeout

  const closeStream = (streamId: string): ActiveChatStream | undefined => {
    const stream = activeStreams.get(streamId)
    if (!stream) return undefined
    activeStreams.delete(streamId)
    if (stream.fallbackTimer !== undefined) clearTimer(stream.fallbackTimer)
    stream.port.onmessage = null
    stream.port.onmessageerror = null
    stream.port.close()
    return stream
  }

  const detachFaultedPort = (stream: ActiveChatStream): void => {
    stream.port.onmessage = null
    stream.port.onmessageerror = null
    stream.port.close()
  }

  const dispatchTerminal = (
    streamId: string,
    terminal: CodexChatTerminalFallback['terminal'],
    callbacks: CodexChatStreamCallbacks
  ): void => {
    const stream = closeStream(streamId)
    if (!stream) return
    callbacksByStreamId.delete(streamId)
    switch (terminal.type) {
      case 'finish':
        callbacks.onFinish(terminal.threadId)
        return
      case 'aborted':
        callbacks.onAbort()
        return
      case 'error':
        callbacks.onError(terminal.error)
    }
  }

  const dispatchFailure = (
    streamId: string,
    failure: CodexChatStreamFailure,
    callbacks: CodexChatStreamCallbacks
  ): void => {
    dispatchTerminal(streamId, { type: 'error', error: failure }, callbacks)
  }

  const makeConnectionLostFailure = (): CodexChatStreamFailure => ({
    code: 'transport-unavailable',
    message: '任务连接暂时中断，正在自动重连。'
  })

  const makeRunUnavailableFailure = (): CodexChatStreamFailure => ({
    code: 'run-unavailable',
    message: '任务已不在运行，无法自动恢复。'
  })

  const makeJournalUnavailableFailure = (): CodexChatStreamFailure => ({
    code: 'journal-unavailable',
    message: '恢复日志已超出可补发范围，请等待任务结束后重新打开任务。'
  })

  const handleStreamMessage = (
    streamId: string,
    received: CodexChatStreamEnvelope | CodexChatStreamEvent,
    callbacks: CodexChatStreamCallbacks
  ): void => {
    const activeStream = activeStreams.get(streamId)
    if (!activeStream) return
    const message = unwrapStreamEvent(
      received,
      activeStream,
      streamId,
      callbacks,
      dispatchFailure,
      () => recoverAfterSequenceGap(streamId, activeStream, callbacks)
    )
    if (!message) return
    if (message.type === 'thread-bound') {
      if (!activeStream.abortRequested) callbacks.onThreadBound(message.threadId)
      activeStream.port.postMessage({ type: 'thread-bound-ack', threadId: message.threadId })
      return
    }
    if (message.type === 'turn-lifecycle') {
      callbacks.onTurnLifecycle?.(message.event)
      return
    }
    if (message.type === 'mode-applied') {
      callbacks.onModeApplied?.(message.threadId, message.modeKind)
      return
    }
    if (message.type === 'thread-goal') {
      callbacks.onThreadGoal?.(message.threadId, message.goal)
      return
    }
    if (message.type === 'chunk') {
      if (!activeStream.abortRequested) callbacks.onChunk(message.chunk)
      return
    }
    if (message.type === 'resync-required') {
      dispatchFailure(streamId, makeJournalUnavailableFailure(), callbacks)
      return
    }
    if (message.type === 'finish' || message.type === 'aborted' || message.type === 'error') {
      dispatchTerminal(streamId, message, callbacks)
    }
  }

  const unsubscribeTerminal = dependencies.subscribeTerminal?.((fallback) => {
    const stream = activeStreams.get(fallback.streamId)
    if (!stream) return
    const callbacks = callbacksByStreamId.get(fallback.streamId)
    if (!callbacks) return
    stream.fallbackTerminal = fallback.terminal
    if (stream.portFaulted) {
      dispatchTerminal(fallback.streamId, fallback.terminal, callbacks)
      return
    }
    if (stream.fallbackTimer !== undefined) return
    stream.fallbackTimer = scheduleTimeout(() => {
      dispatchTerminal(fallback.streamId, fallback.terminal, callbacks)
    }, MESSAGE_PORT_TERMINAL_TIMEOUT_MS)
  })
  // Keep the subscription alive for the preload process lifetime. This bridge
  // is created once, while per-stream callbacks are removed at terminal.
  void unsubscribeTerminal

  const reconnectAfterPortFailure = async (
    streamId: string,
    stream: ActiveChatStream,
    callbacks: CodexChatStreamCallbacks
  ): Promise<void> => {
    if (!dependencies.postAttach) return
    if (stream.reconnectAttempted) {
      dispatchFailure(streamId, makeConnectionLostFailure(), callbacks)
      return
    }
    stream.reconnectAttempted = true
    const conversationId =
      typeof stream.request.body?.conversationId === 'string'
        ? stream.request.body.conversationId
        : stream.request.chatId
    let activeRun: CodexChatRunDescriptor | null | undefined
    try {
      if (dependencies.getActiveRun) activeRun = await dependencies.getActiveRun(conversationId)
      else if (await dependencies.hasActiveRun?.(conversationId)) activeRun = undefined
      else activeRun = null
    } catch {
      dispatchFailure(streamId, makeConnectionLostFailure(), callbacks)
      return
    }
    if (activeRun === null) {
      dispatchFailure(streamId, makeRunUnavailableFailure(), callbacks)
      return
    }

    const channel = dependencies.createMessageChannel()
    stream.port = channel.port1
    stream.portFaulted = false
    stream.runId = activeRun?.runId ?? stream.runId
    channel.port1.onmessage = (
      event: MessageEvent<CodexChatStreamEnvelope | CodexChatStreamEvent>
    ) => {
      handleStreamMessage(streamId, event.data, callbacks)
    }
    channel.port1.onmessageerror = () => {
      const activeStream = activeStreams.get(streamId)
      if (!activeStream || activeStream.portFaulted) return
      activeStream.portFaulted = true
      detachFaultedPort(activeStream)
      if (activeStream.fallbackTerminal) {
        dispatchTerminal(streamId, activeStream.fallbackTerminal, callbacks)
        return
      }
      void reconnectAfterPortFailure(streamId, activeStream, callbacks)
    }
    try {
      dependencies.postAttach(
        conversationId,
        streamId,
        channel.port2,
        activeRun?.runId ?? stream.runId,
        stream.lastSequence ?? 0
      )
    } catch {
      dispatchFailure(streamId, makeConnectionLostFailure(), callbacks)
    }
  }

  const recoverAfterSequenceGap = (
    streamId: string,
    stream: ActiveChatStream,
    callbacks: CodexChatStreamCallbacks
  ): void => {
    if (stream.portFaulted) return
    stream.portFaulted = true
    detachFaultedPort(stream)
    if (stream.fallbackTerminal) {
      dispatchTerminal(streamId, stream.fallbackTerminal, callbacks)
      return
    }
    void reconnectAfterPortFailure(streamId, stream, callbacks)
  }

  return {
    startChatStream: (request, callbacks) => {
      const streamId = dependencies.createStreamId()
      const channel = dependencies.createMessageChannel()
      activeStreams.set(streamId, {
        request,
        port: channel.port1,
        abortRequested: false,
        portFaulted: false,
        fallbackTimer: undefined,
        fallbackTerminal: undefined,
        runId: undefined,
        lastSequence: undefined,
        reconnectAttempted: false
      })
      callbacksByStreamId.set(streamId, callbacks)
      channel.port1.onmessage = (
        event: MessageEvent<CodexChatStreamEnvelope | CodexChatStreamEvent>
      ) => {
        handleStreamMessage(streamId, event.data, callbacks)
      }
      channel.port1.onmessageerror = () => {
        const activeStream = activeStreams.get(streamId)
        if (!activeStream || activeStream.portFaulted) return
        activeStream.portFaulted = true
        detachFaultedPort(activeStream)
        if (activeStream.fallbackTerminal) {
          dispatchTerminal(streamId, activeStream.fallbackTerminal, callbacks)
          return
        }
        void reconnectAfterPortFailure(streamId, activeStream, callbacks)
      }
      dependencies.postStart(request, streamId, channel.port2)
      return streamId
    },
    abortChatStream: (streamId) => {
      const stream = activeStreams.get(streamId)
      if (!stream || stream.abortRequested) return
      stream.abortRequested = true
      stream.port.postMessage({ type: 'abort', ...(stream.runId ? { runId: stream.runId } : {}) })
    },
    getActiveRun: async (conversationId) => dependencies.getActiveRun?.(conversationId) ?? null,
    getActiveRuns: async () => dependencies.getActiveRuns?.() ?? [],
    getActiveSnapshot: async (conversationId) =>
      dependencies.getActiveSnapshot?.(conversationId) ?? null,
    attachChatStream: async (conversationId, callbacks) => {
      if (!dependencies.postAttach) return null
      let activeRun: CodexChatRunDescriptor | null | undefined
      if (dependencies.getActiveRun) {
        activeRun = await dependencies.getActiveRun(conversationId)
      } else if (await dependencies.hasActiveRun?.(conversationId)) {
        activeRun = undefined
      } else {
        activeRun = null
      }
      if (activeRun === null) return null
      const streamId = dependencies.createStreamId()
      const channel = dependencies.createMessageChannel()
      const request: CodexChatRequest = {
        chatId: conversationId,
        trigger: 'submit-message',
        messages: [],
        body: { conversationId }
      }
      const stream: ActiveChatStream = {
        request,
        port: channel.port1,
        abortRequested: false,
        portFaulted: false,
        fallbackTimer: undefined,
        fallbackTerminal: undefined,
        runId: activeRun?.runId,
        lastSequence: undefined,
        reconnectAttempted: false
      }
      activeStreams.set(streamId, stream)
      callbacksByStreamId.set(streamId, callbacks)
      channel.port1.onmessage = (
        event: MessageEvent<CodexChatStreamEnvelope | CodexChatStreamEvent>
      ) => {
        handleStreamMessage(streamId, event.data, callbacks)
      }
      channel.port1.onmessageerror = () => {
        const activeStream = activeStreams.get(streamId)
        if (!activeStream) return
        activeStream.portFaulted = true
        detachFaultedPort(activeStream)
        if (activeStream.fallbackTerminal) {
          dispatchTerminal(streamId, activeStream.fallbackTerminal, callbacks)
          return
        }
        void reconnectAfterPortFailure(streamId, activeStream, callbacks)
      }
      dependencies.postAttach(conversationId, streamId, channel.port2, activeRun?.runId, 0)
      return streamId
    },
    detachActiveStreams: () => {
      for (const [streamId, stream] of activeStreams) {
        dependencies.postDetached?.(streamId, stream.request)
        stream.port.close()
      }
      activeStreams.clear()
      callbacksByStreamId.clear()
    }
  }
}

function unwrapStreamEvent(
  received: CodexChatStreamEnvelope | CodexChatStreamEvent,
  stream: ActiveChatStream,
  streamId: string,
  callbacks: CodexChatStreamCallbacks,
  dispatchFailure: (
    streamId: string,
    failure: CodexChatStreamFailure,
    callbacks: CodexChatStreamCallbacks
  ) => void,
  onSequenceGap: () => void
): CodexChatStreamEvent | undefined {
  if (!('event' in received) || !('runId' in received) || !('sequence' in received)) return received
  if (stream.runId && stream.runId !== received.runId) {
    dispatchFailure(
      streamId,
      {
        code: 'run-mismatch',
        message: '恢复的数据流不属于当前任务，请重新打开任务。'
      },
      callbacks
    )
    return undefined
  }
  if (stream.lastSequence !== undefined) {
    if (received.sequence <= stream.lastSequence) return undefined
    if (received.sequence !== stream.lastSequence + 1) {
      onSequenceGap()
      return undefined
    }
  }
  stream.runId = received.runId
  stream.lastSequence = received.sequence
  return received.event
}
