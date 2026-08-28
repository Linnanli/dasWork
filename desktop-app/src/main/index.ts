import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  protocol,
  session
} from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import {
  createCodexContextCatalogClient,
  createCodexHistoryClient,
  type CodexContextCatalogClient
} from '@janole/ai-sdk-provider-codex-asp'
import icon from '../../resources/icon.png?asset'
import { createBeforeQuitHandler } from './appShutdown'
import { AutomationService } from './automations/AutomationService'
import { AutomationStore } from './automations/AutomationStore'
import { CodexChatRuntimeService } from './codexChatRuntimeService'
import { createCodexAspSharedConnection, type CodexAspSharedConnection } from './codexAspProvider'
import { resolveCodexAppServerLaunchOptions } from './codexAppServerLaunch'
import { createCodexClientInfo } from './codexClientInfo'
import { AppServerThreadClient } from './conversations/AppServerThreadClient'
import { TurnDiffStore } from './conversations/TurnDiffStore'
import {
  ConversationApiService,
  type ObservedStartedThread
} from './conversations/ConversationApiService'
import { ConversationWindowRouter } from './conversations/ConversationWindowRouter'
import { ConversationForkService } from './conversations/ConversationForkService'
import { ManagedWorktreeService } from './conversations/ManagedWorktreeService'
import { ConversationPreferencesStore } from './conversations/ConversationPreferencesStore'
import { createNativeContextMenuHandler, installWindowContextMenu } from './contextMenu'
import { createPickLocalContextHandler } from './localContextPicker'
import { LocalImageCapabilityStore } from './localImageCapabilityStore'
import { LocalPathCapabilityStore } from './localPathCapabilityStore'
import { createListExistingLocalPathsHandler } from './localPathExistence'
import { createOpenLocalPathHandler, createRevealLocalPathHandler } from './localPathOpen'
import { createStartLocalPathDragHandler } from './localPathDrag'
import { sendToActiveRenderer } from './rendererIpc'
import {
  createAppRendererUrl,
  registerAppProtocol,
  registerAppSchemePrivileges
} from './localMediaProtocol'
import { createModelCatalogService } from './modelCatalogService'
import { ComposerContextCatalogService } from './composerContext/ComposerContextCatalogService'
import { ComposerContextChangeBroker } from './composerContext/ComposerContextChangeBroker'
import { ComposerContextSearchService } from './composerContext/ComposerContextSearchService'
import {
  createListComposerContextHandler,
  createRefreshComposerContextHandler
} from './composerContext/composerContextIpc'
import {
  createStartComposerContextSearchHandler,
  createStopComposerContextSearchHandler,
  createUpdateComposerContextSearchHandler
} from './composerContext/composerContextSearchIpc'
import { LiveAgentRegistry } from './composerContext/LiveAgentRegistry'
import { LocalAgentRoleCatalog, resolveCodexHome } from './composerContext/LocalAgentRoleCatalog'
import { createValidateLocalAttachmentsHandler } from './composerContext/localAttachmentValidation'
import { ConversationFollowUpQueueService } from './followUps/ConversationFollowUpQueueService'
import { ConversationFollowUpQueueStore } from './followUps/ConversationFollowUpQueueStore'
import { FollowUpAssetStore } from './followUps/FollowUpAssetStore'
import { steerQueuedFollowUp } from './followUps/steerQueuedFollowUp'
import { validateQueuedLocalAttachments } from './followUps/validateQueuedLocalAttachments'
import { McpServerStatusService } from './mcp/McpServerStatusService'
import { createListMcpServersHandler } from './mcp/mcpServerStatusIpc'
import { McpAppResourceService } from './mcp/McpAppResourceService'
import { createReadMcpAppResourceHandler } from './mcp/mcpAppResourceIpc'
import { PluginCenterService } from './pluginCenter/PluginCenterService'
import { createPluginCenterIpcHandlers } from './pluginCenter/registerPluginCenterIpc'
import type { ProjectApiService } from './projects/ProjectApiService'
import type { ProjectService } from './projects/ProjectService'
import { ProjectWorktreeService } from './projects/ProjectWorktreeService'
import { createProjectRuntimeServices } from './projects/projectRuntimeServices'
import type { WorkspaceRecoveryService } from './projects/WorkspaceRecoveryService'
import type { ProjectStore } from './projects/ProjectStore'
import { LocalGitService } from './localGit/LocalGitService'
import { LocalCommitService } from './localGit/LocalCommitService'
import { LocalPushService } from './localGit/LocalPushService'
import { GithubPullRequestService } from './githubPullRequests/GithubPullRequestService'
import { createGithubPullRequestIpcHandlers } from './githubPullRequests/githubPullRequestIpc'
import { KeyboardShortcutService } from './keyboardShortcuts/KeyboardShortcutService'
import { createKeyboardShortcutIpcHandlers } from './keyboardShortcuts/keyboardShortcutIpc'
import { GitManager } from './localGit/GitManager'
import { GitHostRegistry } from './localGit/GitHostRegistry'
import { GitRepositoryTargetResolver } from './localGit/GitRepositoryTargetResolver'
import { CodexHostConnectionRegistry } from './hosts/CodexHostConnectionRegistry'
import { TerminalBackendFactory } from './terminal/TerminalBackendFactory'
import { createLocalGitIpcHandlers } from './localGit/localGitIpc'
import { LocalGitWatchBroker, localGitWatchControlChannels } from './localGit/LocalGitWatchBroker'
import { invalidateLocalGitWatchCaches } from './localGit/LocalGitWatchInvalidation'
import { loadDesktopRuntimeConfig } from './runtimeConfig'
import {
  registerRightWorkspaceIpc,
  type RightWorkspaceIpcRegistration
} from './rightWorkspace/registerRightWorkspaceIpc'
import { createMainWindowOptions } from './windowOptions'
import { installApplicationMenu } from './applicationMenu'
import {
  codexChatAttachPayloadSchema,
  codexChatPortDetachedPayloadSchema,
  codexChatStartPayloadSchema,
  isExternalHttpUrl,
  codexOpenExternalHttpUrlPayloadSchema,
  projectCreateBlankPayloadSchema,
  projectCreateLocalPayloadSchema,
  projectCreateRemotePayloadSchema,
  projectActionRemovePayloadSchema,
  projectActionUpsertPayloadSchema,
  projectRenamePayloadSchema,
  projectSelectPayloadSchema,
  projectWorktreeListPayloadSchema,
  projectWorktreeSelectPayloadSchema,
  workspaceRecoveryPayloadSchema,
  codexRespondApprovalPayloadSchema,
  codexSnoozeApprovalAutoResolutionPayloadSchema,
  codexSetSelectedModelPayloadSchema,
  type CodexChatAttachResult,
  type ComposerContextCatalogChangeEvent,
  type FollowUpQueueChangeEvent,
  followUpClaimNextPayloadSchema,
  followUpCommitEditPayloadSchema,
  followUpConversationActionPayloadSchema,
  followUpEditPayloadSchema,
  followUpEnqueuePayloadSchema,
  followUpGetStatePayloadSchema,
  followUpItemActionPayloadSchema,
  followUpReorderPayloadSchema,
  followUpSetDefaultModePayloadSchema,
  followUpSteerItemPayloadSchema,
  sidebarConversationActionPayloadSchema,
  sidebarConversationBatchDeletePayloadSchema,
  sidebarConversationFeedbackPayloadSchema,
  sidebarConversationForkPayloadSchema,
  sidebarConversationGoalSetPayloadSchema,
  sidebarConversationRenamePayloadSchema,
  sidebarPreferencesPatchSchema
} from '../shared/codexIpcApi'
import { gitIpcChannels } from '../shared/localGitApi'
import { githubPullRequestIpcChannels } from '../shared/githubPullRequestApi'
import { keyboardShortcutIpcChannels } from '../shared/keyboardShortcutsApi'
import {
  automationActionRequestSchema,
  automationCreateRequestSchema,
  automationIpcChannels,
  automationStatusRequestSchema,
  automationUpdateRequestSchema
} from '../shared/automationApi'
import { nativeContextMenuIpcChannels } from '../shared/nativeContextMenuApi'
import { parseConversationLink, type ConversationLink } from '../shared/conversationLink'
import type { ProjectState } from '../shared/projects/projectTypes'

