import type {
  CodexMcpResourceReadParams,
  CodexTurnListParams
} from '@janole/ai-sdk-provider-codex-asp'

import {
  isMcpAppHtmlContent,
  MCP_APP_RESOURCE_VERSION,
  mcpAppResourceReadResultSchema,
  type McpAppResourceContent,
  type McpAppResourceReadRequest,
  type McpAppResourceReadResult
} from '../../shared/mcpAppResource'

type McpAppResourceProvider = {
  listTurns(threadId: string, input?: CodexTurnListParams): Promise<unknown>
  readMcpResource(input: CodexMcpResourceReadParams): Promise<unknown>
}

const MAX_TURN_PAGES = 20

/**
 * Reads an MCP App only after proving that its primary UI resource came from
 * the same app-server task transcript. Renderer input never chooses a new
 * server/resource pair, and nested reads stay within the standard `ui://`
 * resource namespace.
 */
export class McpAppResourceService {
  constructor(private readonly dependencies: { provider: McpAppResourceProvider }) {}

  async read(input: McpAppResourceReadRequest): Promise<McpAppResourceReadResult> {
    await this.assertResourceWasObserved(input)
    const response = await this.dependencies.provider.readMcpResource({
      threadId: input.threadId,
      server: input.server,
      uri: input.assetUri ?? input.resourceUri
    })
    const contents = textContents(response)
    if (contents.length === 0) {
      throw new Error('MCP App resource did not return readable text content')
    }
    if (!input.assetUri && !contents.some(isMcpAppHtmlContent)) {
      throw new Error('MCP App resource did not return an HTML App document')
    }

    return mcpAppResourceReadResultSchema.parse({
      version: MCP_APP_RESOURCE_VERSION,
      contents
    })
  }

  private async assertResourceWasObserved(input: McpAppResourceReadRequest): Promise<void> {
    let cursor: string | undefined
    const seenCursors = new Set<string>()

    for (let pageNumber = 0; pageNumber < MAX_TURN_PAGES; pageNumber += 1) {
      const page = await this.dependencies.provider.listTurns(input.threadId, {
        ...(cursor ? { cursor } : {}),
        limit: 100,
        sortDirection: 'desc',
        itemsView: 'full'
      })
      if (containsMcpAppResource(page, input.server, input.resourceUri)) return

      const nextCursor = nextPageCursor(page)
      if (!nextCursor || seenCursors.has(nextCursor)) break
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    throw new Error('MCP App resource is not authorized by this task transcript')
  }
}

function textContents(value: unknown): McpAppResourceContent[] {
  const record = asRecord(value)
  const contents = Array.isArray(record?.contents) ? record.contents : []
  return contents.flatMap((content) => {
    const candidate = asRecord(content)
    const uri = stringValue(candidate?.uri)
    const text = stringValue(candidate?.text)
    if (!uri || text === undefined) return []
    const mimeType = stringValue(candidate?.mimeType)
    return [{ uri, text, ...(mimeType ? { mimeType } : {}) }]
  })
}

function containsMcpAppResource(value: unknown, server: string, resourceUri: string): boolean {
  const pending: unknown[] = [value]
  let inspected = 0
  while (pending.length > 0 && inspected < 10_000) {
    inspected += 1
    const current = pending.pop()
    if (Array.isArray(current)) {
      pending.push(...current)
      continue
    }
    const record = asRecord(current)
    if (!record) continue
    const appContext = asRecord(record.appContext)
    const observedResourceUri =
      stringValue(appContext?.resourceUri) ?? stringValue(record.mcpAppResourceUri)
    if (record.server === server && observedResourceUri === resourceUri) return true
    pending.push(...Object.values(record))
  }
  return false
}

function nextPageCursor(value: unknown): string | undefined {
  return stringValue(asRecord(value)?.nextCursor)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
