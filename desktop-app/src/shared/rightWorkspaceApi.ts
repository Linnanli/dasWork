import { z } from 'zod'

import type {
  ArtifactPreviewComposerAttachmentResult,
  ArtifactPreviewMetadataResult,
  ArtifactPreviewReadBinaryResult,
  ArtifactPreviewRegisterAuthorizedLocalSourceRequest,
  ArtifactPreviewRegisterSourceResult,
  ArtifactPreviewRegisterWorkspaceSourceRequest,
  ArtifactPreviewSourceRequest,
  ArtifactPreviewSourceChangeEvent
} from './artifactPreviewApi'

import type {
  BrowserWorkspaceCreateRequest,
  BrowserWorkspaceEvent,
  BrowserWorkspaceListRequest,
  BrowserWorkspaceListResult,
  BrowserWorkspaceNavigateRequest,
  BrowserWorkspaceSetBoundsRequest,
  BrowserWorkspaceViewRequest,
  BrowserWorkspaceViewSnapshot
} from './browserWorkspaceApi'
import type {
  FileWorkspaceListDirectoryRequest,
  FileWorkspaceListDirectoryResult,
  FileWorkspaceMetadataRequest,
  FileWorkspaceMetadataResult,
  FileWorkspaceReadFileRequest,
  FileWorkspaceReadFileResult,
  FileWorkspaceEvent,
  FileWorkspaceSearchRequest,
  FileWorkspaceSearchResult,
  FileWorkspaceSearchSessionEvent,
  FileWorkspaceSearchSessionStartRequest,
  FileWorkspaceSearchSessionStartResult,
  FileWorkspaceSearchSessionStopRequest,
  FileWorkspaceSearchSessionUpdateRequest
} from './fileWorkspaceApi'
import { gitConversationTargetSchema, type GitConversationTarget } from './localGitApi'
import type {
  TerminalWorkspaceAck,
  TerminalWorkspaceAttachRequest,
  TerminalWorkspaceCloseRequest,
  TerminalWorkspaceCreateRequest,
  TerminalWorkspaceDetachRequest,
  TerminalWorkspaceEvent,
  TerminalWorkspaceListRequest,
  TerminalWorkspaceListResult,
  TerminalWorkspaceResizeRequest,
  TerminalWorkspaceRestartRequest,
  TerminalWorkspaceRunActionRequest,
  TerminalWorkspaceSessionSnapshot,
  TerminalWorkspaceSetTitleRequest,
  TerminalWorkspaceSnapshot,
  TerminalWorkspaceSnapshotRequest,
  TerminalWorkspaceWriteRequest
} from './terminalWorkspaceApi'

const workspaceIdSchema = z.string().min(1).max(256)

export const rightWorkspaceIpcChannels = {
  disposeWorkspace: 'right-workspace:dispose-workspace',
  prepareFileRoot: 'right-workspace:files:prepare-root',
  listDirectory: 'right-workspace:files:list-directory',
  metadata: 'right-workspace:files:metadata',
  readFile: 'right-workspace:files:read-file',
  searchFiles: 'right-workspace:files:search',
  startFileSearch: 'right-workspace:files:search-start',
  updateFileSearch: 'right-workspace:files:search-update',
  stopFileSearch: 'right-workspace:files:search-stop',
  fileSearchEvent: 'right-workspace:files:search-event',
  openWithSystem: 'right-workspace:files:open-with-system',
  registerArtifactWorkspaceSource: 'right-workspace:artifacts:register-workspace-source',
  registerArtifactLocalSource: 'right-workspace:artifacts:register-local-source',
  createArtifactComposerAttachment: 'right-workspace:artifacts:create-composer-attachment',
  artifactMetadata: 'right-workspace:artifacts:metadata',
  readArtifactBinary: 'right-workspace:artifacts:read-binary',
  releaseArtifactSource: 'right-workspace:artifacts:release-source',
  openArtifactWithSystem: 'right-workspace:artifacts:open-with-system',
  artifactEvent: 'right-workspace:artifacts:event',
  fileEvent: 'right-workspace:files:event'
} as const

export const rightWorkspaceDisposeRequestSchema = z
  .object({ version: z.literal(1), workspaceId: workspaceIdSchema })
  .strict()
export type RightWorkspaceDisposeRequest = z.infer<typeof rightWorkspaceDisposeRequestSchema>

export const rightWorkspacePrepareFileRootRequestSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    target: gitConversationTargetSchema
  })
  .strict()
export type RightWorkspacePrepareFileRootRequest = z.infer<
  typeof rightWorkspacePrepareFileRootRequestSchema
>

export const rightWorkspacePrepareFileRootResultSchema = z
  .object({ rootId: workspaceIdSchema, label: z.string().min(1).max(1024) })
  .strict()
