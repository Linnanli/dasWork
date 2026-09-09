import { createHash } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { z } from 'zod'

import type { PrimaryRuntimeDiagnostics } from './PrimaryRuntimeDiagnostics'

const POINTER_FILENAME = 'active.json'
const PENDING_POINTER_FILENAME = 'active.json.next'
const VERSIONS_DIRECTORY = 'versions'
const LEGACY_ACTIVE_DIRECTORY = 'active'

const pointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().positive(),
    version: z.string().min(1),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    directory: z.string().min(1)
  })
  .strict()

export type PrimaryRuntimeActivePointerRecord = z.infer<typeof pointerSchema>

export type PrimaryRuntimeActivePointerInput = {
  version: string
  archiveSha256: string
  manifestSha256: string
  directory: string
}

/**
 * Resolves active Primary Runtime versions through a tiny, atomically-replaced
 * pointer file. Runtime directories are immutable once published: readers can
 * therefore observe only the complete previous generation or the complete next
 * generation, never a directory being moved into place.
 */
export class PrimaryRuntimeActivePointer {
  private resolvedVersionsRoot: Promise<string> | undefined
  private readonly resolvedDirectories = new Map<string, Promise<string>>()
  private pendingRead: Promise<PrimaryRuntimeActivePointerRecord | null> | undefined

  constructor(readonly cacheRoot: string) {}

  get pointerPath(): string {
    return join(this.cacheRoot, POINTER_FILENAME)
  }

  get pendingPointerPath(): string {
    return join(this.cacheRoot, PENDING_POINTER_FILENAME)
  }

  get versionsRoot(): string {
    return join(this.cacheRoot, VERSIONS_DIRECTORY)
  }

  async read(): Promise<PrimaryRuntimeActivePointerRecord | null> {
    if (this.pendingRead) return this.pendingRead

    const read = this.readCurrentPointer()
    this.pendingRead = read
    try {
      return await read
    } finally {
      if (this.pendingRead === read) this.pendingRead = undefined
    }
  }

