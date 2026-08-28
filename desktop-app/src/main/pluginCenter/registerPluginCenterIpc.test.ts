import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PLUGIN_CENTER_API_VERSION } from '../../shared/pluginCenterApi'
import { createPluginCenterIpcHandlers, pluginCenterIpcChannels } from './registerPluginCenterIpc'

const VALID_CONTEXT = { version: PLUGIN_CENTER_API_VERSION, cwd: '/repo' } as const

const EMPTY_SNAPSHOT = {
  version: PLUGIN_CENTER_API_VERSION,
  generatedAt: '2026-08-24T00:00:00.000Z',
  plugins: [],
  skills: [],
  apps: [],
  mcp: { userServers: [], pluginServers: [] },
  marketplaces: []
} as const

const SNAPSHOT_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  snapshot: EMPTY_SNAPSHOT
} as const

const MUTATION_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  status: 'applied',
  changedSections: []
} as const

const INSTALLED_PLUGINS_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  generatedAt: '2026-08-24T00:00:00.000Z',
  plugins: []
} as const

const PLUGIN_DETAIL_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  status: 'missing',
  missingReason: 'not_found'
} as const

const APP_TOOLS_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  status: 'ready',
  app: { id: 'app-a' },
  tools: [
    {
      name: 'create_issue',
      title: 'Create issue',
      description: 'Creates an issue',
      enabled: false,
      disabledReason: 'disabled_by_admin',
      readOnly: false,
      restriction: {
        source: 'enterprise',
        kind: 'admin',
        message: '被管理员禁用',
        editable: false
      }
    }
  ]
} as const

const MARKETPLACE_RESULT = {
  ...MUTATION_RESULT,
  marketplace: {
    id: 'market-main',
    name: 'Main marketplace',
    source: 'https://example.com/plugins.git',
    sparsePaths: []
  },
  alreadyAdded: false
} as const

type ServiceMethod =
  | 'getSnapshot'
  | 'getInstalledPlugins'
  | 'getPluginDetail'
  | 'getAppTools'
  | 'addMarketplace'
  | 'installPlugin'
  | 'uninstallPlugin'
  | 'setPluginEnabled'
  | 'setSkillEnabled'
  | 'setAppEnabled'
  | 'setMcpServerEnabled'
  | 'upsertMcpServer'
  | 'removeMcpServer'

type Case = {
  channel: (typeof pluginCenterIpcChannels)[keyof typeof pluginCenterIpcChannels]
  method: ServiceMethod
  validPayload: unknown
  expectedPayload: unknown
  invalidPayload: unknown
  validResult: unknown
}

