import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DynamicAppToolRegistry, type DynamicAppToolDefinition } from './DynamicAppToolRegistry'
import { DesktopThreadConfigSource } from './DesktopThreadConfigSource'
import { CodexAppToolsNativePipeServer } from './nativePipeServer'

const servers: CodexAppToolsNativePipeServer[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of children.splice(0)) await stop(child)
  await Promise.all(servers.splice(0).map((server) => server.shutdown()))
})

describe('bundled Codex App Tools compatibility', () => {
  it('uses the packaged launcher and MCP stdio server to call the main-owned Pipe', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(echoTool)
    const pipe = new CodexAppToolsNativePipeServer({ registry })
    servers.push(pipe)
    const { pipePath } = await pipe.start()

    const pluginRoot = join(
      process.cwd(),
      'resources',
      'bundled-plugins',
      'openai-bundled',
      'plugins',
      'codex-app-tools'
    )
    const config = new DesktopThreadConfigSource({ pipePath, pluginRoot }).snapshot()
    const server = mcpServerConfig(config)
    expect(server.env).toMatchObject({
      CODEX_MCP_NODE_PATH: process.execPath,
      ELECTRON_RUN_AS_NODE: '1'
    })
    await access(server.command)
    const child = spawn(server.command, server.args, {
      cwd: server.cwd,
      env: {
        ...process.env,
        ...server.env
      },
      shell: process.platform === 'win32'
    })
    children.push(child)
    const client = new McpStdioClient(child)

    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dascowork-test', version: '1.0.0' }
    })
    client.notify('notifications/initialized')

    await expect(client.request('tools/list', {})).resolves.toEqual({
      tools: [
        {
          name: 'echo',
          description: 'Echo the input through the desktop host.',
          inputSchema: { type: 'object' }
        }
      ]
    })
    await expect(
      client.request('tools/call', {
        name: 'echo',
        arguments: { value: 'from the bundled server' },
        _meta: {
          'openai/threadId': 'thread-1',
          'openai/turnId': 'turn-1',
          'openai/toolCallId': 'call-1'
        }
      })
    ).resolves.toEqual({
      content: [{ type: 'text', text: '{"value":"from the bundled server"}' }],
      isError: false
    })
  })

  it('does not fall back to PATH node when the controlled runtime env is missing', async () => {
    const pluginRoot = join(
      process.cwd(),
      'resources',
      'bundled-plugins',
      'openai-bundled',
      'plugins',
      'codex-app-tools'
    )
    const launcher = join(
      pluginRoot,
      'scripts',
      process.platform === 'win32' ? 'launch_codex_app_tools_mcp.cmd' : 'launch_codex_app_tools_mcp'
    )
    const child = spawn(launcher, [join(pluginRoot, 'server.mjs')], {
      cwd: pluginRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: '/nonexistent/dascowork-codex-app-tools',
        USERPROFILE: 'C:\\nonexistent\\dascowork-codex-app-tools',
        LOCALAPPDATA: 'C:\\nonexistent\\dascowork-codex-app-tools',
        XDG_CACHE_HOME: '/nonexistent/dascowork-codex-app-tools'
      },
      shell: process.platform === 'win32'
    })
    children.push(child)

    await expect(waitForExit(child)).resolves.toEqual({ code: 127, signal: null })
  })

  it('forwards MCP cancellation to the active main-owned tool call', async () => {
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const registry = new DynamicAppToolRegistry()
    registry.register({
      ...echoTool,
      name: 'block_until_cancelled',
      async execute(context) {
        markStarted?.()
        return new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), {
            once: true
          })
        })
      }
    })
    const pipe = new CodexAppToolsNativePipeServer({ registry })
    servers.push(pipe)
    const { pipePath } = await pipe.start()
    const client = await startBundledMcpClient(pipePath)

    const pendingCall = client.request('tools/call', {
      name: 'block_until_cancelled',
      arguments: {},
      _meta: {
        'openai/threadId': 'thread-cancel',
        'openai/turnId': 'turn-cancel',
        'openai/toolCallId': 'call-cancel'
      }
    })
    await started
    client.notify('notifications/cancelled', { requestId: 2 })

    await expect(pendingCall).resolves.toEqual({
      content: [{ type: 'text', text: 'Native pipe tool call was cancelled.' }],
      isError: true
    })
  })
})

const echoTool: DynamicAppToolDefinition = {
  namespace: 'codex_app',
  name: 'echo',
  description: 'Echo the input through the desktop host.',
  inputSchema: { type: 'object' },
  exposure: { native: true, pipe: true },
  async availability() {
    return { state: 'available' }
  },
  async execute(_context, argumentsValue) {
    return {
      success: true,
      contentItems: [{ type: 'inputText', text: JSON.stringify(argumentsValue) }]
    }
  }
}

async function startBundledMcpClient(pipePath: string): Promise<McpStdioClient> {
  const pluginRoot = join(
    process.cwd(),
    'resources',
    'bundled-plugins',
    'openai-bundled',
    'plugins',
    'codex-app-tools'
  )
  const config = new DesktopThreadConfigSource({ pipePath, pluginRoot }).snapshot()
  const server = mcpServerConfig(config)
  const child = spawn(server.command, server.args, {
    cwd: server.cwd,
    env: {
      ...process.env,
      ...server.env
    },
    shell: process.platform === 'win32'
  })
  children.push(child)
  const client = new McpStdioClient(child)
  await client.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'dascowork-test', version: '1.0.0' }
  })
  client.notify('notifications/initialized')
  return client
}

class McpStdioClient {
  private nextId = 0
  private readonly pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >()
  private output = ''
  private errorOutput = ''

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.errorOutput += chunk
    })
    child.once('error', (error) => this.rejectPending(error))
    child.once('exit', (code, signal) => {
      this.rejectPending(
        new Error(
          `Bundled Codex App Tools server exited (${code ?? 'null'}/${signal ?? 'none'}): ${this.errorOutput}`
        )
      )
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId
    const request = { jsonrpc: '2.0', id, method, params }
    const response = new Promise<unknown>((resolve, reject) =>
      this.pending.set(id, { resolve, reject })
    )
    this.child.stdin.write(`${JSON.stringify(request)}\n`)
    return timeout(response, `${method} response`)
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`
    )
  }

  private consume(chunk: string): void {
    this.output += chunk
    while (true) {
      const newline = this.output.indexOf('\n')
      if (newline === -1) return
      const line = this.output.slice(0, newline).trim()
      this.output = this.output.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as {
        id?: unknown
        result?: unknown
        error?: { message?: unknown }
      }
      if (typeof message.id !== 'number') continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(
          new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP error')
        )
      } else {
        pending.resolve(message.result)
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

function waitForExit(
  child: ChildProcessWithoutNullStreams
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function mcpServerConfig(config: Record<string, unknown>): {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
} {
  const mcpServers = config.mcp_servers as Record<string, unknown>
  expect(Object.keys(mcpServers)).toEqual(['codex_app'])
  return mcpServers.codex_app as {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
  }
}

function timeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 10_000)
    )
  ])
}
