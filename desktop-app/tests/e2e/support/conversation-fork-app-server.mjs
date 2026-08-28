#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JSON-RPC peer. */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const statePath = process.env.DASCOWORK_E2E_CONVERSATION_FORK_STATE_PATH
const rpcLogPath = process.env.DASCOWORK_E2E_CONVERSATION_FORK_RPC_LOG_PATH
if (!statePath || !rpcLogPath) {
  throw new Error('Conversation fork E2E app-server requires state and RPC log paths.')
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'e2e-conversation-fork', version: '1.0.0' } })
    return
  }

  if (message.method === 'thread/list') {
    const state = loadState()
    logCall(message)
    respond(message.id, { data: message.params?.archived === true ? [] : state.threads })
    return
  }

  if (message.method === 'thread/read') {
    const thread = findThread(message.params?.threadId)
    logCall(message)
    respond(message.id, { thread })
    return
  }

  if (message.method === 'thread/turns/list') {
    const thread = findThread(message.params?.threadId)
    logCall(message)
    respond(message.id, { data: [...thread.turns].reverse() })
    return
  }

  if (message.method === 'thread/fork') {
    const state = loadState()
    const source = findThread(message.params?.threadId, state)
    const clone = {
      ...source,
      id: 'forked-thread',
      sessionId: 'forked-thread',
      forkedFromId: source.id,
      preview: 'Forked history task',
      name: 'Forked history task',
      createdAt: source.createdAt + 1,
      updatedAt: source.updatedAt + 1,
      cwd: typeof message.params?.cwd === 'string' ? message.params.cwd : source.cwd,
      turns: structuredClone(source.turns)
    }
    state.threads = [...state.threads.filter((thread) => thread.id !== clone.id), clone]
    saveState(state)
    logCall(message)
    respond(message.id, { thread: clone })
    return
  }

  if (message.method === 'thread/rollback') {
    const state = loadState()
    const thread = findThread(message.params?.threadId, state)
    const numTurns = Number(message.params?.numTurns ?? 0)
    thread.turns = thread.turns.slice(0, Math.max(0, thread.turns.length - numTurns))
    thread.updatedAt += 1
    saveState(state)
    logCall(message)
    respond(message.id, { thread })
    return
  }

  if (message.method === 'experimentalFeature/list') {
    respond(message.id, { data: [] })
    return
  }

  if (message.id !== undefined && message.method) respond(message.id, {})
})

function findThread(threadId, state = loadState()) {
  const thread = state.threads.find((candidate) => candidate.id === threadId)
  if (thread) return thread
  // Other desktop surfaces share this fixture's app-server process. Their
  // best-effort reads must not terminate the history scenario.
  return emptyThread(typeof threadId === 'string' ? threadId : 'unavailable-thread')
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (Array.isArray(parsed?.threads)) return parsed
  } catch {
    // The fixture state is supplied by the test before Electron is launched.
  }
  return { threads: [] }
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
}

function emptyThread(id) {
  const now = Math.floor(Date.now() / 1000)
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: 'full',
    modelProvider: 'e2e',
    createdAt: now,
    updatedAt: now,
    recencyAt: now,
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

function logCall(message) {
  appendFileSync(
    rpcLogPath,
    `${JSON.stringify({ method: message.method, params: message.params })}\n`,
    'utf8'
  )
}

function respond(id, result) {
  if (id !== undefined) process.stdout.write(`${JSON.stringify({ id, result })}\n`)
}
