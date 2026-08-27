import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'

import type {
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexModelList,
  SidebarConversation,
  SidebarConversationActionPayload,
  ThreadGoalSummary
} from '../../../shared/codexIpcApi'
import type { ProjectSelection } from '../../../shared/projects/projectTypes'
import type { ModelOption } from '../components/assistant-ui'
import {
  ConversationChatRegistry,
  type ConversationChatEntry,
  type ConversationScrollSnapshot
} from '../runtime/ConversationChatRegistry'
import type {
  ConversationApprovalModeKind,
  ConversationComposerModeKind,
  ConversationDraftAttachment
} from '../runtime/ConversationDraftStore'
import type { ActiveConversationContext } from '../lib/ElectronIpcChatTransport'
import { ConversationRuntimeIndicatorStore } from '../runtime/ConversationRuntimeIndicatorStore'
import { useConversationFollowUpCoordinator } from './useConversationFollowUpCoordinator'

export type CodexIpcAssistantRuntimeState = {
  activeEntry: ConversationChatEntry
  activeConversation: ActiveConversationContext | undefined
  activeServerRequests: readonly CodexApprovalRequest[]
  serverRequests: readonly CodexApprovalRequest[]
  models: readonly ModelOption[]
  selectedModelId: string | undefined
  modelSelectionError: string | undefined
  startNewConversation: (projectSelection?: ProjectSelection) => ConversationChatEntry
  startNewConversationWithDraft: (
    draft: string,
    projectSelection?: ProjectSelection
  ) => ConversationChatEntry
  prepareNewConversation: (projectSelection?: ProjectSelection) => ConversationChatEntry
  activateConversation: (entry: ConversationChatEntry) => void
  restoreActiveConversation: (conversationId: string) => Promise<boolean>
  restoreSingleActiveConversation: () => Promise<boolean>
  openConversation: (input: SidebarConversationActionPayload) => Promise<void>
  setSelectedModelId: (modelId: string) => Promise<void>
  setActiveProjectSelection: (selection: ProjectSelection | undefined) => void
  setActiveDraft: (draft: string) => void
  setActiveDraftAttachments: (attachments: readonly ConversationDraftAttachment[]) => void
  setActiveComposerModeKind: (composerModeKind: ConversationComposerModeKind) => void
  setActiveApprovalModeKind: (approvalModeKind: ConversationApprovalModeKind) => void
  setActiveGoalEditorActive: (goalEditorActive: boolean) => void
  setActiveThreadGoal: (threadGoal: ThreadGoalSummary | null | undefined) => void
  setActiveGoalOperation: (
    goalOperation: ConversationChatEntry['goalOperation'],
    goalError?: string
  ) => void
  setActiveScroll: (scroll: ConversationScrollSnapshot) => void
  syncConversationMetadata: (conversations: readonly SidebarConversation[]) => void
  conversationIndicators: ConversationRuntimeIndicatorStore
  getConversationTitle: (threadId: string | undefined) => string | undefined
  respondToServerRequest: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponse
  ) => Promise<void>
  rejectServerRequest: (request: CodexApprovalRequest) => Promise<void>
  snoozeServerRequest: (request: CodexApprovalRequest) => Promise<void>
}

export type CodexIpcAssistantRuntimeOptions = {
  projectSelection?: ProjectSelection
}

const activeConversationStorageKey = 'das-cowork.active-conversation.v1'

function persistActiveConversationId(conversationId: string): void {
  try {
    window.sessionStorage.setItem(activeConversationStorageKey, conversationId)
  } catch {
    // Session storage only improves renderer recovery; the main process owns the run.
  }
}

