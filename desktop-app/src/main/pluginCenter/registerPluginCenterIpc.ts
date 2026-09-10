import {
  pluginCenterAddMarketplaceRequestSchema,
  pluginCenterAddMarketplaceResultSchema,
  pluginCenterGetAppToolsRequestSchema,
  pluginCenterGetAppToolsResultSchema,
  pluginCenterGetPluginDetailRequestSchema,
  pluginCenterGetPluginDetailResultSchema,
  pluginCenterGetRecommendedSkillsRequestSchema,
  pluginCenterGetRecommendedSkillsResultSchema,
  pluginCenterGetSkillContentsRequestSchema,
  pluginCenterGetSkillContentsResultSchema,
  pluginCenterInstalledPluginsRequestSchema,
  pluginCenterInstalledPluginsResultSchema,
  pluginCenterInstallPluginRequestSchema,
  pluginCenterInstallRecommendedSkillRequestSchema,
  pluginCenterMutationResultSchema,
  pluginCenterRemoveMcpServerRequestSchema,
  pluginCenterSetAppEnabledRequestSchema,
  pluginCenterSetMcpServerEnabledRequestSchema,
  pluginCenterSetPluginEnabledRequestSchema,
  pluginCenterSetSkillEnabledRequestSchema,
  pluginCenterSnapshotRequestSchema,
  pluginCenterSnapshotResultSchema,
  pluginCenterUninstallPluginRequestSchema,
  pluginCenterUninstallSkillRequestSchema,
  pluginCenterUpsertMcpServerRequestSchema,
  pluginCenterIpcChannels,
  pluginCenterIpcCancelRequestSchema,
  parsePluginCenterIpcRequestEnvelope
} from '../../shared/pluginCenterApi'
import type { PluginCenterService } from './PluginCenterService'

export { pluginCenterIpcChannels }

const SNAPSHOT_ERROR_MESSAGE = '插件中心数据加载失败，请重试。'
const MUTATION_ERROR_MESSAGE = '插件中心操作失败，请刷新后重试。'
const CANCELLED_ERROR_MESSAGE = '插件中心请求已取消。'
const DUPLICATE_REQUEST_ERROR_MESSAGE = '插件中心请求重复，请重试。'

type PluginCenterInvokeChannel = Exclude<
  (typeof pluginCenterIpcChannels)[keyof typeof pluginCenterIpcChannels],
  (typeof pluginCenterIpcChannels)['cancelRequest']
>

type PluginCenterExecutionContext = {
  signal: AbortSignal
}

type PluginCenterWebContents = {
  id: number
  isDestroyed?: () => boolean
  once?: (event: string, listener: () => void) => void
  off?: (event: string, listener: () => void) => void
  removeListener?: (event: string, listener: () => void) => void
}

type PluginCenterIpcEvent = {
  sender: { id: number }
}

type PluginCenterServiceMethod =
  | 'getSnapshot'
  | 'getInstalledPlugins'
  | 'getPluginDetail'
  | 'getAppTools'
  | 'getSkillContents'
  | 'getRecommendedSkills'
  | 'addMarketplace'
  | 'installPlugin'
  | 'installRecommendedSkill'
  | 'uninstallPlugin'
  | 'uninstallSkill'
  | 'setPluginEnabled'
  | 'setSkillEnabled'
  | 'setAppEnabled'
  | 'setMcpServerEnabled'
  | 'upsertMcpServer'
  | 'removeMcpServer'

type PluginCenterServiceLike = {
  [Method in PluginCenterServiceMethod]: (
    input: Parameters<PluginCenterService[Method]>[0],
    context?: PluginCenterExecutionContext
  ) => ReturnType<PluginCenterService[Method]>
}

type PendingPluginCenterRequest = {
  key: string
  requestId: string
  webContentsId: number
  controller: AbortController
  cancellable: boolean
}

type WebContentsLifecycle = {
  webContents: PluginCenterWebContents
  refCount: number
  onDestroyed: () => void
  onRenderProcessGone: () => void
}

const pendingRequests = new Map<string, PendingPluginCenterRequest>()
const webContentsLifecycles = new Map<number, WebContentsLifecycle>()
const lifecycleCounters = {
  completed: 0,
  cancelled: 0,
  ignoredCancels: 0,
  failed: 0,
  duplicateRequests: 0,
  windowAborted: 0
}