let codexRuntime: CodexChatRuntimeService | undefined
let projectApi: ProjectApiService | undefined
let projectService: ProjectService | undefined
let projectStore: ProjectStore | undefined
let projectWorktrees: ProjectWorktreeService | undefined
let workspaceRecovery: WorkspaceRecoveryService | undefined
let automationService: AutomationService | undefined
let conversationApi: ConversationApiService | undefined
let conversationForkService: ConversationForkService | undefined
let composerContextCatalog: ComposerContextCatalogService | undefined
let composerContextSearch: ComposerContextSearchService | undefined
let composerContextChanges: ComposerContextChangeBroker | undefined
let composerContextClient: CodexContextCatalogClient | undefined
let mcpServerStatus: McpServerStatusService | undefined
let mcpAppResource: McpAppResourceService | undefined
let pluginCenterService: PluginCenterService | undefined
let codexAppServerConnection: CodexAspSharedConnection | undefined
let followUpQueue: ConversationFollowUpQueueService | undefined
let localGitWatchBroker: LocalGitWatchBroker | undefined
let gitHostRegistry: GitHostRegistry | undefined
let codexHostConnectionRegistry: CodexHostConnectionRegistry | undefined
let rightWorkspaceIpc: RightWorkspaceIpcRegistration | undefined
const localImageCapabilities = new LocalImageCapabilityStore()
const localPathCapabilities = new LocalPathCapabilityStore()
const convergingConversationThreadIds = new Set<string>()
let pendingConversationLink: ConversationLink | undefined
const pendingConversationLinksByWindowId = new Map<number, ConversationLink>()
const conversationWindowRouter = new ConversationWindowRouter()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const link = commandLine
      .map((argument) => parseConversationLink(argument))
      .find((candidate): candidate is ConversationLink => Boolean(candidate))
    if (link) openConversationLink(link)
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  const link = parseConversationLink(url)
  if (link) openConversationLink(link)
})

const e2eUserDataPath = process.env.DASCOWORK_E2E_USER_DATA_DIR?.trim()
if (e2eUserDataPath) app.setPath('userData', e2eUserDataPath)
const e2eDocumentsPath = process.env.DASCOWORK_E2E_DOCUMENTS_DIR?.trim()
if (e2eDocumentsPath) app.setPath('documents', e2eDocumentsPath)
registerAppSchemePrivileges(protocol)

function createCodexRuntime(
  hosts: GitHostRegistry,
  manager: GitManager,
  turnDiffStore: TurnDiffStore
): CodexChatRuntimeService {
  const launch = resolveCodexAppServerLaunchOptions({ env: process.env })
  const connection = createCodexAspSharedConnection(launch)
  codexAppServerConnection = connection
  const historyClient = createCodexHistoryClient({
    clientInfo: createCodexClientInfo('dascowork_desktop_sidebar', 'dasCowork Desktop Sidebar'),
    experimentalApi: true,
    transportFactory: connection.transportFactory
  })
  const projectRuntimeServices = createProjectRuntimeServices({
    userDataPath: app.getPath('userData'),
    documentsPath: app.getPath('documents'),
    pickWorkspaceRoot: pickWorkspaceRootPath,
    validateRemoteRoot: (hostId, path) => hosts.validateRemoteRoot(hostId, path),
    readThread: async (threadId) => ({
      thread: await historyClient.readThread(threadId)
    })
  })
  projectApi = projectRuntimeServices.projectApi
  projectService = projectRuntimeServices.projectService
  projectStore = projectRuntimeServices.projectStore
  projectWorktrees = new ProjectWorktreeService({
    projectService: projectRuntimeServices.projectService,
    gitHost: hosts.get('local')
  })
  workspaceRecovery = projectRuntimeServices.workspaceRecovery
  const threadClient = new AppServerThreadClient({ historyClient, turnDiffStore })
  conversationApi = new ConversationApiService({
    threadClient,
    projectStore: projectRuntimeServices.projectStore,
    preferencesStore: ConversationPreferencesStore.onDisk(
      join(app.getPath('userData'), 'conversations', 'preferences.json')
    ),
    waitForConversationSettlement: (conversationId) =>
      codexRuntime?.waitForConversationSettlement(conversationId) ?? Promise.resolve(),
    onConversationArchived: (conversationId) =>
      rightWorkspaceIpc?.terminalManager.closeForConversation(conversationId) ?? Promise.resolve(),
    onConversationDeleted: async (conversationId) => {
      await Promise.all([
        rightWorkspaceIpc?.terminalManager.closeForConversation(conversationId) ??
          Promise.resolve(),
        turnDiffStore.removeThread(conversationId),
        automationService?.removeConversationReferences(conversationId) ?? Promise.resolve()
      ])
    }
  })
  conversationForkService = new ConversationForkService({
    threadClient,
    projectStore: projectRuntimeServices.projectStore,
    managedWorktrees: new ManagedWorktreeService({
      projectService: projectRuntimeServices.projectService,
      gitHost: hosts.get('local'),
      gitManager: manager,
      worktreeRoot: join(app.getPath('userData'), 'worktrees')
    })
  })
  const liveAgents = new LiveAgentRegistry(threadClient)
  const agentRoles = new LocalAgentRoleCatalog({
    codexHome: resolveCodexHome(launch.env),
    projectService: projectRuntimeServices.projectService,
    warn: (message) => console.warn(`[agent-role-catalog] ${message}`)
  })
  composerContextClient = createCodexContextCatalogClient({
    clientInfo: createCodexClientInfo(
      'dascowork_desktop_composer_context',
      'dasCowork Desktop Composer Context'
    ),
    experimentalApi: true,
    connectionLifecycle: 'per-operation',
    transportFactory: connection.transportFactory
  })
  mcpServerStatus = new McpServerStatusService({
    provider: composerContextClient
  })
  mcpAppResource = new McpAppResourceService({ provider: historyClient })
  pluginCenterService = new PluginCenterService({
    provider: composerContextClient,
    defaultCwd: () => undefined,
    logger: (event, details) =>
      console.info(`[plugin-center:perf:${event}]`, { atMs: Date.now(), ...details })
  })
  composerContextCatalog = new ComposerContextCatalogService({
    provider: composerContextClient,
    agentRoles,
    liveAgents,
    defaultCwd: app.getAppPath()
  })
  composerContextSearch = new ComposerContextSearchService({
    provider: composerContextClient,
    projectService: projectRuntimeServices.projectService,
    projectStore: projectRuntimeServices.projectStore,
    conversations: conversationApi,
    publish: (ownerWebContentsId, event) => {
      const ownerWindow = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.id === ownerWebContentsId
      )
      if (ownerWindow && !ownerWindow.isDestroyed()) {
        sendToActiveRenderer(ownerWindow.webContents, 'codex:composer-context-search-update', event)
      }
    }
  })
  composerContextChanges?.dispose()
  composerContextChanges = new ComposerContextChangeBroker({
    publish: broadcastComposerContextChange
  })
  const followUpRoot = join(app.getPath('userData'), 'follow-ups')
  followUpQueue = new ConversationFollowUpQueueService({
    store: ConversationFollowUpQueueStore.onDisk(join(followUpRoot, 'queue.json')),
    assetStore: new FollowUpAssetStore(join(followUpRoot, 'assets'), {
      authorizeLocalImages: (requests) => localImageCapabilities.consumeAll(requests)
    }),
    validateLocalAttachments: (attachments) =>
      validateQueuedLocalAttachments(attachments, {
        capabilities: localPathCapabilities,
        stat
      }),
    logger: (event, details) => console.info(`[follow-up:${event}]`, details),
    findAcceptedClientUserMessageIds: async (conversationKey, candidateIds) => {
      const thread = await historyClient.readThread(conversationKey, { includeTurns: true })
      const candidates = new Set(candidateIds)
      const accepted = new Set<string>()
      for (const turn of thread.turns) {
        for (const item of turn.items) {
          if (item.type === 'userMessage' && item.clientId && candidates.has(item.clientId)) {
            accepted.add(item.clientId)
          }
        }
      }
      return [...accepted]
    }
  })
  followUpQueue.subscribe(broadcastFollowUpChange)

  return new CodexChatRuntimeService({
    launch,
    connection,
    modelCatalog: createModelCatalogService(loadDesktopRuntimeConfig(process.env)),
    projectService: projectRuntimeServices.projectService,
    projectStore: projectRuntimeServices.projectStore,
    turnDiffStore,
    collaborationModeClient: historyClient,
    followUpQueue,
    onTurnCompleted: () => manager.handleAppEvent({ type: 'turnComplete' }),
    onAgentLifecycle: (event) => {
      liveAgents.observe(event)
      composerContextChanges?.notify({
        sectionIds: ['agents'],
        scope: { threadId: event.threadId }
      })
    },
    onThreadBound: (conversationId, threadId) =>
      rightWorkspaceIpc?.terminalManager.bindThread(conversationId, threadId),
    readThreadTerminal: (threadId) =>
      rightWorkspaceIpc?.terminalManager.readThreadTerminal(threadId) ?? { terminalAttached: false }
  })
}