export function useCodexIpcAssistantRuntime(
  options: CodexIpcAssistantRuntimeOptions = {}
): CodexIpcAssistantRuntimeState {
  const [serverRequests, setServerRequests] = useState<CodexApprovalRequest[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModelId, setSelectedModelIdState] = useState<string | undefined>()

  const [registry] = useState(
    () =>
      new ConversationChatRegistry({
        chatBridge: window.desktopApp.chat,
        selectedModelId,
        onStreamStarted: persistActiveConversationId,
        loadThreadGoal: (threadId) =>
          window.desktopApp.conversations.getConversationGoal({ conversationId: threadId })
      })
  )
  const [conversationIndicators] = useState(() => new ConversationRuntimeIndicatorStore(registry))
  const registrySnapshot = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  )
  useConversationFollowUpCoordinator(
    registrySnapshot.entries,
    window.desktopApp.followUps as typeof window.desktopApp.followUps | undefined
  )

  useLayoutEffect(() => {
    conversationIndicators.setAttentionThreadIds(
      new Set(
        serverRequests.flatMap((request) =>
          request.context?.threadId ? [request.context.threadId] : []
        )
      )
    )
  }, [conversationIndicators, serverRequests])
  const activeEntry = registrySnapshot.activeEntry
  const activeConversation =
    activeEntry.newConversation && !activeEntry.context.threadId ? undefined : activeEntry.context

  const setActiveProjectSelection = useCallback(
    (selection: ProjectSelection | undefined) => registry.updateActiveProjectSelection(selection),
    [registry]
  )

  useLayoutEffect(() => {
    setActiveProjectSelection(options.projectSelection)
  }, [options.projectSelection, setActiveProjectSelection])

  useEffect(() => {
    let cancelled = false
    void window.desktopApp.codex.listModels().then((list) => {
      if (cancelled) return
      setModels(toModelOptions(list))
      setSelectedModelIdState(list.selectedModelId)
      registry.applyDefaultModel(list.selectedModelId)
    })
    const removeApproval = window.desktopApp.codex.onApprovalRequest((request) => {
      registry.markUnreadByThread(request.context?.threadId)
      setServerRequests((current) => {
        if (current.some((item) => item.id === request.id)) return current
        return [...current, request]
      })
    })
    const removeSettledApproval = window.desktopApp.codex.onApprovalSettled?.((requestId) => {
      setServerRequests((current) => current.filter((item) => item.id !== requestId))
    })
    void window.desktopApp.codex.listPendingApprovals?.().then((requests) => {
      if (cancelled) return
      setServerRequests((current) => {
        const known = new Set(current.map((request) => request.id))
        return [...current, ...requests.filter((request) => !known.has(request.id))]
      })
    })

    return () => {
      cancelled = true
      removeApproval()
      removeSettledApproval?.()
    }
  }, [registry])

  useEffect(() => {
    void registry.restoreSingleActiveConversation().catch(() => undefined)
    const retryTimer = window.setTimeout(() => {
      void registry.restoreSingleActiveConversation().catch(() => undefined)
    }, 250)
    return () => window.clearTimeout(retryTimer)
  }, [registry])

  useEffect(() => {
    const destroyRegistry = (): void => {
      conversationIndicators.destroy()
      registry.destroy()
    }
    window.addEventListener('beforeunload', destroyRegistry)
    return () => window.removeEventListener('beforeunload', destroyRegistry)
  }, [conversationIndicators, registry])

  const openConversation = useCallback(
    async (input: SidebarConversationActionPayload) => {
      await registry.openConversation(input.conversationId, () =>
        window.desktopApp.conversations.openConversation(input)
      )
    },
    [registry]
  )

  const startNewConversation = useCallback(
    (projectSelection?: ProjectSelection) =>
      registry.startNewConversation(projectSelection ?? options.projectSelection),
    [options.projectSelection, registry]
  )
  const startNewConversationWithDraft = useCallback(
    (draft: string, projectSelection?: ProjectSelection) => {
      const entry = registry.startNewConversation(projectSelection ?? options.projectSelection)
      registry.setDraft(entry, draft)
      registry.setDraftAttachments(entry, [])
      return entry
    },
    [options.projectSelection, registry]
  )
  const prepareNewConversation = useCallback(
    (projectSelection?: ProjectSelection) =>
      registry.prepareNewConversation(projectSelection ?? options.projectSelection),
    [options.projectSelection, registry]
  )
  const activateConversation = useCallback(
    (entry: ConversationChatEntry) => registry.activateConversation(entry),
    [registry]
  )

  const restoreActiveConversation = useCallback(
    (conversationId: string) => registry.restoreActiveConversation(conversationId),
    [registry]
  )
  const restoreSingleActiveConversation = useCallback(
    () => registry.restoreSingleActiveConversation(),
    [registry]
  )

  const setSelectedModelId = useCallback(
    async (modelId: string) => {
      const targetEntry = activeEntry
      try {
        const response = await window.desktopApp.codex.setSelectedModel(modelId)
        setSelectedModelIdState(response.selectedModelId)
        registry.applyDefaultModel(response.selectedModelId)
        registry.setSelectedModel(targetEntry, response.selectedModelId)
      } catch (error) {
        registry.setModelSelectionError(targetEntry, errorMessage(error))
        throw error
      }
    },
    [activeEntry, registry]
  )

  const setActiveDraft = useCallback(
    (draft: string) => registry.setDraft(activeEntry, draft),
    [activeEntry, registry]
  )
  const setActiveDraftAttachments = useCallback(
    (attachments: readonly ConversationDraftAttachment[]) =>
      registry.setDraftAttachments(activeEntry, attachments),
    [activeEntry, registry]
  )
  const setActiveComposerModeKind = useCallback(
    (composerModeKind: ConversationComposerModeKind) =>
      registry.setComposerModeKind(activeEntry, composerModeKind),
    [activeEntry, registry]
  )
  const setActiveApprovalModeKind = useCallback(
    (approvalModeKind: ConversationApprovalModeKind) =>
      registry.setApprovalModeKind(activeEntry, approvalModeKind),
    [activeEntry, registry]
  )
  const setActiveGoalEditorActive = useCallback(
    (goalEditorActive: boolean) => registry.setGoalEditorActive(activeEntry, goalEditorActive),
    [activeEntry, registry]
  )
  const setActiveThreadGoal = useCallback(
    (threadGoal: ThreadGoalSummary | null | undefined) =>
      registry.setThreadGoal(activeEntry, threadGoal),
    [activeEntry, registry]
  )
  const setActiveGoalOperation = useCallback(
    (goalOperation: ConversationChatEntry['goalOperation'], goalError?: string) =>
      registry.setGoalOperation(activeEntry, goalOperation, goalError),
    [activeEntry, registry]
  )
  const setActiveScroll = useCallback(
    (scroll: ConversationScrollSnapshot) => registry.setScroll(activeEntry, scroll),
    [activeEntry, registry]
  )

  const syncConversationMetadata = useCallback(
    (conversations: readonly SidebarConversation[]) =>
      registry.applyConversationMetadata(conversations),
    [registry]
  )

  const getConversationTitle = useCallback(
    (threadId: string | undefined): string | undefined => {
      void registrySnapshot.version
      if (!threadId) return undefined
      return registry.resolve(threadId)?.context.title ?? undefined
    },
    [registry, registrySnapshot]
  )

  const respondToServerRequest = useCallback(
    async (request: CodexApprovalRequest, response: CodexApprovalResponse) => {
      await window.desktopApp.codex.respondApproval(request.id, response)
      setServerRequests((current) => current.filter((item) => item.id !== request.id))
    },
    []
  )

  const rejectServerRequest = useCallback(async (request: CodexApprovalRequest) => {
    await window.desktopApp.codex.respondApproval(request.id, {
      action: 'decline',
      reason: 'Rejected from desktop UI'
    })
    setServerRequests((current) => current.filter((item) => item.id !== request.id))
  }, [])

  const snoozeServerRequest = useCallback(async (request: CodexApprovalRequest) => {
    if (request.kind !== 'tool-user-input') return
    const snooze = window.desktopApp.codex.snoozeApprovalAutoResolution
    if (!snooze) return
    if (!(await snooze(request.id))) return
    setServerRequests((current) =>
      current.map((item) =>
        item.id === request.id && item.kind === 'tool-user-input'
          ? {
              ...item,
              params: { ...item.params, autoResolutionSnoozed: true }
            }
          : item
      )
    )
  }, [])

  const activeThreadId = activeEntry.context.threadId
  const activeServerRequests = activeThreadId
    ? serverRequests.filter((request) => request.context?.threadId === activeThreadId)
    : []

  return {
    activeEntry,
    activeConversation,
    activeServerRequests,
    serverRequests,
    models,
    selectedModelId: activeEntry.selectedModelId ?? selectedModelId,
    modelSelectionError: activeEntry.modelSelectionError,
    startNewConversation,
    startNewConversationWithDraft,
    prepareNewConversation,
    activateConversation,
    restoreActiveConversation,
    restoreSingleActiveConversation,
    openConversation,
    setSelectedModelId,
    setActiveProjectSelection,
    setActiveDraft,
    setActiveDraftAttachments,
    setActiveComposerModeKind,
    setActiveApprovalModeKind,
    setActiveGoalEditorActive,
    setActiveThreadGoal,
    setActiveGoalOperation,
    setActiveScroll,
    syncConversationMetadata,
    conversationIndicators,
    getConversationTitle,
    respondToServerRequest,
    rejectServerRequest,
    snoozeServerRequest
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toModelOptions(list: CodexModelList): ModelOption[] {
  if (list.unavailableReason) {
    return [{ id: '__unavailable__', name: list.unavailableReason, disabled: true }]
  }
  return list.models.map((model) => ({
    id: model.id,
    name: model.displayName,
    description: model.description,
    inputModalities: model.inputModalities,
    disabled: false
  }))
}
