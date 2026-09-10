import { EventEmitter } from 'node:events'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PLUGIN_CENTER_API_VERSION } from '../../shared/pluginCenterApi'
import {
  createPluginCenterCancelRequestHandler,
  createPluginCenterIpcHandlers,
  getPluginCenterIpcLifecycleDiagnostics,
  pluginCenterIpcChannels,
  resetPluginCenterIpcLifecycleForTests
} from './registerPluginCenterIpc'

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

const REQUEST_ID = 'request-0000000001'

type ServiceMethod =
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
    channel: pluginCenterIpcChannels.getSkillContents,
    method: 'getSkillContents',
    validPayload: {
      ...VALID_CONTEXT,
      plugin: { id: 'plugin-a', marketplaceId: 'market-main' },
      skill: { id: 'plugin:plugin-a:skill-a', name: 'skill-a' }
    },
    expectedPayload: {
      ...VALID_CONTEXT,
      plugin: { id: 'plugin-a', marketplaceId: 'market-main' },
      skill: { id: 'plugin:plugin-a:skill-a', name: 'skill-a' }
    },
    invalidPayload: {
      ...VALID_CONTEXT,
      plugin: { id: 'plugin-a' },
      skill: { id: 'skill-a', name: 'skill-a', path: '/private/SKILL.md' }
    },
    validResult: SKILL_CONTENTS_RESULT
  },
  {
    channel: pluginCenterIpcChannels.getRecommendedSkills,
    method: 'getRecommendedSkills',
    validPayload: { ...VALID_CONTEXT, forceRefresh: true },
    expectedPayload: { ...VALID_CONTEXT, forceRefresh: true },
    invalidPayload: { ...VALID_CONTEXT, forceRefresh: 'true' },
    validResult: RECOMMENDED_SKILLS_RESULT
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
    channel: pluginCenterIpcChannels.installRecommendedSkill,
    method: 'installRecommendedSkill',
    validPayload: { ...VALID_CONTEXT, id: 'writer', repoPath: 'skills/.curated/writer' },
    expectedPayload: { ...VALID_CONTEXT, id: 'writer', repoPath: 'skills/.curated/writer' },
    invalidPayload: { ...VALID_CONTEXT, id: 'writer', repoPath: '../writer' },
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
    channel: pluginCenterIpcChannels.uninstallSkill,
    method: 'uninstallSkill',
    validPayload: { ...VALID_CONTEXT, skill: { id: '/skills/writer/SKILL.md', name: 'writer' } },
    expectedPayload: {
      ...VALID_CONTEXT,
      skill: { id: '/skills/writer/SKILL.md', name: 'writer' }
    },
    invalidPayload: { ...VALID_CONTEXT, skill: { id: '/skills/writer/SKILL.md' } },
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
    getSkillContents: vi.fn(async () => resultByMethod.getSkillContents ?? SKILL_CONTENTS_RESULT),
    getRecommendedSkills: vi.fn(
      async () => resultByMethod.getRecommendedSkills ?? RECOMMENDED_SKILLS_RESULT
    ),
    addMarketplace: vi.fn(async () => resultByMethod.addMarketplace ?? MARKETPLACE_RESULT),
    installPlugin: vi.fn(async () => resultByMethod.installPlugin ?? MUTATION_RESULT),
    installRecommendedSkill: vi.fn(
      async () => resultByMethod.installRecommendedSkill ?? MUTATION_RESULT
    ),
    uninstallPlugin: vi.fn(async () => resultByMethod.uninstallPlugin ?? MUTATION_RESULT),
    uninstallSkill: vi.fn(async () => resultByMethod.uninstallSkill ?? MUTATION_RESULT),
    setPluginEnabled: vi.fn(async () => resultByMethod.setPluginEnabled ?? MUTATION_RESULT),
    setSkillEnabled: vi.fn(async () => resultByMethod.setSkillEnabled ?? MUTATION_RESULT),
    setAppEnabled: vi.fn(async () => resultByMethod.setAppEnabled ?? MUTATION_RESULT),
    setMcpServerEnabled: vi.fn(async () => resultByMethod.setMcpServerEnabled ?? MUTATION_RESULT),
    upsertMcpServer: vi.fn(async () => resultByMethod.upsertMcpServer ?? MUTATION_RESULT),
    removeMcpServer: vi.fn(async () => resultByMethod.removeMcpServer ?? MUTATION_RESULT)
  }
}

function envelope(payload: unknown, requestId = REQUEST_ID): unknown {
  return { requestId, payload }
}

