import {
  BROWSER_WORKSPACE_BLANK_URL,
  BROWSER_WORKSPACE_API_VERSION,
  browserWorkspaceCreateRequestSchema,
  browserWorkspaceListRequestSchema,
  browserWorkspaceListResultSchema,
  browserWorkspaceNavigateRequestSchema,
  browserWorkspaceSetBoundsRequestSchema,
  browserWorkspaceViewRequestSchema,
  browserWorkspaceViewSnapshotSchema,
  isBrowserWorkspaceUrl,
  type BrowserWorkspaceBounds,
  type BrowserWorkspaceCreateRequest,
  type BrowserWorkspaceEvent,
  type BrowserWorkspaceListRequest,
  type BrowserWorkspaceListResult,
  type BrowserWorkspaceNavigateRequest,
  type BrowserWorkspaceSetBoundsRequest,
  type BrowserWorkspaceViewRequest,
  type BrowserWorkspaceViewSnapshot
} from '../../shared/browserWorkspaceApi'

export type BrowserWorkspaceViewAdapter = {
  loadURL(url: string): Promise<void> | void
  setBounds(bounds: BrowserWorkspaceBounds): void
  goBack?(): void
  goForward?(): void
  reload?(): void
  stop?(): void
  destroy(): void
  isDestroyed(): boolean
  canGoBack?(): boolean
  canGoForward?(): boolean
  getTitle?(): string
  onDidStartLoading?(listener: () => void): void
  onDidFinishLoad?(listener: () => void): void
  onDidFailLoad?(listener: (error?: string) => void): void
  onDidNavigate?(listener: (url: string) => void): void
  onDidNavigateInPage?(listener: (url: string) => void): void
  onFaviconUpdated?(listener: (faviconUrls: string[]) => void): void
}

export type BrowserWorkspaceHostAdapter = {
  createView(input: { viewId: string; bounds: BrowserWorkspaceBounds }): BrowserWorkspaceViewAdapter
  attachView(view: BrowserWorkspaceViewAdapter): void
  detachView(view: BrowserWorkspaceViewAdapter): void
  openExternal(url: string): Promise<void> | void
}

export type BrowserWorkspaceServiceDependencies = {
  host: BrowserWorkspaceHostAdapter
  now?: () => Date
  createId?: () => string
  allowedProtocols?: readonly string[]
}

type BrowserRecord = {
  viewId: string
  workspaceId: string
  url: string
  bounds: BrowserWorkspaceBounds
  state: 'loading' | 'ready' | 'failed' | 'destroyed'
  visible: boolean
  error?: string
  faviconUrl?: string
  title?: string
  canGoBack: boolean
  canGoForward: boolean
  createdAt: string
  updatedAt: string
  view: BrowserWorkspaceViewAdapter
}

export class BrowserWorkspaceService {
  private readonly views = new Map<string, BrowserRecord>()
  private readonly listeners = new Set<(event: BrowserWorkspaceEvent) => void>()
  private nextId = 1

  constructor(private readonly dependencies: BrowserWorkspaceServiceDependencies) {}

