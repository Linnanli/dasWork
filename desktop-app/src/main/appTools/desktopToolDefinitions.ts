import type { CodexToolCallResult } from '@dascowork/codex-app-server-client'

import {
  readThreadTerminalToolResult,
  type ThreadTerminalReader
} from '../terminal/readThreadTerminalTool'
import type { DynamicAppToolDefinition } from './DynamicAppToolRegistry'

export type WorkspaceDependencies = object

export type WorkspaceDependencyDiagnostic = {
  status: 'ready' | 'missing' | 'broken' | 'unsupported' | 'installing' | 'checking' | 'failed'
  issues?: readonly {
    code?: string
    message: string
    path?: string
  }[]
  operationId?: string
  activeVersion?: string
  recovery?: string
}

export type WorkspaceDependencyLoader = {
  loadDependencies(): Promise<WorkspaceDependencies>
  diagnoseDependencies?(): Promise<WorkspaceDependencyDiagnostic>
}

const emptyObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {}
} as const

const unavailable = (message: string): CodexToolCallResult => ({
  success: false,
  contentItems: [{ type: 'inputText', text: message }]
})

const success = (result: unknown): CodexToolCallResult => ({
  success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(result) }]
})

const workspaceDependenciesSuccess = (result: WorkspaceDependencies): CodexToolCallResult => ({
  success: true,
  contentItems: [
    {
      type: 'inputText',
      text:
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { text?: unknown }).text === 'string'
          ? (result as { text: string }).text
          : JSON.stringify(result)
    }
  ]
})

export function createReadThreadTerminalTool(
  readThreadTerminal: ThreadTerminalReader | undefined
): DynamicAppToolDefinition {
  return {
    namespace: 'codex_app',
    name: 'read_thread_terminal',
    description: 'Read the sanitized output and state of the current task terminal.',
    inputSchema: emptyObjectSchema,
    exposure: { native: true, pipe: true },
    async availability(context) {
      if (context.hostId !== 'local')
        return { state: 'unavailable', reason: 'This desktop tool only supports the local host.' }
      return readThreadTerminal
        ? { state: 'available' }
        : { state: 'unavailable', reason: 'This desktop tool is unavailable.' }
    },
    async execute(context, argumentsValue) {
      if (!readThreadTerminal) return unavailable('This desktop tool is unavailable.')
      if (!isEmptyObject(argumentsValue))
        return unavailable('read_thread_terminal does not accept parameters.')
      if (context.signal.aborted) return unavailable('Dynamic tool call was cancelled.')
      return success(await readThreadTerminalToolResult(readThreadTerminal, context.threadId))
    }
  }
}

export function createLoadWorkspaceDependenciesTool(
  runtime: WorkspaceDependencyLoader | undefined
): DynamicAppToolDefinition {
  return {
    namespace: 'codex_app',
    name: 'load_workspace_dependencies',
    description: 'Load the verified local workspace runtime paths and bundled libraries.',
    inputSchema: emptyObjectSchema,
    exposure: { native: true, pipe: true },
    async availability(context) {
      if (context.hostId !== 'local')
        return {
          state: 'unavailable',
          reason: 'Workspace dependencies are only available on the local host.'
        }
      if (!runtime)
        return { state: 'unavailable', reason: 'Workspace dependencies are unavailable.' }
      if (context.workspaceDependenciesEnabled === false) {
        return {
          state: 'unavailable',
          reason: 'Workspace dependencies are not enabled for this host.'
        }
      }
      const runtimeStatus =
        context.primaryRuntimeStatus ?? (await runtime.diagnoseDependencies?.())?.status
      if (runtimeStatus !== 'ready') {
        return {
          state: 'unavailable',
          reason: 'Workspace dependencies are unavailable until the Primary Runtime is ready.'
        }
      }
      return { state: 'available' }
    },
    async execute(context, argumentsValue) {
      if (!runtime) return unavailable('Workspace dependencies are unavailable.')
      if (!isEmptyObject(argumentsValue))
        return unavailable('load_workspace_dependencies does not accept parameters.')
      if (context.hostId !== 'local')
        return unavailable('Workspace dependencies are only available on the local host.')
      if (context.signal.aborted) return unavailable('Dynamic tool call was cancelled.')
      try {
        const dependencies = await runtime.loadDependencies()
        if (context.signal.aborted) return unavailable('Dynamic tool call was cancelled.')
        return workspaceDependenciesSuccess(dependencies)
      } catch {
        return unavailable(await unavailableRuntimeResult(runtime))
      }
    }
  }
}

async function unavailableRuntimeResult(runtime: WorkspaceDependencyLoader): Promise<string> {
  let diagnostic: WorkspaceDependencyDiagnostic | undefined
  try {
    diagnostic = await runtime.diagnoseDependencies?.()
  } catch {
    // Preserve the least-privilege failure result if diagnostics itself is
    // unavailable. Never surface a Runtime path or a raw error stack here.
  }

  const status = diagnostic?.status ?? 'failed'
  return JSON.stringify({
    status,
    ...(diagnostic?.operationId ? { operationId: diagnostic.operationId } : {}),
    ...(diagnostic?.activeVersion ? { activeVersion: diagnostic.activeVersion } : {}),
    issues: (diagnostic?.issues ?? []).map((issue) => ({
      ...(issue.code ? { code: issue.code } : {}),
      message: issue.message
    })),
    recovery:
      diagnostic?.recovery ??
      (status === 'unsupported'
        ? 'This host does not support the Primary Runtime.'
        : 'Install or repair the Primary Runtime from Plugins & Skills, then create a new task.')
  })
}

function isEmptyObject(value: unknown): boolean {
  return (
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  )
}