async function pickWorkspaceRootPath(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })

  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function chooseLocalContextPickerKind(): Promise<'files' | 'folders' | null> {
  const result = await dialog.showMessageBox({
    type: 'question',
    title: '选择文件文件夹',
    message: '请选择要添加的内容',
    buttons: ['选择文件', '选择文件夹', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  })

  if (result.response === 0) return 'files'
  if (result.response === 1) return 'folders'
  return null
}

async function openExternalHttpUrl(url: string): Promise<void> {
  if (!isExternalHttpUrl(url)) throw new Error('external URL must be http(s)')
  await shell.openExternal(url)
}

function requireProjectApi(): ProjectApiService {
  if (!projectApi) throw new Error('Project API is not initialized')
  return projectApi
}

function requireWorkspaceRecovery(): WorkspaceRecoveryService {
  if (!workspaceRecovery) throw new Error('Workspace recovery is not initialized')
  return workspaceRecovery
}

function requireProjectService(): ProjectService {
  if (!projectService) throw new Error('Project service is not initialized')
  return projectService
}

function requireProjectStore(): ProjectStore {
  if (!projectStore) throw new Error('Project store is not initialized')
  return projectStore
}

function requireProjectWorktrees(): ProjectWorktreeService {
  if (!projectWorktrees) throw new Error('Project worktrees are not initialized')
  return projectWorktrees
}

function requireAutomationService(): AutomationService {
  if (!automationService) throw new Error('Automation service is not initialized')
  return automationService
}

function requireConversationApi(): ConversationApiService {
  if (!conversationApi) throw new Error('Conversation API is not initialized')
  return conversationApi
}

function requireConversationForkService(): ConversationForkService {
  if (!conversationForkService) throw new Error('Conversation fork service is not initialized')
  return conversationForkService
}

function requireComposerContextCatalog(): ComposerContextCatalogService {
  if (!composerContextCatalog) throw new Error('Composer context catalog is not initialized')
  return composerContextCatalog
}

function requireComposerContextSearch(): ComposerContextSearchService {
  if (!composerContextSearch) throw new Error('Composer context search is not initialized')
  return composerContextSearch
}

function requireComposerContextClient(): CodexContextCatalogClient {
  if (!composerContextClient) throw new Error('Composer context client is not initialized')
  return composerContextClient
}

function requireMcpServerStatus(): McpServerStatusService {
  if (!mcpServerStatus) throw new Error('MCP server status service is not initialized')
  return mcpServerStatus
}

function requireMcpAppResource(): McpAppResourceService {
  if (!mcpAppResource) throw new Error('MCP App resource service is not initialized')
  return mcpAppResource
}

function requirePluginCenterService(): PluginCenterService {
  if (!pluginCenterService) throw new Error('Plugin Center service is not initialized')
  return pluginCenterService
}

function requireFollowUpQueue(): ConversationFollowUpQueueService {
  if (!followUpQueue) throw new Error('Follow-up queue is not initialized')
  return followUpQueue
}

function assertApprovalOwner(webContentsId: number, requestId: string): void {
  if (conversationWindowRouter.ownsApproval(webContentsId, requestId)) return
  throw new Error('该审批属于另一个窗口或已结束。')
}

function broadcastStatus(): void {
  if (!codexRuntime) return
  const status = codexRuntime.getStatus()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToActiveRenderer(window.webContents, 'codex:status-change', status)
    }
  }
}

function broadcastFollowUpChange(event: FollowUpQueueChangeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToActiveRenderer(window.webContents, 'codex:follow-ups:changed', event)
    }
  }
}

async function broadcastProjectState(stateOverride?: ProjectState): Promise<void> {
  if (!projectApi) return
  const state = stateOverride ?? (await projectApi.getState())
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToActiveRenderer(window.webContents, 'codex:projects-state-change', state)
    }
  }
  const conversationState = conversationApi?.applyProjectState(state)
  if (conversationState?.loaded) sendConversationState(conversationState)
}

function broadcastComposerContextChange(event: ComposerContextCatalogChangeEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToActiveRenderer(window.webContents, 'codex:composer-context-change', event)
    }
  }
}

