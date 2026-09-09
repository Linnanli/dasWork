import {
  DynamicToolsDispatcher,
  type CodexToolCallResult,
  type DynamicToolExecutionContext,
  type DynamicToolCallParams,
  type DynamicToolSpec
} from '@dascowork/codex-app-server-client'

export type DesktopToolHostId = 'local' | 'remote'

export type DesktopToolContext = {
  hostId: DesktopToolHostId
  threadId?: string
  turnId?: string
  callId?: string
  primaryRuntimeStatus?: 'ready' | 'missing' | 'broken' | 'unsupported'
}

export type ToolAvailability = { state: 'available' } | { state: 'unavailable'; reason: string }

export type DynamicAppToolDefinition = {
  namespace: 'codex_app'
  name: string
  description: string
  inputSchema: Record<string, unknown>
  deferLoading?: boolean
  exposure: { native: boolean; pipe: boolean }
  availability(context: DesktopToolContext): Promise<ToolAvailability>
  execute(
    context: DesktopToolContext & { signal: AbortSignal },
    argumentsValue: unknown
  ): Promise<CodexToolCallResult>
}

export type DynamicToolFunctionSpec = Extract<DynamicToolSpec, { type: 'function' }>
export type DynamicToolNamespaceSpec = Extract<DynamicToolSpec, { type: 'namespace' }>
export type NativeDynamicToolSpec = DynamicToolSpec
/** The bundled MCP bridge requires a namespace on every flattened tool. */
export type PipeDynamicToolSpec = DynamicToolFunctionSpec & { namespace: 'codex_app' }

export type DynamicToolCall = Omit<Partial<DynamicToolCallParams>, 'arguments'> & {
  arguments?: unknown
  toolName?: string
  input?: unknown
}

const noToolResult = (message: string): CodexToolCallResult => ({
  success: false,
  contentItems: [{ type: 'inputText', text: message }]
})

/**
 * Main-process source of truth for desktop-hosted tools.  It owns descriptions
 * and availability; protocol dispatch remains in the AI-free client package.
 */
export class DynamicAppToolRegistry {
  private readonly definitions = new Map<string, DynamicAppToolDefinition>()
  private readonly dispatcher: DynamicToolsDispatcher

  constructor(
    private readonly options: {
      timeoutMs?: number
      getAbortSignal?(call: DynamicToolCall): AbortSignal | undefined
    } = {}
  ) {
    this.dispatcher = new DynamicToolsDispatcher({ timeoutMs: options.timeoutMs })
  }

  register(definition: DynamicAppToolDefinition): void {
    const key = toolKey(definition.namespace, definition.name)
    if (this.definitions.has(key)) {
      throw new Error(`Dynamic app tool is already registered: ${key}`)
    }

    this.definitions.set(key, definition)
    this.dispatcher.register(
      definition.name,
      async (argumentsValue, context) =>
        this.executeRegisteredDefinition(definition, argumentsValue, context),
      { namespace: definition.namespace }
    )
  }

  async nativeProjection(context: DesktopToolContext): Promise<readonly NativeDynamicToolSpec[]> {
    const available = await this.availableDefinitions(context, 'native')
    if (available.length === 0) return []

    return [
      {
        type: 'namespace',
        name: 'codex_app',
        description: 'Desktop-hosted tools available in the local Codex application.',
        tools: available.map(toFunctionSpec)
      }
    ]
  }

  async pipeProjection(context: DesktopToolContext): Promise<readonly PipeDynamicToolSpec[]> {
    const available = await this.availableDefinitions(context, 'pipe')
    return available.map((definition) => ({
      ...toFunctionSpec(definition),
      namespace: definition.namespace
    }))
  }

  async availableToolNames(context: DesktopToolContext): Promise<readonly string[]> {
    const definitions = await this.availableDefinitions(context, 'native')
    return definitions.map((definition) => definition.name)
  }

  async dispatch(call: DynamicToolCall, signal?: AbortSignal): Promise<CodexToolCallResult> {
    const tool = call.tool ?? call.toolName
    if (!tool) return noToolResult('Dynamic tool call is missing the tool name.')
    if (call.namespace && call.namespace !== 'codex_app') {
      return noToolResult(`Dynamic tool namespace is unavailable: ${call.namespace}.`)
    }

    const definition = this.definitions.get(toolKey('codex_app', tool))
    if (!definition) return noToolResult(`This desktop tool is unavailable: ${tool}.`)

    const availability = await availabilityOf(definition, toDesktopContext(call))
    if (availability.state !== 'available') return noToolResult(availability.reason)

    const dispatchSignal = signal ?? this.options.getAbortSignal?.(call)
    if (dispatchSignal?.aborted) return noToolResult('Dynamic tool call was cancelled.')

    const hasArguments = Object.prototype.hasOwnProperty.call(call, 'arguments')
    const argumentsValue = hasArguments ? call.arguments : call.input
    if (!isObjectArguments(argumentsValue)) {
      return noToolResult('Tool arguments must be an object.')
    }

    return this.dispatcher.dispatch(
      {
        tool,
        toolName: tool,
        arguments: argumentsValue,
        input: call.input,
        threadId: call.threadId,
        turnId: call.turnId,
        callId: call.callId,
        namespace: 'codex_app'
      } as never,
      { signal: dispatchSignal }
    )
  }

  private async availableDefinitions(
    context: DesktopToolContext,
    exposure: keyof DynamicAppToolDefinition['exposure']
  ): Promise<DynamicAppToolDefinition[]> {
    const entries = [...this.definitions.values()].filter(
      (definition) => definition.exposure[exposure]
    )
    const availability = await Promise.all(
      entries.map(async (definition) => ({
        definition,
        status: await availabilityOf(definition, context)
      }))
    )
    return availability
      .filter((entry) => entry.status.state === 'available')
      .map((entry) => entry.definition)
  }

  private async executeRegisteredDefinition(
    definition: DynamicAppToolDefinition,
    argumentsValue: unknown,
    context: DynamicToolExecutionContext
  ): Promise<CodexToolCallResult> {
    const call: DynamicToolCall = {
      namespace: context.namespace,
      tool: context.toolName,
      threadId: context.threadId,
      turnId: context.turnId,
      callId: context.callId
    }
    const signal =
      context.signal ?? this.options.getAbortSignal?.(call) ?? new AbortController().signal
    if (signal.aborted) return noToolResult('Dynamic tool call was cancelled.')
    return definition.execute({ ...toDesktopContext(call), signal }, argumentsValue)
  }
}

async function availabilityOf(
  definition: DynamicAppToolDefinition,
  context: DesktopToolContext
): Promise<ToolAvailability> {
  try {
    return await definition.availability(context)
  } catch {
    return { state: 'unavailable', reason: 'This desktop tool is unavailable.' }
  }
}

function toFunctionSpec(definition: DynamicAppToolDefinition): DynamicToolFunctionSpec {
  return {
    type: 'function',
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.deferLoading === true ? { deferLoading: true } : {})
  } as DynamicToolFunctionSpec
}

function toolKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`
}

function isObjectArguments(value: unknown): boolean {
  return (
    value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
  )
}

function toDesktopContext(call: DynamicToolCall): DesktopToolContext {
  return {
    hostId: 'local',
    ...(call.threadId ? { threadId: call.threadId } : {}),
    ...(call.turnId ? { turnId: call.turnId } : {}),
    ...(call.callId ? { callId: call.callId } : {})
  }
}
