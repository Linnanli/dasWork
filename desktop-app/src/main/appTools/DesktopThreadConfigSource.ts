import { join } from 'node:path'

export type DesktopThreadConfig = Record<string, unknown>

/**
 * Builds the one main-process-owned MCP configuration used to project desktop
 * tools into the bundled Codex App Tools server. It is deliberately separate
 * from model-provider configuration so a model selection cannot replace host
 * capabilities.
 */
export class DesktopThreadConfigSource {
  constructor(
    private readonly input: {
      pipePath: string
      pluginRoot: string
      platform?: NodeJS.Platform
    }
  ) {}

  snapshot(): DesktopThreadConfig {
    const platform = this.input.platform ?? process.platform
    const launcher = join(
      this.input.pluginRoot,
      'scripts',
      platform === 'win32' ? 'launch_codex_app_tools_mcp.cmd' : 'launch_codex_app_tools_mcp'
    )

    return {
      mcp_servers: {
        codex_app: {
          command: launcher,
          args: [join(this.input.pluginRoot, 'server.mjs')],
          cwd: this.input.pluginRoot,
          enabled: true,
          env: {
            CODEX_APP_TOOLS_PIPE_PATH: this.input.pipePath,
            CODEX_MCP_NODE_PATH: process.execPath,
            ELECTRON_RUN_AS_NODE: '1'
          },
          startup_timeout_sec: 10,
          tool_timeout_sec: 3600
        }
      }
    }
  }
}

/**
 * Extends the selected model's app-server config without overwriting any of
 * its values. A collision at an owned path is a configuration error, not a
 * precedence rule that could silently disable the desktop capability bridge.
 */
export function mergeDesktopThreadConfig(
  existing: Record<string, unknown> | undefined,
  desktop: DesktopThreadConfig | undefined
): Record<string, unknown> | undefined {
  if (!desktop) return existing
  if (!existing) return structuredClone(desktop)

  const existingMcpServers = recordValue(existing.mcp_servers)
  const desktopMcpServers = recordValue(desktop.mcp_servers)
  if (!desktopMcpServers) return deepMerge(existing, desktop)
  if (
    existingMcpServers &&
    Object.keys(desktopMcpServers).some((serverName) => serverName in existingMcpServers)
  ) {
    throw new Error('Desktop MCP server configuration conflicts with the selected model config.')
  }

  return deepMerge(existing, desktop)
}

function deepMerge(
  existing: Record<string, unknown>,
  desktop: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(existing)
  for (const [key, desktopValue] of Object.entries(desktop)) {
    const existingValue = result[key]
    const existingRecord = recordValue(existingValue)
    const desktopRecord = recordValue(desktopValue)
    if (existingRecord && desktopRecord) {
      result[key] = deepMerge(existingRecord, desktopRecord)
      continue
    }
    if (existingValue !== undefined) {
      throw new Error(`Desktop thread configuration conflicts at ${key}.`)
    }
    result[key] = structuredClone(desktopValue)
  }
  return result
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
