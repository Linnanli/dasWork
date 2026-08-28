import { contextBridge, ipcRenderer } from 'electron'
import { config as configureZod, type ZodType } from 'zod'
import { codexChatTerminalFallbackSchema } from '../shared/codexIpcApi'
import type {
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexChatRequest,
  CodexModelList,
  CodexStatus,
  DesktopCodexApi,
  DesktopCodexFollowUpApi,
  DesktopComposerContextApi,
  DesktopConversationsApi,
  DesktopAutomationsApi,
  DesktopGithubPullRequestApi,
  DesktopKeyboardShortcutsApi,
  DesktopGitApi,
  DesktopProjectsApi,
  LocalContextPickerKind,
  LocalContextReference,
  FollowUpQueueChangeEvent,
  ProjectCreateBlankResult,
  ProjectActionRemovePayload,
  ProjectActionUpsertPayload,
  ProjectWorktreeListPayload,
  ProjectWorktreeSelectPayload,
  WorkspaceRecoveryPayload,
  SidebarConversationListState,
  SidebarConversationOpenResult,
  ThreadGoalLoadResult,
  ThreadGoalSummary,
  SidebarConversationGoalSetPayload,
  SidebarPreferences
} from '../shared/codexIpcApi'
import {
  keyboardShortcutConfigSchema,
  keyboardShortcutIpcChannels,
  keyboardShortcutUpdateRequestSchema
} from '../shared/keyboardShortcutsApi'
import {
  automationActionRequestSchema,
  automationCreateRequestSchema,
  automationIpcChannels,
  automationStatusRequestSchema,
  automationUpdateRequestSchema,
  scheduledAutomationListSchema,
  scheduledAutomationSchema
} from '../shared/automationApi'
import {
  browserWorkspaceCreateRequestSchema,
  browserWorkspaceEventSchema,
  browserWorkspaceIpcChannels,
  browserWorkspaceListRequestSchema,
  browserWorkspaceNavigateRequestSchema,
  browserWorkspaceSetBoundsRequestSchema,
  browserWorkspaceViewRequestSchema
} from '../shared/browserWorkspaceApi'
import {
  fileWorkspaceListDirectoryRequestSchema,
  fileWorkspaceEventSchema,
  fileWorkspaceMetadataRequestSchema,
  fileWorkspaceReadFileRequestSchema,
  fileWorkspaceSearchRequestSchema,
  fileWorkspaceSearchSessionEventSchema,
  fileWorkspaceSearchSessionStartRequestSchema,
  fileWorkspaceSearchSessionStopRequestSchema,
  fileWorkspaceSearchSessionUpdateRequestSchema
} from '../shared/fileWorkspaceApi'
import {
  rightWorkspaceIpcChannels,
  rightWorkspaceDisposeRequestSchema,
  rightWorkspacePrepareFileRootRequestSchema,
  type DesktopRightWorkspaceApi
} from '../shared/rightWorkspaceApi'
import {
  nativeContextMenuIpcChannels,
  nativeContextMenuRequestSchema,
  type DesktopNativeContextMenuApi
} from '../shared/nativeContextMenuApi'
import {
  terminalWorkspaceAttachRequestSchema,
  terminalWorkspaceCloseRequestSchema,
  terminalWorkspaceCreateRequestSchema,
  terminalWorkspaceDetachRequestSchema,
  terminalWorkspaceEventSchema,
  terminalWorkspaceIpcChannels,
  terminalWorkspaceListRequestSchema,
  terminalWorkspaceResizeRequestSchema,
  terminalWorkspaceRestartRequestSchema,
  terminalWorkspaceRunActionRequestSchema,
  terminalWorkspaceSetTitleRequestSchema,
  terminalWorkspaceSnapshotRequestSchema,
  terminalWorkspaceWriteRequestSchema
} from '../shared/terminalWorkspaceApi'
import {
  gitIpcChannels,
  gitResolveRepositoryTargetRequestSchema,
  localGitBranchRequestSchema,
  localGitBranchSearchRequestSchema,
  localGitChangeEventSchema,
  localGitCheckoutBranchRequestSchema,
  localGitCreateBranchRequestSchema,
  localGitGetFileDiffRequestSchema,
  localGitGetReviewApplyCommandRequestSchema,
  localGitGetReviewDiffFileContentsRequestSchema,
  localGitGetReviewFileContentRequestSchema,
  localGitGetTurnDiffFileContentsRequestSchema,
  localGitGetReviewSnapshotRequestSchema,
  localGitRefreshReviewFilesRequestSchema,
  localGitListCommitsRequestSchema,
  localGitGetSummaryRequestSchema,
  localGitGetPublishStatusRequestSchema,
  localGitSearchReviewRequestSchema,
  localGitReviewMutationRequestSchema,
  localCommitRequestSchema,
  localPushRequestSchema,
  localGitResolveMergeBaseRequestSchema,
  turnPatchRequestSchema
} from '../shared/localGitApi'
import {
  githubPullRequestCommentRequestSchema,
  githubPullRequestCreateRequestSchema,
  githubPullRequestIpcChannels,
  githubPullRequestRequestReviewersRequestSchema,
  githubPullRequestStatusRequestSchema,
  githubPullRequestSubmitReviewRequestSchema
} from '../shared/githubPullRequestApi'
import type {
  LocalProject,
  ProjectSelection,
  ProjectState,
  ProjectWorktree,
  RemoteProject,
  WorkspaceRootOption
} from '../shared/projects/projectTypes'
import { createChatStreamBridge } from './chatStreamBridge'
import { createComposerContextBridge } from './composerContextBridge'
import { assertFollowUpSnapshotFitsIpc } from './followUpPayloadGuard'
import { createMcpServerStatusBridge } from './mcpServerStatusBridge'
import { createMcpAppResourceBridge } from './mcpAppResourceBridge'
import { createPluginCenterBridge } from './pluginCenterBridge'