async function broadcastConversationState(
  options: {
    awaitThreadId?: string
    discardStartedObservationOnConvergenceFailure?: boolean
  } = {}
): Promise<void> {
  if (!conversationApi) return
  if (options.awaitThreadId) {
    // Immediately broadcast with ensure so the sidebar shows the thread right away,
    // even if thread/list hasn't caught up yet.
    const ensuredState = await conversationApi.refreshConversationList({
      ensureThreadIds: [options.awaitThreadId]
    })
    sendConversationState(ensuredState)
    // In the background, wait for thread/list to converge (include the thread
    // naturally), then broadcast the converged state.
    startConversationListConvergence(options.awaitThreadId, {
      discardStartedObservationOnFailure:
        options.discardStartedObservationOnConvergenceFailure ?? false
    })
  } else {
    const state = await conversationApi.refreshConversationList()
    sendConversationState(state)
  }
}

function broadcastStartedConversation(threadId: string, thread: ObservedStartedThread): void {
  if (!conversationApi) return
  const api = conversationApi
  sendConversationState(api.observeStartedThreadSnapshot(thread))
  void api
    .observeStartedThread(thread)
    .then(sendConversationState)
    .catch((error: unknown) => {
      console.error(`failed to publish started thread ${threadId}`, error)
      void broadcastConversationState({ awaitThreadId: threadId })
    })
  startConversationListConvergence(threadId, { discardStartedObservationOnFailure: false })
}

function sendConversationState(
  state: Awaited<ReturnType<ConversationApiService['refreshConversationList']>>
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToActiveRenderer(window.webContents, 'codex:conversations-state-change', state)
    }
  }
  composerContextChanges?.notify({ sectionIds: ['chats'] })
}

function openConversationLink(link: ConversationLink): void {
  const target =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())
  if (!target) {
    pendingConversationLink = link
    return
  }
  deliverConversationLink(target, link)
}

function deliverConversationLink(window: BrowserWindow, link: ConversationLink): void {
  if (window.isDestroyed()) return
  pendingConversationLinksByWindowId.set(window.webContents.id, link)
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  sendToActiveRenderer(window.webContents, 'codex:conversations:open-link', link)
}

function startConversationListConvergence(
  threadId: string,
  options: { discardStartedObservationOnFailure: boolean }
): void {
  if (convergingConversationThreadIds.has(threadId)) return
  convergingConversationThreadIds.add(threadId)
  void convergeConversationList(threadId, options)
    .catch((error: unknown) => {
      console.error(`failed to converge thread/list for ${threadId}`, error)
    })
    .finally(() => {
      convergingConversationThreadIds.delete(threadId)
    })
}

async function convergeConversationList(
  awaitThreadId: string,
  options: { discardStartedObservationOnFailure: boolean }
): Promise<void> {
  if (!conversationApi) return
  const maxAttempts = 8
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await delay(150 * attempt)
    if (await conversationApi.hasThreadInList(awaitThreadId)) {
      const state = await conversationApi.refreshConversationList()
      sendConversationState(state)
      return
    }
  }
  console.warn(`thread/list did not include ${awaitThreadId} after ${maxAttempts} attempts`)
  if (!options.discardStartedObservationOnFailure) return
  const state = await conversationApi.discardStartedThreadObservation(awaitThreadId)
  sendConversationState(state)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createWindow(options: { conversationLink?: ConversationLink } = {}): BrowserWindow {
  let initialConversationLink = options.conversationLink
  const mainWindow = new BrowserWindow(
    createMainWindowOptions({
      preloadPath: join(__dirname, '../preload/index.js'),
      icon
    })
  )
  const ownerWebContentsId = mainWindow.webContents.id
  rightWorkspaceIpc?.attachWindow(mainWindow)

  mainWindow.webContents.on('did-start-loading', () => {
    rightWorkspaceIpc?.detachWindow(ownerWebContentsId)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (!mainWindow.isDestroyed()) rightWorkspaceIpc?.attachWindow(mainWindow)
    if (initialConversationLink) {
      const link = initialConversationLink
      initialConversationLink = undefined
      deliverConversationLink(mainWindow, link)
      return
    }
    if (pendingConversationLink) {
      const link = pendingConversationLink
      pendingConversationLink = undefined
      deliverConversationLink(mainWindow, link)
    }
  })
  mainWindow.webContents.on('render-process-gone', () => {
    rightWorkspaceIpc?.disposeWindow(ownerWebContentsId)
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isExternalHttpUrl(details.url)) {
      void shell.openExternal(details.url).catch(() => console.error('failed to open external URL'))
    }
    return { action: 'deny' }
  })
  installWindowContextMenu(mainWindow, Menu)
  mainWindow.on('closed', () => {
    pendingConversationLinksByWindowId.delete(ownerWebContentsId)
    conversationWindowRouter.releaseWindow(ownerWebContentsId)
    rightWorkspaceIpc?.disposeWindow(ownerWebContentsId)
  })
  mainWindow.webContents.once('destroyed', () => {
    void composerContextSearch?.stopOwnedBy(ownerWebContentsId)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadURL(createAppRendererUrl())
  }
  return mainWindow
}

