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

const SKILL_CONTENTS_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  status: 'ready',
  plugin: { id: 'plugin-a', marketplaceId: 'market-main' },
  skill: { id: 'plugin:plugin-a:skill-a', name: 'skill-a' },
  contents: '# Skill A',
  localPath: '/trusted/skill-a/SKILL.md'
} as const

const RECOMMENDED_SKILLS_RESULT = {
  version: PLUGIN_CENTER_API_VERSION,
  fetchedAt: '2026-08-30T00:00:00.000Z',
  source: 'cache',
  skills: [
    {
      id: 'writer',
      name: 'Writer',
      description: 'Write docs',
      repoPath: 'skills/.curated/writer'
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

type BridgeMethod =
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

type Case = {
  method: BridgeMethod
  channel: (typeof pluginCenterIpcChannels)[keyof typeof pluginCenterIpcChannels]
  input: unknown
  expectedPayload: unknown
  invalidInput: unknown
  result: unknown
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
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
    method: 'getAppTools',
    channel: pluginCenterIpcChannels.getAppTools,
    input: { ...VALID_CONTEXT, threadId: 'thread-a', app: { id: 'app-a' } },
    expectedPayload: { ...VALID_CONTEXT, threadId: 'thread-a', app: { id: 'app-a' } },
    invalidInput: { ...VALID_CONTEXT, app: { id: 'app-a' }, includeTools: true },
    result: APP_TOOLS_RESULT
  },
  {
    method: 'getSkillContents',
    channel: pluginCenterIpcChannels.getSkillContents,
    input: {
      ...VALID_CONTEXT,
      plugin: { id: 'plugin-a', marketplaceId: 'market-main' },
      skill: { id: 'plugin:plugin-a:skill-a', name: 'skill-a' }
    },
    expectedPayload: {
      ...VALID_CONTEXT,
      plugin: { id: 'plugin-a', marketplaceId: 'market-main' },
      skill: { id: 'plugin:plugin-a:skill-a', name: 'skill-a' }
    },
    invalidInput: {
      ...VALID_CONTEXT,
      plugin: { id: 'plugin-a' },
      skill: { id: 'skill-a', name: 'skill-a', path: '/private/SKILL.md' }
    },
    result: SKILL_CONTENTS_RESULT
  },
  {
    method: 'getRecommendedSkills',
    channel: pluginCenterIpcChannels.getRecommendedSkills,
    input: { ...VALID_CONTEXT, forceRefresh: true },
    expectedPayload: { ...VALID_CONTEXT, forceRefresh: true },
    invalidInput: { ...VALID_CONTEXT, forceRefresh: 'true' },
    result: RECOMMENDED_SKILLS_RESULT
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
    method: 'installRecommendedSkill',
    channel: pluginCenterIpcChannels.installRecommendedSkill,
    input: { ...VALID_CONTEXT, id: 'writer', repoPath: 'skills/.curated/writer' },
    expectedPayload: { ...VALID_CONTEXT, id: 'writer', repoPath: 'skills/.curated/writer' },
    invalidInput: { ...VALID_CONTEXT, id: 'writer', repoPath: '../writer' },
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
    method: 'uninstallSkill',
    channel: pluginCenterIpcChannels.uninstallSkill,
    input: { ...VALID_CONTEXT, skill: { id: '/skills/writer/SKILL.md', name: 'writer' } },
    expectedPayload: {
      ...VALID_CONTEXT,
      skill: { id: '/skills/writer/SKILL.md', name: 'writer' }
    },
    invalidInput: { ...VALID_CONTEXT, skill: { id: '/skills/writer/SKILL.md' } },
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
      getAppTools: 'codex:plugin-center:get-app-tools',
      getSkillContents: 'codex:plugin-center:get-skill-contents',
      getRecommendedSkills: 'codex:plugin-center:get-recommended-skills',
      addMarketplace: 'codex:plugin-center:add-marketplace',
      installPlugin: 'codex:plugin-center:install-plugin',
      installRecommendedSkill: 'codex:plugin-center:install-recommended-skill',
      uninstallPlugin: 'codex:plugin-center:uninstall-plugin',
      uninstallSkill: 'codex:plugin-center:uninstall-skill',
      setPluginEnabled: 'codex:plugin-center:set-plugin-enabled',
      setSkillEnabled: 'codex:plugin-center:set-skill-enabled',
      setAppEnabled: 'codex:plugin-center:set-app-enabled',
      setMcpServerEnabled: 'codex:plugin-center:set-mcp-server-enabled',
      upsertMcpServer: 'codex:plugin-center:upsert-mcp-server',
      removeMcpServer: 'codex:plugin-center:remove-mcp-server',
      cancelRequest: 'codex:plugin-center:cancel-request'
    })
  })

  it.each(cases)(
    'validates the $method request before invoking its fixed channel',
    async ({ method, channel, input, expectedPayload, result }) => {
      const invoke = vi.fn(async () => result)
      const bridge = createPluginCenterBridge(invoke)

      await expect(bridge[method](input as never)).resolves.toEqual(result)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(invoke).toHaveBeenCalledWith(channel, {
        requestId: expect.any(String),
        payload: expectedPayload
      })
    }
  )

  it.each(cases)(
    'rejects an invalid $method request before invoking ipcRenderer',
    async ({ method, invalidInput }) => {
      const invoke = vi.fn(async () => MUTATION_RESULT)
      const bridge = createPluginCenterBridge(invoke)

      await expect(bridge[method](invalidInput as never)).rejects.toThrow()
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

  it('sends a single cancel message for an aborted in-flight request', async () => {
    const pending = deferred<typeof SNAPSHOT_RESULT>()
    let capturedPayload: unknown
    const invoke = vi.fn(async (_channel: string, payload: unknown) => {
      capturedPayload = payload
      return pending.promise
    })
    const send = vi.fn()
    const bridge = createPluginCenterBridge(invoke, send)
    const controller = new AbortController()

    const promise = bridge.getSnapshot(VALID_CONTEXT, { signal: controller.signal })
    await Promise.resolve()
    const envelope = capturedPayload as { requestId: string }

    controller.abort()
    controller.abort()
    pending.resolve(SNAPSHOT_RESULT)

    await expect(promise).resolves.toEqual(SNAPSHOT_RESULT)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(pluginCenterIpcChannels.cancelRequest, {
      requestId: envelope.requestId
    })
  })

  it('uses the renderer request id and tolerates a context-bridge-cloned signal', async () => {
    const invoke = vi.fn(async () => SNAPSHOT_RESULT)
    const send = vi.fn()
    const bridge = createPluginCenterBridge(invoke, send)
    const requestId = 'renderer-request-id-1234'

    await expect(
      bridge.getSnapshot(VALID_CONTEXT, {
        requestId,
        signal: {} as AbortSignal
      })
    ).resolves.toEqual(SNAPSHOT_RESULT)

    expect(invoke).toHaveBeenCalledWith(pluginCenterIpcChannels.getSnapshot, {
      requestId,
      payload: VALID_CONTEXT
    })
    bridge.cancelRequest(requestId)
    expect(send).toHaveBeenCalledWith(pluginCenterIpcChannels.cancelRequest, { requestId })
  })

  it('does not cancel a mutation after it has been dispatched', async () => {
    const pending = deferred<typeof MUTATION_RESULT>()
    const invoke = vi.fn(async () => pending.promise)
    const send = vi.fn()
    const bridge = createPluginCenterBridge(invoke, send)
    const controller = new AbortController()

    const promise = bridge.installPlugin(
      { ...VALID_CONTEXT, plugin: { id: 'plugin-a', marketplaceId: 'market-main' } },
      { signal: controller.signal }
    )
    await Promise.resolve()
    controller.abort()
    pending.resolve(MUTATION_RESULT)

    await expect(promise).resolves.toEqual(MUTATION_RESULT)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('does not invoke ipcRenderer when the signal is already aborted', async () => {
    const invoke = vi.fn(async () => SNAPSHOT_RESULT)
    const send = vi.fn()
    const bridge = createPluginCenterBridge(invoke, send)
    const controller = new AbortController()
    controller.abort()

    await expect(bridge.getSnapshot(VALID_CONTEXT, { signal: controller.signal })).rejects.toThrow(
      'Plugin Center request was cancelled'
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
