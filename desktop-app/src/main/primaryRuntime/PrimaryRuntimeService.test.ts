import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import JSZip from 'jszip'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PrimaryRuntimeActivePointer,
  sha256File,
  versionDirectoryForRelease
} from './PrimaryRuntimeActivePointer'
import { PrimaryRuntimeDiagnostics } from './PrimaryRuntimeDiagnostics'
import { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import { parsePrimaryRuntimeManifest } from './PrimaryRuntimeManifest'
import { PrimaryRuntimeService } from './PrimaryRuntimeService'
import type { PrimaryRuntimeManifest, PrimaryRuntimeReleaseDescriptor } from './primaryRuntimeTypes'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeFixtureDirectory))
})

describe('PrimaryRuntime manifest parsing', () => {
  it('rejects absolute and traversing paths before diagnostics run', () => {
    expect(() =>
      parsePrimaryRuntimeManifest({
        ...manifest(),
        node: { path: '/usr/bin/node' }
      })
    ).toThrow()
    expect(() =>
      parsePrimaryRuntimeManifest({
        ...manifest(),
        nodePackages: [{ name: '@oai/artifact-tool', path: '../artifact-tool' }]
      })
    ).toThrow()
  })

  it('normalizes the real Primary Runtime v2 manifest layout', () => {
    expect(
      parsePrimaryRuntimeManifest({
        artifactToolVersion: '2.8.59',
        bundleFormatVersion: 2,
        bundleVersion: '26.904.11930',
        bundledPlugins: ['plugins/openai-primary-runtime'],
        nativeDependencies: ['libreoffice-headless', 'poppler'],
        nodeVersion: 'v24.19.0',
        pythonVersion: '3.12.14',
        targetArch: process.arch,
        targetPlatform: process.platform
      })
    ).toMatchObject({
      bundleFormatVersion: 2,
      target: { platform: process.platform, arch: process.arch },
      node: { path: 'dependencies/node/bin/node', version: 'v24.19.0' },
      nodePackages: [
        {
          name: '@oai/artifact-tool',
          version: '2.8.59',
          path: 'dependencies/node/node_modules/@oai/artifact-tool'
        }
      ]
    })
  })
})

describe('PrimaryRuntimeLocator', () => {
  it('prefers an explicit development root, then a valid active pointer', async () => {
    const developmentRoot = await fixtureRuntime()
    const cacheRoot = await fixtureDirectory()
    const cachedRoot = await publishFixtureRuntime(cacheRoot, 'cached-runtime')

    const allowed = new PrimaryRuntimeLocator({
      env: { DASCOWORK_PRIMARY_RUNTIME_ROOT: developmentRoot },
      allowDevelopmentRoot: true,
      appCacheRoot: cacheRoot
    })
    await expect(allowed.locate()).resolves.toMatchObject({
      kind: 'development',
      path: developmentRoot
    })

    const disallowed = new PrimaryRuntimeLocator({
      env: { DASCOWORK_PRIMARY_RUNTIME_ROOT: developmentRoot },
      allowDevelopmentRoot: false,
      appCacheRoot: cacheRoot
    })
    await expect(disallowed.locate()).resolves.toMatchObject({
      kind: 'active-cache',
      path: cachedRoot
    })
  })

  it('does not resolve a cache path when the pointer is malformed or escapes versions', async () => {
    const cacheRoot = await fixtureDirectory()
    await writeFile(join(cacheRoot, 'active.json'), '{"directory":"../outside"}\n')
    await expect(new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }).locate()).resolves.toBeNull()
  })
})

