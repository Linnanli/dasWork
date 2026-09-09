import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { z } from 'zod'

import type { PrimaryRuntimeDiagnostic } from '../primaryRuntime'

const bundleFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mode: z.literal('executable').optional()
})

const bundleProvenanceSchema = z
  .object({
    kind: z.literal('repo-owned'),
    sourcePath: z.string().regex(/^desktop-app\/(?!\.\.?\/)(?!.*\/\.\.?\/)[a-zA-Z0-9._/-]+$/u),
    licensePath: z.string().regex(/^(?!\.\.?\/)(?!.*\/\.\.?\/)[a-zA-Z0-9._/-]+$/u),
    reviewStatus: z.enum(['pending-independent-review', 'approved'])
  })
  .strict()

const bundlePluginSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  installWhenMissing: z.boolean(),
  internal: z.boolean(),
  provenance: bundleProvenanceSchema,
  files: z.array(bundleFileSchema).min(1)
})

const bundleLockSchema = z
  .object({
    bundleFormatVersion: z.literal(2),
    marketplace: z.object({
      name: z.string().min(1),
      pluginRoot: z.string().min(1)
    }),
    plugins: z.array(bundlePluginSchema).min(1)
  })
  .strict()

const marketplacePluginSchema = z.object({
  name: z.string().min(1),
  source: z.object({
    source: z.literal('local'),
    path: z.string().min(1)
  })
})

const marketplaceSchema = z
  .object({
    name: z.string().min(1),
    plugins: z.array(marketplacePluginSchema).min(1)
  })
  .passthrough()

const pluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1)
  })
  .passthrough()

export type BundledPluginSourceKind = 'app-resource' | 'primary-runtime'

export type BundledPluginDescriptor = {
  marketplaceName: string
  marketplaceRoot: string
  marketplacePath: string
  pluginRoot: string
  pluginName: string
  version: string
  installWhenMissing: boolean
  internal: boolean
  sourceKind: BundledPluginSourceKind
}

export type BundledPluginLock = z.infer<typeof bundleLockSchema>

type LocalMarketplace = {
  path: string
  manifest: z.infer<typeof marketplaceSchema>
}

export async function readBundledPluginDescriptorsFromMarketplaceRoot(
  marketplacePath: string,
  sourceKind: BundledPluginSourceKind
): Promise<BundledPluginDescriptor[]> {
  const root = await realpath(resolve(marketplacePath))
  const marketplace = await readMarketplace(root)
  const lock = await readBundleLock(root)
  if (!lock) return readMarketplaceDescriptors(root, sourceKind, marketplace)
  return descriptorsFromBundleLock(root, sourceKind, lock, marketplace)
}

async function readMarketplace(root: string): Promise<LocalMarketplace> {
  const path = await realpath(join(root, '.agents', 'plugins', 'marketplace.json'))
  if (!isPathInside(root, path)) {
    throw new Error('Marketplace manifest escapes marketplace.')
  }
  return {
    path,
    manifest: marketplaceSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }
}

