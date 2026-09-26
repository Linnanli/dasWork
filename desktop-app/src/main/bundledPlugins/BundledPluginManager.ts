import { randomUUID } from 'node:crypto'

import type { PluginInstalledResponse } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/PluginInstalledResponse'
import type { PluginSummary } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/PluginSummary'

import type { BundledPluginDescriptor } from './BundledPluginDescriptors'

export type BundledPluginCatalogClient = {
  listInstalledPluginsForManagement(input?: { cwd?: string }): Promise<PluginInstalledResponse>
  listSkillsForManagement(input: { cwd?: string; forceReload?: boolean }): Promise<unknown>
  installPlugin(input: {
    marketplacePath?: string | null
    remoteMarketplaceName?: string | null
    installAttemptId?: string | null
    pluginName: string
  }): Promise<unknown>
  setPluginEnabled(input: { cwd?: string; pluginId: string; enabled: boolean }): Promise<unknown>
}

export type BundledPluginReconcileAction =
  | 'installed'
  | 'updated'
  | 'enabled'
  | 'unchanged'
  | 'retired'

export type BundledPluginReconcileItem = {
  descriptor: BundledPluginDescriptor
  pluginId?: string
  action: BundledPluginReconcileAction
}

export type BundledPluginReconcileFailure = {
  descriptor: BundledPluginDescriptor
  stage: 'sync_plugins' | 'sync_skills' | 'reload_skills'
  message: string
}

export type BundledPluginReconcileResult = {
  status: 'ready' | 'degraded' | 'unavailable'
  reconciled: BundledPluginReconcileItem[]
  failures: BundledPluginReconcileFailure[]
}

export type BundledPluginIdentity = {
  id?: string
  name?: string
  marketplaceName?: string
}

export function isInternalBundledPlugin(
  descriptors: readonly BundledPluginDescriptor[],
  input: BundledPluginIdentity
): boolean {
  return descriptors.some(
    (descriptor) =>
      descriptor.internal &&
      (input.id === `${descriptor.pluginName}@${descriptor.marketplaceName}` ||
        (input.name === descriptor.pluginName &&
          input.marketplaceName === descriptor.marketplaceName))
  )
}

export class BundledPluginManager {
  private readonly descriptors: readonly BundledPluginDescriptor[]
  private readonly installAttempts: number

  constructor(
    private readonly input: {
      catalogClient: BundledPluginCatalogClient
      descriptors: readonly BundledPluginDescriptor[]
      /** Previously committed Runtime-owned descriptors to retire after a successful desired set. */
      retiredDescriptors?: readonly BundledPluginDescriptor[]
      cwd?: string
      invalidateCaches?: () => Promise<void> | void
      installAttempts?: number
      /** Runtime-owned standalone skills must be reconciled after plugins and before reload. */
      syncRuntimeSkills?: () => Promise<void>
    }
  ) {
    this.descriptors = input.descriptors
    this.installAttempts = input.installAttempts ?? 2
  }

  internalPluginIds(installed?: PluginInstalledResponse): string[] {
    if (!installed) return []
    return this.descriptors
      .filter((descriptor) => descriptor.internal)
      .flatMap((descriptor) => {
        const plugin = findInstalledPlugin(installed, descriptor)
        return plugin ? [plugin.id] : []
      })
      .sort()
  }

  isInternalPlugin(input: BundledPluginIdentity): boolean {
    return isInternalBundledPlugin(this.descriptors, input)
  }

  async reconcile(): Promise<BundledPluginReconcileResult> {
    const reconciled: BundledPluginReconcileItem[] = []
    const failures: BundledPluginReconcileFailure[] = []
    let catalogReadFailures = 0

    for (const descriptor of this.descriptors) {
      if (!descriptor.installWhenMissing) continue
      let installed: PluginInstalledResponse
      try {
        installed = await this.readInstalled(descriptor)
      } catch (error) {
        catalogReadFailures += 1
        failures.push({ descriptor, stage: 'sync_plugins', message: messageFor(error) })
        continue
      }
      try {
        const result = await this.reconcileOne(descriptor, installed)
        reconciled.push(result.item)
        installed = result.installed
      } catch (error) {
        failures.push({ descriptor, stage: 'sync_plugins', message: messageFor(error) })
      }
    }

    for (const descriptor of this.input.retiredDescriptors ?? []) {
      if (this.descriptors.some((current) => sameBundledPluginIdentity(current, descriptor)))
        continue
      try {
        const item = await this.retireOne(descriptor)
        if (item) reconciled.push(item)
      } catch (error) {
        failures.push({ descriptor, stage: 'sync_plugins', message: messageFor(error) })
      }
    }

    // Keep the reference ordering: marketplace reconcile, Runtime-owned skill
    // sync/removal, then an app-server skill reload. A failure at any stage
    // prevents this active Runtime from being reported as plugin-ready.
    if (failures.length === 0 && this.descriptors.length > 0) {
      try {
        await this.input.syncRuntimeSkills?.()
      } catch (error) {
        failures.push({
          descriptor: this.descriptors[0]!,
          stage: 'sync_skills',
          message: messageFor(error)
        })
      }
    }

    if (failures.length === 0 && this.descriptors.length > 0) {
      try {
        await this.input.catalogClient.listSkillsForManagement({ forceReload: true })
      } catch (error) {
        failures.push({
          descriptor: this.descriptors[0]!,
          stage: 'reload_skills',
          message: messageFor(error)
        })
      }
    }

    return {
      status:
        failures.length === 0
          ? 'ready'
          : catalogReadFailures ===
              this.descriptors.filter((entry) => entry.installWhenMissing).length
            ? 'unavailable'
            : 'degraded',
      reconciled,
      failures
    }
  }

