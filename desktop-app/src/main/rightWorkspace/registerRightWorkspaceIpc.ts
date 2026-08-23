import {
  BrowserWindow,
  WebContentsView,
  type IpcMain,
  type IpcMainInvokeEvent,
  shell
} from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { basename, sep } from 'node:path'

import {
  browserWorkspaceIpcChannels,
  browserWorkspaceCreateRequestSchema,
  browserWorkspaceListRequestSchema,
  browserWorkspaceNavigateRequestSchema,
  browserWorkspaceSetBoundsRequestSchema,
  browserWorkspaceViewRequestSchema,
  isBrowserWorkspaceUrl
} from '../../shared/browserWorkspaceApi'
import {
  fileWorkspaceListDirectoryRequestSchema,
  fileWorkspaceEventSchema,
  fileWorkspaceRelativePathSchema,
  fileWorkspaceMetadataRequestSchema,
  fileWorkspaceReadFileRequestSchema,
  fileWorkspaceSearchRequestSchema,
  fileWorkspaceSearchSessionStartRequestSchema,
  fileWorkspaceSearchSessionStopRequestSchema,
  fileWorkspaceSearchSessionUpdateRequestSchema
} from '../../shared/fileWorkspaceApi'
import {
  rightWorkspaceIpcChannels,
  rightWorkspaceDisposeRequestSchema,
  rightWorkspacePrepareFileRootRequestSchema
} from '../../shared/rightWorkspaceApi'
import {
  terminalWorkspaceIpcChannels,
  terminalWorkspaceAttachRequestSchema,
  terminalWorkspaceCreateRequestSchema,
  terminalWorkspaceCloseRequestSchema,
  terminalWorkspaceDetachRequestSchema,
  terminalWorkspaceListRequestSchema,
  terminalWorkspaceResizeRequestSchema,
  terminalWorkspaceRestartRequestSchema,
  terminalWorkspaceRunActionRequestSchema,
  terminalWorkspaceSetTitleRequestSchema,
  terminalWorkspaceSnapshotRequestSchema,
  terminalWorkspaceWriteRequestSchema
} from '../../shared/terminalWorkspaceApi'
import type { ProjectService } from '../projects/ProjectService'
import { sendToActiveRenderer } from '../rendererIpc'
import { LocalPtyTerminalBackend } from '../terminal/LocalPtyTerminalBackend'
import { TerminalBackendFactory } from '../terminal/TerminalBackendFactory'
import { TerminalSessionManager } from '../terminal/TerminalSessionManager'
import { commandForTerminalAction } from '../terminal/terminalCommand'
import { terminalEnvironment } from '../terminal/terminalEnvironment'
import {
  BrowserWorkspaceService,
  type BrowserWorkspaceHostAdapter,
  type BrowserWorkspaceViewAdapter
} from './BrowserWorkspaceService'
import {
  FileWorkspaceService,
  type FileWorkspacePathSearchProviderLike
} from './FileWorkspaceService'

type WorkspaceRoot = { path: string; label: string }

type WindowWorkspaceServices = {
  window: BrowserWindow
  roots: Map<string, WorkspaceRoot>
  rootWatchers: Map<string, FSWatcher>
  files: FileWorkspaceService
  browser: BrowserWorkspaceService
  dispose(): void
}

export type RightWorkspaceIpcRegistration = {
  attachWindow(window: BrowserWindow): void
  detachWindow(webContentsId: number): void
  disposeWindow(webContentsId: number): void
  dispose(): void
  terminalManager: TerminalSessionManager
}

