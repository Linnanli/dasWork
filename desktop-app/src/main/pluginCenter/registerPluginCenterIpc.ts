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
  type PluginCenterGetAppToolsRequest,
  type PluginCenterGetAppToolsResult,
  type PluginCenterInstalledPluginsRequest,
  type PluginCenterInstalledPluginsResult
} from '../../shared/pluginCenterApi'
import type { PluginCenterService } from './PluginCenterService'

export { pluginCenterIpcChannels }

const SNAPSHOT_ERROR_MESSAGE = '插件中心数据加载失败，请重试。'
const MUTATION_ERROR_MESSAGE = '插件中心操作失败，请刷新后重试。'

type PluginCenterServiceLike = Pick<
  PluginCenterService,
  | 'getSnapshot'
  | 'getPluginDetail'
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
> & {
  getInstalledPlugins(
    input: PluginCenterInstalledPluginsRequest
  ): Promise<PluginCenterInstalledPluginsResult>
  getAppTools(input: PluginCenterGetAppToolsRequest): Promise<PluginCenterGetAppToolsResult>
}

export function createPluginCenterIpcHandlers(
  service: PluginCenterServiceLike
): Record<
  (typeof pluginCenterIpcChannels)[keyof typeof pluginCenterIpcChannels],
  (_event: unknown, payload: unknown) => Promise<unknown>
> {
  return {
    [pluginCenterIpcChannels.getSnapshot]: async (_event, payload) => {
      const input = pluginCenterSnapshotRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterSnapshotResultSchema.parse(await service.getSnapshot(input)),
        SNAPSHOT_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.getInstalledPlugins]: async (_event, payload) => {
      const input = pluginCenterInstalledPluginsRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterInstalledPluginsResultSchema.parse(await service.getInstalledPlugins(input)),
        SNAPSHOT_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.getPluginDetail]: async (_event, payload) => {
      const input = pluginCenterGetPluginDetailRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterGetPluginDetailResultSchema.parse(await service.getPluginDetail(input)),
        SNAPSHOT_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.getAppTools]: async (_event, payload) => {
      const input = pluginCenterGetAppToolsRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterGetAppToolsResultSchema.parse(await service.getAppTools(input)),
        SNAPSHOT_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.getSkillContents]: async (_event, payload) => {
      const input = pluginCenterGetSkillContentsRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterGetSkillContentsResultSchema.parse(await service.getSkillContents(input)),
        SNAPSHOT_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.getRecommendedSkills]: async (_event, payload) => {
      const input = pluginCenterGetRecommendedSkillsRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterGetRecommendedSkillsResultSchema.parse(
            await service.getRecommendedSkills(input)
          ),
        SNAPSHOT_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.addMarketplace]: async (_event, payload) => {
      const input = pluginCenterAddMarketplaceRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterAddMarketplaceResultSchema.parse(await service.addMarketplace(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.installPlugin]: async (_event, payload) => {
      const input = pluginCenterInstallPluginRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.installPlugin(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.installRecommendedSkill]: async (_event, payload) => {
      const input = pluginCenterInstallRecommendedSkillRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterMutationResultSchema.parse(await service.installRecommendedSkill(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.uninstallPlugin]: async (_event, payload) => {
      const input = pluginCenterUninstallPluginRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.uninstallPlugin(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.uninstallSkill]: async (_event, payload) => {
      const input = pluginCenterUninstallSkillRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.uninstallSkill(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.setPluginEnabled]: async (_event, payload) => {
      const input = pluginCenterSetPluginEnabledRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.setPluginEnabled(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.setSkillEnabled]: async (_event, payload) => {
      const input = pluginCenterSetSkillEnabledRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.setSkillEnabled(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.setAppEnabled]: async (_event, payload) => {
      const input = pluginCenterSetAppEnabledRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.setAppEnabled(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.setMcpServerEnabled]: async (_event, payload) => {
      const input = pluginCenterSetMcpServerEnabledRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () =>
          pluginCenterMutationResultSchema.parse(await service.setMcpServerEnabled(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.upsertMcpServer]: async (_event, payload) => {
      const input = pluginCenterUpsertMcpServerRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.upsertMcpServer(input)),
        MUTATION_ERROR_MESSAGE
      )
    },
    [pluginCenterIpcChannels.removeMcpServer]: async (_event, payload) => {
      const input = pluginCenterRemoveMcpServerRequestSchema.parse(payload)
      return safePluginCenterCall(
        async () => pluginCenterMutationResultSchema.parse(await service.removeMcpServer(input)),
        MUTATION_ERROR_MESSAGE
      )
    }
  }
}

async function safePluginCenterCall<T>(action: () => Promise<T>, message: string): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    console.error('[plugin-center] IPC operation failed', cause)
    throw new Error(message)
  }
}
