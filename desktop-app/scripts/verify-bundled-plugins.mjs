#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runtime validation makes JSDoc return annotations redundant in this executable verifier. */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const KNOWN_PROPRIETARY_SERVER_SHA256 =
  '2a5a64f192b672261e9bb22ebf2a84d550714ba002f58e5a89eeeaca951da222'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDirectory, '..')
const repoRoot = resolve(appRoot, '..')
const marketplaceRoot = resolve(appRoot, 'resources', 'bundled-plugins', 'openai-bundled')
const lockPath = join(marketplaceRoot, 'bundle-lock.json')
const marketplaceManifestRelativePath = '.agents/plugins/marketplace.json'
const marketplaceManifestPath = join(marketplaceRoot, marketplaceManifestRelativePath)

/** @returns {Promise<void>} */
async function main() {
  const publicRelease = publicReleaseMode(process.argv.slice(2))
  const lock = JSON.parse(await readFile(lockPath, 'utf8'))
  assert(lock.bundleFormatVersion === 2, 'bundle-lock.json must use bundleFormatVersion 2')
  assert(
    lock.marketplace?.name === 'openai-bundled',
    'bundle-lock.json marketplace must be openai-bundled'
  )
  assert(
    Array.isArray(lock.plugins) && lock.plugins.length > 0,
    'bundle-lock.json must list plugins'
  )
  const marketplace = JSON.parse(await readFile(marketplaceManifestPath, 'utf8'))
  assert(
    marketplace.name === lock.marketplace.name,
    'marketplace manifest name must match bundle-lock.json'
  )
  assert(Array.isArray(marketplace.plugins), 'marketplace manifest must list plugins')

  const allowedFiles = new Set(['bundle-lock.json', marketplaceManifestRelativePath])
  const pluginNames = new Set()
  for (const plugin of lock.plugins) {
    assert(typeof plugin.name === 'string' && plugin.name.length > 0, 'plugin name is required')
    assert(!pluginNames.has(plugin.name), `Duplicate bundled plugin: ${plugin.name}`)
    pluginNames.add(plugin.name)
    assert(
      typeof plugin.version === 'string' && plugin.version.length > 0,
      `${plugin.name} version is required`
    )
    assert(plugin.installWhenMissing === true, `${plugin.name} must opt into installWhenMissing`)
    assert(plugin.internal === true, `${plugin.name} must be internal`)
    assertRepoOwnedProvenance(plugin, publicRelease)
    assert(Array.isArray(plugin.files) && plugin.files.length > 0, `${plugin.name} must list files`)

    const pluginRoot = containedPath(marketplaceRoot, join('plugins', plugin.name))
    const marketplaceEntries = marketplace.plugins.filter((entry) => entry?.name === plugin.name)
    assert(
      marketplaceEntries.length === 1,
      `${plugin.name} must have exactly one marketplace manifest entry`
    )
    assert(
      marketplaceEntries[0].source?.source === 'local' &&
        marketplaceEntries[0].source?.path === `./plugins/${plugin.name}`,
      `${plugin.name} marketplace source must point to its bundled plugin root`
    )
    assert(
      resolve(repoRoot, plugin.provenance.sourcePath) === pluginRoot,
      `${plugin.name} provenance source must be its repository-owned plugin root`
    )
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')
    )
    assert(manifest.name === plugin.name, `${plugin.name} manifest name mismatch`)
    assert(manifest.version === plugin.version, `${plugin.name} manifest version mismatch`)
    assert(
      typeof manifest.author?.name === 'string' && manifest.author.name.length > 0,
      `${plugin.name} manifest author is required`
    )
    assert(
      typeof manifest.license === 'string' && manifest.license.length > 0,
      `${plugin.name} manifest license is required`
    )

    const declaredPaths = new Set()
    for (const file of plugin.files) {
      assert(
        typeof file.path === 'string' && file.path.length > 0,
        `${plugin.name} has invalid file path`
      )
      assert(!declaredPaths.has(file.path), `${plugin.name}/${file.path} is listed more than once`)
      declaredPaths.add(file.path)
      assert(
        /^[a-f0-9]{64}$/u.test(String(file.sha256)),
        `${plugin.name}/${file.path} has invalid sha256`
      )
      assert(
        file.sha256 !== KNOWN_PROPRIETARY_SERVER_SHA256,
        `${plugin.name}/${file.path} uses a forbidden proprietary server digest`
      )
      const relativeFile = join('plugins', plugin.name, file.path)
      allowedFiles.add(relativeFile)
      const absoluteFile = containedPath(marketplaceRoot, relativeFile)
      const stats = await stat(absoluteFile)
      assert(stats.isFile(), `${relativeFile} must be a file`)
      const actualSha = await sha256File(absoluteFile)
      assert(
        actualSha === file.sha256,
        `${relativeFile} SHA mismatch: expected ${file.sha256}, got ${actualSha}`
      )
      if (file.mode === 'executable' && process.platform !== 'win32') {
        assert((stats.mode & 0o111) !== 0, `${relativeFile} must be executable`)
      }
    }

    assert(
      declaredPaths.has(plugin.provenance.licensePath),
      `${plugin.name} provenance license must be a declared bundle file`
    )
  }

  assert(
    marketplace.plugins.length === pluginNames.size,
    'marketplace manifest plugins must match bundle-lock.json'
  )

  const actualFiles = await listFiles(marketplaceRoot)
  const unexpected = actualFiles.filter((path) => !allowedFiles.has(path))
  const missing = [...allowedFiles].filter((path) => !actualFiles.includes(path))
  assert(unexpected.length === 0, `Unexpected bundled plugin files:\n${unexpected.join('\n')}`)
  assert(missing.length === 0, `Missing bundled plugin files:\n${missing.join('\n')}`)
  console.log(`Bundled plugin resources verified: ${actualFiles.length} files`)
}

