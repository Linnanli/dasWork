import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  type AssistantState,
  MessagePrimitive,
  ThreadPrimitive,
  type QuoteMessagePartProps,
  type TextMessagePartProps,
  type ToolCallMessagePartStatus,
  type Unstable_TriggerItem,
  getExternalStoreMessages,
  useExternalStoreRuntime,
  useAui,
  useAuiEvent,
  useAuiState,
  type AppendMessage,
  type ThreadMessage,
  type ThreadMessageLike
} from '@assistant-ui/react'
import { getToolName, isToolUIPart, type UIMessage, type UIMessagePart } from 'ai'
import { type DirectiveChipProps } from '@assistant-ui/react-lexical'
import { Streamdown, type Components, type PluginConfig } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { math } from '@streamdown/math'
import { mermaid } from '@streamdown/mermaid'
import { MessageTiming } from '@/components/assistant-ui/message-timing'
import { ComposerAttachments, UserMessageAttachments } from '@/components/assistant-ui/attachment'
import { ComposerAddContextPopover } from '@/components/assistant-ui/composer-add-context-popover'
import { ComposerApprovalModeSelector } from '@/components/assistant-ui/composer-approval-mode-selector'
import type { ComposerReviewSelection } from '@/components/assistant-ui/composer-code-review-command-content'
import {
  ComposerModeIndicatorBar,
  type ComposerModePresentation
} from '@/components/assistant-ui/composer-mode-indicator'
import { ComposerSuggestionSurface } from '@/components/assistant-ui/composer-suggestion-surface'
import { ComposerTurnStatusCard } from '@/components/assistant-ui/composer-turn-status-card'
import {
  GitRepositoryProvider,
  useGitRepository
} from '@/components/local-git-review/GitRepositoryProvider'
import { LocalBranchSwitcher } from '@/components/local-git-review/LocalBranchSwitcher'
import { CommitOrPushControlProvider } from '@/components/local-git-review/CommitOrPushControlProvider'
import { LocalGitReviewProvider } from '@/components/local-git-review/LocalGitReviewProvider'
import { ConversationPinnedSummary } from '@/components/conversation-summary/ConversationPinnedSummary'
import {
  RightWorkspaceProvider,
  WorkspaceLauncher,
  useRightWorkspace
} from '@/components/right-workspace'
import {
  ArtifactConversationBridgeProvider,
  useArtifactConversationBridge
} from '@/components/artifacts/ArtifactConversationBridge'
import { artifactConversationText } from '@/components/artifacts/artifactConversationText'
import type { ArtifactAnnotation } from '@/components/artifacts/annotations/artifactAnnotationTypes'
import {
  CLEAR_ACTIVE_TERMINAL_EVENT,
  clearActiveTerminalView
} from '@/components/right-workspace/terminal/terminalActiveView'
import {
  adjacentWorkspaceTabId,
  createWorkspaceContentRegistry,
  isPptxArtifactPath,
  isWorkspaceEditableTarget,
  useWorkspaceContainer,
  WorkspacePanelController,
  WorkspacePanelShell,
  type WorkspaceOpenOptions,
  type WorkspaceOpenTarget,
  type WorkspacePanelId,
  type WorkspaceTabRecord
} from '@/components/workspace-container'
import { ConversationTurnErrorBoundary } from '@/components/conversation/ConversationTurnErrorBoundary'
import { ConversationRecoveryStatus } from '@/components/conversation/ConversationRecoveryStatus'
import { WorkspaceRecoveryBanner } from '@/components/conversation/WorkspaceRecoveryBanner'
import { ContextLexicalInput } from '@/composer/contextLexicalInput'
import {
  ComposerSuggestionProvider,
  useComposerSuggestion
} from '@/composer/composerSuggestionController'
import {
  ComposerCommandRegistryProvider,
  createComposerCommandRegistry,
  useRegisterComposerCommand
} from '@/composer/commands/composerCommandRegistry'
import type { ComposerSuggestionItem } from '@/composer/composerSuggestionTypes'
import { ToolFallback } from '@/components/assistant-ui/tool-fallback'
import { buildCodeReviewPrompt } from '@/lib/codeReviewPrompt'
import {
  CollapsedActivityDetails,
  McpToolCallDetails,
  ReviewCommentsDetails,
  SpecialEntryRenderer,
  UnknownPartRenderer,
  WebSearchDetails
} from '@/components/render-units/renderUnitDetails'
import { ToolActivityGroupShell } from '@/components/render-units/toolActivityGroupShell'
import {
  MultiAgentToolItemDetails,
  SubagentActivityGroup,
  type OpenSubagentConversation
} from '@/components/render-units/subagentActivity'
import { renderUnitAttributes } from '@/components/render-units/renderUnitAttributes'
import {
  InlineReferenceAnchor,
  InlineReferenceCodeToken,
  InlineReferenceProvider
} from '@/components/render-units/inlineReference'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  FileIcon,
  FolderIcon,
  LightbulbIcon,
  MessageSquareIcon,
  Maximize2Icon,
  Minimize2Icon,
  PackageIcon,
  PanelLeftIcon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  PuzzleIcon,
  QuoteIcon,
  SparklesIcon,
  SquareIcon,
  TargetIcon,
  WrenchIcon
} from 'lucide-react'
import {
  createContext,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type FC,
  type ReactNode
} from 'react'

import { ModelSelector } from './components/assistant-ui'
import { ServerRequestPanel } from './components/assistant-ui/server-request-panel'
import { QueuedFollowUpList, QueuedFollowUpPausedBanner } from './components/queued-follow-ups'
import {
  PluginCenterPage,
  prefetchPluginCenterData,
  subscribePluginCenterData,
  type PluginCenterSurface
} from './components/plugin-center'
import { serializeComposerContextReference } from './composer/composerContextDirectiveFormatter'
import { Button } from './components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog'
import { ComposerProjectCard } from './projects/ComposerProjectCard'
import { useProjectState, type ProjectStateController } from './projects/useProjectState'
import { SidebarRoot } from './sidebar/SidebarRoot'
import { ConversationRuntimeIndicatorProvider } from './sidebar/ConversationRuntimeIndicatorProvider'
import {
  useConversationState,
  type ConversationStateController
} from './sidebar/useConversationState'
import { cn } from './lib/utils'
import {
  inlineReferenceCodeTagName,
  referenceInlineRehypePlugins
} from './lib/referenceInlineMarkdown'
import { referenceUrlTransform } from './lib/referenceInlineTarget'
import {
  resolveInlineReferenceAction,
  type InlineReferenceAction
} from './lib/referenceInlineAction'
import { blockedAssistantMessageText, pendingAssistantMessageText } from './lib/assistantMessages'
import {
  buildAssistantRenderUnits,
  type AssistantMessagePhase,
  type AssistantRenderUnit,
  type ToolItem
} from './lib/assistantRenderUnits'
import { buildComposerTurnStatus, withoutComposerStatusRenderUnits } from './lib/composerTurnStatus'
import {
  buildToolActivityDisplayModel,
  buildToolItemDisplay,
  type ToolItemDisplay
} from './lib/toolActivityDisplay'
import { scrollToRenderTarget } from './lib/renderUnitNavigation'
import { useCodexIpcAssistantRuntime } from './hooks/useCodexIpcAssistantRuntime'
import { steerFollowUpItemWithTranscript } from './hooks/useConversationFollowUpCoordinator'
import {
  useConversationFollowUps,
  type ConversationFollowUpsController
} from './hooks/useConversationFollowUps'
import type { ActiveConversationContext } from './lib/ElectronIpcChatTransport'
import type {
  ConversationChatEntry,
  ConversationScrollSnapshot
} from './runtime/ConversationChatRegistry'
import type { ConversationRuntimeIndicatorStore } from './runtime/ConversationRuntimeIndicatorStore'
import {
  type ConversationTranscriptController,
  safeTurnErrorMessage,
  type CodexTurnMessageMetadata,
  type ConversationTranscriptMessage
} from './runtime/ConversationTranscriptController'
import type { ConversationDraftAttachment } from './runtime/ConversationDraftStore'
import { captureConversationScroll, restoreConversationScroll } from './runtime/conversationScroll'
import {
  countConversationStreamPerformance,
  markConversationStreamCommit,
  markConversationStreamEvent,
  scheduleConversationStreamNextFrame
} from './runtime/conversationStreamPerformance'
import { createQueuedFollowUpSnapshot } from './runtime/queuedFollowUpSnapshot'
import { restoreQueuedFollowUpToComposerDraft } from './runtime/restoreQueuedFollowUpToComposer'
import type {
  CodexApprovalRequest,
  CodexApprovalResponse,
  LocalContextPickerKind
} from '../../shared/codexIpcApi'
import type {
  FollowUpMode,
  MaterializedQueuedUserMessage,
  QueuedUserMessageSnapshot,
  QueuedFollowUpTrustedContext,
  QueuedUserMessageSnapshotInput
} from '../../shared/codexFollowUpApi'
import type { ProjectSelection, ProjectState } from '../../shared/projects/projectTypes'
import type { GitConversationTarget } from '../../shared/localGitApi'
import { extractVisibleUserRequest } from '../../shared/userRequestEnvelope'
import type { ModelOption } from './components/assistant-ui'
import {
  composerContextDirectiveFormatter,
  parseComposerContextReferences
} from './composer/composerContextDirectiveFormatter'
import { buildComposerGlobalSearchResult } from './composer/composerGlobalSearch'
import {
  type ComposerContextCatalogState,
  useComposerContextCatalog
} from './composer/useComposerContextCatalog'
import { useComposerContextSearch } from './composer/useComposerContextSearch'
import {
  type ComposerContextIdentityIndex,
  ComposerContextIdentityProvider,
  inlineReferenceSemanticTargetsFromIdentityIndex,
  useComposerContextIdentityIndex
} from './composer/composerContextIdentity'
import {
  artifactSourceAttachmentIdentityFromId,
  createArtifactSourceAttachment,
  createLocalImageAttachment,
  createLocalPathAttachment,
  imageAttachmentAdapter,
  localFileAttachmentMediaType,
  localPathAttachmentIdentityFromId
} from './composer/imageAttachmentAdapter'

type CodexSidebarProps = {
  collapsed: boolean
  nativeBackdrop: boolean
  projectState: ProjectStateController
  conversationState: ConversationStateController
  conversationIndicators: ConversationRuntimeIndicatorStore
  onNewChat: () => void
  onOpenConversation: (conversationId: string) => void
  onOpenPlugins: () => void
  pluginsActive: boolean
}

type AppSurface = { kind: 'conversation' } | ({ kind: 'pluginCenter' } & PluginCenterSurface)

type HeaderProps = {
  activeConversation?: ActiveConversationContext
  sidebarCollapsed: boolean
}

type SidebarHeaderSlotProps = {
  collapsed: boolean
  onToggle: () => void
}

type ComposerProps = {
  activeConversation?: ActiveConversationContext
  composerModeKind: ConversationChatEntry['composerModeKind']
  approvalModeKind: ConversationChatEntry['approvalModeKind']
  goalEditorActive: boolean
  threadGoal: ConversationChatEntry['threadGoal']
  goalCapabilityStatus: ConversationChatEntry['goalCapabilityStatus']
  goalOperation: ConversationChatEntry['goalOperation']
  goalError?: string
  models: readonly ModelOption[]
  selectedModelId: string | undefined
  modelSelectionError?: string
  onSelectedModelChange: (modelId: string) => void
  projectState: ProjectStateController
  disabled?: boolean
  followUps: ConversationFollowUpsController
  onSteerFollowUp: (
    itemId: string,
    message:
      | MaterializedQueuedUserMessage
      | QueuedUserMessageSnapshot
      | QueuedUserMessageSnapshotInput
  ) => Promise<void>
  onStartCodeReview: (prompt: string) => Promise<void>
  onCreateNewTask: () => void
  onComposerModeKindChange: (composerModeKind: ConversationChatEntry['composerModeKind']) => void
  onApprovalModeKindChange: (approvalModeKind: ConversationChatEntry['approvalModeKind']) => void
  onGoalEditorActiveChange: (goalEditorActive: boolean) => void
  onThreadGoalChange: (threadGoal: ConversationChatEntry['threadGoal']) => void
  onGoalOperationChange: (
    goalOperation: ConversationChatEntry['goalOperation'],
    goalError?: string
  ) => void
  onSaveThreadGoal: (objective: string, hasAttachments?: boolean) => Promise<boolean>
}

type ChatThreadProps = ComposerProps & {
  approvalRequests: readonly CodexApprovalRequest[]
  onRespondApproval: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponse
  ) => Promise<void>
  onRejectApproval: (request: CodexApprovalRequest) => Promise<void>
  onSnoozeApproval: (request: CodexApprovalRequest) => Promise<void>
  hasBlockingRequest: boolean
  loading: boolean
  loadError?: Error
  onRetryLoad: () => void
  onOpenConversation: OpenSubagentConversation
  scrollSnapshot?: ConversationScrollSnapshot
  onScrollSnapshotChange: (snapshot: ConversationScrollSnapshot) => void
  recoveryPhase: ConversationChatEntry['recoveryPhase']
  recoveryError?: Error
  onCreateNewTask: () => void
}

type ComposerComponentProps = ComposerProps & {
  composerContextCatalog: ComposerContextCatalogState
  editingFollowUp: EditingFollowUpSession | null
  onEditingFollowUpChange: (editingFollowUp: EditingFollowUpSession | null) => void
  queueAttached: boolean
  reservedEditingItemId?: string
}

type EditingFollowUpSession = {
  itemId: string
  contextReferences: QueuedUserMessageSnapshotInput['contextReferences']
  trustedContext: QueuedFollowUpTrustedContext
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
}

type IconComponent = FC<{ className?: string }>

const directiveChipIcons: Record<string, IconComponent> = {
  file: FileIcon,
  folder: FolderIcon,
  chat: MessageSquareIcon,
  agent: BotIcon,
  agentRole: BotIcon,
  skill: SparklesIcon,
  plugin: PuzzleIcon,
  app: PackageIcon
}

type RenderTargetScrollEventDetail = {
  targetId?: unknown
  behavior?: ScrollBehavior
  focus?: boolean
}

// `streamdown` and its separately published plugins expose the same runtime
// plugin API, while pnpm correctly preserves their different Shiki type
// copies. Adapt only this composition boundary rather than leaking either
// package's private highlighter types through the renderer.
const streamdownPlugins: PluginConfig = {
  code: code as unknown as PluginConfig['code'],
  math,
  mermaid,
  cjk
}
const streamdownAnimation = {
  animation: 'fadeIn',
  duration: 120,
  sep: 'word' as const,
  stagger: 12
}
const assistantMarkdownComponents = {
  a: InlineReferenceAnchor,
  [inlineReferenceCodeTagName]: InlineReferenceCodeToken
} satisfies Components

const sidebarBaseClass =
  'hidden h-full shrink-0 flex-col overflow-hidden transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex'

const expandedSidebarWidth = 260
const collapsedSidebarHeaderSlotWidth = 48
const conversationHeaderPadding = 16
const collapsedConversationHeaderPadding = collapsedSidebarHeaderSlotWidth + 8
const workspaceHeaderActionFallbackWidth = 64
const workspaceHeaderActionEdgeInset = 8
const workspaceHeaderActionGap = 8

type WorkspaceHeaderActionSlot = {
  width: number
  reportWidth: (width: number) => void
}

const WorkspaceHeaderActionSlotContext = createContext<WorkspaceHeaderActionSlot>({
  width: 0,
  reportWidth: () => undefined
})

const nativeBackdropSurfaceClass =
  'bg-background/50 bg-clip-padding backdrop-blur-xl [@media(prefers-reduced-transparency:reduce)]:bg-background [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none dark:bg-background/30'

const sidebarGlassClass =
  'shadow-[0_18px_60px_-48px_rgba(15,23,42,0.75)] dark:shadow-[0_18px_60px_-48px_rgba(0,0,0,0.95)]'
const activeConversationStorageKey = 'das-cowork.active-conversation.v1'

function useNativeBackdrop(): boolean {
  return window.desktopApp.environment.platform === 'darwin'
}

function readActiveConversationId(): string | undefined {
  try {
    const value = window.sessionStorage.getItem(activeConversationStorageKey)
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

function writeActiveConversationId(conversationId: string): void {
  try {
    window.sessionStorage.setItem(activeConversationStorageKey, conversationId)
  } catch {
    // Session storage is a renderer convenience only; conversation history remains canonical.
  }
}

function clearActiveConversationId(): void {
  try {
    window.sessionStorage.removeItem(activeConversationStorageKey)
  } catch {
    // Session storage is a renderer convenience only; conversation history remains canonical.
  }
}

function workspaceScopeForEntry(
  entry: ConversationChatEntry,
  activeConversation: ActiveConversationContext | undefined
): string {
  return (
    activeConversation?.threadId ??
    entry.context.threadId ??
    activeConversation?.conversationId ??
    entry.context.conversationId ??
    entry.localId
  )
}

function workspaceFallbackScopesForEntry(
  entry: ConversationChatEntry,
  activeConversation: ActiveConversationContext | undefined,
  currentScope: string
): readonly string[] {
  return uniqueWorkspaceScopes(
    [
      activeConversation?.conversationId,
      entry.context.conversationId,
      activeConversation?.threadId,
      entry.context.threadId,
      entry.localId
    ],
    currentScope
  )
}

function uniqueWorkspaceScopes(
  candidates: readonly (string | undefined)[],
  currentScope: string
): readonly string[] {
  const seen = new Set([currentScope])
  return candidates.filter((candidate): candidate is string => {
    if (!candidate || seen.has(candidate)) return false
    seen.add(candidate)
    return true
  })
}

async function runTranscriptAction(
  controller: ConversationTranscriptController,
  action: () => Promise<void>
): Promise<void> {
  try {
    await action()
  } catch (error) {
    // Model and transport failures are already represented in the transcript.
    // assistant-ui does not observe these promises, so avoid a duplicate
    // renderer error after the controller has settled the turn.
    if (controller.getSnapshot().status !== 'error') throw error
  }
}

function createCodeReviewMessage(prompt: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: prompt }]
  }
}

