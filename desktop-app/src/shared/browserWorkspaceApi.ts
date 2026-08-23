import { z } from 'zod'

export const BROWSER_WORKSPACE_API_VERSION = 1 as const

const workspaceIdSchema = z.string().min(1).max(256)
const browserViewIdSchema = z.string().min(1).max(256)
export const BROWSER_WORKSPACE_BLANK_URL = 'about:blank' as const
const httpUrlSchema = z
  .string()
  .url()
  .max(32_768)
  .refine((value) => isBrowserWorkspaceUrl(value), {
    message: 'browser workspace URL must use HTTP or HTTPS'
  })
const browserWorkspaceUrlSchema = z.union([z.literal(BROWSER_WORKSPACE_BLANK_URL), httpUrlSchema])
const httpsUrlSchema = httpUrlSchema.refine((value) => new URL(value).protocol === 'https:', {
  message: 'browser workspace favicon URL must use HTTPS'
})

export const browserWorkspaceIpcChannels = {
  create: 'right-workspace:browser:create',
  navigate: 'right-workspace:browser:navigate',
  setBounds: 'right-workspace:browser:set-bounds',
  goBack: 'right-workspace:browser:go-back',
  goForward: 'right-workspace:browser:go-forward',
  reload: 'right-workspace:browser:reload',
  stop: 'right-workspace:browser:stop',
  show: 'right-workspace:browser:show',
  hide: 'right-workspace:browser:hide',
  destroy: 'right-workspace:browser:destroy',
  list: 'right-workspace:browser:list',
  event: 'right-workspace:browser:event'
} as const

export function isBrowserWorkspaceUrl(value: string): boolean {
  if (value === BROWSER_WORKSPACE_BLANK_URL) return true
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export const browserWorkspaceBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(100_000),
    y: z.number().int().min(0).max(100_000),
    width: z.number().int().min(1).max(100_000),
    height: z.number().int().min(0).max(100_000)
  })
  .strict()
export type BrowserWorkspaceBounds = z.infer<typeof browserWorkspaceBoundsSchema>

export const browserWorkspaceViewStateSchema = z.enum(['loading', 'ready', 'failed', 'destroyed'])
export type BrowserWorkspaceViewState = z.infer<typeof browserWorkspaceViewStateSchema>

export const browserWorkspaceCreateRequestSchema = z
  .object({
    version: z.literal(BROWSER_WORKSPACE_API_VERSION),
    workspaceId: workspaceIdSchema,
    url: browserWorkspaceUrlSchema.optional(),
    bounds: browserWorkspaceBoundsSchema
  })
  .strict()
export type BrowserWorkspaceCreateRequest = z.infer<typeof browserWorkspaceCreateRequestSchema>

export const browserWorkspaceNavigateRequestSchema = z
  .object({
    version: z.literal(BROWSER_WORKSPACE_API_VERSION),
    viewId: browserViewIdSchema,
    url: browserWorkspaceUrlSchema
  })
  .strict()
export type BrowserWorkspaceNavigateRequest = z.infer<typeof browserWorkspaceNavigateRequestSchema>

export const browserWorkspaceSetBoundsRequestSchema = z
  .object({
    version: z.literal(BROWSER_WORKSPACE_API_VERSION),
    viewId: browserViewIdSchema,
    bounds: browserWorkspaceBoundsSchema
  })
  .strict()
export type BrowserWorkspaceSetBoundsRequest = z.infer<
  typeof browserWorkspaceSetBoundsRequestSchema
>

export const browserWorkspaceViewRequestSchema = z
  .object({
    version: z.literal(BROWSER_WORKSPACE_API_VERSION),
    viewId: browserViewIdSchema
  })
  .strict()
export type BrowserWorkspaceViewRequest = z.infer<typeof browserWorkspaceViewRequestSchema>

export const browserWorkspaceListRequestSchema = z
  .object({
    version: z.literal(BROWSER_WORKSPACE_API_VERSION),
    workspaceId: workspaceIdSchema.optional()
  })
  .strict()
export type BrowserWorkspaceListRequest = z.infer<typeof browserWorkspaceListRequestSchema>

export const browserWorkspaceViewSnapshotSchema = z
  .object({
    viewId: browserViewIdSchema,
    workspaceId: workspaceIdSchema,
    url: browserWorkspaceUrlSchema,
    title: z.string().max(4096).optional(),
    faviconUrl: httpsUrlSchema.optional(),
    error: z.string().max(4096).optional(),
    state: browserWorkspaceViewStateSchema,
    loading: z.boolean(),
    visible: z.boolean(),
    bounds: browserWorkspaceBoundsSchema,
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict()
export type BrowserWorkspaceViewSnapshot = z.infer<typeof browserWorkspaceViewSnapshotSchema>

export const browserWorkspaceListResultSchema = z
  .object({
    version: z.literal(BROWSER_WORKSPACE_API_VERSION),
    views: z.array(browserWorkspaceViewSnapshotSchema)
  })
  .strict()
export type BrowserWorkspaceListResult = z.infer<typeof browserWorkspaceListResultSchema>

export const browserWorkspaceEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      version: z.literal(BROWSER_WORKSPACE_API_VERSION),
      type: z.literal('created'),
      view: browserWorkspaceViewSnapshotSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(BROWSER_WORKSPACE_API_VERSION),
      type: z.literal('updated'),
      view: browserWorkspaceViewSnapshotSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(BROWSER_WORKSPACE_API_VERSION),
      type: z.literal('destroyed'),
      view: browserWorkspaceViewSnapshotSchema
    })
    .strict()
])
export type BrowserWorkspaceEvent = z.infer<typeof browserWorkspaceEventSchema>