export function createPluginCenterIpcHandlers(
  service: PluginCenterServiceLike
): Record<PluginCenterInvokeChannel, (_event: unknown, payload: unknown) => Promise<unknown>> {
  return {
    [pluginCenterIpcChannels.getSnapshot]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterSnapshotRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterSnapshotResultSchema.parse(await service.getSnapshot(input, context)),
        event,
        requestId,
        SNAPSHOT_ERROR_MESSAGE,
        { cancellable: true }
      )
    },
    [pluginCenterIpcChannels.getInstalledPlugins]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterInstalledPluginsRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterInstalledPluginsResultSchema.parse(
            await service.getInstalledPlugins(input, context)
          ),
        event,
        requestId,
        SNAPSHOT_ERROR_MESSAGE,
        { cancellable: true }
      )
    },
    [pluginCenterIpcChannels.getPluginDetail]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterGetPluginDetailRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterGetPluginDetailResultSchema.parse(
            await service.getPluginDetail(input, context)
          ),
        event,
        requestId,
        SNAPSHOT_ERROR_MESSAGE,
        { cancellable: true }
      )
    },
    [pluginCenterIpcChannels.getAppTools]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterGetAppToolsRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterGetAppToolsResultSchema.parse(await service.getAppTools(input, context)),
        event,
        requestId,
        SNAPSHOT_ERROR_MESSAGE,
        { cancellable: true }
      )
    },
    [pluginCenterIpcChannels.getSkillContents]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterGetSkillContentsRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterGetSkillContentsResultSchema.parse(
            await service.getSkillContents(input, context)
          ),
        event,
        requestId,
        SNAPSHOT_ERROR_MESSAGE,
        { cancellable: true }
      )
    },
    [pluginCenterIpcChannels.getRecommendedSkills]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterGetRecommendedSkillsRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterGetRecommendedSkillsResultSchema.parse(
            await service.getRecommendedSkills(input, context)
          ),
        event,
        requestId,
        SNAPSHOT_ERROR_MESSAGE,
        { cancellable: true }
      )
    },
    [pluginCenterIpcChannels.addMarketplace]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterAddMarketplaceRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterAddMarketplaceResultSchema.parse(
            await service.addMarketplace(input, context)
          ),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.installPlugin]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterInstallPluginRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.installPlugin(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.installRecommendedSkill]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterInstallRecommendedSkillRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(
            await service.installRecommendedSkill(input, context)
          ),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.uninstallPlugin]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterUninstallPluginRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.uninstallPlugin(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.uninstallSkill]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterUninstallSkillRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.uninstallSkill(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.setPluginEnabled]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterSetPluginEnabledRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.setPluginEnabled(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.setSkillEnabled]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterSetSkillEnabledRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.setSkillEnabled(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.setAppEnabled]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterSetAppEnabledRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.setAppEnabled(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.setMcpServerEnabled]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterSetMcpServerEnabledRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.setMcpServerEnabled(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.upsertMcpServer]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterUpsertMcpServerRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.upsertMcpServer(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    },
    [pluginCenterIpcChannels.removeMcpServer]: async (event, payload) => {
      const { requestId, payload: input } = parseEnvelope(
        payload,
        pluginCenterRemoveMcpServerRequestSchema
      )
      return safePluginCenterCall(
        async (context) =>
          pluginCenterMutationResultSchema.parse(await service.removeMcpServer(input, context)),
        event,
        requestId,
        MUTATION_ERROR_MESSAGE,
        { cancellable: false }
      )
    }
  }
}

export function createPluginCenterCancelRequestHandler(): (
  event: PluginCenterIpcEvent,
  payload: unknown
) => void {
  return (event, payload) => {
    const { requestId } = pluginCenterIpcCancelRequestSchema.parse(payload)
    const webContentsId = event.sender.id
    const key = requestKey(webContentsId, requestId)
    const pending = pendingRequests.get(key)
    if (!pending) {
      lifecycleCounters.ignoredCancels += 1
      return
    }
    if (!pending.cancellable) {
      lifecycleCounters.ignoredCancels += 1
      return
    }
    lifecycleCounters.cancelled += 1
    pending.controller.abort()
    completePendingRequest(key)
  }
}

export function getPluginCenterIpcLifecycleDiagnostics(): {
  pending: number
  completed: number
  cancelled: number
  ignoredCancels: number
  failed: number
  duplicateRequests: number
  windowAborted: number
} {
  return {
    pending: pendingRequests.size,
    ...lifecycleCounters
  }
}

export function resetPluginCenterIpcLifecycleForTests(): void {
  for (const key of [...pendingRequests.keys()]) completePendingRequest(key)
  pendingRequests.clear()
  webContentsLifecycles.clear()
  lifecycleCounters.completed = 0
  lifecycleCounters.cancelled = 0
  lifecycleCounters.ignoredCancels = 0
  lifecycleCounters.failed = 0
  lifecycleCounters.duplicateRequests = 0
  lifecycleCounters.windowAborted = 0
}

