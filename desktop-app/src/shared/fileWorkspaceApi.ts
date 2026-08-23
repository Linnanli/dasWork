import { z } from 'zod'

export const FILE_WORKSPACE_API_VERSION = 1 as const

export const FILE_WORKSPACE_MAX_DIRECTORY_ENTRIES = 500
export const FILE_WORKSPACE_DEFAULT_TEXT_BYTE_LIMIT = 1024 * 1024
export const FILE_WORKSPACE_DEFAULT_BINARY_BYTE_LIMIT = 256 * 1024
export const FILE_WORKSPACE_MAX_SEARCH_RESULTS = 200
export const FILE_WORKSPACE_MAX_SEARCH_BYTES = 2 * 1024 * 1024

const rootIdSchema = z.string().min(1).max(512)
const searchSessionIdSchema = z.string().min(1).max(512)

/**
 * Canonicalizes harmless workspace-relative path spelling. Callers must still
 * validate the result before accepting it as a workspace-relative path.
 */
export function normalizeFileWorkspaceRelativePath(path: string): string {
  const normalized = path.trim().replaceAll('\\', '/').replace(/\/+/gu, '/')
  const result = normalized
    .split('/')
    .filter((segment, index) => segment !== '.' && (segment !== '' || index === 0))
    .join('/')
    .replace(/\/$/u, '')
  return result || (normalized.startsWith('/') ? '/' : '')
}

export const fileWorkspaceRelativePathSchema = z
  .string()
  .max(4096)
  .transform((path) => path.trim())
  .superRefine((path, context) => {
    if (
      path.includes('\0') ||
      path.startsWith('/') ||
      /^[A-Za-z]:[\\/]/u.test(path) ||
      path.includes('\\') ||
      path === '..' ||
      path.startsWith('../') ||
      path.endsWith('/..') ||
      path.includes('/../') ||
      path.split('/').some((part) => part === '.')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'path must be a normalized workspace-relative path'
      })
    }
  })

export type FileWorkspaceRelativePath = z.infer<typeof fileWorkspaceRelativePathSchema>

const fileWorkspaceBaseRequestSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema
  })
  .strict()

export const fileWorkspaceEntryKindSchema = z.enum(['file', 'directory', 'symlink', 'other'])
export type FileWorkspaceEntryKind = z.infer<typeof fileWorkspaceEntryKindSchema>

export const fileWorkspaceEntrySchema = z
  .object({
    name: z.string().min(1).max(1024),
    path: fileWorkspaceRelativePathSchema,
    kind: fileWorkspaceEntryKindSchema,
    size: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    readonly: z.boolean().optional()
  })
  .strict()
export type FileWorkspaceEntry = z.infer<typeof fileWorkspaceEntrySchema>

export const fileWorkspacePathUnavailableReasonSchema = z.enum([
  'not-found',
  'not-directory',
  'not-file',
  'workspace-unavailable'
])
export type FileWorkspacePathUnavailableReason = z.infer<
  typeof fileWorkspacePathUnavailableReasonSchema
>

export const fileWorkspacePathUnavailableResultSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema,
    path: fileWorkspaceRelativePathSchema,
    unavailable: fileWorkspacePathUnavailableReasonSchema
  })
  .strict()
export type FileWorkspacePathUnavailableResult = z.infer<
  typeof fileWorkspacePathUnavailableResultSchema
>

export function isFileWorkspacePathUnavailableResult(
  result: object
): result is FileWorkspacePathUnavailableResult {
  return 'unavailable' in result
}

export const fileWorkspaceListDirectoryRequestSchema = fileWorkspaceBaseRequestSchema
  .extend({
    path: fileWorkspaceRelativePathSchema.optional(),
    limit: z.number().int().min(1).max(FILE_WORKSPACE_MAX_DIRECTORY_ENTRIES).optional()
  })
  .strict()
export type FileWorkspaceListDirectoryRequest = z.infer<
  typeof fileWorkspaceListDirectoryRequestSchema
>

export const fileWorkspaceDirectoryListingSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema,
    path: fileWorkspaceRelativePathSchema,
    entries: z.array(fileWorkspaceEntrySchema).max(FILE_WORKSPACE_MAX_DIRECTORY_ENTRIES),
    truncated: z.boolean()
  })
  .strict()
export type FileWorkspaceDirectoryListing = z.infer<typeof fileWorkspaceDirectoryListingSchema>

export const fileWorkspaceListDirectoryResultSchema = z.union([
  fileWorkspaceDirectoryListingSchema,
  fileWorkspacePathUnavailableResultSchema
])
export type FileWorkspaceListDirectoryResult = z.infer<
  typeof fileWorkspaceListDirectoryResultSchema
>

export const fileWorkspaceMetadataRequestSchema = fileWorkspaceBaseRequestSchema
  .extend({
    path: fileWorkspaceRelativePathSchema
  })
  .strict()
export type FileWorkspaceMetadataRequest = z.infer<typeof fileWorkspaceMetadataRequestSchema>

export const fileWorkspaceMetadataSuccessSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema,
    entry: fileWorkspaceEntrySchema
  })
  .strict()
export type FileWorkspaceMetadataSuccess = z.infer<typeof fileWorkspaceMetadataSuccessSchema>

