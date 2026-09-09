import type { PluginInstalledResponse } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/PluginInstalledResponse'
import type { PluginSummary } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/PluginSummary'
import { describe, expect, it, vi } from 'vitest'

import { BundledPluginManager, type BundledPluginCatalogClient } from './BundledPluginManager'
import type { BundledPluginDescriptor } from './BundledPluginDescriptors'

const descriptor: BundledPluginDescriptor = {
  marketplaceName: 'openai-bundled',
  marketplaceRoot: '/app/resources/plugins/openai-bundled',
  marketplacePath: '/app/resources/plugins/openai-bundled/.agents/plugins/marketplace.json',
  pluginRoot: '/app/resources/plugins/openai-bundled/plugins/codex-app-tools',
  pluginName: 'codex-app-tools',
  version: '0.1.0',
  installWhenMissing: true,
  internal: true,
  sourceKind: 'app-resource'
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
      { action: 'installed', pluginId: 'codex-app-tools@openai-bundled' }
    ])
    expect(client.installPlugin).toHaveBeenCalledWith({
      marketplacePath: descriptor.marketplacePath,
      pluginName: descriptor.pluginName,
      installAttemptId: expect.any(String)
    })
    expect(client.listInstalledPluginsForManagement).toHaveBeenCalledWith({
      cwd: descriptor.marketplaceRoot
    })
    expect(invalidateCaches).toHaveBeenCalled()
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
      pluginId: 'codex-app-tools@openai-bundled',
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
      '/app/cache/primary-runtime/versions/old/plugins/openai-primary-runtime'
    )
    oldRuntimeMarketplace.marketplaces[0]!.name = 'openai-primary-runtime'
    const activeDescriptor: BundledPluginDescriptor = {
      ...descriptor,
      marketplaceName: 'openai-primary-runtime',
      marketplaceRoot: '/app/cache/primary-runtime/active/plugins/openai-primary-runtime',
      marketplacePath:
        '/app/cache/primary-runtime/active/plugins/openai-primary-runtime/.agents/plugins/marketplace.json',
      pluginRoot:
        '/app/cache/primary-runtime/active/plugins/openai-primary-runtime/plugins/presentations',
      pluginName: 'presentations',
      sourceKind: 'primary-runtime'
    }
    const installed = [
      oldRuntimeMarketplace,
      installedResponse(
        [
          {
            ...plugin({ installed: true, enabled: true }),
            id: 'presentations@openai-primary-runtime',
            name: 'presentations'
          }
        ],
        activeDescriptor.marketplacePath
      )
    ]
    installed[1]!.marketplaces[0]!.name = 'openai-primary-runtime'
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
      failures: [{ message: 'app-server unavailable' }]
    })
  })

  it('exposes deterministic internal plugin ids for UI hiding', async () => {
    const manager = new BundledPluginManager({
      catalogClient: catalogClient(),
      descriptors: [descriptor]
    })

    expect(
      manager.internalPluginIds(installedResponse([plugin({ installed: true, enabled: true })]))
    ).toEqual(['codex-app-tools@openai-bundled'])
    expect(
      manager.isInternalPlugin({
        id: 'codex-app-tools@openai-bundled',
        marketplaceName: 'openai-bundled'
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
        name: 'openai-bundled',
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
    id: 'codex-app-tools@openai-bundled',
    remotePluginId: null,
    version: '0.1.0',
    localVersion: overrides.localVersion ?? '0.1.0',
    name: 'codex-app-tools',
    shareContext: null,
    source: {
      type: 'local',
      path: '/app/resources/plugins/openai-bundled/plugins/codex-app-tools'
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
