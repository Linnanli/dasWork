import type { LanguageModelV3CallOptions } from '@ai-sdk/provider'
import { describe, expect, it, vi } from 'vitest'

import { CodexAppServerConnection } from '../src/client/app-server-connection'
import type { JsonRpcMessage } from '../src/client/transport'
import { CODEX_PROVIDER_ID, codexCallOptions } from '../src/protocol/provider-metadata'
import { createCodexAppServer } from '../src/provider'
import type { CodexTurnLifecycleEvent } from '../src/provider-settings'
import type { CodexSession } from '../src/session'
import { MockTransport } from './helpers/mock-transport'
import { planAssertionsForTest } from './helpers/plan-assertion'

class ScriptedTransport extends MockTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    await super.sendMessage(message)

    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      return
    }

    if (message.method === 'initialize') {
      this.emitMessage({
        id: message.id,
        result: { serverInfo: { name: 'codex', version: 'test' } }
      })
      return
    }

    if (message.method === 'environment/add') {
      this.emitMessage({ id: message.id, result: {} })
      return
    }

    if (message.method === 'thread/start') {
      this.emitMessage({ id: message.id, result: { threadId: 'thr_1' } })
      return
    }

    if (message.method === 'thread/resume') {
      this.emitMessage({
        id: message.id,
        result: {
          thread: {
            id: 'thr_1',
            preview: '',
            modelProvider: 'openai',
            createdAt: 0,
            updatedAt: 0,
            path: null,
            cwd: '/tmp',
            cliVersion: 'test',
            source: 'appServer',
            gitInfo: null,
            turns: []
          },
          model: 'gpt-5.5',
          modelProvider: 'openai',
          cwd: '/tmp',
          approvalPolicy: 'never',
          approvalsReviewer: 'user',
          sandbox: { type: 'dangerFullAccess' },
          reasoningEffort: null,
          initialTurnsPage: null
        }
      })
      return
    }

    if (message.method === 'thread/compact/start') {
      this.emitMessage({ id: message.id, result: {} })
      return
    }

    if (message.method === 'turn/start') {
      this.emitMessage({ id: message.id, result: { turnId: 'turn_1' } })

      queueMicrotask(() => {
        this.emitMessage({
          method: 'turn/started',
          params: { threadId: 'thr_1', turn: { id: 'turn_1' } }
        })
        this.emitMessage({
          method: 'item/started',
          params: {
            item: { type: 'agentMessage', id: 'item_1', text: '' },
            threadId: 'thr_1',
            turnId: 'turn_1'
          }
        })
        this.emitMessage({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thr_1',
            turnId: 'turn_1',
            itemId: 'item_1',
            delta: 'Hello'
          }
        })
        this.emitMessage({
          method: 'item/completed',
          params: {
            item: { type: 'agentMessage', id: 'item_1', text: 'Hello' },
            threadId: 'thr_1',
            turnId: 'turn_1'
          }
        })
        this.emitMessage({
          method: 'turn/completed',
          params: {
            threadId: 'thr_1',
            turn: { id: 'turn_1', items: [], status: 'completed', error: null }
          }
        })
      })
    }
  }
}

class GoalContinuousTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'goal_turn_1' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'goal_turn_1' } }
      })
      this.emitMessage({
        method: 'item/started',
        params: {
          item: { type: 'agentMessage', id: 'goal_item_1', text: '' },
          threadId: 'thr_1',
          turnId: 'goal_turn_1'
        }
      })
      this.emitMessage({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_1',
          turnId: 'goal_turn_1',
          itemId: 'goal_item_1',
          delta: 'first turn'
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'goal_turn_1', items: [], status: 'completed', error: null }
        }
      })
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'goal_turn_2' } }
      })
      this.emitMessage({
        method: 'item/started',
        params: {
          item: { type: 'agentMessage', id: 'goal_item_2', text: '' },
          threadId: 'thr_1',
          turnId: 'goal_turn_2'
        }
      })
      this.emitMessage({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_1',
          turnId: 'goal_turn_2',
          itemId: 'goal_item_2',
          delta: 'second turn'
        }
      })
      this.emitMessage({
        method: 'thread/goal/updated',
        params: {
          threadId: 'thr_1',
          goal: {
            threadId: 'thr_1',
            objective: 'finish the work',
            status: 'complete',
            tokenBudget: null,
            tokensUsed: 1,
            timeUsedSeconds: 1,
            createdAt: 0,
            updatedAt: 1
          }
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'goal_turn_2', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class PromotedGoalTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      await super.sendMessage(message)
      return
    }

    if (message.method === 'turn/start') {
      await MockTransport.prototype.sendMessage.call(this, message)
      this.emitMessage({ id: message.id, result: { turnId: 'promoted_turn_1' } })
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'promoted_turn_1' } }
      })
      return
    }

    if (message.method !== 'thread/goal/set') {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({
      id: message.id,
      result: {
        goal: {
          threadId: 'thr_1',
          objective: 'continue after this turn',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 0,
          updatedAt: 0
        }
      }
    })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'promoted_turn_1', items: [], status: 'completed', error: null }
        }
      })
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'promoted_turn_2' } }
      })
      this.emitMessage({
        method: 'item/started',
        params: {
          item: { type: 'agentMessage', id: 'promoted_item_2', text: '' },
          threadId: 'thr_1',
          turnId: 'promoted_turn_2'
        }
      })
      this.emitMessage({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_1',
          turnId: 'promoted_turn_2',
          itemId: 'promoted_item_2',
          delta: 'continued goal turn'
        }
      })
      this.emitMessage({
        method: 'thread/goal/updated',
        params: {
          threadId: 'thr_1',
          goal: {
            threadId: 'thr_1',
            objective: 'continue after this turn',
            status: 'complete',
            tokenBudget: null,
            tokensUsed: 1,
            timeUsedSeconds: 1,
            createdAt: 0,
            updatedAt: 1
          }
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'promoted_turn_2', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class ClearedGoalTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'cleared_goal_turn' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'cleared_goal_turn' } }
      })
      this.emitMessage({
        method: 'thread/goal/cleared',
        params: { threadId: 'thr_1' }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'cleared_goal_turn', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class ExistingGoalControlTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'thread/goal/set'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({
      id: message.id,
      result: {
        goal: {
          threadId: 'thr_1',
          objective: 'continue the existing goal',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 0,
          updatedAt: 0
        }
      }
    })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'goal_control_turn' } }
      })
      this.emitMessage({
        method: 'item/started',
        params: {
          item: { type: 'agentMessage', id: 'goal_control_item', text: '' },
          threadId: 'thr_1',
          turnId: 'goal_control_turn'
        }
      })
      this.emitMessage({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_1',
          turnId: 'goal_control_turn',
          itemId: 'goal_control_item',
          delta: 'continued without a user turn'
        }
      })
      this.emitMessage({
        method: 'thread/goal/updated',
        params: {
          threadId: 'thr_1',
          goal: {
            threadId: 'thr_1',
            objective: 'continue the existing goal',
            status: 'complete',
            tokenBudget: null,
            tokensUsed: 1,
            timeUsedSeconds: 1,
            createdAt: 0,
            updatedAt: 1
          }
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'goal_control_turn', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class FailingConnectTransport extends MockTransport {
  override connect(): Promise<void> {
    return Promise.reject(new Error('connection failed before request'))
  }
}

class ActiveTurnResumeTransport extends MockTransport {
  constructor(private readonly includeActiveTurn = true) {
    super()
  }

  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    await super.sendMessage(message)
    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      return
    }
    if (message.method === 'initialize') {
      this.emitMessage({
        id: message.id,
        result: { serverInfo: { name: 'codex', version: 'test' } }
      })
      return
    }
    if (message.method !== 'thread/resume') {
      return
    }
    this.emitMessage({
      id: message.id,
      result: {
        thread: {
          id: 'thr_resume',
          preview: '',
          modelProvider: 'openai',
          createdAt: 0,
          updatedAt: 0,
          path: null,
          cwd: '/tmp',
          cliVersion: 'test',
          source: 'appServer',
          gitInfo: null,
          turns: this.includeActiveTurn
            ? [
                {
                  id: 'turn_resume',
                  items: [{ type: 'agentMessage', id: 'item_resume', text: 'Hello' }],
                  itemsView: 'full',
                  status: 'inProgress',
                  error: null,
                  startedAt: 0,
                  completedAt: null,
                  durationMs: null
                }
              ]
            : []
        },
        model: 'gpt-5.5',
        modelProvider: 'openai',
        cwd: '/tmp',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: { type: 'dangerFullAccess' },
        reasoningEffort: null,
        initialTurnsPage: null
      }
    })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr_resume',
          turnId: 'turn_resume',
          itemId: 'item_resume',
          delta: '!'
        }
      })
      this.emitMessage({
        method: 'item/completed',
        params: {
          threadId: 'thr_resume',
          turnId: 'turn_resume',
          item: { type: 'agentMessage', id: 'item_resume', text: 'Hello!' }
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_resume',
          turn: { id: 'turn_resume', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class TaskReferenceTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    await super.sendMessage(message)
    if (
      'id' in message &&
      message.id !== undefined &&
      'method' in message &&
      message.method === 'thread/read'
    ) {
      this.emitMessage({
        id: message.id,
        result: {
          thread: {
            id: 'referenced',
            name: 'Referenced',
            preview: '',
            turns: []
          }
        }
      })
    }
  }
}

class CompactionFailingTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      await super.sendMessage(message)
      return
    }

    if (message.method === 'thread/compact/start') {
      await MockTransport.prototype.sendMessage.call(this, message)
      this.emitMessage({
        id: message.id,
        error: { code: -32000, message: 'compaction failed' }
      })
      return
    }

    await super.sendMessage(message)
  }
}

class AgentLifecycleTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'turn_1' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'turn_1' } }
      })
      this.emitMessage({
        method: 'item/started',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_1',
          startedAtMs: 123,
          item: {
            type: 'subAgentActivity',
            id: 'activity-1',
            kind: 'started',
            agentThreadId: 'agent-1',
            agentPath: '/repo'
          }
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'turn_1', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class TurnLifecycleTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'turn_lifecycle' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'turn_lifecycle' } }
      })
      const userMessage = {
        type: 'userMessage' as const,
        id: 'user_item_1',
        clientId: 'client_user_1',
        content: [
          { type: 'text' as const, text: '  Hello lifecycle  ', text_elements: [] },
          {
            type: 'image' as const,
            url: 'https://example.test/image.png',
            detail: 'high' as const
          },
          { type: 'localImage' as const, path: '/tmp/local.png' }
        ]
      }
      this.emitMessage({
        method: 'item/started',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_lifecycle',
          startedAtMs: 100,
          item: userMessage
        }
      })
      this.emitMessage({
        method: 'item/completed',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_lifecycle',
          completedAtMs: 200,
          item: userMessage
        }
      })
      this.emitMessage({
        method: 'turn/diff/updated',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_lifecycle',
          diff: 'diff --git a/final.ts b/final.ts\n+final\n'
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: {
            id: 'turn_lifecycle',
            items: [userMessage],
            status: 'completed',
            error: null
          }
        }
      })
    })
  }
}

class ThreadSettingsTransport extends ScriptedTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'turn_settings' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'turn_settings' } }
      })
      this.emitMessage({
        method: 'thread/settings/updated',
        params: {
          threadId: 'thr_1',
          threadSettings: {
            cwd: '/repo',
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandboxPolicy: { type: 'dangerFullAccess' },
            activePermissionProfile: null,
            model: 'gpt-5.5',
            modelProvider: 'openai',
            serviceTier: null,
            effort: 'medium',
            summary: null,
            collaborationMode: {
              mode: 'plan',
              settings: {
                model: 'gpt-5.5',
                reasoning_effort: 'medium',
                developer_instructions: null
              }
            },
            multiAgentMode: 'explicitRequestOnly',
            personality: null
          }
        }
      })
      this.emitMessage({
        method: 'thread/goal/updated',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_settings',
          goal: {
            threadId: 'thr_1',
            objective: '完成参考实现的功能对齐',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 10,
            timeUsedSeconds: 2,
            createdAt: 1,
            updatedAt: 2
          }
        }
      })
      this.emitMessage({
        method: 'turn/completed',
        params: {
          threadId: 'thr_1',
          turn: { id: 'turn_settings', items: [], status: 'completed', error: null }
        }
      })
    })
  }
}

class InterruptAwareTransport extends MockTransport {
  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    await super.sendMessage(message)

    if (!('id' in message) || message.id === undefined || !('method' in message)) {
      return
    }

    if (message.method === 'initialize') {
      this.emitMessage({
        id: message.id,
        result: { serverInfo: { name: 'codex', version: 'test' } }
      })
      return
    }

    if (message.method === 'thread/start') {
      this.emitMessage({ id: message.id, result: { threadId: 'thr_abort' } })
      return
    }

    if (message.method === 'turn/start') {
      this.emitMessage({ id: message.id, result: { turnId: 'turn_abort' } })
      return
    }

    if (message.method === 'turn/interrupt') {
      this.emitMessage({ id: message.id, result: {} })
      queueMicrotask(() => {
        this.emitMessage({
          method: 'turn/completed',
          params: {
            threadId: 'thr_abort',
            turn: { id: 'turn_abort', items: [], status: 'interrupted', error: null }
          }
        })
      })
      return
    }
  }
}

class ActiveTransportCrashTransport extends ScriptedTransport {
  readonly readyForFailure = deferred<void>()
  disconnectCalls = 0

  constructor(private readonly emitPartialToken: boolean) {
    super()
  }

  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'turn_transport_crash' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'turn_transport_crash' } }
      })

      if (this.emitPartialToken) {
        this.emitMessage({
          method: 'item/started',
          params: {
            item: { type: 'agentMessage', id: 'item_transport_crash', text: '' },
            threadId: 'thr_1',
            turnId: 'turn_transport_crash'
          }
        })
        this.emitMessage({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thr_1',
            turnId: 'turn_transport_crash',
            itemId: 'item_transport_crash',
            delta: 'Partial response'
          }
        })
      }

      this.readyForFailure.resolve()
    })
  }

  override async disconnect(): Promise<void> {
    this.disconnectCalls++
    await super.disconnect()
  }
}

class ToolLifecycleCrashTransport extends ScriptedTransport {
  readonly readyForFailure = deferred<void>()
  disconnectCalls = 0

  constructor(private readonly lifecycleEvents: readonly JsonRpcMessage[]) {
    super()
  }

  override async sendMessage(message: JsonRpcMessage): Promise<void> {
    if (
      !('id' in message) ||
      message.id === undefined ||
      !('method' in message) ||
      message.method !== 'turn/start'
    ) {
      await super.sendMessage(message)
      return
    }

    await MockTransport.prototype.sendMessage.call(this, message)
    this.emitMessage({ id: message.id, result: { turnId: 'turn_tool_crash' } })
    queueMicrotask(() => {
      this.emitMessage({
        method: 'turn/started',
        params: { threadId: 'thr_1', turn: { id: 'turn_tool_crash' } }
      })
      for (const event of this.lifecycleEvents) {
        this.emitMessage(event)
      }
      this.readyForFailure.resolve()
    })
  }

  override async disconnect(): Promise<void> {
    this.disconnectCalls++
    await super.disconnect()
  }
}

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader()
  const parts: unknown[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    parts.push(value)
  }

  return parts
}

