#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JSON-RPC peer. */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.148.0-alpha.21\n')
  process.exit(0)
}

const running = new Map()
const terminalProcesses = new Map()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let outputQueue = Promise.resolve()

input.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  if (message.method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'e2e-remote-git', version: '1.0.0' } })
    return
  }
  if (message.method === 'command/exec') {
    void execute(message)
    return
  }
  if (message.method === 'command/exec/write') {
    writeToProcess(message)
    return
  }
  if (message.method === 'command/exec/terminate') {
    running.get(message.params?.processId)?.kill('SIGKILL')
    respond(message.id, {})
    return
  }
  if (message.method === 'process/spawn') {
    spawnTerminal(message)
    return
  }
  if (message.method === 'process/writeStdin') {
    writeToTerminal(message)
    return
  }
  if (message.method === 'process/resizePty') {
    traceTerminalRequest(message.method, message.params)
    respond(message.id, {})
    return
  }
  if (message.method === 'process/kill') {
    traceTerminalRequest(message.method, message.params)
    terminalProcesses.get(message.params?.processHandle)?.kill('SIGTERM')
    respond(message.id, {})
    return
  }
  if (message.id !== undefined && message.method) respond(message.id, {})
})

async function execute(message) {
  const { command, cwd, env, processId, streamStdin } = message.params ?? {}
  traceCommandRequest('command/exec', message.params)
  if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) {
    respond(message.id, { processId: processId ?? 'invalid', exitCode: 2, stdout: '', stderr: '' })
    return
  }

  const crashControlFile = process.env.DASCOWORK_E2E_REMOTE_GIT_CRASH_ON_CONTROL_FILE
  if (crashControlFile && existsSync(crashControlFile)) {
    unlinkSync(crashControlFile)
    process.exit(0)
  }

  if (command[0] === 'codex' && command[1] === '--version') {
    emitOutput(processId, 'stdout', 'codex-cli 1.2.3\n')
    traceCommandRequest('command/exec/close', { processId, exitCode: 0 })
    respond(message.id, { processId, exitCode: 0, stdout: '', stderr: '' })
    return
  }

  const [executable, ...args] = command
  const child = spawn(executable, args, {
    cwd: typeof cwd === 'string' ? cwd : undefined,
    env: mergeEnvironment(env),
    stdio: [streamStdin === true ? 'pipe' : 'ignore', 'pipe', 'pipe']
  })
  if (typeof processId === 'string') running.set(processId, child)
  child.stdout.on('data', (chunk) => emitOutput(processId, 'stdout', chunk))
  child.stderr.on('data', (chunk) => emitOutput(processId, 'stderr', chunk))
  child.once('error', (error) => {
    emitOutput(processId, 'stderr', error.message)
    traceCommandRequest('command/exec/error', { processId, message: error.message })
    respond(message.id, { processId, exitCode: 1, stdout: '', stderr: error.message })
  })
  child.once('close', (exitCode) => {
    if (typeof processId === 'string') running.delete(processId)
    traceCommandRequest('command/exec/close', { processId, exitCode })
    respond(message.id, { processId, exitCode: exitCode ?? 1, stdout: '', stderr: '' })
  })
}

function writeToProcess(message) {
  const child = running.get(message.params?.processId)
  if (child && typeof message.params?.deltaBase64 === 'string') {
    child.stdin.write(Buffer.from(message.params.deltaBase64, 'base64'))
  }
  if (child && message.params?.closeStdin) child.stdin.end()
  respond(message.id, {})
}

function spawnTerminal(message) {
  const { command, cwd, env, processHandle } = message.params ?? {}
  traceTerminalRequest(message.method, message.params)
  if (
    !Array.isArray(command) ||
    !command.every((part) => typeof part === 'string') ||
    typeof processHandle !== 'string'
  ) {
    emit({ id: message.id, error: { code: -32602, message: 'Invalid process/spawn parameters' } })
    return
  }

  const [executable, ...args] = command
  const child = spawn(executable, args, {
    cwd: typeof cwd === 'string' ? cwd : undefined,
    env: mergeEnvironment(env),
    stdio: ['pipe', 'pipe', 'pipe']
  })
  terminalProcesses.set(processHandle, child)
  child.stdout.on('data', (chunk) => emitTerminalOutput(processHandle, 'stdout', chunk))
  child.stderr.on('data', (chunk) => emitTerminalOutput(processHandle, 'stderr', chunk))
  child.once('error', (error) => emitTerminalOutput(processHandle, 'stderr', error.message))
  child.once('close', (exitCode) => {
    terminalProcesses.delete(processHandle)
    emit({
      method: 'process/exited',
      params: {
        processHandle,
        exitCode: exitCode ?? 1,
        stdout: '',
        stdoutCapReached: false,
        stderr: '',
        stderrCapReached: false
      }
    })
  })
  respond(message.id, {})
}

function writeToTerminal(message) {
  const { processHandle, deltaBase64, closeStdin } = message.params ?? {}
  traceTerminalRequest(message.method, message.params)
  const child = terminalProcesses.get(processHandle)
  if (child && typeof deltaBase64 === 'string') {
    // The real app-server allocates a PTY. This lightweight JSON-RPC stand-in
    // uses pipes, so normalize xterm's carriage-return Enter key into a line
    // feed before passing it to the test shell.
    child.stdin.write(Buffer.from(deltaBase64, 'base64').toString('utf8').replaceAll('\r', '\n'))
  }
  if (child && closeStdin) child.stdin.end()
  respond(message.id, {})
}

function mergeEnvironment(overrides) {
  const environment = { ...process.env }
  if (!overrides || typeof overrides !== 'object') return environment
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete environment[key]
    else if (typeof value === 'string') environment[key] = value
  }
  return environment
}

function emitOutput(processId, stream, chunk) {
  if (typeof processId !== 'string') return
  emit({
    method: 'command/exec/outputDelta',
    params: {
      processId,
      stream,
      deltaBase64: Buffer.from(chunk).toString('base64'),
      capReached: false
    }
  })
}

function emitTerminalOutput(processHandle, stream, chunk) {
  emit({
    method: 'process/outputDelta',
    params: {
      processHandle,
      stream,
      deltaBase64: Buffer.from(chunk).toString('base64'),
      capReached: false
    }
  })
}

function traceTerminalRequest(method, params) {
  const tracePath = process.env.DASCOWORK_E2E_REMOTE_TERMINAL_TRACE
  if (!tracePath) return
  appendFileSync(tracePath, `${JSON.stringify({ method, params })}\n`, 'utf8')
}

function traceCommandRequest(method, params) {
  const tracePath = process.env.DASCOWORK_E2E_REMOTE_COMMAND_TRACE
  if (!tracePath) return
  appendFileSync(tracePath, `${JSON.stringify({ method, params })}\n`, 'utf8')
}

function respond(id, result) {
  if (id !== undefined) emit({ id, result })
}

function emit(message) {
  const line = `${JSON.stringify(message)}\n`
  outputQueue = outputQueue.then(
    () =>
      new Promise((resolve) => {
        if (process.stdout.write(line)) {
          resolve()
          return
        }
        process.stdout.once('drain', resolve)
      })
  )
}
