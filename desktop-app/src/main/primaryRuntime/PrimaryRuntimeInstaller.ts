import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'

import {
  PrimaryRuntimeActivePointer,
  sha256File,
  versionDirectoryForRelease
} from './PrimaryRuntimeActivePointer'
import { PrimaryRuntimeDiagnostics } from './PrimaryRuntimeDiagnostics'
import type { PrimaryRuntimeReleaseProvider } from './PrimaryRuntimeReleaseProvider'
import type {
  PrimaryRuntimeDiagnostic,
  PrimaryRuntimeReadyDiagnostic,
  PrimaryRuntimeReleaseDescriptor
} from './primaryRuntimeTypes'

export type PrimaryRuntimeInstallResult = {
  status: 'installed'
  version: string
  activeRoot: string
  diagnostic: PrimaryRuntimeReadyDiagnostic
}

export type PrimaryRuntimeInstallerInput = {
  cacheRoot: string
  releaseProvider?: PrimaryRuntimeReleaseProvider
  diagnostics?: PrimaryRuntimeDiagnostics
  availableDiskBytes?: (path: string) => Promise<number>
}

const STAGING_PREFIX = '.staging-'
const DOWNLOADS_DIRECTORY = 'downloads'
const DEFAULT_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MINIMUM_INSTALL_HEADROOM_BYTES = 2 * 1024 * 1024 * 1024
const MAX_UNPACKED_RUNTIME_BYTES = 8 * 1024 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 200_000

/**
 * Installs Primary Runtime archives without ever materialising an archive in
 * the JavaScript heap. A verified archive is retained on disk, extracted one
 * ZIP entry at a time, validated before publication, then exposed through an
 * atomically replaced active pointer.
 */
export class PrimaryRuntimeInstaller {
  private readonly diagnostics: PrimaryRuntimeDiagnostics
  private readonly maxArchiveBytes: number
  private readonly availableDiskBytes: (path: string) => Promise<number>
  private readonly activePointer: PrimaryRuntimeActivePointer
  private recoveryTail: Promise<void> = Promise.resolve()

  constructor(private readonly input: PrimaryRuntimeInstallerInput) {
    this.diagnostics = input.diagnostics ?? new PrimaryRuntimeDiagnostics()
    this.maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES
    this.availableDiskBytes = input.availableDiskBytes ?? readAvailableDiskBytes
    this.activePointer = new PrimaryRuntimeActivePointer(input.cacheRoot)
  }

