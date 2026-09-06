import { CodexAppServerConnection, StdioTransport } from '@dascowork/codex-app-server-client'

import type { CodexAppServerLaunchOptions } from '../codexAppServerLaunch'

export type CodexNativeSharedConnection = {
  connection: CodexAppServerConnection
  transportFactory(
    context: Parameters<CodexAppServerConnection['createTransport']>[0]
  ): ReturnType<CodexAppServerConnection['createTransport']>
  shutdown(): Promise<void>
  getDiagnostics(): ReturnType<CodexAppServerConnection['getDiagnostics']>
}

/**
 * One host-scoped physical app-server connection. Feature clients receive
 * logical transports only; no renderer-facing code can create a transport.
 */
export function createCodexNativeSharedConnection(
  launch: CodexAppServerLaunchOptions
): CodexNativeSharedConnection {
  const connection = new CodexAppServerConnection({
    transportFactory: () =>
      new StdioTransport({
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        env: sanitizedCodexHostEnv(launch.env)
      }),
    idleTimeoutMs: 300_000
  })

  return {
    connection,
    transportFactory: (context: Parameters<typeof connection.createTransport>[0]) =>
      connection.createTransport(context),
    shutdown: () => connection.shutdown(),
    getDiagnostics: () => connection.getDiagnostics()
  }
}

function sanitizedCodexHostEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const result = Object.fromEntries(
    Object.entries(env ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        entry[0] !== 'CODEX_CI' &&
        entry[0] !== 'CODEX_THREAD_ID' &&
        entry[0] !== 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'
    )
  )
  const appendLocalhost = (value: string | undefined): string => {
    const hosts = new Set(
      (value ?? '')
        .split(',')
        .map((host) => host.trim())
        .filter(Boolean)
    )
    for (const host of ['localhost', '127.0.0.1', '::1']) hosts.add(host)
    return [...hosts].join(',')
  }
  return {
    ...result,
    NO_PROXY: appendLocalhost(result.NO_PROXY ?? result.no_proxy),
    no_proxy: appendLocalhost(result.no_proxy ?? result.NO_PROXY)
  }
}
