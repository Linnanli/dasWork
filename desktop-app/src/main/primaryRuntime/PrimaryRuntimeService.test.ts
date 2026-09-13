import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
import { PrimaryRuntimePostInstallError } from './PrimaryRuntimePostInstallError'
import { PrimaryRuntimeService, type PrimaryRuntimeTelemetryEvent } from './PrimaryRuntimeService'
import type {
  PrimaryRuntimeDiagnostic,
  PrimaryRuntimeManifest,
  PrimaryRuntimeReleaseDescriptor
} from './primaryRuntimeTypes'

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
        nodePackages: [{ name: 'pptxgenjs', path: '../pptxgenjs' }]
      })
    ).toThrow()
  })

  it('normalizes a legacy v2 manifest only for migration diagnostics', () => {
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

  it('accepts the generic v2 release schema without a legacy package identity', () => {
    const manifest = parsePrimaryRuntimeManifest({
      bundleFormatVersion: 2,
      bundleVersion: '2026.9.12-generic',
      target: { platform: process.platform, arch: process.arch },
      node: { path: 'dependencies/node/bin/node', version: '24.19.0' },
      nodePackages: [
        {
          name: 'pptxgenjs',
          version: '4.0.1',
          path: 'dependencies/node/node_modules/pptxgenjs'
        }
      ],
      bundledPlugins: [
        {
          marketplace: 'dascowork-presentation-skill',
          path: 'plugins/dascowork-presentation-skill'
        }
      ],
      sourceDigests: [
        {
          path: 'THIRD_PARTY_NOTICES.md',
          sha256: 'a'.repeat(64)
        }
      ]
    })
    expect(manifest).toMatchObject({
      bundleFormatVersion: 2,
      bundleVersion: '2026.9.12-generic',
      nodePackages: [{ name: 'pptxgenjs' }]
    })
    expect(manifest).not.toHaveProperty('legacyV2')
  })

  it('only accepts the fixed repository-owned synthetic marker and package name', () => {
    expect(
      parsePrimaryRuntimeManifest({
        ...manifest(),
        nodePackages: [
          {
            name: '@dascowork/test-artifact-tool',
            version: '0.0.0-synthetic',
            path: 'node_modules/@dascowork/test-artifact-tool'
          }
        ],
        syntheticTestOnly: {
          kind: 'dascowork-primary-runtime-synthetic-test.v1',
          requiredNodePackage: '@dascowork/test-artifact-tool'
        }
      })
    ).toMatchObject({
      syntheticTestOnly: { requiredNodePackage: '@dascowork/test-artifact-tool' }
    })
    expect(() =>
      parsePrimaryRuntimeManifest({
        ...manifest(),
        syntheticTestOnly: {
          kind: 'dascowork-primary-runtime-synthetic-test.v1',
          requiredNodePackage: '@oai/artifact-tool'
        }
      })
    ).toThrow()
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
    await expect(
      new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }).locate()
    ).resolves.toBeNull()
  })
})