app.whenReady().then(async () => {
  if (app.isPackaged) app.setAsDefaultProtocolClient('dascowork')
  registerAppProtocol({
    protocol,
    session: session.defaultSession,
    rendererRoot: join(__dirname, '../renderer'),
    devRendererUrl: is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined,
    netFetch: (url, init) => net.fetch(url, init),
    logger: console
  })
  const runtimeConfig = loadDesktopRuntimeConfig(process.env)
  const hosts = new GitHostRegistry({
    remoteCodexCommand: runtimeConfig.remoteCodexCommand
  })
  const manager = new GitManager()
  gitHostRegistry = hosts
  const terminalHosts = new CodexHostConnectionRegistry({
    remoteCodexCommand: runtimeConfig.remoteCodexCommand
  })
  codexHostConnectionRegistry = terminalHosts
  const turnDiffStore = new TurnDiffStore(join(app.getPath('userData'), 'turn-diffs'))
  const runtime = createCodexRuntime(hosts, manager, turnDiffStore)
  codexRuntime = runtime
  automationService = new AutomationService({
    store: AutomationStore.onDisk(join(app.getPath('userData'), 'automations.json')),
    projectStore: requireProjectStore(),
    runtime,
    onThreadStarted: async ({ sourceConversationId, thread }) => {
      const ownerWebContentsId =
        conversationWindowRouter.ownerForConversation(sourceConversationId) ??
        BrowserWindow.getFocusedWindow()?.webContents.id ??
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed())?.webContents.id
      if (ownerWebContentsId !== undefined) {
        conversationWindowRouter.bindThread(thread.threadId, ownerWebContentsId)
      }
      broadcastStartedConversation(thread.threadId, thread)
    }
  })
  await automationService.load()
  const targetResolver = new GitRepositoryTargetResolver({
    projectService: requireProjectService(),
    gitManager: manager,
    hosts
  })
  const localGit = new LocalGitService({ targetResolver, turnDiffStore })
  localGitWatchBroker = new LocalGitWatchBroker({
    getState: (target) => localGit.getWatchState(target),
    onRepositoryChange: (target, event) =>
      invalidateLocalGitWatchCaches(manager, hosts, target, event)
  })
  const localGitHandlers = createLocalGitIpcHandlers({
    localGit,
    targetResolver,
    commits: new LocalCommitService(localGit, (input) => runtime.generateCommitMessage(input)),
    pushes: new LocalPushService(localGit),
    watchBroker: localGitWatchBroker
  })
  const githubPullRequestHandlers = createGithubPullRequestIpcHandlers(
    new GithubPullRequestService({ localGit })
  )
  const keyboardShortcuts = KeyboardShortcutService.onDisk(
    join(app.getPath('userData'), 'keyboard-shortcuts.json')
  )
  await keyboardShortcuts.load()
  rightWorkspaceIpc = registerRightWorkspaceIpc({
    ipcMain,
    projectService: requireProjectService(),
    fileSearchProvider: requireComposerContextClient(),
    terminalBackendFactory: new TerminalBackendFactory(terminalHosts),
    terminalCommand: runtimeConfig.terminalCommand
  })

  electronApp.setAppUserModelId('com.electron')
  nativeTheme.themeSource = 'system'
  installApplicationMenu({
    Menu,
    isMac: process.platform === 'darwin',
    onNewTask: () => {
      const window = BrowserWindow.getFocusedWindow()
      if (window && !window.isDestroyed()) {
        sendToActiveRenderer(window.webContents, 'codex:new-task')
      }
    },
    onOpenCommandPalette: () => {
      const window = BrowserWindow.getFocusedWindow()
      if (window && !window.isDestroyed()) {
        sendToActiveRenderer(window.webContents, 'codex:command-palette')
      }
    }
  })

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  app.on('browser-window-blur', () => manager.handleAppEvent({ type: 'background' }))
  app.on('browser-window-focus', () => manager.handleAppEvent({ type: 'foreground' }))

  runtime.onApprovalRequest((request) => {
    let ownerWebContentsId = conversationWindowRouter.bindApproval(request)
    if (ownerWebContentsId === undefined) {
      const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
      if (windows.length === 1) {
        ownerWebContentsId = windows[0]!.webContents.id
        conversationWindowRouter.assignApproval(request.id, ownerWebContentsId)
      }
    }
    const ownerWindow = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === ownerWebContentsId
    )
    if (!ownerWindow || ownerWindow.isDestroyed()) return
    sendToActiveRenderer(ownerWindow.webContents, 'codex:approval-request', request)
  })
  runtime.onApprovalSettled((requestId) => {
    const ownerWebContentsId = conversationWindowRouter.ownerForApproval(requestId)
    conversationWindowRouter.releaseApproval(requestId)
    const ownerWindow = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.id === ownerWebContentsId
    )
    if (!ownerWindow || ownerWindow.isDestroyed()) return
    sendToActiveRenderer(ownerWindow.webContents, 'codex:approval-settled', requestId)
  })

  ipcMain.handle('codex:get-status', () => runtime.getStatus())
  ipcMain.handle(
    nativeContextMenuIpcChannels.show,
    createNativeContextMenuHandler(
      Menu,
      (event) => BrowserWindow.fromWebContents(event.sender) ?? undefined
    )
  )
  ipcMain.handle('codex:list-models', () => runtime.listModels())
  ipcMain.handle('codex:list-mcp-servers', createListMcpServersHandler(requireMcpServerStatus()))
  ipcMain.handle(
    'codex:read-mcp-app-resource',
    createReadMcpAppResourceHandler(requireMcpAppResource())
  )
  for (const [channel, handler] of Object.entries(
    createPluginCenterIpcHandlers(requirePluginCenterService())
  )) {
    ipcMain.handle(channel, handler)
  }
  ipcMain.handle('codex:set-selected-model', (_, payload: unknown) => {
    const request = codexSetSelectedModelPayloadSchema.parse(payload)
    return runtime.setSelectedModel(request.modelId)
  })
  ipcMain.handle('codex:list-pending-approvals', (event) =>
    runtime
      .listPendingApprovals()
      .filter((request) => conversationWindowRouter.ownsApproval(event.sender.id, request.id))
  )
  ipcMain.handle('codex:respond-approval', (event, payload: unknown) => {
    const request = codexRespondApprovalPayloadSchema.parse(payload)
    assertApprovalOwner(event.sender.id, request.requestId)
    return runtime.respondApproval(request.requestId, request.response)
  })
  ipcMain.handle('codex:snooze-approval-auto-resolution', (event, payload: unknown) => {
    const request = codexSnoozeApprovalAutoResolutionPayloadSchema.parse(payload)
    assertApprovalOwner(event.sender.id, request.requestId)
    return runtime.snoozeApprovalAutoResolution(request.requestId)
  })
  ipcMain.handle('codex:open-external-http-url', (_, payload: unknown) => {
    const request = codexOpenExternalHttpUrlPayloadSchema.parse(payload)
    return openExternalHttpUrl(request.url)
  })
  ipcMain.handle(gitIpcChannels.resolveRepositoryTarget, localGitHandlers.resolveRepositoryTarget)
  ipcMain.handle(gitIpcChannels.getSummary, localGitHandlers.getSummary)
  ipcMain.handle(gitIpcChannels.listCommits, localGitHandlers.listCommits)
  ipcMain.handle(gitIpcChannels.getReviewSnapshot, localGitHandlers.getReviewSnapshot)
  ipcMain.handle(gitIpcChannels.refreshReviewFiles, localGitHandlers.refreshReviewFiles)
  ipcMain.handle(gitIpcChannels.getFileDiff, localGitHandlers.getFileDiff)
  ipcMain.handle(gitIpcChannels.getReviewApplyCommand, localGitHandlers.getReviewApplyCommand)
  ipcMain.handle(
    gitIpcChannels.getReviewDiffFileContents,
    localGitHandlers.getReviewDiffFileContents
  )
  ipcMain.handle(gitIpcChannels.getTurnDiffFileContents, localGitHandlers.getTurnDiffFileContents)
  ipcMain.handle(gitIpcChannels.getReviewFileContent, localGitHandlers.getReviewFileContent)
  ipcMain.handle(gitIpcChannels.searchReview, localGitHandlers.searchReview)
  ipcMain.handle(gitIpcChannels.applyReviewAction, localGitHandlers.applyReviewAction)
  ipcMain.handle(gitIpcChannels.applyTurnPatch, localGitHandlers.applyTurnPatch)
  ipcMain.handle(gitIpcChannels.listBranches, localGitHandlers.listBranches)
  ipcMain.handle(gitIpcChannels.searchBranches, localGitHandlers.searchBranches)
  ipcMain.handle(gitIpcChannels.resolveMergeBase, localGitHandlers.resolveMergeBase)
  ipcMain.handle(gitIpcChannels.createBranch, localGitHandlers.createBranch)
  ipcMain.handle(gitIpcChannels.checkoutBranch, localGitHandlers.checkoutBranch)
  ipcMain.handle(gitIpcChannels.commitChanges, localGitHandlers.commitChanges)
  ipcMain.handle(gitIpcChannels.getPublishStatus, localGitHandlers.getPublishStatus)
  ipcMain.handle(gitIpcChannels.pushChanges, localGitHandlers.pushChanges)
  ipcMain.handle(githubPullRequestIpcChannels.getStatus, githubPullRequestHandlers.getStatus)
  ipcMain.handle(githubPullRequestIpcChannels.create, githubPullRequestHandlers.create)
  ipcMain.handle(githubPullRequestIpcChannels.comment, githubPullRequestHandlers.comment)
  ipcMain.handle(githubPullRequestIpcChannels.submitReview, githubPullRequestHandlers.submitReview)
  ipcMain.handle(
    githubPullRequestIpcChannels.requestReviewers,
    githubPullRequestHandlers.requestReviewers
  )
  const keyboardShortcutHandlers = createKeyboardShortcutIpcHandlers(keyboardShortcuts)
  ipcMain.handle(keyboardShortcutIpcChannels.get, keyboardShortcutHandlers.get)
  ipcMain.handle(keyboardShortcutIpcChannels.update, async (event, payload) => {
    return keyboardShortcutHandlers.update(event, payload)
  })
  ipcMain.handle(keyboardShortcutIpcChannels.reset, async () => {
    return keyboardShortcutHandlers.reset()
  })
  ipcMain.handle(automationIpcChannels.list, () => requireAutomationService().list())
  ipcMain.handle(automationIpcChannels.create, async (_event, payload: unknown) => {
    return requireAutomationService().create(automationCreateRequestSchema.parse(payload))
  })
  ipcMain.handle(automationIpcChannels.update, async (_event, payload: unknown) => {
    return requireAutomationService().update(automationUpdateRequestSchema.parse(payload))
  })
  ipcMain.handle(automationIpcChannels.setStatus, async (_event, payload: unknown) => {
    return requireAutomationService().setStatus(automationStatusRequestSchema.parse(payload))
  })
  ipcMain.handle(automationIpcChannels.remove, async (_event, payload: unknown) => {
    await requireAutomationService().remove(automationActionRequestSchema.parse(payload).id)
  })
  ipcMain.handle(automationIpcChannels.runNow, async (_event, payload: unknown) => {
    return requireAutomationService().runNow(automationActionRequestSchema.parse(payload).id)
  })
  ipcMain.on(localGitWatchControlChannels.subscribe, (event) => {
    localGitWatchBroker?.subscribe(event.sender)
  })
  ipcMain.on(localGitWatchControlChannels.unsubscribe, (event) => {
    localGitWatchBroker?.unsubscribe(event.sender.id)
  })
  ipcMain.handle(
    'codex:open-local-path',
    createOpenLocalPathHandler((path) => shell.openPath(path))
  )
  ipcMain.handle(
    'codex:reveal-local-path',
    createRevealLocalPathHandler((path) => shell.showItemInFolder(path))
  )
  ipcMain.on('codex:start-local-path-drag', (event, payload: unknown) =>
    createStartLocalPathDragHandler((path) =>
      event.sender.startDrag({ file: path, icon: nativeImage.createEmpty() })
    )(payload)
  )
  ipcMain.handle('codex:list-existing-local-paths', createListExistingLocalPathsHandler({ stat }))
  ipcMain.handle(
    'codex:pick-local-context',
    createPickLocalContextHandler({
      choosePickerKind: process.platform === 'darwin' ? undefined : chooseLocalContextPickerKind,
      issueLocalImageCapability: (path, mediaType, identity) =>
        localImageCapabilities.issue(path, mediaType, identity),
      issueLocalPathCapability: (path, kind, identity) =>
        localPathCapabilities.issue(path, kind, identity),
      showOpenDialog: (options) => dialog.showOpenDialog(options),
      stat
    })
  )
  ipcMain.handle(
    'codex:composer-context:list',
    createListComposerContextHandler(requireComposerContextCatalog())
  )
  ipcMain.handle(
    'codex:composer-context:refresh',
    createRefreshComposerContextHandler(requireComposerContextCatalog())
  )
  ipcMain.handle(
    'codex:composer-context:validate-local-attachments',
    createValidateLocalAttachmentsHandler({ stat })
  )
  ipcMain.handle(
    'codex:composer-context-search:start',
    createStartComposerContextSearchHandler(requireComposerContextSearch())
  )
  ipcMain.handle(
    'codex:composer-context-search:update',
    createUpdateComposerContextSearchHandler(requireComposerContextSearch())
  )
  ipcMain.handle(
    'codex:composer-context-search:stop',
    createStopComposerContextSearchHandler(requireComposerContextSearch())
  )
  ipcMain.handle('codex:follow-ups:get-state', (_, payload: unknown) => {
    const request = followUpGetStatePayloadSchema.parse(payload)
    return requireFollowUpQueue().getState(request.conversationKey)
  })
  ipcMain.handle('codex:follow-ups:enqueue', (_, payload: unknown) => {
    const request = followUpEnqueuePayloadSchema.parse(payload)
    return requireFollowUpQueue().enqueue(
      request.conversationKey,
      request.snapshot,
      request.preferredMode
    )
  })
  ipcMain.handle('codex:follow-ups:edit', (_, payload: unknown) => {
    const request = followUpEditPayloadSchema.parse(payload)
    return requireFollowUpQueue().edit(
      request.conversationKey,
      request.itemId,
      request.replacementSnapshot
    )
  })
  ipcMain.handle('codex:follow-ups:begin-edit', (_, payload: unknown) => {
    const request = followUpItemActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().beginEdit(request.conversationKey, request.itemId)
  })
  ipcMain.handle('codex:follow-ups:commit-edit', (_, payload: unknown) => {
    const request = followUpCommitEditPayloadSchema.parse(payload)
    return requireFollowUpQueue().commitEdit(
      request.conversationKey,
      request.itemId,
      request.replacementSnapshot
    )
  })
  ipcMain.handle('codex:follow-ups:cancel-edit', (_, payload: unknown) => {
    const request = followUpItemActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().cancelEdit(request.conversationKey, request.itemId)
  })
  ipcMain.handle('codex:follow-ups:delete', (_, payload: unknown) => {
    const request = followUpItemActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().delete(request.conversationKey, request.itemId)
  })
  ipcMain.handle('codex:follow-ups:reorder', (_, payload: unknown) => {
    const request = followUpReorderPayloadSchema.parse(payload)
    const position = request.beforeId
      ? { beforeId: request.beforeId }
      : { afterId: request.afterId! }
    return requireFollowUpQueue().reorder(request.conversationKey, request.itemId, position)
  })
  ipcMain.handle('codex:follow-ups:send-now', (_, payload: unknown) => {
    const request = followUpItemActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().requestSendNow(request.conversationKey, request.itemId)
  })
  ipcMain.handle('codex:follow-ups:retry', (_, payload: unknown) => {
    const request = followUpItemActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().retry(request.conversationKey, request.itemId)
  })
  ipcMain.handle('codex:follow-ups:resume', (_, payload: unknown) => {
    const request = followUpConversationActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().resume(request.conversationKey)
  })
  ipcMain.handle('codex:follow-ups:clear', (_, payload: unknown) => {
    const request = followUpConversationActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().clear(request.conversationKey)
  })
  ipcMain.handle('codex:follow-ups:set-default-mode', (_, payload: unknown) => {
    const request = followUpSetDefaultModePayloadSchema.parse(payload)
    return requireFollowUpQueue().setDefaultMode(request.mode)
  })
  ipcMain.handle('codex:follow-ups:prepare-next-turn', async (_, payload: unknown) => {
    const request = followUpClaimNextPayloadSchema.parse(payload)
    const queue = requireFollowUpQueue()
    const message = await queue.materializeQueuedMessage(request.conversationKey, request.itemId)
    return {
      request: {
        conversationKey: request.conversationKey,
        itemId: message.id
      },
      message
    }
  })
  ipcMain.handle('codex:follow-ups:materialize-item', async (_, payload: unknown) => {
    const request = followUpItemActionPayloadSchema.parse(payload)
    return requireFollowUpQueue().materializeItem(request.conversationKey, request.itemId)
  })
  ipcMain.handle('codex:follow-ups:steer-next', async (_, payload: unknown) => {
    const request = followUpClaimNextPayloadSchema.parse(payload)
    return steerQueuedFollowUp(requireFollowUpQueue(), runtime, request)
  })
  ipcMain.handle('codex:follow-ups:steer-item', async (_, payload: unknown) => {
    const request = followUpSteerItemPayloadSchema.parse(payload)
    return steerQueuedFollowUp(requireFollowUpQueue(), runtime, request)
  })
  ipcMain.handle('codex:projects:get-state', () => requireProjectApi().getState())
  ipcMain.handle('codex:projects:pick-workspace-root', async () => {
    const option = await requireProjectApi().pickWorkspaceRoot()
    await broadcastProjectState()
    return option ?? null
  })
  ipcMain.handle('codex:projects:create-blank', async (_, payload: unknown) => {
    const request = projectCreateBlankPayloadSchema.parse(payload)
    const result = await requireProjectApi().createBlankProject(request.name, request.operationId)
    void broadcastProjectState(result.state).catch((error) => {
      console.warn('Blank project was created, but broadcasting project state failed', error)
    })
    return result
  })
  ipcMain.handle('codex:projects:create-local', async (_, payload: unknown) => {
    const request = projectCreateLocalPayloadSchema.parse(payload)
    const project = await requireProjectApi().createLocalProject(request)
    await broadcastProjectState()
    return project
  })
  ipcMain.handle('codex:projects:create-remote', async (_, payload: unknown) => {
    const request = projectCreateRemotePayloadSchema.parse(payload)
    const project = await requireProjectApi().createRemoteProject(request)
    await broadcastProjectState()
    return project
  })
  ipcMain.handle('codex:projects:list-worktrees', async (_event, payload: unknown) => {
    const request = projectWorktreeListPayloadSchema.parse(payload)
    return requireProjectWorktrees().list(request.source)
  })
  ipcMain.handle('codex:projects:select-worktree', async (_event, payload: unknown) => {
    const request = projectWorktreeSelectPayloadSchema.parse(payload)
    const worktree = await requireProjectWorktrees().resolve(request.source, request.path)
    const state = await requireProjectApi().activateVerifiedWorktree(worktree)
    await broadcastProjectState(state)
    return state
  })
  ipcMain.handle('codex:projects:select', async (_, payload: unknown) => {
    const request = projectSelectPayloadSchema.parse(payload)
    const state = await requireProjectApi().selectProject(request)
    await broadcastProjectState()
    return state
  })
  ipcMain.handle('codex:projects:remove', async (_, payload: unknown) => {
    const request = projectSelectPayloadSchema.parse(payload)
    const state = await requireProjectApi().removeProject(request)
    await broadcastProjectState()
    return state
  })
  ipcMain.handle('codex:projects:rename', async (_, payload: unknown) => {
    const request = projectRenamePayloadSchema.parse(payload)
    const state = await requireProjectApi().renameProject(request)
    await broadcastProjectState()
    return state
  })
  ipcMain.handle('codex:projects:upsert-action', async (_, payload: unknown) => {
    const request = projectActionUpsertPayloadSchema.parse(payload)
    const state = await requireProjectApi().upsertProjectAction(request)
    await broadcastProjectState(state)
    return state
  })
  ipcMain.handle('codex:projects:remove-action', async (_, payload: unknown) => {
    const request = projectActionRemovePayloadSchema.parse(payload)
    const state = await requireProjectApi().removeProjectAction(request)
    await broadcastProjectState(state)
    return state
  })
  ipcMain.handle('codex:projects:get-workspace-recovery', (_, payload: unknown) => {
    const request = workspaceRecoveryPayloadSchema.parse(payload)
    return requireWorkspaceRecovery().inspect(request)
  })
  ipcMain.handle('codex:projects:restore-workspace', async (_, payload: unknown) => {
    const request = workspaceRecoveryPayloadSchema.parse(payload)
    const status = await requireWorkspaceRecovery().restore(request)
    await broadcastProjectState()
    return status
  })
  ipcMain.handle('codex:conversations:get-list', () =>
    requireConversationApi().getConversationList()
  )
  ipcMain.handle('codex:conversations:consume-link', (event) => {
    const link = pendingConversationLinksByWindowId.get(event.sender.id) ?? null
    pendingConversationLinksByWindowId.delete(event.sender.id)
    return link
  })
  ipcMain.handle('codex:conversations:refresh-list', async () => {
    const state = await requireConversationApi().refreshConversationList()
    await broadcastConversationState()
    return state
  })
  ipcMain.handle('codex:conversations:open', (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    return requireConversationApi().openConversation(request)
  })
  ipcMain.handle('codex:conversations:open-in-new-window', async (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    const conversation = await requireConversationApi().openConversation(request)
    const window = createWindow({
      conversationLink: { conversationId: conversation.conversationId }
    })
    conversationWindowRouter.bindConversation(conversation.conversationId, window.webContents.id)
    conversationWindowRouter.bindThread(conversation.threadId, window.webContents.id)
  })
  ipcMain.handle('codex:conversations:get-goal', (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    return requireConversationApi().getConversationGoal(request.conversationId)
  })
  ipcMain.handle('codex:conversations:set-goal', async (_, payload: unknown) => {
    const request = sidebarConversationGoalSetPayloadSchema.parse(payload)
    const activeGoal = await codexRuntime?.setThreadGoalOnActiveSession(
      request.conversationId,
      request.objective
    )
    if (activeGoal) return activeGoal
    throw new Error('目标只能通过当前对话的连续会话设置')
  })
  ipcMain.handle('codex:conversations:clear-goal', async (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    const clearedOnActiveSession = await codexRuntime?.clearThreadGoalOnActiveSession(
      request.conversationId
    )
    if (clearedOnActiveSession !== undefined) return clearedOnActiveSession
    return requireConversationApi().clearConversationGoal(request.conversationId)
  })
  ipcMain.handle('codex:conversations:archive', async (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    const state = await requireConversationApi().archiveConversation(request)
    await requireFollowUpQueue().setArchived(request.conversationId, true)
    await broadcastConversationState()
    return state
  })
  ipcMain.handle('codex:conversations:unarchive', async (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    const state = await requireConversationApi().unarchiveConversation(request)
    await requireFollowUpQueue().setArchived(request.conversationId, false)
    await broadcastConversationState()
    return state
  })
  ipcMain.handle('codex:conversations:delete', async (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    await requireFollowUpQueue().assertConversationCanBeDeleted(request.conversationId)
    const state = await requireConversationApi().deleteConversation(request)
    await requireFollowUpQueue().deleteConversation(request.conversationId)
    await broadcastConversationState()
    return state
  })
  ipcMain.handle('codex:conversations:delete-archived', async (_, payload: unknown) => {
    const request = sidebarConversationBatchDeletePayloadSchema.parse(payload)
    await Promise.all(
      request.conversationIds.map((conversationId) =>
        requireFollowUpQueue().assertConversationCanBeDeleted(conversationId)
      )
    )
    const state = await requireConversationApi().deleteArchivedConversations(request)
    await Promise.all(
      request.conversationIds.map((conversationId) =>
        requireFollowUpQueue().deleteConversation(conversationId)
      )
    )
    await broadcastConversationState()
    return state
  })
  ipcMain.handle('codex:conversations:rename', async (_, payload: unknown) => {
    const request = sidebarConversationRenamePayloadSchema.parse(payload)
    const state = await requireConversationApi().renameConversation(request)
    await broadcastConversationState()
    return state
  })
  ipcMain.handle('codex:conversations:fork', async (_, payload: unknown) => {
    const request = sidebarConversationForkPayloadSchema.parse(payload)
    const forked = await requireConversationForkService().fork(request)
    await requireConversationApi().observeStartedThread({
      threadId: forked.thread.id,
      originConversationId: request.conversationId,
      title: forked.thread.title,
      cwd: forked.thread.cwd,
      createdAt: forked.thread.createdAt,
      updatedAt: forked.thread.updatedAt,
      projectAssignment: forked.projectAssignment
    })
    await broadcastProjectState()
    await broadcastConversationState({
      awaitThreadId: forked.thread.id,
      discardStartedObservationOnConvergenceFailure: false
    })
    return requireConversationApi().openConversation({ conversationId: forked.thread.id })
  })
  ipcMain.handle('codex:conversations:submit-feedback', (_, payload: unknown) => {
    const request = sidebarConversationFeedbackPayloadSchema.parse(payload)
    return requireConversationApi().submitConversationFeedback(request)
  })
  ipcMain.handle('codex:conversations:interrupt', (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    return runtime.interruptConversation(request.conversationId)
  })
  ipcMain.handle('codex:conversations:get-preferences', () =>
    requireConversationApi().getPreferences()
  )
  ipcMain.handle('codex:conversations:set-preferences', async (_, payload: unknown) => {
    const request = sidebarPreferencesPatchSchema.parse(payload)
    return requireConversationApi().setPreferences(request)
  })
  ipcMain.on('codex-chat:port-detached', (_, payload: unknown) => {
    const request = codexChatPortDetachedPayloadSchema.parse(payload)
    runtime.handleChatStreamPortClosed(request.chatId, request.streamId)
  })
  ipcMain.on('codex-chat:start', (event, payload: unknown) => {
    const port = event.ports[0]
    if (!port) return
    const { request, streamId } = codexChatStartPayloadSchema.parse(payload)
    rightWorkspaceIpc?.terminalManager.bindConversationOwner(request.chatId, event.sender.id)
    conversationWindowRouter.bindConversation(request.chatId, event.sender.id)
    port.once('close', () => {
      runtime.handleChatStreamPortClosed(request.chatId, streamId)
    })
    void runtime
      .startChatStream(
        request,
        port,
        {
          onThreadIdAvailable: async (threadId, thread) => {
            conversationWindowRouter.bindThread(threadId, event.sender.id)
            if (thread?.originConversationId) {
              await requireFollowUpQueue().migrateConversationKey(
                thread.originConversationId,
                threadId
              )
            }
            if (thread) {
              broadcastStartedConversation(threadId, thread)
              return
            }
            void broadcastConversationState({ awaitThreadId: threadId })
          },
          onTerminal: (terminal) => {
            sendToActiveRenderer(event.sender, 'codex-chat:terminal', { streamId, terminal })
          }
        },
        streamId
      )
      .then((result) =>
        broadcastConversationState({
          awaitThreadId: result.threadId,
          discardStartedObservationOnConvergenceFailure: true
        })
      )
      .catch((error: unknown) => {
        console.error('failed to complete codex chat stream', error)
      })
      .finally(() => {
        broadcastStatus()
      })
    broadcastStatus()
  })
  ipcMain.on('codex-chat:attach', (event, payload: unknown) => {
    const port = event.ports[0]
    if (!port) return
    const { conversationId, streamId, runId, afterSequence } =
      codexChatAttachPayloadSchema.parse(payload)
    port.once('close', () => runtime.handleChatStreamPortClosed(conversationId, streamId))
    const attachResult = runtime.attachChatStream(
      conversationId,
      streamId,
      port,
      runId,
      afterSequence
    )
    if (attachResult.status === 'attached') {
      conversationWindowRouter.claimThreadIfUnowned(conversationId, event.sender.id)
    }
    if (attachResult.status !== 'attached') {
      port.start()
      port.postMessage({ type: 'error', error: chatAttachFailure(attachResult) })
      port.close()
    }
  })
  ipcMain.handle('codex-chat:has-active-run', (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    return runtime.hasActiveChatStream(request.conversationId)
  })
  ipcMain.handle('codex-chat:get-active-run', (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    return runtime.getActiveChatRun(request.conversationId) ?? null
  })
  ipcMain.handle('codex-chat:get-active-runs', () => runtime.getActiveChatRuns())
  ipcMain.handle('codex-chat:get-active-snapshot', (_, payload: unknown) => {
    const request = sidebarConversationActionPayloadSchema.parse(payload)
    return runtime.getActiveChatSnapshot(request.conversationId) ?? null
  })

  createWindow()
  broadcastStatus()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function chatAttachFailure(result: Exclude<CodexChatAttachResult, { status: 'attached' }>): {
  code: Exclude<CodexChatAttachResult['status'], 'attached'>
  message: string
} {
  switch (result.status) {
    case 'run-unavailable':
      return { code: result.status, message: '任务运行已结束，无法恢复连接。' }
    case 'run-mismatch':
      return { code: result.status, message: '恢复的数据流不属于当前任务，请重新打开任务。' }
    case 'journal-unavailable':
      return {
        code: result.status,
        message: '恢复日志已超出可补发范围，请等待任务结束后重新打开任务。'
      }
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on(
  'before-quit',
  createBeforeQuitHandler({
    shutdown: async () => {
      try {
        await composerContextSearch?.shutdown()
      } finally {
        automationService?.stop()
        localGitWatchBroker?.dispose()
        rightWorkspaceIpc?.dispose()
        composerContextChanges?.dispose()
        await Promise.allSettled([
          codexRuntime?.stop(),
          composerContextClient?.shutdown(),
          gitHostRegistry?.shutdown(),
          codexHostConnectionRegistry?.shutdown()
        ])
        await codexAppServerConnection?.shutdown()
      }
    },
    quit: () => app.quit(),
    onError: (error) => console.error('[app-shutdown] cleanup failed', error)
  })
)
