import {
  mcpAppResourceReadRequestSchema,
  mcpAppResourceReadResultSchema,
  type McpAppResourceReadResult
} from '../../shared/mcpAppResource'
import type { McpAppResourceService } from './McpAppResourceService'

type McpAppResourceServiceLike = Pick<McpAppResourceService, 'read'>

export function createReadMcpAppResourceHandler(
  service: McpAppResourceServiceLike
): (_event: unknown, payload: unknown) => Promise<McpAppResourceReadResult> {
  return async (_event, payload) => {
    const request = mcpAppResourceReadRequestSchema.parse(payload)
    return mcpAppResourceReadResultSchema.parse(await service.read(request))
  }
}
