#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { existsSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const codexCommand = process.env.DASCOWORK_E2E_REAL_CODEX_BIN || 'codex'
const pidPath = process.env.DASCOWORK_E2E_APP_SERVER_PID_PATH
const heldSteerRequestPath = process.env.DASCOWORK_E2E_HELD_STEER_REQUEST_PATH
const originalTurnCompletedPath = process.env.DASCOWORK_E2E_ORIGINAL_TURN_COMPLETED_PATH
const heldThreadStartPath = process.env.DASCOWORK_E2E_HELD_THREAD_START_PATH
const releaseThreadStartPath = process.env.DASCOWORK_E2E_RELEASE_THREAD_START_PATH

if (process.argv.includes('--version')) {
  const versionExitCode = await new Promise((resolve) => {
    const versionChild = spawn(codexCommand, ['--version'], { env: process.env, stdio: 'inherit' })
    versionChild.once('error', () => resolve(1))
    versionChild.once('close', (code) => resolve(code ?? 1))
  })
  process.exit(versionExitCode)
}

if (!pidPath) {
  throw new Error('The E2E app-server wrapper requires DASCOWORK_E2E_APP_SERVER_PID_PATH.')
}

// This wrapper is deliberately test-only. The Desktop process still starts the
// ordinary Codex CLI app-server command with its normal arguments and environment. Tests
// can obtain the operating-system child PID for a real physical failure, or
// hold one already-emitted steer request until the real server completes its
// original turn. The latter produces the server's actual no-active-turn
// rejection rather than injecting an RPC error into the application.
const child = spawn(codexCommand, ['app-server', ...process.argv.slice(2)], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit']
})

writeFileSync(pidPath, `${child.pid}\n`, 'utf8')

let heldSteerRequest
let heldThreadStartRequest
let releaseThreadStartTimer
const clientInput = createInterface({ input: process.stdin, crlfDelay: Infinity })
clientInput.on('line', (line) => {
  if (
    !heldThreadStartRequest &&
    heldThreadStartPath &&
    releaseThreadStartPath &&
    isThreadStartRequest(line)
  ) {
    heldThreadStartRequest = line
    writeFileSync(heldThreadStartPath, 'thread/start\n', 'utf8')
    releaseThreadStartTimer = setInterval(() => {
      if (!heldThreadStartRequest || !existsSync(releaseThreadStartPath)) return
      child.stdin.write(`${heldThreadStartRequest}\n`)
      heldThreadStartRequest = undefined
      clearInterval(releaseThreadStartTimer)
      releaseThreadStartTimer = undefined
    }, 25)
    return
  }
  if (!heldSteerRequest && heldSteerRequestPath && isSteerRequest(line)) {
    heldSteerRequest = line
    writeFileSync(heldSteerRequestPath, 'turn/steer\n', 'utf8')
    return
  }
  child.stdin.write(`${line}\n`)
})

const serverOutput = createInterface({ input: child.stdout, crlfDelay: Infinity })
serverOutput.on('line', (line) => {
  process.stdout.write(`${line}\n`)
  if (!heldSteerRequest || !originalTurnCompletedPath || !isTurnCompletedNotification(line)) return

  writeFileSync(originalTurnCompletedPath, 'turn/completed\n', 'utf8')
  child.stdin.write(`${heldSteerRequest}\n`)
  heldSteerRequest = undefined
})

function isSteerRequest(line) {
  try {
    return JSON.parse(line).method === 'turn/steer'
  } catch {
    return false
  }
}

function isThreadStartRequest(line) {
  try {
    return JSON.parse(line).method === 'thread/start'
  } catch {
    return false
  }
}

function isTurnCompletedNotification(line) {
  try {
    return JSON.parse(line).method === 'turn/completed'
  } catch {
    return false
  }
}

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal)
}

process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))
process.stdin.once('end', () => {
  if (!child.killed) child.stdin.end()
})

child.once('error', (error) => {
  console.error('[e2e-app-server-wrapper] unable to launch codex app-server', error)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  if (releaseThreadStartTimer) clearInterval(releaseThreadStartTimer)
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