describe('PrimaryRuntimeService', () => {
  it('loads stable workspace dependency text from a healthy local fixture runtime', async () => {
    const root = await fixtureRuntime()
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => ({ kind: 'development', path: root }) },
      diagnostics: new PrimaryRuntimeDiagnostics()
    })

    const result = await service.loadDependencies()

    expect(result.root).toBe(root)
    expect(result.node).toBe(join(root, 'bin', 'node'))
    expect(result.nodeModules).toBe(join(root, 'node_modules'))
    expect(result.nodePackages).toContainEqual({
      name: '@oai/artifact-tool',
      version: '1.0.0',
      path: join(root, 'node_modules', '@oai', 'artifact-tool')
    })
    expect(result.python).toBe(join(root, 'bin', 'python'))
    expect(result.binaries).toMatchObject({ libreoffice: join(root, 'bin', 'libreoffice') })
    expect(result.text).toContain(`Primary Runtime root: ${root}`)
  })

  it('fails closed when a manifest path escapes through a symlink', async () => {
    const outside = await fixtureDirectory()
    await mkdir(join(outside, 'artifact-tool'), { recursive: true })
    const root = await fixtureRuntime()
    await rm(join(root, 'node_modules', '@oai', 'artifact-tool'), { recursive: true, force: true })
    await symlink(
      join(outside, 'artifact-tool'),
      join(root, 'node_modules', '@oai', 'artifact-tool')
    )
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => ({ kind: 'development', path: root }) },
      diagnostics: new PrimaryRuntimeDiagnostics()
    })

    await expect(service.loadDependencies()).rejects.toMatchObject({
      name: 'PrimaryRuntimeUnavailableError',
      status: 'broken',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'path-escape' })])
    })
  })

  it('publishes only a complete immutable version through an atomic pointer', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: '2026.9.7-fixture' })
    const service = runtimeServiceWithRelease(cacheRoot, archive)

    const result = await service.install()
    const versionRoot = releaseRoot(cacheRoot, archive.descriptor)
    const pointer = await new PrimaryRuntimeActivePointer(cacheRoot).read()

    expect(result).toMatchObject({
      status: 'installed',
      version: '2026.9.7-fixture',
      activeRoot: versionRoot
    })
    expect(pointer).toMatchObject({
      version: '2026.9.7-fixture',
      archiveSha256: archive.descriptor.archiveSha256,
      directory: versionDirectoryForRelease(
        archive.descriptor.version,
        archive.descriptor.archiveSha256
      )
    })
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: '2026.9.7-fixture',
      root: versionRoot,
      node: join(versionRoot, 'bin', 'node')
    })
    expect((await readdir(cacheRoot)).some((entry) => entry === 'active')).toBe(false)
    expect((await readdir(cacheRoot)).some((entry) => entry.startsWith('.staging-'))).toBe(false)
    await expect(writeFile(join(versionRoot, 'runtime.json'), '{}')).rejects.toMatchObject({
      code: expect.stringMatching(/EACCES|EPERM/u)
    })
  })

  it('keeps the existing pointer when a download is truncated or tampered', async () => {
    const cacheRoot = await fixtureDirectory()
    const previousRoot = await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({ bundleVersion: 'new-runtime' })
    const service = runtimeServiceWithRelease(cacheRoot, {
      descriptor: {
        ...archive.descriptor,
        archiveSizeBytes: archive.bytes.byteLength + 1
      },
      bytes: archive.bytes
    })

    await expect(service.install()).rejects.toThrow('final file verification')
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'old-healthy',
      root: previousRoot
    })
  })

  it('keeps the existing pointer when archive diagnostics fail before publication', async () => {
    const cacheRoot = await fixtureDirectory()
    const previousRoot = await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({
      bundleVersion: 'broken-new-runtime',
      manifestOverrides: { nodePackages: [] }
    })
    const service = runtimeServiceWithRelease(cacheRoot, archive)

    await expect(service.repair()).rejects.toMatchObject({
      name: 'PrimaryRuntimeInstallValidationError'
    })
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'old-healthy',
      root: previousRoot
    })
  })

  it('keeps prior immutable versions available after an update', async () => {
    const cacheRoot = await fixtureDirectory()
    const previousRoot = await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({ bundleVersion: 'new-healthy' })
    const service = runtimeServiceWithRelease(cacheRoot, archive)

    await expect(service.runUpdateNow()).resolves.toMatchObject({
      status: 'installed',
      version: 'new-healthy'
    })
    await expect(new PrimaryRuntimeDiagnostics().diagnose(previousRoot)).resolves.toMatchObject({
      status: 'ready',
      manifest: expect.objectContaining({ bundleVersion: 'old-healthy' })
    })
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'new-healthy',
      root: releaseRoot(cacheRoot, archive.descriptor)
    })
  })

  it('migrates a healthy legacy active directory before it is next read', async () => {
    const cacheRoot = await fixtureDirectory()
    await fixtureRuntime(join(cacheRoot, 'active'), { bundleVersion: 'legacy-healthy' })
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics()
    })

    await expect(service.loadDependencies()).resolves.toMatchObject({ bundleVersion: 'legacy-healthy' })
    const pointer = await new PrimaryRuntimeActivePointer(cacheRoot).read()
    expect(pointer).toMatchObject({ version: 'legacy-healthy', archiveSha256: null })
    expect((await readdir(cacheRoot)).includes('active')).toBe(false)
  })

  it('does not install a descriptor above the configured size limit', async () => {
    const cacheRoot = await fixtureDirectory()
    const downloadArchive = vi.fn()
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => ({
          version: 'oversized',
          archiveFormat: 'zip',
          archiveSizeBytes: 3 * 1024 * 1024 * 1024,
          archiveSha256: '0'.repeat(64)
        }),
        downloadArchive
      }
    })

    await expect(service.install()).rejects.toThrow('size limit')
    expect(downloadArchive).not.toHaveBeenCalled()
  })

  it('rejects installation before download when free disk space is insufficient', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'no-space-runtime' })
    const downloadArchive = vi.fn()
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      installerOptions: { availableDiskBytes: async () => 1 },
      releaseProvider: {
        getRelease: async () => archive.descriptor,
        downloadArchive
      }
    })

    await expect(service.install()).rejects.toThrow('enough free disk space')
    expect(downloadArchive).not.toHaveBeenCalled()
  })

  it('rejects unsafe archive paths and preserves the active pointer', async () => {
    const cacheRoot = await fixtureDirectory()
    const previousRoot = await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({
      bundleVersion: 'unsafe-runtime',
      extraFiles: [{ path: '../escape.txt', content: 'bad' }]
    })
    const service = runtimeServiceWithRelease(cacheRoot, archive)

    await expect(service.install()).rejects.toThrow(/unsafe path|invalid relative path/u)
    await expect(service.loadDependencies()).resolves.toMatchObject({ root: previousRoot })
  })

  it('single-flights concurrent installs and exposes installing status', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'single-flight-runtime' })
    let releaseReads = 0
    let releaseDownloads = 0
    let finishDownload!: () => void
    const downloadGate = new Promise<void>((resolve) => {
      finishDownload = resolve
    })
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => {
          releaseReads += 1
          return archive.descriptor
        },
        downloadArchive: async (descriptor, destinationPath) => {
          releaseDownloads += 1
          await downloadGate
          return writeFixtureArchive(descriptor, archive.bytes, destinationPath)
        }
      }
    })

    const first = service.install()
    const second = service.install()
    await expect(service.getUpdateStatus()).resolves.toEqual({
      status: 'installing',
      version: 'single-flight-runtime'
    })
    finishDownload()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(releaseReads).toBe(1)
    expect(releaseDownloads).toBe(1)
  })

  it('cancels an in-flight download and removes its incomplete file', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'cancelled-runtime' })
    let finishDownload!: () => void
    const downloadGate = new Promise<void>((resolve) => {
      finishDownload = resolve
    })
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => archive.descriptor,
        downloadArchive: async (descriptor, destinationPath, signal) => {
          await downloadGate
          if (signal.aborted) throw new DOMException('cancelled', 'AbortError')
          return writeFixtureArchive(descriptor, archive.bytes, destinationPath)
        }
      }
    })

    const installing = service.install()
    await service.cancelInstall()
    finishDownload()

    await expect(installing).rejects.toMatchObject({ name: 'AbortError' })
    await expect(service.getUpdateStatus()).resolves.toMatchObject({
      status: 'failed',
      cleanedStagingCount: 0
    })
    expect((await readdir(cacheRoot)).filter((entry) => entry.includes('.part-'))).toEqual([])
  })
})

