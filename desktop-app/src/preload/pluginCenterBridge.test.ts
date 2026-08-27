import { beforeEach, describe, expect, it, vi } from 'vitest'

import { pluginCenterIpcChannels } from '../main/pluginCenter/registerPluginCenterIpc'
import { PLUGIN_CENTER_API_VERSION } from '../shared/pluginCenterApi'
import { createPluginCenterBridge } from './pluginCenterBridge'

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

type BridgeMethod =
  | 'getSnapshot'
  | 'getInstalledPlugins'
  | 'getPluginDetail'
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
  method: BridgeMethod
  channel: (typeof pluginCenterIpcChannels)[keyof typeof pluginCenterIpcChannels]
  input: unknown
  expectedPayload: unknown
  invalidInput: unknown
  result: unknown
}

const cases: Case[] = [
  {
    method: 'getSnapshot',
    channel: pluginCenterIpcChannels.getSnapshot,
    input: { ...VALID_CONTEXT, forceRefresh: true },
    expectedPayload: { ...VALID_CONTEXT, forceRefresh: true },
    invalidInput: { version: 2 },
    result: SNAPSHOT_RESULT
  },
  {
    method: 'getInstalledPlugins',
    channel: pluginCenterIpcChannels.getInstalledPlugins,
    input: VALID_CONTEXT,
    expectedPayload: VALID_CONTEXT,
    invalidInput: { ...VALID_CONTEXT, threadId: 'thread-a' },
    result: INSTALLED_PLUGINS_RESULT
  },
  {
    method: 'getPluginDetail',
    channel: pluginCenterIpcChannels.getPluginDetail,
    input: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    invalidInput: { ...VALID_CONTEXT, plugin: { id: '' } },
    result: PLUGIN_DETAIL_RESULT
  },
  {
    method: 'addMarketplace',
    channel: pluginCenterIpcChannels.addMarketplace,
    input: {
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
    invalidInput: { ...VALID_CONTEXT, source: '' },
    result: MARKETPLACE_RESULT
  },
  {
    method: 'installPlugin',
    channel: pluginCenterIpcChannels.installPlugin,
    input: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
    invalidInput: { ...VALID_CONTEXT, plugin: { id: '' } },
    result: MUTATION_RESULT
  },
  {
    method: 'uninstallPlugin',
    channel: pluginCenterIpcChannels.uninstallPlugin,
    input: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' } },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' } },
    invalidInput: { ...VALID_CONTEXT, plugin: { id: '' } },
    result: MUTATION_RESULT
  },
  {
    method: 'setPluginEnabled',
    channel: pluginCenterIpcChannels.setPluginEnabled,
    input: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' }, enabled: false },
    expectedPayload: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' }, enabled: false },
    invalidInput: { ...VALID_CONTEXT, plugin: { id: 'plugin-a' }, enabled: 'false' },
    result: MUTATION_RESULT
  },
  {
    method: 'setSkillEnabled',
    channel: pluginCenterIpcChannels.setSkillEnabled,
    input: { ...VALID_CONTEXT, skill: { id: 'skill-a' }, enabled: true },
    expectedPayload: { ...VALID_CONTEXT, skill: { id: 'skill-a' }, enabled: true },
    invalidInput: { ...VALID_CONTEXT, skill: { id: 'skill-a' }, enabled: 'true' },
    result: MUTATION_RESULT
  },
  {
    method: 'setAppEnabled',
    channel: pluginCenterIpcChannels.setAppEnabled,
    input: { ...VALID_CONTEXT, app: { id: 'app-a' }, enabled: true },
    expectedPayload: { ...VALID_CONTEXT, app: { id: 'app-a' }, enabled: true },
    invalidInput: { ...VALID_CONTEXT, app: { id: 'app-a' }, enabled: 1 },
    result: MUTATION_RESULT
  },
  {
    method: 'setMcpServerEnabled',
    channel: pluginCenterIpcChannels.setMcpServerEnabled,
    input: { ...VALID_CONTEXT, server: { id: 'server-a' }, enabled: false },
    expectedPayload: { ...VALID_CONTEXT, server: { id: 'server-a' }, enabled: false },
    invalidInput: { ...VALID_CONTEXT, server: { id: 'server-a' }, enabled: null },
    result: MUTATION_RESULT
  },
  {
    method: 'upsertMcpServer',
    channel: pluginCenterIpcChannels.upsertMcpServer,
    input: {
      ...VALID_CONTEXT,
      serverId: 'server-a',
      displayName: 'Server A',
      server: {
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        bearerTokenEnvVar: 'MCP_TOKEN',
        httpHeaders: [{ name: 'Authorization', value: { action: 'keep' } }],
        envHttpHeaders: [{ name: 'X-Workspace', envVarName: 'WORKSPACE_ID' }]
      }
    },
    expectedPayload: {
      ...VALID_CONTEXT,
      serverId: 'server-a',
      displayName: 'Server A',
      server: {
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        bearerTokenEnvVar: 'MCP_TOKEN',
        httpHeaders: [{ name: 'Authorization', value: { action: 'keep' } }],
        envHttpHeaders: [{ name: 'X-Workspace', envVarName: 'WORKSPACE_ID' }]
      }
    },
    invalidInput: {
      ...VALID_CONTEXT,
      server: { transport: 'stdio', command: '' }
    },
    result: MUTATION_RESULT
  },
  {
    method: 'removeMcpServer',
    channel: pluginCenterIpcChannels.removeMcpServer,
    input: { ...VALID_CONTEXT, server: { id: 'server-a' } },
    expectedPayload: { ...VALID_CONTEXT, server: { id: 'server-a' } },
    invalidInput: { ...VALID_CONTEXT, server: { id: '' } },
    result: MUTATION_RESULT
  }
]

describe('createPluginCenterBridge', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses the fixed plugin center channel map', () => {
    expect(pluginCenterIpcChannels).toEqual({
      getSnapshot: 'codex:plugin-center:get-snapshot',
      getInstalledPlugins: 'codex:plugin-center:get-installed-plugins',
      getPluginDetail: 'codex:plugin-center:get-plugin-detail',
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
  })

  it.each(cases)(
    'validates the $method request before invoking its fixed channel',
    async ({ method, channel, input, expectedPayload, result }) => {
      const invoke = vi.fn(async () => result)
      const bridge = createPluginCenterBridge(invoke)

      await expect(bridge[method](input as never)).resolves.toEqual(result)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith(channel, expectedPayload)
    }
  )

  it.each(cases)(
    'rejects an invalid $method request before invoking ipcRenderer',
    ({ method, invalidInput }) => {
      const invoke = vi.fn(async () => MUTATION_RESULT)
      const bridge = createPluginCenterBridge(invoke)

      expect(() => bridge[method](invalidInput as never)).toThrow()
      expect(invoke).not.toHaveBeenCalled()
    }
  )

  it.each(cases)(
    'rejects an invalid $method result from ipcRenderer',
    async ({ method, input }) => {
      const invoke = vi.fn(async () => ({ version: PLUGIN_CENTER_API_VERSION }))
      const bridge = createPluginCenterBridge(invoke)

      await expect(bridge[method](input as never)).rejects.toThrow()
      expect(invoke).toHaveBeenCalledTimes(1)
    }
  )

  it.each(cases)('propagates $method invoke errors', async ({ method, input }) => {
    const error = new Error(`${method} failed`)
    const invoke = vi.fn(async () => {
      throw error
    })
    const bridge = createPluginCenterBridge(invoke)

    await expect(bridge[method](input as never)).rejects.toBe(error)
  })
})
