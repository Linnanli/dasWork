import { describe, expect, it, vi } from 'vitest'

import {
  PLUGIN_CENTER_API_VERSION,
  PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH
} from '../../shared/pluginCenterApi'
import { PluginCenterService, type PluginCenterProvider } from './PluginCenterService'

function createProvider(overrides: Partial<PluginCenterProvider> = {}): PluginCenterProvider {
  const mcpConfig = {
    config: {
      mcp_servers: {
        local: {
          command: 'npx',
          args: ['-y', 'server'],
          env: { API_KEY: 'secret-value' },
          env_vars: [{ name: 'REMOTE_TOKEN', source: 'remote' }, 'PATH'],
          enabled: true,
          tool_timeout_sec: 30
        },
        inherited: { url: 'https://mcp.example.test', enabled: false }
      }
    },
    layers: [
      {
        name: { type: 'user', file: '/user/config.toml', profile: null },
        version: 'v1',
        config: {
          mcp_servers: {
            local: {
              command: 'npx',
              env: { API_KEY: 'secret-value' },
              env_vars: [{ name: 'REMOTE_TOKEN', source: 'remote' }, 'PATH'],
              enabled: true,
              tool_timeout_sec: 30
            }
          }
        },
        disabledReason: null
      }
    ],
    origins: {
      'mcp_servers."local"': {
        name: { type: 'user', file: '/user/config.toml', profile: null },
        version: 'v1'
      },
      'mcp_servers."inherited"': {
        name: { type: 'project', dotCodexFolder: '/repo/.codex' },
        version: 'v-project'
      }
    }
  }
  return {
    listPluginCatalog: vi.fn(async () => ({
      marketplaces: [
        {
          name: 'official',
          path: null,
          plugins: [
            {
              id: 'git@official',
              name: 'git',
              source: { type: 'local', path: '/plugins/git' },
              installed: true,
              enabled: true,
              installPolicy: 'AVAILABLE',
              availability: 'AVAILABLE',
              keywords: ['review'],
              version: '1.0.0',
              interface: {
                displayName: 'Git helpers',
                shortDescription: 'Review a repository',
                category: '开发',
                logoUrlDark: 'https://cdn.example.test/git-dark.png',
                logoUrl: 'https://cdn.example.test/git.png',
                logo: '/plugins/git/assets/logo.png'
              }
            }
          ]
        }
      ],
      featuredPluginIds: ['git@official'],
      marketplaceLoadErrors: []
    })),
    listInstalledPluginsForManagement: vi.fn(async () => ({
      marketplaces: [
        {
          name: 'official',
          path: null,
          plugins: [
            {
              id: 'git@official',
              name: 'git',
              source: { type: 'local', path: '/plugins/git' },
              installed: true,
              enabled: true,
              installPolicy: 'AVAILABLE',
              availability: 'AVAILABLE',
              keywords: ['review'],
              version: '1.0.0',
              interface: {
                displayName: 'Git helpers',
                shortDescription: 'Review a repository',
                category: '开发',
                logoUrlDark: 'https://cdn.example.test/git-dark.png',
                logoUrl: 'https://cdn.example.test/git.png',
                logo: '/plugins/git/assets/logo.png'
              }
            }
          ]
        }
      ],
      featuredPluginIds: ['git@official'],
      marketplaceLoadErrors: []
    })),
    readPluginDetailsForManagement: vi.fn(async () => [
      {
        summary: {
          id: 'git@official',
          name: 'git',
          enabled: true,
          interface: { displayName: 'Git helpers' }
        },
        skills: [{ name: 'review', description: 'Review code', enabled: true }],
        apps: [{ id: 'github', name: 'GitHub' }],
        mcpServers: ['plugin-server']
      }
    ]),
    listSkillsForManagement: vi.fn(async () => [
      {
        name: 'writer',
        description: 'Write docs',
        path: '/skills/writer/SKILL.md',
        scope: 'user',
        enabled: false
      }
    ]),
    listAppsForManagement: vi.fn(async () => [
      {
        id: 'github',
        name: 'GitHub',
        description: 'Connected app',
        logoUrl: null,
        logoUrlDark: null,
        isEnabled: true,
        isAccessible: false,
        pluginDisplayNames: ['Git helpers'],
        installUrl: 'https://github.com/apps/example'
      }
    ]),
    readMcpManagementSnapshot: vi.fn(async () => ({
      config: mcpConfig,
      servers: [
        { name: 'local', connected: true, authStatus: 'unsupported', toolCount: 2 },
        { name: 'plugin-server', connected: false, authStatus: 'oAuth', toolCount: 1 }
      ],
      pluginDetails: [
        {
          summary: {
            id: 'git@official',
            name: 'git',
            enabled: true,
            interface: { displayName: 'Git helpers' }
          },
          mcpServers: ['plugin-server']
        }
      ]
    })),
    installPlugin: vi.fn(async () => ({})),
    uninstallPlugin: vi.fn(async () => ({})),
    setPluginEnabled: vi.fn(async () => ({ response: { status: 'ok' } })),
    setSkillEnabled: vi.fn(async () => ({})),
    setAppEnabled: vi.fn(async () => ({ response: { status: 'ok' } })),
    setMcpServerEnabled: vi.fn(async () => ({ response: { status: 'ok' } })),
    upsertMcpServer: vi.fn(async () => ({ response: { status: 'ok' } })),
    removeMcpServer: vi.fn(async () => ({ response: { status: 'ok' } })),
    addMarketplace: vi.fn(async () => ({ marketplaceName: 'added', alreadyAdded: false })),
    ...overrides
  }
}