async function sendCodeReviewMessage(
  controller: ConversationTranscriptController,
  prompt: string
): Promise<void> {
  let sendError: unknown
  await runTranscriptAction(controller, async () => {
    try {
      await controller.sendMessageUntilAccepted(createCodeReviewMessage(prompt))
    } catch (error) {
      sendError = error
      throw error
    }
  })
  if (sendError) throw sendError
}

function App(): React.JSX.Element {
  const storedProjectState = useProjectState()
  const storedProjectSelection = storedProjectState.state?.activeProjectSelection
  const persistProjectSelection = storedProjectState.selectProject
  const {
    activeEntry,
    serverRequests,
    activeServerRequests,
    respondToServerRequest,
    rejectServerRequest,
    snoozeServerRequest,
    models,
    selectedModelId,
    modelSelectionError,
    setSelectedModelId,
    activeConversation,
    startNewConversation,
    startNewConversationWithDraft,
    restoreActiveConversation,
    restoreSingleActiveConversation,
    openConversation,
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
    conversationIndicators
  } = useCodexIpcAssistantRuntime({
    projectSelection: storedProjectSelection
  })
  const projectSelectionRevision = useRef(0)
  const selectProject = useCallback(
    async (selection: ProjectSelection) => {
      const revision = ++projectSelectionRevision.current
      const previousSelection = storedProjectSelection
      setActiveProjectSelection(selection)
      try {
        await persistProjectSelection(selection)
      } catch (error) {
        if (projectSelectionRevision.current === revision) {
          setActiveProjectSelection(previousSelection)
        }
        throw error
      }
    },
    [persistProjectSelection, setActiveProjectSelection, storedProjectSelection]
  )
  const projectState = useMemo<ProjectStateController>(
    () => ({ ...storedProjectState, selectProject }),
    [selectProject, storedProjectState]
  )
  const visibleApprovalRequests = useMemo(() => {
    const activeRequestIds = new Set(activeServerRequests.map((request) => request.id))
    const contextlessRequests = serverRequests.filter(
      (request) => !request.context?.threadId && !activeRequestIds.has(request.id)
    )
    return [...activeServerRequests, ...contextlessRequests]
  }, [activeServerRequests, serverRequests])
  const conversationState = useConversationState({
    openConversation,
    syncConversationMetadata
  })
  const restoredActiveConversation = useRef(false)
  const restoringActiveConversation = useRef(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [surface, setSurface] = useState<AppSurface>({ kind: 'conversation' })
  const nativeBackdrop = useNativeBackdrop()

  useEffect(() => {
    if (!conversationState.state.loaded || restoredActiveConversation.current) return
    const conversationId = readActiveConversationId()
    if (!conversationId) {
      restoringActiveConversation.current = true
      void restoreSingleActiveConversation().finally(() => {
        restoredActiveConversation.current = true
        restoringActiveConversation.current = false
      })
      return
    }
    const conversation = conversationState.state.conversations.find(
      (candidate) => candidate.id === conversationId || candidate.threadId === conversationId
    )
    if (conversation) {
      restoredActiveConversation.current = true
      restoringActiveConversation.current = true
      void openConversation({ conversationId: conversation.id }).then(
        () => {
          restoringActiveConversation.current = false
        },
        () => {
          restoringActiveConversation.current = false
        }
      )
      return
    }

    restoringActiveConversation.current = true
    void restoreActiveConversation(conversationId).then(
      (restored) => {
        if (!restored) clearActiveConversationId()
        restoredActiveConversation.current = true
        restoringActiveConversation.current = false
      },
      () => {
        clearActiveConversationId()
        restoredActiveConversation.current = true
        restoringActiveConversation.current = false
      }
    )
  }, [
    conversationState.state.conversations,
    conversationState.state.loaded,
    openConversation,
    restoreActiveConversation,
    restoreSingleActiveConversation
  ])

  useEffect(() => {
    const activeConversationId = activeConversation?.threadId ?? activeConversation?.conversationId
    if (activeConversationId) {
      writeActiveConversationId(activeConversationId)
      return
    }
    if (
      activeEntry.status === 'submitted' ||
      activeEntry.status === 'streaming' ||
      (activeEntry.newConversation && activeEntry.messages.length > 0)
    ) {
      writeActiveConversationId(activeEntry.localId)
      return
    }
    if (!restoredActiveConversation.current || restoringActiveConversation.current) return
  }, [
    activeConversation?.conversationId,
    activeConversation?.threadId,
    activeEntry.localId,
    activeEntry.messages.length,
    activeEntry.newConversation,
    activeEntry.status
  ])

  useEffect(() => {
    const handleRenderTargetScroll = (event: Event): void => {
      const detail = (event as CustomEvent<RenderTargetScrollEventDetail>).detail
      if (typeof detail?.targetId !== 'string' || detail.targetId.length === 0) return

      void scrollToRenderTarget(detail.targetId, {
        behavior: detail.behavior,
        focus: detail.focus
      })
    }

    window.addEventListener('codex:scroll-render-target', handleRenderTargetScroll)
    return () => window.removeEventListener('codex:scroll-render-target', handleRenderTargetScroll)
  }, [])

  const toggleSidebar = (): void => {
    setSidebarCollapsed((collapsed) => !collapsed)
  }
  const handleSelectedModelChange = (modelId: string): void => {
    void setSelectedModelId(modelId).catch(() => undefined)
  }
  const handleStartNewConversation = useCallback((): void => {
    setSurface({ kind: 'conversation' })
    clearActiveConversationId()
    startNewConversation()
  }, [startNewConversation])
  const handleActivatePluginPrompt = useCallback(
    ({ mention, prompt }: { mention: { path: string; name: string }; prompt: string }): void => {
      const directive = serializeComposerContextReference({
        type: 'plugin',
        path: mention.path,
        label: mention.name,
        mentionName: mention.name
      })
      setSurface({ kind: 'conversation' })
      clearActiveConversationId()
      startNewConversationWithDraft(`${directive} ${prompt}`)
    },
    [startNewConversationWithDraft]
  )
  const handleTryApp = useCallback(
    ({ mention }: { mention: { path: string; name: string } }): void => {
      const directive = serializeComposerContextReference({
        type: 'app',
        path: mention.path,
        label: mention.name,
        mentionName: mention.name
      })
      setSurface({ kind: 'conversation' })
      clearActiveConversationId()
      startNewConversationWithDraft(directive)
    },
    [startNewConversationWithDraft]
  )
  const handleTrySkill = useCallback(
    ({ mention }: { mention: { path: string; name: string } }): void => {
      const directive = serializeComposerContextReference({
        type: 'skill',
        path: mention.path,
        label: mention.name,
        mentionName: mention.name
      })
      setSurface({ kind: 'conversation' })
      clearActiveConversationId()
      startNewConversationWithDraft(directive)
    },
    [startNewConversationWithDraft]
  )
  const handleOpenConversation = useCallback<OpenSubagentConversation>(
    (conversationId) => {
      setSurface({ kind: 'conversation' })
      void openConversation({ conversationId })
    },
    [openConversation]
  )
  const gitRepositoryIdentity = useMemo(
    () => ({
      conversationId: activeConversation?.conversationId ?? activeEntry.context.conversationId,
      ...((activeConversation?.threadId ?? activeEntry.context.threadId)
        ? { threadId: activeConversation?.threadId ?? activeEntry.context.threadId }
        : {})
    }),
    [
      activeConversation?.conversationId,
      activeConversation?.threadId,
      activeEntry.context.conversationId,
      activeEntry.context.threadId
    ]
  )
  const preSendProjectKey =
    activeConversation?.threadId || activeEntry.context.threadId
      ? undefined
      : JSON.stringify(storedProjectSelection ?? null)
  const workspaceProjectScope = workspaceScopeForEntry(activeEntry, activeConversation)
  const fallbackWorkspaceProjectScopes = workspaceFallbackScopesForEntry(
    activeEntry,
    activeConversation,
    workspaceProjectScope
  )
  const pluginCenterCwd = resolvePluginCenterLocalCwd(
    activeConversation,
    activeEntry,
    storedProjectState.state
  )

  useEffect(() => {
    const pluginApi = window.desktopApp.plugins
    const unsubscribe = subscribePluginCenterData(pluginApi, pluginCenterCwd, () => undefined)
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const prefetch = (): void => {
      void prefetchPluginCenterData(pluginApi, pluginCenterCwd).catch(() => undefined)
    }
    let idleHandle: number | undefined
    let timeoutHandle: number | undefined
    if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(prefetch)
    } else {
      timeoutHandle = window.setTimeout(prefetch, 50)
    }

    return () => {
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle)
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle)
      unsubscribe()
    }
  }, [pluginCenterCwd])

  return (
    <main
      className={cn(
        'relative flex h-screen w-full text-foreground',
        nativeBackdrop ? 'bg-background/10 dark:bg-background/10' : 'bg-muted/30'
      )}
    >
      <SidebarHeaderSlot collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      <CodexSidebar
        collapsed={sidebarCollapsed}
        nativeBackdrop={nativeBackdrop}
        projectState={projectState}
        conversationState={conversationState}
        conversationIndicators={conversationIndicators}
        onNewChat={handleStartNewConversation}
        onOpenConversation={handleOpenConversation}
        onOpenPlugins={() => setSurface({ kind: 'pluginCenter', page: 'browse', tab: 'plugins' })}
        pluginsActive={surface.kind === 'pluginCenter'}
      />
      {surface.kind === 'pluginCenter' ? (
        <section
          data-slot="app-main-section"
          className={cn(
            'relative flex min-w-0 flex-1 overflow-hidden',
            nativeBackdrop && nativeBackdropSurfaceClass
          )}
        >
          <PluginCenterPage
            surface={surface}
            onSurfaceChange={(nextSurface) => setSurface({ kind: 'pluginCenter', ...nextSurface })}
            cwd={pluginCenterCwd}
            threadId={activeConversation?.threadId ?? activeEntry.context.threadId}
            onActivatePluginPrompt={handleActivatePluginPrompt}
            onTryApp={handleTryApp}
            onTrySkill={handleTrySkill}
          />
        </section>
      ) : (
        <RightWorkspaceProvider
          key={workspaceProjectScope}
          projectScope={workspaceProjectScope}
          fallbackProjectScopes={fallbackWorkspaceProjectScopes}
        >
          <ArtifactConversationBridgeProvider>
            <GitRepositoryProvider
              identity={gitRepositoryIdentity}
              preSendProjectKey={preSendProjectKey}
            >
              <LocalGitReviewProvider>
                <CommitOrPushControlProvider>
                  <section
                    data-slot="app-main-section"
                    className={cn(
                      'relative flex min-w-0 flex-1 overflow-hidden',
                      nativeBackdrop && nativeBackdropSurfaceClass
                    )}
                  >
                    <ConversationWorkspaceLayout
                      target={gitRepositoryIdentity}
                      workspaceId={`conversation:${workspaceProjectScope}`}
                    >
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border/50 bg-background shadow-[0_18px_60px_-48px_rgba(15,23,42,0.75)]">
                        <ActiveConversationPane
                          key={activeEntry.localId}
                          activeConversation={activeConversation}
                          entry={activeEntry}
                          approvalRequests={visibleApprovalRequests}
                          hasBlockingRequest={visibleApprovalRequests.length > 0}
                          models={models}
                          selectedModelId={selectedModelId}
                          modelSelectionError={modelSelectionError}
                          onDraftChange={setActiveDraft}
                          onDraftAttachmentsChange={setActiveDraftAttachments}
                          onComposerModeKindChange={setActiveComposerModeKind}
                          onApprovalModeKindChange={setActiveApprovalModeKind}
                          onGoalEditorActiveChange={setActiveGoalEditorActive}
                          onThreadGoalChange={setActiveThreadGoal}
                          onGoalOperationChange={setActiveGoalOperation}
                          onRetryLoad={() => {
                            void openConversation({ conversationId: activeEntry.localId })
                          }}
                          onOpenConversation={handleOpenConversation}
                          onScrollSnapshotChange={setActiveScroll}
                          onSelectedModelChange={handleSelectedModelChange}
                          onCreateNewTask={handleStartNewConversation}
                          onRejectApproval={rejectServerRequest}
                          onSnoozeApproval={snoozeServerRequest}
                          onRespondApproval={respondToServerRequest}
                          projectState={projectState}
                          sidebarCollapsed={sidebarCollapsed}
                        />
                      </div>
                    </ConversationWorkspaceLayout>
                  </section>
                </CommitOrPushControlProvider>
              </LocalGitReviewProvider>
            </GitRepositoryProvider>
          </ArtifactConversationBridgeProvider>
        </RightWorkspaceProvider>
      )}
    </main>
  )
}

function ActiveConversationPane({
  activeConversation,
  entry,
  approvalRequests,
  hasBlockingRequest,
  models,
  selectedModelId,
  modelSelectionError,
  onDraftChange,
  onDraftAttachmentsChange,
  onComposerModeKindChange,
  onApprovalModeKindChange,
  onGoalEditorActiveChange,
  onThreadGoalChange,
  onGoalOperationChange,
  onRetryLoad,
  onOpenConversation,
  onScrollSnapshotChange,
  onSelectedModelChange,
  onCreateNewTask,
  onRejectApproval,
  onSnoozeApproval,
  onRespondApproval,
  projectState,
  sidebarCollapsed
}: {
  activeConversation: ActiveConversationContext | undefined
  entry: ConversationChatEntry
  approvalRequests: readonly CodexApprovalRequest[]
  hasBlockingRequest: boolean
  models: readonly ModelOption[]
  selectedModelId: string | undefined
  modelSelectionError?: string
  onDraftChange: (draft: string) => void
  onDraftAttachmentsChange: (attachments: readonly ConversationDraftAttachment[]) => void
  onComposerModeKindChange: (composerModeKind: ConversationChatEntry['composerModeKind']) => void
  onApprovalModeKindChange: (approvalModeKind: ConversationChatEntry['approvalModeKind']) => void
  onGoalEditorActiveChange: (goalEditorActive: boolean) => void
  onThreadGoalChange: (threadGoal: ConversationChatEntry['threadGoal']) => void
  onGoalOperationChange: (
    goalOperation: ConversationChatEntry['goalOperation'],
    goalError?: string
  ) => void
  onRetryLoad: () => void
  onOpenConversation: OpenSubagentConversation
  onScrollSnapshotChange: (snapshot: ConversationScrollSnapshot) => void
  onSelectedModelChange: (modelId: string) => void
  onCreateNewTask: () => void
  onRejectApproval: (request: CodexApprovalRequest) => Promise<void>
  onSnoozeApproval: (request: CodexApprovalRequest) => Promise<void>
  onRespondApproval: (
    request: CodexApprovalRequest,
    response: CodexApprovalResponse
  ) => Promise<void>
  projectState: ProjectStateController
  sidebarCollapsed: boolean
}): React.JSX.Element {
  countConversationStreamPerformance('activeConversationPane')
  const transcriptSnapshot = useSyncExternalStore(
    entry.controller.subscribe,
    entry.controller.getSnapshot,
    entry.controller.getSnapshot
  )
  useLayoutEffect(() => {
    markConversationStreamCommit(entry.controller.id, transcriptSnapshot.version)
    scheduleConversationStreamNextFrame(entry.controller.id, transcriptSnapshot.version)
  }, [entry.controller, transcriptSnapshot.version])
  const reloadInFlight = useRef<{ entryId: string; request: symbol } | null>(null)
  const saveThreadGoal = useCallback(
    async (objective: string, hasAttachments = false): Promise<boolean> => {
      const trimmedObjective = objective.trim()
      const threadId = entry.context.threadId
      if (!threadId) {
        onGoalOperationChange('idle', '当前对话尚未创建，无法保存目标')
        return false
      }
      if (!trimmedObjective) {
        onGoalOperationChange('idle', '请输入目标后再保存')
        return false
      }
      if (hasAttachments) {
        onGoalOperationChange('idle', '目标只能包含文字，请先移除附件')
        return false
      }
      if ([...trimmedObjective].length > 4_000) {
        onGoalOperationChange('idle', '目标不能超过 4,000 个字符')
        return false
      }

      onGoalOperationChange('setting')
      try {
        if (
          transcriptSnapshot.status === 'submitted' ||
          transcriptSnapshot.status === 'streaming'
        ) {
          const goal = await window.desktopApp.conversations.setConversationGoal({
            conversationId: threadId,
            objective: trimmedObjective
          })
          onThreadGoalChange(goal)
          onGoalEditorActiveChange(false)
          return true
        }

        onDraftChange(trimmedObjective)
        onGoalEditorActiveChange(true)
        await runTranscriptAction(entry.controller, () =>
          entry.controller.startGoalControlUntilAccepted()
        )
        return true
      } catch {
        onGoalOperationChange('idle', '无法保存目标，请稍后重试')
        return false
      }
    },
    [
      entry,
      onDraftChange,
      onGoalEditorActiveChange,
      onGoalOperationChange,
      onThreadGoalChange,
      transcriptSnapshot.status
    ]
  )
  const isRunning =
    transcriptSnapshot.status === 'submitted' || transcriptSnapshot.status === 'streaming'
  const messageCount = transcriptSnapshot.messages.length
  const runtime = useExternalStoreRuntime<ConversationTranscriptMessage>({
    messages: transcriptSnapshot.messages,
    isRunning,
    isDisabled: !entry.loaded,
    convertMessage: useCallback(
      (message, index) =>
        transcriptMessageToThreadMessageLike(message, index === messageCount - 1 && isRunning),
      [isRunning, messageCount]
    ),
    onNew: async (message) => {
      const submittedMessage = appendMessageToUIMessage(message)
      if (entry.goalEditorActive && entry.context.threadId) {
        const hasNonTextPart = submittedMessage.parts.some((part) => part.type !== 'text')
        const objective = submittedMessage.parts
          .filter(
            (
              part
            ): part is Extract<UIMessagePart<Record<string, unknown>, never>, { type: 'text' }> =>
              part.type === 'text'
          )
          .map((part) => part.text)
          .join('\n')
          .trim()
        await saveThreadGoal(objective, hasNonTextPart)
        return
      }
      await runTranscriptAction(entry.controller, () =>
        entry.controller.sendMessage(submittedMessage, {
          metadata: message.runConfig
        })
      )
    },
    onEdit: async (message) => {
      await runTranscriptAction(entry.controller, () =>
        entry.controller.editMessage(message.parentId, appendMessageToUIMessage(message), {
          metadata: message.runConfig
        })
      )
    },
    onReload: async (parentId, config) => {
      if (reloadInFlight.current?.entryId === entry.localId) return
      const request = Symbol('conversation-reload')
      reloadInFlight.current = { entryId: entry.localId, request }
      try {
        await entry.controller.regenerate(parentId, { metadata: config.runConfig })
      } catch {
        // The controller projects the failure back into the transcript. The
        // assistant-ui reload action does not observe this promise, so do not
        // leak a duplicate unhandled rejection into the renderer.
      } finally {
        if (reloadInFlight.current?.request === request) reloadInFlight.current = null
      }
    },
    onCancel: () => entry.controller.stop(),
    adapters: { attachments: imageAttachmentAdapter }
  })
  const conversationKey = entry.context.threadId ?? entry.context.conversationId
  const followUps = useConversationFollowUps({
    api: window.desktopApp.followUps,
    conversationKey
  })
  const steerFollowUp = useCallback(
    async (
      itemId: string,
      message:
        | MaterializedQueuedUserMessage
        | QueuedUserMessageSnapshot
        | QueuedUserMessageSnapshotInput
    ): Promise<void> => {
      await steerFollowUpItemWithTranscript(message, entry, () => followUps.steerItem(itemId))
    },
    [entry, followUps]
  )
  const startCodeReview = useCallback(
    async (prompt: string): Promise<void> => {
      await sendCodeReviewMessage(entry.controller, prompt)
    },
    [entry.controller]
  )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ArtifactConversationActionsRegistrar entry={entry} />
      <ConversationDraftBridge
        draft={entry.draft}
        draftAttachments={entry.draftAttachments}
        status={transcriptSnapshot.status}
        onDraftChange={onDraftChange}
        onDraftAttachmentsChange={onDraftAttachmentsChange}
      />
      <ConversationFocusBridge entryId={entry.localId} />
      <Header
        activeConversation={activeConversation}
        projectState={projectState}
        sidebarCollapsed={sidebarCollapsed}
      />
      <ChatThread
        activeConversation={activeConversation}
        approvalRequests={approvalRequests}
        disabled={!entry.loaded}
        followUps={followUps}
        hasBlockingRequest={hasBlockingRequest}
        loading={entry.status === 'loading'}
        loadError={!entry.loaded ? entry.error : undefined}
        models={models}
        selectedModelId={selectedModelId}
        modelSelectionError={modelSelectionError}
        onSteerFollowUp={steerFollowUp}
        onRetryLoad={onRetryLoad}
        onOpenConversation={onOpenConversation}
        onScrollSnapshotChange={onScrollSnapshotChange}
        onSelectedModelChange={onSelectedModelChange}
        onCreateNewTask={onCreateNewTask}
        onStartCodeReview={startCodeReview}
        composerModeKind={entry.composerModeKind}
        approvalModeKind={entry.approvalModeKind}
        goalEditorActive={entry.goalEditorActive}
        threadGoal={entry.threadGoal}
        goalCapabilityStatus={entry.goalCapabilityStatus}
        goalOperation={entry.goalOperation}
        goalError={entry.goalError}
        onComposerModeKindChange={onComposerModeKindChange}
        onApprovalModeKindChange={onApprovalModeKindChange}
        onGoalEditorActiveChange={onGoalEditorActiveChange}
        onThreadGoalChange={onThreadGoalChange}
        onGoalOperationChange={onGoalOperationChange}
        onSaveThreadGoal={saveThreadGoal}
        onRejectApproval={onRejectApproval}
        onSnoozeApproval={onSnoozeApproval}
        onRespondApproval={onRespondApproval}
        projectState={projectState}
        scrollSnapshot={entry.scroll}
        recoveryPhase={entry.recoveryPhase}
        recoveryError={entry.recoveryError}
      />
    </AssistantRuntimeProvider>
  )
}

