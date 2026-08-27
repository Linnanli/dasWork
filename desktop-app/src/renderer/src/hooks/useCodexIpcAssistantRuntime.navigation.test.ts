// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  CodexChatStreamCallbacks,
  DesktopCodexChatApi,
  SidebarConversationOpenResult
} from '../../../shared/codexIpcApi'
import {
  useCodexIpcAssistantRuntime,
  type CodexIpcAssistantRuntimeState
} from './useCodexIpcAssistantRuntime'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('useCodexIpcAssistantRuntime conversation navigation', () => {
  let container: HTMLDivElement
  let root: Root
  let runtimeState: CodexIpcAssistantRuntimeState | null
  let streamCallbacks: Map<string, CodexChatStreamCallbacks>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    runtimeState = null
    streamCallbacks = new Map()
    window.localStorage.clear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('keeps the last requested conversation when open responses finish out of order', async () => {
    const firstOpen = deferred<SidebarConversationOpenResult>()
    const secondOpen = deferred<SidebarConversationOpenResult>()
    const openConversation = vi
      .fn()
      .mockReturnValueOnce(firstOpen.promise)
      .mockReturnValueOnce(secondOpen.promise)
    installDesktopApp(openConversation)
    await renderProbe()

    let firstRequest!: Promise<void>
    let secondRequest!: Promise<void>
    await act(async () => {
      firstRequest = runtimeState!.openConversation({ conversationId: 'first' })
      secondRequest = runtimeState!.openConversation({ conversationId: 'second' })
    })
    expect(runtimeState?.activeEntry.localId).toBe('second')

    await act(async () => {
      secondOpen.resolve(openResult('second'))
      await secondRequest
      firstOpen.resolve(openResult('first'))
      await firstRequest
    })

    expect(runtimeState?.activeConversation?.conversationId).toBe('second')
    expect(runtimeState?.activeEntry.messages.map((message) => message.renderId)).toEqual([
      'message:message-second'
    ])
  })

  it('does not reopen a pending conversation after starting a new one', async () => {
    const pendingOpen = deferred<SidebarConversationOpenResult>()
    installDesktopApp(vi.fn(() => pendingOpen.promise))
    await renderProbe()

    let openRequest!: Promise<void>
    await act(async () => {
      openRequest = runtimeState!.openConversation({ conversationId: 'pending' })
      runtimeState!.startNewConversation()
    })
    const newEntryId = runtimeState!.activeEntry.localId
    await act(async () => {
      pendingOpen.resolve(openResult('pending'))
      await openRequest
    })

    expect(runtimeState?.activeEntry.localId).toBe(newEntryId)
    expect(runtimeState?.activeConversation).toBeUndefined()
  })

  it('opens another conversation while the current response keeps streaming in the background', async () => {
    const openConversation = vi.fn(async () => openResult('other'))
    installDesktopApp(openConversation)
    await renderProbe()
    const backgroundEntry = runtimeState!.activeEntry

    await act(async () => {
      await backgroundEntry.transport.sendMessages({
        chatId: backgroundEntry.controller.id,
        trigger: 'submit-message',
        messageId: undefined,
        messages: [],
        abortSignal: undefined
      })
    })
    expect(backgroundEntry.status).toBe('submitted')

    await act(async () => {
      await runtimeState!.openConversation({ conversationId: 'other' })
    })
    await act(async () => {
      streamCallbacks
        .get(backgroundEntry.controller.id)
        ?.onChunk({ type: 'text-start', id: 'text-a' })
    })

    expect(runtimeState?.activeConversation?.conversationId).toBe('other')
    expect(backgroundEntry.status).toBe('streaming')
    expect(backgroundEntry.unread).toBe(true)
  })

  it('starts a new conversation without stopping the background entry', async () => {
    installDesktopApp(vi.fn())
    await renderProbe()
    const backgroundEntry = runtimeState!.activeEntry
    await act(async () => {
      await backgroundEntry.transport.sendMessages({
        chatId: backgroundEntry.controller.id,
        trigger: 'submit-message',
        messageId: undefined,
        messages: [],
        abortSignal: undefined
      })
      runtimeState!.startNewConversation()
    })

    expect(runtimeState?.activeEntry).not.toBe(backgroundEntry)
    expect(backgroundEntry.status).toBe('submitted')
  })

  it('starts a fresh conversation with a plugin prompt draft and no inherited attachments', async () => {
    installDesktopApp(vi.fn())
    await renderProbe()
    const previousEntry = runtimeState!.activeEntry
    await act(async () => {
      runtimeState!.setActiveDraft('Keep this older draft')
      runtimeState!.setActiveDraftAttachments([
        {
          kind: 'file',
          fileUrl: 'file:///tmp/old.txt',
          label: 'old.txt',
          path: '/tmp/old.txt'
        }
      ])
      runtimeState!.startNewConversationWithDraft(
        '@plugin://marketplace:personal/github Review the current pull request'
      )
    })

    expect(runtimeState?.activeEntry).not.toBe(previousEntry)
    expect(runtimeState?.activeEntry.draft).toBe(
      '@plugin://marketplace:personal/github Review the current pull request'
    )
    expect(runtimeState?.activeEntry.draftAttachments).toEqual([])
    expect(previousEntry.draft).toBe('Keep this older draft')
  })

  it('reuses the local transcript controller when the bound thread is opened from the sidebar', async () => {
    const openConversation = vi.fn(async () => openResult('thread-real'))
    installDesktopApp(openConversation)
    await renderProbe()
    const entry = runtimeState!.activeEntry
    await act(async () => {
      await entry.transport.sendMessages({
        chatId: entry.controller.id,
        trigger: 'submit-message',
        messageId: undefined,
        messages: [],
        abortSignal: undefined
      })
      streamCallbacks.get(entry.controller.id)?.onThreadBound('thread-real')
      await runtimeState!.openConversation({ conversationId: 'thread-real' })
    })

    expect(runtimeState?.activeEntry).toBe(entry)
    expect(openConversation).not.toHaveBeenCalled()
  })

  it('keeps an asynchronous model selection failure on the entry that started it', async () => {
    const modelSelection = deferred<{ selectedModelId: string }>()
    installDesktopApp(vi.fn(), () => modelSelection.promise)
    await renderProbe()
    const firstEntry = runtimeState!.activeEntry

    let selectionRequest!: Promise<void>
    await act(async () => {
      selectionRequest = runtimeState!.setSelectedModelId('unavailable-model')
      runtimeState!.startNewConversation()
    })
    await act(async () => {
      modelSelection.reject(new Error('model catalog unavailable'))
      await expect(selectionRequest).rejects.toThrow('model catalog unavailable')
    })

    expect(firstEntry.modelSelectionError).toBe('model catalog unavailable')
    expect(runtimeState?.activeEntry.modelSelectionError).toBeUndefined()
  })

  async function renderProbe(): Promise<void> {
    await act(async () => {
      root.render(createElement(Probe, { onState: (state) => (runtimeState = state) }))
    })
  }

  function installDesktopApp(
    openConversation: (input: { conversationId: string }) => Promise<SidebarConversationOpenResult>,
    setSelectedModel: (modelId: string) => Promise<{ selectedModelId: string }> = async (
      modelId
    ) => ({ selectedModelId: modelId })
  ): void {
    const chatBridge: DesktopCodexChatApi = {
      startChatStream: vi.fn((request, callbacks) => {
        streamCallbacks.set(request.chatId, callbacks)
        return `stream-${request.chatId}`
      }),
      abortChatStream: vi.fn()
    }
    vi.stubGlobal('desktopApp', {
      codex: {
        listModels: vi.fn(async () => ({ models: [] })),
        setSelectedModel: vi.fn(setSelectedModel),
        respondApproval: vi.fn(async () => undefined),
        onApprovalRequest: vi.fn(() => vi.fn())
      },
      chat: chatBridge,
      conversations: { openConversation }
    })
  }
})

function Probe({ onState }: { onState: (state: CodexIpcAssistantRuntimeState) => void }): null {
  const state = useCodexIpcAssistantRuntime()
  useEffect(() => {
    onState(state)
  }, [onState, state])
  return null
}

function openResult(conversationId: string): SidebarConversationOpenResult {
  return {
    conversationId,
    threadId: `thread-${conversationId}`,
    title: conversationId,
    messages: [
      {
        id: `message-${conversationId}`,
        role: 'user',
        parts: [{ type: 'text', text: conversationId }]
      }
    ]
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}