describe('PluginCenterService', () => {
  it('maps raw catalog/config data without returning MCP secret values', async () => {
    const service = new PluginCenterService({
      provider: createProvider(),
      defaultCwd: () => '/repo',
      now: () => new Date('2026-08-24T00:00:00.000Z')
    })

    const result = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.snapshot.plugins).toMatchObject([
      { id: 'git@official', displayName: 'Git helpers', featured: true, sourceKind: 'local' }
    ])
    expect(result.snapshot.skills).toContainEqual(
      expect.objectContaining({ id: '/skills/writer/SKILL.md', enabled: false })
    )
    expect(result.snapshot.apps).toMatchObject([{ id: 'github', accessible: false }])
    expect(result.snapshot.apps[0]?.restriction).toBeUndefined()
    expect(result.snapshot.mcp.userServers).toMatchObject([
      {
        id: 'local',
        transport: 'stdio',
        connected: true,
        editable: true,
        env: [{ name: 'API_KEY', hasValue: true }],
        envVars: [
          { name: 'REMOTE_TOKEN', source: 'remote', editable: false },
          { name: 'PATH', source: 'local', editable: true }
        ]
      },
      { id: 'inherited', transport: 'streamable-http', editable: false, origin: 'project' }
    ])
    expect(JSON.stringify(result.snapshot)).not.toContain('secret-value')
    expect(result.snapshot.plugins[0]).toMatchObject({
      skillCount: 1,
      appCount: 1,
      mcpServerCount: 1,
      icon: { kind: 'url', value: 'app://fs/@fs/plugins/git/assets/logo.png' }
    })
    expect(result.snapshot.skills).toContainEqual(
      expect.objectContaining({
        id: 'plugin:git@official:review',
        recommended: true,
        pluginId: 'git@official'
      })
    )
    expect(result.snapshot.mcp.pluginServers).toMatchObject([
      { id: 'plugin-server', pluginId: 'git@official', editable: false }
    ])
  })

  it('bounds remote display text before validating the renderer snapshot', async () => {
    const service = new PluginCenterService({
      provider: createProvider({
        listSkillsForManagement: vi.fn(async () => [
          {
            name: 'long-skill',
            description: 's'.repeat(610),
            path: '/skills/long-skill/SKILL.md',
            scope: 'user',
            enabled: true
          }
        ]),
        listAppsForManagement: vi.fn(async () => [
          {
            id: 'long-app',
            name: 'Long app',
            description: 'a'.repeat(552),
            isEnabled: true,
            isAccessible: true,
            pluginDisplayNames: []
          }
        ])
      }),
      defaultCwd: () => '/repo'
    })

    const result = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.snapshot.skills[0]?.description).toHaveLength(
      PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH
    )
    expect(result.snapshot.apps[0]?.description).toHaveLength(PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH)
  })

  it('returns one plugin when the catalog repeats the same plugin id', async () => {
    const duplicatePlugin = {
      id: 'no-ai-slop@openai-curated-remote',
      name: 'no-ai-slop',
      source: { type: 'remote' },
      installed: false,
      enabled: false,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      interface: { displayName: 'No AI Slop' }
    }
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          { name: 'openai-curated-remote', plugins: [duplicatePlugin] },
          {
            name: 'openai-curated-remote',
            plugins: [{ ...duplicatePlugin, installed: true, enabled: true }]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'openai-curated-remote',
            plugins: [{ ...duplicatePlugin, installed: true, enabled: true }]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      readPluginDetailsForManagement: vi.fn(async () => [])
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.snapshot.plugins).toHaveLength(1)
    expect(result.snapshot.plugins[0]).toMatchObject({
      id: 'no-ai-slop@openai-curated-remote',
      installed: true,
      enabled: true
    })
  })

  it('ignores plugins from the legacy openai-curated marketplace', async () => {
    const currentGithub = {
      id: 'github@openai-curated-remote',
      name: 'github',
      source: { type: 'remote' },
      installed: false,
      enabled: false,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      interface: { displayName: 'GitHub' }
    }
    const legacyGithub = {
      ...currentGithub,
      id: 'github@openai-curated',
      source: { type: 'local', path: '/plugins/openai-curated/github' },
      installed: true,
      enabled: true
    }
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          { name: 'openai-curated', path: '/plugins/openai-curated', plugins: [legacyGithub] },
          { name: 'openai-curated-remote', path: null, plugins: [currentGithub] }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [
          { name: 'openai-curated', path: '/plugins/openai-curated', plugins: [legacyGithub] }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      readPluginDetailsForManagement: vi.fn(async () => []),
      readPluginDetailForManagement: vi.fn(async () => ({
        summary: currentGithub,
        skills: [],
        apps: [],
        mcpServers: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const snapshot = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })
    const installed = await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION })
    const currentDetail = await service.getPluginDetail({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: {
        id: 'github@openai-curated-remote',
        marketplaceId: 'openai-curated-remote'
      }
    })
    const legacyDetail = await service.getPluginDetail({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'github@openai-curated', marketplaceId: 'openai-curated' }
    })

    expect(snapshot.snapshot.plugins).toEqual([
      expect.objectContaining({
        id: 'github@openai-curated-remote',
        marketplaceId: 'openai-curated-remote',
        installed: false,
        enabled: false
      })
    ])
    expect(snapshot.snapshot.marketplaces.map((marketplace) => marketplace.id)).toEqual([
      'openai-curated-remote'
    ])
    expect(installed.plugins).toEqual([])
    expect(currentDetail).toMatchObject({
      status: 'ready',
      detail: {
        plugin: {
          id: 'github@openai-curated-remote',
          marketplaceId: 'openai-curated-remote'
        }
      }
    })
    expect(legacyDetail).toEqual({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'missing',
      missingReason: 'not_found'
    })
    expect(provider.readPluginDetailForManagement).toHaveBeenCalledTimes(1)
    expect(provider.readPluginDetailForManagement).toHaveBeenCalledWith({
      remoteMarketplaceName: 'openai-curated-remote',
      pluginName: 'github'
    })
  })

  it('rejects writes to MCP servers outside the user config layer', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.setMcpServerEnabled({
        version: PLUGIN_CENTER_API_VERSION,
        server: { id: 'inherited' },
        enabled: true
      })
    ).rejects.toThrow('Only user-configured MCP servers')
    expect(provider.setMcpServerEnabled).not.toHaveBeenCalled()
  })

  it('merges MCP edits with hidden fields and respects keep secret patches', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.upsertMcpServer({
      version: PLUGIN_CENTER_API_VERSION,
      serverId: 'local',
      server: {
        transport: 'stdio',
        command: 'node server.mjs',
        args: ['--watch'],
        env: [{ name: 'API_KEY', value: { action: 'keep' } }],
        envVars: ['PATH']
      }
    })

    expect(provider.upsertMcpServer).toHaveBeenCalledWith({
      cwd: '/repo',
      serverName: 'local',
      value: expect.objectContaining({
        command: 'node server.mjs',
        args: ['--watch'],
        env: { API_KEY: 'secret-value' },
        env_vars: [
          { name: 'REMOTE_TOKEN', source: 'remote' },
          { name: 'PATH', source: 'local' }
        ],
        tool_timeout_sec: 30
      })
    })
  })

  it('isolates unavailable plugin catalog while still returning other sections safely', async () => {
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => {
        throw new Error('raw provider failure with token=secret')
      }),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.snapshot.plugins).toEqual([])
    expect(result.snapshot.skills).toHaveLength(1)
    expect(result.snapshot.apps).toHaveLength(1)
    expect(result.snapshot.mcp.userServers).toHaveLength(2)
    expect(result.snapshot.capabilities?.plugins).toMatchObject({
      available: false,
      restriction: { code: 'error', message: '该数据源暂时不可用' }
    })
    expect(JSON.stringify(result.snapshot)).not.toContain('secret')
  })

  it('returns partial when write readback does not reach the requested state', async () => {
    const provider = createProvider({
      setPluginEnabled: vi.fn(async () => ({ response: { status: 'ok' } }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.setPluginEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official' },
      enabled: false
    })

    expect(result.status).toBe('partial')
    expect(result.message).toBe('写入已提交，但刷新后的状态与目标不一致')
  })

  it('reports overridden and MCP reload failure states without claiming success', async () => {
    const provider = createProvider({
      setPluginEnabled: vi.fn(async () => ({ response: { status: 'okOverridden' } })),
      setMcpServerEnabled: vi.fn(async () => ({
        response: { status: 'ok' },
        reloadStatus: 'failed'
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const overridden = await service.setPluginEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official' },
      enabled: false
    })
    const reloadFailed = await service.setMcpServerEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      server: { id: 'local' },
      enabled: false
    })

    expect(overridden).toMatchObject({
      status: 'overridden',
      message: '设置已被更高优先级的配置覆盖'
    })
    expect(reloadFailed).toMatchObject({
      status: 'partial',
      message: '配置已写入，但 MCP 运行时重载失败'
    })
  })

  it('uses no project cwd when no local workspace is available', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => undefined })

    await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(provider.listPluginCatalog).toHaveBeenCalledWith({
      cwd: undefined,
      forceRefetch: undefined
    })
    expect(provider.listSkillsForManagement).toHaveBeenCalledWith({
      cwd: undefined,
      forceReload: undefined
    })
  })

  it('keeps catalog-only recommended skills disabled until their plugin is installed', async () => {
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'official',
            plugins: [
              {
                id: 'suggested@official',
                name: 'suggested',
                source: { type: 'remote' },
                installed: false,
                enabled: false,
                availability: 'AVAILABLE',
                installPolicy: 'AVAILABLE',
                interface: { displayName: 'Suggested' }
              }
            ]
          }
        ],
        featuredPluginIds: ['suggested@official'],
        marketplaceLoadErrors: []
      })),
      readPluginDetailsForManagement: vi.fn(async () => [
        {
          summary: { id: 'suggested@official', name: 'suggested' },
          skills: [{ name: 'catalog-skill', enabled: true }],
          apps: [],
          mcpServers: []
        }
      ]),
      readMcpManagementSnapshot: vi.fn(async () => ({
        config: { config: {}, layers: [], origins: {} },
        servers: [],
        pluginDetails: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.snapshot.skills).toContainEqual(
      expect.objectContaining({
        id: 'plugin:suggested@official:catalog-skill',
        installed: false,
        enabled: false,
        recommended: true,
        canToggle: false,
        restriction: { code: 'unavailable', message: '请先安装所属插件' }
      })
    )
  })

  it('rejects plugin icons outside the local plugin root and insecure remote icons', async () => {
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'personal',
            plugins: [
              {
                id: 'local@personal',
                name: 'local',
                source: { type: 'local', path: '/plugins/local' },
                installed: true,
                enabled: true,
                interface: { logo: '/outside/private.png' }
              },
              {
                id: 'remote@personal',
                name: 'remote',
                source: { type: 'remote' },
                installed: false,
                enabled: false,
                interface: { logoUrl: 'http://example.test/logo.png' }
              }
            ]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      readPluginDetailsForManagement: vi.fn(async () => [])
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.snapshot.plugins).toHaveLength(2)
    expect(result.snapshot.plugins.every((plugin) => plugin.icon === undefined)).toBe(true)
  })

  it('caches ordinary plugin detail reads but always honors force refresh', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })
    await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION })
    expect(provider.readPluginDetailsForManagement).toHaveBeenCalledTimes(1)

    await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION, forceRefresh: true })
    await service.getSnapshot({ version: PLUGIN_CENTER_API_VERSION, forceRefresh: true })
    expect(provider.readPluginDetailsForManagement).toHaveBeenCalledTimes(3)
  })

  it('loads the plugin browse section without waiting for management-only catalogs', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })

    expect(result.snapshot.plugins).toHaveLength(1)
    expect(result.snapshot.skills).toHaveLength(0)
    expect(result.snapshot.apps).toHaveLength(0)
    expect(result.snapshot.mcp.userServers).toHaveLength(0)
    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(1)
    expect(provider.readPluginDetailsForManagement).not.toHaveBeenCalled()
    expect(provider.listSkillsForManagement).not.toHaveBeenCalled()
    expect(provider.listAppsForManagement).not.toHaveBeenCalled()
    expect(provider.readMcpManagementSnapshot).not.toHaveBeenCalled()
  })

  it('reuses the six-hour catalog cache for repeated plugin browse reads', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })
    await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })

    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(1)
    expect(provider.listInstalledPluginsForManagement!).toHaveBeenCalledTimes(1)
  })

  it('joins concurrent catalog reads into one provider request', async () => {
    const catalog = await createProvider().listPluginCatalog({ cwd: '/repo' })
    let resolveCatalog!: (value: unknown) => void
    const pendingCatalog = new Promise<unknown>((resolve) => {
      resolveCatalog = resolve
    })
    const provider = createProvider({
      listPluginCatalog: vi.fn(() => pendingCatalog)
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const first = service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })
    const second = service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins'],
      forceRefresh: true
    })

    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(1)
    resolveCatalog(catalog)
    await Promise.all([first, second])
    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(1)
  })

  it('limits installed-state cache entries to the three most recent cwd keys', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION, cwd: '/repo-a' })
    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION, cwd: '/repo-b' })
    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION, cwd: '/repo-c' })
    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION, cwd: '/repo-d' })
    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION, cwd: '/repo-a' })

    expect(provider.listInstalledPluginsForManagement!).toHaveBeenCalledTimes(5)
  })

  it('installs using the cached catalog locator and verifies only installed state', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })
    vi.mocked(provider.listPluginCatalog).mockClear()
    vi.mocked(provider.listInstalledPluginsForManagement!).mockClear()

    const result = await service.installPlugin({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official', marketplaceId: 'official' }
    })

    expect(provider.installPlugin).toHaveBeenCalledWith({
      remoteMarketplaceName: 'official',
      installAttemptId: expect.any(String),
      pluginName: 'git'
    })
    expect(provider.listPluginCatalog).not.toHaveBeenCalled()
    expect(provider.listInstalledPluginsForManagement).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      status: 'applied',
      changedItemId: 'git@official',
      changedSections: ['installed']
    })
    expect(result.snapshot).toBeUndefined()
  })

  it('keeps a fresh main-process catalog locator after the renderer gc window', async () => {
    let nowMs = 0
    const provider = createProvider()
    const service = new PluginCenterService({
      provider,
      defaultCwd: () => '/repo',
      nowMs: () => nowMs
    })

    await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })
    nowMs = 10 * 60 * 1_000
    vi.mocked(provider.listInstalledPluginsForManagement!).mockClear()

    await service.installPlugin({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official', marketplaceId: 'official' }
    })

    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(1)
    expect(provider.listInstalledPluginsForManagement!).toHaveBeenCalledTimes(1)
  })

  it('awaits a stale main-process catalog refresh before returning data', async () => {
    let nowMs = 0
    let pluginId = 'old@official'
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'official',
            path: null,
            plugins: [
              {
                id: pluginId,
                name: pluginId.replace('@official', ''),
                installed: false,
                enabled: false,
                installPolicy: 'AVAILABLE',
                availability: 'AVAILABLE',
                interface: { displayName: pluginId }
              }
            ]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      }))
    })
    const service = new PluginCenterService({
      provider,
      defaultCwd: () => '/repo',
      nowMs: () => nowMs
    })

    const first = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })
    pluginId = 'new@official'
    nowMs = 7 * 60 * 60 * 1_000
    const second = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })

    expect(first.snapshot.plugins.map((plugin) => plugin.id)).toEqual(['old@official'])
    expect(second.snapshot.plugins.map((plugin) => plugin.id)).toEqual(['new@official'])
    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(2)
  })

  it('keeps the last complete remote catalog when a refresh falls back to local marketplaces', async () => {
    const localPlugin = {
      id: 'latex@openai-bundled',
      name: 'latex',
      installed: false,
      enabled: false,
      availability: 'AVAILABLE',
      installPolicy: 'AVAILABLE',
      interface: { displayName: 'LaTeX', category: 'Education & Research' }
    }
    const remotePlugin = {
      ...localPlugin,
      id: 'remote@openai-curated-remote',
      name: 'remote',
      interface: { displayName: 'Remote plugin', category: 'Productivity' }
    }
    const recoveredPlugin = {
      ...remotePlugin,
      id: 'recovered@openai-curated-remote',
      name: 'recovered',
      interface: { displayName: 'Recovered plugin', category: 'Productivity' }
    }
    const completeCatalog = {
      marketplaces: [
        { name: 'openai-bundled', plugins: [localPlugin] },
        { name: 'openai-curated-remote', plugins: [remotePlugin] }
      ],
      featuredPluginIds: [],
      marketplaceLoadErrors: []
    }
    const degradedCatalog = {
      marketplaces: [{ name: 'openai-bundled', plugins: [localPlugin] }],
      featuredPluginIds: [],
      marketplaceLoadErrors: []
    }
    const recoveredCatalog = {
      marketplaces: [
        { name: 'openai-bundled', plugins: [localPlugin] },
        { name: 'openai-curated-remote', plugins: [recoveredPlugin] }
      ],
      featuredPluginIds: [],
      marketplaceLoadErrors: []
    }
    const provider = createProvider({
      listPluginCatalog: vi
        .fn()
        .mockResolvedValueOnce(completeCatalog)
        .mockResolvedValueOnce(degradedCatalog)
        .mockResolvedValueOnce(recoveredCatalog),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const complete = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })
    const fallback = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins'],
      forceRefresh: true
    })
    const recovered = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })

    expect(complete.snapshot.plugins.map((plugin) => plugin.id)).toEqual([
      'latex@openai-bundled',
      'remote@openai-curated-remote'
    ])
    expect(fallback.snapshot.plugins.map((plugin) => plugin.id)).toEqual([
      'latex@openai-bundled',
      'remote@openai-curated-remote'
    ])
    expect(fallback.snapshot.catalogUnavailableReason).toContain('最近一次成功加载的目录')
    expect(recovered.snapshot.plugins.map((plugin) => plugin.id)).toEqual([
      'latex@openai-bundled',
      'recovered@openai-curated-remote'
    ])
    expect(recovered.snapshot.catalogUnavailableReason).toBeUndefined()
    expect(provider.listPluginCatalog).toHaveBeenCalledTimes(3)
  })

  it('marks an initial local-only official catalog as degraded', async () => {
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'openai-primary-runtime',
            plugins: [
              {
                id: 'latex@openai-primary-runtime',
                name: 'latex',
                installed: false,
                enabled: false,
                availability: 'AVAILABLE',
                installPolicy: 'AVAILABLE',
                interface: { displayName: 'LaTeX', category: 'Education & Research' }
              }
            ]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins']
    })

    expect(result.snapshot.plugins.map((plugin) => plugin.id)).toEqual([
      'latex@openai-primary-runtime'
    ])
    expect(result.snapshot.catalogUnavailableReason).toContain('当前仅显示本地插件')
  })

  it('refreshes only the changed management section after skill, app, and MCP mutations', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const skill = await service.setSkillEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      skill: { id: '/skills/writer/SKILL.md' },
      enabled: true
    })
    expect(skill).toMatchObject({ changedSections: ['skills'] })
    expect(skill.snapshot).toBeUndefined()
    expect(provider.listPluginCatalog).not.toHaveBeenCalled()
    expect(provider.readPluginDetailsForManagement).not.toHaveBeenCalled()
    expect(provider.listAppsForManagement).not.toHaveBeenCalled()
    expect(provider.readMcpManagementSnapshot).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const app = await service.setAppEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      app: { id: 'github' },
      enabled: true
    })
    expect(app).toMatchObject({ changedSections: ['apps'] })
    expect(app.snapshot).toBeUndefined()
    expect(provider.listAppsForManagement).toHaveBeenCalledTimes(1)
    expect(provider.listPluginCatalog).not.toHaveBeenCalled()
    expect(provider.listSkillsForManagement).not.toHaveBeenCalled()
    expect(provider.readMcpManagementSnapshot).not.toHaveBeenCalled()

    vi.clearAllMocks()
    const mcp = await service.setMcpServerEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      server: { id: 'local' },
      enabled: false
    })
    expect(mcp).toMatchObject({ changedSections: ['mcp'] })
    expect(mcp.snapshot).toBeUndefined()
    expect(provider.readMcpManagementSnapshot).toHaveBeenCalledTimes(2)
    expect(provider.listPluginCatalog).not.toHaveBeenCalled()
    expect(provider.listSkillsForManagement).not.toHaveBeenCalled()
    expect(provider.listAppsForManagement).not.toHaveBeenCalled()
  })

  it('writes an unqualified plugin detail skill through its installed path', async () => {
    const skillPath = '/plugins/git/skills/review/SKILL.md'
    let enabled = true
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        { name: 'review', path: skillPath, scope: 'plugin', enabled }
      ]),
      setSkillEnabled: vi.fn(async (input) => {
        enabled = input.enabled
        return {}
      })
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.setSkillEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      skill: { id: skillPath },
      enabled: false
    })

    expect(provider.setSkillEnabled).toHaveBeenCalledWith({ path: skillPath, enabled: false })
    expect(result).toMatchObject({ status: 'applied', changedSections: ['skills'] })
  })

  it('writes a qualified plugin detail skill by name', async () => {
    const skillPath = '/plugins/git/skills/review/SKILL.md'
    let enabled = true
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        { name: 'git:review', path: skillPath, scope: 'plugin', enabled }
      ]),
      setSkillEnabled: vi.fn(async (input) => {
        enabled = input.enabled
        return {}
      })
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.setSkillEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      skill: { id: skillPath },
      enabled: false
    })

    expect(provider.setSkillEnabled).toHaveBeenCalledWith({ name: 'git:review', enabled: false })
    expect(result).toMatchObject({ status: 'applied', changedSections: ['skills'] })
  })

  it('does not wait for a post-write skill readback', async () => {
    const skillPath = '/skills/writer/SKILL.md'
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        { name: 'writer', path: skillPath, scope: 'user', enabled: true }
      ])
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.setSkillEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      skill: { id: skillPath },
      enabled: false
    })

    expect(result).toMatchObject({ status: 'applied', changedSections: ['skills'] })
    expect(provider.listSkillsForManagement).toHaveBeenCalledTimes(1)
  })

  it('does not synchronously refresh the full catalog after adding a marketplace', async () => {
    let releaseCatalog!: () => void
    const catalogStarted = vi.fn()
    const provider = createProvider({
      listPluginCatalog: vi.fn(
        () =>
          new Promise((resolve) => {
            catalogStarted()
            releaseCatalog = () =>
              resolve({
                marketplaces: [],
                featuredPluginIds: [],
                marketplaceLoadErrors: []
              })
          })
      )
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.addMarketplace({
      version: PLUGIN_CENTER_API_VERSION,
      source: 'owner/repo',
      sparsePaths: []
    })

    expect(result).toMatchObject({
      status: 'applied',
      changedSections: ['catalog', 'installed']
    })
    expect(result.snapshot).toBeUndefined()
    expect(catalogStarted).toHaveBeenCalledTimes(1)
    releaseCatalog()
  })

  it('logs the plugin browse request and plugin/list duration without request contents', async () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> = []
    const ticks = [100, 110, 160, 170, 170, 170, 180]
    const service = new PluginCenterService({
      provider: createProvider(),
      defaultCwd: () => '/repo',
      nowMs: () => ticks.shift() ?? 170,
      logger: (event, details) => events.push({ event, details })
    })

    await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins'],
      threadId: 'thread-secret'
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'snapshot:start',
        details: expect.objectContaining({
          requestId: 1,
          sections: 'plugins',
          includePluginDetails: false,
          forceRefresh: false,
          hasCwd: true,
          hasThreadId: true
        })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'cache:miss',
        details: expect.objectContaining({
          requestId: 1,
          kind: 'catalog',
          key: 'cwd:5',
          cacheStatus: 'miss',
          providerCallCount: 1
        })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'snapshot:section',
        details: expect.objectContaining({
          requestId: 1,
          name: 'plugin/list',
          status: 'ok'
        })
      })
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'snapshot:complete',
        details: expect.objectContaining({
          requestId: 1,
          pluginCount: 1,
          skillCount: 0,
          appCount: 0,
          mcpServerCount: 0
        })
      })
    )
    expect(JSON.stringify(events)).not.toContain('/repo')
    expect(JSON.stringify(events)).not.toContain('thread-secret')
  })

  it('does not include raw mutation item identifiers in performance logs', async () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> = []
    const service = new PluginCenterService({
      provider: createProvider(),
      defaultCwd: () => '/repo',
      logger: (event, details) => events.push({ event, details })
    })

    await service.setSkillEnabled({
      version: PLUGIN_CENTER_API_VERSION,
      skill: { id: '/skills/writer/SKILL.md' },
      enabled: true
    })

    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'mutation:write',
        details: expect.objectContaining({ hasChangedItemId: true, changedSections: 'skills' })
      })
    )
    expect(JSON.stringify(events)).not.toContain('/skills/writer/SKILL.md')
  })

  it('can enrich the plugin browse section with plugin details on demand', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins'],
      includePluginDetails: true
    })

    expect(provider.readPluginDetailsForManagement).toHaveBeenCalledTimes(1)
    expect(result.snapshot.plugins[0]).toMatchObject({
      skillCount: 1,
      appCount: 1,
      mcpServerCount: 1
    })
  })

  it('rejects user MCP edits when a higher config layer owns the effective server', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.upsertMcpServer({
        version: PLUGIN_CENTER_API_VERSION,
        serverId: 'inherited',
        server: {
          transport: 'streamable-http',
          url: 'https://mcp.example.test',
          httpHeaders: [],
          envHttpHeaders: []
        }
      })
    ).rejects.toThrow('Only user-configured MCP servers')
    expect(provider.upsertMcpServer).not.toHaveBeenCalled()
  })

  it('does not permit an existing MCP server to change transport', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.upsertMcpServer({
        version: PLUGIN_CENTER_API_VERSION,
        serverId: 'local',
        server: {
          transport: 'streamable-http',
          url: 'https://mcp.example.test',
          httpHeaders: [],
          envHttpHeaders: []
        }
      })
    ).rejects.toThrow('Existing MCP server transport cannot be changed')

    expect(provider.upsertMcpServer).not.toHaveBeenCalled()
  })

  it('reads and projects a single safe plugin detail without batch detail reads', async () => {
    const provider = createProvider({
      readAppsForManagement: vi.fn(async () => [
        {
          id: 'github',
          name: 'GitHub from app/read',
          description: 'Find and reference emails from your inbox.',
          iconUrl: 'https://cdn.example.test/github-read.png',
          iconUrlDark: 'https://cdn.example.test/github-read-dark.png',
          installUrl: 'https://github.com/apps/read-example'
        }
      ]),
      listAppsForManagement: vi.fn(async () => [
        {
          id: 'github',
          name: 'GitHub',
          description: 'Directory state returned by app/list.',
          logoUrl: 'https://cdn.example.test/github.png',
          logoUrlDark: 'https://cdn.example.test/github-dark.png',
          installUrl: 'https://github.com/apps/example',
          isEnabled: false,
          isAccessible: true
        }
      ]),
      listSkillsForManagement: vi.fn(async () => [
        {
          name: 'git:review',
          path: '/plugins/git/skills/review/SKILL.md',
          description: 'Installed skill description',
          enabled: false,
          interface: { displayName: 'Installed review', shortDescription: 'Installed skill state' }
        }
      ]),
      readPluginDetailForManagement: vi.fn(async () => ({
        summary: {
          id: 'git@official',
          name: 'git',
          localVersion: '2.0.0',
          installed: false,
          enabled: true,
          source: { type: 'local', path: '/plugins/git' },
          interface: {
            displayName: 'Git helpers',
            shortDescription: 'Review a repository',
            longDescription: 'A long safe description',
            developerName: 'dasCowork',
            category: '开发',
            capabilities: ['Review', 'Review'],
            defaultPrompt: ['Review this repository'],
            brandColor: '#123456',
            screenshotUrls: ['https://cdn.example.test/screenshot.png'],
            websiteUrl: 'https://example.test',
            privacyPolicyUrl: 'javascript:alert(1)',
            termsOfServiceUrl: 'https://example.test/terms'
          }
        },
        description: 'Fallback description',
        skills: [
          {
            name: 'review',
            path: '/plugins/git/skills/review/SKILL.md',
            description: 'Long skill description',
            short_description: 'Legacy short skill description',
            shortDescription: 'Short skill description',
            enabled: true,
            interface: {
              iconSmall: 'icons/review.svg',
              shortDescription: 'Review a repository before merging changes'
            }
          }
        ],
        apps: [
          {
            id: 'github',
            name: 'GitHub',
            description: 'Use GitHub to inspect and improve repositories in detail.',
            installUrl: 'https://github.com/apps/example'
          },
          {
            id: 'fallback-app',
            name: 'Fallback app',
            shortDescription: '',
            description: 'Use the fallback application description.'
          }
        ],
        mcpServers: ['git-mcp']
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getPluginDetail({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official', marketplaceId: 'official' }
    })

    expect(result).toMatchObject({
      status: 'ready',
      detail: {
        mention: { path: 'plugin://git@official', name: 'git' },
        longDescription: 'A long safe description',
        capabilities: ['Review'],
        defaultPrompts: ['Review this repository'],
        brandColor: '#123456',
        screenshots: ['https://cdn.example.test/screenshot.png'],
        plugin: {
          author: 'dasCowork',
          versionLabel: '2.0.0',
          installed: true,
          enabled: true
        },
        apps: [
          expect.objectContaining({
            id: 'github',
            name: 'GitHub from app/read',
            description: 'Find and reference emails from your inbox.',
            installUrl: 'https://github.com/apps/read-example',
            icon: { kind: 'url', value: 'https://cdn.example.test/github-read-dark.png' },
            enabled: false,
            accessible: true,
            canToggle: true
          }),
          expect.objectContaining({
            id: 'fallback-app',
            name: 'Fallback app',
            description: 'Use the fallback application description.',
            enabled: false,
            accessible: false,
            canToggle: false
          })
        ],
        skills: [
          expect.objectContaining({
            id: '/plugins/git/skills/review/SKILL.md',
            name: 'git:review',
            displayName: 'Installed review',
            description: 'Installed skill state',
            enabled: false,
            canToggle: true,
            icon: expect.objectContaining({
              kind: 'url',
              value: expect.stringContaining('/plugins/git/icons/review.svg')
            })
          })
        ],
        mcpServers: ['git-mcp']
      }
    })
    expect(result.status === 'ready' && result.detail.privacyPolicyUrl).toBeUndefined()
    expect(result.status === 'ready' && result.detail.apps).toHaveLength(2)
    expect(provider.readPluginDetailForManagement).toHaveBeenCalledWith({
      remoteMarketplaceName: 'official',
      pluginName: 'git'
    })
    expect(provider.listAppsForManagement).toHaveBeenCalledWith({ forceRefetch: undefined })
    expect(provider.readAppsForManagement).toHaveBeenCalledWith({
      appIds: ['github', 'fallback-app']
    })
    expect(provider.listSkillsForManagement).toHaveBeenCalledWith({
      cwd: '/repo',
      forceReload: undefined
    })
    expect(provider.readPluginDetailsForManagement).not.toHaveBeenCalled()
  })

  it('uses plugin/read descriptions when app/read is unsupported without using app/list', async () => {
    const provider = createProvider({
      readAppsForManagement: vi.fn(async () => {
        throw new Error('app/read is unsupported')
      }),
      listAppsForManagement: vi.fn(async () => [
        {
          id: 'github',
          name: 'GitHub fallback',
          description: 'Fallback metadata and state.',
          installUrl: 'https://example.test/connect-github',
          isEnabled: true,
          isAccessible: false
        }
      ]),
      listSkillsForManagement: vi.fn(async () => [
        {
          name: 'git:review-skill',
          path: '/installed/review-skill/SKILL.md',
          description: 'Installed normalized skill',
          enabled: false
        }
      ]),
      readPluginDetailForManagement: vi.fn(async () => ({
        summary: {
          id: 'git@official',
          name: 'git',
          installed: true,
          enabled: true,
          source: { type: 'local', path: '/plugins/git' },
          interface: { displayName: 'Git helpers' }
        },
        apps: [
          {
            id: 'github',
            name: 'Ignored plugin summary',
            description: 'Short description returned by plugin/read.'
          }
        ],
        skills: [{ name: 'Review Skill', description: 'Catalog skill', enabled: true }],
        mcpServers: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getPluginDetail({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official', marketplaceId: 'official' }
    })

    expect(result).toMatchObject({
      status: 'ready',
      detail: {
        apps: [
          {
            id: 'github',
            name: 'GitHub fallback',
            description: 'Short description returned by plugin/read.',
            installUrl: 'https://example.test/connect-github',
            enabled: true,
            accessible: false,
            canToggle: true
          }
        ],
        skills: [
          {
            id: '/installed/review-skill/SKILL.md',
            name: 'git:review-skill',
            description: 'Installed normalized skill',
            enabled: false,
            canToggle: true
          }
        ]
      }
    })
    expect(
      result.status === 'ready' ? result.detail.apps[0]?.restriction : undefined
    ).toBeUndefined()
    expect(result.status === 'ready' ? result.detail.apps[0]?.description : undefined).toBe(
      'Short description returned by plugin/read.'
    )
  })

  it('does not select an arbitrary marketplace when an unscoped plugin id is ambiguous', async () => {
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'one',
            path: null,
            plugins: [{ id: 'duplicate', name: 'one-plugin', source: { type: 'remote' } }]
          },
          {
            name: 'two',
            path: null,
            plugins: [{ id: 'duplicate', name: 'two-plugin', source: { type: 'remote' } }]
          }
        ]
      })),
      readPluginDetailForManagement: vi.fn()
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.getPluginDetail({ version: PLUGIN_CENTER_API_VERSION, plugin: { id: 'duplicate' } })
    ).resolves.toEqual({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'missing',
      missingReason: 'ambiguous'
    })
    expect(provider.readPluginDetailForManagement).not.toHaveBeenCalled()
  })
})