  private async readCurrentPointer(): Promise<PrimaryRuntimeActivePointerRecord | null> {
    let raw: string
    try {
      raw = await readFile(this.pointerPath, 'utf8')
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    return parsePrimaryRuntimeActivePointer(raw)
  }

  async resolveRoot(): Promise<string | null> {
    const pointer = await this.read()
    if (!pointer) return null
    return this.resolveDirectory(pointer.directory)
  }

  async publish(
    input: PrimaryRuntimeActivePointerInput
  ): Promise<PrimaryRuntimeActivePointerRecord> {
    const directory = normalizedVersionDirectory(input.directory)
    // Publishing must observe the file after the preceding replacement. Reader
    // coalescing is safe for resolution but could otherwise reuse a stale read
    // and duplicate a generation during rapid successive publications.
    const existing = await this.readCurrentPointer()
    const pointer: PrimaryRuntimeActivePointerRecord = {
      schemaVersion: 1,
      generation: (existing?.generation ?? 0) + 1,
      version: input.version,
      archiveSha256: input.archiveSha256,
      manifestSha256: input.manifestSha256,
      directory
    }
    await this.writeAtomically(pointer)
    return pointer
  }

  /** Removes an interrupted, not-yet-published pointer write. */
  async recover(): Promise<void> {
    await rm(this.pendingPointerPath, { force: true })
  }

  /**
   * One-time migration for pre-pointer installations. The legacy directory has
   * no archive digest, so its pointer states that fact explicitly rather than
   * inventing provenance. It is first diagnosed and moved into the immutable
   * version namespace, then (and only then) made active by the pointer.
   */
  async migrateLegacyActive(diagnostics: PrimaryRuntimeDiagnostics): Promise<void> {
    if (await this.read()) return

    const legacyRoot = join(this.cacheRoot, LEGACY_ACTIVE_DIRECTORY)
    const diagnostic = await diagnostics.diagnose(legacyRoot)
    if (diagnostic.status !== 'ready' || !diagnostic.manifest || !diagnostic.root) return

    const manifestSha256 = await sha256File(join(diagnostic.root, 'runtime.json'))
    const directory = `legacy-${safePathSegment(diagnostic.manifest.bundleVersion)}-${manifestSha256}`
    const destination = join(this.versionsRoot, directory)
    await mkdir(this.versionsRoot, { recursive: true })
    if (await pathExists(destination)) {
      const existing = await diagnostics.diagnose(destination)
      if (existing.status !== 'ready') {
        throw new Error('Primary Runtime legacy migration target is not healthy.')
      }
      await rm(legacyRoot, { recursive: true, force: true })
    } else {
      await rename(legacyRoot, destination)
    }

    await this.writeAtomically({
      schemaVersion: 1,
      generation: 1,
      version: diagnostic.manifest.bundleVersion,
      archiveSha256: null,
      manifestSha256,
      directory: join(VERSIONS_DIRECTORY, directory)
    })
  }

  async resolveDirectory(directory: string): Promise<string> {
    const normalized = normalizedVersionDirectory(directory)
    const cached = this.resolvedDirectories.get(normalized)
    if (cached) return cached

    const resolution = this.resolveImmutableDirectory(normalized)
    this.resolvedDirectories.set(normalized, resolution)
    void resolution.catch(() => {
      if (this.resolvedDirectories.get(normalized) === resolution) {
        this.resolvedDirectories.delete(normalized)
      }
    })
    return resolution
  }

  private async resolveImmutableDirectory(directory: string): Promise<string> {
    const root = await this.canonicalVersionsRoot()
    const candidate = await realpath(resolve(this.cacheRoot, directory))
    if (!isPathInside(root, candidate)) {
      throw new Error('Primary Runtime active pointer escapes the versions directory.')
    }
    const details = await stat(candidate)
    if (!details.isDirectory()) {
      throw new Error('Primary Runtime active pointer does not reference a directory.')
    }
    return candidate
  }

  private async canonicalVersionsRoot(): Promise<string> {
    if (!this.resolvedVersionsRoot) {
      this.resolvedVersionsRoot = realpath(this.versionsRoot)
      void this.resolvedVersionsRoot.catch(() => {
        this.resolvedVersionsRoot = undefined
      })
    }
    return this.resolvedVersionsRoot
  }

  private async writeAtomically(pointer: PrimaryRuntimeActivePointerRecord): Promise<void> {
    await mkdir(this.cacheRoot, { recursive: true })
    const serialized = `${JSON.stringify(pointer)}\n`
    const handle = await open(this.pendingPointerPath, 'w', 0o600)
    try {
      await handle.writeFile(serialized, 'utf8')
    } finally {
      await handle.close()
    }
    await rename(this.pendingPointerPath, this.pointerPath)
  }
}

export function parsePrimaryRuntimeActivePointer(input: string): PrimaryRuntimeActivePointerRecord {
  const pointer = pointerSchema.parse(JSON.parse(input))
  normalizedVersionDirectory(pointer.directory)
  return pointer
}

export function versionDirectoryForRelease(version: string, archiveSha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(archiveSha256)) {
    throw new Error('Primary Runtime archive SHA256 must be lowercase hexadecimal.')
  }
  return join(VERSIONS_DIRECTORY, `${safePathSegment(version)}-${archiveSha256}`)
}

export async function sha256File(path: string): Promise<string> {
  const contents = await readFile(path)
  return createHash('sha256').update(contents).digest('hex')
}

function normalizedVersionDirectory(directory: string): string {
  if (
    isAbsolute(directory) ||
    directory.split(/[\\/]+/u).includes('..') ||
    !directory.startsWith(`${VERSIONS_DIRECTORY}/`) ||
    directory === VERSIONS_DIRECTORY
  ) {
    throw new Error('Primary Runtime active pointer contains an unsafe version directory.')
  }
  const normalized = directory.replace(/\\/gu, '/')
  if (!/^versions\/[A-Za-z0-9._-]+$/u.test(normalized)) {
    throw new Error('Primary Runtime active pointer contains an invalid version directory.')
  }
  return normalized
}

function safePathSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]/gu, '_')
  if (!segment || segment === '.' || segment === '..') {
    throw new Error('Primary Runtime version cannot be represented as a safe directory name.')
  }
  return segment
}

function isPathInside(root: string, path: string): boolean {
  const diff = relative(root, path)
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff))
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}