function ArtifactConversationActionsRegistrar({ entry }: { entry: ConversationChatEntry }): null {
  const aui = useAui()
  const { register } = useArtifactConversationBridge()
  const composerText = useAuiState((state) => state.composer.text)
  const composerAttachments = useAuiState((state) => state.composer.attachments)
  const composerAttachmentIds = useMemo(
    () => composerAttachments.map((attachment) => attachment.id),
    [composerAttachments]
  )
  const composerTextRef = useRef(composerText)

  useEffect(() => {
    composerTextRef.current = composerText
  }, [composerText])

  useEffect(
    () =>
      register({
        conversationId: entry.context.conversationId,
        addToComposer: async (reference, annotation) => {
          if (
            !composerAttachmentIds.some(
              (id) => artifactSourceAttachmentIdentityFromId(id)?.sourceId === reference.sourceId
            )
          ) {
            const result = await window.desktopApp.workspace.artifacts.createComposerAttachment({
              version: 1,
              sourceId: reference.sourceId
            })
            await aui.composer().addAttachment(createArtifactSourceAttachment(result.attachment))
          }
          const context = artifactConversationText(reference, annotation)
          const current = composerTextRef.current.trim()
          if (current.includes(context)) return
          aui.composer().setText(current ? `${current}\n\n${context}` : context)
        },
        directSubmit: async (reference, annotation: ArtifactAnnotation) => {
          const result = await window.desktopApp.workspace.artifacts.createComposerAttachment({
            version: 1,
            sourceId: reference.sourceId
          })
          await runTranscriptAction(entry.controller, () =>
            entry.controller.sendMessage({
              id: `artifact-direct-${annotation.id}`,
              role: 'user',
              parts: [
                { type: 'text', text: artifactConversationText(reference, annotation) },
                {
                  type: 'file',
                  filename: result.attachment.label,
                  mediaType: localFileAttachmentMediaType,
                  url: result.attachment.url
                }
              ]
            })
          )
        }
      }),
    [aui, composerAttachmentIds, entry, register]
  )
  return null
}

function ConversationWorkspaceLayout({
  children,
  target,
  workspaceId
}: {
  children: ReactNode
  target: GitConversationTarget
  workspaceId: string
}): React.JSX.Element {
  countConversationStreamPerformance('conversationWorkspaceLayout')
  const container = useWorkspaceContainer()
  const registry = useMemo(() => createWorkspaceContentRegistry(), [])
  const terminalCloseDialog = useTerminalCloseDialog()
  const [workspaceHeaderActionWidth, setWorkspaceHeaderActionWidth] = useState(0)
  const reportWorkspaceHeaderActionWidth = useCallback((width: number): void => {
    setWorkspaceHeaderActionWidth((currentWidth) => (currentWidth === width ? currentWidth : width))
  }, [])
  const workspaceHeaderActionSlot = useMemo(
    () => ({
      width: workspaceHeaderActionWidth,
      reportWidth: reportWorkspaceHeaderActionWidth
    }),
    [reportWorkspaceHeaderActionWidth, workspaceHeaderActionWidth]
  )
  const controller = new WorkspacePanelController({
    getState: () => container.state,
    dispatch: container.dispatch,
    registry,
    workspaceId,
    confirmTerminalClose: terminalCloseDialog.confirm
  })
  useWorkspaceShortcuts(container, controller)

  useEffect(() => {
    const clearFocusedTerminal = (): void => {
      clearActiveTerminalView()
    }
    window.addEventListener(CLEAR_ACTIVE_TERMINAL_EVENT, clearFocusedTerminal)
    return () => window.removeEventListener(CLEAR_ACTIVE_TERMINAL_EVENT, clearFocusedTerminal)
  }, [])

  useEffect(() => {
    return () => {
      // Some renderer-only test harnesses deliberately omit desktop-only APIs.
      // The production preload always exposes this bridge.
      void window.desktopApp.workspace?.dispose({ version: 1, workspaceId })
    }
  }, [workspaceId])

  const renderPanel = (panelId: WorkspacePanelId): React.JSX.Element => {
    const panel = container.state.panels[panelId]
    const tabs = container.panelTabs(panelId)
    return (
      <WorkspacePanelShell
        panelId={panelId}
        panel={panel}
        tabs={tabs}
        renderLauncher={() => (
          <WorkspaceLauncher
            onOpen={(openTarget) => void controller.open(openTarget, { panelId })}
          />
        )}
        renderTab={(tab) =>
          tab ? (
            <WorkspacePreviewBoundary
              tab={tab}
              onPin={() => container.dispatch({ type: 'pin-tab', tabId: tab.id })}
            >
              {registry.render(tab, {
                panelId,
                panel,
                workspaceId,
                target,
                runtime: container.tabRuntime(tab.id),
                openTarget: (openTarget: WorkspaceOpenTarget, options: WorkspaceOpenOptions = {}) =>
                  void controller.open(openTarget, { ...options, panelId }),
                setTabTitle: (tabId, title) =>
                  container.dispatch({ type: 'set-tab-title', tabId, title }),
                setRuntime: (tabId, runtime) =>
                  container.dispatch({ type: 'set-tab-runtime', tabId, runtime })
              })}
            </WorkspacePreviewBoundary>
          ) : null
        }
        onActivate={(tabId) => void controller.activate(panelId, tabId)}
        onClose={(tabId) => void controller.close(panelId, tabId)}
        onCloseOther={(tabId) => void controller.closeOther(panelId, tabId)}
        onCloseToRight={(tabId) => void controller.closeToRight(panelId, tabId)}
        onPin={(tabId) => container.dispatch({ type: 'pin-tab', tabId })}
        onOpen={(openTarget) => void controller.open(openTarget, { panelId })}
        onMove={(sourcePanelId, destinationPanelId, tabId, insertAfterTabId) =>
          void controller.move(sourcePanelId, destinationPanelId, tabId, insertAfterTabId)
        }
        onSetSize={(size) => container.dispatch({ type: 'set-panel-size', panelId, size })}
        onSetOpen={(isOpen) => container.dispatch({ type: 'set-panel-open', panelId, isOpen })}
        onFocus={(focusedPanelId) =>
          container.dispatch({ type: 'set-last-focused-panel', panelId: focusedPanelId })
        }
        onOverlayVisibilityChange={(visible) =>
          setPanelBrowserVisibility(container, panelId, visible)
        }
      />
    )
  }

  return (
    <WorkspaceHeaderActionSlotContext.Provider value={workspaceHeaderActionSlot}>
      <WorkspaceHeaderActions
        onOpenBottomTerminal={() =>
          void controller.open({ type: 'terminal' }, { panelId: 'bottom' })
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div data-slot="conversation-workspace-row" className="flex min-h-0 min-w-0 flex-1">
          {children}
          {renderPanel('right')}
        </div>
        {renderPanel('bottom')}
      </div>
      <WorkspaceCloseGuardDialog
        tabs={terminalCloseDialog.tabs}
        onDecision={terminalCloseDialog.decide}
      />
    </WorkspaceHeaderActionSlotContext.Provider>
  )
}

function useWorkspaceShortcuts(
  container: ReturnType<typeof useWorkspaceContainer>,
  controller: WorkspacePanelController
): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isWorkspaceEditableTarget(event.target)) return
      const panelId = container.state.lastFocusedPanelId
      const panel = container.state.panels[panelId]
      const open = (target: WorkspaceOpenTarget, options: WorkspaceOpenOptions = {}): void => {
        event.preventDefault()
        void controller.open(target, { ...options, panelId: options.panelId ?? panelId })
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey) {
        switch (event.key.toLowerCase()) {
          case 'r':
            open({ type: 'review' })
            return
          case 't':
            open({ type: 'terminal' }, { panelId: 'bottom' })
            return
          case 'b':
            open({ type: 'browser' })
            return
          case 'w':
            if (panel.activeTabId) {
              event.preventDefault()
              void controller.close(panelId, panel.activeTabId)
            }
            return
        }
      }
      if (!event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key !== 'PageUp' && event.key !== 'PageDown') return
      const adjacent = adjacentWorkspaceTabId(
        panel.tabIds,
        panel.activeTabId,
        event.key === 'PageUp' ? -1 : 1
      )
      if (!adjacent) return
      event.preventDefault()
      void controller.activate(panelId, adjacent)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [container, controller])
}

export function WorkspacePreviewBoundary({
  children,
  onPin,
  tab
}: {
  children: ReactNode
  onPin(): void
  tab: WorkspaceTabRecord
}): React.JSX.Element {
  const pinIfContentInteraction = (target: EventTarget | null): void => {
    if (!tab.isPreview) return
    if (!(target instanceof Element) || target.closest('[data-tab-preview-pin-exempt]')) return
    onPin()
  }
  return (
    <div
      className="h-full"
      {...(tab.isPreview ? { 'data-workspace-preview': 'true' } : {})}
      onKeyDownCapture={
        tab.isPreview ? (event) => pinIfContentInteraction(event.target) : undefined
      }
      onPointerDownCapture={
        tab.isPreview ? (event) => pinIfContentInteraction(event.target) : undefined
      }
    >
      {children}
    </div>
  )
}

function setPanelBrowserVisibility(
  container: ReturnType<typeof useWorkspaceContainer>,
  panelId: WorkspacePanelId,
  visible: boolean
): void {
  const tab = container.activeTab(panelId)
  const viewId = tab?.kind === 'browser' ? container.tabRuntime(tab.id)?.browserViewId : undefined
  if (typeof viewId !== 'string') return
  void window.desktopApp.workspace.browser[visible ? 'hide' : 'show']({ version: 1, viewId })
}

function useTerminalCloseDialog(): {
  tabs: readonly WorkspaceTabRecord[]
  confirm(tabs: readonly WorkspaceTabRecord[]): Promise<boolean>
  decide(confirmed: boolean): void
} {
  const [tabs, setTabs] = useState<readonly WorkspaceTabRecord[]>([])
  const resolveRef = useRef<((confirmed: boolean) => void) | undefined>(undefined)
  const confirm = useCallback(
    (nextTabs: readonly WorkspaceTabRecord[]) =>
      new Promise<boolean>((resolve) => {
        resolveRef.current = resolve
        setTabs(nextTabs)
      }),
    []
  )
  const decide = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed)
    resolveRef.current = undefined
    setTabs([])
  }, [])
  useEffect(() => () => resolveRef.current?.(false), [])
  return { tabs, confirm, decide }
}