// Electron's renderer CSP disallows Zod's optional dynamic parser compilation.
// Set this globally before any IPC payload is parsed, including the schemas
// imported by this preload bundle.
configureZod({ jitless: true })

const desktopEnvironment = {
  platform: process.platform
}

const desktopCodex: DesktopCodexApi = {
  getStatus: () => ipcRenderer.invoke('codex:get-status') as Promise<CodexStatus>,
  listModels: () => ipcRenderer.invoke('codex:list-models') as Promise<CodexModelList>,
  ...createMcpServerStatusBridge((channel, payload) => ipcRenderer.invoke(channel, payload)),
  ...createMcpAppResourceBridge((channel, payload) => ipcRenderer.invoke(channel, payload)),
  setSelectedModel: (modelId: string) =>
    ipcRenderer.invoke('codex:set-selected-model', { modelId }) as Promise<{
      selectedModelId: string
    }>,
  listPendingApprovals: () =>
    ipcRenderer.invoke('codex:list-pending-approvals') as Promise<CodexApprovalRequest[]>,
  respondApproval: (requestId: string, response: CodexApprovalResponse) =>
    ipcRenderer.invoke('codex:respond-approval', { requestId, response }) as Promise<void>,
  snoozeApprovalAutoResolution: (requestId: string) =>
    ipcRenderer.invoke('codex:snooze-approval-auto-resolution', { requestId }) as Promise<boolean>,
  openExternalHttpUrl: (url: string) =>
    ipcRenderer.invoke('codex:open-external-http-url', { url }) as Promise<void>,
  openLocalPath: (input) => ipcRenderer.invoke('codex:open-local-path', input) as Promise<void>,
  revealLocalPath: (input) => ipcRenderer.invoke('codex:reveal-local-path', input) as Promise<void>,
  startLocalPathDrag: (input) => ipcRenderer.send('codex:start-local-path-drag', input),
  listExistingLocalPaths: (input) => ipcRenderer.invoke('codex:list-existing-local-paths', input),
  pickLocalContext: (kind: LocalContextPickerKind) =>
    ipcRenderer.invoke('codex:pick-local-context', { kind }) as Promise<LocalContextReference[]>,
  onStatusChange: (callback: (status: CodexStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CodexStatus): void =>
      callback(status)
    ipcRenderer.on('codex:status-change', listener)
    return () => ipcRenderer.removeListener('codex:status-change', listener)
  },
  onApprovalRequest: (callback: (request: CodexApprovalRequest) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: CodexApprovalRequest): void =>
      callback(request)
    ipcRenderer.on('codex:approval-request', listener)
    return () => ipcRenderer.removeListener('codex:approval-request', listener)
  },
  onApprovalSettled: (callback: (requestId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: unknown): void => {
      if (typeof requestId === 'string' && requestId.length > 0) callback(requestId)
    }
    ipcRenderer.on('codex:approval-settled', listener)
    return () => ipcRenderer.removeListener('codex:approval-settled', listener)
  },
  onConversationFindRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('codex:conversation-find', listener)
    return () => ipcRenderer.removeListener('codex:conversation-find', listener)
  },
  onNewTaskRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('codex:new-task', listener)
    return () => ipcRenderer.removeListener('codex:new-task', listener)
  },
  onCommandPaletteRequested: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('codex:command-palette', listener)
    return () => ipcRenderer.removeListener('codex:command-palette', listener)
  }
}

