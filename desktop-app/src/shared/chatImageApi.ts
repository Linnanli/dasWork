import { z } from 'zod'

export const chatImageIpcChannels = {
  resolveSource: 'codex:resolve-image-source',
  save: 'codex:save-image'
} as const

export const chatImageRequestSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(64 * 1024 * 1024)
      .refine((value) => !value.includes('\0')),
    sourceKind: z.enum(['markdown-url', 'native-path', 'media-url']),
    conversationId: z.string().min(1).max(256).optional(),
    threadId: z.string().min(1).max(256).optional()
  })
  .strict()

export type ChatImageSourceKind = z.infer<typeof chatImageRequestSchema>['sourceKind']
export type ChatImageRequest = z.infer<typeof chatImageRequestSchema>

export const chatImageSaveRequestSchema = chatImageRequestSchema.extend({
  fileName: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (value) =>
        !/[\\/]/u.test(value) &&
        ![...value].some((character) => character.charCodeAt(0) < 32) &&
        value !== '.' &&
        value !== '..'
    )
    .optional()
})
export type ChatImageSaveRequest = z.infer<typeof chatImageSaveRequestSchema>

export const chatImageResolveResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      displaySrc: z.string().min(1),
      fileName: z.string().optional()
    })
    .strict(),
  z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict()
])
export type ChatImageResolveResult = z.infer<typeof chatImageResolveResultSchema>

export const chatImageSaveResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), path: z.string().min(1) }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({ status: z.literal('failed'), message: z.string().min(1) }).strict()
])
export type ChatImageSaveResult = z.infer<typeof chatImageSaveResultSchema>

const imageMimeTypes = new Set([
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/svg+xml',
  'image/tiff',
  'image/webp',
  'image/x-icon'
])

export function isChatImageMimeType(value: string): boolean {
  return imageMimeTypes.has(value.toLowerCase().split(';', 1)[0]!.trim())
}

export function parseChatImageDataUrl(value: string): {
  mimeType: string
  encoding: 'base64' | 'url'
  data: string
} | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]+)$/iu.exec(value)
  if (!match || !isChatImageMimeType(match[1]!)) return null
  const data = match[3]!
  if (match[2]) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
      return null
    }
    return { mimeType: match[1]!.toLowerCase(), encoding: 'base64', data }
  }
  if (/%(?![0-9a-f]{2})/iu.test(data)) return null
  return { mimeType: match[1]!.toLowerCase(), encoding: 'url', data }
}