  onEvent(listener: (event: BrowserWorkspaceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  create(input: BrowserWorkspaceCreateRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceCreateRequestSchema.parse(input)
    const url = request.url ?? BROWSER_WORKSPACE_BLANK_URL
    this.assertAllowedAppUrl(url)

    const viewId = this.dependencies.createId?.() ?? `browser-${this.nextId++}`
    const view = this.dependencies.host.createView({ viewId, bounds: request.bounds })
    const timestamp = this.nowIso()
    const record: BrowserRecord = {
      viewId,
      workspaceId: request.workspaceId,
      url,
      bounds: request.bounds,
      state: 'loading',
      visible: true,
      canGoBack: false,
      canGoForward: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      view
    }

    view.onDidStartLoading?.(() => this.updateState(viewId, 'loading'))
    view.onDidFinishLoad?.(() => this.updateState(viewId, 'ready'))
    view.onDidFailLoad?.((error) => this.updateState(viewId, 'failed', error))
    view.onDidNavigate?.((url) => this.updateNavigatedUrl(viewId, url))
    view.onDidNavigateInPage?.((url) => this.updateNavigatedUrl(viewId, url))
    view.onFaviconUpdated?.((faviconUrls) => this.updateFavicon(viewId, faviconUrls))

    this.views.set(viewId, record)
    this.dependencies.host.attachView(view)
    view.setBounds(request.bounds)
    this.loadUrl(record, url)

    const snapshot = this.snapshot(record)
    this.emit({ version: BROWSER_WORKSPACE_API_VERSION, type: 'created', view: snapshot })
    return snapshot
  }

  navigate(input: BrowserWorkspaceNavigateRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceNavigateRequestSchema.parse(input)
    this.assertAllowedAppUrl(request.url)
    const record = this.getLiveView(request.viewId)
    record.url = request.url
    record.state = 'loading'
    record.updatedAt = this.nowIso()
    record.error = undefined
    record.faviconUrl = undefined
    this.loadUrl(record, request.url)
    const snapshot = this.snapshot(record)
    this.emit({ version: BROWSER_WORKSPACE_API_VERSION, type: 'updated', view: snapshot })
    return snapshot
  }

  setBounds(input: BrowserWorkspaceSetBoundsRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceSetBoundsRequestSchema.parse(input)
    const record = this.getView(request.viewId)
    if (record.state === 'destroyed') return this.snapshot(record)
    record.bounds = request.bounds
    record.updatedAt = this.nowIso()
    record.view.setBounds(this.renderBounds(record))
    const snapshot = this.snapshot(record)
    this.emit({ version: BROWSER_WORKSPACE_API_VERSION, type: 'updated', view: snapshot })
    return snapshot
  }

  goBack(input: BrowserWorkspaceViewRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getLiveView(request.viewId)
    record.view.goBack?.()
    record.updatedAt = this.nowIso()
    this.refreshLiveMetadata(record)
    return this.snapshot(record)
  }

  goForward(input: BrowserWorkspaceViewRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getLiveView(request.viewId)
    record.view.goForward?.()
    record.updatedAt = this.nowIso()
    this.refreshLiveMetadata(record)
    return this.snapshot(record)
  }

  reload(input: BrowserWorkspaceViewRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getLiveView(request.viewId)
    record.state = 'loading'
    record.error = undefined
    record.view.reload?.()
    record.updatedAt = this.nowIso()
    this.refreshLiveMetadata(record)
    return this.snapshot(record)
  }

  stop(input: BrowserWorkspaceViewRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getLiveView(request.viewId)
    record.view.stop?.()
    record.state = 'ready'
    record.error = undefined
    record.updatedAt = this.nowIso()
    this.refreshLiveMetadata(record)
    return this.snapshot(record)
  }

  show(
    input: BrowserWorkspaceViewRequest,
    bounds?: BrowserWorkspaceBounds
  ): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getView(request.viewId)
    if (record.state === 'destroyed') return this.snapshot(record)
    if (bounds) record.bounds = bounds
    record.visible = true
    record.updatedAt = this.nowIso()
    record.view.setBounds(record.bounds)
    const snapshot = this.snapshot(record)
    this.emit({ version: BROWSER_WORKSPACE_API_VERSION, type: 'updated', view: snapshot })
    return snapshot
  }

  hide(input: BrowserWorkspaceViewRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getView(request.viewId)
    if (record.state === 'destroyed') return this.snapshot(record)
    record.visible = false
    record.updatedAt = this.nowIso()
    record.view.setBounds(this.renderBounds(record))
    const snapshot = this.snapshot(record)
    this.emit({ version: BROWSER_WORKSPACE_API_VERSION, type: 'updated', view: snapshot })
    return snapshot
  }

  destroy(input: BrowserWorkspaceViewRequest): BrowserWorkspaceViewSnapshot {
    const request = browserWorkspaceViewRequestSchema.parse(input)
    const record = this.getView(request.viewId)
    if (record.state !== 'destroyed') {
      this.refreshLiveMetadata(record)
      this.dependencies.host.detachView(record.view)
      record.view.destroy()
      record.state = 'destroyed'
      record.visible = false
      record.updatedAt = this.nowIso()
      const snapshot = this.snapshot(record)
      this.emit({ version: BROWSER_WORKSPACE_API_VERSION, type: 'destroyed', view: snapshot })
      return snapshot
    }
    return this.snapshot(record)
  }

  list(input: BrowserWorkspaceListRequest): BrowserWorkspaceListResult {
    const request = browserWorkspaceListRequestSchema.parse(input)
    const views = [...this.views.values()]
      .filter((view) => !request.workspaceId || view.workspaceId === request.workspaceId)
      .map((view) => {
        this.refreshLiveMetadata(view)
        return this.snapshot(view)
      })

    return browserWorkspaceListResultSchema.parse({
      version: BROWSER_WORKSPACE_API_VERSION,
      views
    })
  }

  disposeWorkspace(workspaceId: string): void {
    for (const view of this.views.values()) {
      if (view.workspaceId === workspaceId && view.state !== 'destroyed') {
        this.destroy({ version: BROWSER_WORKSPACE_API_VERSION, viewId: view.viewId })
      }
    }
  }

  dispose(): void {
    for (const view of this.views.values()) {
      if (view.state !== 'destroyed') {
        this.destroy({ version: BROWSER_WORKSPACE_API_VERSION, viewId: view.viewId })
      }
    }
    this.listeners.clear()
  }

  handleWindowOpen(url: string): { action: 'allow' | 'deny' } {
    if (isExternalHttpsUrl(url)) void this.dependencies.host.openExternal(url)
    return { action: 'deny' }
  }

  handlePermissionRequest(): false {
    return false
  }

  private getLiveView(viewId: string): BrowserRecord {
    const record = this.getView(viewId)
    if (record.state === 'destroyed') throw new Error('Browser view has been destroyed')
    return record
  }

  private getView(viewId: string): BrowserRecord {
    const record = this.views.get(viewId)
    if (!record) throw new Error(`Unknown browser view: ${viewId}`)
    this.reconcileNativeLifecycle(record)
    return record
  }

  private updateState(viewId: string, state: BrowserRecord['state'], error?: string): void {
    const record = this.views.get(viewId)
    if (!record || record.state === 'destroyed') return
    record.state = state
    record.error = state === 'failed' ? (error ?? 'The page could not be loaded.') : undefined
    record.updatedAt = this.nowIso()
    this.refreshLiveMetadata(record)
    this.emit({
      version: BROWSER_WORKSPACE_API_VERSION,
      type: 'updated',
      view: this.snapshot(record)
    })
  }

  private updateFavicon(viewId: string, faviconUrls: string[]): void {
    const record = this.views.get(viewId)
    if (!record || record.state === 'destroyed') return
    record.faviconUrl = faviconUrls.find(isExternalHttpsUrl)
    record.updatedAt = this.nowIso()
    this.emit({
      version: BROWSER_WORKSPACE_API_VERSION,
      type: 'updated',
      view: this.snapshot(record)
    })
  }

  private updateNavigatedUrl(viewId: string, url: string): void {
    const record = this.views.get(viewId)
    if (!record || record.state === 'destroyed' || !this.isAllowedAppUrl(url)) return
    if (record.url === url) return
    record.url = url
    record.faviconUrl = undefined
    record.updatedAt = this.nowIso()
    this.refreshLiveMetadata(record)
    this.emit({
      version: BROWSER_WORKSPACE_API_VERSION,
      type: 'updated',
      view: this.snapshot(record)
    })
  }

  private loadUrl(record: BrowserRecord, url: string): void {
    void Promise.resolve(record.view.loadURL(url)).catch((cause: unknown) => {
      this.updateState(
        record.viewId,
        'failed',
        cause instanceof Error ? cause.message : 'The page could not be loaded.'
      )
    })
  }

  private renderBounds(record: BrowserRecord): BrowserWorkspaceBounds {
    return record.visible ? record.bounds : { ...record.bounds, height: 0 }
  }

  private snapshot(record: BrowserRecord): BrowserWorkspaceViewSnapshot {
    return browserWorkspaceViewSnapshotSchema.parse({
      viewId: record.viewId,
      workspaceId: record.workspaceId,
      url: record.url,
      title: record.title,
      faviconUrl: record.faviconUrl,
      error: record.error,
      state: record.state,
      loading: record.state === 'loading',
      visible: record.visible,
      bounds: record.bounds,
      canGoBack: record.canGoBack,
      canGoForward: record.canGoForward,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    })
  }

  private refreshLiveMetadata(record: BrowserRecord): void {
    if (this.reconcileNativeLifecycle(record)) return
    record.title = record.view.getTitle?.() || undefined
    record.canGoBack = record.view.canGoBack?.() ?? false
    record.canGoForward = record.view.canGoForward?.() ?? false
  }

  private reconcileNativeLifecycle(record: BrowserRecord): boolean {
    if (record.state === 'destroyed') return true
    if (!record.view.isDestroyed()) return false
    record.state = 'destroyed'
    record.visible = false
    record.updatedAt = this.nowIso()
    return true
  }

  private assertAllowedAppUrl(url: string): void {
    if (!this.isAllowedAppUrl(url)) throw new Error(`Blocked browser workspace URL: ${url}`)
  }

  private isAllowedAppUrl(url: string): boolean {
    if (!isBrowserWorkspaceUrl(url)) return false
    if (url === BROWSER_WORKSPACE_BLANK_URL) return true
    const allowed = this.dependencies.allowedProtocols ?? ['http:', 'https:']
    return allowed.includes(new URL(url).protocol)
  }

  private emit(event: BrowserWorkspaceEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private nowIso(): string {
    return (this.dependencies.now ?? (() => new Date()))().toISOString()
  }
}

function isExternalHttpsUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:'
  } catch {
    return false
  }
}