  async install(
    signal: AbortSignal,
    descriptor?: PrimaryRuntimeReleaseDescriptor
  ): Promise<PrimaryRuntimeInstallResult> {
    await this.cleanupStaging()
    throwIfAborted(signal)

    const releaseProvider = this.input.releaseProvider
    if (!releaseProvider) {
      throw new Error('Primary Runtime release provider is not configured.')
    }
    const resolvedDescriptor = descriptor ?? (await releaseProvider.getRelease())
    if (!resolvedDescriptor) {
      throw new Error('Primary Runtime release descriptor is not configured.')
    }
    assertSupportedDescriptor(resolvedDescriptor, this.maxArchiveBytes)
    await assertDiskCapacity(
      this.input.cacheRoot,
      Math.max(MINIMUM_INSTALL_HEADROOM_BYTES, resolvedDescriptor.archiveSizeBytes * 8),
      this.availableDiskBytes
    )

    const archivePath = join(
      this.input.cacheRoot,
      DOWNLOADS_DIRECTORY,
      `${resolvedDescriptor.archiveSha256}.zip`
    )
    await ensureVerifiedArchive({
      archivePath,
      descriptor: resolvedDescriptor,
      releaseProvider,
      signal
    })
    throwIfAborted(signal)

    const stagingRoot = join(
      this.input.cacheRoot,
      `${STAGING_PREFIX}${safePathSegment(resolvedDescriptor.version)}-${randomUUID()}`
    )
    const extractedRoot = join(stagingRoot, 'runtime')
    try {
      await mkdir(extractedRoot, { recursive: true })
      await extractRuntimeZip(archivePath, extractedRoot, signal, this.availableDiskBytes)
      throwIfAborted(signal)

      const diagnostic = await this.diagnostics.diagnose(extractedRoot)
      if (diagnostic.status !== 'ready') {
        throw new PrimaryRuntimeInstallValidationError(diagnostic)
      }

      const versionDirectory = versionDirectoryForRelease(
        resolvedDescriptor.version,
        resolvedDescriptor.archiveSha256
      )
      const versionRoot = join(this.input.cacheRoot, versionDirectory)
      await publishImmutableRuntime(extractedRoot, versionRoot, this.diagnostics)
      const publishedDiagnostic = await this.diagnostics.diagnose(versionRoot)
      if (publishedDiagnostic.status !== 'ready') {
        throw new PrimaryRuntimeInstallValidationError(publishedDiagnostic)
      }

      const manifestSha256 = await sha256File(join(versionRoot, 'runtime.json'))
      await this.activePointer.publish({
        version: resolvedDescriptor.version,
        archiveSha256: resolvedDescriptor.archiveSha256,
        manifestSha256,
        directory: versionDirectory
      })
      const activeRoot = await this.activePointer.resolveRoot()
      if (!activeRoot) {
        throw new Error('Primary Runtime active pointer was not published.')
      }
      const activeDiagnostic = await this.diagnostics.diagnose(activeRoot)
      if (activeDiagnostic.status !== 'ready') {
        throw new PrimaryRuntimeInstallValidationError(activeDiagnostic)
      }

      return {
        status: 'installed',
        version: resolvedDescriptor.version,
        activeRoot,
        diagnostic: readyRuntimeDiagnostic(activeDiagnostic)
      }
    } finally {
      await makeRuntimeTreeWritable(stagingRoot).catch(() => undefined)
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }

  async cleanupStaging(): Promise<number> {
    await mkdir(this.input.cacheRoot, { recursive: true })
    await this.recoverActivation()
    const entries = await readdir(this.input.cacheRoot, { withFileTypes: true })
    const stagingEntries = entries.filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)
    )
    await Promise.all(
      stagingEntries.map((entry) =>
        rm(join(this.input.cacheRoot, entry.name), { recursive: true, force: true })
      )
    )
    if (entries.some((entry) => entry.isDirectory() && entry.name === DOWNLOADS_DIRECTORY)) {
      await cleanupPartialDownloads(join(this.input.cacheRoot, DOWNLOADS_DIRECTORY))
    }
    return stagingEntries.length
  }

  recoverActivation(): Promise<void> {
    const recovery = this.recoveryTail.then(async () => {
      await mkdir(this.input.cacheRoot, { recursive: true })
      await this.activePointer.recover()
      await this.activePointer.migrateLegacyActive(this.diagnostics)
    })
    this.recoveryTail = recovery.catch(() => undefined)
    return recovery
  }
}

export class PrimaryRuntimeInstallValidationError extends Error {
  constructor(readonly diagnostic: PrimaryRuntimeDiagnostic) {
    super('Primary Runtime release failed diagnostics.')
    this.name = 'PrimaryRuntimeInstallValidationError'
  }
}

async function ensureVerifiedArchive({
  archivePath,
  descriptor,
  releaseProvider,
  signal
}: {
  archivePath: string
  descriptor: PrimaryRuntimeReleaseDescriptor
  releaseProvider: PrimaryRuntimeReleaseProvider
  signal: AbortSignal
}): Promise<void> {
  if (await verifyArchiveFile(archivePath, descriptor).catch(() => false)) return
  await rm(archivePath, { force: true })
  const downloaded = await releaseProvider.downloadArchive(descriptor, archivePath, signal)
  if (downloaded.path !== archivePath) {
    throw new Error('Primary Runtime release provider wrote the archive to an unexpected path.')
  }
  if (
    downloaded.sizeBytes !== descriptor.archiveSizeBytes ||
    downloaded.sha256 !== descriptor.archiveSha256 ||
    !(await verifyArchiveFile(archivePath, descriptor))
  ) {
    throw new Error('Primary Runtime archive did not pass final file verification.')
  }
}

