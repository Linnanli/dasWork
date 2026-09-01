import {
  MCP_SERVER_STATUS_VERSION,
  mcpServerListResultSchema,
  mcpServerSummarySchema,
  type McpServerListRequest,
  type McpServerListResult
} from '../../shared/mcpServerStatus'

type ProviderListRequest = {
  threadId?: string
  detail: 'toolsAndAuthOnly'
  pageSize: number
}

export type McpServerStatusProvider = {
  listMcpServerStatus(input: ProviderListRequest): Promise<unknown>
}

export class McpServerStatusService {
  constructor(
    private readonly dependencies: {
      provider: Partial<McpServerStatusProvider>
      now?: () => Date
    }
  ) {}

  async list(input: McpServerListRequest): Promise<McpServerListResult> {
    const providerList = this.dependencies.provider.listMcpServerStatus
    if (!providerList) throw new Error('MCP server status provider is not available')

    const servers = mcpServerSummarySchema.array().parse(
      await providerList.call(this.dependencies.provider, {
        ...(input.threadId ? { threadId: input.threadId } : {}),
        detail: 'toolsAndAuthOnly',
        pageSize: 100
      })
    )

    return mcpServerListResultSchema.parse({
      version: MCP_SERVER_STATUS_VERSION,
      generatedAt: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      servers
    })
  }
}
