import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { basename } from 'node:path'

import {
  ARTIFACT_PREVIEW_API_VERSION,
  ARTIFACT_PREVIEW_MAX_BYTES,
  artifactPreviewComposerAttachmentResultSchema,
  artifactPreviewMetadataResultSchema,
  artifactPreviewReadBinaryResultSchema,
  artifactPreviewRegisterSourceResultSchema,
  type ArtifactPreviewFileIdentity,
  type ArtifactPreviewComposerAttachment,
  type ArtifactPreviewComposerAttachmentResult,
  type ArtifactPreviewMetadata,
  type ArtifactPreviewMetadataResult,
  type ArtifactPreviewReadBinaryResult,
  type ArtifactPreviewRegisterAuthorizedLocalSourceRequest,
  type ArtifactPreviewRegisterSourceResult,
  type ArtifactPreviewRegisterWorkspaceSourceRequest,
  type ArtifactPreviewUnavailableReason
} from '../../shared/artifactPreviewApi'
import type { PersistedArtifactPreviewSource } from './ArtifactPreviewSourceManifest'

export type ArtifactPreviewResolvedWorkspaceFile = {
  absolutePath: string
  relativePath: string
  identity: ArtifactPreviewFileIdentity
}

export type ArtifactPreviewAuthorizedLocalFile = {
  absolutePath: string
  identity: ArtifactPreviewFileIdentity
}

export type ArtifactPreviewSourceServiceOptions = {
  resolveWorkspaceFile(
    input: ArtifactPreviewRegisterWorkspaceSourceRequest
  ): Promise<ArtifactPreviewResolvedWorkspaceFile>
  redeemAuthorizedLocalPreview(
    capabilityToken: string
  ): Promise<ArtifactPreviewAuthorizedLocalFile> | ArtifactPreviewAuthorizedLocalFile
  issueComposerAttachment?(input: {
    sourceId: string
    absolutePath: string
    identity: ArtifactPreviewFileIdentity
    label: string
  }): ArtifactPreviewComposerAttachment
  now?: () => number
  ttlMs?: number
  loadAuthorizedLocalSources?(): readonly PersistedArtifactPreviewSource[]
  persistAuthorizedLocalSource?(source: PersistedArtifactPreviewSource): void
  removeAuthorizedLocalSource?(sourceId: string): void
}

type WorkspaceRecord = {
  kind: 'workspace-file'
  rootId: string
  relativePath: string
}

type AuthorizedRecord = {
  kind: 'authorized-local'
  absolutePath: string
  expectedIdentity: ArtifactPreviewFileIdentity
}

type SourceRecord = (WorkspaceRecord | AuthorizedRecord) & {
  sourceId: string
  generation: number
  identity: ArtifactPreviewFileIdentity
  expiresAt: number
  watcher?: FSWatcher
}

type ResolvedSource = {
  absolutePath: string
  identity: ArtifactPreviewFileIdentity
  metadata: ArtifactPreviewMetadata
  expectedIdentity?: ArtifactPreviewFileIdentity
}

/**
 * Main-process-only capability registry for Artifact bytes.  It deliberately
 * exposes no absolute paths to the renderer and reads a bounded `limit + 1`
 * bytes rather than trusting a preceding stat result.
 */
