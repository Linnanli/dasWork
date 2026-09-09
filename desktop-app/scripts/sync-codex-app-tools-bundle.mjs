#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executable bundle script validates its runtime inputs directly. */
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'LICENSE',
  'server.mjs',
  'scripts/launch_codex_app_tools_mcp',
  'scripts/launch_codex_app_tools_mcp.cmd'
]

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDirectory, '..')
const targetMarketplaceRoot = join(appRoot, 'resources', 'bundled-plugins', 'openai-bundled')
const targetPluginRoot = join(targetMarketplaceRoot, 'plugins', 'codex-app-tools')
const targetMarketplaceManifestPath = join(
  targetMarketplaceRoot,
  '.agents',
  'plugins',
  'marketplace.json'
)

/** @returns {Promise<void>} */
async function main() {
  if (process.argv.length !== 2) {
    throw new Error(
      'This command only regenerates the repository-owned Codex App Tools bundle lock; external --source input is not supported.'
    )
  }

  const manifest = await readJson(join(targetPluginRoot, '.codex-plugin', 'plugin.json'))
  if (
    manifest.name !== 'codex-app-tools' ||
    typeof manifest.version !== 'string' ||
    !manifest.version
  ) {
    throw new Error('The repository-owned Codex App Tools manifest is invalid.')
  }
  const marketplace = await readJson(targetMarketplaceManifestPath)
  const marketplaceEntries = Array.isArray(marketplace.plugins)
    ? marketplace.plugins.filter((plugin) => plugin?.name === manifest.name)
    : []
  if (
    marketplace.name !== 'openai-bundled' ||
    marketplaceEntries.length !== 1 ||
    marketplaceEntries[0].source?.source !== 'local' ||
    marketplaceEntries[0].source?.path !== './plugins/codex-app-tools'
  ) {
    throw new Error('The repository-owned Codex App Tools marketplace manifest is invalid.')
  }

  const files = await Promise.all(
    REQUIRED_FILES.map(async (path) => {
      const filePath = join(targetPluginRoot, path)
      const file = await stat(filePath)
      if (!file.isFile()) throw new Error(`Required bundle file is missing: ${path}`)
      return {
        path,
        sha256: await sha256File(filePath),
        ...(path === 'scripts/launch_codex_app_tools_mcp' ? { mode: 'executable' } : {})
      }
    })
  )

  const lock = {
    bundleFormatVersion: 2,
    marketplace: { name: 'openai-bundled', pluginRoot: 'plugins' },
    plugins: [
      {
        name: manifest.name,
        version: manifest.version,
        installWhenMissing: true,
        internal: true,
        provenance: {
          kind: 'repo-owned',
          sourcePath:
            'desktop-app/resources/bundled-plugins/openai-bundled/plugins/codex-app-tools',
          licensePath: 'LICENSE',
          reviewStatus: 'pending-independent-review'
        },
        files
      }
    ]
  }
  await writeFile(
    join(targetMarketplaceRoot, 'bundle-lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
    'utf8'
  )
}

/**
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function sha256File(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
