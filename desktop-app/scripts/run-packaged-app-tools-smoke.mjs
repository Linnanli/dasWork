#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executable smoke scripts use runtime assertions instead of TypeScript annotations. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.env.DASCOWORK_PACKAGED_APP_TOOLS_SMOKE !== '1') {
  throw new Error('Set DASCOWORK_PACKAGED_APP_TOOLS_SMOKE=1 to run the packaged app-tools gate.')
}

const tempRoot = await mkdtemp(join(tmpdir(), 'dascowork-app-tools-smoke-'))

async function main() {
  const configuredResourcesPath = process.env.DASCOWORK_PACKAGED_RESOURCES_PATH?.trim()
  const configuredExecutable = process.env.DASCOWORK_PACKAGED_EXECUTABLE?.trim()
  assert(
    configuredResourcesPath && configuredExecutable,
    'Packaged smoke requires DASCOWORK_PACKAGED_RESOURCES_PATH and DASCOWORK_PACKAGED_EXECUTABLE.'
  )
  const resourcesPath = await realpath(resolve(configuredResourcesPath))
  const packagedExecutable = await realpath(resolve(configuredExecutable))
  const marketplaceRoot = join(resourcesPath, 'plugins', 'openai-bundled')
  const marketplacePath = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')
  const pluginRoot = join(marketplaceRoot, 'plugins', 'codex-app-tools')
  const launcher = join(
    pluginRoot,
    'scripts',
    process.platform === 'win32' ? 'launch_codex_app_tools_mcp.cmd' : 'launch_codex_app_tools_mcp'
  )
  const serverPath = join(pluginRoot, 'server.mjs')
  await assertFile(marketplacePath, 'openai-bundled marketplace manifest')
  await assertFile(launcher, 'codex-app-tools launcher')
  await assertFile(serverPath, 'codex-app-tools MCP server')
  await assertFile(packagedExecutable, 'packaged Electron executable')

  await assertLauncherNeedsExplicitRuntime(launcher, serverPath, pluginRoot)

  const pipePath =
    process.platform === 'win32'
      ? join('\\\\.\\pipe', `dc-app-tools-${process.pid}`)
      : join(tempRoot, 'c.sock')
  const pipe = await startPipeServer(pipePath)
  const child = spawn(launcher, [serverPath], {
    cwd: pluginRoot,
    env: {
      CODEX_APP_TOOLS_PIPE_PATH: pipePath,
      CODEX_MCP_NODE_PATH: packagedExecutable,
      ELECTRON_RUN_AS_NODE: '1',
      PATH: ''
    },
    shell: process.platform === 'win32'
  })

  try {
    const client = new McpClient(child)
    await client.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'dascowork-packaged-app-tools-smoke', version: '1.0.0' }
    })
    client.notify('notifications/initialized')
    const listed = await client.request('tools/list', {})
    assert(
      Array.isArray(listed?.tools) && listed.tools.some((tool) => tool.name === 'echo'),
      'MCP tools/list did not expose the Pipe-backed echo tool.'
    )
    const called = await client.request('tools/call', {
      name: 'echo',
      arguments: { value: 'packaged-smoke' },
      _meta: {
        'openai/threadId': 'thread-smoke',
        'openai/turnId': 'turn-smoke',
        'openai/toolCallId': 'call-smoke'
      }
    })
    assert(
      called?.isError === false &&
        called.content?.[0]?.type === 'text' &&
        called.content[0].text === '{"value":"packaged-smoke"}',
      'MCP tools/call did not return the expected Pipe-backed result.'
    )
    console.log('Packaged app-tools smoke passed.')
  } finally {
    child.kill('SIGTERM')
    await waitForExit(child)
    await pipe.close()
    if (process.platform !== 'win32') {
      await expectMissing(pipePath, 'Unix socket was left behind after shutdown.')
    }
  }
}

async function assertLauncherNeedsExplicitRuntime(launcher, serverPath, pluginRoot) {
  const child = spawn(launcher, [serverPath], {
    cwd: pluginRoot,
    env: { PATH: '' },
    shell: process.platform === 'win32'
  })
  const { code, stderr } = await collectExit(child)
  assert(
    code === 127 && stderr.includes('could not find a Node runtime'),
    `Launcher used an undeclared Node fallback (${code}): ${stderr}`
  )
}

async function assertFile(path, label) {
  const stats = await stat(path)
  assert(stats.isFile(), `${label} is not a file: ${path}`)
}

async function startPipeServer(pipePath) {
  const sessions = new Set()
  const server = createServer((socket) => {
    sessions.add(socket)
    socket.on('close', () => sessions.delete(socket))
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0)
        if (buffered.length < length + 4) return
        const frame = buffered.subarray(4, length + 4)
        buffered = buffered.subarray(length + 4)
        const request = JSON.parse(frame.toString('utf8'))
        socket.write(encodePipeResponse(responseFor(request)))
      }
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.once('listening', resolveListen)
    server.listen(pipePath)
  })
  return {
    close: () =>
      new Promise((resolveClose) => {
        for (const socket of sessions) socket.destroy()
        server.close(() => resolveClose())
      })
  }
}

function responseFor(request) {
  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        tools: [
          {
            type: 'function',
            namespace: 'codex_app',
            name: 'echo',
            description: 'Echo smoke-test arguments.',
            inputSchema: { type: 'object' }
          }
        ]
      }
    }
  }
  if (request.method === 'tools/call') {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      result: {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(request.params?.arguments ?? {}) }]
      }
    }
  }
  return {
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: { code: -32601, message: `Unsupported smoke request: ${request.method}` }
  }
}

function encodePipeResponse(response) {
  const payload = Buffer.from(JSON.stringify(response), 'utf8')
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

class McpClient {
  nextId = 0
  output = ''
  stderr = ''
  pending = new Map()

  constructor(child) {
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.consume(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
    child.once('exit', (code, signal) => {
      this.rejectAll(
        new Error(`MCP server exited (${code ?? 'null'}/${signal ?? 'none'}): ${this.stderr}`)
      )
    })
  }

  request(method, params) {
    const id = ++this.nextId
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return withTimeout(
      new Promise((resolveRequest, rejectRequest) =>
        this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
      ),
      method
    )
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  consume(chunk) {
    this.output += chunk
    while (true) {
      const newline = this.output.indexOf('\n')
      if (newline === -1) return
      const line = this.output.slice(0, newline).trim()
      this.output = this.output.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function withTimeout(promise, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rejectTimeout) => {
      timer = setTimeout(() => rejectTimeout(new Error(`${label} timed out.`)), 10_000)
    })
  ])
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function collectExit(child) {
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal, stderr }))
  })
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => child.once('exit', resolveExit))
}

async function expectMissing(path, message) {
  try {
    await access(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error(message)
}

try {
  await main()
} finally {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
}
