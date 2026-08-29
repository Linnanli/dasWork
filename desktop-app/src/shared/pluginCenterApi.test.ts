import { describe, expect, it } from 'vitest'

import {
  PLUGIN_CENTER_API_VERSION,
  pluginCenterAddMarketplaceRequestSchema,
  pluginCenterGetAppToolsRequestSchema,
  pluginCenterGetAppToolsResultSchema,
  pluginCenterGetPluginDetailRequestSchema,
  pluginCenterGetPluginDetailResultSchema,
  pluginCenterGetSkillContentsRequestSchema,
  pluginCenterGetSkillContentsResultSchema,
  pluginCenterInstalledPluginsRequestSchema,
  pluginCenterInstalledPluginsResultSchema,
  pluginCenterMutationResultSchema,
  pluginCenterSetAppEnabledRequestSchema,
  pluginCenterSnapshotRequestSchema,
  pluginCenterSnapshotSchema,
  pluginCenterUpsertMcpServerRequestSchema
} from './pluginCenterApi'

describe('plugin center API schemas', () => {
  it('accepts a targeted snapshot request and removes duplicate sections', () => {
    expect(
      pluginCenterSnapshotRequestSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        sections: ['plugins', 'plugins', 'skills'],
        includePluginDetails: false
      })
    ).toMatchObject({
      sections: ['plugins', 'skills'],
      includePluginDetails: false
    })
  })

  it('accepts a renderer-safe product snapshot for plugins, skills, apps, and MCP', () => {
    const parsed = pluginCenterSnapshotSchema.safeParse({
      version: PLUGIN_CENTER_API_VERSION,
      generatedAt: '2026-08-24T00:00:00.000Z',
      plugins: [
        {
          kind: 'plugin',
          id: 'plugin:github',
          name: 'github',
          displayName: 'GitHub',
          description: 'Repository tools',
          sourceKind: 'marketplace',
          marketplaceId: 'personal',
          categories: ['Developer tools'],
          tags: ['git'],
          featured: true,
          installed: true,
          enabled: true,
          canInstall: true,
          canUninstall: true,
          canToggle: true,
          skillCount: 1,
          appCount: 1,
          mcpServerCount: 1
        }
      ],
      skills: [
        {
          id: 'skill:review',
          name: 'review',
          displayName: 'Review',
          description: 'Review code',
          scope: 'plugin',
          sourceKind: 'marketplace',
          pluginId: 'plugin:github',
          enabled: true,
          installed: true,
          recommended: false,
          canToggle: true,
          tags: []
        }
      ],
      apps: [
        {
          id: 'app:github',
          name: 'github',
          displayName: 'GitHub',
          sourceKind: 'marketplace',
          pluginIds: ['plugin:github'],
          pluginDisplayNames: ['GitHub'],
          enabled: false,
          accessible: false,
          canToggle: false,
          installUrl: 'https://github.com/apps/example',
          restriction: { code: 'inaccessible', message: 'Connect GitHub first' }
        }
      ],
      mcp: {
        userServers: [
          {
            id: 'mcp:filesystem',
            name: 'filesystem',
            enabled: true,
            connected: false,
            authStatus: 'unsupported',
            toolCount: 0,
            origin: 'user',
            editable: true,
            transport: 'stdio',
            command: 'npx',
            args: ['server-filesystem'],
            env: [{ name: 'API_TOKEN', hasValue: true, editable: true }],
            envVars: [{ name: 'PATH', source: 'local', editable: true }]
          }
        ],
        pluginServers: [
          {
            id: 'mcp:github',
            name: 'github',
            enabled: true,
            connected: true,
            authStatus: 'oAuth',
            toolCount: 12,
            origin: 'plugin',
            editable: false,
            pluginId: 'plugin:github',
            pluginDisplayName: 'GitHub',
            transport: 'streamable-http'
          }
        ]
      },
      capabilities: {
        plugins: { available: true },
        skills: { available: true },
        apps: { available: true },
        mcp: { available: true }
      },
      marketplaces: [
        {
          id: 'marketplace:personal',
          name: 'personal',
          source: 'owner/repo',
          sparsePaths: ['plugins']
        }
      ]
    })

    expect(parsed.success).toBe(true)
  })

  it('keeps MCP args ordered while allowing partial mutation results', () => {
    const edit = pluginCenterUpsertMcpServerRequestSchema.parse({
      version: PLUGIN_CENTER_API_VERSION,
      displayName: 'Ordered MCP',
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['--flag', '--flag', 'server'],
        env: [],
        envVars: []
      }
    })

    if (edit.server.transport !== 'stdio') throw new Error('Expected stdio MCP edit')
    expect(edit.server.args).toEqual(['--flag', '--flag', 'server'])
    expect(
      pluginCenterMutationResultSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'partial',
        message: '写入已提交，但刷新后的状态与目标不一致'
      }).changedSections
    ).toEqual([])
    expect(
      pluginCenterMutationResultSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'applied',
        changedSections: ['installed', 'installed', 'skills']
      }).changedSections
    ).toEqual(['installed', 'skills'])
  })

  it('keeps installed-only plugin requests and results renderer-safe', () => {
    expect(
      pluginCenterInstalledPluginsRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        forceRefresh: true
      }).success
    ).toBe(true)
    expect(
      pluginCenterInstalledPluginsRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        threadId: 'thread-a'
      }).success
    ).toBe(false)
    expect(
      pluginCenterInstalledPluginsResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        generatedAt: '2026-08-24T00:00:00.000Z',
        plugins: [],
        configPath: '/Users/me/.codex/config.toml'
      }).success
    ).toBe(false)
  })

  it('rejects secret values and backend implementation details in snapshots', () => {
    expect(
      pluginCenterSnapshotSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        generatedAt: '2026-08-24T00:00:00.000Z',
        plugins: [],
        skills: [],
        apps: [],
        mcp: {
          userServers: [
            {
              id: 'mcp:filesystem',
              name: 'filesystem',
              enabled: true,
              connected: false,
              authStatus: 'unsupported',
              toolCount: 0,
              origin: 'user',
              editable: true,
              transport: 'stdio',
              command: 'npx',
              args: [],
              env: [{ name: 'API_TOKEN', hasValue: true, value: 'secret' }],
              envVars: []
            }
          ],
          pluginServers: []
        },
        marketplaces: [],
        configPath: '/Users/me/.codex/config.toml',
        jsonRpcMethod: 'config/read'
      }).success
    ).toBe(false)
  })

  it('normalizes marketplace add input without exposing RPC-specific fields', () => {
    const parsed = pluginCenterAddMarketplaceRequestSchema.safeParse({
      version: PLUGIN_CENTER_API_VERSION,
      source: ' owner/repo ',
      refName: ' main ',
      sparsePaths: [' plugins ', 'skills', 'plugins']
    })

    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject({
      source: 'owner/repo',
      refName: 'main',
      sparsePaths: ['plugins', 'skills']
    })
    expect(
      pluginCenterAddMarketplaceRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        source: 'owner/repo',
        method: 'marketplace/add'
      }).success
    ).toBe(false)
  })

  it('accepts MCP edits with patch semantics and rejects inline bearer tokens', () => {
    expect(
      pluginCenterUpsertMcpServerRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        displayName: 'GitHub MCP',
        server: {
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          bearerTokenEnvVar: 'GITHUB_TOKEN',
          httpHeaders: [
            { name: 'X-API-Key', value: { action: 'set', value: 'new-secret' } },
            { name: 'X-Existing', value: { action: 'keep' } }
          ],
          envHttpHeaders: [{ name: 'X-From-Env', envVarName: 'HEADER_TOKEN' }]
        }
      }).success
    ).toBe(true)
    expect(
      pluginCenterUpsertMcpServerRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        server: {
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          bearerToken: 'inline-secret'
        }
      }).success
    ).toBe(false)
  })

  it.each([
    {
      label: 'non-http URL',
      server: {
        transport: 'streamable-http',
        url: 'file:///tmp/mcp.sock',
        httpHeaders: [],
        envHttpHeaders: []
      }
    },
    {
      label: 'mixed HTTP and stdio fields',
      server: {
        transport: 'stdio',
        command: 'node',
        args: [],
        env: [],
        envVars: [],
        url: 'https://example.com/mcp'
      }
    },
    {
      label: 'secret-bearing env passthrough object',
      server: {
        transport: 'stdio',
        command: 'node',
        args: [],
        env: [],
        envVars: [{ name: 'TOKEN', source: 'remote', value: 'secret' }]
      }
    }
  ])('rejects unsafe MCP input: $label', ({ server }) => {
    expect(
      pluginCenterUpsertMcpServerRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        displayName: 'Unsafe MCP',
        server
      }).success
    ).toBe(false)
  })

  it('keeps app toggles product-scoped instead of accepting arbitrary config keys', () => {
    expect(
      pluginCenterSetAppEnabledRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        app: { id: 'app:slack' },
        enabled: true
      }).success
    ).toBe(true)
    expect(
      pluginCenterSetAppEnabledRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        configKey: 'apps.slack.enabled',
        enabled: true
      }).success
    ).toBe(false)
  })

  it('limits plugin-detail requests to a fixed plugin ref and keeps missing results explicit', () => {
    expect(
      pluginCenterGetPluginDetailRequestSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        plugin: { id: 'github@official', marketplaceId: 'official' },
        forceRefresh: true
      })
    ).toMatchObject({ plugin: { id: 'github@official', marketplaceId: 'official' } })
    expect(
      pluginCenterGetPluginDetailRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        plugin: { id: 'github@official' },
        method: 'plugin/read'
      }).success
    ).toBe(false)
    expect(
      pluginCenterGetPluginDetailResultSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'missing',
        missingReason: 'ambiguous'
      })
    ).toEqual({
      version: PLUGIN_CENTER_API_VERSION,
      status: 'missing',
      missingReason: 'ambiguous'
    })
  })

  it('accepts plugin detail apps only through safe display fields and app mentions', () => {
    const baseDetail = {
      plugin: {
        kind: 'plugin',
        id: 'plugin:github',
        name: 'github',
        sourceKind: 'marketplace',
        categories: [],
        tags: [],
        installed: true,
        enabled: true
      },
      mention: { path: 'plugin://github', name: 'github' },
      capabilities: [],
      defaultPrompts: [],
      screenshots: [],
      apps: [
        {
          id: 'github',
          name: 'GitHub',
          description: 'Repository tools',
          installUrl: 'https://chatgpt.com/plugins',
          settingsUrl:
            'https://chatgpt.com/plugins#settings/Connectors?connector=github&product-sku=CODEX&referrer=codex',
          mention: { path: 'app://github', name: 'github' },
          multiAccountCapability: 'unknown',
          enabled: true,
          accessible: true,
          restriction: {
            code: 'readonly',
            source: 'project',
            editable: false,
            message: '由项目配置控制'
          }
        }
      ],
      skills: [],
      mcpServers: []
    }

    expect(
      pluginCenterGetPluginDetailResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        detail: baseDetail
      }).success
    ).toBe(true)
    expect(
      pluginCenterGetPluginDetailResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        detail: {
          ...baseDetail,
          apps: [{ ...baseDetail.apps[0], mention: { path: 'plugin://github', name: 'github' } }]
        }
      }).success
    ).toBe(false)
    expect(
      pluginCenterGetPluginDetailResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        detail: {
          ...baseDetail,
          apps: [{ ...baseDetail.apps[0], connectedEmail: 'user@example.com' }]
        }
      }).success
    ).toBe(false)
  })

  it('keeps app tool loading on a fixed request shape and safe result projection', () => {
    expect(
      pluginCenterGetAppToolsRequestSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        threadId: 'thread-a',
        app: { id: 'github' }
      })
    ).toEqual({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: '/repo',
      threadId: 'thread-a',
      app: { id: 'github' }
    })
    expect(
      pluginCenterGetAppToolsRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        app: { id: 'github' },
        includeTools: true
      }).success
    ).toBe(false)

    expect(
      pluginCenterGetAppToolsResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        app: { id: 'github' },
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
              editable: false,
              recoveryKeyPath: 'apps.github.tools.create_issue.enabled'
            }
          }
        ]
      }).success
    ).toBe(true)
    expect(
      pluginCenterGetAppToolsResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        app: { id: 'github' },
        tools: [
          {
            name: 'create_issue',
            title: 'Create issue',
            inputSchema: { type: 'object' },
            restriction: {
              source: 'enterprise',
              kind: 'admin',
              message: '被管理员禁用',
              editable: false,
              configPath: '/Users/me/.codex/config.toml'
            }
          }
        ]
      }).success
    ).toBe(false)
  })

  it('loads skill contents through plugin and skill identity only', () => {
    expect(
      pluginCenterGetSkillContentsRequestSchema.parse({
        version: PLUGIN_CENTER_API_VERSION,
        cwd: '/repo',
        plugin: { id: 'github@official', marketplaceId: 'official' },
        skill: { id: 'plugin:github@official:review', name: 'review' },
        forceRefresh: true
      })
    ).toEqual({
      version: PLUGIN_CENTER_API_VERSION,
      cwd: '/repo',
      plugin: { id: 'github@official', marketplaceId: 'official' },
      skill: { id: 'plugin:github@official:review', name: 'review' },
      forceRefresh: true
    })
    expect(
      pluginCenterGetSkillContentsRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        plugin: { id: 'github@official' },
        skill: { id: 'review', name: 'review', path: '/private/SKILL.md' }
      }).success
    ).toBe(false)
    expect(
      pluginCenterGetSkillContentsRequestSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        plugin: { id: 'github@official' },
        skill: { id: 'review', name: 'review' },
        method: 'fs/readFile'
      }).success
    ).toBe(false)

    expect(
      pluginCenterGetSkillContentsResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        plugin: { id: 'github@official', marketplaceId: 'official' },
        skill: { id: 'plugin:github@official:review', name: 'review' },
        contents: '# Review\nUse carefully.',
        localPath: '/trusted/SKILL.md'
      }).success
    ).toBe(true)
    expect(
      pluginCenterGetSkillContentsResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'missing',
        plugin: { id: 'github@official' },
        skill: { id: 'review', name: 'review' },
        missingReason: 'unavailable'
      }).success
    ).toBe(true)
    expect(
      pluginCenterGetSkillContentsResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        plugin: { id: 'github@official' },
        skill: { id: 'review', name: 'review' },
        contents: '# Review',
        backendPath: '/private/SKILL.md'
      }).success
    ).toBe(false)
  })

  it('rejects credential-bearing plugin center URLs', () => {
    expect(
      pluginCenterGetPluginDetailResultSchema.safeParse({
        version: PLUGIN_CENTER_API_VERSION,
        status: 'ready',
        detail: {
          plugin: {
            kind: 'plugin',
            id: 'plugin:github',
            name: 'github',
            sourceKind: 'marketplace',
            categories: [],
            tags: [],
            installed: true,
            enabled: true
          },
          mention: { path: 'plugin://github', name: 'github' },
          defaultPrompts: [],
          apps: [
            {
              id: 'github',
              name: 'GitHub',
              installUrl: 'https://user:secret@chatgpt.com/plugins',
              mention: { path: 'app://github', name: 'github' },
              multiAccountCapability: 'unknown'
            }
          ]
        }
      }).success
    ).toBe(false)
  })
})