async function fixtureDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dascowork-primary-runtime-')))
  directories.push(directory)
  return directory
}

async function removeFixtureDirectory(directory: string): Promise<void> {
  await makeFixtureTreeWritable(directory)
  await rm(directory, { recursive: true, force: true })
}

async function makeFixtureTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await makeFixtureTreeWritable(path)
      await chmod(path, 0o700)
    } else if (entry.isFile()) {
      await chmod(path, 0o600)
    }
  }
  await chmod(root, 0o700).catch(() => undefined)
}

async function fixtureRuntime(
  targetRoot?: string,
  overrides: Partial<PrimaryRuntimeManifest> = {}
): Promise<string> {
  const root = targetRoot ?? (await fixtureDirectory())
  if (targetRoot) await mkdir(root, { recursive: true })

  await mkdir(join(root, 'bin'), { recursive: true })
  await mkdir(join(root, 'node_modules', '@oai', 'artifact-tool'), { recursive: true })
  await mkdir(join(root, 'python-packages', 'pptx-tools'), { recursive: true })
  await writeFile(join(root, 'bin', 'node'), '#!/bin/sh\n')
  await writeFile(join(root, 'bin', 'python'), '#!/bin/sh\n')
  await writeFile(join(root, 'bin', 'libreoffice'), '#!/bin/sh\n')
  await writeFile(
    join(root, 'node_modules', '@oai', 'artifact-tool', 'package.json'),
    JSON.stringify({ name: '@oai/artifact-tool', version: '1.0.0', main: './index.js' })
  )
  await writeFile(join(root, 'node_modules', '@oai', 'artifact-tool', 'index.js'), 'export {}\n')
  await chmod(join(root, 'bin', 'node'), 0o755)
  await chmod(join(root, 'bin', 'python'), 0o755)
  await chmod(join(root, 'bin', 'libreoffice'), 0o755)
  await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest(overrides), null, 2))
  return root
}

