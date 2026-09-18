import type { PluginInstalledResponse } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/PluginInstalledResponse'
import type { PluginSummary } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/PluginSummary'
import { describe, expect, it, vi } from 'vitest'

import { BundledPluginManager, type BundledPluginCatalogClient } from './BundledPluginManager'
import type { BundledPluginDescriptor } from './BundledPluginDescriptors'

const descriptor: BundledPluginDescriptor = {
  marketplaceName: 'dascowork-bundled',
  marketplaceRoot: '/app/resources/plugins/dascowork-bundled',
  marketplacePath: '/app/resources/plugins/dascowork-bundled/.agents/plugins/marketplace.json',
  pluginRoot: '/app/resources/plugins/dascowork-bundled/plugins/codex-app-tools',
  pluginName: 'codex-app-tools',
  version: '0.1.0',
  installWhenMissing: true,
  internal: true,
  sourceKind: 'app-resource',
  owner: 'app-bundled'
}

describe('BundledPluginManager', () => {
  it('installs a missing internal plugin and confirms the readback', async () => {
    const installed = [
      installedResponse([]),
      installedResponse([plugin({ installed: true, enabled: true })])
    ]
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async () => installed.shift() ?? installed.at(-1)!)
    })
    const invalidateCaches = vi.fn()

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor],
      invalidateCaches
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(result.reconciled).toMatchObject([
      { action: 'installed', pluginId: 'codex-app-tools@dascowork-bundled' }
    ])
    expect(client.installPlugin).toHaveBeenCalledWith({
      marketplacePath: descriptor.marketplacePath,
      pluginName: descriptor.pluginName,
      installAttemptId: expect.any(String)
    })
    expect(client.listInstalledPluginsForManagement).toHaveBeenCalledWith({
      cwd: descriptor.marketplaceRoot
    })
    expect(client.listSkillsForManagement).toHaveBeenCalledWith({ forceReload: true })
    expect(invalidateCaches).toHaveBeenCalled()
  })

  it('does not confuse the app bundle with Codex-managed openai-bundled plugins', async () => {
    const codexManaged = installedResponse(
      [
        {
          ...plugin({ installed: true, enabled: true, localVersion: '0.1.4' }),
          id: 'codex-app-tools@openai-bundled',
          source: {
            type: 'local',
            path: '/Users/test/.codex/.tmp/bundled-marketplaces/openai-bundled/plugins/codex-app-tools'
          }
        }
      ],
      '/Users/test/.codex/.tmp/bundled-marketplaces/openai-bundled/.agents/plugins/marketplace.json'
    )
    codexManaged.marketplaces[0]!.name = 'openai-bundled'
    const appBundled = installedResponse([plugin({ installed: true, enabled: true })])
    const installed = [
      codexManaged,
      {
        marketplaces: [...codexManaged.marketplaces, ...appBundled.marketplaces],
        marketplaceLoadErrors: []
      } satisfies PluginInstalledResponse
    ]
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async () => installed.shift() ?? installed.at(-1)!)
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor]
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(result.reconciled).toMatchObject([
      { action: 'installed', pluginId: 'codex-app-tools@dascowork-bundled' }
    ])
    expect(client.installPlugin).toHaveBeenCalledWith({
      marketplacePath: descriptor.marketplacePath,
      pluginName: descriptor.pluginName,
      installAttemptId: expect.any(String)
    })
  })

  it('restores a disabled bundled plugin without reinstalling it', async () => {
    const installed = [
      installedResponse([plugin({ installed: true, enabled: false })]),
      installedResponse([plugin({ installed: true, enabled: true })])
    ]
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async () => installed.shift() ?? installed.at(-1)!)
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor],
      cwd: '/workspace'
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(result.reconciled).toMatchObject([{ action: 'enabled' }])
    expect(client.installPlugin).not.toHaveBeenCalled()
    expect(client.setPluginEnabled).toHaveBeenCalledWith({
      cwd: '/workspace',
      pluginId: 'codex-app-tools@dascowork-bundled',
      enabled: true
    })
  })

  it('reinstalls when the local version differs from the pinned descriptor', async () => {
    const installed = [
      installedResponse([plugin({ installed: true, enabled: true, localVersion: '0.0.9' })]),
      installedResponse([plugin({ installed: true, enabled: true })])
    ]
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async () => installed.shift() ?? installed.at(-1)!)
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor]
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(result.reconciled).toMatchObject([{ action: 'updated' }])
    expect(client.installPlugin).toHaveBeenCalledOnce()
  })

  it('does not treat a plugin from an older runtime marketplace path as active', async () => {
    const oldRuntimeMarketplace = installedResponse(
      [plugin({ installed: true, enabled: true })],
      '/app/cache/primary-runtime/versions/old/plugins/presentation-skill'
    )
    oldRuntimeMarketplace.marketplaces[0]!.name = 'presentation-skill'
    const activeDescriptor: BundledPluginDescriptor = {
      ...descriptor,
      marketplaceName: 'presentation-skill',
      marketplaceRoot: '/app/cache/primary-runtime/active/plugins/presentation-skill',
      marketplacePath:
        '/app/cache/primary-runtime/active/plugins/presentation-skill/.agents/plugins/marketplace.json',
      pluginRoot:
        '/app/cache/primary-runtime/active/plugins/presentation-skill/plugins/presentation-skill',
      pluginName: 'presentation-skill',
      sourceKind: 'primary-runtime',
      owner: 'primary-runtime:2026.09.10'
    }
    const installed = [
      oldRuntimeMarketplace,
      installedResponse(
        [
          {
            ...plugin({ installed: true, enabled: true }),
            id: 'presentation-skill@presentation-skill',
            name: 'presentation-skill'
          }
        ],
        activeDescriptor.marketplacePath
      )
    ]
    installed[1]!.marketplaces[0]!.name = 'presentation-skill'
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async () => installed.shift() ?? installed.at(-1)!)
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [activeDescriptor],
      installAttempts: 1
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(result.reconciled).toMatchObject([{ action: 'installed' }])
    expect(client.installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({ marketplacePath: activeDescriptor.marketplacePath })
    )
  })

  it('retires only an obsolete Runtime-owned plugin after committing the replacement desired set', async () => {
    const current: BundledPluginDescriptor = {
      ...descriptor,
      marketplaceName: 'presentation-skill',
      marketplaceRoot: '/app/cache/primary-runtime/versions/new/plugins/presentation-skill',
      marketplacePath:
        '/app/cache/primary-runtime/versions/new/plugins/presentation-skill/.agents/plugins/marketplace.json',
      pluginRoot:
        '/app/cache/primary-runtime/versions/new/plugins/presentation-skill/plugins/presentation-skill',
      pluginName: 'presentation-skill',
      sourceKind: 'primary-runtime',
      owner: 'primary-runtime:2'
    }
    const retired: BundledPluginDescriptor = {
      ...current,
      marketplaceRoot: '/app/cache/primary-runtime/versions/old/plugins/presentation-skill',
      marketplacePath:
        '/app/cache/primary-runtime/versions/old/plugins/presentation-skill/.agents/plugins/marketplace.json',
      pluginRoot:
        '/app/cache/primary-runtime/versions/old/plugins/presentation-skill/plugins/presentation-skill',
      owner: 'primary-runtime:1'
    }
    let retiredEnabled = true
    const responseFor = (
      entry: BundledPluginDescriptor,
      enabled: boolean
    ): PluginInstalledResponse => {
      const response = installedResponse(
        [
          {
            ...plugin({ installed: true, enabled }),
            id: 'presentation-skill@presentation-skill',
            name: 'presentation-skill'
          }
        ],
        entry.marketplacePath
      )
      response.marketplaces[0]!.name = entry.marketplaceName
      return response
    }
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async ({ cwd } = {}) =>
        cwd === retired.marketplaceRoot
          ? responseFor(retired, retiredEnabled)
          : responseFor(current, true)
      ),
      setPluginEnabled: vi.fn(async ({ pluginId, enabled }) => {
        if (pluginId === 'presentation-skill@presentation-skill' && !enabled) retiredEnabled = false
      })
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [current],
      retiredDescriptors: [retired]
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(result.reconciled).toContainEqual(
      expect.objectContaining({ descriptor: retired, action: 'retired' })
    )
    expect(client.setPluginEnabled).toHaveBeenCalledWith({
      pluginId: 'presentation-skill@presentation-skill',
      enabled: false
    })
  })

  it('fails degraded when install readback does not confirm the plugin', async () => {
    const client = catalogClient({
      listInstalledPluginsForManagement: vi.fn(async () => installedResponse([]))
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor],
      installAttempts: 1
    }).reconcile()

    expect(result.status).toBe('degraded')
    expect(result.failures).toMatchObject([
      {
        descriptor,
        stage: 'sync_plugins',
        message: expect.stringContaining('was not installed after reconcile')
      }
    ])
  })

  it('reports unavailable when the catalog client cannot read installed plugins', async () => {
    const result = await new BundledPluginManager({
      catalogClient: catalogClient({
        listInstalledPluginsForManagement: vi.fn(async () => {
          throw new Error('app-server unavailable')
        })
      }),
      descriptors: [descriptor]
    }).reconcile()

    expect(result).toMatchObject({
      status: 'unavailable',
      failures: [{ stage: 'sync_plugins', message: 'app-server unavailable' }]
    })
  })

  it('does not report success when the required skill reload fails', async () => {
    const client = catalogClient({
      listSkillsForManagement: vi.fn(async () => {
        throw new Error('skills reload failed')
      })
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor]
    }).reconcile()

    expect(result).toMatchObject({
      status: 'degraded',
      failures: [{ descriptor, stage: 'reload_skills', message: 'skills reload failed' }]
    })
  })

  it('synchronizes Runtime-owned skills after the marketplace and before the reload', async () => {
    const order: string[] = []
    const client = catalogClient({
      listSkillsForManagement: vi.fn(async () => {
        order.push('reload')
        return []
      })
    })

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor],
      syncRuntimeSkills: async () => {
        order.push('sync-skills')
      }
    }).reconcile()

    expect(result.status).toBe('ready')
    expect(order).toEqual(['sync-skills', 'reload'])
  })

  it('does not reload or report ready when Runtime-owned skill sync fails', async () => {
    const client = catalogClient()

    const result = await new BundledPluginManager({
      catalogClient: client,
      descriptors: [descriptor],
      syncRuntimeSkills: async () => {
        throw new Error('legacy skill move failed')
      }
    }).reconcile()

    expect(result).toMatchObject({
      status: 'degraded',
      failures: [{ stage: 'sync_skills', message: 'legacy skill move failed' }]
    })
    expect(client.listSkillsForManagement).not.toHaveBeenCalled()
  })

  it('exposes deterministic internal plugin ids for UI hiding', async () => {
    const manager = new BundledPluginManager({
      catalogClient: catalogClient(),
      descriptors: [descriptor]
    })

    expect(
      manager.internalPluginIds(installedResponse([plugin({ installed: true, enabled: true })]))
    ).toEqual(['codex-app-tools@dascowork-bundled'])
    expect(
      manager.isInternalPlugin({
        id: 'codex-app-tools@dascowork-bundled',
        marketplaceName: 'dascowork-bundled'
      })
    ).toBe(true)
    expect(
      manager.isInternalPlugin({
        id: 'codex-app-tools@third-party',
        name: 'codex-app-tools'
      })
    ).toBe(false)
  })
})