  private async reconcileOne(
    descriptor: BundledPluginDescriptor,
    installed: PluginInstalledResponse
  ): Promise<{ item: BundledPluginReconcileItem; installed: PluginInstalledResponse }> {
    let plugin = findInstalledPlugin(installed, descriptor)
    let action: BundledPluginReconcileAction = 'unchanged'

    if (!plugin || !plugin.installed) {
      await this.installWithRetry(descriptor)
      await this.invalidateCaches()
      installed = await this.readInstalled(descriptor)
      plugin = findInstalledPlugin(installed, descriptor)
      action = 'installed'
    } else if (!isExpectedVersion(plugin, descriptor.version)) {
      await this.installWithRetry(descriptor)
      await this.invalidateCaches()
      installed = await this.readInstalled(descriptor)
      plugin = findInstalledPlugin(installed, descriptor)
      action = 'updated'
    }

    if (!plugin?.installed) {
      throw new Error(`Bundled plugin ${descriptor.pluginName} was not installed after reconcile.`)
    }

    if (!isExpectedVersion(plugin, descriptor.version)) {
      throw new Error(`Bundled plugin ${descriptor.pluginName} version readback failed.`)
    }

    if (!plugin.enabled) {
      await this.input.catalogClient.setPluginEnabled({
        ...(this.input.cwd ? { cwd: this.input.cwd } : {}),
        pluginId: plugin.id,
        enabled: true
      })
      await this.invalidateCaches()
      installed = await this.readInstalled(descriptor)
      plugin = findInstalledPlugin(installed, descriptor)
      action = action === 'unchanged' ? 'enabled' : action
    }

    if (!plugin?.enabled) {
      throw new Error(`Bundled plugin ${descriptor.pluginName} was not enabled after reconcile.`)
    }

    return {
      item: { descriptor, pluginId: plugin.id, action },
      installed
    }
  }

  private async installWithRetry(descriptor: BundledPluginDescriptor): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < this.installAttempts; attempt += 1) {
      try {
        await this.input.catalogClient.installPlugin({
          marketplacePath: descriptor.marketplacePath,
          installAttemptId: randomUUID(),
          pluginName: descriptor.pluginName
        })
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  private async retireOne(
    descriptor: BundledPluginDescriptor
  ): Promise<BundledPluginReconcileItem | undefined> {
    if (!descriptor.internal || descriptor.sourceKind !== 'primary-runtime') return undefined
    let installed = await this.readInstalled(descriptor)
    let plugin = findInstalledPlugin(installed, descriptor)
    if (!plugin?.installed || !plugin.enabled) return undefined

    await this.input.catalogClient.setPluginEnabled({
      ...(this.input.cwd ? { cwd: this.input.cwd } : {}),
      pluginId: plugin.id,
      enabled: false
    })
    await this.invalidateCaches()
    installed = await this.readInstalled(descriptor)
    plugin = findInstalledPlugin(installed, descriptor)
    if (plugin?.enabled) {
      throw new Error(`Retired Primary Runtime plugin ${descriptor.pluginName} remained enabled.`)
    }
    return { descriptor, pluginId: plugin?.id, action: 'retired' }
  }

  private async readInstalled(
    descriptor: BundledPluginDescriptor
  ): Promise<PluginInstalledResponse> {
    return this.input.catalogClient.listInstalledPluginsForManagement({
      cwd: descriptor.marketplaceRoot
    })
  }

  private async invalidateCaches(): Promise<void> {
    await this.input.invalidateCaches?.()
  }
}

function findInstalledPlugin(
  installed: PluginInstalledResponse,
  descriptor: BundledPluginDescriptor
): PluginSummary | undefined {
  const marketplace = installed.marketplaces.find(
    (entry) =>
      entry.name === descriptor.marketplaceName &&
      entry.path !== null &&
      entry.path === descriptor.marketplacePath
  )
  return marketplace?.plugins.find((plugin) => plugin.name === descriptor.pluginName)
}

function isExpectedVersion(plugin: PluginSummary, version: string): boolean {
  return (plugin.localVersion ?? plugin.version) === version
}

function sameBundledPluginIdentity(
  left: BundledPluginDescriptor,
  right: BundledPluginDescriptor
): boolean {
  return left.marketplaceName === right.marketplaceName && left.pluginName === right.pluginName
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
