import type { McpAppResourceReadResult } from '../../../../shared/mcpAppResource'

type JsonRpcId = string | number

export type McpAppHostRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

type McpAppHostResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

const unsupportedMethodMessage = '此 MCP App 宿主尚未提供该交互能力。'

export function parseMcpAppHostRequest(value: unknown): McpAppHostRequest | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') return undefined
  if (typeof record.id !== 'string' && typeof record.id !== 'number') return undefined
  return {
    jsonrpc: '2.0',
    id: record.id,
    method: record.method,
    ...(Object.hasOwn(record, 'params') ? { params: record.params } : {})
  }
}

export async function mcpAppHostResponse(
  request: McpAppHostRequest,
  dependencies: { readResource(assetUri: string): Promise<McpAppResourceReadResult> }
): Promise<McpAppHostResponse | null> {
  if (request.method === 'ui/notifications/initialized' || request.method.startsWith('notifications/')) {
    return null
  }
  if (request.method === 'ui/initialize') {
    return response(request.id, {
      protocolVersion: protocolVersion(request.params),
      hostInfo: { name: 'dasCowork', version: '1.0.0' },
      hostCapabilities: { serverResources: {} },
      hostContext: {
        platform: 'desktop',
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      }
    })
  }
  if (request.method === 'ping') return response(request.id, {})
  if (request.method === 'resources/read') {
    const uri = resourceUriFromParams(request.params)
    if (!uri) return errorResponse(request.id, -32_602, '只允许读取 ui:// MCP App 资源。')
    try {
      return response(request.id, await dependencies.readResource(uri))
    } catch (error) {
      return errorResponse(request.id, -32_000, errorMessage(error))
    }
  }
  return errorResponse(request.id, -32_601, unsupportedMethodMessage)
}

export function mcpAppSrcDoc(html: string): string {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "media-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'"
  ].join('; ')
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`
}

export function errorMessage(value: unknown): string {
  return value instanceof Error && value.message ? value.message : 'MCP App 请求失败。'
}

function protocolVersion(params: unknown): string {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined
  return typeof record?.protocolVersion === 'string' ? record.protocolVersion : '2026-01-26'
}

function resourceUriFromParams(params: unknown): string | undefined {
  const record = params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined
  return typeof record?.uri === 'string' && record.uri.startsWith('ui://') ? record.uri : undefined
}

function response(id: JsonRpcId, result: unknown): McpAppHostResponse {
  return { jsonrpc: '2.0', id, result }
}

function errorResponse(id: JsonRpcId, code: number, message: string): McpAppHostResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