/**
 * @param {unknown} plugin
 * @returns {void}
 */
function assertRepoOwnedProvenance(plugin, publicRelease) {
  assert(plugin && typeof plugin === 'object', 'bundle plugin must be an object')
  const provenance = plugin.provenance
  assert(provenance && typeof provenance === 'object', `${plugin.name} provenance is required`)
  assert(provenance.kind === 'repo-owned', `${plugin.name} provenance must be repo-owned`)
  assert(
    isSafeRepoSourcePath(provenance.sourcePath),
    `${plugin.name} provenance source must stay inside desktop-app and outside reference-projects`
  )
  assert(
    isSafeBundleRelativePath(provenance.licensePath),
    `${plugin.name} provenance license path is unsafe`
  )
  if (publicRelease) {
    assert(
      provenance.reviewStatus === 'approved',
      `${plugin.name} provenance has not passed independent review for public release`
    )
  }
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function publicReleaseMode(args) {
  if (args.length === 0) return false
  if (args.length === 1 && args[0] === '--public-release') return true
  throw new Error('Usage: node scripts/verify-bundled-plugins.mjs [--public-release]')
}

/**
 * @param {unknown} path
 * @returns {boolean}
 */
function isSafeRepoSourcePath(path) {
  return (
    typeof path === 'string' &&
    path.startsWith('desktop-app/') &&
    !path.includes('reference-projects/') &&
    isSafeBundleRelativePath(path)
  )
}

/**
 * @param {unknown} path
 * @returns {boolean}
 */
function isSafeBundleRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]+/u).some((segment) => segment === '.' || segment === '..')
  )
}

/**
 * @param {string} root
 * @param {string} path
 * @returns {string}
 */
function containedPath(root, path) {
  if (!isSafeBundleRelativePath(path)) {
    throw new Error(`Unsafe bundle path: ${path}`)
  }
  const candidate = resolve(root, path)
  const diff = relative(root, candidate)
  if (diff.startsWith('..') || isAbsolute(diff)) {
    throw new Error(`Bundle path escapes root: ${path}`)
  }
  return candidate
}

/**
 * @param {string} root
 * @param {string} [base]
 * @returns {Promise<string[]>}
 */
async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolutePath = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, base)))
      continue
    }
    if (entry.isFile()) files.push(relative(base, absolutePath))
  }
  return files.sort()
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function sha256File(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