const desktopCodexChat = createChatStreamBridge({
  createStreamId: () => crypto.randomUUID(),
  createMessageChannel: () => new MessageChannel(),
  hasActiveRun: (conversationId) =>
    ipcRenderer.invoke('codex-chat:has-active-run', { conversationId }),
  getActiveRun: (conversationId) =>
    ipcRenderer.invoke('codex-chat:get-active-run', { conversationId }),
  getActiveRuns: () => ipcRenderer.invoke('codex-chat:get-active-runs'),
  getActiveSnapshot: (conversationId) =>
    ipcRenderer.invoke('codex-chat:get-active-snapshot', { conversationId }),
  postStart: (request: CodexChatRequest, streamId: string, port: MessagePort) => {
    ipcRenderer.postMessage('codex-chat:start', { streamId, request }, [port])
  },
  postAttach: (conversationId, streamId, port, runId, afterSequence) => {
    ipcRenderer.postMessage(
      'codex-chat:attach',
      { conversationId, streamId, ...(runId ? { runId } : {}), afterSequence },
      [port]
    )
  },
  postDetached: (streamId, request) => {
    ipcRenderer.send('codex-chat:port-detached', { streamId, chatId: request.chatId })
  },
  subscribeTerminal: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = codexChatTerminalFallbackSchema.safeParse(payload, { jitless: true })
      if (parsed.success) callback(parsed.data)
    }
    ipcRenderer.on('codex-chat:terminal', listener)
    return () => ipcRenderer.removeListener('codex-chat:terminal', listener)
  }
})

window.addEventListener('beforeunload', () => {
  desktopCodexChat.detachActiveStreams()
})

