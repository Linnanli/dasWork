import {
  mcpAppResourceReadRequestSchema,
  mcpAppResourceReadResultSchema
} from '../shared/mcpAppResource'
import type { DesktopCodexApi } from '../shared/codexIpcApi'

type Invoke = (channel: string, payload: unknown) => Promise<unknown>

export function createMcpAppResourceBridge(
  invoke: Invoke
): Pick<DesktopCodexApi, 'readMcpAppResource'> {
  return {
    readMcpAppResource: (input) =>
      invoke(
        'codex:read-mcp-app-resource',
        mcpAppResourceReadRequestSchema.parse(input, { jitless: true })
      ).then((result) => mcpAppResourceReadResultSchema.parse(result, { jitless: true }))
  }
}