function WorkspaceCloseGuardDialog({
  tabs,
  onDecision
}: {
  tabs: readonly WorkspaceTabRecord[]
  onDecision(confirmed: boolean): void
}): React.JSX.Element {
  const open = tabs.length > 0
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onDecision(false)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>关闭正在运行的终端？</DialogTitle>
          <DialogDescription>
            {tabs.length === 1
              ? '关闭该标签会终止正在运行的终端进程。'
              : `关闭这 ${tabs.length} 个标签会终止其中正在运行的终端进程。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onDecision(false)}>
            取消
          </Button>
          <Button type="button" variant="destructive" onClick={() => onDecision(true)}>
            关闭终端
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CodexSidebar = memo(function CodexSidebar({
  collapsed,
  nativeBackdrop,
  projectState,
  conversationState,
  conversationIndicators,
  onNewChat,
  onOpenConversation,
  onOpenPlugins,
  pluginsActive
}: CodexSidebarProps): React.JSX.Element {
  return (
    <ConversationRuntimeIndicatorProvider store={conversationIndicators}>
      <aside
        data-slot="codex-sidebar"
        aria-hidden={collapsed}
        inert={collapsed}
        className={cn(
          sidebarBaseClass,
          nativeBackdrop && nativeBackdropSurfaceClass,
          nativeBackdrop && sidebarGlassClass
        )}
        style={{ width: collapsed ? 0 : expandedSidebarWidth }}
      >
        <div className="relative min-h-0 flex-1 overflow-hidden pt-14">
          <SidebarRoot
            nativeBackdrop={nativeBackdrop}
            projectState={projectState}
            conversationState={conversationState}
            onNewChat={onNewChat}
            onOpenConversation={onOpenConversation}
            onOpenPlugins={onOpenPlugins}
            pluginsActive={pluginsActive}
          />
        </div>
      </aside>
    </ConversationRuntimeIndicatorProvider>
  )
})

function SidebarHeaderSlot({ collapsed, onToggle }: SidebarHeaderSlotProps): React.JSX.Element {
  const toggleLabel = collapsed ? '显示侧栏' : '隐藏侧栏'

  return (
    <div
      data-slot="sidebar-header-slot"
      className="pointer-events-none absolute top-0 left-0 z-30 hidden h-12 items-center overflow-hidden px-2 transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex"
      style={{
        width: collapsed ? collapsedSidebarHeaderSlotWidth : expandedSidebarWidth,
        minWidth: collapsedSidebarHeaderSlotWidth
      }}
    >
      <div
        aria-hidden={collapsed}
        className={cn(
          'absolute left-2 min-w-0 transition-opacity duration-150 motion-reduce:transition-none',
          collapsed ? 'opacity-0' : 'opacity-100'
        )}
      >
        <Logo />
      </div>
      <IconButton
        data-slot="sidebar-toggle"
        className="pointer-events-auto ml-auto hidden md:grid"
        label={toggleLabel}
        title={toggleLabel}
        style={{ viewTransitionName: 'sidebar-trigger' }}
        onClick={onToggle}
      >
        <PanelLeftIcon className="size-4" />
      </IconButton>
    </div>
  )
}

function Logo(): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2 text-sm">
      <BrandMark />
      <span className="min-w-0 truncate text-foreground/90">Codex</span>
    </div>
  )
}

function BrandMark(): React.JSX.Element {
  return (
    <div className="grid size-5 shrink-0 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground">
      C
    </div>
  )
}

function Header({
  activeConversation,
  projectState,
  sidebarCollapsed
}: HeaderProps & { projectState: ProjectStateController }): React.JSX.Element {
  const { state: workspaceState } = useRightWorkspace()
  const { width: workspaceHeaderActionWidth } = useContext(WorkspaceHeaderActionSlotContext)
  const workspaceHeaderActionSpace =
    workspaceHeaderActionWidth || workspaceHeaderActionFallbackWidth

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-2 transition-[padding] duration-200 ease-out motion-reduce:transition-none"
      style={{
        paddingLeft: sidebarCollapsed
          ? collapsedConversationHeaderPadding
          : conversationHeaderPadding,
        // When the right workspace is open, its column already bounds this
        // header. When it is closed, reserve the actual header action rail so
        // the summary trigger occupies the adjacent header action slot.
        paddingRight: workspaceState.isOpen
          ? conversationHeaderPadding
          : workspaceHeaderActionSpace + workspaceHeaderActionEdgeInset + workspaceHeaderActionGap
      }}
    >
      <ConversationContextText activeConversation={activeConversation} />
      {!activeConversation ? <ThreadTitle /> : null}
      <div className="ml-auto flex shrink-0 items-center">
        <ConversationPinnedSummary
          selection={
            activeConversation?.projectSelection ?? projectState.state?.activeProjectSelection
          }
          taskStarted={Boolean(activeConversation?.threadId)}
        />
      </div>
    </header>
  )
}

function WorkspaceHeaderActions({
  onOpenBottomTerminal
}: {
  onOpenBottomTerminal(): void
}): React.JSX.Element {
  const { collapse, restore, state, toggleMaximized } = useRightWorkspace()
  const container = useWorkspaceContainer()
  const { reportWidth } = useContext(WorkspaceHeaderActionSlotContext)
  const actionRailRef = useRef<HTMLDivElement>(null)
  const toggleLabel = state.isOpen ? '关闭工作区' : '打开工作区'
  const maximizeLabel = state.isMaximized ? '恢复工作区宽度' : '最大化工作区'
  const bottomOpen = container.state.panels.bottom.isOpen
  const bottomToggleLabel = bottomOpen ? '关闭底部工作区' : '打开底部工作区'
  const toggleBottomWorkspace = (): void => {
    if (bottomOpen) {
      container.dispatch({ type: 'set-panel-open', panelId: 'bottom', isOpen: false })
      return
    }
    if (container.state.panels.bottom.tabIds.length === 0) {
      onOpenBottomTerminal()
      return
    }
    container.dispatch({ type: 'set-panel-open', panelId: 'bottom', isOpen: true })
  }
  const measureActionRail = useCallback((): void => {
    const width = actionRailRef.current?.getBoundingClientRect().width ?? 0
    reportWidth(Math.round(width))
  }, [reportWidth])

  useLayoutEffect(() => {
    measureActionRail()
    const actionRail = actionRailRef.current
    if (!actionRail || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measureActionRail)
    observer.observe(actionRail)
    return () => observer.disconnect()
  }, [measureActionRail])

  return (
    <div
      data-slot="workspace-header-actions"
      ref={actionRailRef}
      className="absolute top-2 right-2 z-50 flex items-center"
    >
      <div
        aria-hidden={!state.isOpen}
        inert={!state.isOpen}
        className="flex justify-end overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: state.isOpen ? 40 : 0, opacity: state.isOpen ? 1 : 0 }}
      >
        <IconButton label={maximizeLabel} title={maximizeLabel} onClick={toggleMaximized}>
          {state.isMaximized ? (
            <Minimize2Icon className="size-4" />
          ) : (
            <Maximize2Icon className="size-4" />
          )}
        </IconButton>
      </div>
      <IconButton
        label={bottomToggleLabel}
        title={bottomToggleLabel}
        onClick={toggleBottomWorkspace}
      >
        {bottomOpen ? (
          <PanelBottomCloseIcon className="size-4" />
        ) : (
          <PanelBottomOpenIcon className="size-4" />
        )}
      </IconButton>
      <IconButton
        data-slot="workspace-toggle"
        label={toggleLabel}
        title={toggleLabel}
        style={{ viewTransitionName: 'workspace-trigger' }}
        onClick={state.isOpen ? collapse : restore}
      >
        <span className="relative size-4" aria-hidden="true">
          <PanelRightOpenIcon
            className={cn(
              'absolute inset-0 size-4 transition-opacity duration-150 motion-reduce:transition-none',
              state.isOpen ? 'opacity-0' : 'opacity-100'
            )}
          />
          <PanelRightCloseIcon
            className={cn(
              'absolute inset-0 size-4 transition-opacity duration-150 motion-reduce:transition-none',
              state.isOpen ? 'opacity-100' : 'opacity-0'
            )}
          />
        </span>
      </IconButton>
    </div>
  )
}

function ConversationContextText({
  activeConversation
}: {
  activeConversation?: ActiveConversationContext
}): React.JSX.Element | null {
  if (!activeConversation) return null

  const title = activeConversation.title ?? 'New Chat'

  return (
    <span className="min-w-0 truncate text-sm font-medium text-foreground" title={title}>
      {title}
    </span>
  )
}

function ThreadTitle(): React.JSX.Element | null {
  const title = useAuiState(
    (state) =>
      state.threads.threadItems.find((thread) => thread.id === state.threads.mainThreadId)?.title
  )

  if (!title) return null

  return <span className="min-w-0 truncate text-sm font-medium">{title}</span>
}

function isNewChatView(state: AssistantState): boolean {
  return state.thread.messages.length === 0 && (!state.thread.isLoading || state.threads.isLoading)
}

function latestRunningAssistantMessage(
  state: AssistantState
): AssistantState['thread']['messages'][number] | undefined {
  return state.thread.messages.findLast(
    (message) => message.role === 'assistant' && message.status?.type === 'running'
  )
}

function ChatThread({
  activeConversation,
  approvalRequests,
  disabled,
  followUps,
  hasBlockingRequest,
  loading,
  loadError,
  models,
  selectedModelId,
  modelSelectionError,
  onRetryLoad,
  onOpenConversation,
  onSelectedModelChange,
  onSteerFollowUp,
  onStartCodeReview,
  projectState,
  scrollSnapshot,
  onScrollSnapshotChange,
  recoveryPhase,
  recoveryError,
  onCreateNewTask,
  composerModeKind,
  approvalModeKind,
  goalEditorActive,
  threadGoal,
  goalCapabilityStatus,
  goalOperation,
  goalError,
  onComposerModeKindChange,
  onApprovalModeKindChange,
  onGoalEditorActiveChange,
  onThreadGoalChange,
  onGoalOperationChange,
  onSaveThreadGoal,
  onRejectApproval,
  onSnoozeApproval,
  onRespondApproval
}: ChatThreadProps): React.JSX.Element {
  countConversationStreamPerformance('chatThread')
  const isEmpty = useAuiState(isNewChatView)
  const showNewConversationView = isEmpty && !loading && !loadError
  const canChangeProject = showNewConversationView && !activeConversation?.threadId
  const viewportRef = useRef<HTMLDivElement>(null)
  useViewportIdentityProbe(viewportRef)
  const aui = useAui()
  const composerText = useAuiState((state) => state.composer.text)
  const composerAttachments = useAuiState((state) => state.composer.attachments)
  const [editingFollowUp, setEditingFollowUp] = useState<EditingFollowUpSession | null>(null)
  const scrollRestoreKey =
    activeConversation?.threadId ?? activeConversation?.conversationId ?? 'new-conversation'
  useConversationScrollRestoration(
    viewportRef,
    scrollSnapshot,
    onScrollSnapshotChange,
    scrollRestoreKey
  )
  const effectiveProjectSelection = activeConversation
    ? activeConversation.projectSelection
    : projectState.state?.activeProjectSelection
  const gitRepository = useGitRepository()
  const projectBranchTarget = gitRepository.status === 'ready' ? gitRepository.target : undefined
  const hasSelectedProject = Boolean(
    effectiveProjectSelection && effectiveProjectSelection.projectKind !== 'projectless'
  )
  const composerContextCatalog = useComposerContextCatalog({
    cwd: resolveComposerCwd(activeConversation, projectState),
    enabled: hasConversationProjectContext(activeConversation, projectState),
    projectSelection: effectiveProjectSelection,
    threadId: activeConversation?.threadId
  })
  const runningAssistantMessage = useAuiState(latestRunningAssistantMessage)
  const composerTurnStatus = useMemo(() => {
    if (!runningAssistantMessage) return null
    const renderModel = buildAssistantRenderUnits({
      content: runningAssistantMessage.content,
      parts: runningAssistantMessage.parts,
      status: runningAssistantMessage.status,
      metadata: runningAssistantMessage.metadata,
      hasBlockingRequest,
      workspaceCwd: activeConversation?.cwd ?? undefined,
      canOpenLocalPaths: activeConversation?.projectSelection?.projectKind !== 'remote'
    })
    return buildComposerTurnStatus(renderModel.units)
  }, [activeConversation, hasBlockingRequest, runningAssistantMessage])
  const visibleFollowUpItems = followUps.items.filter(
    (item) => item.status !== 'editing' && item.status !== 'steering'
  )
  const reservedEditingItem = followUps.items.find((item) => item.status === 'editing')
  const beginEditingFollowUp = useCallback(
    async (itemId: string): Promise<void> => {
      const hasComposerDraft = composerText.trim().length > 0 || composerAttachments.length > 0
      if (hasComposerDraft && !window.confirm('输入框中已有内容。要用排队消息替换当前草稿吗？')) {
        return
      }

      if (editingFollowUp && editingFollowUp.itemId !== itemId) {
        await followUps.cancelEdit(editingFollowUp.itemId)
        setEditingFollowUp(null)
      }
      const prepared = await followUps.beginEdit(itemId)
      try {
        const restored = restoreQueuedFollowUpToComposerDraft(prepared.message)
        await aui.composer().reset()
        aui.composer().setText(restored.text)
        for (const attachment of restored.attachments) {
          await aui.composer().addAttachment(attachment)
        }
        setEditingFollowUp({
          itemId,
          contextReferences: prepared.message.contextReferences,
          trustedContext: prepared.message.trustedContext
        })
        window.requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('.aui-lexical-input')?.focus()
        )
      } catch (error) {
        await followUps.cancelEdit(itemId)
        throw error
      }
    },
    [aui, composerAttachments.length, composerText, editingFollowUp, followUps]
  )

  return (
    <ComposerContextIdentityProvider index={composerContextCatalog.identityIndex}>
      <ThreadPrimitive.Root
        className="aui-root aui-thread-root @container flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background"
        style={{
          ['--thread-max-width' as string]: '48rem',
          ['--composer-padding' as string]: '8px'
        }}
      >
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          turnAnchor="top"
          scrollToBottomOnInitialize={!scrollSnapshot}
          scrollToBottomOnThreadSwitch={false}
          data-slot="aui_thread-viewport"
          className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth px-4 pt-4"
        >
          {loadError ? (
            <div
              data-slot="conversation-load-error"
              role="alert"
              className="mx-auto mb-6 flex w-full max-w-(--thread-max-width) items-center justify-between gap-4 rounded-md border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              <span>无法加载此对话：{loadError.message}</span>
              <Button type="button" size="sm" variant="secondary" onClick={onRetryLoad}>
                重试
              </Button>
            </div>
          ) : null}
          {showNewConversationView ? <ThreadWelcome /> : null}
          <div data-slot="aui_message-group" className="mb-14 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>
              {({ message }) => {
                if (message.composer.isEditing) return <EditComposer />
                if (message.role === 'user') return <UserMessage />
                return (
                  <AssistantMessage
                    hasBlockingRequest={hasBlockingRequest}
                    workspaceCwd={activeConversation?.cwd ?? undefined}
                    canOpenLocalPaths={
                      activeConversation?.projectSelection?.projectKind !== 'remote'
                    }
                    onOpenConversation={onOpenConversation}
                  />
                )
              }}
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 overflow-visible rounded-t-xl bg-background pb-4 md:pb-6">
            <ThreadScrollToBottom />
            <ConversationRecoveryStatus phase={recoveryPhase} error={recoveryError} />
            <WorkspaceRecoveryBanner
              conversationId={activeConversation?.conversationId}
              threadId={activeConversation?.threadId}
              onCreateNewTask={onCreateNewTask}
            />
            <ComposerTurnStatusCard status={composerTurnStatus} />
            <div data-slot="composer-project-stack" className="flex w-full flex-col">
              {reservedEditingItem && !editingFollowUp ? (
                <div
                  data-slot="queued-follow-up-edit-recovery"
                  className="mb-2 flex items-center justify-between rounded-xl border border-border/60 bg-muted/60 px-3 py-2 text-xs"
                >
                  <span>有一条排队消息处于编辑保留状态。</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void beginEditingFollowUp(reservedEditingItem.id)}
                    >
                      继续编辑
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => void followUps.cancelEdit(reservedEditingItem.id)}
                    >
                      恢复到队列
                    </Button>
                  </div>
                </div>
              ) : null}
              <QueuedFollowUpPausedBanner
                item={visibleFollowUpItems[0]}
                busy={followUps.pendingItemIds.has(visibleFollowUpItems[0]?.id ?? '')}
                onResume={followUps.resume}
              />
              <QueuedFollowUpList
                items={visibleFollowUpItems}
                conversationKey={followUps.state?.conversationKey}
                defaultMode={followUps.defaultMode}
                pendingItemIds={followUps.pendingItemIds}
                announcement={followUps.announcement}
                onEdit={(item) => beginEditingFollowUp(item.id)}
                onDelete={followUps.deleteItem}
                onMoveUp={followUps.moveUp}
                onMoveDown={followUps.moveDown}
                onReorder={followUps.reorder}
                onSteer={async (itemId) => {
                  const message = await followUps.materializeItem(itemId)
                  return onSteerFollowUp(itemId, message)
                }}
                onRetry={followUps.retry}
                onToggleQueueing={() =>
                  followUps.setDefaultMode(followUps.defaultMode === 'queue' ? 'steer' : 'queue')
                }
                onRequestComposerFocus={() =>
                  document.querySelector<HTMLElement>('.aui-lexical-input')?.focus()
                }
              />
              {followUps.error ? (
                <p role="alert" className="px-2 py-1 text-xs text-destructive">
                  {followUps.error}
                </p>
              ) : null}
              {canChangeProject ? (
                <ComposerProjectCard
                  activeSelection={effectiveProjectSelection}
                  projectState={projectState}
                  trailingControl={
                    hasSelectedProject ? (
                      <LocalBranchSwitcher target={projectBranchTarget} />
                    ) : undefined
                  }
                />
              ) : null}
              {approvalRequests.length > 0 ? (
                <ServerRequestPanel
                  onInteraction={onSnoozeApproval}
                  onReject={onRejectApproval}
                  onRespond={onRespondApproval}
                  requests={approvalRequests}
                />
              ) : (
                <Composer
                  activeConversation={activeConversation}
                  composerContextCatalog={composerContextCatalog}
                  disabled={disabled}
                  followUps={followUps}
                  models={models}
                  selectedModelId={selectedModelId}
                  modelSelectionError={modelSelectionError}
                  onSelectedModelChange={onSelectedModelChange}
                  onSteerFollowUp={onSteerFollowUp}
                  onStartCodeReview={onStartCodeReview}
                  onCreateNewTask={onCreateNewTask}
                  composerModeKind={composerModeKind}
                  approvalModeKind={approvalModeKind}
                  goalEditorActive={goalEditorActive}
                  threadGoal={threadGoal}
                  goalCapabilityStatus={goalCapabilityStatus}
                  goalOperation={goalOperation}
                  goalError={goalError}
                  onComposerModeKindChange={onComposerModeKindChange}
                  onApprovalModeKindChange={onApprovalModeKindChange}
                  onGoalEditorActiveChange={onGoalEditorActiveChange}
                  onThreadGoalChange={onThreadGoalChange}
                  onGoalOperationChange={onGoalOperationChange}
                  onSaveThreadGoal={onSaveThreadGoal}
                  projectState={projectState}
                  editingFollowUp={editingFollowUp}
                  onEditingFollowUpChange={setEditingFollowUp}
                  queueAttached={visibleFollowUpItems.length > 0}
                  reservedEditingItemId={reservedEditingItem?.id}
                />
              )}
            </div>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ComposerContextIdentityProvider>
  )
}

function ConversationDraftBridge({
  draft,
  draftAttachments,
  status,
  onDraftChange,
  onDraftAttachmentsChange
}: {
  draft: string
  draftAttachments: readonly ConversationDraftAttachment[]
  status: ConversationChatEntry['status']
  onDraftChange: (draft: string) => void
  onDraftAttachmentsChange: (attachments: readonly ConversationDraftAttachment[]) => void
}): null {
  const aui = useAui()
  const composerText = useAuiState((state) => state.composer.text)
  const composerAttachments = useAuiState((state) => state.composer.attachments)
  const initialDraft = useRef(draft)
  const initialDraftAttachments = useRef(draftAttachments)
  const hydrated = useRef(false)
  const latestDraft = useRef({ text: draft, attachments: [...draftAttachments] })
  const pendingSend = useRef<{
    text: string
    attachments: ConversationDraftAttachment[]
  } | null>(null)

  useAuiEvent('composer.send', () => {
    pendingSend.current = {
      text: latestDraft.current.text,
      attachments: latestDraft.current.attachments.map((attachment) => ({ ...attachment }))
    }
  })

  useLayoutEffect(() => {
    aui.composer().setText(initialDraft.current)
    const markHydrated = (): void => {
      hydrated.current = true
    }
    void Promise.all(
      initialDraftAttachments.current.map((attachment) =>
        addDraftAttachment(aui, attachment)
      )
    ).then(markHydrated, markHydrated)
  }, [aui])

  useEffect(() => {
    if (!hydrated.current || pendingSend.current) return
    latestDraft.current.text = composerText
    onDraftChange(composerText)
  }, [composerAttachments.length, composerText, onDraftChange])

  useEffect(() => {
    if (!hydrated.current || pendingSend.current) return
    const attachments = localDraftAttachments(composerAttachments)
    latestDraft.current.attachments = attachments
    onDraftAttachmentsChange(attachments)
  }, [composerAttachments, onDraftAttachmentsChange])

  useEffect(() => {
    const snapshot = pendingSend.current
    if (!snapshot) return

    const storedDraftWasCleared = draft.length === 0 && draftAttachments.length === 0
    if ((status === 'streaming' || status === 'ready') && storedDraftWasCleared) {
      pendingSend.current = null
      const nextAttachments = localDraftAttachments(composerAttachments)
      latestDraft.current = { text: composerText, attachments: nextAttachments }
      onDraftChange(composerText)
      onDraftAttachmentsChange(nextAttachments)
      return
    }
    if (status !== 'error') return

    const currentAttachments = localDraftAttachments(composerAttachments)
    if (composerText.length > 0 || composerAttachments.length > 0) {
      latestDraft.current = { text: composerText, attachments: currentAttachments }
      pendingSend.current = null
      onDraftChange(composerText)
      onDraftAttachmentsChange(currentAttachments)
      return
    }

    aui.composer().setText(snapshot.text)
    const restoreDraft = (): void => {
      latestDraft.current = snapshot
      pendingSend.current = null
      onDraftChange(snapshot.text)
      onDraftAttachmentsChange(snapshot.attachments)
    }
    void Promise.all(
      snapshot.attachments.map((attachment) =>
        addDraftAttachment(aui, attachment)
      )
    ).then(restoreDraft, restoreDraft)
  }, [
    aui,
    composerAttachments,
    composerText,
    draft,
    draftAttachments,
    onDraftAttachmentsChange,
    onDraftChange,
    status
  ])

  return null
}

function localDraftAttachments(
  attachments: readonly { id: string; name: string }[]
): ConversationDraftAttachment[] {
  return attachments.flatMap((attachment): ConversationDraftAttachment[] => {
    const artifact = artifactSourceAttachmentIdentityFromId(attachment.id)
    if (artifact) return [{ kind: 'artifact', sourceId: artifact.sourceId, label: attachment.name }]
    const identity = localPathAttachmentIdentityFromId(attachment.id)
    if (!identity) return []
    return [{ ...identity, label: attachment.name }]
  })
}

async function addDraftAttachment(
  aui: ReturnType<typeof useAui>,
  attachment: ConversationDraftAttachment
): Promise<void> {
  if (attachment.kind === 'artifact') {
    const result = await window.desktopApp.workspace.artifacts.createComposerAttachment({
      version: 1,
      sourceId: attachment.sourceId
    })
    await aui.composer().addAttachment(createArtifactSourceAttachment(result.attachment))
    return
  }
  await aui.composer().addAttachment(createLocalPathAttachment(attachment))
}

function ConversationFocusBridge({ entryId }: { entryId: string }): null {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const input = document.querySelector<HTMLElement>('.aui-lexical-input')
      input?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [entryId])
  return null
}

function useConversationScrollRestoration(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  snapshot: ConversationScrollSnapshot | undefined,
  onSnapshotChange: (snapshot: ConversationScrollSnapshot) => void,
  restoreKey: string
): void {
  const snapshotRef = useRef(snapshot)
  const onSnapshotChangeRef = useRef(onSnapshotChange)

  useLayoutEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useLayoutEffect(() => {
    onSnapshotChangeRef.current = onSnapshotChange
  }, [onSnapshotChange])

  useLayoutEffect(() => {
    countConversationStreamPerformance('scrollRestoreSetupCount')
    markConversationStreamEvent('scroll-restore-setup')
    const viewport = viewportRef.current
    if (!viewport) return
    let restoreFrame = 0
    const layoutFrame = window.requestAnimationFrame(() => {
      countConversationStreamPerformance('scrollRestoreScheduleCount')
      markConversationStreamEvent('scroll-restore-schedule')
      const snapshotToRestore = snapshotRef.current
      if (!snapshotToRestore) return
      restoreFrame = window.requestAnimationFrame(() => {
        countConversationStreamPerformance('scrollRestoreApplyCount')
        markConversationStreamEvent('scroll-restore-apply')
        restoreConversationScroll(viewport, snapshotToRestore)
      })
    })

    return () => {
      countConversationStreamPerformance('scrollRestoreCleanupCount')
      markConversationStreamEvent('scroll-restore-cleanup')
      window.cancelAnimationFrame(layoutFrame)
      window.cancelAnimationFrame(restoreFrame)
    }
  }, [restoreKey, viewportRef])

  useLayoutEffect(
    () => () => {
      const viewport = viewportRef.current
      if (viewport) onSnapshotChangeRef.current(captureConversationScroll(viewport))
    },
    [restoreKey, viewportRef]
  )
}

function useViewportIdentityProbe(viewportRef: React.RefObject<HTMLDivElement | null>): void {
  const previousNodeRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || viewport === previousNodeRef.current) return

    if (previousNodeRef.current) {
      countConversationStreamPerformance('forwardedRefDetachCount')
      markConversationStreamEvent('viewport-ref-detach')
      countConversationStreamPerformance('nodeReplacementCount')
      markConversationStreamEvent('viewport-node-replaced')
    }

    countConversationStreamPerformance('forwardedRefAttachCount')
    markConversationStreamEvent('viewport-ref-attach')
    previousNodeRef.current = viewport
  })

  useEffect(
    () => () => {
      if (!previousNodeRef.current) return
      countConversationStreamPerformance('forwardedRefDetachCount')
      markConversationStreamEvent('viewport-ref-detach')
      previousNodeRef.current = null
    },
    []
  )
}

function ThreadWelcome(): React.JSX.Element {
  return (
    <section className="aui-thread-welcome-root mx-auto mb-6 flex w-full max-w-(--thread-max-width) flex-col items-center px-4 text-center">
      <h1 className="aui-thread-welcome-message-inner duration-200 animate-in fade-in slide-in-from-bottom-1 text-2xl font-semibold tracking-[-0.02em]">
        How can I help you today?
      </h1>
    </section>
  )
}

function ThreadScrollToBottom(): React.JSX.Element {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <IconButton
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 size-10 self-center rounded-full border border-border bg-background p-0 shadow-sm disabled:invisible"
        label="滚动到底部"
        title="滚动到底部"
      >
        <ArrowDownIcon className="size-4" />
      </IconButton>
    </ThreadPrimitive.ScrollToBottom>
  )
}

function AssistantMessage({
  hasBlockingRequest,
  workspaceCwd,
  canOpenLocalPaths,
  onOpenConversation
}: {
  hasBlockingRequest: boolean
  workspaceCwd?: string
  canOpenLocalPaths: boolean
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element {
  countConversationStreamPerformance('assistantMessage')
  const message = useAuiState((state) => state.message)
  const isThreadRunning = useAuiState((state) => state.thread.isRunning)
  const textPartMetadata = useMemo(() => codexTextPartMetadataFor(message), [message])
  const turnDurationMs = useMemo(() => codexTurnDurationFor(message), [message])
  const renderModel = useMemo(
    () =>
      buildAssistantRenderUnits({
        content: message.content,
        parts: message.parts,
        status: message.status,
        metadata: message.metadata,
        textPhases: textPartMetadata.map((metadata) => metadata.phase),
        hasBlockingRequest,
        workspaceCwd,
        canOpenLocalPaths,
        processDurationMs:
          message.metadata?.timing?.totalStreamTime ??
          turnDurationMs ??
          textPartMetadata.find((metadata) => metadata.turnDurationMs !== undefined)?.turnDurationMs
      }),
    [canOpenLocalPaths, hasBlockingRequest, message, textPartMetadata, turnDurationMs, workspaceCwd]
  )
  const isThinkingOnly = renderModel.isThinkingOnly
  const visibleUnits = withoutComposerStatusRenderUnits(renderModel.units, {
    keepTurnDiff: message.status?.type === 'complete'
  })
  const wasCancelled =
    message.status?.type === 'incomplete' && message.status.reason === 'cancelled'

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative mx-auto w-full max-w-(--thread-max-width) duration-150 animate-in fade-in slide-in-from-bottom-1"
    >
      <div
        data-slot="aui_assistant-message-content"
        className={cn(
          'wrap-break-word px-2 leading-relaxed text-foreground',
          isThinkingOnly && 'shimmer text-foreground/60 motion-reduce:animate-none'
        )}
      >
        {isThinkingOnly ? (
          pendingAssistantMessageText
        ) : (
          <>
            {visibleUnits.map((unit) => (
              <ConversationTurnErrorBoundary
                key={unit.key}
                resetKey={`${message.id}:${unit.key}`}
                renderUnitKind={unit.type}
              >
                <AssistantRenderUnitView
                  unit={unit}
                  onOpenConversation={onOpenConversation}
                  workspaceCwd={workspaceCwd}
                  canOpenLocalPaths={canOpenLocalPaths}
                />
              </ConversationTurnErrorBoundary>
            ))}
          </>
        )}
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root
            data-slot="aui_assistant-message-error"
            role="alert"
            aria-live="polite"
            className="border-destructive/20 bg-destructive/5 text-destructive mt-2 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <ErrorPrimitive.Message className="min-w-0 flex-1 wrap-break-word" />
            <ActionBarPrimitive.Reload asChild>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={isThreadRunning}
                data-slot="aui_assistant-message-retry"
              >
                重试
              </Button>
            </ActionBarPrimitive.Reload>
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
        {wasCancelled ? (
          <p
            data-slot="aui_assistant-message-cancelled"
            role="status"
            className="mt-2 text-sm text-muted-foreground"
          >
            已取消
          </p>
        ) : null}
      </div>
      {isThinkingOnly ? null : (
        // Keep the autohidden action bar from changing the following message's position.
        <div
          data-slot="aui_assistant-message-footer"
          className="ml-2 mt-1.5 flex h-8 items-center -mb-8"
        >
          <AssistantActionBar />
        </div>
      )}
    </MessagePrimitive.Root>
  )
}

type ExternalAISDKMessage = {
  parts?: readonly { type?: unknown; providerMetadata?: unknown }[]
  metadata?: unknown
}

function appendMessageToUIMessage(message: AppendMessage): UIMessage {
  const inputParts = [
    ...message.content.filter((part) => part.type !== 'file'),
    ...(message.attachments?.flatMap((attachment) =>
      attachment.content.map((part) => ({
        ...part,
        filename: attachment.name
      }))
    ) ?? [])
  ]
  const parts = inputParts.map((part): UIMessagePart<Record<string, unknown>, never> => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text }
      case 'image':
        return {
          type: 'file',
          url: part.image,
          mediaType: 'image/png',
          ...(part.filename ? { filename: part.filename } : {})
        }
      case 'file':
        return {
          type: 'file',
          url: part.data,
          mediaType: part.mimeType,
          ...(part.filename ? { filename: part.filename } : {})
        }
      case 'data':
        return {
          type: `data-${part.name}`,
          data: part.data
        }
      default:
        throw new Error(`Unsupported composer message part: ${part.type}`)
    }
  })

  return {
    id: crypto.randomUUID(),
    role: message.role,
    parts,
    ...(message.metadata === undefined ? {} : { metadata: message.metadata })
  }
}

function transcriptMessageToThreadMessageLike(
  message: ConversationTranscriptMessage,
  running: boolean
): ThreadMessageLike & {
  readonly convertConfig?: { readonly joinStrategy: 'none' }
} {
  const visibleUserText =
    message.role === 'user'
      ? extractVisibleUserRequest(
          message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
        )
      : undefined
  let userTextEmitted = false

  const content = message.parts.flatMap((part): unknown[] => {
    if (part.type === 'step-start') return []
    if (part.type === 'text') {
      if (message.role === 'user') {
        if (userTextEmitted) return []
        userTextEmitted = true
      }
      return [
        {
          type: 'text',
          text: visibleUserText ?? part.text
        }
      ]
    }
    if (part.type === 'reasoning') return [{ type: 'reasoning', text: part.text }]
    if (isToolUIPart(part)) {
      const input =
        part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? part.input : {}
      const result =
        part.state === 'output-available'
          ? part.output
          : part.state === 'output-error'
            ? { error: part.errorText }
            : undefined
      return [
        {
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: getToolName(part),
          args: input,
          argsText: JSON.stringify(input),
          result,
          isError: part.state === 'output-error' || part.state === 'output-denied',
          ...('approval' in part && part.approval ? { approval: part.approval } : {})
        }
      ]
    }
    if (part.type === 'source-url') {
      return [
        {
          type: 'source',
          sourceType: 'url',
          id: part.sourceId,
          url: part.url,
          ...(part.title ? { title: part.title } : {}),
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {})
        }
      ]
    }
    if (part.type === 'source-document') {
      return [
        {
          type: 'source',
          sourceType: 'document',
          id: part.sourceId,
          title: part.title,
          mediaType: part.mediaType,
          ...(part.filename ? { filename: part.filename } : {}),
          ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {})
        }
      ]
    }
    if (part.type === 'file') {
      return message.role === 'user'
        ? []
        : [
            {
              type: 'file',
              data: part.url,
              mimeType: part.mediaType,
              ...(part.filename ? { filename: part.filename } : {})
            }
          ]
    }
    if (part.type.startsWith('data-')) {
      return [
        {
          type: 'data',
          name: part.type.slice('data-'.length),
          data: 'data' in part ? part.data : undefined
        }
      ]
    }
    return []
  }) as Exclude<ThreadMessageLike['content'], string>
  const attachments =
    message.role === 'user'
      ? message.parts.flatMap((part, index) => {
          if (part.type !== 'file') return []
          const image = part.mediaType.startsWith('image/')
          return [
            {
              id: String(index),
              type: image ? ('image' as const) : ('file' as const),
              name: part.filename ?? 'file',
              content: image
                ? [
                    {
                      type: 'image' as const,
                      image: part.url,
                      filename: part.filename
                    }
                  ]
                : [
                    {
                      type: 'file' as const,
                      data: part.url,
                      mimeType: part.mediaType,
                      filename: part.filename
                    }
                  ],
              contentType: part.mediaType,
              status: { type: 'complete' as const }
            }
          ]
        })
      : undefined

  return {
    id: message.renderId,
    role: message.role,
    content,
    ...(attachments ? { attachments } : {}),
    ...(message.metadata === undefined
      ? {}
      : { metadata: message.metadata as ThreadMessageLike['metadata'] }),
    ...(message.role === 'assistant'
      ? {
          status: assistantMessageStatus(message.metadata, running),
          convertConfig: { joinStrategy: 'none' as const }
        }
      : {})
  }
}

function assistantMessageStatus(
  metadata: unknown,
  running: boolean
): NonNullable<ThreadMessageLike['status']> {
  if (running) return { type: 'running' }

  const codexTurn = codexTurnMetadataFor(metadata)
  if (codexTurn?.status === 'failed') {
    return {
      type: 'incomplete',
      reason: 'error',
      error: safeTurnErrorMessage(codexTurn.error?.message)
    }
  }
  if (codexTurn?.status === 'interrupted') {
    return { type: 'incomplete', reason: 'cancelled' }
  }
  return { type: 'complete', reason: 'stop' }
}

function codexTurnMetadataFor(metadata: unknown): CodexTurnMessageMetadata | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const codexTurn = (metadata as Record<string, unknown>).codexTurn
  if (!codexTurn || typeof codexTurn !== 'object' || Array.isArray(codexTurn)) return undefined
  const candidate = codexTurn as Record<string, unknown>
  if (
    typeof candidate.turnId !== 'string' ||
    (candidate.status !== 'failed' && candidate.status !== 'interrupted')
  ) {
    return undefined
  }

  const rawError = candidate.error
  const error =
    rawError && typeof rawError === 'object' && !Array.isArray(rawError)
      ? (rawError as Record<string, unknown>)
      : undefined
  return {
    turnId: candidate.turnId,
    status: candidate.status,
    ...(error && typeof error.message === 'string'
      ? {
          error: {
            message: error.message,
            ...(typeof error.additionalDetails === 'string' || error.additionalDetails === null
              ? { additionalDetails: error.additionalDetails }
              : {}),
            ...('codexErrorInfo' in error ? { codexErrorInfo: error.codexErrorInfo } : {})
          }
        }
      : {})
  }
}

type CodexTextPartMetadata = {
  phase?: AssistantMessagePhase
  turnDurationMs?: number
}

const CODEX_PROVIDER_ID = '@janole/ai-sdk-provider-codex-asp'

function codexTextPartMetadataFor(message: ThreadMessage): readonly CodexTextPartMetadata[] {
  return getExternalStoreMessages<ExternalAISDKMessage>(message).flatMap((externalMessage) =>
    (externalMessage.parts ?? []).flatMap((part) => {
      if (part.type !== 'text') return []
      return [messageMetadataFromProviderMetadata(part.providerMetadata)]
    })
  )
}

function codexTurnDurationFor(message: ThreadMessage): number | undefined {
  return getExternalStoreMessages<ExternalAISDKMessage>(message)
    .map((externalMessage) => externalMessage.metadata)
    .map((metadata) =>
      metadata && typeof metadata === 'object'
        ? (metadata as Record<string, unknown>).codexTurnDurationMs
        : undefined
    )
    .find(
      (durationMs): durationMs is number =>
        typeof durationMs === 'number' && Number.isFinite(durationMs)
    )
}

function messageMetadataFromProviderMetadata(providerMetadata: unknown): CodexTextPartMetadata {
  if (!providerMetadata || typeof providerMetadata !== 'object') return {}
  const codexMetadata = (providerMetadata as Record<string, unknown>)[CODEX_PROVIDER_ID]
  if (!codexMetadata || typeof codexMetadata !== 'object') return {}
  const metadata = codexMetadata as Record<string, unknown>
  const phase = metadata.messagePhase
  const turnDurationMs = metadata.turnDurationMs
  return {
    ...(phase === 'commentary' || phase === 'final_answer' ? { phase } : {}),
    ...(typeof turnDurationMs === 'number' && Number.isFinite(turnDurationMs)
      ? { turnDurationMs }
      : {})
  }
}

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="mx-auto grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 animate-in fade-in slide-in-from-bottom-1 [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer rounded-xl bg-muted px-4 py-2 text-foreground wrap-break-word empty:hidden">
          <MessagePrimitive.Quote>{(quote) => <QuoteBlock {...quote} />}</MessagePrimitive.Quote>
          <MessagePrimitive.Parts components={{ Text: DirectiveText }} />
        </div>
        <div className="aui-user-action-bar-wrapper absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2 peer-empty:hidden">
          <UserActionBar />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

function QuoteBlock({ text }: QuoteMessagePartProps): React.JSX.Element {
  return (
    <div data-slot="quote-block" className="mb-2 flex items-start gap-1.5">
      <QuoteIcon
        data-slot="quote-block-icon"
        className="mt-0.5 size-3 shrink-0 text-muted-foreground/60"
      />
      <p
        data-slot="quote-block-text"
        className="line-clamp-2 min-w-0 text-sm text-muted-foreground/80 italic"
      >
        {text}
      </p>
    </div>
  )
}

function DirectiveText({ text }: TextMessagePartProps): React.JSX.Element {
  const segments = composerContextDirectiveFormatter.parse(text)
  const identityIndex = useComposerContextIdentityIndex()

  if (segments.length === 1 && segments[0]?.kind === 'text') return <>{text}</>

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') {
          return (
            <span key={index} className="whitespace-pre-wrap">
              {segment.text}
            </span>
          )
        }

        return (
          <span
            key={index}
            className="aui-directive-chip inline-flex items-baseline rounded-md bg-blue-100 px-1.5 py-0.5 text-[13px] leading-none font-medium text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
            data-directive-id={segment.id}
            data-directive-type={segment.type}
          >
            {displayDirectiveLabel(segment.type, segment.id, segment.label, identityIndex)}
          </span>
        )
      })}
    </>
  )
}

function displayDirectiveLabel(
  directiveType: string,
  directiveId: string,
  fallbackLabel: string,
  identityIndex: ComposerContextIdentityIndex
): string {
  if (directiveType !== 'app' && directiveType !== 'plugin') return fallbackLabel
  const identity = identityIndex.get(directiveId)
  return identity?.type === directiveType ? identity.displayLabel : fallbackLabel
}

function AssistantRenderUnitView({
  unit,
  onOpenConversation,
  workspaceCwd,
  canOpenLocalPaths
}: {
  unit: AssistantRenderUnit
  onOpenConversation: OpenSubagentConversation
  workspaceCwd?: string
  canOpenLocalPaths: boolean
}): React.JSX.Element | null {
  switch (unit.type) {
    case 'message-thinking':
      return (
        <span
          data-slot="message-thinking-unit"
          className="inline-flex max-w-full min-w-0 items-center overflow-hidden text-sm text-muted-foreground"
          {...renderUnitAttributes(unit)}
        >
          <span aria-hidden className="h-4 w-0 shrink-0" />
          <span className="shimmer min-w-0 flex-1 truncate select-none leading-none motion-reduce:animate-none">
            {pendingAssistantMessageText}
          </span>
        </span>
      )
    case 'text':
      return (
        <AssistantText
          text={unit.text}
          unit={unit}
          workspaceCwd={workspaceCwd}
          canOpenLocalPaths={canOpenLocalPaths}
          onOpenConversation={onOpenConversation}
        />
      )
    case 'review-comments':
      return <ReviewCommentsDetails unit={unit} />
    case 'reasoning-group':
      return (
        <ReasoningGroupUnit
          unit={unit}
          onOpenConversation={onOpenConversation}
          workspaceCwd={workspaceCwd}
          canOpenLocalPaths={canOpenLocalPaths}
        />
      )
    case 'subagent-activity-group':
      return <SubagentActivityGroup unit={unit} onOpenConversation={onOpenConversation} />
    case 'entry':
      return (
        <EntryUnit
          unit={unit}
          workspaceCwd={workspaceCwd}
          canOpenLocalPaths={canOpenLocalPaths}
          onOpenConversation={onOpenConversation}
        />
      )
    case 'tool-group':
      return <ToolGroupUnit unit={unit} onOpenConversation={onOpenConversation} />
    case 'unknown':
      return <UnknownUnit unit={unit} />
  }
}

function ReasoningGroupUnit({
  unit,
  onOpenConversation,
  workspaceCwd,
  canOpenLocalPaths
}: {
  unit: Extract<AssistantRenderUnit, { type: 'reasoning-group' }>
  onOpenConversation: OpenSubagentConversation
  workspaceCwd?: string
  canOpenLocalPaths: boolean
}): React.JSX.Element {
  const isActive = unit.active === true
  const [completedProcessOpen, setCompletedProcessOpen] = useState(false)
  const measuredDurationMs = useReasoningElapsedDuration(isActive)
  let label = isActive
    ? `已处理 · 耗时 ${formatProcessedDuration(measuredDurationMs ?? 0)}`
    : processedDurationLabel(unit.durationMs ?? measuredDurationMs)
  if (unit.state === 'blocked') label = blockedAssistantMessageText

  return (
    <Collapsible
      data-slot="reasoning-group"
      open={isActive || completedProcessOpen}
      onOpenChange={isActive ? undefined : setCompletedProcessOpen}
      disabled={isActive}
      className="group/reasoning my-2 w-full"
      {...renderUnitAttributes(unit)}
    >
      <div data-slot="reasoning-group-header">
        <CollapsibleTrigger
          data-slot="reasoning-group-trigger"
          disabled={isActive}
          className={cn(
            'group/trigger flex w-fit items-center gap-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground',
            isActive && 'cursor-default hover:text-muted-foreground'
          )}
        >
          <span data-slot="reasoning-group-label" className="relative inline-block">
            {label}
          </span>
          <ChevronDownIcon
            aria-hidden
            className="size-3.5 transition-transform duration-200 group-data-[state=closed]/trigger:-rotate-90"
          />
        </CollapsibleTrigger>
      </div>
      <hr data-slot="reasoning-group-divider" className="mb-4 border-border" />
      <CollapsibleContent
        data-slot="reasoning-group-content"
        className="overflow-hidden outline-none data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
      >
        <div className="min-w-0 space-y-4">
          {unit.children.map((child) => (
            <div key={child.key} data-slot="reasoning-process-item" className="min-w-0">
              <AssistantRenderUnitView
                unit={child}
                onOpenConversation={onOpenConversation}
                workspaceCwd={workspaceCwd}
                canOpenLocalPaths={canOpenLocalPaths}
              />
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

type ReasoningTimerState = {
  active: boolean
  startedAt?: number
  updatedAt: number
  completedDurationMs?: number
}

function useReasoningElapsedDuration(isActive: boolean): number | undefined {
  const [timer, setTimer] = useState<ReasoningTimerState>(() => {
    const now = Date.now()
    return {
      active: isActive,
      startedAt: isActive ? now : undefined,
      updatedAt: now
    }
  })
  const wasActive = useRef(isActive)
  const startTimer = useEffectEvent(() => {
    const startedAt = Date.now()
    setTimer({ active: true, startedAt, updatedAt: startedAt })
  })
  const stopTimer = useEffectEvent(() => {
    setTimer((current) => {
      if (!current.active || current.startedAt === undefined) return current
      const completedAt = Date.now()
      return {
        active: false,
        updatedAt: completedAt,
        completedDurationMs: Math.max(0, completedAt - current.startedAt)
      }
    })
  })

  useEffect(() => {
    if (!wasActive.current && isActive) startTimer()
    if (wasActive.current && !isActive) stopTimer()
    wasActive.current = isActive
  }, [isActive])

  useEffect(() => {
    if (!isActive) return

    const intervalId = window.setInterval(() => {
      setTimer((current) => (current.active ? { ...current, updatedAt: Date.now() } : current))
    }, 1_000)

    return () => window.clearInterval(intervalId)
  }, [isActive])

  if (isActive) {
    if (!timer.active || timer.startedAt === undefined) return 0
    return Math.max(0, timer.updatedAt - timer.startedAt)
  }

  return timer.completedDurationMs
}

function processedDurationLabel(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return '已处理'
  return `已处理 · 耗时 ${formatProcessedDuration(durationMs)}`
}

function formatProcessedDuration(durationMs: number): string {
  const roundedSeconds = Math.max(0, Math.round(durationMs / 1000))
  const totalSeconds = durationMs > 0 ? Math.max(1, roundedSeconds) : 0

  if (durationMs < 60_000) return `${totalSeconds} 秒`

  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)

  if (durationMs < 3_600_000) return `${totalMinutes} 分 ${seconds} 秒`

  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours} 小时 ${minutes} 分 ${seconds} 秒`
}

function AssistantText({
  text,
  unit,
  workspaceCwd,
  canOpenLocalPaths,
  onOpenConversation
}: {
  text: string
  unit?: AssistantRenderUnit
  workspaceCwd?: string
  canOpenLocalPaths: boolean
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element {
  const workspace = useRightWorkspace()
  const identityIndex = useComposerContextIdentityIndex()
  const semanticTargets = useMemo(
    () => inlineReferenceSemanticTargetsFromIdentityIndex(identityIndex),
    [identityIndex]
  )
  const referenceContext = useMemo(
    () => ({
      workspaceCwd,
      canOpenLocalPaths,
      resolve: (descriptor: Parameters<typeof resolveInlineReferenceAction>[0]) =>
        resolveInlineReferenceAction(descriptor, {
          canOpenLocalPaths,
          canOpenWorkspace: true,
          semanticTargets,
          workspaceCwd
        }),
      execute: (action: InlineReferenceAction): void => {
        switch (action.type) {
          case 'workspace-file':
            if (isPptxArtifactPath(action.relativePath)) {
              workspace.openArtifact(
                {
                  artifactType: 'slides',
                  importKind: 'pptx',
                  source: { kind: 'workspace-file', relativePath: action.relativePath },
                  title: action.relativePath.split('/').at(-1) ?? '演示文稿',
                  openSource: 'inline-link'
                },
                { mode: action.mode }
              )
              return
            }
            workspace.openFile(action.relativePath, undefined, {
              location: {
                ...(action.line ? { line: action.line } : {}),
                ...(action.column ? { column: action.column } : {}),
                ...(action.endLine ? { endLine: action.endLine } : {})
              },
              mode: action.mode
            })
            return
          case 'workspace-folder':
            workspace.openFile('', 'Files', { mode: 'pinned', revealPath: action.relativePath })
            return
          case 'workspace-browser':
            workspace.openBrowser(action.url)
            return
          case 'conversation':
            onOpenConversation(action.conversationId)
            return
          case 'system-file':
            void window.desktopApp.codex
              .openLocalPath({
                path: action.path,
                ...(action.cwd ? { cwd: action.cwd } : {}),
                ...(action.line ? { line: action.line } : {})
              })
              .catch(() => undefined)
            return
          case 'external-browser':
            void window.desktopApp.codex.openExternalHttpUrl(action.url).catch(() => undefined)
            return
          case 'display-only':
            return
        }
      }
    }),
    [canOpenLocalPaths, onOpenConversation, semanticTargets, workspace, workspaceCwd]
  )

  return (
    <div data-slot="assistant-render-text" {...renderUnitAttributes(unit)}>
      <InlineReferenceProvider value={referenceContext}>
        <Streamdown
          animated={streamdownAnimation}
          components={assistantMarkdownComponents}
          isAnimating={unit?.type === 'text' && unit.streaming === true}
          mode="streaming"
          plugins={streamdownPlugins}
          rehypePlugins={referenceInlineRehypePlugins}
          urlTransform={referenceUrlTransform}
        >
          {text}
        </Streamdown>
      </InlineReferenceProvider>
    </div>
  )
}

function ToolGroupUnit({
  unit,
  onOpenConversation
}: {
  unit: Extract<AssistantRenderUnit, { type: 'tool-group' }>
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element {
  const displayModel = buildToolActivityDisplayModel(unit)

  return (
    <ToolActivityGroupShell
      unit={unit}
      slot="tool-group-unit"
      display={displayModel.group}
      defaultOpen={false}
    >
      <CollapsedActivityDetails detailRows={displayModel.group.detailRows} />
      {unit.dynamicMetadata?.hasRegistryMetadata === false ? (
        <p className="text-xs text-muted-foreground">动态工具缺少完整显示元数据</p>
      ) : null}
      {unit.children.map((item, index) => (
        <ToolItemRenderer
          key={`${item.id}:${index}`}
          item={item}
          display={displayModel.items[index] ?? buildToolItemDisplay(item, unit)}
          index={index}
          group={unit}
          onOpenConversation={onOpenConversation}
        />
      ))}
    </ToolActivityGroupShell>
  )
}

function ToolItemRenderer({
  item,
  display,
  index,
  group,
  onOpenConversation
}: {
  item: ToolItem
  display: ToolItemDisplay
  index: number
  group: Extract<AssistantRenderUnit, { type: 'tool-group' }>
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element {
  if (item.kind === 'mcpToolCall') {
    return <McpToolCallDetails parts={[item.rawPart]} mcpSource={item.source ?? group.mcpSource} />
  }

  if (item.kind === 'webSearch') {
    return <WebSearchDetails parts={[item.rawPart]} />
  }

  if (item.kind === 'collabAgentToolCall' || item.kind === 'collabToolCall') {
    return <MultiAgentToolItemDetails item={item} onOpenConversation={onOpenConversation} />
  }

  return (
    <>
      {renderToolPart(
        item.rawPart,
        index,
        undefined,
        item.dynamicMetadata ?? group.dynamicMetadata,
        item,
        display
      )}
    </>
  )
}

function EntryUnit({
  unit,
  workspaceCwd,
  canOpenLocalPaths,
  onOpenConversation
}: {
  unit: Extract<AssistantRenderUnit, { type: 'entry' }>
  workspaceCwd?: string
  canOpenLocalPaths: boolean
  onOpenConversation: OpenSubagentConversation
}): React.JSX.Element | null {
  if (unit.renderMode === 'known-null') return null

  if (unit.renderMode === 'text') {
    const text = entryText(unit)
    return text ? (
      <AssistantText
        text={text}
        unit={unit}
        workspaceCwd={workspaceCwd}
        canOpenLocalPaths={canOpenLocalPaths}
        onOpenConversation={onOpenConversation}
      />
    ) : null
  }

  if (unit.renderMode === 'custom') {
    return (
      <SpecialEntryRenderer
        unit={unit}
        workspaceCwd={workspaceCwd}
        canOpenLocalPaths={canOpenLocalPaths}
      />
    )
  }

  return (
    <div data-slot="entry-unit" {...renderUnitAttributes(unit)}>
      <AssistantToolPart part={unit.part} unit={unit} />
    </div>
  )
}

function UnknownUnit({
  unit
}: {
  unit: Extract<AssistantRenderUnit, { type: 'unknown' }>
}): React.JSX.Element {
  if (isRenderableUnknownPart(unit.part)) {
    return <UnknownPartRenderer part={unit.part} unit={unit} />
  }

  return (
    <div
      aria-hidden="true"
      className="hidden"
      data-slot="unknown-render-unit"
      {...renderUnitAttributes(unit)}
    />
  )
}

function isRenderableUnknownPart(part: Record<string, unknown>): boolean {
  return part.type === 'file' && stringRecordValue(part, 'mediaType')?.startsWith('image/') === true
}

function entryText(unit: Extract<AssistantRenderUnit, { type: 'entry' }>): string | undefined {
  const item = unit.item
  return (
    stringRecordValue(item, 'message') ??
    stringRecordValue(item, 'text') ??
    stringRecordValue(item, 'content') ??
    stringRecordValue(unit.part, 'text')
  )
}

function AssistantToolPart({
  part,
  unit
}: {
  part: Record<string, unknown>
  unit: Extract<AssistantRenderUnit, { type: 'entry' }>
}): ReactNode {
  return renderToolPart(part, unit.partIndex, unit)
}

function renderToolPart(
  part: Record<string, unknown>,
  index: number,
  unit?: Extract<AssistantRenderUnit, { type: 'entry' }>,
  _dynamicMetadata?: unknown,
  item?: ToolItem,
  display?: ToolItemDisplay
): ReactNode {
  const toolUI = part.toolUI as ReactNode | undefined
  if (toolUI) return toolUI

  const activeStatus = toolStatusForPart(part)
  const itemDisplay = display ?? (item ? buildToolItemDisplay(item) : undefined)

  return (
    <ToolFallback
      {...(part as React.ComponentProps<typeof ToolFallback>)}
      key={String(part.toolCallId ?? index)}
      toolName={stringRecordValue(part, 'toolName') ?? unit?.itemType ?? 'unknown_tool'}
      status={activeStatus ?? { type: 'complete' }}
      display={itemDisplay}
      summaryLabel={itemDisplay?.label ?? item?.label ?? unit?.summary?.label}
      summaryIcon={itemDisplay?.icon ?? unit?.summary?.icon}
    />
  )
}

function toolStatusForPart(part: Record<string, unknown>): ToolCallMessagePartStatus | undefined {
  if (isToolCallStatus(part.status)) return part.status
  if (part.preliminary === true) return { type: 'running' }

  return toolStatusForAiSdkState(part.state)
}

function toolStatusForAiSdkState(state: unknown): ToolCallMessagePartStatus | undefined {
  if (state === 'approval-requested') return { type: 'requires-action', reason: 'interrupt' }
  if (
    state === 'input-streaming' ||
    state === 'input-available' ||
    state === 'approval-responded'
  ) {
    return { type: 'running' }
  }
  if (state === 'output-error') return { type: 'incomplete', reason: 'error' }
  if (state === 'output-available' || state === 'output-denied') return { type: 'complete' }
  return undefined
}

function stringRecordValue(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const result = value?.[key]
  return typeof result === 'string' ? result : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isToolCallStatus(value: unknown): value is ToolCallMessagePartStatus {
  if (!isRecord(value)) return false
  return (
    value.type === 'running' ||
    value.type === 'complete' ||
    value.type === 'requires-action' ||
    value.type === 'incomplete'
  )
}

function UserActionBar(): React.JSX.Element {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-user-action-bar-root flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <IconButton className="aui-user-action-edit" label="编辑" title="编辑">
          <PencilIcon className="size-4" />
        </IconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  )
}

function EditComposer(): React.JSX.Element {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-3xl border border-border/60 bg-background shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] dark:border-muted-foreground/15 dark:bg-muted/30 dark:shadow-none">
        <ContextLexicalInput
          autoFocus
          directiveChip={DirectiveChip}
          formatter={composerContextDirectiveFormatter}
          suggestionEnabled={false}
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-base text-foreground outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300"
        />
        <div className="aui-edit-composer-footer mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <button
              className="h-8 rounded-full px-3.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              type="button"
            >
              取消
            </button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <button
              className="h-8 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              type="button"
            >
              更新
            </button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  )
}

function AssistantActionBar(): React.JSX.Element {
  return (
    <ActionBarPrimitive.Root
      className="flex items-center gap-1 text-muted-foreground duration-200 animate-in fade-in"
      hideWhenRunning
      autohide="not-last"
    >
      <ActionBarPrimitive.Copy asChild>
        <IconButton label="复制" title="复制">
          <AuiIf condition={(state) => state.message.isCopied}>
            <CheckIcon className="size-4" />
          </AuiIf>
          <AuiIf condition={(state) => !state.message.isCopied}>
            <CopyIcon className="size-4" />
          </AuiIf>
        </IconButton>
      </ActionBarPrimitive.Copy>
      <MessageTiming />
    </ActionBarPrimitive.Root>
  )
}

function DirectiveChip({
  directiveId,
  directiveType,
  label
}: DirectiveChipProps): React.JSX.Element {
  const identityIndex = useComposerContextIdentityIndex()
  const Icon =
    directiveType === 'command' ? undefined : (directiveChipIcons[directiveType] ?? WrenchIcon)

  return (
    <span
      className="aui-directive-chip"
      data-directive-id={directiveId}
      data-directive-type={directiveType}
    >
      {Icon ? (
        <span className="aui-directive-chip-icon">
          <Icon className="size-3" />
        </span>
      ) : null}
      <span className="aui-directive-chip-label">
        {displayDirectiveLabel(directiveType, directiveId, label, identityIndex)}
      </span>
    </span>
  )
}

function Composer(props: ComposerComponentProps): React.JSX.Element {
  const commandRegistry = useMemo(() => createComposerCommandRegistry(), [])
  return (
    <ComposerSuggestionProvider>
      <ComposerCommandRegistryProvider registry={commandRegistry}>
        <ComposerBody {...props} />
      </ComposerCommandRegistryProvider>
    </ComposerSuggestionProvider>
  )
}

function ComposerBody({
  activeConversation,
  composerModeKind,
  approvalModeKind,
  goalEditorActive,
  threadGoal,
  goalCapabilityStatus,
  goalOperation,
  goalError,
  composerContextCatalog,
  disabled,
  followUps,
  models,
  selectedModelId,
  modelSelectionError,
  onSelectedModelChange,
  onSteerFollowUp,
  onStartCodeReview,
  onCreateNewTask,
  onComposerModeKindChange,
  onApprovalModeKindChange,
  onGoalEditorActiveChange,
  onThreadGoalChange,
  onGoalOperationChange,
  onSaveThreadGoal,
  projectState,
  editingFollowUp,
  onEditingFollowUpChange,
  queueAttached,
  reservedEditingItemId
}: ComposerComponentProps): React.JSX.Element {
  const aui = useAui()
  const { controller: suggestionController, state: suggestionState } = useComposerSuggestion()
  const globalProjectSelection = projectState.state?.activeProjectSelection
  const conversationProjectSelection = activeConversation?.projectSelection
  const effectiveProjectSelection = activeConversation
    ? conversationProjectSelection
    : globalProjectSelection
  const isRemoteExecution = effectiveProjectSelection?.projectKind === 'remote'
  const gitRepository = useGitRepository()
  const gitTarget = gitRepository.status === 'ready' ? gitRepository.target : undefined
  const hasProjectContext = hasConversationProjectContext(activeConversation, projectState)
  const localContextPickerEnabled = !isRemoteExecution
  const [contextSearchOpen, setContextSearchOpen] = useState(false)
  const composerText = useAuiState((state) => state.composer.text)
  const composerAttachments = useAuiState((state) => state.composer.attachments)
  const isThreadRunning = useAuiState((state) => state.thread.isRunning)
  const [pausedSubmission, setPausedSubmission] = useState<{
    mode: FollowUpMode
    snapshot: QueuedUserMessageSnapshotInput
  } | null>(null)
  const [goalEditDialogOpen, setGoalEditDialogOpen] = useState(false)
  const [goalEditObjective, setGoalEditObjective] = useState('')
  const goalBusy = goalOperation !== 'idle'
  const clearThreadGoal = useCallback(async (): Promise<boolean> => {
    if (!threadGoal) {
      onGoalEditorActiveChange(false)
      return true
    }
    const threadId = activeConversation?.threadId
    if (!threadId) {
      onGoalOperationChange('idle', '当前对话尚未创建，无法清除目标')
      return false
    }
    onGoalOperationChange('clearing')
    try {
      const cleared = await window.desktopApp.conversations.clearConversationGoal({
        conversationId: threadId
      })
      if (!cleared) throw new Error('未能清除目标')
      onThreadGoalChange(null)
      onGoalEditorActiveChange(false)
      setGoalEditDialogOpen(false)
      return true
    } catch {
      onGoalOperationChange('idle', '无法清除目标，请稍后重试')
      return false
    }
  }, [
    activeConversation?.threadId,
    onGoalEditorActiveChange,
    onGoalOperationChange,
    onThreadGoalChange,
    threadGoal
  ])
  const enterGoalEditor = useCallback(() => {
    onComposerModeKindChange('default')
    if (threadGoal && activeConversation?.threadId) {
      onGoalEditorActiveChange(false)
      setGoalEditObjective(threadGoal.objective)
      setGoalEditDialogOpen(true)
      return
    }
    onGoalEditorActiveChange(true)
  }, [activeConversation?.threadId, onComposerModeKindChange, onGoalEditorActiveChange, threadGoal])
  const exitGoalEditor = useCallback(() => {
    onGoalEditorActiveChange(false)
  }, [onGoalEditorActiveChange])
  const goalEditCharacterCount = [...goalEditObjective].length
  const normalizedGoalEditObjective = goalEditObjective.trim()
  const canSaveGoalEdit =
    Boolean(normalizedGoalEditObjective) &&
    normalizedGoalEditObjective !== threadGoal?.objective &&
    goalEditCharacterCount <= 4_000 &&
    !goalBusy
  const saveGoalEdit = useCallback(async (): Promise<void> => {
    if (!canSaveGoalEdit) return
    if (await onSaveThreadGoal(goalEditObjective)) setGoalEditDialogOpen(false)
  }, [canSaveGoalEdit, goalEditObjective, onSaveThreadGoal])
  const enterPlanMode = useCallback(async () => {
    if (threadGoal && !(await clearThreadGoal())) return
    onGoalEditorActiveChange(false)
    onComposerModeKindChange('plan')
  }, [clearThreadGoal, onComposerModeKindChange, onGoalEditorActiveChange, threadGoal])
  const exitPlanMode = useCallback(() => {
    onComposerModeKindChange('default')
  }, [onComposerModeKindChange])
  const composerPlaceholder = goalEditorActive
    ? '描述你的目标，定义可衡量的成果，以获得最佳效果'
    : composerModeKind === 'plan'
      ? '描述你的任务以生成计划…'
      : '输入消息（@ 提及工具，/ 输入命令）'
  const modePresentations = useMemo<readonly ComposerModePresentation[]>(() => {
    if (goalEditorActive || threadGoal) {
      return [
        {
          id: 'goal',
          label: '目标',
          tooltip: goalBusy ? '正在更新目标' : threadGoal ? '清除目标' : '退出目标编辑',
          dismissLabel: threadGoal ? '清除目标' : '退出目标编辑',
          Icon: TargetIcon,
          onDismiss: threadGoal ? () => void clearThreadGoal() : exitGoalEditor,
          busy: goalBusy
        }
      ]
    }
    if (composerModeKind === 'plan') {
      return [
        {
          id: 'plan',
          label: '计划',
          tooltip: '关闭计划模式',
          dismissLabel: '关闭计划模式',
          Icon: LightbulbIcon,
          onDismiss: exitPlanMode
        }
      ]
    }
    return []
  }, [
    clearThreadGoal,
    composerModeKind,
    exitGoalEditor,
    exitPlanMode,
    goalBusy,
    goalEditorActive,
    threadGoal
  ])
  const selectedTaskIds = useMemo(
    () => [
      ...new Set(
        parseComposerContextReferences(composerText).flatMap((reference) =>
          reference.type === 'chat' ? [threadIdFromComposerReference(reference.path)] : []
        )
      )
    ],
    [composerText]
  )
  const composerContextSearch = useComposerContextSearch({
    cwd: resolveComposerCwd(activeConversation, projectState),
    enabled: contextSearchOpen && hasProjectContext,
    excludedThreadIds: selectedTaskIds,
    projectSelection: effectiveProjectSelection,
    query: composerContextCatalog.query,
    threadId: activeConversation?.threadId
  })
  const hasImageAttachments = useAuiState((state) =>
    state.composer.attachments.some((attachment) => attachment.type === 'image')
  )
  const hasLocalPathAttachments = useAuiState((state) =>
    state.composer.attachments.some((attachment) =>
      Boolean(localPathAttachmentIdentityFromId(attachment.id))
    )
  )
  const hasUnsendableAttachments = useAuiState((state) =>
    state.composer.attachments.some(
      (attachment) =>
        attachment.status.type === 'running' ||
        (attachment.status.type === 'incomplete' && attachment.status.reason === 'error')
    )
  )

  const modelContextTools = useMemo<Unstable_TriggerItem[]>(() => {
    const tools = aui.thread().getModelContext().tools
    if (!tools) return []
    return Object.entries(tools).map(([id, tool]) => ({
      id,
      type: 'tool',
      label: id,
      ...(tool.description ? { description: tool.description } : {}),
      metadata: { icon: 'tool' }
    }))
  }, [aui])
  const selectedModel = models.find((model) => model.id === selectedModelId)
  const selectedModelSupportsImages = selectedModel?.inputModalities?.includes('image') ?? true
  const cannotSendImages = hasImageAttachments && !selectedModelSupportsImages
  const pickLocalContext = useCallback(
    async (kind: LocalContextPickerKind): Promise<boolean> => {
      const references = await window.desktopApp.codex.pickLocalContext(kind)
      if (references.length === 0) return false

      const composer = aui.composer()
      for (const reference of references) {
        if (reference.kind === 'image') {
          await composer.addAttachment(
            createLocalImageAttachment({
              capabilityToken: reference.capabilityToken,
              label: reference.label,
              mediaType: reference.mediaType,
              path: reference.path,
              previewUrl: reference.previewUrl
            })
          )
          continue
        }
        await composer.addAttachment(
          createLocalPathAttachment({
            artifactPreviewToken: reference.artifactPreviewToken,
            capabilityToken: reference.capabilityToken,
            fileUrl: reference.fileUrl,
            kind: reference.kind,
            label: reference.label,
            path: reference.path
          })
        )
      }

      return true
    },
    [aui]
  )
  const sendDisabled =
    disabled ||
    !hasProjectContext ||
    cannotSendImages ||
    hasUnsendableAttachments ||
    (isRemoteExecution && hasLocalPathAttachments) ||
    Boolean(reservedEditingItemId && !editingFollowUp)
  const hasComposerContent = composerText.trim().length > 0 || composerAttachments.length > 0
  const commandDraftText = useMemo(() => {
    if (!suggestionState.open || suggestionState.trigger !== '/' || !suggestionState.range) {
      return composerText
    }
    return `${composerText.slice(0, suggestionState.range.start)}${composerText.slice(suggestionState.range.end)}`
  }, [composerText, suggestionState])
  const hasReviewCommandDraft = commandDraftText.trim().length > 0 || composerAttachments.length > 0
  const submitCodeReview = useCallback(
    async (selection: ComposerReviewSelection): Promise<void> => {
      if (!gitTarget) throw new Error('Choose a Git-backed conversation before starting a review')
      if (hasComposerContent) {
        throw new Error('请先发送或清空输入框中的草稿和附件，再开始审核')
      }
      const reviewTarget =
        selection.type === 'uncommitted'
          ? selection
          : {
              type: 'base-branch' as const,
              sourceBranch: selection.sourceBranch,
              ...(await window.desktopApp.git.resolveMergeBase({
                target: gitTarget,
                baseBranch: selection.baseBranch
              }))
            }
      const prompt = buildCodeReviewPrompt(reviewTarget)
      await onStartCodeReview(prompt)
    },
    [gitTarget, hasComposerContent, onStartCodeReview]
  )
  const reviewCommandDisabledReason = getReviewDisabledReason({
    hasDraft: hasReviewCommandDraft,
    hasGitTarget: Boolean(gitTarget),
    isEditing: Boolean(editingFollowUp),
    isRunning: isThreadRunning
  })
  const composerContentScope = useMemo(
    () =>
      JSON.stringify({
        conversationId: activeConversation?.conversationId,
        cwd: activeConversation?.cwd,
        projectSelection: effectiveProjectSelection,
        threadId: activeConversation?.threadId
      }),
    [
      activeConversation?.conversationId,
      activeConversation?.cwd,
      activeConversation?.threadId,
      effectiveProjectSelection
    ]
  )
  const previousComposerContentScope = useRef(composerContentScope)
  useEffect(() => {
    const previousScope = previousComposerContentScope.current
    previousComposerContentScope.current = composerContentScope
    if (previousScope === composerContentScope) return

    const suggestionContentOpen = suggestionState.open && suggestionState.view.type === 'content'
    if (!suggestionContentOpen) return

    const frameId = window.requestAnimationFrame(() => {
      suggestionController.close()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [composerContentScope, suggestionController, suggestionState])
  useEffect(() => {
    const suggestionContentOpen = suggestionState.open && suggestionState.view.type === 'content'
    if (!isThreadRunning || !suggestionContentOpen) return

    const frameId = window.requestAnimationFrame(() => {
      suggestionController.close()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [isThreadRunning, suggestionController, suggestionState])
  const commandContext = useMemo(
    () => ({
      draftText: commandDraftText,
      hasAttachments: composerAttachments.length > 0,
      isRunning: isThreadRunning,
      isEditing: Boolean(editingFollowUp),
      activeContentId:
        suggestionState.open && suggestionState.view.type === 'content'
          ? suggestionState.view.id
          : null,
      hasProject: hasProjectContext,
      hasGitReviewTarget: Boolean(gitTarget)
    }),
    [
      commandDraftText,
      composerAttachments.length,
      editingFollowUp,
      gitTarget,
      hasProjectContext,
      isThreadRunning,
      suggestionState
    ]
  )
  useRegisterComposerCommand({
    id: 'new-chat',
    title: 'New chat',
    description: '创建一个新的空白任务',
    group: 'General',
    searchAliases: ['new', 'new chat'],
    triggers: ['/'],
    requiresEmptyComposer: true,
    enabled: !isThreadRunning && !editingFollowUp,
    selection: { type: 'action', run: onCreateNewTask }
  })
  useRegisterComposerCommand({
    id: 'goal',
    title: '目标',
    description: '设置要持续追求的目标',
    group: 'General',
    searchAliases: ['goal', '目标'],
    triggers: ['/'],
    requiresEmptyComposer: false,
    // Goal changes target the thread owner and are safe while that owner is
    // active; disabling this would make an active Goal impossible to replace
    // or clear without first interrupting its turn.
    enabled: !editingFollowUp && !goalBusy && goalCapabilityStatus !== 'unsupported',
    selection: { type: 'action', run: enterGoalEditor }
  })
  useRegisterComposerCommand({
    id: 'plan-mode',
    title: '计划模式',
    description: composerModeKind === 'plan' ? '关闭计划模式' : '开启计划模式',
    group: 'General',
    searchAliases: ['plan', '计划', 'planning'],
    triggers: ['/'],
    requiresEmptyComposer: false,
    // Entering Plan clears any persisted Goal before changing local intent.
    // That mutation is routed to the existing owner when a turn is active.
    enabled: !editingFollowUp && !goalBusy,
    selection: {
      type: 'action',
      run: composerModeKind === 'plan' ? exitPlanMode : enterPlanMode
    }
  })
  useRegisterComposerCommand({
    id: 'code-review',
    title: 'Code review',
    description: '审核当前 Git 工作区的改动',
    group: 'Development',
    searchAliases: ['review', '代码审查'],
    triggers: ['/'],
    requiresEmptyComposer: true,
    enabled: !reviewCommandDisabledReason,
    selection: { type: 'content', contentId: 'code-review', placement: 'panel' }
  })
  useRegisterComposerCommand({
    id: 'mcp',
    title: 'MCP',
    description: '查看 MCP 服务状态',
    group: 'Development',
    searchAliases: ['mcp servers'],
    triggers: ['/'],
    enabled: !editingFollowUp,
    selection: { type: 'content', contentId: 'mcp', placement: 'panel' }
  })
  const contextActions = useMemo<readonly ComposerSuggestionItem[]>(
    () => [
      {
        id: 'context:add:goal',
        kind: 'context',
        label: '目标',
        description: '设置要持续追求的目标',
        icon: <TargetIcon className="size-4" />,
        searchTerms: ['goal', '目标'],
        disabled: Boolean(editingFollowUp) || goalBusy || goalCapabilityStatus === 'unsupported',
        selection: { type: 'action', run: enterGoalEditor }
      },
      {
        id: 'context:add:plan',
        kind: 'context',
        label: '计划',
        description: composerModeKind === 'plan' ? '关闭计划模式' : '开启计划模式',
        icon: <LightbulbIcon className="size-4" />,
        searchTerms: ['plan', '计划', 'planning'],
        disabled: Boolean(editingFollowUp) || goalBusy,
        selection: {
          type: 'action',
          run: composerModeKind === 'plan' ? exitPlanMode : enterPlanMode
        }
      }
    ],
    [
      composerModeKind,
      editingFollowUp,
      enterGoalEditor,
      enterPlanMode,
      exitPlanMode,
      goalBusy,
      goalCapabilityStatus
    ]
  )
  const enqueueRunningFollowUp = useCallback(
    async (mode: FollowUpMode) => {
      const id = editingFollowUp?.itemId ?? crypto.randomUUID()
      const cwd = resolveComposerCwd(activeConversation, projectState) ?? null
      const selection = effectiveProjectSelection
      const conversationKey =
        activeConversation?.threadId ??
        activeConversation?.conversationId ??
        followUps.state?.conversationKey
      if (!conversationKey) throw new Error('当前会话尚未准备好，无法保存追问')
      const hostId = selection?.projectKind === 'remote' ? selection.hostId : 'local'
      const snapshot = await createQueuedFollowUpSnapshot({
        id,
        text: composerText,
        attachments: composerAttachments,
        trustedContext:
          editingFollowUp?.trustedContext ??
          ({
            conversationId: activeConversation?.conversationId ?? conversationKey,
            ...(activeConversation?.threadId ? { threadId: activeConversation.threadId } : {}),
            ...(selection ? { projectSelection: selection } : {}),
            hostId,
            cwd,
            workspaceRoots: projectState.state?.activeWorkspaceRoots ?? (cwd ? [cwd] : [])
          } satisfies QueuedFollowUpTrustedContext)
      })
      if (editingFollowUp) snapshot.contextReferences = editingFollowUp.contextReferences
      if (!editingFollowUp && followUps.items[0]?.status === 'paused-interrupted') {
        setPausedSubmission({ mode, snapshot })
        return
      }
      if (editingFollowUp) {
        await followUps.commitEdit(editingFollowUp.itemId, snapshot)
        onEditingFollowUpChange(null)
        await aui.composer().reset()
      } else {
        await followUps.enqueue(snapshot, mode)
        await aui.composer().reset()
        if (mode === 'steer') await onSteerFollowUp(id, snapshot)
      }
    },
    [
      activeConversation,
      aui,
      composerAttachments,
      composerText,
      editingFollowUp,
      effectiveProjectSelection,
      followUps,
      onEditingFollowUpChange,
      onSteerFollowUp,
      projectState
    ]
  )

  const contextSections = useMemo(() => {
    const catalogSections = composerContextCatalog.sections.map((section) => {
      let items = section.items
      if (composerContextCatalog.loading) {
        items = []
      } else if (section.id === 'apps') {
        items = section.items.slice(0, 3)
      }
      return {
        id: section.id,
        label: composerContextSectionLabel(section.id),
        items,
        loading: composerContextCatalog.loading,
        error: section.error,
        onRetry: () => composerContextCatalog.refresh(section.id),
        preFiltered: true
      }
    })
    if (!composerContextCatalog.query.trim()) {
      return [
        ...catalogSections.filter((section) => section.id !== 'skills'),
        {
          id: 'files-and-tasks',
          label: 'Files and tasks',
          items: [],
          placeholder: '输入以搜索文件或任务',
          preFiltered: true
        },
        { id: 'tools', label: 'Tools', items: modelContextTools, preFiltered: true }
      ]
    }

    const dynamicSections = composerContextSearch.sections.map((section) => ({
      id: section.id,
      items: selectedTaskIds.length >= 3 && section.id === 'tasks' ? [] : section.items
    }))
    return buildComposerGlobalSearchResult({
      query: composerContextCatalog.query,
      sections: [...catalogSections, ...dynamicSections],
      loading: composerContextCatalog.loading || composerContextSearch.loading,
      sourceErrors: [
        ...catalogSections.flatMap((section) => (section.error ? [section.error] : [])),
        ...composerContextSearch.sections.flatMap((section) =>
          section.error ? [section.error] : []
        )
      ],
      warnings: selectedTaskIds.length >= 3 ? ['每条消息最多引用 3 个任务'] : []
    })
  }, [
    composerContextCatalog,
    composerContextSearch.loading,
    composerContextSearch.sections,
    modelContextTools,
    selectedTaskIds
  ])

  return (
    <>
      <Dialog open={goalEditDialogOpen && Boolean(threadGoal)} onOpenChange={setGoalEditDialogOpen}>
        <DialogContent data-slot="thread-goal-edit-dialog">
          <DialogHeader>
            <DialogTitle>编辑目标</DialogTitle>
            <DialogDescription>更新后，Codex 会继续围绕新目标推进当前任务。</DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            aria-label="目标内容"
            className="min-h-40 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            maxLength={4_000}
            value={goalEditObjective}
            onChange={(event) => setGoalEditObjective(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
              event.preventDefault()
              void saveGoalEdit()
            }}
          />
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>按 Ctrl/⌘ + Enter 保存</span>
            <span>{goalEditCharacterCount.toLocaleString()} / 4,000</span>
          </div>
          {goalError ? (
            <p role="alert" className="text-sm text-destructive">
              {goalError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={goalBusy}
              onClick={() => setGoalEditDialogOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={!canSaveGoalEdit} onClick={() => void saveGoalEdit()}>
              {goalBusy ? '保存中…' : '保存目标'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={pausedSubmission !== null}
        onOpenChange={(open) => {
          if (!open) setPausedSubmission(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>追问队列已暂停</DialogTitle>
            <DialogDescription>
              你刚刚停止了任务。请选择如何处理原来的追问，再继续提交这条新消息。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setPausedSubmission(null)}>
              取消
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  const pending = pausedSubmission
                  if (!pending) return
                  void (async () => {
                    await followUps.clear()
                    await followUps.enqueue(pending.snapshot, pending.mode)
                    setPausedSubmission(null)
                    await aui.composer().reset()
                  })()
                }}
              >
                清空旧队列并发送
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const pending = pausedSubmission
                  if (!pending) return
                  void (async () => {
                    await followUps.enqueue(pending.snapshot, pending.mode)
                    await followUps.resume()
                    setPausedSubmission(null)
                    await aui.composer().reset()
                  })()
                }}
              >
                保留旧队列并恢复
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ComposerPrimitive.Root
        className="aui-composer-root relative flex w-full flex-col"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          if (isThreadRunning) {
            event.preventDefault()
            aui.composer().cancel()
          }
        }}
      >
        <div
          data-slot="aui_composer-shell"
          className={cn(
            'flex w-full flex-col gap-2 border border-border/60 bg-background p-(--composer-padding) shadow-[0_4px_16px_-8px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-[0_6px_24px_-8px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] dark:bg-muted/70',
            queueAttached ? 'rounded-b-3xl rounded-t-none' : 'rounded-3xl'
          )}
        >
          {editingFollowUp ? (
            <div
              data-slot="queued-follow-up-editing"
              className="flex items-center justify-between gap-3 rounded-xl bg-muted/65 px-2.5 py-1.5 text-xs text-muted-foreground"
            >
              <span>正在编辑排队消息</span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  void (async () => {
                    await followUps.cancelEdit(editingFollowUp.itemId)
                    await aui.composer().reset()
                    onEditingFollowUpChange(null)
                  })()
                }}
              >
                取消编辑
              </Button>
            </div>
          ) : null}
          <ComposerAttachments />
          <ContextLexicalInput
            className="aui-composer-input relative max-h-32 min-h-10 w-full resize-none overflow-y-auto bg-transparent px-2.5 py-1 text-base leading-6 outline-none [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 [&_.aui-directive-chip-icon]:self-center [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:inset-x-0 [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1 [&_.aui-lexical-placeholder]:text-muted-foreground/80 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300"
            directiveChip={DirectiveChip}
            formatter={composerContextDirectiveFormatter}
            placeholder={composerPlaceholder}
          />
          <div className="aui-composer-action-wrapper flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-1">
              <ComposerAddContextPopover />
              <ComposerApprovalModeSelector
                approvalModeKind={approvalModeKind}
                disabled={disabled || isThreadRunning}
                onApprovalModeKindChange={onApprovalModeKindChange}
              />
              <ComposerModeIndicatorBar presentations={modePresentations} />
              {threadGoal ? (
                <IconButton
                  className="size-7 rounded-full bg-transparent hover:bg-muted"
                  disabled={goalBusy}
                  label="编辑目标"
                  title="编辑目标"
                  onClick={enterGoalEditor}
                >
                  <PencilIcon className="size-3.5" />
                </IconButton>
              ) : null}
              {isRemoteExecution &&
              (gitRepository.status === 'unavailable' || gitRepository.status === 'error') ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-slot="git-repository-retry"
                  title={
                    gitRepository.status === 'unavailable'
                      ? gitRepository.reason
                      : gitRepository.error.message
                  }
                  onClick={gitRepository.retry}
                >
                  重试 Git
                </Button>
              ) : null}
              {modelSelectionError && (
                <span
                  role="alert"
                  data-slot="model-selection-error"
                  className="text-destructive max-w-56 truncate text-xs"
                  title={modelSelectionError}
                >
                  {modelSelectionError}
                </span>
              )}
              {goalError ? (
                <span
                  role="alert"
                  data-slot="composer-goal-error"
                  className="max-w-56 truncate text-xs text-destructive"
                  title={goalError}
                >
                  {goalError}
                </span>
              ) : null}
              {cannotSendImages ? (
                <span
                  role="alert"
                  data-slot="composer-image-model-error"
                  className="max-w-56 truncate text-xs text-destructive"
                >
                  移除照片或切换到支持图片的模型
                </span>
              ) : null}
              {isRemoteExecution && hasLocalPathAttachments ? (
                <span
                  role="alert"
                  data-slot="composer-remote-local-attachment-error"
                  className="max-w-64 truncate text-xs text-destructive"
                >
                  移除本地文件附件后才能发送到远程项目
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5">
              <ModelSelector
                models={models}
                value={selectedModelId}
                onValueChange={onSelectedModelChange}
                variant="ghost"
                size="sm"
              />
              {!editingFollowUp ? (
                <AuiIf condition={(state) => !state.thread.isRunning}>
                  <ComposerPrimitive.Send asChild>
                    <IconButton
                      className="aui-composer-send size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                      disabled={sendDisabled}
                      label="发送消息"
                      title="发送消息"
                    >
                      <ArrowUpIcon className="size-4.5" />
                    </IconButton>
                  </ComposerPrimitive.Send>
                </AuiIf>
              ) : null}
              {isThreadRunning && !hasComposerContent ? (
                <ComposerPrimitive.Cancel asChild>
                  <IconButton
                    className="aui-composer-cancel size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                    label="停止生成"
                    title="停止生成"
                  >
                    <SquareIcon className="size-3.5 fill-current" />
                  </IconButton>
                </ComposerPrimitive.Cancel>
              ) : null}
              {(editingFollowUp || isThreadRunning) && hasComposerContent ? (
                <>
                  <IconButton
                    className="size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                    disabled={sendDisabled || followUps.loading}
                    label={
                      editingFollowUp
                        ? '保存编辑后的排队消息'
                        : followUps.defaultMode === 'queue'
                          ? '将追问加入队列'
                          : '立即调整当前任务'
                    }
                    title={
                      editingFollowUp
                        ? '保存到原来的队列位置'
                        : followUps.defaultMode === 'queue'
                          ? '排队（按住 Shift 单次引导）'
                          : '引导（按住 Shift 单次排队）'
                    }
                    onClick={(event) => {
                      const mode = editingFollowUp
                        ? followUps.defaultMode
                        : event.shiftKey
                          ? followUps.defaultMode === 'queue'
                            ? 'steer'
                            : 'queue'
                          : followUps.defaultMode
                      void enqueueRunningFollowUp(mode).catch(() => undefined)
                    }}
                  >
                    <ArrowUpIcon className="size-4.5" />
                  </IconButton>
                  <ComposerPrimitive.Cancel asChild>
                    <IconButton
                      className="size-7 rounded-full bg-transparent hover:bg-muted"
                      label="停止生成"
                      title="停止生成（Esc）"
                    >
                      <SquareIcon className="size-3 fill-current" />
                    </IconButton>
                  </ComposerPrimitive.Cancel>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <ComposerSuggestionSurface
          codeReview={{
            target: gitTarget,
            disabled: sendDisabled || isThreadRunning,
            onSubmit: submitCodeReview
          }}
          commandContext={commandContext}
          contextActions={contextActions}
          contextSections={contextSections}
          localPickerEnabled={localContextPickerEnabled}
          onContextOpenChange={setContextSearchOpen}
          onContextQueryChange={composerContextCatalog.setQuery}
          onOpenContent={() => undefined}
          pickLocalContext={pickLocalContext}
          threadId={activeConversation?.threadId}
        />
      </ComposerPrimitive.Root>
    </>
  )
}

function hasConversationProjectContext(
  activeConversation: ActiveConversationContext | undefined,
  projectState: ProjectStateController
): boolean {
  if (!activeConversation?.threadId) return projectState.state !== null
  return Boolean(
    activeConversation.threadId || activeConversation.projectSelection || activeConversation.cwd
  )
}

function getReviewDisabledReason({
  hasDraft,
  hasGitTarget,
  isEditing,
  isRunning
}: {
  hasDraft: boolean
  hasGitTarget: boolean
  isEditing: boolean
  isRunning: boolean
}): string | undefined {
  if (!hasGitTarget) return '当前会话没有可审核的 Git 仓库'
  if (isRunning) return '请等待当前任务完成后再开始审核'
  if (isEditing) return '请先完成或取消正在编辑的排队消息'
  if (hasDraft) return '请先发送或清空输入框中的草稿和附件，再开始审核'
  return undefined
}

function resolveComposerCwd(
  activeConversation: ActiveConversationContext | undefined,
  projectState: ProjectStateController
): string | undefined {
  if (activeConversation?.cwd) return activeConversation.cwd
  const selection =
    activeConversation?.projectSelection ?? projectState.state?.activeProjectSelection
  if (selection?.projectKind === 'path') return selection.path
  if (selection?.projectKind === 'local') {
    const project = projectState.state?.localProjects[selection.projectId]
    return project?.defaultCwd ?? project?.writableRoots[0]
  }
  return projectState.state?.activeWorkspaceRoots?.[0]
}

function resolvePluginCenterLocalCwd(
  activeConversation: ActiveConversationContext | undefined,
  activeEntry: ConversationChatEntry,
  projectState: ProjectState | null
): string | undefined {
  const selection = activeConversation?.projectSelection ?? activeEntry.context.projectSelection
  const cwd = activeConversation?.cwd ?? activeEntry.context.cwd ?? undefined

  if (selection?.projectKind === 'path') return selection.path
  if (selection?.projectKind === 'local') {
    const project = projectState?.localProjects[selection.projectId]
    return cwd ?? project?.defaultCwd ?? project?.writableRoots[0]
  }
  if (selection) return undefined

  if (activeConversation) return undefined

  const activeSelection = projectState?.activeProjectSelection
  if (activeSelection?.projectKind === 'path') return activeSelection.path
  if (activeSelection?.projectKind === 'local') {
    const project = projectState?.localProjects[activeSelection.projectId]
    return project?.defaultCwd ?? project?.writableRoots[0]
  }

  return undefined
}

function composerContextSectionLabel(sectionId: string): string {
  switch (sectionId) {
    case 'files':
      return 'Files'
    case 'chats':
      return 'Tasks'
    case 'tasks':
      return 'Tasks'
    case 'agents':
      return '智能体'
    case 'skills':
      return '技能'
    case 'plugins':
      return '插件'
    case 'apps':
      return 'Apps'
    default:
      return sectionId
  }
}

function threadIdFromComposerReference(uri: string): string {
  const encodedThreadId = uri.slice('thread://'.length)
  try {
    return decodeURIComponent(encodedThreadId)
  } catch {
    return encodedThreadId
  }
}

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { children, className, label, title, type, ...buttonProps },
  ref
): React.JSX.Element {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
      type={type ?? 'button'}
      aria-label={label}
      title={title ?? label}
      {...buttonProps}
    >
      {children}
    </button>
  )
})

export default App