const desktopComposerContext: DesktopComposerContextApi = createComposerContextBridge(
  (channel, payload) => ipcRenderer.invoke(channel, payload),
  (channel, callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
)

const desktopPlugins = createPluginCenterBridge((channel, payload) =>
  ipcRenderer.invoke(channel, payload)
)

const desktopProjects: DesktopProjectsApi = {
  getState: () => ipcRenderer.invoke('codex:projects:get-state') as Promise<ProjectState>,
  pickWorkspaceRoot: () =>
    ipcRenderer.invoke('codex:projects:pick-workspace-root') as Promise<WorkspaceRootOption | null>,
  createBlankProject: (input) =>
    ipcRenderer.invoke('codex:projects:create-blank', input) as Promise<ProjectCreateBlankResult>,
  createLocalProject: (input) =>
    ipcRenderer.invoke('codex:projects:create-local', input) as Promise<LocalProject>,
  createRemoteProject: (input) =>
    ipcRenderer.invoke('codex:projects:create-remote', input) as Promise<RemoteProject>,
  listWorktrees: (input: ProjectWorktreeListPayload) =>
    ipcRenderer.invoke('codex:projects:list-worktrees', input) as Promise<ProjectWorktree[]>,
  selectWorktree: (input: ProjectWorktreeSelectPayload) =>
    ipcRenderer.invoke('codex:projects:select-worktree', input) as Promise<ProjectState>,
  selectProject: (input: ProjectSelection) =>
    ipcRenderer.invoke('codex:projects:select', input) as Promise<ProjectState>,
  removeProject: (input: ProjectSelection) =>
    ipcRenderer.invoke('codex:projects:remove', input) as Promise<ProjectState>,
  renameProject: (input) =>
    ipcRenderer.invoke('codex:projects:rename', input) as Promise<ProjectState>,
  upsertAction: (input: ProjectActionUpsertPayload) =>
    ipcRenderer.invoke('codex:projects:upsert-action', input) as Promise<ProjectState>,
  removeAction: (input: ProjectActionRemovePayload) =>
    ipcRenderer.invoke('codex:projects:remove-action', input) as Promise<ProjectState>,
  getWorkspaceRecovery: (input: WorkspaceRecoveryPayload) =>
    ipcRenderer.invoke('codex:projects:get-workspace-recovery', input),
  restoreWorkspace: (input: WorkspaceRecoveryPayload) =>
    ipcRenderer.invoke('codex:projects:restore-workspace', input),
  onStateChange: (callback: (state: ProjectState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ProjectState): void =>
      callback(state)
    ipcRenderer.on('codex:projects-state-change', listener)
    return () => ipcRenderer.removeListener('codex:projects-state-change', listener)
  }
}

const desktopNativeContextMenu: DesktopNativeContextMenuApi = {
  show: (items) =>
    ipcRenderer.invoke(
      nativeContextMenuIpcChannels.show,
      parseWorkspacePayload(nativeContextMenuRequestSchema, { items })
    ) as Promise<string | null>
}

const desktopConversations: DesktopConversationsApi = {
  getConversationList: () =>
    ipcRenderer.invoke('codex:conversations:get-list') as Promise<SidebarConversationListState>,
  refreshConversationList: () =>
    ipcRenderer.invoke('codex:conversations:refresh-list') as Promise<SidebarConversationListState>,
  openConversation: (input) =>
    ipcRenderer.invoke('codex:conversations:open', input) as Promise<SidebarConversationOpenResult>,
  openConversationInNewWindow: (input) =>
    ipcRenderer.invoke('codex:conversations:open-in-new-window', input) as Promise<void>,
  getConversationGoal: (input) =>
    ipcRenderer.invoke('codex:conversations:get-goal', input) as Promise<ThreadGoalLoadResult>,
  setConversationGoal: (input: SidebarConversationGoalSetPayload) =>
    ipcRenderer.invoke('codex:conversations:set-goal', input) as Promise<ThreadGoalSummary>,
  clearConversationGoal: (input) =>
    ipcRenderer.invoke('codex:conversations:clear-goal', input) as Promise<boolean>,
  archiveConversation: (input) =>
    ipcRenderer.invoke(
      'codex:conversations:archive',
      input
    ) as Promise<SidebarConversationListState>,
  unarchiveConversation: (input) =>
    ipcRenderer.invoke(
      'codex:conversations:unarchive',
      input
    ) as Promise<SidebarConversationListState>,
  deleteConversation: (input) =>
    ipcRenderer.invoke(
      'codex:conversations:delete',
      input
    ) as Promise<SidebarConversationListState>,
  deleteArchivedConversations: (input) =>
    ipcRenderer.invoke(
      'codex:conversations:delete-archived',
      input
    ) as Promise<SidebarConversationListState>,
  renameConversation: (input) =>
    ipcRenderer.invoke(
      'codex:conversations:rename',
      input
    ) as Promise<SidebarConversationListState>,
  forkConversation: (input) =>
    ipcRenderer.invoke('codex:conversations:fork', input) as Promise<SidebarConversationOpenResult>,
  submitFeedback: (input) =>
    ipcRenderer.invoke('codex:conversations:submit-feedback', input) as Promise<void>,
  interruptConversation: (input) =>
    ipcRenderer.invoke('codex:conversations:interrupt', input) as Promise<void>,
  getPreferences: () =>
    ipcRenderer.invoke('codex:conversations:get-preferences') as Promise<SidebarPreferences>,
  setPreferences: (input) =>
    ipcRenderer.invoke('codex:conversations:set-preferences', input) as Promise<SidebarPreferences>,
  onConversationListChange: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: SidebarConversationListState
    ): void => callback(state)
    ipcRenderer.on('codex:conversations-state-change', listener)
    return () => ipcRenderer.removeListener('codex:conversations-state-change', listener)
  },
  consumeConversationLink: () => ipcRenderer.invoke('codex:conversations:consume-link'),
  onConversationLink: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, link: { conversationId: string }): void =>
      callback(link)
    ipcRenderer.on('codex:conversations:open-link', listener)
    return () => ipcRenderer.removeListener('codex:conversations:open-link', listener)
  }
}

