import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { PrimaryRuntimeActivePointer } from './PrimaryRuntimeActivePointer'
import {
  PrimaryRuntimeActivationTransaction,
  type PrimaryRuntimeActivationProgress
} from './PrimaryRuntimeActivationTransaction'
import type { PreparedPrimaryRuntimeInstall } from './PrimaryRuntimeInstaller'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('PrimaryRuntimeActivationTransaction', () => {
  it('keeps the active pointer unchanged when candidate publication fails', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'versions', 'v1'), { recursive: true })
    await mkdir(join(root, 'versions', 'v2'), { recursive: true })
    const pointer = new PrimaryRuntimeActivePointer(root)
    await pointer.publish({
      version: 'v1',
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      directory: 'versions/v1'
    })
    const prepared = candidate(root)
    const transaction = new PrimaryRuntimeActivationTransaction({
      cacheRoot: root,
      installer: {
        prepare: vi.fn(async () => prepared),
        commitPrepared: vi.fn(async () => {
          throw new Error('injected pointer failure')
        })
      },
      diagnostics: { diagnose: vi.fn(async () => prepared.diagnostic) }
    })

    await expect(transaction.activate(new AbortController().signal)).rejects.toThrow(
      'injected pointer failure'
    )
    expect((await pointer.read())?.version).toBe('v1')
    await expect(readFile(transaction.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the old pointer after a failed active readback', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'versions', 'v1'), { recursive: true })
    await mkdir(join(root, 'versions', 'v2'), { recursive: true })
    const pointer = new PrimaryRuntimeActivePointer(root)
    await pointer.publish({
      version: 'v1',
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      directory: 'versions/v1'
    })
    const prepared = candidate(root)
    const transaction = new PrimaryRuntimeActivationTransaction({
      cacheRoot: root,
      installer: {
        prepare: vi.fn(async () => prepared),
        commitPrepared: vi.fn(async () => {
          await pointer.publish({
            version: prepared.version,
            archiveSha256: prepared.archiveSha256,
            manifestSha256: prepared.manifestSha256,
            directory: prepared.versionDirectory
          })
          return installed(prepared)
        })
      },
      diagnostics: { diagnose: vi.fn(async () => ({ status: 'broken' as const, issues: [] })) }
    })

    await expect(transaction.activate(new AbortController().signal)).rejects.toThrow('readback')
    expect((await pointer.read())?.version).toBe('v1')
  })

  it('serializes Runtime activation and records only Runtime publication progress', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'versions', 'v2'), { recursive: true })
    const prepared = candidate(root)
    const progress: PrimaryRuntimeActivationProgress[] = []
    const transaction = new PrimaryRuntimeActivationTransaction({
      cacheRoot: root,
      installer: {
        prepare: vi.fn(async () => prepared),
        commitPrepared: vi.fn(async () => installed(prepared))
      },
      diagnostics: { diagnose: vi.fn(async () => prepared.diagnostic) },
      onProgress: (update) => {
        progress.push(update)
      }
    })

    const operationId = '78f5b3ab-9713-46de-a5e1-978dba35fa31'
    const result = await transaction.activate(
      new AbortController().signal,
      {
        version: 'v2',
        archiveFormat: 'zip',
        archiveSizeBytes: 1,
        archiveSha256: 'c'.repeat(64),
        manifestSequence: 7
      },
      operationId
    )

    expect(result.operationId).toBe(operationId)
    expect(progress).not.toHaveLength(0)
    expect(new Set(progress.map((entry) => entry.operationId))).toEqual(new Set([operationId]))
    expect(progress.map((entry) => entry.phase)).toEqual(
      expect.arrayContaining(['downloading', 'verifying', 'committing'])
    )
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId,
          phase: 'downloading',
          targetVersion: 'v2',
          manifestSequence: 7
        })
      ])
    )
  })

  it('rejects a caller-provided non-UUID operation ID before queuing activation', async () => {
    const root = await fixtureRoot()
    const prepared = candidate(root)
    const prepare = vi.fn(async () => prepared)
    const transaction = new PrimaryRuntimeActivationTransaction({
      cacheRoot: root,
      installer: {
        prepare,
        commitPrepared: vi.fn(async () => installed(prepared))
      },
      diagnostics: { diagnose: vi.fn(async () => prepared.diagnostic) }
    })

    await expect(
      transaction.activate(new AbortController().signal, undefined, 'not-an-operation-id')
    ).rejects.toThrow('operation ID must be a UUID')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('restores the old pointer after an interrupted post-switch journal', async () => {
    const root = await fixtureRoot()
    await mkdir(join(root, 'versions', 'v1'), { recursive: true })
    await mkdir(join(root, 'versions', 'v2'), { recursive: true })
    const pointer = new PrimaryRuntimeActivePointer(root)
    const previousPointer = await pointer.publish({
      version: 'v1',
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      directory: 'versions/v1'
    })
    const prepared = candidate(root)
    await pointer.publish({
      version: prepared.version,
      archiveSha256: prepared.archiveSha256,
      manifestSha256: prepared.manifestSha256,
      directory: prepared.versionDirectory
    })
    const transaction = new PrimaryRuntimeActivationTransaction({
      cacheRoot: root,
      installer: { prepare: vi.fn(), commitPrepared: vi.fn() },
      diagnostics: { diagnose: vi.fn(async () => prepared.diagnostic) }
    })
    await writeFile(
      transaction.journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        operationId: '88c893c4-6b8c-4ca4-9bf2-b1dafff44f1d',
        phase: 'pointer-committed',
        prepared: {
          version: prepared.version,
          archiveSha256: prepared.archiveSha256,
          versionDirectory: prepared.versionDirectory,
          manifestSha256: prepared.manifestSha256
        },
        previousPointer
      })}\n`,
      'utf8'
    )

    await transaction.recover()
    expect((await pointer.read())?.version).toBe('v1')
    await expect(readFile(transaction.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function installed(prepared: PreparedPrimaryRuntimeInstall): {
  status: 'installed'
  version: string
  activeRoot: string
  diagnostic: PreparedPrimaryRuntimeInstall['diagnostic']
} {
  return {
    status: 'installed' as const,
    version: prepared.version,
    activeRoot: prepared.versionRoot,
    diagnostic: prepared.diagnostic
  }
}

function candidate(root: string): PreparedPrimaryRuntimeInstall {
  return {
    version: 'v2',
    archiveSha256: 'c'.repeat(64),
    versionDirectory: 'versions/v2',
    versionRoot: join(root, 'versions', 'v2'),
    manifestSha256: 'd'.repeat(64),
    diagnostic: {
      status: 'ready',
      root: join(root, 'versions', 'v2'),
      manifest: {
        bundleFormatVersion: 2,
        bundleVersion: 'v2',
        target: { platform: process.platform, arch: process.arch },
        node: { path: 'dependencies/node/bin/node' },
        nodePackages: []
      },
      dependencies: {
        root: join(root, 'versions', 'v2'),
        bundleVersion: 'v2',
        node: { path: '/runtime/node' },
        nodePackages: [],
        binaries: [],
        fonts: []
      },
      issues: []
    }
  }
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'primary-runtime-activation-'))
  directories.push(root)
  return root
}