export class ArtifactPreviewSourceService {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly listeners = new Set<(sourceId: string) => void>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly options: ArtifactPreviewSourceServiceOptions) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000
    for (const source of options.loadAuthorizedLocalSources?.() ?? []) {
      if (source.expiresAt <= this.now()) continue
      const record: SourceRecord = {
        kind: 'authorized-local',
        sourceId: source.sourceId,
        absolutePath: source.absolutePath,
        expectedIdentity: source.identity,
        identity: source.identity,
        generation: 0,
        expiresAt: source.expiresAt
      }
      this.sources.set(record.sourceId, record)
      this.watchSource(record, record.absolutePath)
    }
  }

  async registerWorkspaceSource(
    input: ArtifactPreviewRegisterWorkspaceSourceRequest
  ): Promise<ArtifactPreviewRegisterSourceResult> {
    this.deleteExpired()
    const resolved = await this.options.resolveWorkspaceFile(input)
    const sourceId = opaqueId()
    const record: SourceRecord = {
      kind: 'workspace-file',
      sourceId,
      rootId: input.rootId,
      relativePath: resolved.relativePath,
      identity: resolved.identity,
      generation: 0,
      expiresAt: this.expiresAt()
    }
    this.sources.set(sourceId, record)
    this.watchSource(record, resolved.absolutePath)
    return artifactPreviewRegisterSourceResultSchema.parse({
      version: ARTIFACT_PREVIEW_API_VERSION,
      sourceId,
      metadata: metadataFor(resolved.relativePath, resolved.identity, record.generation)
    })
  }

  async registerAuthorizedLocalSource(
    input: ArtifactPreviewRegisterAuthorizedLocalSourceRequest
  ): Promise<ArtifactPreviewRegisterSourceResult> {
    this.deleteExpired()
    const resolved = await this.options.redeemAuthorizedLocalPreview(input.capabilityToken)
    const sourceId = opaqueId()
    const record: SourceRecord = {
      kind: 'authorized-local',
      sourceId,
      absolutePath: resolved.absolutePath,
      expectedIdentity: resolved.identity,
      identity: resolved.identity,
      generation: 0,
      expiresAt: this.expiresAt()
    }
    this.sources.set(sourceId, record)
    this.watchSource(record, resolved.absolutePath)
    this.persistAuthorizedLocal(record)
    return artifactPreviewRegisterSourceResultSchema.parse({
      version: ARTIFACT_PREVIEW_API_VERSION,
      sourceId,
      metadata: metadataFor(resolved.absolutePath, resolved.identity, record.generation)
    })
  }

  async metadata(sourceId: string): Promise<ArtifactPreviewMetadataResult> {
    const resolved = await this.resolve(sourceId)
    if ('unavailable' in resolved) return unavailableMetadata(sourceId, resolved.unavailable)
    return artifactPreviewMetadataResultSchema.parse({
      version: ARTIFACT_PREVIEW_API_VERSION,
      sourceId,
      metadata: resolved.metadata
    })
  }

  async readBinary(sourceId: string): Promise<ArtifactPreviewReadBinaryResult> {
    const resolved = await this.resolve(sourceId)
    if ('unavailable' in resolved) return unavailableBinary(sourceId, resolved.unavailable)

    let handle: FileHandle | undefined
    try {
      handle = await open(resolved.absolutePath, 'r')
      if (
        resolved.expectedIdentity &&
        !sameIdentity(resolved.expectedIdentity, identityFromStat(await handle.stat()))
      ) {
        return unavailableBinary(sourceId, 'identity-changed')
      }
      const bytes = Buffer.allocUnsafe(ARTIFACT_PREVIEW_MAX_BYTES + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > ARTIFACT_PREVIEW_MAX_BYTES) {
        return artifactPreviewReadBinaryResultSchema.parse({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId,
          content: {
            kind: 'too-large',
            size: bytesRead,
            limit: ARTIFACT_PREVIEW_MAX_BYTES,
            generation: resolved.metadata.generation
          }
        })
      }
      const content = bytes.subarray(0, bytesRead)
      return artifactPreviewReadBinaryResultSchema.parse({
        version: ARTIFACT_PREVIEW_API_VERSION,
        sourceId,
        content: {
          kind: 'binary',
          encoding: 'base64',
          base64: content.toString('base64'),
          checksum: createHash('sha256').update(content).digest('hex'),
          generation: resolved.metadata.generation
        }
      })
    } catch (error) {
      if (isMissingPathError(error)) return unavailableBinary(sourceId, 'not-found')
      throw error
    } finally {
      await handle?.close()
    }
  }

  async createComposerAttachment(
    sourceId: string
  ): Promise<ArtifactPreviewComposerAttachmentResult> {
    const resolved = await this.resolve(sourceId)
    if ('unavailable' in resolved) throw new Error('Artifact source is unavailable.')
    if (!this.options.issueComposerAttachment)
      throw new Error('Artifact composer attachments are not configured.')
    return artifactPreviewComposerAttachmentResultSchema.parse({
      version: ARTIFACT_PREVIEW_API_VERSION,
      sourceId,
      attachment: this.options.issueComposerAttachment({
        sourceId,
        absolutePath: resolved.absolutePath,
        identity: resolved.identity,
        label: resolved.metadata.name
      })
    })
  }

  release(sourceId: string): void {
    const source = this.sources.get(sourceId)
    source?.watcher?.close()
    if (source?.kind === 'authorized-local') this.options.removeAuthorizedLocalSource?.(sourceId)
    this.sources.delete(sourceId)
  }

  onChange(listener: (sourceId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    for (const source of this.sources.values()) source.watcher?.close()
    this.sources.clear()
    this.listeners.clear()
  }

  async resolveFileForSystemOpen(sourceId: string): Promise<string> {
    const resolved = await this.resolve(sourceId)
    if ('unavailable' in resolved) throw new Error('Artifact source is unavailable.')
    return resolved.absolutePath
  }

  private async resolve(
    sourceId: string
  ): Promise<ResolvedSource | { unavailable: ArtifactPreviewUnavailableReason }> {
    this.deleteExpired()
    const record = this.sources.get(sourceId)
    if (!record) return { unavailable: 'expired' }
    record.expiresAt = this.expiresAt()

    try {
      if (record.kind === 'workspace-file') {
        const resolved = await this.options.resolveWorkspaceFile({
          version: ARTIFACT_PREVIEW_API_VERSION,
          rootId: record.rootId,
          path: record.relativePath
        })
        this.advanceGeneration(record, resolved.identity)
        return {
          absolutePath: resolved.absolutePath,
          identity: resolved.identity,
          metadata: metadataFor(resolved.relativePath, resolved.identity, record.generation)
        }
      }

      const nextIdentity = identityFromStat(await stat(record.absolutePath))
      if (!sameIdentity(record.expectedIdentity, nextIdentity))
        return { unavailable: 'identity-changed' }
      this.advanceGeneration(record, nextIdentity)
      return {
        absolutePath: record.absolutePath,
        identity: nextIdentity,
        metadata: metadataFor(record.absolutePath, nextIdentity, record.generation),
        expectedIdentity: record.expectedIdentity
      }
    } catch (error) {
      if (isMissingPathError(error)) return { unavailable: 'not-found' }
      if (error instanceof WorkspaceUnavailableError)
        return { unavailable: 'workspace-unavailable' }
      throw error
    }
  }

  private advanceGeneration(record: SourceRecord, nextIdentity: ArtifactPreviewFileIdentity): void {
    if (!sameIdentity(record.identity, nextIdentity)) {
      record.identity = nextIdentity
      record.generation += 1
    }
  }

  private expiresAt(): number {
    return this.now() + this.ttlMs
  }

  private deleteExpired(): void {
    const now = this.now()
    for (const [sourceId, source] of this.sources) {
      if (source.expiresAt <= now) {
        source.watcher?.close()
        if (source.kind === 'authorized-local') this.options.removeAuthorizedLocalSource?.(sourceId)
        this.sources.delete(sourceId)
      }
    }
  }

  private watchSource(record: SourceRecord, absolutePath: string): void {
    try {
      record.watcher = watch(absolutePath, { persistent: false }, () => {
        for (const listener of this.listeners) listener(record.sourceId)
      })
      record.watcher.on('error', () => undefined)
    } catch {
      // Filesystems without watch support remain safe because every read revalidates identity.
    }
  }

  private persistAuthorizedLocal(record: {
    sourceId: string
    absolutePath: string
    expectedIdentity: ArtifactPreviewFileIdentity
    expiresAt: number
  }): void {
    this.options.persistAuthorizedLocalSource?.({
      sourceId: record.sourceId,
      absolutePath: record.absolutePath,
      identity: record.expectedIdentity,
      expiresAt: record.expiresAt
    })
  }
}