describe('PrimaryRuntimeService', () => {
  it('returns a safe disabled status when no trusted release provider is configured', async () => {
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => null },
      diagnostics: new PrimaryRuntimeDiagnostics()
    })

    await expect(service.getUserStatus()).resolves.toEqual({
      state: 'disabled',
      message: '此版本尚未配置 Primary Runtime 发布服务。',
      recovery: '请联系管理员配置受信任的 Runtime 发布服务。',
      canInstallOrRepair: false,
      canRunUpdate: false,
      canCancel: false
    })
  })

  it('returns ready state without exposing the active Runtime root', async () => {
    const root = await fixtureRuntime()
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => ({ kind: 'development', path: root }) },
      cacheRoot: await fixtureDirectory(),
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => ({
          version: '2026.9.7-target',
          archiveFormat: 'zip',
          archiveSizeBytes: 1,
          archiveSha256: '0'.repeat(64)
        }),
        downloadArchive: vi.fn()
      }
    })

    const status = await service.getUserStatus()

    expect(status).toMatchObject({
      state: 'ready',
      currentVersion: '2026.9.6-fixture',
      canInstallOrRepair: true,
      canRunUpdate: true,
      canCancel: false
    })
    expect(JSON.stringify(status)).not.toContain(root)
  })

  it('treats a readable legacy v2 Runtime as outdated even when the version label matches', async () => {
    const diagnostics = new PrimaryRuntimeDiagnostics()
    const root = await fixtureRuntime()
    const legacyDiagnostic = {
      status: 'ready',
      root,
      manifest: { ...manifest(), legacyV2: true },
      dependencies: {
        root,
        bundleVersion: '2026.9.6-fixture',
        node: { path: join(root, 'bin', 'node') },
        nodePackages: [{ name: 'pptxgenjs', path: join(root, 'node_modules', 'pptxgenjs') }],
        binaries: []
      },
      issues: []
    } satisfies PrimaryRuntimeDiagnostic
    vi.spyOn(diagnostics, 'diagnose').mockResolvedValue(legacyDiagnostic)
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => ({ kind: 'development', path: root }) },
      diagnostics,
      releaseProvider: {
        getRelease: async () => ({
          version: '2026.9.6-fixture',
          archiveFormat: 'zip',
          archiveSizeBytes: 1,
          archiveSha256: '0'.repeat(64)
        }),
        downloadArchive: vi.fn()
      }
    })

    await expect(service.checkForUpdate()).resolves.toEqual({
      available: true,
      version: '2026.9.6-fixture',
      activeVersion: '2026.9.6-fixture'
    })
  })

  it('does not install on an unsupported target', async () => {
    const diagnostics = new PrimaryRuntimeDiagnostics()
    const root = await fixtureRuntime()
    vi.spyOn(diagnostics, 'diagnose').mockResolvedValue({
      status: 'unsupported',
      root,
      manifest: manifest(),
      issues: [{ code: 'unsupported-target', message: 'fixture target mismatch' }]
    })
    const downloadArchive = vi.fn()
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => ({ kind: 'development', path: root }) },
      cacheRoot: await fixtureDirectory(),
      diagnostics,
      releaseProvider: {
        getRelease: async () => ({
          version: '2026.9.7-target',
          archiveFormat: 'zip',
          archiveSizeBytes: 1,
          archiveSha256: '0'.repeat(64)
        }),
        downloadArchive
      }
    })

    await expect(service.updateIfAvailable()).resolves.toBeUndefined()
    expect(downloadArchive).not.toHaveBeenCalled()
  })

  it('loads stable workspace dependency text from a healthy local fixture runtime', async () => {
    const root = await fixtureRuntime()
    const service = new PrimaryRuntimeService({
      locator: { locate: async () => ({ kind: 'development', path: root }) },
      diagnostics: new PrimaryRuntimeDiagnostics()
    })

    const result = await service.loadDependencies()

    expect(result.node).toBe(join(root, 'bin', 'node'))
    expect(result.nodeModules).toBe(join(root, 'node_modules'))
    expect(result.python).toBe(join(root, 'bin', 'python'))
    expect(result.binaries).toMatchObject({ libreoffice: join(root, 'bin', 'libreoffice') })
    expect(result).not.toHaveProperty('root')
    expect(result).not.toHaveProperty('nodePackages')
    expect(result.text).toContain('Use only the following verified Primary Runtime paths.')
    expect(result.text).not.toContain('Primary Runtime root:')
  })

  it('accepts a locked type-only Node package in the Runtime dependency closure', async () => {
    const root = await fixtureRuntime()
    const packageRoot = join(root, 'node_modules', '@types', 'node')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@types/node', version: '22.19.17', types: 'index.d.ts' })
    )
    await writeFile(join(packageRoot, 'index.d.ts'), 'export {}\n')
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify(
        manifest({
          nodePackages: [
            { name: 'pptxgenjs', version: '4.0.1', path: 'node_modules/pptxgenjs' },
            { name: '@types/node', version: '22.19.17', path: 'node_modules/@types/node' }
          ]
        }),
        null,
        2
      )
    )

    await expect(new PrimaryRuntimeDiagnostics().diagnose(root)).resolves.toMatchObject({
      status: 'ready',
      dependencies: {
        nodePackages: expect.arrayContaining([
          expect.objectContaining({ name: '@types/node', path: packageRoot })
        ])
      }
    })
  })

  it('validates each generic v2 plugin descriptor and source receipt before publishing paths', async () => {
    const root = await fixtureRuntime()
    const receipt = 'reference Runtime receipt\n'
    const receiptSha256 = createHash('sha256').update(receipt).digest('hex')
    await mkdir(join(root, 'plugins', 'presentation-skill'), { recursive: true })
    await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), receipt)
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify(
        manifest({
          bundledPlugins: [
            { marketplace: 'dascowork-presentation-skill', path: 'plugins/presentation-skill' }
          ],
          sourceDigests: [{ path: 'THIRD_PARTY_NOTICES.md', sha256: 'a'.repeat(64) }]
        }),
        null,
        2
      )
    )

    await expect(new PrimaryRuntimeDiagnostics().diagnose(root)).resolves.toMatchObject({
      status: 'broken',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'missing-plugin-marketplace' }),
        expect.objectContaining({ code: 'source-digest-mismatch' })
      ])
    })

    await mkdir(join(root, 'plugins', 'presentation-skill', '.agents', 'plugins'), {
      recursive: true
    })
    await writeFile(
      join(root, 'plugins', 'presentation-skill', '.agents', 'plugins', 'marketplace.json'),
      '{}\n'
    )
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify(
        manifest({
          bundledPlugins: [
            { marketplace: 'dascowork-presentation-skill', path: 'plugins/presentation-skill' }
          ],
          sourceDigests: [{ path: 'THIRD_PARTY_NOTICES.md', sha256: receiptSha256 }]
        }),
        null,
        2
      )
    )

    await expect(new PrimaryRuntimeDiagnostics().diagnose(root)).resolves.toMatchObject({
      status: 'ready'
    })

    const skill = '# Verified Runtime skill\n'
    const skillPath = join(
      root,
      'plugins',
      'presentation-skill',
      'plugins',
      'presentation-skill',
      'skills',
      'presentation-skill',
      'SKILL.md'
    )
    await mkdir(dirname(skillPath), { recursive: true })
    await writeFile(skillPath, skill)
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify(
        manifest({
          bundledPlugins: [
            { marketplace: 'dascowork-presentation-skill', path: 'plugins/presentation-skill' }
          ],
          bundledSkills: [
            {
              path: 'plugins/presentation-skill/plugins/presentation-skill/skills/presentation-skill/SKILL.md',
              sha256: createHash('sha256').update(skill).digest('hex')
            }
          ],
          sourceDigests: [{ path: 'THIRD_PARTY_NOTICES.md', sha256: receiptSha256 }]
        }),
        null,
        2
      )
    )

    await expect(new PrimaryRuntimeDiagnostics().diagnose(root)).resolves.toMatchObject({
      status: 'ready'
    })
    await writeFile(skillPath, '# Altered Runtime skill\n')
    await expect(new PrimaryRuntimeDiagnostics().diagnose(root)).resolves.toMatchObject({
      status: 'broken',
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'bundled-skill-digest-mismatch' })
      ])
    })
  })

  it('rejects synthetic Runtime manifests unless this explicit test lane is enabled', async () => {
    const root = await fixtureRuntime()
    const syntheticManifest = manifest({
      nodePackages: [
        {
          name: '@dascowork/test-artifact-tool',
          version: '0.0.0-synthetic',
          path: 'node_modules/@dascowork/test-artifact-tool'
        }
      ],
      syntheticTestOnly: {
        kind: 'dascowork-primary-runtime-synthetic-test.v1',
        requiredNodePackage: '@dascowork/test-artifact-tool'
      }
    })
    await rm(join(root, 'node_modules', 'pptxgenjs'), { recursive: true, force: true })
    await mkdir(join(root, 'node_modules', '@dascowork', 'test-artifact-tool'), { recursive: true })
    await writeFile(
      join(root, 'node_modules', '@dascowork', 'test-artifact-tool', 'package.json'),
      JSON.stringify({
        name: '@dascowork/test-artifact-tool',
        version: '0.0.0-synthetic',
        main: './index.js'
      })
    )
    await writeFile(
      join(root, 'node_modules', '@dascowork', 'test-artifact-tool', 'index.js'),
      'export {}\n'
    )
    await writeFile(join(root, 'runtime.json'), JSON.stringify(syntheticManifest, null, 2))

    await expect(new PrimaryRuntimeDiagnostics().diagnose(root)).resolves.toMatchObject({
      status: 'broken',
      issues: [expect.objectContaining({ code: 'synthetic-test-runtime-disallowed' })]
    })
    await expect(
      new PrimaryRuntimeDiagnostics({ allowSyntheticTestRuntime: true }).diagnose(root)
    ).resolves.toMatchObject({ status: 'ready' })
  })

  it('fails closed when a manifest path escapes through a symlink', async () => {
    const outside = await fixtureDirectory()
    await mkdir(join(outside, 'pptxgenjs'), { recursive: true })
    const root = await fixtureRuntime()
    await rm(join(root, 'node_modules', 'pptxgenjs'), { recursive: true, force: true })
    await symlink(join(outside, 'pptxgenjs'), join(root, 'node_modules', 'pptxgenjs'))
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
    await publishFixtureRuntime(cacheRoot, 'old-healthy')
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
      bundleVersion: 'old-healthy'
    })
  })

  it('maps integrity failures to a safe recovery message', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'tampered-runtime' })
    const service = runtimeServiceWithRelease(cacheRoot, {
      descriptor: { ...archive.descriptor, archiveSizeBytes: archive.bytes.byteLength + 1 },
      bytes: archive.bytes
    })

    await expect(service.installOrRepair()).rejects.toThrow('final file verification')
    await expect(service.getUserStatus()).resolves.toMatchObject({
      state: 'failed',
      targetVersion: 'tampered-runtime',
      failureKind: 'integrity',
      callId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      ),
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      ),
      failureCategory: 'checksum_mismatch',
      failureStage: 'verify_checksum',
      failureDomain: 'archive',
      errorCode: 'primary_runtime_checksum_mismatch',
      retryable: false,
      runtimeActive: false,
      pluginReady: false,
      message: '下载的 Primary Runtime 未通过安全校验，未启用该版本。',
      canInstallOrRepair: true,
      canCancel: false
    })
  })

  it('keeps a verified Runtime active when post-install configuration fails', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'plugin-sync-failure' })
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => archive.descriptor,
        downloadArchive: (descriptor, destinationPath) =>
          writeFixtureArchive(descriptor, archive.bytes, destinationPath)
      },
      postActivation: async () => {
        throw new Error('Runtime plugin synchronization failed.')
      }
    })

    await expect(service.installOrRepair()).rejects.toThrow('plugin synchronization failed')
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'plugin-sync-failure'
    })
    await expect(service.getUserStatus()).resolves.toMatchObject({
      state: 'failed',
      currentVersion: 'plugin-sync-failure',
      targetVersion: 'plugin-sync-failure',
      failureCategory: 'post_install_failed',
      failureStage: 'sync_plugins',
      failureDomain: 'post_install',
      errorCode: 'primary_runtime_post_install_failed',
      retryable: false,
      runtimeActive: true,
      pluginReady: false
    })
  })

  it('preserves the precise safe stage when skill catalog reload fails', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'skill-reload-failure' })
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => archive.descriptor,
        downloadArchive: (descriptor, destinationPath) =>
          writeFixtureArchive(descriptor, archive.bytes, destinationPath)
      },
      postActivation: async () => {
        throw new PrimaryRuntimePostInstallError('reload_skills', 'Skills catalog reload failed.')
      }
    })

    await expect(service.install()).rejects.toThrow('Skills catalog reload failed')
    await expect(service.getUserStatus()).resolves.toMatchObject({
      state: 'failed',
      failureCategory: 'post_install_failed',
      failureStage: 'reload_skills',
      failureDomain: 'post_install',
      runtimeActive: true,
      pluginReady: false
    })
  })

  it('maps missing authorization or provenance to a non-bypassable recovery path', async () => {
    const cacheRoot = await fixtureDirectory()
    const telemetry: PrimaryRuntimeTelemetryEvent[] = []
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => {
          throw new Error('Runtime provenance is awaiting an authorized source record.')
        },
        downloadArchive: vi.fn()
      },
      onTelemetry: (event) => {
        telemetry.push(event)
      }
    })

    await expect(service.installOrRepair()).rejects.toThrow('authorized source')
    await expect(service.getUserStatus()).resolves.toMatchObject({
      state: 'failed',
      callId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      ),
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      ),
      failureKind: 'provenance',
      message: 'Primary Runtime 的授权来源或供应链证明尚未满足要求。',
      recovery: '请联系管理员提供已授权、可审计的 Runtime 发布版本；不会安装替代依赖。'
    })
    expect(telemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'primary_runtime_install_operation_failed',
          safe: expect.objectContaining({
            callId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
            trigger: 'repair',
            release: null,
            target: `${process.platform}-${process.arch}`,
            bundleVersion: null,
            failureCategory: 'invalid_manifest',
            failureStage: 'resolve_manifest',
            failureDomain: 'metadata',
            errorCode: 'primary_runtime_invalid_manifest',
            retryable: false
          }),
          sensitive: {
            redactionApplied: true,
            errorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
          }
        })
      ])
    )
    expect(JSON.stringify(telemetry)).not.toContain('authorized source')
  })

  it('keeps the existing pointer when archive diagnostics fail before publication', async () => {
    const cacheRoot = await fixtureDirectory()
    await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({
      bundleVersion: 'broken-new-runtime',
      manifestOverrides: { nodePackages: [] }
    })
    const service = runtimeServiceWithRelease(cacheRoot, archive)

    await expect(service.repair()).rejects.toMatchObject({
      name: 'PrimaryRuntimeInstallValidationError'
    })
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'old-healthy'
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
      bundleVersion: 'new-healthy'
    })
  })

  it('surfaces checking and update-available states without activating a candidate', async () => {
    const cacheRoot = await fixtureDirectory()
    await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({ bundleVersion: 'new-healthy' })
    let releaseReads = 0
    let resolveRelease!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve
    })
    const service = new PrimaryRuntimeService({
      locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
      cacheRoot,
      diagnostics: new PrimaryRuntimeDiagnostics(),
      releaseProvider: {
        getRelease: async () => {
          releaseReads += 1
          await releaseGate
          return archive.descriptor
        },
        downloadArchive: vi.fn()
      }
    })

    const check = service.checkForUpdate()
    const concurrentCheck = service.checkForUpdate()
    await expect(service.getUserStatus()).resolves.toMatchObject({
      state: 'checking',
      canInstallOrRepair: false,
      canRunUpdate: false
    })
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'old-healthy'
    })

    resolveRelease()
    await expect(Promise.all([check, concurrentCheck])).resolves.toEqual([
      { available: true, activeVersion: 'old-healthy', version: 'new-healthy' },
      { available: true, activeVersion: 'old-healthy', version: 'new-healthy' }
    ])
    expect(releaseReads).toBe(1)
    await expect(service.getUserStatus()).resolves.toMatchObject({
      state: 'update-available',
      currentVersion: 'old-healthy',
      targetVersion: 'new-healthy',
      canRunUpdate: true
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

    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'legacy-healthy'
    })
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
    await publishFixtureRuntime(cacheRoot, 'old-healthy')
    const archive = await releaseArchive({
      bundleVersion: 'unsafe-runtime',
      extraFiles: [{ path: '../escape.txt', content: 'bad' }]
    })
    const service = runtimeServiceWithRelease(cacheRoot, archive)

    await expect(service.install()).rejects.toThrow(/unsafe path|invalid relative path/u)
    await expect(service.loadDependencies()).resolves.toMatchObject({
      bundleVersion: 'old-healthy'
    })
  })

  it('single-flights concurrent installs and exposes in-progress status', async () => {
    const cacheRoot = await fixtureDirectory()
    const archive = await releaseArchive({ bundleVersion: 'single-flight-runtime' })
    archive.descriptor.manifestSequence = 9
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
        downloadArchive: async (descriptor, destinationPath, _signal, onProgress) => {
          releaseDownloads += 1
          onProgress?.({
            downloadedBytes: Math.floor(descriptor.archiveSizeBytes / 2),
            totalBytes: descriptor.archiveSizeBytes
          })
          await downloadGate
          return writeFixtureArchive(descriptor, archive.bytes, destinationPath)
        }
      }
    })

    const first = service.install()
    const second = service.install()
    let operationId: string | undefined
    await vi.waitFor(async () => {
      const status = await service.getUserStatus()
      operationId = status.operationId
      expect(status).toMatchObject({
        state: 'downloading',
        targetVersion: 'single-flight-runtime',
        operationId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
        ),
        downloadedBytes: Math.floor(archive.descriptor.archiveSizeBytes / 2),
        downloadSizeBytes: archive.descriptor.archiveSizeBytes,
        manifestSequence: 9,
        canCancel: true
      })
    })
    await expect(service.getUpdateStatus()).resolves.toEqual({
      status: 'installing',
      version: 'single-flight-runtime'
    })
    finishDownload()

    const results = await Promise.all([first, second])
    expect(results).toHaveLength(2)
    expect(results.map((result) => result.callId)).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
      expect.stringMatching(/^[0-9a-f-]{36}$/u)
    ])
    expect(results[0].callId).not.toBe(results[1].callId)
    expect(results.map((result) => result.operationId)).toEqual([operationId, operationId])
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

    await expect(installing).rejects.toMatchObject({
      name: 'AbortError',
      callId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/u)
    })
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
  await mkdir(join(root, 'node_modules', 'pptxgenjs'), { recursive: true })
  await mkdir(join(root, 'python-packages', 'pptx-tools'), { recursive: true })
  await writeFile(join(root, 'bin', 'node'), '#!/bin/sh\n')
  await writeFile(join(root, 'bin', 'python'), '#!/bin/sh\n')
  await writeFile(join(root, 'bin', 'libreoffice'), '#!/bin/sh\n')
  await writeFile(
    join(root, 'node_modules', 'pptxgenjs', 'package.json'),
    JSON.stringify({ name: 'pptxgenjs', version: '4.0.1', main: './index.js' })
  )
  await writeFile(join(root, 'node_modules', 'pptxgenjs', 'index.js'), 'export {}\n')
  await chmod(join(root, 'bin', 'node'), 0o755)
  await chmod(join(root, 'bin', 'python'), 0o755)
  await chmod(join(root, 'bin', 'libreoffice'), 0o755)
  await writeFile(join(root, 'runtime.json'), JSON.stringify(manifest(overrides), null, 2))
  return root
}

function manifest(overrides: Partial<PrimaryRuntimeManifest> = {}): PrimaryRuntimeManifest {
  return {
    bundleFormatVersion: 2,
    bundleVersion: '2026.9.6-fixture',
    target: { platform: process.platform, arch: process.arch },
    node: { path: 'bin/node', version: '22.0.0' },
    nodePackages: [{ name: 'pptxgenjs', version: '4.0.1', path: 'node_modules/pptxgenjs' }],
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
    'node_modules/pptxgenjs/package.json',
    JSON.stringify({ name: 'pptxgenjs', version: '4.0.1', main: './index.js' })
  )
  zip.file('node_modules/pptxgenjs/index.js', 'export {}\n')
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