async function safePluginCenterCall<T>(
  action: (context: PluginCenterExecutionContext) => Promise<T>,
  event: unknown,
  requestId: string,
  message: string,
  lifecycle: { cancellable: boolean }
): Promise<T> {
  const registration = registerPendingRequest(event, requestId, lifecycle)
  if (!registration) {
    lifecycleCounters.duplicateRequests += 1
    throw new Error(DUPLICATE_REQUEST_ERROR_MESSAGE)
  }
  const { key, controller } = registration
  try {
    const operation = action({ signal: controller.signal })
    const result = lifecycle.cancellable
      ? await runUntilCancelled(operation, controller.signal)
      : await operation
    lifecycleCounters.completed += 1
    return result
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(CANCELLED_ERROR_MESSAGE)
    }
    lifecycleCounters.failed += 1
    console.error('[plugin-center] IPC operation failed', safeErrorMetadata(cause))
    throw new Error(message)
  } finally {
    completePendingRequest(key)
  }
}

function parseEnvelope<T>(
  payload: unknown,
  payloadSchema: { parse(value: unknown, options?: { jitless: boolean }): T }
): { requestId: string; payload: T } {
  return parsePluginCenterIpcRequestEnvelope(payload, payloadSchema)
}

function registerPendingRequest(
  event: unknown,
  requestId: string,
  lifecycle: { cancellable: boolean }
): PendingPluginCenterRequest | null {
  const webContents = senderFromEvent(event)
  const key = requestKey(webContents.id, requestId)
  if (pendingRequests.has(key)) return null

  const pending = {
    key,
    requestId,
    webContentsId: webContents.id,
    controller: new AbortController(),
    cancellable: lifecycle.cancellable
  }
  pendingRequests.set(key, pending)
  retainWebContents(webContents)
  return pending
}

function senderFromEvent(event: unknown): PluginCenterWebContents {
  const sender = (event as Partial<PluginCenterIpcEvent> | null)?.sender
  if (!sender || typeof sender.id !== 'number') {
    throw new Error('Plugin Center IPC event is missing a sender')
  }
  return sender as PluginCenterWebContents
}

function requestKey(webContentsId: number, requestId: string): string {
  return `${webContentsId}:${requestId}`
}

function runUntilCancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  operation.catch(() => undefined)
  if (signal.aborted) return Promise.reject(new Error(CANCELLED_ERROR_MESSAGE))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(CANCELLED_ERROR_MESSAGE))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function retainWebContents(webContents: PluginCenterWebContents): void {
  const existing = webContentsLifecycles.get(webContents.id)
  if (existing) {
    existing.refCount += 1
    return
  }

  const onDestroyed = (): void => abortWebContentsRequests(webContents.id)
  const onRenderProcessGone = (): void => abortWebContentsRequests(webContents.id)
  webContents.once?.('destroyed', onDestroyed)
  webContents.once?.('render-process-gone', onRenderProcessGone)
  webContentsLifecycles.set(webContents.id, {
    webContents,
    refCount: 1,
    onDestroyed,
    onRenderProcessGone
  })
}

function completePendingRequest(key: string): void {
  const pending = pendingRequests.get(key)
  if (!pending) return
  pendingRequests.delete(key)
  releaseWebContents(pending.webContentsId)
}

function releaseWebContents(webContentsId: number): void {
  const lifecycle = webContentsLifecycles.get(webContentsId)
  if (!lifecycle) return
  lifecycle.refCount -= 1
  if (lifecycle.refCount > 0) return

  removeWebContentsListener(lifecycle.webContents, 'destroyed', lifecycle.onDestroyed)
  removeWebContentsListener(
    lifecycle.webContents,
    'render-process-gone',
    lifecycle.onRenderProcessGone
  )
  webContentsLifecycles.delete(webContentsId)
}

function abortWebContentsRequests(webContentsId: number): void {
  const keys = [...pendingRequests.entries()]
    .filter(([, pending]) => pending.webContentsId === webContentsId)
    .map(([key]) => key)
  lifecycleCounters.windowAborted += keys.length
  for (const key of keys) {
    const pending = pendingRequests.get(key)
    if (pending?.cancellable) pending.controller.abort()
    completePendingRequest(key)
  }
}

function safeErrorMetadata(cause: unknown): { errorName: string; errorType: string } {
  if (cause instanceof Error) {
    return { errorName: cause.name, errorType: 'error' }
  }
  return { errorName: 'NonError', errorType: typeof cause }
}

function removeWebContentsListener(
  webContents: PluginCenterWebContents,
  event: 'destroyed' | 'render-process-gone',
  listener: () => void
): void {
  if (webContents.isDestroyed?.()) return
  if (webContents.off) {
    webContents.off(event, listener)
    return
  }
  webContents.removeListener?.(event, listener)
}