/** Lets an IPC resolver map an owned-root failure without leaking native errors. */
export class WorkspaceUnavailableError extends Error {}

function opaqueId(): string {
  return randomUUID().replaceAll('-', '')
}

function metadataFor(
  path: string,
  identity: ArtifactPreviewFileIdentity,
  generation: number
): ArtifactPreviewMetadata {
  return {
    name: basename(path) || 'presentation.pptx',
    size: identity.size,
    mtimeMs: identity.mtimeMs,
    generation
  }
}

function identityFromStat(value: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
}): ArtifactPreviewFileIdentity {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs }
}

function sameIdentity(
  left: ArtifactPreviewFileIdentity,
  right: ArtifactPreviewFileIdentity
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  )
}

function unavailableMetadata(
  sourceId: string,
  unavailable: ArtifactPreviewUnavailableReason
): ArtifactPreviewMetadataResult {
  return artifactPreviewMetadataResultSchema.parse({
    version: ARTIFACT_PREVIEW_API_VERSION,
    sourceId,
    unavailable
  })
}

function unavailableBinary(
  sourceId: string,
  unavailable: ArtifactPreviewUnavailableReason
): ArtifactPreviewReadBinaryResult {
  return artifactPreviewReadBinaryResultSchema.parse({
    version: ARTIFACT_PREVIEW_API_VERSION,
    sourceId,
    unavailable
  })
}

function isMissingPathError(cause: unknown): cause is NodeJS.ErrnoException {
  return Boolean(
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    ((cause as NodeJS.ErrnoException).code === 'ENOENT' ||
      (cause as NodeJS.ErrnoException).code === 'ENOTDIR')
  )
}
