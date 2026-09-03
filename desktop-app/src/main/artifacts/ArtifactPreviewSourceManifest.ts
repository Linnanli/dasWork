import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ArtifactPreviewFileIdentity } from '../../shared/artifactPreviewApi'

export type PersistedArtifactPreviewSource = {
  sourceId: string
  absolutePath: string
  identity: ArtifactPreviewFileIdentity
  expiresAt: number
}

/**
 * Small private manifest for picker-authorized Artifact sources. It is never
 * exposed to the renderer and preserves identity validation across restarts.
 */
export class ArtifactPreviewSourceManifest {
  constructor(private readonly path: string) {}

  load(now = Date.now()): readonly PersistedArtifactPreviewSource[] {
    const records = readRecords(this.path)
    const active = records.filter((record) => record.expiresAt > now)
    if (active.length !== records.length) this.write(active)
    return active
  }

  upsert(record: PersistedArtifactPreviewSource): void {
    const records = this.load().filter((current) => current.sourceId !== record.sourceId)
    this.write([...records, record])
  }

  remove(sourceId: string): void {
    const records = this.load().filter((record) => record.sourceId !== sourceId)
    this.write(records)
  }

  private write(records: readonly PersistedArtifactPreviewSource[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, records }), { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch {
      // Losing restart restoration is safer than failing the desktop shell.
    }
  }
}

function readRecords(path: string): PersistedArtifactPreviewSource[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.records)) return []
    return parsed.records.flatMap((record) => (isPersistedRecord(record) ? [record] : []))
  } catch {
    return []
  }
}

function isPersistedRecord(value: unknown): value is PersistedArtifactPreviewSource {
  if (!isRecord(value) || !isRecord(value.identity)) return false
  const identity = value.identity
  return (
    typeof value.sourceId === 'string' &&
    /^[A-Za-z0-9_-]{16,256}$/u.test(value.sourceId) &&
    typeof value.absolutePath === 'string' &&
    value.absolutePath.length > 0 &&
    typeof value.expiresAt === 'number' &&
    Number.isFinite(value.expiresAt) &&
    ['dev', 'ino', 'size', 'mtimeMs'].every(
      (key) => typeof identity[key] === 'number' && Number.isFinite(identity[key])
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
