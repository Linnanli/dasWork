import { randomUUID } from 'node:crypto'

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
  pluginCenterIpcCancelRequestSchema,
  pluginCenterIpcChannels,
  parsePluginCenterIpcRequestEnvelope,
  type DesktopPluginCenterApi,
  type PluginCenterMutationResult,
  type PluginCenterRequestOptions
} from '../shared/pluginCenterApi'

type Invoke = (channel: string, payload: unknown) => Promise<unknown>
type Send = (channel: string, payload: unknown) => void

/** Exposes only fixed product actions, with validation on both IPC boundaries. */
export function createPluginCenterBridge(
  invoke: Invoke,
  send: Send = () => undefined
): DesktopPluginCenterApi {
  return {
    cancelRequest: (requestId) => {
      send(
        pluginCenterIpcChannels.cancelRequest,
        pluginCenterIpcCancelRequestSchema.parse({ requestId }, { jitless: true })
      )
    },
    getSnapshot: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.getSnapshot,
        pluginCenterSnapshotRequestSchema,
        pluginCenterSnapshotResultSchema,
        input,
        options
      ),
    getInstalledPlugins: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.getInstalledPlugins,
        pluginCenterInstalledPluginsRequestSchema,
        pluginCenterInstalledPluginsResultSchema,
        input,
        options
      ),
    getPluginDetail: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.getPluginDetail,
        pluginCenterGetPluginDetailRequestSchema,
        pluginCenterGetPluginDetailResultSchema,
        input,
        options
      ),
    getAppTools: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.getAppTools,
        pluginCenterGetAppToolsRequestSchema,
        pluginCenterGetAppToolsResultSchema,
        input,
        options
      ),
    getSkillContents: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.getSkillContents,
        pluginCenterGetSkillContentsRequestSchema,
        pluginCenterGetSkillContentsResultSchema,
        input,
        options
      ),
    getRecommendedSkills: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.getRecommendedSkills,
        pluginCenterGetRecommendedSkillsRequestSchema,
        pluginCenterGetRecommendedSkillsResultSchema,
        input,
        options
      ),
    addMarketplace: (input, options) =>
      request(
        invoke,
        send,
        pluginCenterIpcChannels.addMarketplace,
        pluginCenterAddMarketplaceRequestSchema,
        pluginCenterAddMarketplaceResultSchema,
        input,
        options,
        { cancellable: false }
      ),
    installPlugin: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.installPlugin,
        pluginCenterInstallPluginRequestSchema,
        input,
        options
      ),
    installRecommendedSkill: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.installRecommendedSkill,
        pluginCenterInstallRecommendedSkillRequestSchema,
        input,
        options
      ),
    uninstallPlugin: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.uninstallPlugin,
        pluginCenterUninstallPluginRequestSchema,
        input,
        options
      ),
    uninstallSkill: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.uninstallSkill,
        pluginCenterUninstallSkillRequestSchema,
        input,
        options
      ),
    setPluginEnabled: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.setPluginEnabled,
        pluginCenterSetPluginEnabledRequestSchema,
        input,
        options
      ),
    setSkillEnabled: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.setSkillEnabled,
        pluginCenterSetSkillEnabledRequestSchema,
        input,
        options
      ),
    setAppEnabled: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.setAppEnabled,
        pluginCenterSetAppEnabledRequestSchema,
        input,
        options
      ),
    setMcpServerEnabled: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.setMcpServerEnabled,
        pluginCenterSetMcpServerEnabledRequestSchema,
        input,
        options
      ),
    upsertMcpServer: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.upsertMcpServer,
        pluginCenterUpsertMcpServerRequestSchema,
        input,
        options
      ),
    removeMcpServer: (input, options) =>
      mutation(
        invoke,
        send,
        pluginCenterIpcChannels.removeMcpServer,
        pluginCenterRemoveMcpServerRequestSchema,
        input,
        options
      )
  }
}

function mutation<T>(
  invoke: Invoke,
  send: Send,
  channel: string,
  schema: { parse(value: unknown, options?: { jitless: boolean }): T },
  input: T,
  options?: PluginCenterRequestOptions
): Promise<PluginCenterMutationResult> {
  return request(invoke, send, channel, schema, pluginCenterMutationResultSchema, input, options, {
    cancellable: false
  })
}

async function request<TInput, TResult>(
  invoke: Invoke,
  send: Send,
  channel: string,
  requestSchema: { parse(value: unknown, options?: { jitless: boolean }): TInput },
  resultSchema: { parse(value: unknown, options?: { jitless: boolean }): TResult },
  input: TInput,
  options?: PluginCenterRequestOptions,
  lifecycle: { cancellable: boolean } = { cancellable: true }
): Promise<TResult> {
  const payload = requestSchema.parse(input, { jitless: true })
  const requestId = options?.requestId ?? randomUUID()
  const envelope = parsePluginCenterIpcRequestEnvelope({ requestId, payload }, requestSchema, {
    jitless: true
  })
  const signal = abortSignalFrom(options?.signal)
  if (signal?.aborted) {
    throw new Error('Plugin Center request was cancelled')
  }
  let cancelSent = false
  const sendCancel = (): void => {
    if (cancelSent) return
    cancelSent = true
    send(pluginCenterIpcChannels.cancelRequest, { requestId })
  }

  if (lifecycle.cancellable) {
    signal?.addEventListener('abort', sendCancel, { once: true })
  }

  try {
    const result = await invoke(channel, envelope)
    return resultSchema.parse(result, { jitless: true })
  } finally {
    if (lifecycle.cancellable) {
      signal?.removeEventListener('abort', sendCancel)
    }
  }
}

function abortSignalFrom(value: unknown): AbortSignal | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as Partial<AbortSignal>).aborted !== 'boolean' ||
    typeof (value as Partial<AbortSignal>).addEventListener !== 'function' ||
    typeof (value as Partial<AbortSignal>).removeEventListener !== 'function'
  ) {
    return undefined
  }
  return value as AbortSignal
}