async function verifyArchiveFile(
  archivePath: string,
  descriptor: PrimaryRuntimeReleaseDescriptor
): Promise<boolean> {
  const details = await stat(archivePath)
  if (!details.isFile() || details.size !== descriptor.archiveSizeBytes) return false
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(archivePath)) {
    digest.update(chunk)
  }
  return digest.digest('hex') === descriptor.archiveSha256
}

async function publishImmutableRuntime(
  extractedRoot: string,
  versionRoot: string,
  diagnostics: PrimaryRuntimeDiagnostics
): Promise<void> {
  await mkdir(dirname(versionRoot), { recursive: true })
  if (await directoryExists(versionRoot)) {
    const existing = await diagnostics.diagnose(versionRoot)
    if (existing.status !== 'ready') {
      throw new Error(
        'Primary Runtime immutable version directory already exists but is not healthy.'
      )
    }
    return
  }
  await rename(extractedRoot, versionRoot)
  try {
    // The directory is not observable through the active pointer yet, so make
    // it immutable only after the cross-directory move has completed.
    await freezeRuntimeTree(versionRoot)
  } catch (error) {
    await makeRuntimeTreeWritable(versionRoot).catch(() => undefined)
    await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function extractRuntimeZip(
  archivePath: string,
  targetRoot: string,
  signal: AbortSignal,
  availableDiskBytes: (path: string) => Promise<number>
): Promise<void> {
  const archive = await openZip(archivePath)
  let entries = 0
  let unpackedBytes = 0
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let finished = false
      const fail = (error: unknown): void => {
        if (finished) return
        finished = true
        rejectPromise(error)
      }
      const next = (): void => {
        if (!finished) archive.readEntry()
      }

      archive.once('error', fail)
      archive.once('end', () => {
        if (finished) return
        finished = true
        resolvePromise()
      })
      archive.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          try {
            throwIfAborted(signal)
            entries += 1
            if (entries > MAX_ARCHIVE_ENTRIES) {
              throw new Error('Primary Runtime archive contains too many entries.')
            }
            const relativePath = normalizedArchivePath(entry.fileName)
            if (isSymlinkEntry(entry)) {
              throw new Error('Primary Runtime archive contains a symbolic link entry.')
            }
            if (entry.isEncrypted()) {
              throw new Error('Primary Runtime archive contains an encrypted entry.')
            }
            const targetPath = resolve(targetRoot, relativePath)
            if (!isPathInside(targetRoot, targetPath)) {
              throw new Error('Primary Runtime archive contains a path outside the runtime root.')
            }

            if (isDirectoryEntry(entry)) {
              await mkdir(targetPath, { recursive: true })
              next()
              return
            }

            unpackedBytes = checkedUnpackedBytes(unpackedBytes, entry.uncompressedSize)
            await assertDiskCapacity(targetRoot, unpackedBytes, availableDiskBytes)
            await mkdir(dirname(targetPath), { recursive: true })
            const stream = await openEntryReadStream(archive, entry)
            await pipeline(stream, createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }), {
              signal
            })
            if (isExecutableArchivePath(relativePath)) await chmod(targetPath, 0o755)
            next()
          } catch (error) {
            fail(error)
          }
        })()
      })
      next()
    })
  } finally {
    archive.close()
  }
}

function checkedUnpackedBytes(total: number, entrySize: number): number {
  if (!Number.isSafeInteger(entrySize) || entrySize < 0) {
    throw new Error('Primary Runtime archive contains an entry with an invalid size.')
  }
  const next = total + entrySize
  if (!Number.isSafeInteger(next) || next > MAX_UNPACKED_RUNTIME_BYTES) {
    throw new Error('Primary Runtime archive expands beyond the configured size limit.')
  }
  return next
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, archive) => {
        if (error || !archive) {
          rejectPromise(error ?? new Error('Primary Runtime archive could not be opened.'))
          return
        }
        resolvePromise(archive)
      }
    )
  })
}