const desktopFollowUps: DesktopCodexFollowUpApi = {
  getState: (conversationKey) =>
    ipcRenderer.invoke('codex:follow-ups:get-state', { conversationKey }),
  enqueue: (conversationKey, snapshot, preferredMode) => {
    assertFollowUpSnapshotFitsIpc(snapshot)
    return ipcRenderer.invoke('codex:follow-ups:enqueue', {
      conversationKey,
      snapshot,
      preferredMode
    })
  },
  edit: (conversationKey, itemId, replacementSnapshot) => {
    assertFollowUpSnapshotFitsIpc(replacementSnapshot)
    return ipcRenderer.invoke('codex:follow-ups:edit', {
      conversationKey,
      itemId,
      replacementSnapshot
    })
  },
  beginEdit: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:begin-edit', { conversationKey, itemId }),
  commitEdit: (conversationKey, itemId, replacementSnapshot) => {
    assertFollowUpSnapshotFitsIpc(replacementSnapshot)
    return ipcRenderer.invoke('codex:follow-ups:commit-edit', {
      conversationKey,
      itemId,
      replacementSnapshot
    })
  },
  cancelEdit: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:cancel-edit', { conversationKey, itemId }),
  delete: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:delete', { conversationKey, itemId }),
  reorder: (conversationKey, itemId, position) =>
    ipcRenderer.invoke('codex:follow-ups:reorder', {
      conversationKey,
      itemId,
      ...position
    }),
  requestSendNow: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:send-now', { conversationKey, itemId }),
  retry: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:retry', { conversationKey, itemId }),
  resume: (conversationKey) => ipcRenderer.invoke('codex:follow-ups:resume', { conversationKey }),
  clear: (conversationKey) => ipcRenderer.invoke('codex:follow-ups:clear', { conversationKey }),
  setDefaultMode: (mode) => ipcRenderer.invoke('codex:follow-ups:set-default-mode', { mode }),
  prepareNextTurn: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:prepare-next-turn', {
      conversationKey,
      ...(itemId ? { itemId } : {})
    }),
  materializeItem: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:materialize-item', {
      conversationKey,
      itemId
    }),
  steerNext: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:steer-next', {
      conversationKey,
      ...(itemId ? { itemId } : {})
    }),
  steerItem: (conversationKey, itemId) =>
    ipcRenderer.invoke('codex:follow-ups:steer-item', {
      conversationKey,
      itemId
    }),
  subscribe: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FollowUpQueueChangeEvent): void =>
      callback(payload)
    ipcRenderer.on('codex:follow-ups:changed', listener)
    return () => ipcRenderer.removeListener('codex:follow-ups:changed', listener)
  }
}

