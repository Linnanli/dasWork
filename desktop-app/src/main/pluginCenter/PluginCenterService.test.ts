import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  PLUGIN_CENTER_API_VERSION,
  PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH,
  type PluginCenterRecommendedSkill
} from '../../shared/pluginCenterApi'
import { PluginCenterService, type PluginCenterProvider } from './PluginCenterService'
import type { RecommendedSkillsService } from './RecommendedSkillsService'

function createRecommendedSkillsService(
  skills: PluginCenterRecommendedSkill[],
  error?: string
): RecommendedSkillsService {
  return {
    getRecommendedSkills: vi.fn(async () => ({
      version: PLUGIN_CENTER_API_VERSION,
      skills,
      fetchedAt: '2026-09-01T00:00:00.000Z',
      source: 'cache',
      ...(error ? { error } : {})
    })),
    installRecommendedSkill: vi.fn()
  } as unknown as RecommendedSkillsService
}

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
    readPluginDetailForManagement: vi.fn(async () => ({
      summary: {
        id: 'git@official',
        name: 'git',
        remotePluginId: 'remote-git',
        enabled: true,
        installed: true,
        source: { type: 'local', path: '/plugins/git' },
        interface: { displayName: 'Git helpers' }
      },
      skills: [
        {
          name: 'review',
          description: 'Review code',
          path: '/plugins/git/skills/review/SKILL.md',
          enabled: true
        }
      ],
      apps: [{ id: 'github', name: 'GitHub' }],
      mcpServers: ['plugin-server']
    })),
    readSkillFileContents: vi.fn(async () => '# Review\nUse the trusted local file.'),
    readRemotePluginSkillContents: vi.fn(async () => '# Remote Review\nUse remote contents.'),
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
        labels: { retrievable: 'true' },
        installUrl: 'https://github.com/apps/example'
      }
    ]),
    readMcpManagementSnapshot: vi.fn(async () => ({
      config: mcpConfig,
      servers: [
        { name: 'local', connected: true, authStatus: 'unsupported', toolCount: 2 },
        { name: 'plugin-server', connected: false, authStatus: 'oAuth', toolCount: 1 }
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
  it('hides internal bundled plugins and refuses direct user mutations', async () => {
    const internalPlugin = {
      id: 'codex-app-tools@openai-bundled',
      name: 'codex-app-tools',
      source: { type: 'local', path: '/plugins/codex-app-tools' },
      installed: true,
      enabled: true,
      installPolicy: 'AVAILABLE',
      availability: 'AVAILABLE',
      version: '0.1.0',
      interface: { displayName: 'Codex App Tools' }
    }
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [{ name: 'openai-bundled', path: '/plugins', plugins: [internalPlugin] }],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [{ name: 'openai-bundled', path: '/plugins', plugins: [internalPlugin] }],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      }))
    })
    const service = new PluginCenterService({
      provider,
      defaultCwd: () => '/repo',
      isInternalPlugin: (plugin) => plugin.id === internalPlugin.id
    })
    const pluginInput = {
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: internalPlugin.id, marketplaceId: 'openai-bundled' }
    }

    const snapshot = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['plugins'],
      includePluginDetails: false
    })
    const installed = await service.getInstalledPlugins({
      version: PLUGIN_CENTER_API_VERSION
    })

    expect(snapshot.snapshot.plugins).toEqual([])
    expect(installed.plugins).toEqual([])
    await expect(service.getPluginDetail(pluginInput)).rejects.toThrow('managed by the desktop')
    await expect(service.installPlugin(pluginInput)).rejects.toThrow('managed by the desktop')
    await expect(service.uninstallPlugin(pluginInput)).rejects.toThrow('managed by the desktop')
    await expect(service.setPluginEnabled({ ...pluginInput, enabled: false })).rejects.toThrow(
      'managed by the desktop'
    )
    expect(provider.installPlugin).not.toHaveBeenCalled()
    expect(provider.uninstallPlugin).not.toHaveBeenCalled()
    expect(provider.setPluginEnabled).not.toHaveBeenCalled()
  })

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
    expect(result.snapshot.apps).toMatchObject([
      { id: 'github', accessible: false, labels: { retrievable: 'true' } }
    ])
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
    expect(result.snapshot.mcp.userServers.map((server) => [server.id, server.canToggle])).toEqual([
      ['local', true],
      ['inherited', false]
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
      { id: 'plugin-server', pluginId: 'git@official', editable: false, canToggle: false }
    ])
  })

  it('lists MCP servers when config/read returns the camelCase mcpServers field', async () => {
    const service = new PluginCenterService({
      provider: createProvider({
        readMcpManagementSnapshot: vi.fn(async () => ({
          config: {
            config: {
              mcpServers: {
                filesystem: {
                  command: 'npx',
                  args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
                  enabled: true
                }
              }
            },
            layers: [],
            origins: {}
          },
          servers: [
            { name: 'filesystem', connected: true, authStatus: 'unsupported', toolCount: 4 }
          ]
        }))
      }),
      defaultCwd: () => '/repo'
    })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['mcp']
    })

    expect(result.snapshot.mcp.userServers).toEqual([
      expect.objectContaining({
        id: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        connected: true,
        toolCount: 4
      })
    ])
  })

  it('classifies runtime-only MCP servers as plugin-provided without plugin metadata', async () => {
    const service = new PluginCenterService({
      provider: createProvider({
        readMcpManagementSnapshot: vi.fn(async () => ({
          config: {
            config: {
              mcp_servers: {
                local: { command: 'local-mcp', name: 'local-runtime' }
              }
            },
            layers: [],
            origins: {}
          },
          servers: [
            { name: 'local-runtime', connected: true, authStatus: 'unsupported', toolCount: 1 },
            { name: 'plugin-server', connected: true, authStatus: 'oAuth', toolCount: 3 },
            { name: 'codex_app', connected: true, authStatus: 'unsupported', toolCount: 2 }
          ]
        }))
      }),
      defaultCwd: () => '/repo'
    })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['mcp'],
      includePluginDetails: false
    })

    expect(result.snapshot.mcp.userServers).toEqual([
      expect.objectContaining({ id: 'local', connected: true, toolCount: 1 })
    ])
    expect(result.snapshot.mcp.pluginServers).toEqual([
      expect.objectContaining({
        id: 'plugin-server',
        origin: 'plugin',
        editable: false,
        canToggle: false,
        connected: true,
        toolCount: 3
      })
    ])
  })

  it('uses a skill interface display name instead of its short description', async () => {
    const service = new PluginCenterService({
      provider: createProvider({
        listSkillsForManagement: vi.fn(async () => [
          {
            name: 'review-workflow',
            shortDescription: 'Review each pull request with the team workflow.',
            description: 'Use the team review workflow.',
            path: '/skills/review-workflow/SKILL.md',
            scope: 'user',
            enabled: true,
            interface: { displayName: 'Review workflow' }
          }
        ])
      }),
      defaultCwd: () => '/repo'
    })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['skills']
    })

    expect(result.snapshot.skills).toContainEqual(
      expect.objectContaining({
        name: 'review-workflow',
        displayName: 'Review workflow',
        description: 'Use the team review workflow.'
      })
    )
  })

  it('keeps only standalone personal skills in the Codex manage skills tab', async () => {
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        {
          name: 'writer',
          path: '/skills/z-writer/SKILL.md',
          scope: 'user',
          enabled: true,
          interface: { displayName: 'Writer' }
        },
        {
          name: 'review',
          path: '/system/skills/review/SKILL.md',
          scope: 'system',
          enabled: true,
          interface: { displayName: 'Code Review' }
        },
        {
          name: 'review',
          path: '/repo/.codex/skills/review/SKILL.md',
          scope: 'repo',
          enabled: false,
          interface: { displayName: 'Code Review' }
        },
        {
          name: 'writer',
          path: '/skills/a-writer/SKILL.md',
          scope: 'user',
          enabled: false,
          interface: { displayName: 'Writer' }
        },
        {
          name: 'alpha',
          path: '/skills/alpha/SKILL.md',
          scope: 'user',
          enabled: true,
          interface: { displayName: 'Alpha' }
        },
        {
          name: 'documents',
          path: '/Users/test/.codex/plugins/cache/openai-bundled/documents/1.0.0/skills/documents/SKILL.md',
          scope: 'user',
          enabled: true,
          interface: { displayName: 'Documents' }
        },
        {
          name: 'github',
          path: '/Users/test/.codex/plugins/github/skills/github/SKILL.md',
          scope: 'user',
          enabled: true,
          interface: { displayName: 'GitHub' }
        },
        {
          name: 'admin-skill',
          path: '/admin/skills/admin-skill/SKILL.md',
          scope: 'admin',
          enabled: true,
          interface: { displayName: 'Admin skill' }
        }
      ])
    })
    const recommendedSkills = createRecommendedSkillsService([])
    const service = new PluginCenterService({
      provider,
      defaultCwd: () => '/repo',
      recommendedSkills
    })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['skills'],
      skillListMode: 'manage'
    })

    expect(provider.listSkillsForManagement).toHaveBeenCalledWith({
      cwd: '/repo',
      forceReload: undefined
    })
    expect(recommendedSkills.getRecommendedSkills).toHaveBeenCalledWith(false)
    expect(result.snapshot.skills.map(({ id, name, scope }) => ({ id, name, scope }))).toEqual([
      { id: '/skills/alpha/SKILL.md', name: 'alpha', scope: 'personal' },
      { id: '/skills/a-writer/SKILL.md', name: 'writer', scope: 'personal' }
    ])
  })

  it('removes managed skills that match the recommended catalog', async () => {
    const recommendedSkills = createRecommendedSkillsService([
      {
        id: 'aspnet-core',
        name: 'aspnet-core',
        description: 'Build ASP.NET Core applications.',
        repoPath: 'skills/.curated/aspnet-core'
      }
    ])
    const service = new PluginCenterService({
      provider: createProvider({
        listSkillsForManagement: vi.fn(async () => [
          {
            name: 'aspnet-core',
            path: '/Users/test/.codex/skills/aspnet-core/SKILL.md',
            scope: 'user',
            enabled: false,
            interface: { displayName: 'ASP.NET Core' }
          },
          {
            name: 'writer',
            path: '/Users/test/.codex/skills/writer/SKILL.md',
            scope: 'user',
            enabled: true,
            interface: { displayName: 'Writer' }
          }
        ])
      }),
      defaultCwd: () => '/repo',
      recommendedSkills
    })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['skills'],
      skillListMode: 'manage'
    })

    expect(result.snapshot.skills.map((skill) => skill.name)).toEqual(['writer'])
  })

  it('keeps the managed skill list empty while the recommended catalog is unavailable', async () => {
    const service = new PluginCenterService({
      provider: createProvider({
        listSkillsForManagement: vi.fn(async () => [
          {
            name: 'writer',
            path: '/Users/test/.codex/skills/writer/SKILL.md',
            scope: 'user',
            enabled: true,
            interface: { displayName: 'Writer' }
          }
        ])
      }),
      defaultCwd: () => '/repo',
      recommendedSkills: createRecommendedSkillsService([], '推荐技能目录暂时不可用')
    })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['skills'],
      skillListMode: 'manage'
    })

    expect(result.snapshot.skills).toEqual([])
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

  it('preserves the installation timestamp returned by plugin/installed', async () => {
    const installedAt = 1_788_062_387
    const provider = createProvider({
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'openai-curated-remote',
            path: null,
            plugins: [
              {
                id: 'gmail@openai-curated-remote',
                name: 'gmail',
                source: { type: 'remote' },
                installed: true,
                installedAt,
                enabled: true,
                installPolicy: 'AVAILABLE',
                availability: 'AVAILABLE',
                interface: { displayName: 'Gmail' }
              }
            ]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION })

    expect(result.plugins).toEqual([
      expect.objectContaining({ id: 'gmail@openai-curated-remote', installedAt })
    ])
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
    ).rejects.toThrow('Only user-toggleable MCP servers')
    expect(provider.setMcpServerEnabled).not.toHaveBeenCalled()
  })

  it('keeps runtime-only plugin MCP servers read-only', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.setMcpServerEnabled({
        version: PLUGIN_CENTER_API_VERSION,
        server: { id: 'plugin-server' },
        enabled: true
      })
    ).rejects.toThrow('Only user-toggleable MCP servers')
    expect(provider.setMcpServerEnabled).not.toHaveBeenCalled()
  })

  it('blocks plugin MCP toggles when a higher-priority config layer owns enabled', async () => {
    const provider = createProvider({
      readMcpManagementSnapshot: vi.fn(async () => ({
        config: {
          config: {
            mcp_servers: {
              'plugin-server': { enabled: false }
            }
          },
          layers: [],
          origins: {
            'mcp_servers."plugin-server".enabled': {
              name: { type: 'project', dotCodexFolder: '/repo/.codex' },
              version: 'v-project'
            }
          }
        },
        servers: [{ name: 'plugin-server', connected: false, authStatus: 'oAuth', toolCount: 1 }]
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.setMcpServerEnabled({
        version: PLUGIN_CENTER_API_VERSION,
        server: { id: 'plugin-server' },
        enabled: true
      })
    ).rejects.toThrow('Only user-toggleable MCP servers')
    expect(provider.setMcpServerEnabled).not.toHaveBeenCalled()
  })

  it('reads installed skill contents from provider-resolved metadata instead of renderer paths', async () => {
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        {
          name: 'git:review',
          description: 'Review code',
          path: '/trusted/installed/review/SKILL.md',
          scope: 'plugin',
          enabled: true
        }
      ])
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSkillContents({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official', marketplaceId: 'official' },
      skill: { id: '/private/not-allowed/SKILL.md', name: 'review' }
    })

    expect(result).toMatchObject({
      status: 'ready',
      contents: '# Review\nUse the trusted local file.',
      localPath: '/trusted/installed/review/SKILL.md'
    })
    expect(provider.readSkillFileContents).toHaveBeenCalledWith({
      path: '/trusted/installed/review/SKILL.md',
      maxBytes: 524288
    })
  })

  it('reads a local skill by matching the server-owned skills list when no plugin is supplied', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSkillContents({
      version: PLUGIN_CENTER_API_VERSION,
      skill: { id: '/skills/writer/SKILL.md', name: 'writer' }
    })

    expect(result).toMatchObject({
      status: 'ready',
      contents: '# Review\nUse the trusted local file.',
      localPath: '/skills/writer/SKILL.md'
    })
    expect(provider.readPluginDetailForManagement).not.toHaveBeenCalled()
    expect(provider.readSkillFileContents).toHaveBeenCalledWith({
      path: '/skills/writer/SKILL.md',
      maxBytes: 524288
    })
  })

  it('uninstalls only the independently managed skill directory resolved by the server', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'dascowork-plugin-center-skills-'))
    const skillDirectory = join(codexHome, 'skills', 'writer')
    const removeSkillDirectory = vi.fn(async () => undefined)
    try {
      await mkdir(skillDirectory, { recursive: true })
      await writeFile(join(skillDirectory, 'SKILL.md'), '# Writer')
      const skillPath = join(skillDirectory, 'SKILL.md')
      const service = new PluginCenterService({
        provider: createProvider({
          listSkillsForManagement: vi.fn(async () => [
            { name: 'writer', path: skillPath, scope: 'user', enabled: true }
          ])
        }),
        defaultCwd: () => '/repo',
        codexHome,
        removeSkillDirectory
      })

      await expect(
        service.uninstallSkill({
          version: PLUGIN_CENTER_API_VERSION,
          skill: { id: skillPath, name: 'writer' }
        })
      ).resolves.toMatchObject({
        status: 'applied',
        changedItemId: skillPath,
        changedSections: ['skills']
      })
      expect(removeSkillDirectory).toHaveBeenCalledWith(await realpath(skillDirectory))
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('does not remove a skill path outside the configured skills root', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'dascowork-plugin-center-skills-'))
    const outsideRoot = await mkdtemp(join(tmpdir(), 'dascowork-plugin-center-outside-'))
    const skillDirectory = join(outsideRoot, 'writer')
    const removeSkillDirectory = vi.fn(async () => undefined)
    try {
      await mkdir(skillDirectory, { recursive: true })
      const skillPath = join(skillDirectory, 'SKILL.md')
      await writeFile(skillPath, '# Writer')
      const service = new PluginCenterService({
        provider: createProvider({
          listSkillsForManagement: vi.fn(async () => [
            { name: 'writer', path: skillPath, scope: 'user', enabled: true }
          ])
        }),
        defaultCwd: () => '/repo',
        codexHome,
        removeSkillDirectory
      })

      await expect(
        service.uninstallSkill({
          version: PLUGIN_CENTER_API_VERSION,
          skill: { id: skillPath, name: 'writer' }
        })
      ).rejects.toThrow('Only independent user or project skills')
      expect(removeSkillDirectory).not.toHaveBeenCalled()
    } finally {
      await Promise.all([
        rm(codexHome, { recursive: true, force: true }),
        rm(outsideRoot, { recursive: true, force: true })
      ])
    }
  })

  it('refuses to uninstall plugin, system, or admin skills', async () => {
    const removeSkillDirectory = vi.fn(async () => undefined)
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        {
          name: 'git:review',
          path: '/plugins/git/skills/review/SKILL.md',
          scope: 'user',
          enabled: true
        },
        {
          name: 'system-skill',
          path: '/system/skills/system-skill/SKILL.md',
          scope: 'system',
          enabled: true
        }
      ])
    })
    const service = new PluginCenterService({
      provider,
      defaultCwd: () => '/repo',
      removeSkillDirectory
    })

    await expect(
      service.uninstallSkill({
        version: PLUGIN_CENTER_API_VERSION,
        skill: { id: '/plugins/git/skills/review/SKILL.md', name: 'git:review' }
      })
    ).rejects.toThrow('Only independent user or project skills')
    await expect(
      service.uninstallSkill({
        version: PLUGIN_CENTER_API_VERSION,
        skill: { id: '/system/skills/system-skill/SKILL.md', name: 'system-skill' }
      })
    ).rejects.toThrow('Only independent user or project skills')
    expect(removeSkillDirectory).not.toHaveBeenCalled()
  })

  it('reads remote plugin skill contents from a server-resolved plugin locator', async () => {
    const remotePlugin = {
      id: 'remote@official',
      name: 'remote',
      remotePluginId: 'remote-plugin-id',
      source: { type: 'remote' },
      installed: false,
      enabled: false,
      installPolicy: 'AVAILABLE',
      availability: 'AVAILABLE',
      interface: { displayName: 'Remote helpers' }
    }
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [{ name: 'official', path: null, plugins: [remotePlugin] }],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      readPluginDetailForManagement: vi.fn(async () => ({
        summary: remotePlugin,
        skills: [{ name: 'remote-review', description: 'Review remotely', enabled: true }],
        apps: [],
        mcpServers: []
      })),
      listSkillsForManagement: vi.fn(async () => []),
      readSkillFileContents: vi.fn(),
      readRemotePluginSkillContents: vi.fn(async () => '# Remote Review')
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSkillContents({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'remote@official', marketplaceId: 'official' },
      skill: { id: 'plugin:remote@official:remote-review', name: 'remote-review' }
    })

    expect(result).toMatchObject({ status: 'ready', contents: '# Remote Review' })
    expect(provider.readSkillFileContents).not.toHaveBeenCalled()
    expect(provider.readRemotePluginSkillContents).toHaveBeenCalledWith({
      remoteMarketplaceName: 'official',
      remotePluginId: 'remote-plugin-id',
      skillName: 'remote-review',
      maxBytes: 524288
    })
  })

  it('returns missing for unknown skill content requests without reading files', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await expect(
      service.getSkillContents({
        version: PLUGIN_CENTER_API_VERSION,
        plugin: { id: 'git@official', marketplaceId: 'official' },
        skill: { id: 'plugin:git@official:missing', name: 'missing' }
      })
    ).resolves.toMatchObject({ status: 'missing', missingReason: 'not_found' })
    expect(provider.readSkillFileContents).not.toHaveBeenCalled()
    expect(provider.readRemotePluginSkillContents).not.toHaveBeenCalled()
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

  it('reads MCP management data by cwd without forwarding the active thread', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['mcp'],
      threadId: 'thread-secret'
    })

    expect(provider.readMcpManagementSnapshot).toHaveBeenCalledWith({ cwd: '/repo' })
  })

  it('preserves local skill interface images through the app media protocol', async () => {
    const provider = createProvider({
      listSkillsForManagement: vi.fn(async () => [
        {
          name: 'writer',
          description: 'Write docs',
          path: '/skills/writer/SKILL.md',
          scope: 'user',
          enabled: true,
          interface: {
            iconSmall: '/skills/writer/assets/icon-small.png',
            iconLarge: '/skills/writer/assets/icon-large.png'
          }
        }
      ])
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getSnapshot({
      version: PLUGIN_CENTER_API_VERSION,
      sections: ['skills']
    })

    expect(result.snapshot.skills).toContainEqual(
      expect.objectContaining({
        id: '/skills/writer/SKILL.md',
        iconSmall: { kind: 'url', value: 'app://fs/@fs/skills/writer/assets/icon-small.png' },
        iconLarge: { kind: 'url', value: 'app://fs/@fs/skills/writer/assets/icon-large.png' }
      })
    )
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
          skills: [
            {
              name: 'catalog-skill',
              enabled: true,
              interface: {
                iconSmall: 'https://cdn.example.test/catalog-skill-small.png',
                iconLarge: 'https://cdn.example.test/catalog-skill-large.png'
              }
            }
          ],
          apps: [],
          mcpServers: []
        }
      ]),
      readMcpManagementSnapshot: vi.fn(async () => ({
        config: { config: {}, layers: [], origins: {} },
        servers: []
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
        iconSmall: { kind: 'url', value: 'https://cdn.example.test/catalog-skill-small.png' },
        iconLarge: { kind: 'url', value: 'https://cdn.example.test/catalog-skill-large.png' },
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

  it('bypasses the installed-state cache when explicitly refreshed', async () => {
    const provider = createProvider()
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION })
    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION })
    await service.getInstalledPlugins({ version: PLUGIN_CENTER_API_VERSION, forceRefresh: true })

    expect(provider.listInstalledPluginsForManagement).toHaveBeenCalledTimes(2)
  })

  it('installs and uninstalls using the cached catalog locator without treating an asynchronous readback as failure', async () => {
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

    await service.uninstallPlugin({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: 'git@official', marketplaceId: 'official' }
    })

    expect(provider.uninstallPlugin).toHaveBeenCalledWith({ pluginId: 'git@official' })
    expect(provider.listPluginCatalog).not.toHaveBeenCalled()
    expect(provider.listInstalledPluginsForManagement).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'applied',
      changedItemId: 'git@official',
      changedSections: ['installed']
    })
    expect(result.snapshot).toBeUndefined()
  })

  it('uses the opaque remote plugin id for remote catalog detail and mutation requests', async () => {
    const remotePlugin = {
      id: 'gmail@openai-curated-remote',
      name: 'gmail',
      remotePluginId: 'plugins~Plugin_gmail_123',
      source: { type: 'remote' },
      installed: false,
      enabled: false,
      installPolicy: 'AVAILABLE',
      availability: 'AVAILABLE',
      interface: { displayName: 'Gmail' }
    }
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [{ name: 'openai-curated-remote', path: null, plugins: [remotePlugin] }],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      listInstalledPluginsForManagement: vi.fn(async () => ({
        marketplaces: [
          {
            name: 'openai-curated-remote',
            path: null,
            plugins: [{ ...remotePlugin, installed: true, enabled: true }]
          }
        ],
        featuredPluginIds: [],
        marketplaceLoadErrors: []
      })),
      readPluginDetailForManagement: vi.fn(async () => ({
        summary: remotePlugin,
        skills: [],
        apps: [],
        mcpServers: []
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })
    const input = {
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: remotePlugin.id, marketplaceId: 'openai-curated-remote' }
    }

    await service.getPluginDetail(input)
    await service.installPlugin(input)
    await service.uninstallPlugin(input)

    expect(provider.readPluginDetailForManagement).toHaveBeenCalledWith({
      remoteMarketplaceName: 'openai-curated-remote',
      pluginName: 'plugins~Plugin_gmail_123'
    })
    expect(provider.installPlugin).toHaveBeenCalledWith({
      remoteMarketplaceName: 'openai-curated-remote',
      installAttemptId: expect.any(String),
      pluginName: 'plugins~Plugin_gmail_123'
    })
    expect(provider.uninstallPlugin).toHaveBeenCalledWith({
      pluginId: 'plugins~Plugin_gmail_123'
    })
  })

  it('returns remote installation success before the asynchronous installed-state cache catches up', async () => {
    const remotePlugin = {
      id: 'gmail@openai-curated-remote',
      name: 'gmail',
      remotePluginId: 'plugins~Plugin_gmail_123',
      source: { type: 'remote' },
      installed: false,
      enabled: false,
      installPolicy: 'AVAILABLE',
      availability: 'AVAILABLE',
      interface: { displayName: 'Gmail' }
    }
    const provider = createProvider({
      listPluginCatalog: vi.fn(async () => ({
        marketplaces: [{ name: 'openai-curated-remote', path: null, plugins: [remotePlugin] }],
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

    const result = await service.installPlugin({
      version: PLUGIN_CENTER_API_VERSION,
      plugin: { id: remotePlugin.id, marketplaceId: 'openai-curated-remote' }
    })

    expect(result).toMatchObject({
      status: 'applied',
      changedItemId: remotePlugin.id,
      changedSections: ['installed']
    })
    expect(provider.listInstalledPluginsForManagement).not.toHaveBeenCalled()
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
    expect(provider.listInstalledPluginsForManagement!).not.toHaveBeenCalled()
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

  it('projects one app tool list with redacted configuration restrictions', async () => {
    const provider = createProvider({
      readAppsForManagement: vi.fn(async () => ({
        apps: [
          {
            id: 'github-app',
            toolSummaries: [
              {
                name: 'github.write_issue',
                title: '创建议题',
                description: '创建一个新的议题。',
                isEnabled: false,
                isReadOnly: false
              },
              {
                name: 'github.admin_only',
                isEnabled: false,
                disabledReason: 'disabled_by_admin',
                isReadOnly: false
              },
              {
                name: 'github.unavailable',
                isEnabled: false,
                isReadOnly: true
              },
              {
                name: 'github.search',
                isEnabled: true,
                isReadOnly: true
              }
            ]
          }
        ],
        missingAppIds: []
      })),
      readConfigForManagement: vi.fn(async () => ({
        config: {},
        origins: {
          'apps."github-app"."tools"."github.write_issue".enabled': {
            name: { type: 'project', dotCodexFolder: '/repo/.codex' },
            version: 'v-project'
          }
        }
      }))
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getAppTools({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: '/repo',
      threadId: 'thread-app-tools',
      app: { id: 'github-app' }
    })

    expect(provider.readAppsForManagement).toHaveBeenCalledWith({
      appIds: ['github-app'],
      threadId: 'thread-app-tools',
      includeTools: true
    })
    expect(provider.readConfigForManagement).toHaveBeenCalledWith({ cwd: '/repo' })
    expect(result).toMatchObject({
      status: 'ready',
      app: { id: 'github-app' },
      tools: [
        {
          name: 'github.write_issue',
          title: '创建议题',
          enabled: false,
          readOnly: false,
          restriction: {
            kind: 'configuration',
            source: 'project',
            editable: false,
            recoveryKeyPath: 'apps."github-app"."tools"."github.write_issue".enabled'
          }
        },
        {
          name: 'github.admin_only',
          enabled: false,
          restriction: { kind: 'admin', editable: false }
        },
        {
          name: 'github.unavailable',
          enabled: false,
          restriction: { kind: 'unavailable', editable: false }
        },
        { name: 'github.search', enabled: true, readOnly: true }
      ]
    })
    expect(JSON.stringify(result)).not.toContain('/repo/.codex')
  })

  it('keeps app tools available when configuration origins cannot be read', async () => {
    const provider = createProvider({
      readAppsForManagement: vi.fn(async () => ({
        apps: [
          {
            id: 'github-app',
            toolSummaries: [
              {
                name: 'github.search',
                isEnabled: true,
                isReadOnly: true
              }
            ]
          }
        ],
        missingAppIds: []
      })),
      readConfigForManagement: vi.fn(async () => {
        throw new Error('config unavailable')
      })
    })
    const service = new PluginCenterService({ provider, defaultCwd: () => '/repo' })

    const result = await service.getAppTools({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: '/repo',
      app: { id: 'github-app' }
    })

    expect(result).toMatchObject({
      status: 'ready',
      app: { id: 'github-app' },
      tools: [{ name: 'github.search', enabled: true, readOnly: true }]
    })
  })

  it('builds safe settings URLs and stable app mentions from app/read metadata', async () => {
    const provider = createProvider({
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
          { id: 'google_drive', name: 'Google Drive' },
          { id: 'remote-plugin', name: 'Remote Plugin' },
          { id: 'unsafe-app', name: 'Unsafe App' }
        ],
        skills: [],
        mcpServers: []
      })),
      readAppsForManagement: vi.fn(async () => ({
        apps: [
          {
            id: 'google_drive',
            name: 'Google Drive',
            installUrl: 'https://chatgpt.com/install#untrusted-fragment'
          },
          {
            id: 'remote-plugin',
            name: 'Remote Plugin'
          },
          {
            id: 'unsafe-app',
            name: 'Unsafe App',
            installUrl: 'javascript:alert(1)'
          }
        ],
        missingAppIds: []
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
            id: 'google_drive',
            mention: { path: 'app://google_drive', name: 'Google Drive' },
            installUrl: 'https://chatgpt.com/install',
            settingsUrl:
              'https://chatgpt.com/plugins#settings/Connectors?connector=google_drive&product-sku=CODEX&referrer=codex'
          },
          {
            id: 'remote-plugin',
            settingsUrl:
              'https://chatgpt.com/plugins#settings/Connectors?connector=remote-plugin&product-sku=CODEX&referrer=codex'
          },
          {
            id: 'unsafe-app'
          }
        ]
      }
    })
    const unsafeApp =
      result.status === 'ready'
        ? result.detail.apps.find((app) => app.id === 'unsafe-app')
        : undefined
    expect(unsafeApp?.installUrl).toBeUndefined()
    expect(unsafeApp?.settingsUrl).toBeUndefined()
  })

  it('builds remote plugin settings URLs from plugin summary metadata', async () => {
    const provider = createProvider({
      readPluginDetailForManagement: vi.fn(async () => ({
        summary: {
          id: 'git@official',
          name: 'git',
          installed: true,
          enabled: true,
          source: { type: 'local', path: '/plugins/git' },
          remotePluginId: 'rp/123'
        },
        apps: [{ id: 'remote-app', name: 'Remote App' }],
        skills: [],
        mcpServers: []
      })),
      readAppsForManagement: vi.fn(async () => ({
        apps: [{ id: 'remote-app', name: 'Remote App' }],
        missingAppIds: []
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
            id: 'remote-app',
            settingsUrl:
              'https://chatgpt.com/plugins/rp%2F123#settings/Plugins/rp%2F123?product-sku=CODEX'
          }
        ]
      }
    })
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
