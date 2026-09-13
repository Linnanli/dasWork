import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { DesktopHostCapabilityRuntime } from '../appTools/DesktopHostCapabilityRuntime'
import { readPrimaryRuntimeBundledPluginDescriptors } from '../bundledPlugins'
import { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import { PrimaryRuntimeService } from './PrimaryRuntimeService'

const candidateArchive = process.env.DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_ARCHIVE?.trim()
const candidateVersion = process.env.DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_VERSION?.trim()
const candidateSha256 = process.env.DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_SHA256?.trim().toLowerCase()
const realRuntimeSmokeEnabled = process.env.DASCOWORK_REAL_PRIMARY_RUNTIME_SMOKE === '1'
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRuntimeCache))
}, 90_000)

describe.skipIf(!realRuntimeSmokeEnabled)('Primary Runtime real integration', () => {
  it('installs a target-native P1a archive before loading dependencies and its plugin marketplace', async () => {
    expect(candidateArchive, 'real Runtime gate requires a P1a candidate archive').toBeTruthy()
    expect(candidateVersion, 'real Runtime gate requires a P1a candidate version').toBeTruthy()
    expect(candidateSha256, 'real Runtime gate requires a P1a candidate SHA256').toMatch(
      /^[a-f0-9]{64}$/u
    )
    const archiveDetails = await stat(candidateArchive!)
    const cacheRoot = await mkdtemp(join(tmpdir(), 'primary-runtime-real-smoke-'))
    directories.push(cacheRoot)
    const service = new PrimaryRuntimeService({
      cacheRoot,
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      releaseProvider: {
        getRelease: async () => ({
          version: candidateVersion!,
          archiveFormat: 'zip',
          archiveSizeBytes: archiveDetails.size,
          archiveSha256: candidateSha256!
        }),
        downloadArchive: async (_descriptor, destinationPath, signal) => {
          await mkdir(dirname(destinationPath), { recursive: true })
          await pipeline(createReadStream(candidateArchive!), createWriteStream(destinationPath), {
            signal
          })
          return {
            path: destinationPath,
            sizeBytes: archiveDetails.size,
            sha256: await sha256File(destinationPath)
          }
        }
      }
    })
    let toolLoadCount = 0
    const capabilities = new DesktopHostCapabilityRuntime({
      workspaceDependencies: {
        diagnoseDependencies: () => service.diagnoseDependencies(),
        async loadDependencies() {
          toolLoadCount += 1
          return service.loadDependencies()
        }
      }
    })

    const install = await service.install()
    const diagnostic = await service.diagnoseDependencies()
    expect(diagnostic).toMatchObject({
      status: 'ready',
      root: install.activeRoot,
      manifest: { bundleFormatVersion: 2 }
    })

    const snapshot = await capabilities.snapshot()
    expect(snapshot.availableToolNames).toContain('load_workspace_dependencies')

    const result = await capabilities.dispatch({
      namespace: 'codex_app',
      tool: 'load_workspace_dependencies',
      arguments: {},
      threadId: 'primary-runtime-real-smoke'
    })
    expect(result.success).toBe(true)
    expect(toolLoadCount).toBe(1)

    const text = result.contentItems.find((item) => item.type === 'inputText')?.text
    expect(text).toBeTruthy()
    const dependencies = await service.loadDependencies()
    expect(text).toBe(dependencies.text)
    expect(dependencies.bundleVersion).toBe(diagnostic.manifest?.bundleVersion)
    expect(dependencies).not.toHaveProperty('root')
    expect(dependencies).not.toHaveProperty('nodePackages')
    expectRuntimePath(install.activeRoot, dependencies.node)
    expectRuntimePath(install.activeRoot, dependencies.nodeModules)
    if (dependencies.python) expectRuntimePath(install.activeRoot, dependencies.python)
    for (const binary of Object.values(dependencies.binaries)) {
      expectRuntimePath(install.activeRoot, binary)
    }

    const descriptors = await readPrimaryRuntimeBundledPluginDescriptors(diagnostic)
    expect(descriptors.length).toBeGreaterThan(0)
    for (const descriptor of descriptors) {
      expect(descriptor).toMatchObject({ sourceKind: 'primary-runtime', internal: true })
      expectRuntimePath(install.activeRoot, descriptor.marketplacePath)
      expectRuntimePath(install.activeRoot, descriptor.pluginRoot)
    }
  }, 90_000)
})

function expectRuntimePath(runtimeRoot: string, candidate: string): void {
  expect(isAbsolute(candidate)).toBe(true)
  const difference = relative(runtimeRoot, candidate)
  expect(difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))).toBe(true)
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function removeRuntimeCache(root: string): Promise<void> {
  await makeWritable(root)
  await rm(root, { recursive: true, force: true })
}

async function makeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await makeWritable(path)
      await chmod(path, 0o700)
    } else if (entry.isFile()) {
      await chmod(path, 0o600)
    }
  }
  await chmod(root, 0o700).catch(() => undefined)
}