const desktopGit: DesktopGitApi = {
  resolveRepositoryTarget: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.resolveRepositoryTarget,
      parseGitPayload(gitResolveRepositoryTargetRequestSchema, input)
    ),
  getSummary: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getSummary,
      parseGitPayload(localGitGetSummaryRequestSchema, input)
    ),
  listCommits: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.listCommits,
      parseGitPayload(localGitListCommitsRequestSchema, input)
    ),
  getReviewSnapshot: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getReviewSnapshot,
      parseGitPayload(localGitGetReviewSnapshotRequestSchema, input)
    ),
  refreshReviewFiles: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.refreshReviewFiles,
      parseGitPayload(localGitRefreshReviewFilesRequestSchema, input)
    ),
  getFileDiff: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getFileDiff,
      parseGitPayload(localGitGetFileDiffRequestSchema, input)
    ),
  getReviewApplyCommand: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getReviewApplyCommand,
      parseGitPayload(localGitGetReviewApplyCommandRequestSchema, input)
    ),
  getReviewDiffFileContents: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getReviewDiffFileContents,
      parseGitPayload(localGitGetReviewDiffFileContentsRequestSchema, input)
    ),
  getTurnDiffFileContents: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getTurnDiffFileContents,
      parseGitPayload(localGitGetTurnDiffFileContentsRequestSchema, input)
    ),
  getReviewFileContent: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getReviewFileContent,
      parseGitPayload(localGitGetReviewFileContentRequestSchema, input)
    ),
  searchReview: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.searchReview,
      parseGitPayload(localGitSearchReviewRequestSchema, input)
    ),
  applyReviewAction: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.applyReviewAction,
      parseGitPayload(localGitReviewMutationRequestSchema, input)
    ),
  applyTurnPatch: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.applyTurnPatch,
      parseGitPayload(turnPatchRequestSchema, input)
    ),
  listBranches: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.listBranches,
      parseGitPayload(localGitBranchRequestSchema, input)
    ),
  searchBranches: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.searchBranches,
      parseGitPayload(localGitBranchSearchRequestSchema, input)
    ),
  resolveMergeBase: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.resolveMergeBase,
      parseGitPayload(localGitResolveMergeBaseRequestSchema, input)
    ),
  createBranch: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.createBranch,
      parseGitPayload(localGitCreateBranchRequestSchema, input)
    ),
  checkoutBranch: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.checkoutBranch,
      parseGitPayload(localGitCheckoutBranchRequestSchema, input)
    ),
  commitChanges: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.commitChanges,
      parseGitPayload(localCommitRequestSchema, input)
    ),
  getPublishStatus: (input) =>
    ipcRenderer.invoke(
      gitIpcChannels.getPublishStatus,
      parseGitPayload(localGitGetPublishStatusRequestSchema, input)
    ),
  pushChanges: (input) =>
    ipcRenderer.invoke(gitIpcChannels.pushChanges, parseGitPayload(localPushRequestSchema, input)),
  subscribe: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      const parsed = localGitChangeEventSchema.safeParse(payload, { jitless: true })
      if (parsed.success) callback(parsed.data)
    }
    ipcRenderer.send(`${gitIpcChannels.changed}:subscribe`)
    ipcRenderer.on(gitIpcChannels.changed, listener)
    return () => {
      ipcRenderer.removeListener(gitIpcChannels.changed, listener)
      ipcRenderer.send(`${gitIpcChannels.changed}:unsubscribe`)
    }
  }
}

const desktopGithubPullRequests: DesktopGithubPullRequestApi = {
  getStatus: (input) =>
    ipcRenderer.invoke(
      githubPullRequestIpcChannels.getStatus,
      parseGitPayload(githubPullRequestStatusRequestSchema, input)
    ),
  create: (input) =>
    ipcRenderer.invoke(
      githubPullRequestIpcChannels.create,
      parseGitPayload(githubPullRequestCreateRequestSchema, input)
    ),
  comment: (input) =>
    ipcRenderer.invoke(
      githubPullRequestIpcChannels.comment,
      parseGitPayload(githubPullRequestCommentRequestSchema, input)
    ),
  submitReview: (input) =>
    ipcRenderer.invoke(
      githubPullRequestIpcChannels.submitReview,
      parseGitPayload(githubPullRequestSubmitReviewRequestSchema, input)
    ),
  requestReviewers: (input) =>
    ipcRenderer.invoke(
      githubPullRequestIpcChannels.requestReviewers,
      parseGitPayload(githubPullRequestRequestReviewersRequestSchema, input)
    )
}

