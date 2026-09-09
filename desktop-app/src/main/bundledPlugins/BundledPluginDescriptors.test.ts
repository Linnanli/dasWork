import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  BundledPluginManager,
  parseBundledPluginLock,
  readAppBundledPluginDescriptors,
  readBundledPluginDescriptorsFromMarketplaceRoot
} from './index'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('BundledPluginDescriptors', () => {
  it('exports every public Phase 4 bundled plugin surface from the index', () => {
    expect(BundledPluginManager).toBeTypeOf('function')
    expect(parseBundledPluginLock).toBeTypeOf('function')
    expect(readAppBundledPluginDescriptors).toBeTypeOf('function')
    expect(readBundledPluginDescriptorsFromMarketplaceRoot).toBeTypeOf('function')
  })

  it('parses locked marketplace descriptors into data-driven install inputs', async () => {
    const marketplaceRoot = await fixtureMarketplace()

    await expect(
      readBundledPluginDescriptorsFromMarketplaceRoot(marketplaceRoot, 'app-resource')
    ).resolves.toEqual([
      {
        marketplaceName: 'openai-bundled',
        marketplaceRoot,
        marketplacePath: join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        pluginRoot: join(marketplaceRoot, 'plugins', 'codex-app-tools'),
        pluginName: 'codex-app-tools',
        version: '0.2.0',
        installWhenMissing: true,
        internal: true,
        sourceKind: 'app-resource'
      }
    ])
  })

  it('reads app-bundled plugins from the repository resource layout in development', async () => {
    const appRoot = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-development-app-')))
    directories.push(appRoot)
    const marketplaceRoot = join(appRoot, 'resources', 'bundled-plugins', 'openai-bundled')
    await writeFixtureMarketplace(marketplaceRoot)

    const descriptors = await readAppBundledPluginDescriptors({
      appPath: appRoot,
      isPackaged: false
    })

    expect(descriptors[0]?.marketplacePath).toBe(
      join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')
    )
  })

  it('reads app-bundled plugins from the installed resource layout when packaged', async () => {
    const resourcesPath = await realpath(
      await mkdtemp(join(tmpdir(), 'dascowork-packaged-resources-'))
    )
    directories.push(resourcesPath)
    const marketplaceRoot = join(resourcesPath, 'plugins', 'openai-bundled')
    await writeFixtureMarketplace(marketplaceRoot)

    const descriptors = await readAppBundledPluginDescriptors({
      isPackaged: true,
      resourcesPath
    })

    expect(descriptors[0]?.marketplacePath).toBe(
      join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')
    )
  })

  it('parses Primary Runtime marketplace descriptors without a bundle lock', async () => {
    const marketplaceRoot = await fixtureRuntimeMarketplace()

    await expect(
      readBundledPluginDescriptorsFromMarketplaceRoot(marketplaceRoot, 'primary-runtime')
    ).resolves.toEqual([
      {
        marketplaceName: 'openai-primary-runtime',
        marketplaceRoot,
        marketplacePath: join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        pluginRoot: join(marketplaceRoot, 'plugins', 'presentations'),
        pluginName: 'presentations',
        version: '26.904.11930',
        installWhenMissing: true,
        internal: true,
        sourceKind: 'primary-runtime'
      }
    ])
  })

  it('rejects marketplace entries that do not match their plugin manifests', async () => {
    const marketplaceRoot = await fixtureRuntimeMarketplace({
      marketplacePluginName: 'presentations',
      manifestPluginName: 'documents'
    })

    await expect(
      readBundledPluginDescriptorsFromMarketplaceRoot(marketplaceRoot, 'primary-runtime')
    ).rejects.toThrow('does not match manifest name')
  })

  it('rejects marketplace plugin symlinks that resolve outside the marketplace', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-runtime-marketplace-')))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-runtime-outside-')))
    directories.push(root, outside)
    await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
    await mkdir(join(root, 'plugins'), { recursive: true })
    await mkdir(join(outside, '.codex-plugin'), { recursive: true })
    await writeFile(
      join(root, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({
        name: 'openai-primary-runtime',
        plugins: [
          {
            name: 'presentations',
            source: { source: 'local', path: './plugins/presentations' }
          }
        ]
      })
    )
    await writeFile(
      join(outside, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'presentations', version: '26.904.11930' })
    )
    await symlink(outside, join(root, 'plugins', 'presentations'), 'dir')

    await expect(
      readBundledPluginDescriptorsFromMarketplaceRoot(root, 'primary-runtime')
    ).rejects.toThrow('escapes marketplace')
  })

  it('rejects malformed locks before reconcile can trust them', () => {
    expect(() =>
      parseBundledPluginLock({
        bundleFormatVersion: 2,
        marketplace: { name: 'openai-bundled', pluginRoot: 'plugins' },
        plugins: [
          {
            name: 'codex-app-tools',
            version: '0.2.0',
            installWhenMissing: true,
            internal: true,
            provenance: {
              kind: 'repo-owned',
              sourcePath:
                'desktop-app/resources/bundled-plugins/openai-bundled/plugins/codex-app-tools',
              licensePath: '../LICENSE',
              reviewStatus: 'approved'
            },
            files: [{ path: '../server.mjs', sha256: 'not-a-sha' }]
          }
        ]
      })
    ).toThrow()
  })
})

async function fixtureMarketplace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-bundled-marketplace-')))
  directories.push(root)
  await writeFixtureMarketplace(root)
  return root
}

async function writeFixtureMarketplace(root: string): Promise<void> {
  await mkdir(join(root, 'plugins', 'codex-app-tools'), { recursive: true })
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
  await writeFile(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'openai-bundled',
      plugins: [
        {
          name: 'codex-app-tools',
          source: { source: 'local', path: './plugins/codex-app-tools' }
        }
      ]
    })
  )
  await writeFile(
    join(root, 'bundle-lock.json'),
    JSON.stringify({
      bundleFormatVersion: 2,
      marketplace: { name: 'openai-bundled', pluginRoot: 'plugins' },
      plugins: [
        {
          name: 'codex-app-tools',
          version: '0.2.0',
          installWhenMissing: true,
          internal: true,
          provenance: {
            kind: 'repo-owned',
            sourcePath:
              'desktop-app/resources/bundled-plugins/openai-bundled/plugins/codex-app-tools',
            licensePath: 'LICENSE',
            reviewStatus: 'pending-independent-review'
          },
          files: [
            {
              path: 'server.mjs',
              sha256: '2a5a64f192b672261e9bb22ebf2a84d550714ba002f58e5a89eeeaca951da222'
            }
          ]
        }
      ]
    })
  )
}

async function fixtureRuntimeMarketplace(
  options: { marketplacePluginName?: string; manifestPluginName?: string } = {}
): Promise<string> {
  const marketplacePluginName = options.marketplacePluginName ?? 'presentations'
  const manifestPluginName = options.manifestPluginName ?? marketplacePluginName
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-runtime-marketplace-')))
  directories.push(root)
  await mkdir(join(root, '.agents', 'plugins'), { recursive: true })
  await mkdir(join(root, 'plugins', marketplacePluginName, '.codex-plugin'), { recursive: true })
  await writeFile(
    join(root, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({
      name: 'openai-primary-runtime',
      plugins: [
        {
          name: marketplacePluginName,
          source: { source: 'local', path: `./plugins/${marketplacePluginName}` }
        }
      ]
    })
  )
  await writeFile(
    join(root, 'plugins', marketplacePluginName, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: manifestPluginName, version: '26.904.11930' })
  )
  return root
}
