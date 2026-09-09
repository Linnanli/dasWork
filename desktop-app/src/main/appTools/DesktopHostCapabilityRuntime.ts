import type { ThreadTerminalReader } from '../terminal/readThreadTerminalTool'
import type { CodexToolCallResult } from '@dascowork/codex-app-server-client'
import { isDeepStrictEqual } from 'node:util'
import type { DesktopThreadConfig } from './DesktopThreadConfigSource'
import {
  DynamicAppToolRegistry,
  type DesktopToolContext,
  type DynamicToolCall,
  type NativeDynamicToolSpec
} from './DynamicAppToolRegistry'
import {
  createLoadWorkspaceDependenciesTool,
  createReadThreadTerminalTool,
  type WorkspaceDependencyLoader
} from './desktopToolDefinitions'

export type DesktopCapabilityState = 'ready' | 'degraded' | 'unavailable'

export type DesktopCapabilitySnapshot = {
  revision: string
  hostId: 'local'
  dynamicTools: readonly NativeDynamicToolSpec[]
  availableToolNames: readonly string[]
  threadConfig?: DesktopThreadConfig
  nativeTools: DesktopCapabilityState
  primaryRuntime: 'ready' | 'missing' | 'broken' | 'unsupported'
  codexAppMcp: DesktopCapabilityState
  bundledPlugins: DesktopCapabilityState
  degraded: boolean
}

/** Coordinates per-thread host-tool snapshots without exposing runtime state to renderer code. */
export class DesktopHostCapabilityRuntime {
  readonly registry: DynamicAppToolRegistry
  private revision = 0
  private readonly workspaceDependencies: WorkspaceDependencyLoader | undefined
  private codexAppMcp: DesktopCapabilityState = 'unavailable'
  private codexAppMcpThreadConfig: DesktopThreadConfig | undefined
  private bundledPlugins: DesktopCapabilityState = 'unavailable'

  constructor(options: {
    readThreadTerminal?: ThreadTerminalReader
    workspaceDependencies?: WorkspaceDependencyLoader
  }) {
    this.workspaceDependencies = options.workspaceDependencies
    this.registry = new DynamicAppToolRegistry()
    this.registry.register(createReadThreadTerminalTool(options.readThreadTerminal))
    this.registry.register(createLoadWorkspaceDependenciesTool(options.workspaceDependencies))
  }

  async snapshot(
    context: DesktopToolContext = { hostId: 'local' }
  ): Promise<DesktopCapabilitySnapshot> {
    const runtimeStatus = await this.workspaceDependencies?.diagnoseDependencies?.()
    const snapshotContext = {
      ...context,
      ...(runtimeStatus ? { primaryRuntimeStatus: runtimeStatus.status } : {})
    }
    const dynamicTools = await this.registry.nativeProjection(snapshotContext)
    const availableToolNames = await this.registry.availableToolNames(snapshotContext)
    const primaryRuntime =
      runtimeStatus?.status ??
      (availableToolNames.includes('load_workspace_dependencies') ? 'ready' : 'missing')
    const degraded =
      this.codexAppMcp !== 'ready' ||
      this.bundledPlugins !== 'ready' ||
      primaryRuntime !== 'ready' ||
      dynamicTools.length === 0
    return {
      revision: `desktop-capabilities-${this.revision}`,
      hostId: 'local',
      dynamicTools,
      availableToolNames,
      ...(this.codexAppMcpThreadConfig
        ? { threadConfig: structuredClone(this.codexAppMcpThreadConfig) }
        : {}),
      nativeTools: dynamicTools.length === 0 ? 'unavailable' : degraded ? 'degraded' : 'ready',
      primaryRuntime,
      codexAppMcp: this.codexAppMcp,
      bundledPlugins: this.bundledPlugins,
      degraded
    }
  }

  async dispatch(call: DynamicToolCall, signal?: AbortSignal): Promise<CodexToolCallResult> {
    return this.registry.dispatch(call, signal)
  }

  refresh(): void {
    this.revision += 1
  }

  setCodexAppMcp(input: {
    status: DesktopCapabilityState
    threadConfig?: DesktopThreadConfig
  }): void {
    if (input.status === 'ready' && !input.threadConfig) {
      throw new Error('Ready Codex App MCP capability requires a thread configuration.')
    }
    const threadConfig = input.status === 'ready' ? structuredClone(input.threadConfig) : undefined
    if (
      this.codexAppMcp === input.status &&
      isDeepStrictEqual(this.codexAppMcpThreadConfig, threadConfig)
    ) {
      return
    }
    this.codexAppMcp = input.status
    this.codexAppMcpThreadConfig = threadConfig
    this.refresh()
  }

  setBundledPluginsStatus(status: DesktopCapabilityState): void {
    if (this.bundledPlugins === status) return
    this.bundledPlugins = status
    this.refresh()
  }
}