export type RightWorkspacePrepareFileRootResult = z.infer<
  typeof rightWorkspacePrepareFileRootResultSchema
>

export type DesktopRightWorkspaceApi = {
  dispose(input: RightWorkspaceDisposeRequest): Promise<void>
  files: {
    prepareRoot(
      input: RightWorkspacePrepareFileRootRequest
    ): Promise<RightWorkspacePrepareFileRootResult>
    listDirectory(
      input: FileWorkspaceListDirectoryRequest
    ): Promise<FileWorkspaceListDirectoryResult>
    metadata(input: FileWorkspaceMetadataRequest): Promise<FileWorkspaceMetadataResult>
    readFile(input: FileWorkspaceReadFileRequest): Promise<FileWorkspaceReadFileResult>
    search(input: FileWorkspaceSearchRequest): Promise<FileWorkspaceSearchResult>
    startSearch(
      input: FileWorkspaceSearchSessionStartRequest
    ): Promise<FileWorkspaceSearchSessionStartResult>
    updateSearch(input: FileWorkspaceSearchSessionUpdateRequest): Promise<void>
    stopSearch(input: FileWorkspaceSearchSessionStopRequest): Promise<void>
    onSearchEvent(callback: (event: FileWorkspaceSearchSessionEvent) => void): () => void
    openWithSystem(input: FileWorkspaceMetadataRequest): Promise<void>
    onEvent(callback: (event: FileWorkspaceEvent) => void): () => void
  }
  artifacts: {
    registerWorkspaceSource(
      input: ArtifactPreviewRegisterWorkspaceSourceRequest
    ): Promise<ArtifactPreviewRegisterSourceResult>
    registerAuthorizedLocalSource(
      input: ArtifactPreviewRegisterAuthorizedLocalSourceRequest
    ): Promise<ArtifactPreviewRegisterSourceResult>
    createComposerAttachment(
      input: ArtifactPreviewSourceRequest
    ): Promise<ArtifactPreviewComposerAttachmentResult>
    metadata(input: ArtifactPreviewSourceRequest): Promise<ArtifactPreviewMetadataResult>
    readBinary(input: ArtifactPreviewSourceRequest): Promise<ArtifactPreviewReadBinaryResult>
    release(input: ArtifactPreviewSourceRequest): Promise<void>
    openWithSystem(input: ArtifactPreviewSourceRequest): Promise<void>
    onEvent(callback: (event: ArtifactPreviewSourceChangeEvent) => void): () => void
  }
  terminal: {
    create(input: TerminalWorkspaceCreateRequest): Promise<TerminalWorkspaceSessionSnapshot>
    attach(input: TerminalWorkspaceAttachRequest): Promise<TerminalWorkspaceSessionSnapshot>
    detach(input: TerminalWorkspaceDetachRequest): Promise<TerminalWorkspaceAck>
    write(input: TerminalWorkspaceWriteRequest): Promise<TerminalWorkspaceAck>
    resize(input: TerminalWorkspaceResizeRequest): Promise<TerminalWorkspaceAck>
    setTitle(input: TerminalWorkspaceSetTitleRequest): Promise<TerminalWorkspaceAck>
    runAction(input: TerminalWorkspaceRunActionRequest): Promise<TerminalWorkspaceAck>
    restart(input: TerminalWorkspaceRestartRequest): Promise<TerminalWorkspaceSessionSnapshot>
    close(input: TerminalWorkspaceCloseRequest): Promise<TerminalWorkspaceSessionSnapshot>
    list(input: TerminalWorkspaceListRequest): Promise<TerminalWorkspaceListResult>
    snapshot(input: TerminalWorkspaceSnapshotRequest): Promise<TerminalWorkspaceSnapshot>
    listShells(): Promise<import('./terminalWorkspaceApi').TerminalWorkspaceShellOption[]>
    onEvent(callback: (event: TerminalWorkspaceEvent) => void): () => void
  }
  browser: {
    create(input: BrowserWorkspaceCreateRequest): Promise<BrowserWorkspaceViewSnapshot>
    navigate(input: BrowserWorkspaceNavigateRequest): Promise<BrowserWorkspaceViewSnapshot>
    setBounds(input: BrowserWorkspaceSetBoundsRequest): Promise<BrowserWorkspaceViewSnapshot>
    goBack(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    goForward(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    reload(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    stop(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    show(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    hide(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    destroy(input: BrowserWorkspaceViewRequest): Promise<BrowserWorkspaceViewSnapshot>
    list(input: BrowserWorkspaceListRequest): Promise<BrowserWorkspaceListResult>
    onEvent(callback: (event: BrowserWorkspaceEvent) => void): () => void
  }
}

export type RightWorkspaceOwner = {
  workspaceId: string
  target: GitConversationTarget
}
