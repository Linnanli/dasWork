import { z } from 'zod'

import { fileWorkspaceRelativePathSchema } from './fileWorkspaceApi'

export const ARTIFACT_PREVIEW_API_VERSION = 1 as const
export const ARTIFACT_PREVIEW_MAX_BYTES = 40 * 1024 * 1024

const sourceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u)
const rootIdSchema = z.string().min(1).max(512)
const opaqueCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u)

const requestBaseSchema = z.object({ version: z.literal(ARTIFACT_PREVIEW_API_VERSION) }).strict()

export const artifactPreviewRegisterWorkspaceSourceRequestSchema = requestBaseSchema
  .extend({ rootId: rootIdSchema, path: fileWorkspaceRelativePathSchema })
  .strict()
export type ArtifactPreviewRegisterWorkspaceSourceRequest = z.infer<
  typeof artifactPreviewRegisterWorkspaceSourceRequestSchema
>

export const artifactPreviewRegisterAuthorizedLocalSourceRequestSchema = requestBaseSchema
  .extend({ capabilityToken: opaqueCapabilitySchema })
  .strict()
export type ArtifactPreviewRegisterAuthorizedLocalSourceRequest = z.infer<
  typeof artifactPreviewRegisterAuthorizedLocalSourceRequestSchema
>

export const artifactPreviewSourceRequestSchema = requestBaseSchema
  .extend({ sourceId: sourceIdSchema })
  .strict()
export type ArtifactPreviewSourceRequest = z.infer<typeof artifactPreviewSourceRequestSchema>

const artifactAttachmentUrlSchema = z
  .string()
  .regex(/^dascowork-artifact:\/\/[A-Za-z0-9_-]{16,256}\/[A-Za-z0-9_-]{16,256}$/u)

/**
 * This is an opaque, main-process-resolved URL. It is intentionally not a
 * `file:` URL, so the renderer never receives the source's absolute path.
 */
export const artifactPreviewComposerAttachmentSchema = z
  .object({
    sourceId: sourceIdSchema,
    label: z.string().min(1).max(1024),
    url: artifactAttachmentUrlSchema
  })
  .strict()
export type ArtifactPreviewComposerAttachment = z.infer<
  typeof artifactPreviewComposerAttachmentSchema
>

export const artifactPreviewFileIdentitySchema = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative()
  })
  .strict()
export type ArtifactPreviewFileIdentity = z.infer<typeof artifactPreviewFileIdentitySchema>

export const artifactPreviewMetadataSchema = z
  .object({
    name: z.string().min(1).max(1024),
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    generation: z.number().int().nonnegative()
  })
  .strict()
export type ArtifactPreviewMetadata = z.infer<typeof artifactPreviewMetadataSchema>

export const artifactPreviewUnavailableReasonSchema = z.enum([
  'not-found',
  'identity-changed',
  'workspace-unavailable',
  'not-file',
  'expired'
])
export type ArtifactPreviewUnavailableReason = z.infer<
  typeof artifactPreviewUnavailableReasonSchema
>

const artifactPreviewSuccessSchema = z
  .object({ version: z.literal(ARTIFACT_PREVIEW_API_VERSION), sourceId: sourceIdSchema })
  .strict()

export const artifactPreviewComposerAttachmentResultSchema = artifactPreviewSuccessSchema
  .extend({ attachment: artifactPreviewComposerAttachmentSchema })
  .strict()
export type ArtifactPreviewComposerAttachmentResult = z.infer<
  typeof artifactPreviewComposerAttachmentResultSchema
>

export const artifactPreviewRegisterSourceResultSchema = artifactPreviewSuccessSchema
  .extend({ metadata: artifactPreviewMetadataSchema })
  .strict()
export type ArtifactPreviewRegisterSourceResult = z.infer<
  typeof artifactPreviewRegisterSourceResultSchema
>

export const artifactPreviewMetadataResultSchema = z.union([
  artifactPreviewSuccessSchema.extend({ metadata: artifactPreviewMetadataSchema }).strict(),
  artifactPreviewSuccessSchema
    .extend({ unavailable: artifactPreviewUnavailableReasonSchema })
    .strict()
])
export type ArtifactPreviewMetadataResult = z.infer<typeof artifactPreviewMetadataResultSchema>

export const artifactPreviewReadBinaryResultSchema = z.union([
  artifactPreviewSuccessSchema
    .extend({
      content: z
        .object({
          kind: z.literal('binary'),
          encoding: z.literal('base64'),
          base64: z.string(),
          checksum: z.string().regex(/^[a-f0-9]{64}$/u),
          generation: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict(),
  artifactPreviewSuccessSchema
    .extend({
      content: z
        .object({
          kind: z.literal('too-large'),
          size: z.number().int().nonnegative(),
          limit: z.literal(ARTIFACT_PREVIEW_MAX_BYTES),
          generation: z.number().int().nonnegative()
        })
        .strict()
    })
    .strict(),
  artifactPreviewSuccessSchema
    .extend({ unavailable: artifactPreviewUnavailableReasonSchema })
    .strict()
])
export type ArtifactPreviewReadBinaryResult = z.infer<typeof artifactPreviewReadBinaryResultSchema>

export const artifactPreviewSourceChangeEventSchema = z
  .object({ version: z.literal(ARTIFACT_PREVIEW_API_VERSION), sourceId: sourceIdSchema })
  .strict()
export type ArtifactPreviewSourceChangeEvent = z.infer<
  typeof artifactPreviewSourceChangeEventSchema
>

export function isArtifactPreviewUnavailableResult(
  result: ArtifactPreviewMetadataResult | ArtifactPreviewReadBinaryResult
): result is {
  version: typeof ARTIFACT_PREVIEW_API_VERSION
  sourceId: string
  unavailable: ArtifactPreviewUnavailableReason
} {
  return 'unavailable' in result
}
