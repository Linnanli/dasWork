#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JSON-RPC peer. */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.148.0-alpha.21\n')
  process.exit(0)
}

const rpcLogPath = process.env.DASCOWORK_E2E_APPROVAL_RPC_LOG_PATH
if (!rpcLogPath) throw new Error('Approval mode E2E app-server requires an RPC log path.')

let turnSequence = 0
const threadStorePath = `${rpcLogPath}.threads.json`
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'e2e-approval-modes', version: '1.0.0' } })
    return
  }

  if (message.method === 'thread/start') {
    const threads = loadThreads()
    const thread = createThread(`e2e-approval-thread-${threads.length + 1}`)
    saveThreads([...threads, thread])
    const { id: threadId } = thread
    logCall(message, { threadId })
    respond(message.id, { threadId })
    return
  }

  if (message.method === 'thread/resume') {
    const threadId = String(message.params?.threadId ?? '')
    logCall(message, { threadId })
    respond(message.id, { thread: { id: threadId } })
    return
  }

  if (message.method === 'thread/list') {
    respond(message.id, { data: loadThreads() })
    return
  }

  if (message.method === 'thread/read') {
    const threadId = String(message.params?.threadId ?? '')
    const thread = loadThreads().find((candidate) => candidate.id === threadId)
    respond(message.id, { thread: thread ?? createThread(threadId) })
    return
  }

  if (message.method === 'thread/turns/list') {
    respond(message.id, { data: [] })
    return
  }

  if (message.method === 'turn/start') {
    const threadId = String(message.params?.threadId ?? '')
    const turnId = `e2e-approval-turn-${++turnSequence}`
    logCall(message, { threadId, turnId })
    respond(message.id, { turnId })
    emit({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
    emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, status: 'completed' } }
    })
    return
  }

  if (message.id !== undefined && message.method) respond(message.id, {})
})

function logCall(message, derived) {
  const { method, id, params } = message
  if (typeof method !== 'string' || method.startsWith('item/')) return
  const record = {
    method,
    ...(id === undefined ? {} : { id }),
    ...(params === undefined ? {} : { params }),
    ...derived
  }
  appendFileSync(rpcLogPath, `${JSON.stringify(record)}\n`, 'utf8')
}

function respond(id, result) {
  emit({ id, result })
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function loadThreads() {
  try {
    const parsed = JSON.parse(readFileSync(threadStorePath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveThreads(threads) {
  writeFileSync(threadStorePath, JSON.stringify(threads), 'utf8')
}

function createThread(threadId) {
  const createdAt = Math.floor(Date.now() / 1000)
  return {
    id: threadId,
    extra: null,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: `Approval test ${threadId}`,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: 'full',
    modelProvider: 'e2e',
    createdAt,
    updatedAt: createdAt,
    recencyAt: createdAt,
    status: { type: 'idle' },
    path: null,
    cwd: process.cwd(),
    cliVersion: 'e2e',
    source: 'app-server',
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: []
  }
}