function createIpcEvent(webContentsId = 1): {
  sender: EventEmitter & { id: number; isDestroyed: () => boolean }
  emit: (event: 'destroyed' | 'render-process-gone') => void
} {
  const sender = new EventEmitter() as EventEmitter & {
    id: number
    isDestroyed: () => boolean
  }
  let destroyed = false
  sender.id = webContentsId
  sender.isDestroyed = () => destroyed
  return {
    sender,
    emit: (event) => {
      if (event === 'destroyed') destroyed = true
      sender.emit(event)
    }
  }
}

describe('createPluginCenterIpcHandlers', () => {
  beforeEach(() => {
    resetPluginCenterIpcLifecycleForTests()
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('exposes only the fixed plugin center channels', () => {
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

    const handlers = createPluginCenterIpcHandlers(createService() as never)
    expect(Object.keys(handlers).sort()).toEqual(
      Object.values(pluginCenterIpcChannels)
        .filter((channel) => channel !== pluginCenterIpcChannels.cancelRequest)
        .sort()
    )
  })

  it.each(cases)(
    'validates request and result boundaries for $method',
    async ({ channel, method, validPayload, expectedPayload, validResult }) => {
      const service = createService({ [method]: validResult })
      const handlers = createPluginCenterIpcHandlers(service as never)
      const event = createIpcEvent()

      const result = await handlers[channel](event, envelope(validPayload))

      expect(result).toEqual(validResult)
      expect(service[method]).toHaveBeenCalledTimes(1)
      expect(service[method]).toHaveBeenCalledWith(expectedPayload, {
        signal: expect.any(AbortSignal)
      })
      expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({ pending: 0, completed: 1 })
    }
  )

  it.each(cases)(
    'rejects an invalid $method request before calling the service',
    async ({ channel, method, invalidPayload }) => {
      const service = createService()
      const handlers = createPluginCenterIpcHandlers(service as never)

      await expect(handlers[channel](createIpcEvent(), envelope(invalidPayload))).rejects.toThrow()
      expect(service[method]).not.toHaveBeenCalled()
    }
  )

  it.each(cases)(
    'rejects an invalid $method result after the service returns',
    async ({ channel, method, validPayload }) => {
      const service = createService({ [method]: { version: PLUGIN_CENTER_API_VERSION } })
      const handlers = createPluginCenterIpcHandlers(service as never)

      await expect(handlers[channel](createIpcEvent(), envelope(validPayload))).rejects.toThrow()
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
        method === 'getAppTools' ||
        method === 'getSkillContents' ||
        method === 'getRecommendedSkills'
          ? '插件中心数据加载失败，请重试。'
          : '插件中心操作失败，请刷新后重试。'
      await expect(handlers[channel](createIpcEvent(), envelope(validPayload))).rejects.toThrow(
        expectedMessage
      )
      expect(console.error).toHaveBeenCalledWith('[plugin-center] IPC operation failed', {
        errorName: 'Error',
        errorType: 'error'
      })
      expect(console.error).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining(sensitiveDetail)
      )
    }
  )

  it('logs only redacted service error metadata at the IPC boundary', async () => {
    const service = createService()
    service.getSnapshot.mockRejectedValueOnce(
      new Error('failed with access-token-secret and /private/workspace')
    )
    const handlers = createPluginCenterIpcHandlers(service as never)

    await expect(
      handlers[pluginCenterIpcChannels.getSnapshot](createIpcEvent(), envelope(VALID_CONTEXT))
    ).rejects.toThrow('插件中心数据加载失败，请重试。')

    const output = JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls)
    expect(output).not.toContain('access-token-secret')
    expect(output).not.toContain('/private/workspace')
    expect(output).toContain('errorName')
  })

  it('rejects duplicate active request ids for the same webContents', async () => {
    const service = createService()
    const pending = new Promise<typeof SNAPSHOT_RESULT>(() => undefined)
    service.getSnapshot.mockReturnValueOnce(pending)
    const handlers = createPluginCenterIpcHandlers(service as never)
    const event = createIpcEvent(7)

    const first = handlers[pluginCenterIpcChannels.getSnapshot](event, envelope(VALID_CONTEXT))
    await Promise.resolve()

    await expect(
      handlers[pluginCenterIpcChannels.getSnapshot](event, envelope(VALID_CONTEXT))
    ).rejects.toThrow('插件中心请求重复，请重试。')
    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({
      pending: 1,
      duplicateRequests: 1
    })
    createPluginCenterCancelRequestHandler()(event, { requestId: REQUEST_ID })
    await expect(first).rejects.toThrow('插件中心请求已取消。')
    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({ pending: 0 })
  })

  it('cancels active requests by webContents id and request id', async () => {
    const service = createService()
    let observedSignal: AbortSignal | undefined
    service.getSnapshot.mockImplementationOnce(
      async (_input: unknown, context?: { signal: AbortSignal }) => {
        observedSignal = context?.signal
        return new Promise<typeof SNAPSHOT_RESULT>(() => undefined)
      }
    )
    const handlers = createPluginCenterIpcHandlers(service as never)
    const event = createIpcEvent(3)

    const result = handlers[pluginCenterIpcChannels.getSnapshot](event, envelope(VALID_CONTEXT))
    await Promise.resolve()
    createPluginCenterCancelRequestHandler()(event, { requestId: REQUEST_ID })
    createPluginCenterCancelRequestHandler()(event, { requestId: REQUEST_ID })

    await expect(result).rejects.toThrow('插件中心请求已取消。')
    expect(observedSignal?.aborted).toBe(true)
    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({
      pending: 0,
      cancelled: 1,
      ignoredCancels: 1
    })
  })

  it('does not cancel a dispatched mutation from the cancel channel', async () => {
    const service = createService()
    let observedSignal: AbortSignal | undefined
    service.installPlugin.mockImplementationOnce(
      async (_input: unknown, context?: { signal: AbortSignal }) => {
        observedSignal = context?.signal
        return MUTATION_RESULT
      }
    )
    const handlers = createPluginCenterIpcHandlers(service as never)
    const event = createIpcEvent(9)

    const result = handlers[pluginCenterIpcChannels.installPlugin](
      event,
      envelope({
        ...VALID_CONTEXT,
        plugin: { id: 'plugin-a', marketplaceId: 'market-main' }
      })
    )
    createPluginCenterCancelRequestHandler()(event, { requestId: REQUEST_ID })

    await expect(result).resolves.toEqual(MUTATION_RESULT)
    expect(observedSignal?.aborted).toBe(false)
    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({
      pending: 0,
      ignoredCancels: 1
    })
  })

  it('ignores cancel requests from other webContents', async () => {
    const service = createService()
    service.getSnapshot.mockReturnValueOnce(new Promise(() => undefined))
    const handlers = createPluginCenterIpcHandlers(service as never)
    const ownerEvent = createIpcEvent(11)
    const otherEvent = createIpcEvent(12)

    const result = handlers[pluginCenterIpcChannels.getSnapshot](
      ownerEvent,
      envelope(VALID_CONTEXT)
    )
    await Promise.resolve()
    createPluginCenterCancelRequestHandler()(otherEvent, { requestId: REQUEST_ID })

    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({
      pending: 1,
      ignoredCancels: 1
    })
    createPluginCenterCancelRequestHandler()(ownerEvent, { requestId: REQUEST_ID })
    await expect(result).rejects.toThrow('插件中心请求已取消。')
  })

  it('aborts and unregisters active requests when the webContents is destroyed', async () => {
    const service = createService()
    let observedSignal: AbortSignal | undefined
    service.getSnapshot.mockImplementationOnce(
      async (_input: unknown, context?: { signal: AbortSignal }) => {
        observedSignal = context?.signal
        return new Promise<typeof SNAPSHOT_RESULT>(() => undefined)
      }
    )
    const handlers = createPluginCenterIpcHandlers(service as never)
    const event = createIpcEvent(5)

    const result = handlers[pluginCenterIpcChannels.getSnapshot](event, envelope(VALID_CONTEXT))
    await Promise.resolve()
    event.emit('destroyed')

    await expect(result).rejects.toThrow('插件中心请求已取消。')
    expect(observedSignal?.aborted).toBe(true)
    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({
      pending: 0,
      windowAborted: 1
    })
  })

  it('aborts and unregisters active requests when the render process exits', async () => {
    const service = createService()
    service.getSnapshot.mockReturnValueOnce(new Promise(() => undefined))
    const handlers = createPluginCenterIpcHandlers(service as never)
    const event = createIpcEvent(6)

    const result = handlers[pluginCenterIpcChannels.getSnapshot](event, envelope(VALID_CONTEXT))
    await Promise.resolve()
    event.emit('render-process-gone')

    await expect(result).rejects.toThrow('插件中心请求已取消。')
    expect(getPluginCenterIpcLifecycleDiagnostics()).toMatchObject({
      pending: 0,
      windowAborted: 1
    })
  })
})