const desktopKeyboardShortcuts: DesktopKeyboardShortcutsApi = {
  get: () =>
    ipcRenderer
      .invoke(keyboardShortcutIpcChannels.get)
      .then((result) => keyboardShortcutConfigSchema.parse(result, { jitless: true })),
  update: (input) =>
    ipcRenderer
      .invoke(
        keyboardShortcutIpcChannels.update,
        keyboardShortcutUpdateRequestSchema.parse(input, { jitless: true })
      )
      .then((result) => keyboardShortcutConfigSchema.parse(result, { jitless: true })),
  reset: () =>
    ipcRenderer
      .invoke(keyboardShortcutIpcChannels.reset)
      .then((result) => keyboardShortcutConfigSchema.parse(result, { jitless: true }))
}

const desktopAutomations: DesktopAutomationsApi = {
  list: () =>
    ipcRenderer
      .invoke(automationIpcChannels.list)
      .then((result) => scheduledAutomationListSchema.parse(result, { jitless: true })),
  create: (input) =>
    ipcRenderer
      .invoke(
        automationIpcChannels.create,
        parseWorkspacePayload(automationCreateRequestSchema, input)
      )
      .then((result) => scheduledAutomationSchema.parse(result, { jitless: true })),
  update: (input) =>
    ipcRenderer
      .invoke(
        automationIpcChannels.update,
        parseWorkspacePayload(automationUpdateRequestSchema, input)
      )
      .then((result) => scheduledAutomationSchema.parse(result, { jitless: true })),
  setStatus: (input) =>
    ipcRenderer
      .invoke(
        automationIpcChannels.setStatus,
        parseWorkspacePayload(automationStatusRequestSchema, input)
      )
      .then((result) => scheduledAutomationSchema.parse(result, { jitless: true })),
  remove: (input) =>
    ipcRenderer.invoke(
      automationIpcChannels.remove,
      parseWorkspacePayload(automationActionRequestSchema, input)
    ),
  runNow: (input) =>
    ipcRenderer
      .invoke(
        automationIpcChannels.runNow,
        parseWorkspacePayload(automationActionRequestSchema, input)
      )
      .then((result) => scheduledAutomationSchema.parse(result, { jitless: true }))
}