export const fileWorkspaceMetadataResultSchema = z.union([
  fileWorkspaceMetadataSuccessSchema,
  fileWorkspacePathUnavailableResultSchema
])
export type FileWorkspaceMetadataResult = z.infer<typeof fileWorkspaceMetadataResultSchema>

const byteLimitSchema = z.number().int().min(1).max(FILE_WORKSPACE_MAX_SEARCH_BYTES)

export const fileWorkspaceReadFileRequestSchema = fileWorkspaceBaseRequestSchema
  .extend({
    path: fileWorkspaceRelativePathSchema,
    textByteLimit: byteLimitSchema.optional(),
    binaryByteLimit: byteLimitSchema.optional()
  })
  .strict()
export type FileWorkspaceReadFileRequest = z.infer<typeof fileWorkspaceReadFileRequestSchema>

export const fileWorkspaceReadFileContentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('text'),
      encoding: z.literal('utf8'),
      text: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('binary'),
      encoding: z.literal('base64'),
      base64: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('media'),
      url: z.string().regex(/^app:\/\/fs\/@fs\//u),
      mediaType: z.string().min(1).max(256)
    })
    .strict(),
  z
    .object({
      kind: z.literal('too-large'),
      binary: z.boolean(),
      size: z.number().int().nonnegative(),
      limit: z.number().int().positive()
    })
    .strict()
])
export type FileWorkspaceReadFileContent = z.infer<typeof fileWorkspaceReadFileContentSchema>

export const fileWorkspaceReadFileSuccessSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema,
    entry: fileWorkspaceEntrySchema,
    content: fileWorkspaceReadFileContentSchema
  })
  .strict()
export type FileWorkspaceReadFileSuccess = z.infer<typeof fileWorkspaceReadFileSuccessSchema>

export const fileWorkspaceReadFileResultSchema = z.union([
  fileWorkspaceReadFileSuccessSchema,
  fileWorkspacePathUnavailableResultSchema
])
export type FileWorkspaceReadFileResult = z.infer<typeof fileWorkspaceReadFileResultSchema>

export const fileWorkspaceSearchRequestSchema = fileWorkspaceBaseRequestSchema
  .extend({
    query: z.string().trim().min(1).max(500),
    path: fileWorkspaceRelativePathSchema.optional(),
    limit: z.number().int().min(1).max(FILE_WORKSPACE_MAX_SEARCH_RESULTS).optional(),
    includeContent: z.boolean().optional(),
    maxFileBytes: byteLimitSchema.optional()
  })
  .strict()
export type FileWorkspaceSearchRequest = z.infer<typeof fileWorkspaceSearchRequestSchema>

export const fileWorkspaceSearchMatchSchema = z
  .object({
    path: fileWorkspaceRelativePathSchema,
    kind: z.enum(['path', 'content']),
    line: z.number().int().positive().optional(),
    preview: z.string().max(1000).optional()
  })
  .strict()
export type FileWorkspaceSearchMatch = z.infer<typeof fileWorkspaceSearchMatchSchema>

export const fileWorkspaceSearchResultSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema,
    query: z.string().min(1).max(500),
    matches: z.array(fileWorkspaceSearchMatchSchema).max(FILE_WORKSPACE_MAX_SEARCH_RESULTS),
    truncated: z.boolean()
  })
  .strict()
export type FileWorkspaceSearchResult = z.infer<typeof fileWorkspaceSearchResultSchema>

export const fileWorkspaceSearchSessionStartRequestSchema = fileWorkspaceBaseRequestSchema.strict()
export type FileWorkspaceSearchSessionStartRequest = z.infer<
  typeof fileWorkspaceSearchSessionStartRequestSchema
>

export const fileWorkspaceSearchSessionStartResultSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    rootId: rootIdSchema,
    sessionId: searchSessionIdSchema
  })
  .strict()
export type FileWorkspaceSearchSessionStartResult = z.infer<
  typeof fileWorkspaceSearchSessionStartResultSchema
>

export const fileWorkspaceSearchSessionUpdateRequestSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    sessionId: searchSessionIdSchema,
    query: z.string().trim().max(500)
  })
  .strict()
export type FileWorkspaceSearchSessionUpdateRequest = z.infer<
  typeof fileWorkspaceSearchSessionUpdateRequestSchema
>

export const fileWorkspaceSearchSessionStopRequestSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    sessionId: searchSessionIdSchema
  })
  .strict()
export type FileWorkspaceSearchSessionStopRequest = z.infer<
  typeof fileWorkspaceSearchSessionStopRequestSchema
>

export const fileWorkspaceSearchSessionEventSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    type: z.literal('search-results'),
    rootId: rootIdSchema,
    sessionId: searchSessionIdSchema,
    query: z.string().max(500),
    matches: z.array(fileWorkspaceSearchMatchSchema).max(FILE_WORKSPACE_MAX_SEARCH_RESULTS),
    complete: z.boolean(),
    error: z.string().max(2000).optional()
  })
  .strict()
export type FileWorkspaceSearchSessionEvent = z.infer<typeof fileWorkspaceSearchSessionEventSchema>

export const fileWorkspaceEventSchema = z
  .object({
    version: z.literal(FILE_WORKSPACE_API_VERSION),
    type: z.literal('changed'),
    rootId: rootIdSchema,
    path: fileWorkspaceRelativePathSchema.optional()
  })
  .strict()
export type FileWorkspaceEvent = z.infer<typeof fileWorkspaceEventSchema>
