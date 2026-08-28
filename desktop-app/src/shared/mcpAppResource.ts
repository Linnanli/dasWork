import { z } from 'zod'

export const MCP_APP_RESOURCE_VERSION = 1 as const

const mcpAppUriSchema = z.string().startsWith('ui://').max(2_048)

export const mcpAppResourceReadRequestSchema = z
  .object({
    version: z.literal(MCP_APP_RESOURCE_VERSION),
    threadId: z.string().min(1).max(200),
    server: z.string().min(1).max(200),
    /** A UI resource observed in this task's trusted app-server transcript. */
    resourceUri: mcpAppUriSchema,
    /** An optional UI-only asset requested by the already-authorized App. */
    assetUri: mcpAppUriSchema.optional()
  })
  .strict()

export type McpAppResourceReadRequest = z.infer<typeof mcpAppResourceReadRequestSchema>

export const mcpAppResourceContentSchema = z
  .object({
    uri: z.string().min(1).max(2_048),
    mimeType: z.string().min(1).max(256).optional(),
    text: z.string().max(2_000_000)
  })
  .strict()

export type McpAppResourceContent = z.infer<typeof mcpAppResourceContentSchema>

export const mcpAppResourceReadResultSchema = z
  .object({
    version: z.literal(MCP_APP_RESOURCE_VERSION),
    contents: z.array(mcpAppResourceContentSchema).min(1).max(64)
  })
  .strict()

export type McpAppResourceReadResult = z.infer<typeof mcpAppResourceReadResultSchema>

export function isMcpAppHtmlContent(content: McpAppResourceContent): boolean {
  const mimeType = content.mimeType?.toLowerCase() ?? ''
  return (
    mimeType.startsWith('text/html;profile=mcp-app') || mimeType.startsWith('text/html+skybridge')
  )
}
