import type { AttachmentAdapter, CreateAttachment } from '@assistant-ui/react'

import {
  LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
  LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE
} from '../../../shared/composerContext'

type LocalImageAttachmentSource = {
  capabilityToken?: string
  label: string
  mediaType: string
  path?: string
  previewUrl: string
}

export const localFileAttachmentMediaType = LOCAL_FILE_ATTACHMENT_MEDIA_TYPE
export const localFolderAttachmentMediaType = LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE

function createAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `image-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error(`无法读取图片“${file.name}”`))
    }
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取图片“${file.name}”`))
    reader.onabort = () => reject(new Error(`已取消读取图片“${file.name}”`))
    reader.readAsDataURL(file)
  })
}

export function createLocalImageAttachment({
  capabilityToken,
  label,
  mediaType,
  path,
  previewUrl
}: LocalImageAttachmentSource): CreateAttachment {
  const identity = path
    ? ({ path, capabilityToken } satisfies LocalImageAttachmentIdentity)
    : undefined
  return {
    ...(identity ? { id: `local-image:${encodeURIComponent(JSON.stringify(identity))}` } : {}),
    type: 'image' as const,
    name: label,
    contentType: mediaType,
    content: [
      {
        type: 'file' as const,
        filename: label,
        mimeType: mediaType,
        data: previewUrl
      }
    ]
  }
}

export type LocalImageAttachmentIdentity = {
  capabilityToken?: string
  path: string
}

export function localImageAttachmentIdentityFromId(
  attachmentId: unknown
): LocalImageAttachmentIdentity | undefined {
  const prefix = 'local-image:'
  if (typeof attachmentId !== 'string') return undefined
  if (!attachmentId.startsWith(prefix)) return undefined
  try {
    const value = JSON.parse(decodeURIComponent(attachmentId.slice(prefix.length))) as unknown
    if (!value || typeof value !== 'object') return undefined
    const identity = value as Partial<LocalImageAttachmentIdentity>
    if (typeof identity.path !== 'string' || identity.path.length === 0) return undefined
    return identity as LocalImageAttachmentIdentity
  } catch {
    return undefined
  }
}

export function createLocalPathAttachment({
  artifactPreviewToken,
  capabilityToken,
  fileUrl,
  kind,
  label,
  path
}: {
  artifactPreviewToken?: string
  capabilityToken?: string
  fileUrl: string
  kind: 'file' | 'folder'
  label: string
  path: string
}): CreateAttachment {
  const contentType =
    kind === 'folder' ? localFolderAttachmentMediaType : localFileAttachmentMediaType
  const identity = {
    artifactPreviewToken,
    capabilityToken,
    fileUrl,
    kind,
    path
  } satisfies LocalPathAttachmentIdentity
  return {
    id: `local-context:${encodeURIComponent(JSON.stringify(identity))}`,
    type: 'file',
    name: label,
    contentType,
    content: [
      {
        type: 'file',
        filename: label,
        mimeType: contentType,
        data: fileUrl
      }
    ]
  }
}

export type LocalPathAttachmentIdentity = {
  artifactPreviewToken?: string
  capabilityToken?: string
  fileUrl: string
  kind: 'file' | 'folder'
  path: string
}

export type ArtifactSourceAttachmentIdentity = {
  sourceId: string
  url: string
}

export function createArtifactSourceAttachment({
  sourceId,
  label,
  url
}: {
  sourceId: string
  label: string
  url: string
}): CreateAttachment {
  const identity = { sourceId, url } satisfies ArtifactSourceAttachmentIdentity
  return {
    id: `artifact-source:${encodeURIComponent(JSON.stringify(identity))}`,
    type: 'file',
    name: label,
    contentType: localFileAttachmentMediaType,
    content: [
      {
        type: 'file',
        filename: label,
        mimeType: localFileAttachmentMediaType,
        data: url
      }
    ]
  }
}

export function artifactSourceAttachmentIdentityFromId(
  attachmentId: unknown
): ArtifactSourceAttachmentIdentity | undefined {
  const prefix = 'artifact-source:'
  if (typeof attachmentId !== 'string') return undefined
  if (!attachmentId.startsWith(prefix)) return undefined
  try {
    const value = JSON.parse(decodeURIComponent(attachmentId.slice(prefix.length))) as unknown
    if (!value || typeof value !== 'object') return undefined
    const identity = value as Partial<ArtifactSourceAttachmentIdentity>
    if (
      typeof identity.sourceId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,256}$/u.test(identity.sourceId) ||
      typeof identity.url !== 'string' ||
      !identity.url.startsWith(`dascowork-artifact://${identity.sourceId}/`)
    ) {
      return undefined
    }
    return identity as ArtifactSourceAttachmentIdentity
  } catch {
    return undefined
  }
}

export function artifactSourceIdFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'dascowork-artifact:' && /^[A-Za-z0-9_-]{16,256}$/u.test(url.hostname)
      ? url.hostname
      : undefined
  } catch {
    return undefined
  }
}

export function localPathAttachmentIdentityFromId(
  attachmentId: unknown
): LocalPathAttachmentIdentity | undefined {
  const prefix = 'local-context:'
  if (typeof attachmentId !== 'string') return undefined
  if (!attachmentId.startsWith(prefix)) return undefined
  try {
    const value = JSON.parse(decodeURIComponent(attachmentId.slice(prefix.length))) as unknown
    if (!value || typeof value !== 'object') return undefined
    const identity = value as Partial<LocalPathAttachmentIdentity>
    if (
      (identity.kind !== 'file' && identity.kind !== 'folder') ||
      typeof identity.path !== 'string' ||
      typeof identity.fileUrl !== 'string' ||
      (identity.capabilityToken !== undefined &&
        (typeof identity.capabilityToken !== 'string' || identity.capabilityToken.length === 0)) ||
      (identity.artifactPreviewToken !== undefined &&
        (typeof identity.artifactPreviewToken !== 'string' ||
          identity.artifactPreviewToken.length < 16)) ||
      !identity.fileUrl.startsWith('file:')
    ) {
      return undefined
    }
    return identity as LocalPathAttachmentIdentity
  } catch {
    return undefined
  }
}

/**
 * Image-only adapter for AI SDK UIMessage file parts. Keeping the completed
 * content as a `file` part preserves the selected file's MIME type—assistant-ui's
 * `image` content part otherwise assumes image/png when creating a UIMessage.
 */
export const imageAttachmentAdapter = {
  accept: `image/*,${localFileAttachmentMediaType},${localFolderAttachmentMediaType}`,

  async add({ file }) {
    return {
      id: createAttachmentId(),
      type: 'image',
      name: file.name,
      contentType: file.type,
      file,
      content: [],
      status: { type: 'requires-action', reason: 'composer-send' }
    }
  },

  async send(attachment) {
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          filename: attachment.name,
          mimeType: attachment.contentType ?? attachment.file.type,
          data: await readFileAsDataUrl(attachment.file)
        }
      ]
    }
  },

  async remove() {
    // Local File objects are owned by the browser; there is no remote upload to clean up.
  }
} satisfies AttachmentAdapter
