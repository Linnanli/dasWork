import type {
  CodexProcessSession,
  CodexProcessSessionClient
} from '@dascowork/codex-app-server-client'

import type { TerminalBackend, TerminalExit } from './TerminalBackend'

export type RemoteProcessTerminalBackendOptions = {
  client: CodexProcessSessionClient
  command: string[]
  cwd: string
  cols: number
  rows: number
  env?: Record<string, string | null | undefined>
}

/** Maps provider-owned process/* protocol events to the main terminal backend contract. */
export class RemoteProcessTerminalBackend implements TerminalBackend {
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(event: TerminalExit) => void>()
  private readonly errorListeners = new Set<(error: Error) => void>()
  private readonly connectionLostListeners = new Set<(error: Error) => void>()
  private readonly releaseListeners: Array<() => void>

  private constructor(private readonly session: CodexProcessSession) {
    this.releaseListeners = [
      session.onData((data) => {
        for (const listener of this.dataListeners) listener(data)
      }),
      session.onExit((event) => {
        for (const listener of this.exitListeners) listener({ exitCode: event.exitCode, signal: null })
      }),
      session.onConnectionLost((error) => {
        for (const listener of this.connectionLostListeners) listener(error)
      })
    ]
  }

  static async create(options: RemoteProcessTerminalBackendOptions): Promise<RemoteProcessTerminalBackend> {
    try {
      const session = await options.client.spawn({
        command: options.command,
        cwd: options.cwd,
        cols: options.cols,
        rows: options.rows,
        ...(options.env ? { env: options.env } : {})
      })
      return new RemoteProcessTerminalBackend(session)
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  write(data: string): Promise<void> {
    return this.session.write(data)
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.session.resize(cols, rows)
  }

  async dispose(): Promise<void> {
    for (const release of this.releaseListeners) release()
    await this.session.kill()
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }

  onExit(listener: (event: TerminalExit) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onConnectionLost(listener: (error: Error) => void): () => void {
    this.connectionLostListeners.add(listener)
    return () => this.connectionLostListeners.delete(listener)
  }
}