async function readBundleLock(root: string): Promise<BundledPluginLock | null> {
  try {
    return parseBundledPluginLock(
      JSON.parse(await readFile(join(root, 'bundle-lock.json'), 'utf8'))
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function descriptorsFromBundleLock(
  root: string,
  sourceKind: BundledPluginSourceKind,
  lock: BundledPluginLock,
  marketplace: LocalMarketplace
): Promise<BundledPluginDescriptor[]> {
  if (marketplace.manifest.name !== lock.marketplace.name) {
    throw new Error('Bundle lock marketplace name does not match marketplace manifest.')
  }
  if (
    marketplace.manifest.plugins.length !== lock.plugins.length ||
    lock.plugins.some(
      (plugin) => !marketplace.manifest.plugins.some((entry) => entry.name === plugin.name)
    )
  ) {
    throw new Error('Bundle lock plugins do not match marketplace manifest.')
  }
  const pluginsRoot = await realpath(resolve(root, lock.marketplace.pluginRoot))
  if (!isPathInside(root, pluginsRoot)) {
    throw new Error('Bundled plugin root escapes marketplace.')
  }

  return Promise.all(
    lock.plugins.map(async (plugin) => {
      const pluginRoot = await realpath(resolve(pluginsRoot, plugin.name))
      if (!isPathInside(pluginsRoot, pluginRoot)) {
        throw new Error('Bundled plugin path escapes marketplace.')
      }
      const marketplaceEntry = marketplace.manifest.plugins.find(
        (entry) => entry.name === plugin.name
      )
      if (!marketplaceEntry) {
        throw new Error(`Marketplace entry for ${plugin.name} is missing.`)
      }
      const marketplacePluginRoot = await realpath(resolve(root, marketplaceEntry.source.path))
      if (marketplacePluginRoot !== pluginRoot) {
        throw new Error(`Marketplace path for ${plugin.name} does not match its bundle lock.`)
      }
      return {
        marketplaceName: lock.marketplace.name,
        marketplaceRoot: root,
        marketplacePath: marketplace.path,
        pluginRoot,
        pluginName: plugin.name,
        version: plugin.version,
        installWhenMissing: plugin.installWhenMissing,
        internal: plugin.internal,
        sourceKind
      }
    })
  )
}

async function readMarketplaceDescriptors(
  root: string,
  sourceKind: BundledPluginSourceKind,
  marketplace: LocalMarketplace
): Promise<BundledPluginDescriptor[]> {
  const descriptors: BundledPluginDescriptor[] = []
  for (const plugin of marketplace.manifest.plugins) {
    const pluginRoot = await realpath(resolve(root, plugin.source.path))
    if (!isPathInside(root, pluginRoot)) {
      throw new Error('Marketplace plugin root escapes marketplace.')
    }
    const pluginManifest = pluginManifestSchema.parse(
      JSON.parse(await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'))
    )
    if (pluginManifest.name !== plugin.name) {
      throw new Error(
        `Marketplace plugin name ${plugin.name} does not match manifest name ${pluginManifest.name}.`
      )
    }
    descriptors.push({
      marketplaceName: marketplace.manifest.name,
      marketplaceRoot: root,
      marketplacePath: marketplace.path,
      pluginRoot,
      pluginName: pluginManifest.name,
      version: pluginManifest.version,
      installWhenMissing: true,
      internal: true,
      sourceKind
    })
  }
  return descriptors
}

export function parseBundledPluginLock(input: unknown): BundledPluginLock {
  return bundleLockSchema.parse(input)
}

export async function readAppBundledPluginDescriptors(
  options: { isPackaged: false; appPath: string } | { isPackaged: true; resourcesPath: string }
): Promise<BundledPluginDescriptor[]> {
  const marketplacePath = options.isPackaged
    ? join(options.resourcesPath, 'plugins', 'openai-bundled')
    : join(options.appPath, 'resources', 'bundled-plugins', 'openai-bundled')
  return readBundledPluginDescriptorsFromMarketplaceRoot(marketplacePath, 'app-resource')
}

export async function readPrimaryRuntimeBundledPluginDescriptors(
  diagnostic: PrimaryRuntimeDiagnostic
): Promise<BundledPluginDescriptor[]> {
  if (diagnostic.status !== 'ready' || !diagnostic.root || !diagnostic.manifest?.bundledPlugins) {
    return []
  }

  const descriptors: BundledPluginDescriptor[] = []
  for (const marketplace of diagnostic.manifest.bundledPlugins) {
    descriptors.push(
      ...(await readBundledPluginDescriptorsFromMarketplaceRoot(
        join(diagnostic.root, marketplace.path),
        'primary-runtime'
      ))
    )
  }
  return descriptors
}

function isPathInside(root: string, candidate: string): boolean {
  const difference = relative(root, candidate)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}
