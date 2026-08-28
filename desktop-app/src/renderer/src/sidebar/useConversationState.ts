import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  SidebarConversationActionPayload,
  SidebarConversationBatchDeletePayload,
  SidebarConversationListState,
  SidebarConversationRenamePayload,
  SidebarPreferences
} from '../../../shared/codexIpcApi'

const initialConversationState: SidebarConversationListState = {
  conversations: [],
  archivedConversationIds: [],
  loaded: false
}

const defaultPreferences: SidebarPreferences = {
  organizeMode: 'project',
  sortKey: 'updated_at',
  collapsedSectionIds: [],
  collapsedGroupIds: [],
  pinnedConversationIds: []
}

export type ConversationStateController = {
  state: SidebarConversationListState
  preferences: SidebarPreferences
  refresh: () => Promise<void>
  openConversation: (input: SidebarConversationActionPayload) => Promise<void>
  archiveConversation: (input: SidebarConversationActionPayload) => Promise<void>
  unarchiveConversation: (input: SidebarConversationActionPayload) => Promise<void>
  deleteConversation: (input: SidebarConversationActionPayload) => Promise<void>
  deleteArchivedConversations: (input: SidebarConversationBatchDeletePayload) => Promise<void>
  renameConversation: (input: SidebarConversationRenamePayload) => Promise<void>
  interruptConversation: (input: SidebarConversationActionPayload) => Promise<void>
  setPreferences: (input: Partial<SidebarPreferences>) => Promise<void>
}

export function useConversationState({
  openConversation: openConversationInRuntime,
  syncConversationMetadata
}: {
  openConversation: (input: SidebarConversationActionPayload) => Promise<void>
  syncConversationMetadata?: (conversations: SidebarConversationListState['conversations']) => void
}): ConversationStateController {
  const [state, setState] = useState<SidebarConversationListState>(initialConversationState)
  const [preferences, setPreferencesState] = useState<SidebarPreferences>(defaultPreferences)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.desktopApp.conversations.getConversationList(),
      window.desktopApp.conversations.getPreferences()
    ]).then(([nextState, nextPreferences]) => {
      if (cancelled) return
      setState(nextState)
      setPreferencesState(nextPreferences)
    })
    const removeListener = window.desktopApp.conversations.onConversationListChange((nextState) => {
      setState(nextState)
    })
    return () => {
      cancelled = true
      removeListener()
    }
  }, [])

  useEffect(() => {
    syncConversationMetadata?.(state.conversations)
  }, [state.conversations, syncConversationMetadata])

  const refresh = useCallback(async () => {
    setState(await window.desktopApp.conversations.refreshConversationList())
  }, [])

  const openConversation = useCallback(
    async (input: SidebarConversationActionPayload) => {
      await openConversationInRuntime(input)
    },
    [openConversationInRuntime]
  )

  const archiveConversation = useCallback(async (input: SidebarConversationActionPayload) => {
    setState(await window.desktopApp.conversations.archiveConversation(input))
  }, [])

  const unarchiveConversation = useCallback(async (input: SidebarConversationActionPayload) => {
    setState(await window.desktopApp.conversations.unarchiveConversation(input))
  }, [])

  const deleteConversation = useCallback(async (input: SidebarConversationActionPayload) => {
    setState(await window.desktopApp.conversations.deleteConversation(input))
  }, [])

  const deleteArchivedConversations = useCallback(
    async (input: SidebarConversationBatchDeletePayload) => {
      setState(await window.desktopApp.conversations.deleteArchivedConversations(input))
    },
    []
  )

  const renameConversation = useCallback(async (input: SidebarConversationRenamePayload) => {
    setState(await window.desktopApp.conversations.renameConversation(input))
  }, [])

  const interruptConversation = useCallback(async (input: SidebarConversationActionPayload) => {
    await window.desktopApp.conversations.interruptConversation(input)
  }, [])

  const setPreferences = useCallback(async (input: Partial<SidebarPreferences>) => {
    setPreferencesState(await window.desktopApp.conversations.setPreferences(input))
  }, [])

  return useMemo(
    () => ({
      state,
      preferences,
      refresh,
      openConversation,
      archiveConversation,
      unarchiveConversation,
      deleteConversation,
      deleteArchivedConversations,
      renameConversation,
      interruptConversation,
      setPreferences
    }),
    [
      archiveConversation,
      deleteConversation,
      deleteArchivedConversations,
      interruptConversation,
      openConversation,
      preferences,
      refresh,
      renameConversation,
      setPreferences,
      state,
      unarchiveConversation
    ]
  )
}