async function readAllWithin(
  stream: ReadableStream<unknown>,
  timeoutMs: number
): Promise<unknown[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      readAll(stream),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Stream did not terminate within ${timeoutMs}ms.`)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('CodexLanguageModel.doStream', () => {
  it('C01 emits one error and sends no JSON-RPC request when transport connection fails', async () => {
    const assertC01 = planAssertionsForTest('C01')
    const transport = new FailingConnectTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })
    const parts = (await readAll(stream)) as Array<{
      type?: string
      error?: Error & { code?: unknown }
    }>

    await assertC01('terminal 只结算一次且 Composer 恢复', () =>
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1)
    )
    await assertC01('保留可见内容并显示单一终态', () =>
      expect(parts.find((part) => part.type === 'error')?.error?.message).toBe(
        'connection failed before request'
      )
    )
    await assertC01('无自动重试、额外请求或迟到事件应用', () =>
      expect(transport.sentMessages).toHaveLength(0)
    )
  })

  it('runs initialize -> thread/start -> turn/start and maps notifications to stream parts', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ clientUserMessageId: 'queue-message-1' })
    })

    const parts = await readAll(stream)

    expect(parts).toEqual([
      {
        type: 'stream-start',
        warnings: [],
        providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: 'thr_1', turnId: 'turn_1' } }
      },
      {
        type: 'text-start',
        id: 'item_1',
        providerMetadata: {
          [CODEX_PROVIDER_ID]: {
            threadId: 'thr_1',
            turnId: 'turn_1',
            sourceItemId: 'item_1'
          }
        }
      },
      {
        type: 'text-delta',
        id: 'item_1',
        delta: 'Hello',
        providerMetadata: {
          [CODEX_PROVIDER_ID]: {
            threadId: 'thr_1',
            turnId: 'turn_1',
            sourceItemId: 'item_1'
          }
        }
      },
      {
        type: 'text-end',
        id: 'item_1',
        providerMetadata: {
          [CODEX_PROVIDER_ID]: {
            threadId: 'thr_1',
            turnId: 'turn_1',
            sourceItemId: 'item_1'
          }
        }
      },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'completed' },
        usage: {
          inputTokens: {
            total: undefined,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined
          },
          outputTokens: {
            total: undefined,
            text: undefined,
            reasoning: undefined
          }
        },
        providerMetadata: { [CODEX_PROVIDER_ID]: { threadId: 'thr_1', turnId: 'turn_1' } }
      }
    ])

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )
    expect(turnStartMessage).toBeDefined()
    expect(turnStartMessage?.params).toMatchObject({
      clientUserMessageId: 'queue-message-1',
      input: [{ type: 'text', text: 'hi', text_elements: [] }]
    })
  })

  it('forwards explicit Plan and Default collaboration modes on turn/start', async () => {
    const planMode = {
      mode: 'plan' as const,
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: 'medium',
        developer_instructions: null
      }
    }
    const defaultMode = {
      mode: 'default' as const,
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: null,
        developer_instructions: null
      }
    }

    const planTransport = new ScriptedTransport()
    const defaultTransport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: ({ threadId }) => (threadId ? defaultTransport : planTransport),
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })
    const model = provider.languageModel('gpt-5.5')

    const { stream: planStream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'make a plan' }] }],
      providerOptions: codexCallOptions({ collaborationMode: planMode })
    })
    await readAll(planStream)

    const { stream: defaultStream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'make a plan' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Plan done' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_1' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'now continue normally' }] }
      ],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr_1',
        collaborationMode: defaultMode
      })
    })
    await readAll(defaultStream)

    const planTurnStart = planTransport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )
    const defaultTurnStart = defaultTransport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(planTurnStart?.params).toMatchObject({ collaborationMode: planMode })
    expect(defaultTurnStart?.params).toMatchObject({ collaborationMode: defaultMode })
  })

  it("frames a new Goal's first turn while preserving system instructions and attachments", async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [
        { role: 'system', content: 'Keep the implementation minimal.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ship Goal parity' },
            { type: 'file', mediaType: 'image/png', data: new URL('https://example.test/goal.png') }
          ]
        }
      ],
      providerOptions: codexCallOptions({
        goalFirstTurnObjective: 'ship Goal parity'
      })
    })
    await readAll(stream)

    const threadStart = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )
    const turnStart = transport.sentMessages.find(
      (message): message is { method: string; params?: { input?: unknown } } =>
        'method' in message && message.method === 'turn/start'
    )
    expect(threadStart?.params).toMatchObject({
      developerInstructions: 'Keep the implementation minimal.'
    })
    expect(turnStart?.params?.input).toEqual([
      {
        type: 'text',
        text: 'Begin working toward this long-running goal.\n\nGoal:\nship Goal parity',
        text_elements: []
      },
      { type: 'image', url: 'https://example.test/goal.png' }
    ])
  })

  it('keeps one Goal conversation session open across automatic turns', async () => {
    const transport = new GoalContinuousTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'finish the work' }] }],
      providerOptions: codexCallOptions({ goalContinuous: true })
    })
    const parts = (await readAll(stream)) as Array<{
      type: string
      delta?: string
    }>

    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      'first turn',
      'second turn'
    ])
    expect(
      transport.sentMessages.filter(
        (message) => 'method' in message && message.method === 'turn/start'
      )
    ).toHaveLength(1)
  })

  it('promotes an active single-turn session when a Goal is set through its control channel', async () => {
    const transport = new PromotedGoalTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'start normally' }] }],
      providerOptions: codexCallOptions({
        onSessionCreated: async (session) => {
          await session.setThreadGoal?.({
            objective: 'continue after this turn',
            status: 'active'
          })
        }
      })
    })
    const parts = (await readAll(stream)) as Array<{ type: string; delta?: string }>

    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'text-delta', delta: 'continued goal turn' })
    )
  })

  it('finishes a continuous Goal stream after thread/goal/cleared', async () => {
    const transport = new ClearedGoalTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'clear this goal' }] }],
      providerOptions: codexCallOptions({ goalContinuous: true })
    })
    const parts = (await readAll(stream)) as Array<{ type: string }>

    expect(parts.filter((part) => part.type === 'finish')).toHaveLength(1)
  })

  it('resumes an existing Goal before setting it and does not add turn/start', async () => {
    const transport = new ExistingGoalControlTransport()
    const sessionCreated = vi.fn(async (session: CodexSession) => {
      await session.setThreadGoal?.({
        objective: 'continue the existing goal',
        status: 'active'
      })
    })
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'previous transcript' }] }],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr_1',
        goalControlObjective: 'continue the existing goal',
        goalContinuous: true,
        onSessionCreated: sessionCreated
      })
    })
    const parts = (await readAll(stream)) as Array<{ type: string; delta?: string }>
    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'thread/goal/set'])
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'text-delta', delta: 'continued without a user turn' })
    )
    expect(sessionCreated.mock.calls[0]?.[0]).toMatchObject({
      threadId: 'thr_1',
      policy: 'goal-continuous'
    })
  })

  it('reattaches an active turn without issuing turn/start and merges its text snapshot', async () => {
    const transport = new ActiveTurnResumeTransport()
    const recoveryStates: Array<{ textByItemId: Record<string, string> }> = []
    const sessionCreated = vi.fn()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'must not replay' }] }],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr_resume',
        resumeActiveTurn: true,
        existingTurnRecoveryState: {
          turnId: 'turn_resume',
          textByItemId: { item_resume: 'Hel' },
          emittedProviderToolCallIds: [],
          completedProviderToolCallIds: []
        },
        onExistingTurnRecoveryState: (state) => recoveryStates.push(state),
        onSessionCreated: sessionCreated
      })
    })
    const parts = await readAll(stream)
    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(parts.filter((part) => (part as { type?: string }).type === 'text-delta')).toEqual([
      expect.objectContaining({ type: 'text-delta', id: 'item_resume', delta: 'lo' }),
      expect.objectContaining({ type: 'text-delta', id: 'item_resume', delta: '!' })
    ])
    expect(
      parts.filter(
        (part) =>
          (part as { type?: string; id?: string }).type === 'text-start' &&
          (part as { id?: string }).id === 'item_resume'
      )
    ).toEqual([])
    expect(parts).toContainEqual(expect.objectContaining({ type: 'finish' }))
    expect(sessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thr_resume', turnId: 'turn_resume' })
    )
    expect(recoveryStates.at(-1)?.textByItemId).toEqual({ item_resume: 'Hello!' })
  })

  it('does not create a turn when the resumed thread no longer has the active turn', async () => {
    const transport = new ActiveTurnResumeTransport(false)
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'must not replay' }] }],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr_resume',
        resumeActiveTurn: true,
        existingTurnRecoveryState: {
          turnId: 'turn_resume',
          textByItemId: { item_resume: 'Hel' },
          emittedProviderToolCallIds: [],
          completedProviderToolCallIds: []
        }
      })
    })
    const parts = (await readAll(stream)) as Array<{
      type?: string
      error?: Error & { code?: unknown }
    }>
    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume'])
    const errorParts = parts.filter((part) => part.type === 'error')
    expect(errorParts).toHaveLength(1)
    expect(errorParts[0]?.error?.message).toBe(
      'The active turn is no longer available for recovery.'
    )
    expect(errorParts[0]?.error?.code).toBe('active_turn_unavailable')
  })

  it('C23 fails once and deactivates the session when transport closes before the first token', async () => {
    const assertC23 = planAssertionsForTest('C23')
    const transport = new ActiveTransportCrashTransport(false)
    let session: CodexSession | undefined
    const sessionCreated = deferred<CodexSession>()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({
        onSessionCreated: (createdSession) => {
          session = createdSession
          sessionCreated.resolve(createdSession)
        }
      })
    })
    await sessionCreated.promise

    expect(session?.isActive()).toBe(true)
    transport.emitClose(1, null)

    const parts = (await readAll(stream)) as Array<{
      type?: string
      error?: Error & { code?: unknown }
    }>
    const errors = parts.filter((part) => part.type === 'error')

    await assertC23('terminal 只结算一次且 Composer 恢复', () => expect(errors).toHaveLength(1))
    await assertC23('保留可见内容并显示单一终态', () =>
      expect(errors[0]?.error?.message).toBe('App Server transport closed unexpectedly (code 1).')
    )
    expect(errors[0]?.error?.code).toBe('app_server_transport_closed')
    await assertC23('无自动重试、额外请求或迟到事件应用', () =>
      expect(transport.disconnectCalls).toBe(1)
    )
    expect(parts.some((part) => part.type === 'text-delta')).toBe(false)
    expect(session?.isActive()).toBe(false)
  })

  it('C23 preserves partial output, emits one error, and rebuilds a crashed persistent worker', async () => {
    const assertC23 = planAssertionsForTest('C23')
    const firstTransport = new ActiveTransportCrashTransport(true)
    const transports: MockTransport[] = []
    let factoryCalls = 0
    const provider = createCodexAppServer({
      transportFactory: () => {
        factoryCalls++
        const transport = factoryCalls === 1 ? firstTransport : new ScriptedTransport()
        transports.push(transport)
        return transport
      },
      persistent: { poolSize: 1 },
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })
    const model = provider.languageModel('gpt-5.5')

    const { stream: failedStream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })
    await firstTransport.readyForFailure.promise
    firstTransport.emitError(new Error('connection reset'))
    firstTransport.emitClose(null, 'SIGTERM')

    const failedParts = (await readAll(failedStream)) as Array<{
      type?: string
      delta?: string
      error?: Error & { code?: unknown }
    }>
    await assertC23('terminal 只结算一次且 Composer 恢复', () =>
      expect(failedParts.filter((part) => part.type === 'error')).toHaveLength(1)
    )
    await assertC23('保留可见内容并显示单一终态', () =>
      expect(
        failedParts.some((part) => part.type === 'text-delta' && part.delta === 'Partial response')
      ).toBe(true)
    )
    await assertC23('无自动重试、额外请求或迟到事件应用', () => expect(factoryCalls).toBe(1))
    expect(failedParts.find((part) => part.type === 'error')?.error?.code).toBe(
      'app_server_transport_terminated'
    )

    const { stream: recoveredStream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'retry' }] }]
    })
    const recoveredParts = (await readAll(recoveredStream)) as Array<{ type?: string }>

    expect(factoryCalls).toBe(2)
    expect(recoveredParts.some((part) => part.type === 'finish')).toBe(true)
    expect(
      transports[1]?.sentMessages.some(
        (message) => 'method' in message && message.method === 'initialize'
      )
    ).toBe(true)

    await provider.shutdown()
  })

  it.each([
    { phase: 'before the first token', emitPartialToken: false },
    { phase: 'after partial output', emitPartialToken: true }
  ])(
    'C23 terminates once $phase and rebuilds the Desktop shared connection',
    async ({ emitPartialToken }) => {
      const assertC23 = planAssertionsForTest('C23')
      const crashedTransport = new ActiveTransportCrashTransport(emitPartialToken)
      const physicalTransports: MockTransport[] = []
      const connection = new CodexAppServerConnection({
        transportFactory: () => {
          const transport =
            physicalTransports.length === 0 ? crashedTransport : new ScriptedTransport()
          physicalTransports.push(transport)
          return transport
        }
      })
      const provider = createCodexAppServer({
        transportFactory: (context) => connection.createTransport(context),
        clientInfo: { name: 'desktop-test-client', version: '1.0.0' }
      })
      const model = provider.languageModel('gpt-5.5')

      const { stream: failedStream } = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
      })
      await crashedTransport.readyForFailure.promise
      crashedTransport.emitError(new Error('connection reset'))
      crashedTransport.emitClose(null, 'SIGTERM')

      const failedParts = (await readAllWithin(failedStream, 1_000)) as Array<{
        type?: string
        delta?: string
        error?: Error & { code?: unknown }
      }>
      await assertC23('terminal 只结算一次且 Composer 恢复', () =>
        expect(failedParts.filter((part) => part.type === 'error')).toHaveLength(1)
      )
      await assertC23('保留可见内容并显示单一终态', () =>
        expect(failedParts.some((part) => part.type === 'finish')).toBe(false)
      )
      await assertC23('无自动重试、额外请求或迟到事件应用', () =>
        expect(physicalTransports).toHaveLength(1)
      )
      expect(failedParts.find((part) => part.type === 'error')?.error?.code).toBe(
        'app_server_transport_terminated'
      )
      expect(
        failedParts.some((part) => part.type === 'text-delta' && part.delta === 'Partial response')
      ).toBe(emitPartialToken)
      expect(connection.getDiagnostics()).toEqual({
        generation: 1,
        physicalConnectionActive: false,
        logicalChannelCount: 0,
        pendingRequestCount: 0,
        activeLeaseCount: 0,
        threadOwnerCount: 0,
        turnOwnerCount: 0,
        continuationCount: 0
      })

      const { stream: recoveredStream } = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'retry' }] }]
      })
      const recoveredParts = (await readAll(recoveredStream)) as Array<{ type?: string }>

      expect(physicalTransports).toHaveLength(2)
      expect(recoveredParts.some((part) => part.type === 'finish')).toBe(true)
      expect(connection.getDiagnostics()).toEqual({
        generation: 1,
        physicalConnectionActive: true,
        logicalChannelCount: 0,
        pendingRequestCount: 0,
        activeLeaseCount: 0,
        threadOwnerCount: 0,
        turnOwnerCount: 0,
        continuationCount: 0
      })

      await provider.shutdown()
      await connection.shutdown()
      expect(connection.getDiagnostics()).toEqual({
        generation: 2,
        physicalConnectionActive: false,
        logicalChannelCount: 0,
        pendingRequestCount: 0,
        activeLeaseCount: 0,
        threadOwnerCount: 0,
        turnOwnerCount: 0,
        continuationCount: 0
      })
    }
  )

  it('C09/C11 preserves completed tool state and emits one error when transport fails mid-tool sequence', async () => {
    const assertC09 = planAssertionsForTest('C09')
    const assertC11 = planAssertionsForTest('C11')
    const commandActions = [
      { type: 'search' as const, command: 'rg test', query: 'test', path: null }
    ]
    const toolStarted = (id: string) =>
      ({
        method: 'item/started',
        params: {
          item: {
            type: 'commandExecution',
            id,
            command: 'rg test',
            cwd: '/repo',
            processId: null,
            status: 'inProgress',
            commandActions,
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null
          },
          threadId: 'thr_1',
          turnId: 'turn_tool_crash'
        }
      }) as JsonRpcMessage
    const firstToolCompleted = {
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'tool-completed',
          command: 'rg test',
          cwd: '/repo',
          processId: '123',
          status: 'completed',
          commandActions,
          aggregatedOutput: 'one completed result',
          exitCode: 0,
          durationMs: 1
        },
        threadId: 'thr_1',
        turnId: 'turn_tool_crash'
      }
    } as JsonRpcMessage
    const transport = new ToolLifecycleCrashTransport([
      toolStarted('tool-completed'),
      firstToolCompleted,
      toolStarted('tool-pending')
    ])
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'run tools' }] }]
    })
    await transport.readyForFailure.promise
    transport.emitError(new Error('connection reset while running tools'))
    transport.emitClose(null, 'SIGTERM')

    const parts = (await readAll(stream)) as Array<{
      type?: string
      toolCallId?: string
      result?: { item?: { id?: string } }
    }>
    await assertC09('terminal 只结算一次且 Composer 恢复', () =>
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1)
    )
    await assertC09('保留可见内容并显示单一终态', () =>
      expect(parts.find((part) => part.type === 'tool-result')?.result?.item?.id).toBe(
        'tool-completed'
      )
    )
    await assertC09('无自动重试、额外请求或迟到事件应用', () =>
      expect(transport.disconnectCalls).toBe(1)
    )
    await assertC11('terminal 只结算一次且 Composer 恢复', () =>
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1)
    )
    await assertC11('保留可见内容并显示单一终态', () =>
      expect(
        parts.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId)
      ).toEqual(['tool-completed', 'tool-pending'])
    )
    await assertC11('无自动重试、额外请求或迟到事件应用', () =>
      expect(transport.disconnectCalls).toBe(1)
    )
  })

  it('C06 preserves reasoning output and emits one error when transport fails during reasoning', async () => {
    const assertC06 = planAssertionsForTest('C06')
    const transport = new ToolLifecycleCrashTransport([
      {
        method: 'item/started',
        params: {
          item: { type: 'reasoning', id: 'reasoning-crash', summary: [], content: [] },
          threadId: 'thr_1',
          turnId: 'turn_tool_crash'
        }
      },
      {
        method: 'item/reasoning/textDelta',
        params: {
          threadId: 'thr_1',
          turnId: 'turn_tool_crash',
          itemId: 'reasoning-crash',
          delta: 'Thinking before the transport fails',
          contentIndex: 0
        }
      }
    ])
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'reason before failing' }] }]
    })
    await transport.readyForFailure.promise
    transport.emitError(new Error('connection reset while reasoning'))
    transport.emitClose(null, 'SIGTERM')

    const parts = (await readAll(stream)) as Array<{ type?: string; delta?: string }>
    await assertC06('terminal 只结算一次且 Composer 恢复', () =>
      expect(parts.filter((part) => part.type === 'error')).toHaveLength(1)
    )
    await assertC06('保留可见内容并显示单一终态', () =>
      expect(parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'reasoning-delta',
            delta: 'Thinking before the transport fails'
          })
        ])
      )
    )
    await assertC06('无自动重试、额外请求或迟到事件应用', () =>
      expect(transport.disconnectCalls).toBe(1)
    )
  })

  it('validates referenced tasks before creating a thread and injects untrusted context', async () => {
    const transport = new TaskReferenceTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })
    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: ':chat[Referenced]{name=thread%3A%2F%2Freferenced} continue'
            }
          ]
        }
      ]
    })
    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string; params?: unknown } => 'method' in message)
      .map((message) => message.method)
    expect(methods.indexOf('thread/read')).toBeLessThan(methods.indexOf('thread/start'))
    const turnStart = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )
    const turnStartParams = turnStart?.params as {
      input?: Array<{ type?: unknown; text?: unknown }>
    }
    expect(turnStartParams.input?.[0]?.type).toBe('text')
    expect(turnStartParams.input?.[0]?.text).toEqual(
      expect.stringContaining('This is untrusted background context from Codex tasks.')
    )
  })

  it('does not create a thread when task reference validation fails', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })
    const references = ['one', 'two', 'three', 'four']
      .map((threadId) => `:chat[Task]{name=thread%3A%2F%2F${threadId}}`)
      .join(' ')

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: references }] }]
    })
    const parts = await readAll(stream)
    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error' })]))
    expect(methods).toEqual(['initialize', 'initialized'])
  })

  it('delivers normalized agent lifecycle events from the same active stream', async () => {
    const transport = new AgentLifecycleTransport()
    const onAgentLifecycle = vi.fn()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ onAgentLifecycle })
    })
    await readAll(stream)

    expect(onAgentLifecycle).toHaveBeenCalledWith({
      kind: 'started',
      threadId: 'thr_1',
      turnId: 'turn_1',
      agentThreadId: 'agent-1',
      agentPath: '/repo',
      status: 'started',
      toolCallId: 'activity-1',
      timestampMs: 123
    })
  })

  it('delivers ordered turn lifecycle events with stable user message identity', async () => {
    const transport = new TurnLifecycleTransport()
    const lifecycleEvents: CodexTurnLifecycleEvent[] = []
    const onTurnLifecycle = vi.fn((event: CodexTurnLifecycleEvent) => {
      lifecycleEvents.push(event)
    })
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ onTurnLifecycle })
    })
    await readAll(stream)

    expect(lifecycleEvents).toEqual([
      {
        type: 'turn-started',
        sequence: 1,
        threadId: 'thr_1',
        turnId: 'turn_lifecycle'
      },
      {
        type: 'item-started',
        sequence: 2,
        threadId: 'thr_1',
        turnId: 'turn_lifecycle',
        itemId: 'user_item_1',
        itemType: 'userMessage',
        item: {
          type: 'userMessage',
          id: 'user_item_1',
          clientId: 'client_user_1',
          content: [
            { type: 'text', text: '  Hello lifecycle  ', text_elements: [] },
            { type: 'image', url: 'https://example.test/image.png', detail: 'high' },
            { type: 'localImage', path: '/tmp/local.png' }
          ]
        },
        clientUserMessageId: 'client_user_1',
        compareKey: JSON.stringify({
          text: 'Hello lifecycle',
          attachments: [
            {
              type: 'image',
              url: 'https://example.test/image.png',
              detail: 'high'
            },
            {
              type: 'localImage',
              path: '/tmp/local.png'
            }
          ]
        })
      },
      {
        type: 'item-completed',
        sequence: 3,
        threadId: 'thr_1',
        turnId: 'turn_lifecycle',
        itemId: 'user_item_1',
        itemType: 'userMessage',
        item: {
          type: 'userMessage',
          id: 'user_item_1',
          clientId: 'client_user_1',
          content: [
            { type: 'text', text: '  Hello lifecycle  ', text_elements: [] },
            { type: 'image', url: 'https://example.test/image.png', detail: 'high' },
            { type: 'localImage', path: '/tmp/local.png' }
          ]
        },
        clientUserMessageId: 'client_user_1',
        compareKey: JSON.stringify({
          text: 'Hello lifecycle',
          attachments: [
            {
              type: 'image',
              url: 'https://example.test/image.png',
              detail: 'high'
            },
            {
              type: 'localImage',
              path: '/tmp/local.png'
            }
          ]
        })
      },
      {
        type: 'turn-completed',
        sequence: 4,
        threadId: 'thr_1',
        turnId: 'turn_lifecycle',
        outcome: 'completed'
      }
    ])
  })

  it('delivers the complete live turn diff to the host callback', async () => {
    const transport = new TurnLifecycleTransport()
    const onTurnDiffUpdated = vi.fn()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ onTurnDiffUpdated })
    })
    await readAll(stream)

    expect(onTurnDiffUpdated).toHaveBeenCalledWith({
      threadId: 'thr_1',
      turnId: 'turn_lifecycle',
      diff: 'diff --git a/final.ts b/final.ts\n+final\n'
    })
  })

  it('delivers sanitized thread settings updates to the host callback', async () => {
    const transport = new ThreadSettingsTransport()
    const onThreadSettingsUpdated = vi.fn()
    const onThreadGoalUpdated = vi.fn()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ onThreadSettingsUpdated, onThreadGoalUpdated })
    })
    await readAll(stream)

    expect(onThreadSettingsUpdated).toHaveBeenCalledWith({
      threadId: 'thr_1',
      modeKind: 'plan',
      cwd: '/repo',
      model: 'gpt-5.5',
      modelProvider: 'openai',
      effort: 'medium',
      summary: null
    })
    expect(onThreadGoalUpdated).toHaveBeenCalledWith({
      threadId: 'thr_1',
      turnId: 'turn_settings',
      goal: {
        threadId: 'thr_1',
        objective: '完成参考实现的功能对齐',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 10,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 2
      }
    })
  })

  it('calls onThreadStarted after thread/start and before the first turn/start', async () => {
    const transport = new ScriptedTransport()
    const events: string[] = []
    const onThreadStarted = vi.fn((thread: { threadId: string; threadPath?: string }) => {
      events.push(`callback:${thread.threadId}`)
      const methods = transport.sentMessages
        .filter((message): message is { method: string } => 'method' in message)
        .map((message) => message.method)
      expect(methods).toEqual(['initialize', 'initialized', 'thread/start'])
    })

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ onThreadStarted })
    })

    await readAll(stream)

    expect(onThreadStarted).toHaveBeenCalledWith({ threadId: 'thr_1' })
    expect(events).toEqual(['callback:thr_1'])
    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
  })

  it('waits for async onThreadStarted work before turn/start', async () => {
    const transport = new ScriptedTransport()
    const callbackBlocker = deferred()
    const events: string[] = []
    const onThreadStarted = vi.fn(async (thread: { threadId: string; threadPath?: string }) => {
      events.push(`callback:${thread.threadId}:start`)
      await callbackBlocker.promise
      events.push(`callback:${thread.threadId}:done`)
    })

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const resultPromise = model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ onThreadStarted })
    })

    await vi.waitFor(() => {
      expect(events).toEqual(['callback:thr_1:start'])
    })

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start'])

    callbackBlocker.resolve()
    const { stream } = await resultPromise
    await readAll(stream)
    expect(events).toEqual(['callback:thr_1:start', 'callback:thr_1:done'])

    const completedMethods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)
    expect(completedMethods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
  })

  it('does not start a turn when onThreadStarted fails', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({
        onThreadStarted: () => {
          throw new Error('queue migration failed')
        }
      })
    })

    const parts = await readAll(stream)
    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(parts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'error' })]))
    expect(methods).toEqual(['initialize', 'initialized', 'thread/start'])
  })

  it('passes configured custom model providers through thread/start config', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      customModelProviders: {
        qwen: {
          name: 'qwen',
          base_url: 'http://127.0.0.1:4010/v1',
          wire_api: 'responses',
          experimental_bearer_token: 'sk-test',
          requires_openai_auth: false,
          request_max_retries: 0,
          stream_max_retries: 0
        }
      }
    })

    const model = provider.languageModel('qwen3.7-plus')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }]
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )

    expect(threadStartMessage?.params).toMatchObject({
      model: 'qwen3.7-plus',
      modelProvider: 'qwen',
      config: {
        model_provider: 'qwen',
        model_providers: {
          qwen: {
            name: 'qwen',
            base_url: 'http://127.0.0.1:4010/v1',
            wire_api: 'responses',
            experimental_bearer_token: 'sk-test',
            requires_openai_auth: false,
            request_max_retries: 0,
            stream_max_retries: 0
          }
        }
      }
    })
  })

  it('passes runtime workspace roots through thread/start and turn/start', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({
        cwd: '/repo',
        runtimeWorkspaceRoots: ['/repo', '/repo/packages/api']
      })
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )
    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(threadStartMessage?.params).toMatchObject({
      cwd: '/repo',
      runtimeWorkspaceRoots: ['/repo', '/repo/packages/api']
    })
    expect(turnStartMessage?.params).toMatchObject({
      cwd: '/repo',
      runtimeWorkspaceRoots: ['/repo', '/repo/packages/api']
    })
  })

  it('registers and selects a remote environment for new threads', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'inspect the remote app' }] }],
      providerOptions: codexCallOptions({
        cwd: '/srv/app',
        remoteEnvironment: {
          environmentId: 'ssh-prod',
          cwd: '/srv/app',
          execServerUrl: 'wss://exec.example.test/codex',
          connectTimeoutMs: 30_000
        }
      })
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)
    expect(methods).toEqual([
      'initialize',
      'initialized',
      'environment/add',
      'thread/start',
      'turn/start'
    ])

    const environmentAdd = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'environment/add'
    )
    expect(environmentAdd?.params).toEqual({
      environmentId: 'ssh-prod',
      execServerUrl: 'wss://exec.example.test/codex',
      connectTimeoutMs: 30_000
    })

    const selectedEnvironment = [{ environmentId: 'ssh-prod', cwd: '/srv/app' }]
    for (const method of ['thread/start', 'turn/start']) {
      const message = transport.sentMessages.find(
        (candidate): candidate is { method: string; params?: unknown } =>
          'method' in candidate && candidate.method === method
      )
      expect(message?.params).toMatchObject({ environments: selectedEnvironment })
    }
  })

  it('marks desktop-scheduled runs as automation threads', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'run the daily report' }] }],
      providerOptions: codexCallOptions({ threadSource: 'automation' })
    })

    await readAll(stream)

    const threadStart = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )
    expect(threadStart?.params).toMatchObject({ threadSource: 'automation' })
  })

  it('resumes an existing thread when providerMetadata carries a threadId', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start'])

    const resumeMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/resume'
    )
    expect(resumeMessage?.params).toMatchObject({
      threadId: 'thr_existing',
      initialTurnsPage: {
        limit: 5,
        itemsView: 'full',
        sortDirection: 'desc'
      }
    })
    expect(resumeMessage?.params).not.toHaveProperty('persistExtendedHistory')

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )
    expect(turnStartMessage?.params).toMatchObject({
      input: [{ type: 'text', text: 'continue', text_elements: [] }]
    })
  })

  it('selects a remote environment on a resumed thread without sending it to thread/resume', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'continue remotely' }] }],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr-existing',
        cwd: '/srv/app',
        remoteEnvironment: {
          environmentId: 'ssh-prod',
          cwd: '/srv/app',
          execServerUrl: 'wss://exec.example.test/codex'
        }
      })
    })

    await readAll(stream)

    const resume = transport.sentMessages.find(
      (message): message is { method: string; params?: Record<string, unknown> } =>
        'method' in message && message.method === 'thread/resume'
    )
    expect(resume?.params).not.toHaveProperty('environments')

    const turnStart = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )
    expect(turnStart?.params).toMatchObject({
      environments: [{ environmentId: 'ssh-prod', cwd: '/srv/app' }]
    })
  })

  it('resumes an existing thread from explicit call options without provider metadata', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr_explicit'
      })
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start'])

    const resumeMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/resume'
    )
    expect(resumeMessage?.params).toMatchObject({ threadId: 'thr_explicit' })
  })

  it('starts a terminal retry in a fresh thread without replaying tool results', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'initial request' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'initial response' }] },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-old-tool',
              toolName: 'old_tool',
              output: { type: 'text', value: 'old tool output must not be replayed' }
            }
          ]
        },
        { role: 'user', content: [{ type: 'text', text: 'retry' }] }
      ],
      providerOptions: codexCallOptions({
        resumeThreadId: 'thr_explicit',
        startFreshTerminalRetry: true
      })
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: { developerInstructions?: string } } =>
        'method' in message && message.method === 'thread/start'
    )
    expect(threadStartMessage?.params?.developerInstructions).toContain('initial request')
    expect(threadStartMessage?.params?.developerInstructions).toContain('initial response')
    expect(threadStartMessage?.params?.developerInstructions).not.toContain('old tool output')
    expect(
      transport.sentMessages.find(
        (message): message is { method: string; params?: { input?: unknown } } =>
          'method' in message && message.method === 'turn/start'
      )?.params?.input
    ).toEqual([{ type: 'text', text: 'retry', text_elements: [] }])
  })

  it('passes runtime workspace roots through thread/resume and turn/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ],
      providerOptions: codexCallOptions({
        cwd: '/repo',
        runtimeWorkspaceRoots: ['/repo']
      })
    })

    await readAll(stream)

    const resumeMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/resume'
    )
    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(resumeMessage?.params).toMatchObject({
      threadId: 'thr_existing',
      cwd: '/repo',
      runtimeWorkspaceRoots: ['/repo']
    })
    expect(turnStartMessage?.params).toMatchObject({
      threadId: 'thr_1',
      cwd: '/repo',
      runtimeWorkspaceRoots: ['/repo']
    })
  })

  it('resumes a thread when threadId is on content-part providerOptions', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Hello',
              providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_content_part' } }
            }
          ]
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start'])

    const resumeMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/resume'
    )
    expect(resumeMessage?.params).toMatchObject({ threadId: 'thr_content_part' })
  })

  it('can compact a resumed thread before turn/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      compaction: { shouldCompactOnResume: true }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/compact/start',
      'turn/start'
    ])
  })

  it('continues when non-strict compaction fails', async () => {
    const transport = new CompactionFailingTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      compaction: { shouldCompactOnResume: true }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/compact/start',
      'turn/start'
    ])
  })

  it('supports callback-based compaction decision with resume context', async () => {
    const transport = new ScriptedTransport()
    const shouldCompactOnResume = vi.fn<(context: unknown) => boolean>(() => true)

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      compaction: { shouldCompactOnResume }
    })

    const model = provider.languageModel('gpt-5.5')

    const prompt: LanguageModelV3CallOptions['prompt'] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] }
    ]

    const { stream } = await model.doStream({ prompt })
    await readAll(stream)

    expect(shouldCompactOnResume).toHaveBeenCalledTimes(1)
    const firstCall = shouldCompactOnResume.mock.calls[0]
    expect(firstCall).toBeDefined()
    const typedCallbackContext = firstCall![0] as {
      threadId: string
      resumeThreadId: string
      resumeResult: { thread: { id: string } }
      prompt: unknown[]
    }
    expect(typedCallbackContext).toMatchObject({
      threadId: 'thr_1',
      resumeThreadId: 'thr_existing',
      resumeResult: { thread: { id: 'thr_1' } }
    })
    expect(typedCallbackContext.prompt).toEqual(prompt)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'thread/compact/start',
      'turn/start'
    ])
  })

  it('skips compaction when callback returns false', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      compaction: { shouldCompactOnResume: () => false }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start'])
  })

  it('continues when callback throws in non-strict mode', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      compaction: {
        shouldCompactOnResume: () => {
          throw new Error('decision failed')
        }
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start'])
  })

  it('fails before turn/start when callback throws in strict mode', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      compaction: {
        shouldCompactOnResume: () => {
          throw new Error('decision failed')
        },
        strict: true
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    const parts = await readAll(stream)
    expect(
      parts.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          (part as { type: string }).type === 'error'
      )
    ).toBe(true)

    const methods = transport.sentMessages
      .filter((message): message is { method: string } => 'method' in message)
      .map((message) => message.method)

    expect(methods).toEqual(['initialize', 'initialized', 'thread/resume'])
  })

  it('passes system messages as developerInstructions on thread/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] }
      ]
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )
    expect(threadStartMessage?.params).toMatchObject({
      developerInstructions: 'Be concise.'
    })

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )
    expect(turnStartMessage?.params).toMatchObject({
      input: [{ type: 'text', text: 'hello', text_elements: [] }]
    })
  })

  it('passes a single desktop app-context unchanged to thread/start and thread/resume', async () => {
    const transport = new ScriptedTransport()
    const developerInstructions = [
      'Preserve these existing instructions.',
      '<app-context>\n# DasCowork desktop context\n\n### Inline Code Comments\n</app-context>'
    ].join('\n\n')
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      experimentalApi: true
    })
    const model = provider.languageModel('gpt-5.5')

    const first = await model.doStream({
      prompt: [
        { role: 'system', content: developerInstructions },
        { role: 'user', content: [{ type: 'text', text: 'start' }] }
      ]
    })
    await readAll(first.stream)

    const resumed = await model.doStream({
      prompt: [
        { role: 'system', content: developerInstructions },
        { role: 'user', content: [{ type: 'text', text: 'start' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_1' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })
    await readAll(resumed.stream)

    const threadStart = transport.sentMessages.find(
      (message): message is { method: string; params?: { developerInstructions?: string } } =>
        'method' in message && message.method === 'thread/start'
    )
    const threadResume = transport.sentMessages.find(
      (message): message is { method: string; params?: { developerInstructions?: string } } =>
        'method' in message && message.method === 'thread/resume'
    )

    expect(threadStart?.params?.developerInstructions).toBe(developerInstructions)
    expect(threadResume?.params?.developerInstructions).toBe(developerInstructions)
    expect(threadResume?.params?.developerInstructions?.match(/<app-context>/gu)).toHaveLength(1)
  })

  it('passes defaultTurnSettings including rich sandboxPolicy on turn/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      defaultTurnSettings: {
        approvalPolicy: 'on-request',
        sandboxPolicy: {
          type: 'externalSandbox',
          networkAccess: 'enabled'
        }
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })

    await readAll(stream)

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(turnStartMessage?.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'externalSandbox',
        networkAccess: 'enabled'
      }
    })
  })

  it('passes the fixed personality option through turn/start', async () => {
    const transport = new ScriptedTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const { stream } = await provider.languageModel('gpt-5.5').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: codexCallOptions({ personality: 'pragmatic' })
    })
    await readAll(stream)

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(turnStartMessage?.params).toMatchObject({ personality: 'pragmatic' })
  })

  it('passes approve-for-me packets through thread/start and turn/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      defaultThreadSettings: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write'
      },
      defaultTurnSettings: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/tmp/project'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )
    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(threadStartMessage?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write'
    })
    expect(turnStartMessage?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/project'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    })
  })

  it('passes full-access packets through thread/start and turn/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      defaultThreadSettings: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access'
      },
      defaultTurnSettings: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' }
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(threadStartMessage?.params).toMatchObject({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access'
    })
    expect(turnStartMessage?.params).toMatchObject({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
  })

  it('passes per-call ephemeral through thread/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: {
        [CODEX_PROVIDER_ID]: {
          ephemeral: true
        }
      }
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )

    expect(threadStartMessage?.params).toMatchObject({
      ephemeral: true
    })
  })

  it('passes request-approval override when resuming from full-access defaults', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      defaultThreadSettings: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access'
      },
      defaultTurnSettings: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' }
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ],
      providerOptions: codexCallOptions({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: ['/tmp/project'],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      })
    })

    await readAll(stream)

    const threadResumeMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/resume'
    )
    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(threadResumeMessage?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write'
    })
    expect(turnStartMessage?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/project'],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    })
  })

  it('forwards responseFormat JSON schema to turn/start outputSchema', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })

    const model = provider.languageModel('gpt-5.5')

    const schema = {
      type: 'object' as const,
      properties: {
        answer: { type: 'string' as const },
        confidence: { type: 'number' as const }
      },
      required: ['answer'],
      additionalProperties: false
    }

    const outputSchema: unknown = JSON.parse(JSON.stringify(schema))

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      responseFormat: {
        type: 'json',
        schema
      }
    })

    await readAll(stream)

    const turnStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/start'
    )

    expect(turnStartMessage?.params).toMatchObject({
      outputSchema
    })
  })

  it('forwards mcpServers as config on thread/start', async () => {
    const transport = new ScriptedTransport()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      mcpServers: {
        filesystem: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
        }
      }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })

    await readAll(stream)

    const threadStartMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'thread/start'
    )

    expect(threadStartMessage?.params).toMatchObject({
      config: {
        mcp_servers: {
          filesystem: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']
          }
        }
      }
    })
  })

  it('emits debug events through the logger when logPackets is enabled', async () => {
    const transport = new ScriptedTransport()
    const loggerSpy = vi.fn()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      debug: { logPackets: true, logger: loggerSpy }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    })

    await readAll(stream)

    const debugEvents = loggerSpy.mock.calls
      .map((call: unknown[]) => call[0] as { direction: string; message: unknown })
      .filter(
        (packet) =>
          typeof packet.message === 'object' && packet.message !== null && 'debug' in packet.message
      )

    const debugLabels = debugEvents.map((e) => (e.message as { debug: string }).debug)

    expect(debugLabels).toContain('prompt')
    expect(debugLabels).toContain('extractResumeThreadId')
    expect(debugLabels).toContain('thread/start')
    expect(debugLabels).toContain('turn/start')

    const promptEvent = debugEvents.find((e) => (e.message as { debug: string }).debug === 'prompt')
    expect(promptEvent?.direction).toBe('inbound')

    const extractEvent = debugEvents.find(
      (e) => (e.message as { debug: string }).debug === 'extractResumeThreadId'
    )
    expect(extractEvent?.direction).toBe('inbound')
    expect((extractEvent?.message as { data: unknown }).data).toEqual({
      resumeThreadId: undefined
    })

    const threadStartEvent = debugEvents.find(
      (e) => (e.message as { debug: string }).debug === 'thread/start'
    )
    expect(threadStartEvent?.direction).toBe('outbound')

    const turnStartEvent = debugEvents.find(
      (e) => (e.message as { debug: string }).debug === 'turn/start'
    )
    expect(turnStartEvent?.direction).toBe('outbound')
    expect((turnStartEvent?.message as { data: { threadId: string } }).data).toMatchObject({
      threadId: 'thr_1'
    })
  })

  it('emits thread/resume debug event when resuming a thread', async () => {
    const transport = new ScriptedTransport()
    const loggerSpy = vi.fn()

    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      debug: { logPackets: true, logger: loggerSpy }
    })

    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
          providerOptions: { [CODEX_PROVIDER_ID]: { threadId: 'thr_existing' } }
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] }
      ]
    })

    await readAll(stream)

    const debugEvents = loggerSpy.mock.calls
      .map((call: unknown[]) => call[0] as { direction: string; message: unknown })
      .filter(
        (packet) =>
          typeof packet.message === 'object' && packet.message !== null && 'debug' in packet.message
      )

    const debugLabels = debugEvents.map((e) => (e.message as { debug: string }).debug)

    expect(debugLabels).toContain('extractResumeThreadId')
    expect(debugLabels).toContain('thread/resume')
    expect(debugLabels).not.toContain('thread/start')

    const extractEvent = debugEvents.find(
      (e) => (e.message as { debug: string }).debug === 'extractResumeThreadId'
    )
    expect((extractEvent?.message as { data: unknown }).data).toEqual({
      resumeThreadId: 'thr_existing'
    })

    const resumeEvent = debugEvents.find(
      (e) => (e.message as { debug: string }).debug === 'thread/resume'
    )
    expect(resumeEvent?.direction).toBe('outbound')
    expect((resumeEvent?.message as { data: { threadId: string } }).data).toMatchObject({
      threadId: 'thr_existing'
    })
  })

  it('keeps the stream open until canonical interruption after abortSignal', async () => {
    const transport = new InterruptAwareTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })
    const model = provider.languageModel('gpt-5.5')
    const abortController = new AbortController()

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'interrupt me' }] }],
      abortSignal: abortController.signal
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    abortController.abort()

    await readAll(stream)

    const interruptMessage = transport.sentMessages.find(
      (message): message is { method: string; params?: unknown } =>
        'method' in message && message.method === 'turn/interrupt'
    )
    expect(interruptMessage).toBeDefined()
    expect(interruptMessage?.params).toMatchObject({
      threadId: 'thr_abort',
      turnId: 'turn_abort'
    })
  })

  it('shares one interrupt RPC between a session stop and AbortSignal', async () => {
    const transport = new InterruptAwareTransport()
    const abortController = new AbortController()
    let manualInterrupt: Promise<void> | undefined
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' },
      onSessionCreated: (session) => {
        manualInterrupt = session.interrupt()
        abortController.abort()
      }
    })
    const model = provider.languageModel('gpt-5.5')

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'interrupt me' }] }],
      abortSignal: abortController.signal
    })

    await readAll(stream)
    await manualInterrupt

    expect(
      transport.sentMessages.filter(
        (message) => 'method' in message && message.method === 'turn/interrupt'
      )
    ).toHaveLength(1)
  })

  it('does not synthesize an AbortError before canonical interruption settles', async () => {
    let interruptResolved = false

    // Delay the interrupt acknowledgement and canonical terminal notification. The
    // consumer must remain subscribed rather than receiving a locally inferred AbortError.
    class DelayedInterruptTransport extends InterruptAwareTransport {
      override async sendMessage(message: JsonRpcMessage): Promise<void> {
        if ('method' in message && message.method === 'turn/interrupt') {
          await MockTransport.prototype.sendMessage.call(this, message)
          setTimeout(() => {
            interruptResolved = true
            this.emitMessage({ id: (message as { id: string | number }).id, result: {} })
            this.emitMessage({
              method: 'turn/completed',
              params: {
                threadId: 'thr_abort',
                turn: { id: 'turn_abort', items: [], status: 'interrupted', error: null }
              }
            })
          }, 200)
          return
        }

        await super.sendMessage(message)
      }
    }

    const transport = new DelayedInterruptTransport()
    const provider = createCodexAppServer({
      transportFactory: () => transport,
      clientInfo: { name: 'test-client', version: '1.0.0' }
    })
    const model = provider.languageModel('gpt-5.5')
    const abortController = new AbortController()

    const { stream } = await model.doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'interrupt me' }] }],
      abortSignal: abortController.signal
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    abortController.abort()

    const parts = (await readAll(stream)) as Array<{ type?: string; error?: unknown }>

    expect(interruptResolved).toBe(true)
    expect(parts.find((part) => part.type === 'error')).toBeUndefined()
    expect(parts.find((part) => part.type === 'finish')).toBeDefined()
    expect(interruptResolved).toBe(true)

    const interruptMessage = transport.sentMessages.find(
      (message): message is { method: string } =>
        'method' in message && message.method === 'turn/interrupt'
    )
    expect(interruptMessage).toBeDefined()
  })
})