function manifest(overrides: Partial<PrimaryRuntimeManifest> = {}): PrimaryRuntimeManifest {
  return {
    bundleFormatVersion: 1,
    bundleVersion: '2026.9.6-fixture',
    target: { platform: process.platform, arch: process.arch },
    node: { path: 'bin/node', version: '22.0.0' },
    nodePackages: [
      { name: '@oai/artifact-tool', version: '1.0.0', path: 'node_modules/@oai/artifact-tool' }
    ],
    python: {
      path: 'bin/python',
      version: '3.12.0',
      packages: [{ name: 'pptx-tools', path: 'python-packages/pptx-tools' }]
    },
    binaries: [{ name: 'libreoffice', path: 'bin/libreoffice' }],
    ...overrides
  }
}

async function publishFixtureRuntime(cacheRoot: string, bundleVersion: string): Promise<string> {
  const archiveSha256 = createHash('sha256').update(bundleVersion).digest('hex')
  const directory = versionDirectoryForRelease(bundleVersion, archiveSha256)
  const root = await fixtureRuntime(join(cacheRoot, directory), { bundleVersion })
  await new PrimaryRuntimeActivePointer(cacheRoot).publish({
    version: bundleVersion,
    archiveSha256,
    manifestSha256: await sha256File(join(root, 'runtime.json')),
    directory
  })
  return root
}

function releaseRoot(cacheRoot: string, descriptor: PrimaryRuntimeReleaseDescriptor): string {
  return join(cacheRoot, versionDirectoryForRelease(descriptor.version, descriptor.archiveSha256))
}

function runtimeServiceWithRelease(
  cacheRoot: string,
  archive: { descriptor: PrimaryRuntimeReleaseDescriptor; bytes: Uint8Array }
): PrimaryRuntimeService {
  return new PrimaryRuntimeService({
    locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
    cacheRoot,
    diagnostics: new PrimaryRuntimeDiagnostics(),
    releaseProvider: {
      getRelease: async () => archive.descriptor,
      downloadArchive: (descriptor, destinationPath) =>
        writeFixtureArchive(descriptor, archive.bytes, destinationPath)
    }
  })
}

async function writeFixtureArchive(
  _descriptor: PrimaryRuntimeReleaseDescriptor,
  bytes: Uint8Array,
  destinationPath: string
): Promise<{ path: string; sizeBytes: number; sha256: string }> {
  await mkdir(dirname(destinationPath), { recursive: true })
  await writeFile(destinationPath, bytes, { mode: 0o400 })
  return {
    path: destinationPath,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

async function releaseArchive({
  bundleVersion,
  manifestOverrides = {},
  extraFiles = []
}: {
  bundleVersion: string
  manifestOverrides?: Partial<PrimaryRuntimeManifest>
  extraFiles?: Array<{ path: string; content: string }>
}): Promise<{ descriptor: PrimaryRuntimeReleaseDescriptor; bytes: Uint8Array }> {
  const zip = new JSZip()
  const runtimeManifest = manifest({ bundleVersion, ...manifestOverrides })
  zip.file('runtime.json', JSON.stringify(runtimeManifest))
  zip.file('bin/node', '#!/bin/sh\n')
  zip.file('bin/python', '#!/bin/sh\n')
  zip.file('bin/libreoffice', '#!/bin/sh\n')
  zip.file(
    'node_modules/@oai/artifact-tool/package.json',
    JSON.stringify({ name: '@oai/artifact-tool', version: '1.0.0', main: './index.js' })
  )
  zip.file('node_modules/@oai/artifact-tool/index.js', 'export {}\n')
  zip.file('python-packages/pptx-tools/package.json', '{}\n')
  for (const extraFile of extraFiles) zip.file(extraFile.path, extraFile.content)
  const bytes = await zip.generateAsync({ type: 'uint8array' })
  return {
    bytes,
    descriptor: {
      version: bundleVersion,
      archiveFormat: 'zip',
      archiveSizeBytes: bytes.byteLength,
      archiveSha256: createHash('sha256').update(bytes).digest('hex')
    }
  }
}