export function registerRightWorkspaceIpc({
  ipcMain,
  projectService,
  fileSearchProvider,
  terminalBackendFactory,
  terminalCommand,
  terminalManager = createTerminalSessionManager(projectService, terminalBackendFactory, terminalCommand)
}: {
  ipcMain: IpcMain
  projectService: ProjectService
  fileSearchProvider: FileWorkspacePathSearchProviderLike
  terminalBackendFactory?: Pick<TerminalBackendFactory, 'create'>
  terminalCommand?: string
  terminalManager?: TerminalSessionManager
}): RightWorkspaceIpcRegistration {
  const servicesByOwner = new Map<number, WindowWorkspaceServices>()
  const removeTerminalListener = terminalManager.onEvent((event) => {
    const sessionId = event.type === 'data' ? event.sessionId : event.session.sessionId
    const services = servicesByOwner.get(terminalManager.ownerForSession(sessionId) ?? -1)
    if (services && !services.window.isDestroyed()) {
      sendToActiveRenderer(services.window.webContents, terminalWorkspaceIpcChannels.event, event)
    }
  })

  const requireServices = (event: IpcMainInvokeEvent): WindowWorkspaceServices => {
    const services = servicesByOwner.get(event.sender.id)
    if (!services || services.window.isDestroyed())
      throw new Error('Right workspace is unavailable')
    return services
  }
  const requireOwnedRoot = (event: IpcMainInvokeEvent, rootId: string): WindowWorkspaceServices => {
    const services = requireServices(event)
    if (!services.roots.has(rootId)) throw new Error('Workspace root is unavailable')
    return services
  }

  ipcMain.handle(rightWorkspaceIpcChannels.prepareFileRoot, async (event, payload: unknown) => {
    const request = rightWorkspacePrepareFileRootRequestSchema.parse(payload)
    const services = requireServices(event)
    const resolved = await projectService.resolveExistingThreadTarget({
      conversationId: request.target.conversationId,
      threadId: request.target.threadId,
      allowActiveProjectFallback: true,
      allowActiveProjectFallbackForUnboundThread: true
    })
    if (!resolved?.cwd || resolved.hostId !== 'local') {
      throw new Error('This task does not have a local workspace available.')
    }
    const root = { path: resolved.cwd, label: basename(resolved.cwd) || resolved.cwd }
    await services.files.stopSearchSessionsForRoot(request.workspaceId)
    services.roots.set(request.workspaceId, root)
    watchWorkspaceRoot(services, request.workspaceId, root.path)
    return { rootId: request.workspaceId, label: root.label }
  })
  ipcMain.handle(rightWorkspaceIpcChannels.disposeWorkspace, async (event, payload: unknown) => {
    const request = rightWorkspaceDisposeRequestSchema.parse(payload)
    const services = requireServices(event)
    services.browser.disposeWorkspace(request.workspaceId)
    await services.files.stopSearchSessionsForRoot(request.workspaceId)
    services.roots.delete(request.workspaceId)
    closeRootWatcher(services, request.workspaceId)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.listDirectory, (event, payload: unknown) => {
    const request = fileWorkspaceListDirectoryRequestSchema.parse(payload)
    return requireServices(event).files.listDirectory(request)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.metadata, (event, payload: unknown) => {
    const request = fileWorkspaceMetadataRequestSchema.parse(payload)
    return requireServices(event).files.metadata(request)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.readFile, (event, payload: unknown) => {
    const request = fileWorkspaceReadFileRequestSchema.parse(payload)
    return requireServices(event).files.readFile(request)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.searchFiles, (event, payload: unknown) => {
    const request = fileWorkspaceSearchRequestSchema.parse(payload)
    return requireOwnedRoot(event, request.rootId).files.search(request)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.startFileSearch, (event, payload: unknown) => {
    const request = fileWorkspaceSearchSessionStartRequestSchema.parse(payload)
    const services = requireOwnedRoot(event, request.rootId)
    return services.files.startSearchSession(request, (searchEvent) => {
      if (!services.window.isDestroyed()) {
        sendToActiveRenderer(
          services.window.webContents,
          rightWorkspaceIpcChannels.fileSearchEvent,
          searchEvent
        )
      }
    })
  })
  ipcMain.handle(rightWorkspaceIpcChannels.updateFileSearch, (event, payload: unknown) => {
    const request = fileWorkspaceSearchSessionUpdateRequestSchema.parse(payload)
    return requireServices(event).files.updateSearchSession(request)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.stopFileSearch, (event, payload: unknown) => {
    const request = fileWorkspaceSearchSessionStopRequestSchema.parse(payload)
    return requireServices(event).files.stopSearchSession(request)
  })
  ipcMain.handle(rightWorkspaceIpcChannels.openWithSystem, async (event, payload: unknown) => {
    const request = fileWorkspaceMetadataRequestSchema.parse(payload)
    const path = await requireOwnedRoot(event, request.rootId).files.resolveFileForSystemOpen(
      request
    )
    const error = await shell.openPath(path)
    if (error) throw new Error(`Unable to open workspace file: ${error}`)
  })

  ipcMain.handle(terminalWorkspaceIpcChannels.create, (event, payload: unknown) => {
    const request = terminalWorkspaceCreateRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.create(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.attach, (event, payload: unknown) => {
    const request = terminalWorkspaceAttachRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.attach(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.detach, (event, payload: unknown) => {
    const request = terminalWorkspaceDetachRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.detach(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.write, (event, payload: unknown) => {
    const request = terminalWorkspaceWriteRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.write(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.resize, (event, payload: unknown) => {
    const request = terminalWorkspaceResizeRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.resize(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.setTitle, (event, payload: unknown) => {
    const request = terminalWorkspaceSetTitleRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.setTitle(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.runAction, (event, payload: unknown) => {
    const request = terminalWorkspaceRunActionRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.runAction(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.restart, (event, payload: unknown) => {
    const request = terminalWorkspaceRestartRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.restart(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.close, (event, payload: unknown) => {
    const request = terminalWorkspaceCloseRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.close(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.list, (event, payload: unknown) => {
    const request = terminalWorkspaceListRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.list(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.snapshot, (event, payload: unknown) => {
    const request = terminalWorkspaceSnapshotRequestSchema.parse(payload)
    requireServices(event)
    return terminalManager.getSnapshot(request, event.sender.id)
  })
  ipcMain.handle(terminalWorkspaceIpcChannels.listShells, (event) => {
    requireServices(event)
    return terminalManager.listShells()
  })

  ipcMain.handle(browserWorkspaceIpcChannels.create, (event, payload: unknown) => {
    const request = browserWorkspaceCreateRequestSchema.parse(payload)
    return requireServices(event).browser.create(request)
  })
  ipcMain.handle(browserWorkspaceIpcChannels.navigate, (event, payload: unknown) => {
    const request = browserWorkspaceNavigateRequestSchema.parse(payload)
    return requireServices(event).browser.navigate(request)
  })
  ipcMain.handle(browserWorkspaceIpcChannels.setBounds, (event, payload: unknown) => {
    const request = browserWorkspaceSetBoundsRequestSchema.parse(payload)
    return requireServices(event).browser.setBounds(request)
  })
  ipcMain.handle(browserWorkspaceIpcChannels.goBack, (event, payload: unknown) => {
    return requireServices(event).browser.goBack(browserWorkspaceViewRequestSchema.parse(payload))
  })
  ipcMain.handle(browserWorkspaceIpcChannels.goForward, (event, payload: unknown) => {
    return requireServices(event).browser.goForward(
      browserWorkspaceViewRequestSchema.parse(payload)
    )
  })
  ipcMain.handle(browserWorkspaceIpcChannels.reload, (event, payload: unknown) => {
    return requireServices(event).browser.reload(browserWorkspaceViewRequestSchema.parse(payload))
  })
  ipcMain.handle(browserWorkspaceIpcChannels.stop, (event, payload: unknown) => {
    return requireServices(event).browser.stop(browserWorkspaceViewRequestSchema.parse(payload))
  })
  ipcMain.handle(browserWorkspaceIpcChannels.show, (event, payload: unknown) => {
    return requireServices(event).browser.show(browserWorkspaceViewRequestSchema.parse(payload))
  })
  ipcMain.handle(browserWorkspaceIpcChannels.hide, (event, payload: unknown) => {
    return requireServices(event).browser.hide(browserWorkspaceViewRequestSchema.parse(payload))
  })
  ipcMain.handle(browserWorkspaceIpcChannels.destroy, (event, payload: unknown) => {
    return requireServices(event).browser.destroy(browserWorkspaceViewRequestSchema.parse(payload))
  })
  ipcMain.handle(browserWorkspaceIpcChannels.list, (event, payload: unknown) => {
    return requireServices(event).browser.list(browserWorkspaceListRequestSchema.parse(payload))
  })

  return {
    attachWindow(window) {
      const ownerId = window.webContents.id
      const existing = servicesByOwner.get(ownerId)
      existing?.dispose()
      servicesByOwner.set(ownerId, createWindowServices(window, fileSearchProvider))
    },
    detachWindow(webContentsId) {
      const services = servicesByOwner.get(webContentsId)
      if (services) {
        services.dispose()
        servicesByOwner.delete(webContentsId)
      }
      terminalManager.detachOwner(webContentsId)
    },
    disposeWindow(webContentsId) {
      const services = servicesByOwner.get(webContentsId)
      services?.dispose()
      servicesByOwner.delete(webContentsId)
      terminalManager.detachOwner(webContentsId)
      void terminalManager.closeOwner(webContentsId)
    },
    dispose() {
      removeTerminalListener()
      for (const [ownerId, services] of servicesByOwner) {
        services.dispose()
        servicesByOwner.delete(ownerId)
      }
      void terminalManager.dispose()
      for (const channel of Object.values({
        ...rightWorkspaceIpcChannels,
        ...terminalWorkspaceIpcChannels,
        ...browserWorkspaceIpcChannels
      })) {
        ipcMain.removeHandler(channel)
      }
    },
    terminalManager
  }
}

function createTerminalSessionManager(
  projectService: ProjectService,
  terminalBackendFactory?: Pick<TerminalBackendFactory, 'create'>,
  appTerminalCommand?: string
): TerminalSessionManager {
  return new TerminalSessionManager({
    resolveExecutionTarget: async (target) => {
      const resolved = await projectService.resolveExistingThreadTarget({
        conversationId: target.conversationId,
        threadId: target.threadId,
        allowActiveProjectFallback: true,
        allowActiveProjectFallbackForUnboundThread: true
      })
      if (!resolved?.cwd || !resolved.hostId) throw new Error('This task does not have a workspace available.')
      return {
        hostId: resolved.hostId,
        cwd: resolved.cwd,
        ...(resolved.terminalCommand ? { terminalCommand: resolved.terminalCommand } : {})
      }
    },
    ...(appTerminalCommand ? { appTerminalCommand } : {}),
    createBackend: (input) => {
      if (terminalBackendFactory) return terminalBackendFactory.create(input)
      if (input.target.hostId !== 'local') throw new Error('Remote terminal support is not configured for this host.')
      const command = input.actionCommand
        ? commandForTerminalAction(input.shell, input.actionCommand)
        : input.shell
      return new LocalPtyTerminalBackend({
        shell: command.shell,
        args: command.args,
        cwd: input.target.cwd,
        env: terminalEnvironment(),
        cols: input.cols,
        rows: input.rows
      })
    }
  })
}

function createWindowServices(
  window: BrowserWindow,
  fileSearchProvider: FileWorkspacePathSearchProviderLike
): WindowWorkspaceServices {
  const roots = new Map<string, WorkspaceRoot>()
  const rootWatchers = new Map<string, FSWatcher>()
  const files = new FileWorkspaceService({
    resolveRoot: async (rootId) => roots.get(rootId)?.path ?? null,
    pathSearch: fileSearchProvider
  })
  const browser = new BrowserWorkspaceService({ host: createBrowserHost(window) })
  const removeBrowserListener = browser.onEvent((event) => {
    if (!window.isDestroyed()) {
      sendToActiveRenderer(window.webContents, browserWorkspaceIpcChannels.event, event)
    }
  })

  return {
    window,
    roots,
    rootWatchers,
    files,
    browser,
    dispose() {
      removeBrowserListener()
      browser.dispose()
      void files.dispose()
      for (const watcher of rootWatchers.values()) watcher.close()
      rootWatchers.clear()
      roots.clear()
    }
  }
}

function watchWorkspaceRoot(
  services: WindowWorkspaceServices,
  rootId: string,
  rootPath: string
): void {
  closeRootWatcher(services, rootId)
  let pendingPaths = new Set<string | undefined>()
  let debounceTimer: NodeJS.Timeout | undefined
  const flush = (): void => {
    debounceTimer = undefined
    const paths = pendingPaths
    pendingPaths = new Set()
    for (const path of paths) {
      const event = fileWorkspaceEventSchema.parse({
        version: 1,
        type: 'changed',
        rootId,
        ...(path ? { path } : {})
      })
      if (!services.window.isDestroyed()) {
        sendToActiveRenderer(
          services.window.webContents,
          rightWorkspaceIpcChannels.fileEvent,
          event
        )
      }
    }
  }
  const schedule = (filename: string | Buffer | null): void => {
    pendingPaths.add(toWorkspaceRelativePath(filename))
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(flush, 120)
  }
  try {
    const watcher = watch(rootPath, { recursive: true }, (_event, filename) => schedule(filename))
    watcher.on('error', () => schedule(null))
    services.rootWatchers.set(rootId, watcher)
  } catch {
    const watcher = watch(rootPath, (_event, filename) => schedule(filename))
    watcher.on('error', () => schedule(null))
    services.rootWatchers.set(rootId, watcher)
  }
}

function closeRootWatcher(services: WindowWorkspaceServices, rootId: string): void {
  services.rootWatchers.get(rootId)?.close()
  services.rootWatchers.delete(rootId)
}

function toWorkspaceRelativePath(filename: string | Buffer | null): string | undefined {
  if (!filename) return undefined
  const value = filename.toString().split(sep).join('/')
  return fileWorkspaceRelativePathSchema.safeParse(value).success ? value : undefined
}


function createBrowserHost(window: BrowserWindow): BrowserWorkspaceHostAdapter {
  const nativeViews = new WeakMap<BrowserWorkspaceViewAdapter, WebContentsView>()
  return {
    createView: ({
      bounds
    }: {
      viewId: string
      bounds: { x: number; y: number; width: number; height: number }
    }) => {
      const nativeView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          partition: `right-workspace-${window.webContents.id}-${crypto.randomUUID()}`
        }
      })
      const webContents = nativeView.webContents
      nativeView.setBounds(bounds)
      webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      webContents.on('will-navigate', (event, url) => {
        if (!isBrowserWorkspaceUrl(url)) event.preventDefault()
      })
      webContents.on('will-redirect', (event, url) => {
        if (!isBrowserWorkspaceUrl(url)) event.preventDefault()
      })
      webContents.session.on('will-download', (event) => event.preventDefault())
      webContents.on('certificate-error', (event, _url, _error, _certificate, callback) => {
        event.preventDefault()
        callback(false)
      })
      webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false)
      )
      webContents.session.setPermissionCheckHandler(() => false)
      const adapter: BrowserWorkspaceViewAdapter = {
        loadURL: (url: string) => webContents.loadURL(url),
        setBounds: (nextBounds: { x: number; y: number; width: number; height: number }) =>
          nativeView.setBounds(nextBounds),
        goBack: () => webContents.navigationHistory.goBack(),
        goForward: () => webContents.navigationHistory.goForward(),
        reload: () => webContents.reload(),
        stop: () => webContents.stop(),
        destroy: () => {
          if (!webContents.isDestroyed()) webContents.close()
        },
        isDestroyed: () => webContents.isDestroyed(),
        canGoBack: () => webContents.navigationHistory.canGoBack(),
        canGoForward: () => webContents.navigationHistory.canGoForward(),
        getTitle: () => webContents.getTitle(),
        onDidStartLoading: (listener: () => void) => webContents.on('did-start-loading', listener),
        onDidFinishLoad: (listener: () => void) => webContents.on('did-finish-load', listener),
        onDidFailLoad: (listener: (error?: string) => void) =>
          webContents.on('did-fail-load', (_event, errorCode, errorDescription) =>
            listener(`${errorDescription} (${errorCode})`)
          ),
        onFaviconUpdated: (listener: (faviconUrls: string[]) => void) =>
          webContents.on('page-favicon-updated', (_event, faviconUrls) => listener(faviconUrls))
      }
      nativeViews.set(adapter, nativeView)
      return adapter
    },
    attachView: (view: BrowserWorkspaceViewAdapter) => {
      const nativeView = nativeViews.get(view)
      if (!nativeView) throw new Error('Browser view is unavailable')
      window.contentView.addChildView(nativeView)
    },
    detachView: (view: BrowserWorkspaceViewAdapter) => {
      const nativeView = nativeViews.get(view)
      if (!nativeView) return
      window.contentView.removeChildView(nativeView)
    },
    openExternal: (url: string) => shell.openExternal(url)
  }
}