const desktopRightWorkspace: DesktopRightWorkspaceApi = {
  dispose: (input) =>
    ipcRenderer.invoke(
      rightWorkspaceIpcChannels.disposeWorkspace,
      parseWorkspacePayload(rightWorkspaceDisposeRequestSchema, input)
    ) as Promise<void>,
  files: {
    prepareRoot: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.prepareFileRoot,
        parseWorkspacePayload(rightWorkspacePrepareFileRootRequestSchema, input)
      ),
    listDirectory: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.listDirectory,
        parseWorkspacePayload(fileWorkspaceListDirectoryRequestSchema, input)
      ),
    metadata: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.metadata,
        parseWorkspacePayload(fileWorkspaceMetadataRequestSchema, input)
      ),
    readFile: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.readFile,
        parseWorkspacePayload(fileWorkspaceReadFileRequestSchema, input)
      ),
    search: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.searchFiles,
        parseWorkspacePayload(fileWorkspaceSearchRequestSchema, input)
      ),
    startSearch: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.startFileSearch,
        parseWorkspacePayload(fileWorkspaceSearchSessionStartRequestSchema, input)
      ),
    updateSearch: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.updateFileSearch,
        parseWorkspacePayload(fileWorkspaceSearchSessionUpdateRequestSchema, input)
      ) as Promise<void>,
    stopSearch: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.stopFileSearch,
        parseWorkspacePayload(fileWorkspaceSearchSessionStopRequestSchema, input)
      ) as Promise<void>,
    onSearchEvent: (callback) =>
      subscribeWorkspaceEvent(
        rightWorkspaceIpcChannels.fileSearchEvent,
        fileWorkspaceSearchSessionEventSchema,
        callback
      ),
    openWithSystem: (input) =>
      ipcRenderer.invoke(
        rightWorkspaceIpcChannels.openWithSystem,
        parseWorkspacePayload(fileWorkspaceMetadataRequestSchema, input)
      ) as Promise<void>,
    onEvent: (callback) =>
      subscribeWorkspaceEvent(
        rightWorkspaceIpcChannels.fileEvent,
        fileWorkspaceEventSchema,
        callback
      )
  },
  terminal: {
    create: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.create,
        parseWorkspacePayload(terminalWorkspaceCreateRequestSchema, input)
      ),
    attach: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.attach,
        parseWorkspacePayload(terminalWorkspaceAttachRequestSchema, input)
      ),
    detach: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.detach,
        parseWorkspacePayload(terminalWorkspaceDetachRequestSchema, input)
      ),
    write: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.write,
        parseWorkspacePayload(terminalWorkspaceWriteRequestSchema, input)
      ),
    resize: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.resize,
        parseWorkspacePayload(terminalWorkspaceResizeRequestSchema, input)
      ),
    setTitle: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.setTitle,
        parseWorkspacePayload(terminalWorkspaceSetTitleRequestSchema, input)
      ),
    runAction: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.runAction,
        parseWorkspacePayload(terminalWorkspaceRunActionRequestSchema, input)
      ),
    restart: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.restart,
        parseWorkspacePayload(terminalWorkspaceRestartRequestSchema, input)
      ),
    close: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.close,
        parseWorkspacePayload(terminalWorkspaceCloseRequestSchema, input)
      ),
    list: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.list,
        parseWorkspacePayload(terminalWorkspaceListRequestSchema, input)
      ),
    snapshot: (input) =>
      ipcRenderer.invoke(
        terminalWorkspaceIpcChannels.snapshot,
        parseWorkspacePayload(terminalWorkspaceSnapshotRequestSchema, input)
      ),
    listShells: () => ipcRenderer.invoke(terminalWorkspaceIpcChannels.listShells),
    onEvent: (callback) =>
      subscribeWorkspaceEvent(
        terminalWorkspaceIpcChannels.event,
        terminalWorkspaceEventSchema,
        callback
      )
  },
  browser: {
    create: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.create,
        parseWorkspacePayload(browserWorkspaceCreateRequestSchema, input)
      ),
    navigate: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.navigate,
        parseWorkspacePayload(browserWorkspaceNavigateRequestSchema, input)
      ),
    setBounds: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.setBounds,
        parseWorkspacePayload(browserWorkspaceSetBoundsRequestSchema, input)
      ),
    goBack: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.goBack,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    goForward: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.goForward,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    reload: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.reload,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    stop: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.stop,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    show: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.show,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    hide: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.hide,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    destroy: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.destroy,
        parseWorkspacePayload(browserWorkspaceViewRequestSchema, input)
      ),
    list: (input) =>
      ipcRenderer.invoke(
        browserWorkspaceIpcChannels.list,
        parseWorkspacePayload(browserWorkspaceListRequestSchema, input)
      ),
    onEvent: (callback) =>
      subscribeWorkspaceEvent(
        browserWorkspaceIpcChannels.event,
        browserWorkspaceEventSchema,
        callback
      )
  }
}

function parseGitPayload<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input, { jitless: true })
  if (!parsed.success) throw parsed.error
  return parsed.data
}

function parseWorkspacePayload<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input, { jitless: true })
  if (!parsed.success) throw parsed.error
  return parsed.data
}

function subscribeWorkspaceEvent<T>(
  channel: string,
  schema: ZodType<T>,
  callback: (event: T) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
    const parsed = schema.safeParse(payload, { jitless: true })
    if (parsed.success) callback(parsed.data)
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const desktopApp = {
  environment: desktopEnvironment,
  codex: desktopCodex,
  chat: desktopCodexChat,
  composerContext: desktopComposerContext,
  plugins: desktopPlugins,
  projects: desktopProjects,
  conversations: desktopConversations,
  followUps: desktopFollowUps,
  git: desktopGit,
  githubPullRequests: desktopGithubPullRequests,
  keyboardShortcuts: desktopKeyboardShortcuts,
  automations: desktopAutomations,
  nativeContextMenu: desktopNativeContextMenu,
  workspace: desktopRightWorkspace
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('desktopApp', desktopApp)
  } catch (error) {
    console.error(error)
  }
} else {
  ;(window as typeof window & { desktopApp: typeof desktopApp }).desktopApp = desktopApp
}
