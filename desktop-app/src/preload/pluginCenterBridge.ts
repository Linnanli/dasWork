import {
  pluginCenterAddMarketplaceRequestSchema,
  pluginCenterAddMarketplaceResultSchema,
  pluginCenterGetPluginDetailRequestSchema,
  pluginCenterGetPluginDetailResultSchema,
  pluginCenterInstalledPluginsRequestSchema,
  pluginCenterInstalledPluginsResultSchema,
  pluginCenterInstallPluginRequestSchema,
  pluginCenterMutationResultSchema,
  pluginCenterRemoveMcpServerRequestSchema,
  pluginCenterSetAppEnabledRequestSchema,
  pluginCenterSetMcpServerEnabledRequestSchema,
  pluginCenterSetPluginEnabledRequestSchema,
  pluginCenterSetSkillEnabledRequestSchema,
  pluginCenterSnapshotRequestSchema,
  pluginCenterSnapshotResultSchema,
  pluginCenterUninstallPluginRequestSchema,
  pluginCenterUpsertMcpServerRequestSchema,
  pluginCenterIpcChannels,
  type DesktopPluginCenterApi,
  type PluginCenterMutationResult
} from '../shared/pluginCenterApi'

type Invoke = (channel: string, payload: unknown) => Promise<unknown>

/** Exposes only fixed product actions, with validation on both IPC boundaries. */
export function createPluginCenterBridge(invoke: Invoke): DesktopPluginCenterApi {
  return {
    getSnapshot: (input) =>
      invoke(
        pluginCenterIpcChannels.getSnapshot,
        pluginCenterSnapshotRequestSchema.parse(input, { jitless: true })
      ).then((result) => pluginCenterSnapshotResultSchema.parse(result, { jitless: true })),
    getInstalledPlugins: (input) =>
      invoke(
        pluginCenterIpcChannels.getInstalledPlugins,
        pluginCenterInstalledPluginsRequestSchema.parse(input, { jitless: true })
      ).then((result) => pluginCenterInstalledPluginsResultSchema.parse(result, { jitless: true })),
    getPluginDetail: (input) =>
      invoke(
        pluginCenterIpcChannels.getPluginDetail,
        pluginCenterGetPluginDetailRequestSchema.parse(input, { jitless: true })
      ).then((result) => pluginCenterGetPluginDetailResultSchema.parse(result, { jitless: true })),
    addMarketplace: (input) =>
      invoke(
        pluginCenterIpcChannels.addMarketplace,
        pluginCenterAddMarketplaceRequestSchema.parse(input, { jitless: true })
      ).then((result) => pluginCenterAddMarketplaceResultSchema.parse(result, { jitless: true })),
    installPlugin: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.installPlugin,
        pluginCenterInstallPluginRequestSchema,
        input
      ),
    uninstallPlugin: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.uninstallPlugin,
        pluginCenterUninstallPluginRequestSchema,
        input
      ),
    setPluginEnabled: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.setPluginEnabled,
        pluginCenterSetPluginEnabledRequestSchema,
        input
      ),
    setSkillEnabled: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.setSkillEnabled,
        pluginCenterSetSkillEnabledRequestSchema,
        input
      ),
    setAppEnabled: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.setAppEnabled,
        pluginCenterSetAppEnabledRequestSchema,
        input
      ),
    setMcpServerEnabled: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.setMcpServerEnabled,
        pluginCenterSetMcpServerEnabledRequestSchema,
        input
      ),
    upsertMcpServer: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.upsertMcpServer,
        pluginCenterUpsertMcpServerRequestSchema,
        input
      ),
    removeMcpServer: (input) =>
      mutation(
        invoke,
        pluginCenterIpcChannels.removeMcpServer,
        pluginCenterRemoveMcpServerRequestSchema,
        input
      )
  }
}

function mutation<T>(
  invoke: Invoke,
  channel: string,
  schema: { parse(value: unknown, options?: { jitless: boolean }): T },
  input: T
): Promise<PluginCenterMutationResult> {
  return invoke(channel, schema.parse(input, { jitless: true })).then((result) =>
    pluginCenterMutationResultSchema.parse(result, { jitless: true })
  )
}