const cases: Case[] = [
  {
    channel: pluginCenterIpcChannels.getSnapshot,
    method: 'getSnapshot',
    validPayload: { ...VALID_CONTEXT, forceRefresh: true },
    expectedPayload: { ...VALID_CONTEXT, forceRefresh: true },
    invalidPayload: { version: 2 },
    validResult: SNAPSHOT_RESULT
  },
  {
    channel: pluginCenterIpcChannels.getInstalledPlugins,
    method: 'getInstalledPlugins',
    validPayload: VALID_CONTEXT,
    expectedPayload: VALID_CONTEXT,
    invalidPayload: { ...VALID_CONTEXT, threadId: 'thread-a' },
    validResult: INSTALLED_PLUGINS_RESULT
  },
  {
    channel: pluginCenterIpcChannels.getPluginDetail,
    method: 'getPluginDetail',
    validPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    invalidPayload: { ...VALID_CONTEXT, plugin: { id: '' } },
    validResult: PLUGIN_DETAIL_RESULT
  },
  {
    channel: pluginCenterIpcChannels.getAppTools,
    method: 'getAppTools',
    validPayload: { ...VALID_CONTEXT, threadId: 'thread-a', app: { id: 'app-a' } },
    expectedPayload: { ...VALID_CONTEXT, threadId: 'thread-a', app: { id: 'app-a' } },
    invalidPayload: { ...VALID_CONTEXT, app: { id: 'app-a' }, includeTools: true },
    validResult: APP_TOOLS_RESULT
  },
  {
    channel: pluginCenterIpcChannels.addMarketplace,
    method: 'addMarketplace',
    validPayload: {
      ...VALID_CONTEXT,
      source: 'https://example.com/plugins.git',
      refName: 'main',
      sparsePaths: ['plugins/core', 'plugins/core']
    },
    expectedPayload: {
      ...VALID_CONTEXT,
      source: 'https://example.com/plugins.git',
      refName: 'main',
      sparsePaths: ['plugins/core']
    },
    invalidPayload: { ...VALID_CONTEXT, source: '' },
    validResult: MARKETPLACE_RESULT
  },
  {
    channel: pluginCenterIpcChannels.installPlugin,
    method: 'installPlugin',
    validPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    invalidPayload: { ...VALID_CONTEXT, plugin: { id: '' } },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.uninstallPlugin,
    method: 'uninstallPlugin',
    validPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' } },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' } },
    invalidPayload: { ...VALID_CONTEXT, plugin: { id: '' } },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.setPluginEnabled,
    method: 'setPluginEnabled',
    validPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' }, enabled: false },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' }, enabled: false },
    invalidPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' }, enabled: 'false' },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.setSkillEnabled,
    method: 'setSkillEnabled',
    validPayload: { ...VALID_CONTEXT, skill: { id: 'skill-a' }, enabled: true },
    expectedPayload: { ...VALID_CONTEXT, skill: { id: 'skill-a' }, enabled: true },
    invalidPayload: { ...VALID_CONTEXT, skill: { id: 'skill-a' }, enabled: 'true' },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.setAppEnabled,
    method: 'setAppEnabled',
    validPayload: { ...VALID_CONTEXT, app: { id: 'app-a' }, enabled: true },
    expectedPayload: { ...VALID_CONTEXT, app: { id: 'app-a' }, enabled: true },
    invalidPayload: { ...VALID_CONTEXT, app: { id: 'app-a' }, enabled: 1 },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.setMcpServerEnabled,
    method: 'setMcpServerEnabled',
    validPayload: { ...VALID_CONTEXT, server: { id: 'server-a' }, enabled: false },
    expectedPayload: { ...VALID_CONTEXT, server: { id: 'server-a' }, enabled: false },
    invalidPayload: { ...VALID_CONTEXT, server: { id: 'server-a' }, enabled: null },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.upsertMcpServer,
    method: 'upsertMcpServer',
    validPayload: {
      ...VALID_CONTEXT,
      serverId: 'server-a',
      displayName: 'Server A',
      server: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        cwd: '/repo',
        env: [{ name: 'API_TOKEN', value: { action: 'keep' } }],
        envVars: ['PATH', 'PATH']
      }
    },
    expectedPayload: {
      ...VALID_CONTEXT,
      serverId: 'server-a',
      displayName: 'Server A',
      server: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        cwd: '/repo',
        env: [{ name: 'API_TOKEN', value: { action: 'keep' } }],
        envVars: ['PATH']
      }
    },
    invalidPayload: {
      ...VALID_CONTEXT,
      server: { transport: 'streamable-http', url: 'file:///tmp/server' }
    },
    validResult: MUTATION_RESULT
  },
  {
    channel: pluginCenterIpcChannels.removeMcpServer,
    method: 'removeMcpServer',
    validPayload: { ...VALID_CONTEXT, server: { id: 'server-a' } },
    expectedPayload: { ...VALID_CONTEXT, server: { id: 'server-a' } },
    invalidPayload: { ...VALID_CONTEXT, server: { id: '' } },
    validResult: MUTATION_RESULT
  }
]

function createService(
  resultByMethod: Partial<Record<ServiceMethod, unknown>> = {}
): Record<ServiceMethod, ReturnType<typeof vi.fn>> {
  return {
    getSnapshot: vi.fn(async () => resultByMethod.getSnapshot ?? SNAPSHOT_RESULT),
    getInstalledPlugins: vi.fn(
      async () => resultByMethod.getInstalledPlugins ?? INSTALLED_PLUGINS_RESULT
    ),
    getPluginDetail: vi.fn(async () => resultByMethod.getPluginDetail ?? PLUGIN_DETAIL_RESULT),
    getAppTools: vi.fn(async () => resultByMethod.getAppTools ?? APP_TOOLS_RESULT),
    addMarketplace: vi.fn(async () => resultByMethod.addMarketplace ?? MARKETPLACE_RESULT),
    installPlugin: vi.fn(async () => resultByMethod.installPlugin ?? MUTATION_RESULT),
    uninstallPlugin: vi.fn(async () => resultByMethod.uninstallPlugin ?? MUTATION_RESULT),
    setPluginEnabled: vi.fn(async () => resultByMethod.setPluginEnabled ?? MUTATION_RESULT),
    setSkillEnabled: vi.fn(async () => resultByMethod.setSkillEnabled ?? MUTATION_RESULT),
    setAppEnabled: vi.fn(async () => resultByMethod.setAppEnabled ?? MUTATION_RESULT),
    setMcpServerEnabled: vi.fn(async () => resultByMethod.setMcpServerEnabled ?? MUTATION_RESULT),
    upsertMcpServer: vi.fn(async () => resultByMethod.upsertMcpServer ?? MUTATION_RESULT),
    removeMcpServer: vi.fn(async () => resultByMethod.removeMcpServer ?? MUTATION_RESULT)
  }
}

describe('createPluginCenterIpcHandlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('exposes only the fixed plugin center channels', () => {
    expect(pluginCenterIpcChannels).toEqual({
      getSnapshot: 'codex:plugin-center:get-snapshot',
      getInstalledPlugins: 'codex:plugin-center:get-installed-plugins',
      getPluginDetail: 'codex:plugin-center:get-plugin-detail',
      getAppTools: 'codex:plugin-center:get-app-tools',
      addMarketplace: 'codex:plugin-center:add-marketplace',
      installPlugin: 'codex:plugin-center:install-plugin',
      uninstallPlugin: 'codex:plugin-center:uninstall-plugin',
      setPluginEnabled: 'codex:plugin-center:set-plugin-enabled',
      setSkillEnabled: 'codex:plugin-center:set-skill-enabled',
      setAppEnabled: 'codex:plugin-center:set-app-enabled',
      setMcpServerEnabled: 'codex:plugin-center:set-mcp-server-enabled',
      upsertMcpServer: 'codex:plugin-center:upsert-mcp-server',
      removeMcpServer: 'codex:plugin-center:remove-mcp-server'
    })

    const handlers = createPluginCenterIpcHandlers(createService() as never)
    expect(Object.keys(handlers).sort()).toEqual(Object.values(pluginCenterIpcChannels).sort())
  })

  it.each(cases)(
    'validates request and result boundaries for $method',
    async ({ channel, method, validPayload, expectedPayload, validResult }) => {
      const service = createService({ [method]: validResult })
      const handlers = createPluginCenterIpcHandlers(service as never)

      const result = await handlers[channel]({}, validPayload)

      expect(result).toEqual(validResult)
      expect(service[method]).toHaveBeenCalledTimes(1)
      expect(service[method]).toHaveBeenCalledWith(expectedPayload)
    }
  )

  it.each(cases)(
    'rejects an invalid $method request before calling the service',
    async ({ channel, method, invalidPayload }) => {
      const service = createService()
      const handlers = createPluginCenterIpcHandlers(service as never)

      await expect(handlers[channel]({}, invalidPayload)).rejects.toThrow()
      expect(service[method]).not.toHaveBeenCalled()
    }
  )

  it.each(cases)(
    'rejects an invalid $method result after the service returns',
    async ({ channel, method, validPayload }) => {
      const service = createService({ [method]: { version: PLUGIN_CENTER_API_VERSION } })
      const handlers = createPluginCenterIpcHandlers(service as never)

      await expect(handlers[channel]({}, validPayload)).rejects.toThrow()
      expect(service[method]).toHaveBeenCalledTimes(1)
    }
  )

  it.each(cases)(
    'hides $method service errors from the renderer boundary',
    async ({ channel, method, validPayload }) => {
      const sensitiveDetail = `secret-${method}-detail`
      const error = new Error(`${method} failed: ${sensitiveDetail}`)
      const service = createService()
      service[method].mockRejectedValueOnce(error)
      const handlers = createPluginCenterIpcHandlers(service as never)

      const expectedMessage =
        method === 'getSnapshot' ||
        method === 'getInstalledPlugins' ||
        method === 'getPluginDetail' ||
        method === 'getAppTools'
          ? '插件中心数据加载失败，请重试。'
          : '插件中心操作失败，请刷新后重试。'
      await expect(handlers[channel]({}, validPayload)).rejects.toThrow(expectedMessage)
      expect(console.error).toHaveBeenCalledWith('[plugin-center] IPC operation failed', error)
    }
  )
})
