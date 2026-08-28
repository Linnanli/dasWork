#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Test-only JSON-RPC peer. */

import { createInterface } from 'node:readline'

const imageResult =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let threadSequence = 0
let turnSequence = 0
const threads = new Map()
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })

input.on('line', (line) => {
  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    respond(message.id, { serverInfo: { name: 'e2e-image-generation', version: '1.0.0' } })
    return
  }

  if (message.method === 'thread/start') {
    const thread = createThread(`e2e-image-thread-${++threadSequence}`)
    threads.set(thread.id, thread)
    respond(message.id, { threadId: thread.id })
    return
  }

  if (message.method === 'thread/resume') {
    const threadId = String(message.params?.threadId ?? '')
    respond(message.id, { thread: threads.get(threadId) ?? createThread(threadId) })
    return
  }

  if (message.method === 'thread/list') {
    respond(message.id, { data: [...threads.values()] })
    return
  }

  if (message.method === 'thread/read') {
    const threadId = String(message.params?.threadId ?? '')
    respond(message.id, { thread: threads.get(threadId) ?? createThread(threadId) })
    return
  }

  if (message.method === 'thread/turns/list') {
    respond(message.id, { data: [] })
    return
  }

  if (message.method === 'turn/start') {
    const threadId = String(message.params?.threadId ?? '')
    const turnId = `e2e-image-turn-${++turnSequence}`
    respond(message.id, { turnId })
    emit({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
    emit({
      method: 'item/started',
      params: {
        threadId,
        turnId,
        item: {
          type: 'imageGeneration',
          id: `e2e-image-item-${turnSequence}`,
          status: 'inProgress',
          revisedPrompt: null,
          result: ''
        }
      }
    })
    emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        item: {
          type: 'imageGeneration',
          id: `e2e-image-item-${turnSequence}`,
          status: 'completed',
          revisedPrompt: 'a one-pixel blue test image',
          result: imageResult
        }
      }
    })
    emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } })
    return
  }

  if (message.id !== undefined && message.method) respond(message.id, {})
})

function createThread(id) {
  const createdAt = Math.floor(Date.now() / 1000)
  return {
    id,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: 'Image generation test',
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

function respond(id, result) {
  if (id !== undefined) emit({ id, result })
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
