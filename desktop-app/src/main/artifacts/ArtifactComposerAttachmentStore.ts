import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import type { UIMessage } from 'ai'

import type {
  ArtifactPreviewComposerAttachment,
  ArtifactPreviewFileIdentity
} from '../../shared/artifactPreviewApi'

const attachmentProtocol = 'dascowork-artifact:'
const defaultTtlMs = 6 * 60 * 60 * 1000

type AttachmentRecord = {
  absolutePath: string
  identity: ArtifactPreviewFileIdentity
  sourceId: string
  expiresAt: number
}

/**
 * Converts a renderer-safe, opaque Artifact URL into a local file URL only at
 * the final main-process-to-provider boundary. This is deliberately separate
 * from picker send capabilities: an Artifact source can be previewed and then
 * added to the composer without exposing or trusting a renderer-provided path.
 */
export class ArtifactComposerAttachmentStore {
  private readonly attachments = new Map<string, AttachmentRecord>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = defaultTtlMs
  ) {}

  issue(input: {
    sourceId: string
    absolutePath: string
    identity: ArtifactPreviewFileIdentity
    label: string
  }): ArtifactPreviewComposerAttachment {
    this.deleteExpired()
    const attachmentId = randomUUID().replaceAll('-', '')
    this.attachments.set(attachmentId, {
      absolutePath: input.absolutePath,
      identity: input.identity,
      sourceId: input.sourceId,
      expiresAt: this.now() + this.ttlMs
    })
    return {
      sourceId: input.sourceId,
      label: input.label,
      url: `${attachmentProtocol}//${input.sourceId}/${attachmentId}`
    }
  }

  async restoreInMessages(messages: readonly UIMessage[]): Promise<UIMessage[]> {
    return Promise.all(
      messages.map(async (message) => ({
        ...message,
        parts: await Promise.all(
          message.parts.map(async (part) => {
            if (part.type !== 'file' || !isArtifactAttachmentUrl(part.url)) return part
            return { ...part, url: await this.resolve(part.url) }
          })
        )
      }))
    )
  }

  private async resolve(url: string): Promise<string> {
    this.deleteExpired()
    const parsed = parseArtifactAttachmentUrl(url)
    if (!parsed) throw new Error('Artifact attachment reference is invalid.')
    const record = this.attachments.get(parsed.attachmentId)
    if (!record || record.sourceId !== parsed.sourceId)
      throw new Error('Artifact attachment reference is unavailable.')
    const metadata = await stat(record.absolutePath).catch(() => undefined)
    if (!metadata || !sameIdentity(record.identity, metadata)) {
      this.attachments.delete(parsed.attachmentId)
      throw new Error('Artifact attachment source has changed or is unavailable.')
    }
    record.expiresAt = this.now() + this.ttlMs
    return pathToFileURL(record.absolutePath).href
  }

  private deleteExpired(): void {
    const now = this.now()
    for (const [attachmentId, attachment] of this.attachments) {
      if (attachment.expiresAt <= now) this.attachments.delete(attachmentId)
    }
  }
}

function isArtifactAttachmentUrl(value: string): boolean {
  return value.startsWith(`${attachmentProtocol}//`)
}

function parseArtifactAttachmentUrl(
  value: string
): { sourceId: string; attachmentId: string } | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== attachmentProtocol) return undefined
    const sourceId = url.hostname
    const attachmentId = url.pathname.slice(1)
    if (
      !/^[A-Za-z0-9_-]{16,256}$/u.test(sourceId) ||
      !/^[A-Za-z0-9_-]{16,256}$/u.test(attachmentId) ||
      url.search ||
      url.hash
    ) {
      return undefined
    }
    return { sourceId, attachmentId }
  } catch {
    return undefined
  }
}

function sameIdentity(
  expected: ArtifactPreviewFileIdentity,
  actual: { dev: number; ino: number; size: number; mtimeMs: number }
): boolean {
  return (
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeMs === actual.mtimeMs
  )
}
