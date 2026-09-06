#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node E2E helper uses JavaScript. */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import net from 'node:net'

const socketPath = process.env.DASCOWORK_E2E_PERSISTENT_RELAY_SOCKET
const readyPath = process.env.DASCOWORK_E2E_RELAY_READY_PATH
const relayPidPath = process.env.DASCOWORK_E2E_RELAY_PID_PATH
const proxyPidPath = process.env.DASCOWORK_E2E_APP_SERVER_PID_PATH
const codexCommand = process.env.DASCOWORK_E2E_REAL_CODEX_BIN || 'codex'

if (process.argv.includes('--version')) {
  const versionExitCode = await new Promise((resolve) => {
    const versionChild = spawn(codexCommand, ['--version'], { env: process.env, stdio: 'inherit' })
    versionChild.once('error', () => resolve(1))
    versionChild.once('close', (code) => resolve(code ?? 1))
  })
  process.exit(versionExitCode)
}

if (!socketPath || !readyPath || !relayPidPath || !proxyPidPath) {
  throw new Error('Persistent app-server proxy is missing required E2E environment variables.')
}

if (!existsSync(socketPath)) {
  const relay = spawn(
    process.execPath,
    [
      join(dirname(new URL(import.meta.url).pathname), 'persistent-app-server-relay.mjs'),
      socketPath,
      codexCommand,
      ...process.argv.slice(2)
    ],
    { detached: true, stdio: 'ignore', env: process.env }
  )
  relay.unref()
}

const deadline = Date.now() + 10_000
let connected = false
const connect = () => {
  const proxy = net.createConnection(socketPath)
  proxy.once('connect', () => {
    connected = true
    writeFileSync(proxyPidPath, `${process.pid}\n`, 'utf8')
    process.stdin.pipe(proxy)
    proxy.pipe(process.stdout)
  })
  proxy.once('error', () => {
    if (connected || Date.now() >= deadline) process.exit(1)
    setTimeout(connect, 25)
  })
  proxy.once('close', () => {
    if (connected) process.exit(0)
  })
}

connect()