function openEntryReadStream(
  archive: yauzl.ZipFile,
  entry: yauzl.Entry
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, rejectPromise) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        rejectPromise(error ?? new Error('Primary Runtime archive entry could not be opened.'))
        return
      }
      resolvePromise(stream)
    })
  })
}

function isDirectoryEntry(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith('/')
}

function isSymlinkEntry(entry: yauzl.Entry): boolean {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
}

async function freezeRuntimeTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await freezeRuntimeTree(path)
      await chmod(path, 0o555)
      continue
    }
    if (entry.isFile()) {
      const mode = (await stat(path)).mode
      await chmod(path, mode & 0o111 ? 0o555 : 0o444)
      continue
    }
    throw new Error('Primary Runtime extraction created an unsupported filesystem entry.')
  }
  await chmod(root, 0o555)
}

async function makeRuntimeTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await makeRuntimeTreeWritable(path)
      await chmod(path, 0o700)
      continue
    }
    if (entry.isFile()) await chmod(path, 0o600)
  }
  await chmod(root, 0o700)
}

async function readAvailableDiskBytes(path: string): Promise<number> {
  const filesystem = await statfs(path)
  return filesystem.bavail * filesystem.bsize
}

async function assertDiskCapacity(
  path: string,
  requiredBytes: number,
  availableDiskBytes: (path: string) => Promise<number>
): Promise<void> {
  const availableBytes = await availableDiskBytes(path)
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new Error('Primary Runtime installation does not have enough free disk space.')
  }
}

function assertSupportedDescriptor(
  descriptor: PrimaryRuntimeReleaseDescriptor,
  maxArchiveBytes: number
): void {
  if (descriptor.archiveFormat !== 'zip') {
    throw new Error('Primary Runtime release archive format is not supported.')
  }
  if (descriptor.archiveSizeBytes > maxArchiveBytes) {
    throw new Error('Primary Runtime release archive exceeds the configured size limit.')
  }
  if (!/^[a-f0-9]{64}$/u.test(descriptor.archiveSha256)) {
    throw new Error('Primary Runtime release archive SHA256 is invalid.')
  }
}

function normalizedArchivePath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (
    !normalized ||
    isAbsolute(path) ||
    normalized.split('/').includes('..') ||
    /^[A-Za-z]:\//u.test(normalized)
  ) {
    throw new Error('Primary Runtime archive contains an unsafe path.')
  }
  return normalized
}

function isExecutableArchivePath(path: string): boolean {
  return basename(dirname(path)) === 'bin' || path.startsWith('bin/')
}

function isPathInside(root: string, path: string): boolean {
  const diff = relative(root, path)
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff))
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

async function cleanupPartialDownloads(downloadsRoot: string): Promise<void> {
  const entries = await readdir(downloadsRoot, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.includes('.part-'))
      .map((entry) => rm(join(downloadsRoot, entry.name), { force: true }))
  )
}

function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/gu, '_')
  if (!segment || segment === '.' || segment === '..') {
    throw new Error('Primary Runtime version cannot be represented as a safe directory name.')
  }
  return segment
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Primary Runtime installation was cancelled.', 'AbortError')
  }
}

function readyRuntimeDiagnostic(
  diagnostic: PrimaryRuntimeDiagnostic
): PrimaryRuntimeReadyDiagnostic {
  if (
    diagnostic.status !== 'ready' ||
    !diagnostic.root ||
    !diagnostic.manifest ||
    !diagnostic.dependencies
  ) {
    throw new PrimaryRuntimeInstallValidationError(diagnostic)
  }

  return {
    ...diagnostic,
    status: 'ready',
    root: diagnostic.root,
    manifest: diagnostic.manifest,
    dependencies: diagnostic.dependencies
  }
}