function catalogClient(
  overrides: Partial<BundledPluginCatalogClient> = {}
): BundledPluginCatalogClient {
  return {
    listInstalledPluginsForManagement: vi.fn(async () =>
      installedResponse([plugin({ installed: true, enabled: true })])
    ),
    listSkillsForManagement: vi.fn(async () => []),
    installPlugin: vi.fn(async () => ({})),
    setPluginEnabled: vi.fn(async () => ({})),
    ...overrides
  }
}

function installedResponse(
  plugins: ReturnType<typeof plugin>[],
  marketplacePath = descriptor.marketplacePath
): PluginInstalledResponse {
  return {
    marketplaces: [
      {
        name: 'dascowork-bundled',
        path: marketplacePath,
        interface: null,
        plugins
      }
    ],
    marketplaceLoadErrors: []
  } as PluginInstalledResponse
}

function plugin(
  overrides: Partial<{
    installed: boolean
    enabled: boolean
    localVersion: string
  }>
): PluginSummary {
  return {
    id: 'codex-app-tools@dascowork-bundled',
    remotePluginId: null,
    version: '0.1.0',
    localVersion: overrides.localVersion ?? '0.1.0',
    name: 'codex-app-tools',
    shareContext: null,
    source: {
      type: 'local',
      path: '/app/resources/plugins/dascowork-bundled/plugins/codex-app-tools'
    },
    installed: overrides.installed ?? true,
    installedAt: 1,
    enabled: overrides.enabled ?? true,
    installPolicy: 'AVAILABLE',
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: 'ON_USE',
    availability: 'AVAILABLE',
    disabledReason: null,
    eligiblePlanTypes: null,
    interface: null,
    keywords: []
  }
}
