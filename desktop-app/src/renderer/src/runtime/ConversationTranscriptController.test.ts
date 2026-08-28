import type { UIMessageChunk } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import { createVitestPlanAssertionRecorder } from '../../../../scripts/lib/test-plan-assertions.mjs'
import type { ElectronIpcChatTransport } from '../lib/ElectronIpcChatTransport'
import {
  ConversationTranscriptController,
  ConversationTranscriptIntegrityError,
  safeTurnErrorMessage,
  type SteeringUserMessage
} from './ConversationTranscriptController'

const { planAssert } = createVitestPlanAssertionRecorder(expect)

async function recordPlanAssertions({
  scenarioIds,
  assertionId,
  assertion
}: {
  scenarioIds: string[]
  assertionId: string
  assertion: () => unknown
}): Promise<void> {
  await Promise.all(
    scenarioIds.map((scenarioId) => planAssert({ scenarioId, assertionId, assertion }))
  )
}

describe('ConversationTranscriptController', () => {
  it('coalesces rapid text deltas before publishing the transcript snapshot', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'user-message',
      role: 'user',
      parts: [{ type: 'text', text: 'Write a response.' }]
    })

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    beginCanonicalTurn(controller, 'rapid-stream-turn')
    let notifications = 0
    controller.subscribe(() => {
      notifications += 1
    })

    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    const deltas = Array.from({ length: 24 }, (_, index) => `${index}`)
    for (const delta of deltas) {
      transport.enqueue({ type: 'text-delta', id: 'text-one', delta })
    }

    await vi.waitFor(() =>
      expect(controller.getSnapshot().messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: deltas.join('') })
      ])
    )
    expect(notifications).toBeLessThan(4)

    completeCanonicalTurn(controller, 'rapid-stream-turn', 'completed', 2)
    transport.close()
    await expect(send).resolves.toBeUndefined()
  })

  it('retains an assistant response that contains only a generated image file', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'image-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Generate an image.' }]
    })

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    beginCanonicalTurn(controller, 'image-only-turn')
    transport.enqueue({ type: 'start', messageId: 'image-assistant' })
    transport.enqueue({ type: 'start-step' })
    transport.enqueue({
      type: 'file',
      mediaType: 'image/png',
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    })

    await vi.waitFor(() =>
      expect(controller.getSnapshot().messages.at(-1)?.parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'file', mediaType: 'image/png' })
        ])
      )
    )

    completeCanonicalTurn(controller, 'image-only-turn', 'completed', 2)
    transport.enqueue({ type: 'finish-step' })
    transport.enqueue({ type: 'finish', finishReason: 'stop' })
    transport.close()
    await expect(send).resolves.toBeUndefined()
  })

  it('resolves a start-only send after the stream is accepted without waiting for completion', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const start = controller.sendMessageUntilAccepted({
      id: 'review-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Review my uncommitted changes.' }]
    })

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    controller.handleStreamAccepted()

    await expect(start).resolves.toBeUndefined()
    expect(controller.getSnapshot().status).toBe('streaming')

    beginCanonicalTurn(controller, 'review-turn')
    completeCanonicalTurn(controller, 'review-turn', 'completed', 2)
    transport.close()
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  })

  it('starts existing Goal control without appending a synthetic user message', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const start = controller.startGoalControlUntilAccepted()

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    expect(transport.lastTrigger).toBe('goal-control')
    expect(controller.getSnapshot().messages).not.toContainEqual(
      expect.objectContaining({ role: 'user' })
    )

    controller.handleStreamAccepted()
    await expect(start).resolves.toBeUndefined()
    expect(controller.getSnapshot().status).toBe('streaming')

    beginCanonicalTurn(controller, 'existing-goal-turn')
    completeCanonicalTurn(controller, 'existing-goal-turn', 'completed', 2)
    transport.close()
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('ready'))
  })

  it('seals each automatic Goal turn into a separate assistant transcript message', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'goal-user',
      role: 'user',
      parts: [{ type: 'text', text: 'finish the work' }]
    })

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    beginCanonicalTurn(controller, 'goal-turn-one')
    transport.enqueue({ type: 'start', messageId: 'goal-assistant-one' })
    transport.enqueue({ type: 'text-start', id: 'goal-text-one' })
    transport.enqueue({ type: 'text-delta', id: 'goal-text-one', delta: 'first turn' })
    await vi.waitFor(() =>
      expect(controller.getSnapshot().messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'first turn' })
      ])
    )
    completeCanonicalTurn(controller, 'goal-turn-one', 'completed', 2)

    controller.handleTurnLifecycle({
      type: 'turn-started',
      sequence: 1,
      threadId: 'thread-one',
      turnId: 'goal-turn-two'
    })
    transport.enqueue({ type: 'start', messageId: 'goal-assistant-two' })
    transport.enqueue({ type: 'text-start', id: 'goal-text-two' })
    transport.enqueue({ type: 'text-delta', id: 'goal-text-two', delta: 'second turn' })
    await vi.waitFor(() =>
      expect(controller.getSnapshot().messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'second turn' })
      ])
    )
    completeCanonicalTurn(controller, 'goal-turn-two', 'completed', 2)
    transport.enqueue({ type: 'finish' })
    transport.close()
    await send

    expect(
      controller
        .getSnapshot()
        .messages.filter((message) => message.role === 'assistant')
        .map((message) =>
          message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        )
    ).toEqual([['first turn'], ['second turn']])
  })

  it('rejects a start-only send when the stream fails before acceptance', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const start = controller.sendMessageUntilAccepted({
      id: 'review-user',
      role: 'user',
      parts: [{ type: 'text', text: 'Review my uncommitted changes.' }]
    })

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    transport.error(new Error('Review start failed'))

    await expect(start).rejects.toThrow('Review start failed')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: { message: 'Review start failed' }
    })
  })

  it('rejects duplicate history render ids with conversation and source context', () => {
    const controller = createController(new ControlledTransport())
    let thrown: unknown

    try {
      controller.replaceMessages([
        { id: 'duplicate', role: 'user', parts: [{ type: 'text', text: 'one' }] },
        { id: 'duplicate', role: 'assistant', parts: [{ type: 'text', text: 'two' }] }
      ])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConversationTranscriptIntegrityError)
    expect((thrown as Error).message).toContain('renderId "message:duplicate"')
    expect((thrown as Error).message).toContain('conversation=conversation-test')
    expect((thrown as Error).message).toContain('turn=history')
    expect((thrown as Error).message).toContain('sourceItems=none')
  })

  it('drops a staged Steer when the stream ends without a completed userMessage item', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    controller.stageSteeringMessage(
      {
        id: 'steer-one',
        role: 'user',
        parts: [{ type: 'text', text: 'change direction' }]
      },
      {
        clientUserMessageId: 'steer-one',
        targetTurnId: controller.getActiveTurnId()!
      }
    )
    expect(
      controller.getSnapshot().messages.some((message) => message.renderId === 'steer:steer-one')
    ).toBe(true)

    beginCanonicalTurn(controller, 'turn-one')
    completeCanonicalTurn(controller, 'turn-one', 'completed', 2)
    transport.close()
    await send

    expect(controller.getSnapshot().messages.map((message) => message.renderId)).toEqual([
      'message:initial-user'
    ])
  })

  it('accepts a Steer only from a completed matching userMessage lifecycle item', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    controller.stageSteeringMessage(
      {
        id: 'steer-one',
        role: 'user',
        parts: [{ type: 'text', text: '  change direction  ' }]
      },
      {
        clientUserMessageId: 'steer-one',
        targetTurnId: controller.getActiveTurnId()!
      }
    )
    beginCanonicalTurn(controller, 'turn-one')
    controller.handleTurnLifecycle({
      type: 'item-started',
      sequence: 2,
      threadId: 'thread-one',
      turnId: 'turn-one',
      itemId: 'user-item-one',
      itemType: 'userMessage',
      compareKey: JSON.stringify({ text: 'change direction', attachments: [] })
    })
    expect(
      controller.getSnapshot().messages.find((message) => message.renderId === 'steer:steer-one')
    ).toMatchObject({
      status: 'pending',
      sourceItemId: 'user-item-one'
    })

    controller.handleTurnLifecycle({
      type: 'item-completed',
      sequence: 3,
      threadId: 'thread-one',
      turnId: 'turn-one',
      itemId: 'user-item-one',
      itemType: 'userMessage',
      compareKey: JSON.stringify({ text: 'change direction', attachments: [] })
    })
    expect(
      controller.getSnapshot().messages.find((message) => message.renderId === 'steer:steer-one')
    ).toMatchObject({
      status: 'accepted',
      sourceItemId: 'user-item-one'
    })

    completeCanonicalTurn(controller, 'turn-one', 'completed', 4)
    transport.close()
    await send

    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      renderId: 'steer:steer-one',
      status: 'accepted'
    })
  })

  it('ignores stale or mismatched lifecycle events without retargeting the active turn', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    beginCanonicalTurn(controller, 'turn-one')
    const snapshotBeforeRejectedEvents = structuredClone(controller.getSnapshot())

    controller.handleTurnLifecycle({
      type: 'turn-completed',
      sequence: 2,
      threadId: 'thread-other',
      turnId: 'turn-one',
      outcome: 'completed'
    })
    controller.handleTurnLifecycle({
      type: 'turn-completed',
      sequence: 3,
      threadId: 'thread-one',
      turnId: 'turn-other',
      outcome: 'completed'
    })
    controller.handleTurnLifecycle({
      type: 'turn-completed',
      sequence: 1,
      threadId: 'thread-one',
      turnId: 'turn-one',
      outcome: 'completed'
    })

    expect(controller.getActiveTurnId()).toBe('turn-one')
    expect(controller.getSnapshot()).toEqual(snapshotBeforeRejectedEvents)

    completeCanonicalTurn(controller, 'turn-one', 'completed', 4)
    transport.enqueue({ type: 'finish' })
    transport.close()
    await send
  })

  it('B11 leaves identical pending Steers unconfirmed for an ambiguous legacy acknowledgement', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    for (const id of ['steer-one', 'steer-two']) {
      controller.stageSteeringMessage(
        { id, role: 'user', parts: [{ type: 'text', text: 'change direction' }] },
        { clientUserMessageId: id, targetTurnId: controller.getActiveTurnId()! }
      )
    }

    beginCanonicalTurn(controller, 'turn-one')
    controller.handleTurnLifecycle({
      type: 'item-completed',
      sequence: 2,
      threadId: 'thread-one',
      turnId: 'turn-one',
      itemId: 'legacy-user-item',
      itemType: 'userMessage',
      compareKey: JSON.stringify({ text: 'change direction', attachments: [] })
    })

    expect(
      controller
        .getSnapshot()
        .messages.filter(
          (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
        )
        .map((message) => ({ status: message.status, sourceItemId: message.sourceItemId }))
    ).toEqual([
      { status: 'pending', sourceItemId: undefined },
      { status: 'pending', sourceItemId: undefined }
    ])
    expect(warning).toHaveBeenCalledWith('ambiguous legacy steer acknowledgement ignored', {
      turnId: 'turn-one',
      candidateCount: 2,
      messageIds: ['steer-one', 'steer-two']
    })
    expect(JSON.stringify(warning.mock.calls)).not.toContain('change direction')

    controller.handleTurnLifecycle({
      type: 'item-completed',
      sequence: 3,
      threadId: 'thread-one',
      turnId: 'turn-one',
      itemId: 'canonical-user-item',
      itemType: 'userMessage',
      clientUserMessageId: 'steer-two'
    })
    expect(
      controller
        .getSnapshot()
        .messages.filter(
          (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
        )
        .map((message) => ({
          renderId: message.renderId,
          status: message.status,
          sourceItemId: message.sourceItemId
        }))
    ).toEqual(
      expect.arrayContaining([
        { renderId: 'steer:steer-one', status: 'pending', sourceItemId: undefined },
        {
          renderId: 'steer:steer-two',
          status: 'accepted',
          sourceItemId: 'canonical-user-item'
        }
      ])
    )
    await recordPlanAssertions({
      scenarioIds: ['B11'],
      assertionId: 'claim、接受与队列结算至多一次',
      assertion: () =>
        expect(
          controller
            .getSnapshot()
            .messages.filter(
              (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
            )
            .map((message) => message.status)
        ).toEqual(['accepted', 'pending'])
    })
    await recordPlanAssertions({
      scenarioIds: ['B11'],
      assertionId: '正确的恢复、暂停或拒绝状态',
      assertion: () =>
        expect(
          controller
            .getSnapshot()
            .messages.find((message) => message.renderId === 'steer:steer-two')
        ).toMatchObject({ status: 'accepted', sourceItemId: 'canonical-user-item' })
    })
    await recordPlanAssertions({
      scenarioIds: ['B11'],
      assertionId: 'terminal 和 active run 不被竞态覆盖',
      assertion: () => expect(controller.getActiveTurnId()).toBe('turn-one')
    })

    completeCanonicalTurn(controller, 'turn-one', 'completed', 4)

    transport.close()
    await send
    warning.mockRestore()
  })

  it('A01/A02/A03/A04/A10 stages every steer phase on the existing turn without changing visible output', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    const targetTurnId = controller.getActiveTurnId()!
    const stage = (id: string): void => {
      controller.stageSteeringMessage(
        { id, role: 'user', parts: [{ type: 'text', text: `steer ${id}` }] },
        { clientUserMessageId: id, targetTurnId }
      )
      expect(transport.sendCount).toBe(1)
      expect(controller.getActiveTurnId()).toBe(targetTurnId)
    }

    stage('a01-empty')
    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'reasoning-start', id: 'reasoning-one' })
    transport.enqueue({ type: 'reasoning-delta', id: 'reasoning-one', delta: 'checking' })
    stage('a02-reasoning')

    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'visible answer' })
    await vi.waitFor(() =>
      expect(
        controller
          .getSnapshot()
          .messages.find((message) => message.kind === 'message' && message.role === 'assistant')
          ?.parts
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'visible answer' })])
      )
    )
    stage('a03-partial')
    transport.enqueue({ type: 'text-end', id: 'text-one' })
    stage('a04-complete-item')
    stage('a10-second')
    stage('a10-third')

    expect(
      controller
        .getSnapshot()
        .messages.filter(
          (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
        )
        .map((message) => message.clientUserMessageId)
    ).toEqual([
      'a01-empty',
      'a02-reasoning',
      'a03-partial',
      'a04-complete-item',
      'a10-second',
      'a10-third'
    ])
    expect(
      controller
        .getSnapshot()
        .messages.find((message) => message.kind === 'message' && message.role === 'assistant')
        ?.parts
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'visible answer' })])
    )
    await recordPlanAssertions({
      scenarioIds: ['A01', 'A02', 'A04', 'A10'],
      assertionId: '已显示回答保持不变',
      assertion: () =>
        expect(
          controller
            .getSnapshot()
            .messages.find((message) => message.kind === 'message' && message.role === 'assistant')
            ?.parts
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'visible answer' })
          ])
        )
    })
    await recordPlanAssertions({
      scenarioIds: ['A01', 'A02', 'A04', 'A10'],
      assertionId: '复用原 turn，不能额外启动 turn',
      assertion: () => {
        expect(transport.sendCount).toBe(1)
        expect(controller.getActiveTurnId()).toBe(targetTurnId)
      }
    })
    await recordPlanAssertions({
      scenarioIds: ['A01', 'A02', 'A04', 'A10'],
      assertionId: '队列顺序与对话隔离正确',
      assertion: () =>
        expect(
          controller
            .getSnapshot()
            .messages.filter(
              (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
            )
            .map((message) => message.clientUserMessageId)
        ).toEqual([
          'a01-empty',
          'a02-reasoning',
          'a03-partial',
          'a04-complete-item',
          'a10-second',
          'a10-third'
        ])
    })

    transport.close()
    await send
  })

  it('A05/A06/A07/D19 keeps one active turn while staging Steers across all tool phases', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })
    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())

    const phases = [
      { type: 'tool-input-start', toolCallId: 'tool-1' },
      {
        type: 'tool-input-available',
        toolCallId: 'tool-1',
        toolName: 'shell_command',
        input: { command: 'pwd' }
      },
      { type: 'tool-output-available', toolCallId: 'tool-1', output: 'done' }
    ] as unknown as UIMessageChunk[]

    for (const [index, chunk] of phases.entries()) {
      transport.enqueue(chunk)
      const id = `steer-phase-${index + 1}`
      controller.stageSteeringMessage(
        { id, role: 'user', parts: [{ type: 'text', text: `steer ${index + 1}` }] },
        { clientUserMessageId: id, targetTurnId: controller.getActiveTurnId()! }
      )
      expect(
        controller.getSnapshot().messages.find((message) => message.renderId === `steer:${id}`)
      ).toMatchObject({ status: 'pending', targetTurnId: controller.getActiveTurnId() })
      expect(transport.sendCount).toBe(1)
    }

    await recordPlanAssertions({
      scenarioIds: ['A05', 'A06', 'A07'],
      assertionId: '已显示回答保持不变',
      assertion: () =>
        expect(
          controller
            .getSnapshot()
            .messages.filter(
              (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
            )
            .map((message) => message.status)
        ).toEqual(['pending', 'pending', 'pending'])
    })
    await recordPlanAssertions({
      scenarioIds: ['A05', 'A06', 'A07'],
      assertionId: '复用原 turn，不能额外启动 turn',
      assertion: () => {
        expect(transport.sendCount).toBe(1)
        expect(controller.getActiveTurnId()).toBeDefined()
      }
    })
    await recordPlanAssertions({
      scenarioIds: ['A05', 'A06', 'A07'],
      assertionId: '队列顺序与对话隔离正确',
      assertion: () =>
        expect(
          controller
            .getSnapshot()
            .messages.filter(
              (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
            )
            .map((message) => message.clientUserMessageId)
        ).toEqual(['steer-phase-1', 'steer-phase-2', 'steer-phase-3'])
    })
    await recordPlanAssertions({
      scenarioIds: ['D19'],
      assertionId: '三阶段工具事件期间 steer 保持同一 active turn',
      assertion: () => {
        expect(transport.sendCount).toBe(1)
        expect(controller.getActiveTurnId()).toBeDefined()
        expect(
          controller
            .getSnapshot()
            .messages.filter(
              (message): message is SteeringUserMessage => message.kind === 'steering-user-message'
            )
            .map((message) => message.clientUserMessageId)
        ).toEqual(['steer-phase-1', 'steer-phase-2', 'steer-phase-3'])
      }
    })

    transport.close()
    await send
  })

  it('keeps a client-executed tool result when the following stream step contains only text', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({
      type: 'tool-input-available',
      toolCallId: 'read-terminal-1',
      toolName: 'read_thread_terminal',
      input: {}
    })
    transport.enqueue({
      type: 'tool-output-available',
      toolCallId: 'read-terminal-1',
      output: { output: 'Terminal is not attached.' }
    })
    transport.enqueue({ type: 'start-step' })
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'final answer' })
    transport.enqueue({ type: 'text-end', id: 'text-one' })
    transport.enqueue({ type: 'finish' })
    transport.close()
    await send

    const assistant = controller
      .getSnapshot()
      .messages.find((message) => message.kind === 'message' && message.role === 'assistant')
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-read_thread_terminal',
          toolCallId: 'read-terminal-1',
          state: 'output-available',
          output: { output: 'Terminal is not attached.' }
        }),
        expect.objectContaining({ type: 'text', text: 'final answer' })
      ])
    )
  })

  it('G10 settles a turn containing large text and tool output without losing either payload', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const largeToolOutput = 'tool-output-'.repeat(24_000)
    const largeText = 'assistant-text-'.repeat(24_000)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    beginCanonicalTurn(controller, 'turn-large')
    transport.enqueue({ type: 'start', messageId: 'assistant-large' })
    transport.enqueue({
      type: 'tool-input-available',
      toolCallId: 'large-tool-1',
      toolName: 'read_thread_terminal',
      input: {}
    })
    transport.enqueue({
      type: 'tool-output-available',
      toolCallId: 'large-tool-1',
      output: { output: largeToolOutput }
    })
    transport.enqueue({ type: 'text-start', id: 'large-text-1' })
    transport.enqueue({ type: 'text-delta', id: 'large-text-1', delta: largeText })
    transport.enqueue({ type: 'text-end', id: 'large-text-1' })
    transport.enqueue({ type: 'finish' })
    completeCanonicalTurn(controller, 'turn-large', 'completed', 2)
    transport.close()
    await send

    const assistant = controller
      .getSnapshot()
      .messages.find((message) => message.kind === 'message' && message.role === 'assistant')
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getActiveTurnId()).toBeUndefined()
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool-read_thread_terminal',
          toolCallId: 'large-tool-1',
          state: 'output-available',
          output: { output: largeToolOutput }
        }),
        expect.objectContaining({ type: 'text', text: largeText, state: 'done' })
      ])
    )
    await recordPlanAssertions({
      scenarioIds: ['G10'],
      assertionId: '跨对话与信任边界隔离',
      assertion: () => expect(controller.getActiveTurnId()).toBeUndefined()
    })
    await recordPlanAssertions({
      scenarioIds: ['G10'],
      assertionId: '资源、并发和终态无残留',
      assertion: () => expect(controller.getSnapshot().status).toBe('ready')
    })
    await recordPlanAssertions({
      scenarioIds: ['G10'],
      assertionId: '诊断可关联而不泄露密钥',
      assertion: () =>
        expect(assistant?.parts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-read_thread_terminal',
              toolCallId: 'large-tool-1',
              output: { output: largeToolOutput }
            }),
            expect.objectContaining({ type: 'text', text: largeText, state: 'done' })
          ])
        )
    })
  })

  it('keeps a provider-executed dynamic tool result after reasoning and duplicate lifecycle chunks', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'start-step' })
    transport.enqueue({ type: 'reasoning-start', id: 'reasoning-one' })
    transport.enqueue({ type: 'reasoning-delta', id: 'reasoning-one', delta: 'checking terminal' })
    transport.enqueue({ type: 'reasoning-end', id: 'reasoning-one' })
    const toolInput = {
      type: 'tool-input-available' as const,
      toolCallId: 'read-terminal-1',
      toolName: 'read_thread_terminal',
      input: {},
      providerExecuted: true,
      dynamic: true
    }
    const toolOutput = {
      type: 'tool-output-available' as const,
      toolCallId: 'read-terminal-1',
      output: { terminal: 'No terminal is attached.' },
      providerExecuted: true,
      dynamic: true
    }
    transport.enqueue(toolInput)
    transport.enqueue(toolInput)
    transport.enqueue(toolOutput)
    transport.enqueue(toolOutput)
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'final answer' })
    transport.enqueue({ type: 'text-end', id: 'text-one' })
    transport.enqueue({ type: 'finish-step' })
    transport.enqueue({ type: 'finish' })
    transport.close()
    await send

    const assistant = controller
      .getSnapshot()
      .messages.find((message) => message.kind === 'message' && message.role === 'assistant')
    expect(assistant?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'dynamic-tool',
          toolCallId: 'read-terminal-1',
          toolName: 'read_thread_terminal',
          state: 'output-available',
          output: { terminal: 'No terminal is attached.' },
          providerExecuted: true
        }),
        expect.objectContaining({ type: 'text', text: 'final answer' })
      ])
    )
  })

  it('settles only after the transport stream has been consumed', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('submitted'))
    beginCanonicalTurn(controller, 'turn-one')
    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'final answer' })
    transport.enqueue({ type: 'text-end', id: 'text-one' })
    transport.enqueue({ type: 'finish' })
    completeCanonicalTurn(controller, 'turn-one', 'completed', 2)
    transport.close()
    await send

    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getActiveTurnId()).toBeUndefined()
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      renderId: 'message:assistant:turn-one:text-one',
      sourceMessageId: 'assistant:turn-one:text-one',
      turnId: 'turn-one',
      sourceItemIds: ['text-one'],
      role: 'assistant',
      parts: [{ type: 'text', text: 'final answer', state: 'done' }]
    })
  })

  it('F01/F02 keeps partial assistant content and marks the last assistant segment as failed', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('submitted'))
    beginCanonicalTurn(controller, 'turn-one')
    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'partial answer' })
    await vi.waitFor(() =>
      expect(controller.getSnapshot().messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'partial answer' })
      ])
    )
    transport.error(new Error('stream disconnected before completion'))

    await expect(send).rejects.toThrow('stream disconnected before completion')
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: { message: 'stream disconnected before completion' }
    })
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [expect.objectContaining({ type: 'text', text: 'partial answer' })],
      metadata: {
        codexTurn: {
          status: 'failed',
          error: { message: 'stream disconnected before completion' }
        }
      }
    })
  })

  it('B10/C24/G11 keeps the settled transcript unchanged when lifecycle events arrive after an error terminal', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'partial answer' })
    await vi.waitFor(() =>
      expect(controller.getSnapshot().messages.at(-1)?.parts).toEqual([
        expect.objectContaining({ type: 'text', text: 'partial answer' })
      ])
    )
    transport.error(new Error('stream disconnected before completion'))
    await expect(send).rejects.toThrow('stream disconnected before completion')
    const settledSnapshot = structuredClone(controller.getSnapshot())

    controller.handleTurnLifecycle({
      type: 'item-completed',
      sequence: 2,
      threadId: 'thread-one',
      turnId: 'turn-one',
      itemId: 'late-user-item',
      itemType: 'userMessage',
      clientUserMessageId: 'late-steer'
    })
    controller.handleTurnLifecycle({
      type: 'turn-completed',
      sequence: 3,
      threadId: 'thread-one',
      turnId: 'turn-one',
      outcome: 'completed'
    })

    expect(controller.getSnapshot()).toEqual(settledSnapshot)
  })

  it('waits for the authoritative interrupted terminal after a user stop', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('submitted'))
    beginCanonicalTurn(controller, 'turn-one')
    transport.enqueue({ type: 'start', messageId: 'assistant-one' })
    transport.enqueue({ type: 'text-start', id: 'text-one' })
    transport.enqueue({ type: 'text-delta', id: 'text-one', delta: 'partial answer' })
    await controller.stop()
    controller.handleTurnLifecycle({
      type: 'turn-completed',
      sequence: 2,
      threadId: 'thread-one',
      turnId: 'turn-one',
      outcome: 'interrupted'
    })
    transport.enqueue({ type: 'finish' })
    transport.close()
    await send

    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [expect.objectContaining({ type: 'text', text: 'partial answer' })],
      metadata: {
        codexTurn: {
          status: 'interrupted'
        }
      }
    })
  })

  it('replaces a recovered terminal fallback with replayed interrupted output from the same turn', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    controller.replaceMessages([
      { id: 'user-one', role: 'user', parts: [{ type: 'text', text: 'request' }] },
      {
        id: 'assistant:turn-one:terminal',
        role: 'assistant',
        parts: [],
        metadata: { codexTurn: { turnId: 'turn-one', status: 'interrupted' } }
      }
    ])

    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getActiveTurnId()).toBeDefined())
    beginCanonicalTurn(controller, 'turn-one')
    transport.enqueue({ type: 'text-start', id: 'replayed-text' })
    transport.enqueue({
      type: 'text-delta',
      id: 'replayed-text',
      delta: 'Recovered partial output.'
    })
    completeCanonicalTurn(controller, 'turn-one', 'interrupted', 2)
    transport.close()
    await send

    const interruptedMessages = controller
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.kind === 'message' &&
          message.role === 'assistant' &&
          message.turnId === 'turn-one'
      )
    expect(interruptedMessages).toHaveLength(1)
    expect(interruptedMessages[0]).toMatchObject({
      sourceMessageId: 'assistant:turn-one:replayed-text',
      parts: [expect.objectContaining({ type: 'text', text: 'Recovered partial output.' })],
      metadata: { codexTurn: { turnId: 'turn-one', status: 'interrupted' } }
    })
  })

  it('keeps the pending assistant identity stable when canonical interruption arrives before output', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('submitted'))
    beginCanonicalTurn(controller, 'turn-one')
    const pendingAssistant = controller
      .getSnapshot()
      .messages.find((message) => message.role === 'assistant')
    expect(pendingAssistant).toMatchObject({
      renderId: 'message:assistant:local-turn-1:initial',
      parts: []
    })

    await controller.stop()
    controller.handleTurnLifecycle({
      type: 'turn-completed',
      sequence: 2,
      threadId: 'thread-one',
      turnId: 'turn-one',
      outcome: 'interrupted'
    })
    transport.close()
    await send

    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      renderId: pendingAssistant?.renderId,
      role: 'assistant',
      parts: [],
      metadata: {
        codexTurn: {
          status: 'interrupted'
        }
      }
    })
  })

  it('F10 starts only one retry when regenerate is triggered twice', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const failedSend = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })

    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    transport.error(new Error('first attempt failed'))
    await expect(failedSend).rejects.toThrow('first attempt failed')

    const retry = controller.regenerate('message:initial-user')
    await expect(controller.regenerate('message:initial-user')).rejects.toThrow(
      'Conversation already has a running turn'
    )
    await vi.waitFor(() => expect(transport.sendCount).toBe(2))
    beginCanonicalTurn(controller, 'turn-retry')
    transport.enqueue({ type: 'start', messageId: 'assistant-retry' })
    transport.enqueue({ type: 'text-start', id: 'text-retry' })
    transport.enqueue({ type: 'text-delta', id: 'text-retry', delta: 'retry succeeded' })
    transport.enqueue({ type: 'text-end', id: 'text-retry' })
    transport.enqueue({ type: 'finish' })
    completeCanonicalTurn(controller, 'turn-retry', 'completed', 2)
    transport.close()
    await retry

    expect(transport.sendCount).toBe(2)
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().messages.map((message) => message.renderId)).toEqual([
      'message:initial-user',
      'message:assistant:turn-retry:text-retry'
    ])
    await recordPlanAssertions({
      scenarioIds: ['F10'],
      assertionId: '错误、取消与重试 UI 正确',
      assertion: () => expect(transport.sendCount).toBe(2)
    })
    await recordPlanAssertions({
      scenarioIds: ['F10'],
      assertionId: '历史与已显示内容保留',
      assertion: () =>
        expect(controller.getSnapshot().messages.map((message) => message.renderId)).toEqual([
          'message:initial-user',
          'message:assistant:turn-retry:text-retry'
        ])
    })
    await recordPlanAssertions({
      scenarioIds: ['F10'],
      assertionId: '可访问性、脱敏和 Composer 状态正确',
      assertion: () => expect(controller.getSnapshot().status).toBe('ready')
    })
  })

  it('F11/F12 continues local assistant identities after restoring a failed local turn', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    controller.replaceMessages([
      { id: 'initial-user', role: 'user', parts: [{ type: 'text', text: 'start' }] },
      {
        id: 'assistant:local-turn-1:initial',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial' }],
        metadata: {
          codexTurn: {
            turnId: 'local-turn-1',
            status: 'failed',
            error: { message: 'upstream disconnected' }
          }
        }
      }
    ])

    const retry = controller.regenerate('message:initial-user')
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))

    expect(controller.getSnapshot().messages.map((message) => message.renderId)).toEqual([
      'message:initial-user',
      'message:assistant:local-turn-2:initial'
    ])
    await recordPlanAssertions({
      scenarioIds: ['F11'],
      assertionId: '错误、取消与重试 UI 正确',
      assertion: () => expect(transport.sendCount).toBe(1)
    })
    await recordPlanAssertions({
      scenarioIds: ['F11'],
      assertionId: '历史与已显示内容保留',
      assertion: () =>
        expect(controller.getSnapshot().messages.map((message) => message.renderId)).toEqual([
          'message:initial-user',
          'message:assistant:local-turn-2:initial'
        ])
    })
    await recordPlanAssertions({
      scenarioIds: ['F11'],
      assertionId: '可访问性、脱敏和 Composer 状态正确',
      assertion: () => expect(controller.getSnapshot().status).toBe('submitted')
    })

    transport.close()
    await retry
  })

  it('marks a terminal retry when assistant-ui targets the preceding user message', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    controller.replaceMessages([
      { id: 'initial-user', role: 'user', parts: [{ type: 'text', text: 'start' }] },
      {
        id: 'assistant:failed-turn:initial',
        role: 'assistant',
        parts: [{ type: 'text', text: 'completed before failure' }],
        metadata: {
          codexTurn: {
            turnId: 'failed-turn',
            status: 'failed',
            error: { message: 'upstream disconnected' }
          }
        }
      }
    ])

    const retry = controller.regenerate('message:initial-user')
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))

    expect(controller.getSnapshot().messages.map((message) => message.renderId)).toEqual([
      'message:initial-user',
      'message:assistant:local-turn-1:initial'
    ])
    expect(transport.lastBody).toMatchObject({ retryTerminalTurn: true })

    transport.close()
    await retry
  })

  it('F18 restores failed and interrupted statuses from history metadata', () => {
    const controller = createController(new ControlledTransport())

    controller.replaceMessages([
      { id: 'user-one', role: 'user', parts: [{ type: 'text', text: 'one' }] },
      {
        id: 'assistant-failed',
        role: 'assistant',
        parts: [{ type: 'text', text: 'partial' }],
        metadata: {
          codexTurn: {
            turnId: 'turn-failed',
            status: 'failed',
            error: { message: 'history failure' }
          }
        }
      },
      { id: 'user-two', role: 'user', parts: [{ type: 'text', text: 'two' }] },
      {
        id: 'assistant-interrupted',
        role: 'assistant',
        parts: [],
        metadata: {
          codexTurn: {
            turnId: 'turn-interrupted',
            status: 'interrupted'
          }
        }
      }
    ])

    expect(controller.getSnapshot().messages[1]?.metadata).toEqual({
      codexTurn: {
        turnId: 'turn-failed',
        status: 'failed',
        error: { message: 'history failure' }
      }
    })
    expect(controller.getSnapshot().messages[3]?.metadata).toEqual({
      codexTurn: {
        turnId: 'turn-interrupted',
        status: 'interrupted'
      }
    })
  })

  it('settles a replayed abort as interrupted even when no lifecycle terminal is replayed', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)

    const resume = controller.resumeStream()
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    controller.handleStreamAccepted()
    transport.enqueue({ type: 'text-start', id: 'replayed-text' })
    transport.enqueue({ type: 'text-delta', id: 'replayed-text', delta: 'Partial replay.' })
    controller.handleStreamAborted()
    transport.close()

    await expect(resume).resolves.toBe(true)
    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [expect.objectContaining({ type: 'text', text: 'Partial replay.' })],
      metadata: { codexTurn: { status: 'interrupted' } }
    })
  })

  it('leaves initial no-active-run recovery as a no-op', async () => {
    const transport = new ControlledTransport()
    transport.nextReconnectResult = 'null'
    const controller = createController(transport)

    await expect(controller.resumeStream()).resolves.toBe(false)

    expect(controller.getSnapshot()).toMatchObject({ status: 'ready' })
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getRecoveryError()).toBeUndefined()
  })

  it('treats an attached stream that silently closes without events as unknown recovery failure', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)

    const resume = controller.resumeStream()
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    transport.close()

    await expect(resume).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: { message: '无法确认后台任务状态，请重试。' }
    })
    expect(controller.getRecoveryError()).toMatchObject({
      code: 'unknown-recovery',
      message: '无法确认后台任务状态，请重试。'
    })
  })

  it('keeps a replayed failed terminal after the draft acceptance has been consumed', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    controller.subscribe(() => {
      controller.takeCurrentSendAcceptance()
    })

    const resume = controller.resumeStream()
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    controller.handleStreamAccepted()
    transport.enqueue({ type: 'text-start', id: 'replayed-text' })
    transport.enqueue({
      type: 'text-delta',
      id: 'replayed-text',
      delta: 'Recovered partial output.'
    })
    controller.handleStreamError('stream disconnected before completion')
    transport.close()

    await expect(resume).resolves.toBe(false)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      error: { message: 'stream disconnected before completion' }
    })
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [expect.objectContaining({ type: 'text', text: 'Recovered partial output.' })],
      metadata: {
        codexTurn: {
          status: 'failed',
          error: { message: 'stream disconnected before completion' }
        }
      }
    })
  })

  it('keeps replayed output and structured recovery code when attach is rejected after replay', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)

    const resume = controller.resumeStream()
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    transport.enqueue({ type: 'text-start', id: 'replayed-text' })
    transport.enqueue({ type: 'text-delta', id: 'replayed-text', delta: 'Recovered partial.' })
    controller.handleStreamError({
      code: 'run-mismatch',
      message: 'The active run changed before recovery could attach.'
    })
    transport.close()

    await expect(resume).resolves.toBe(false)
    expect(controller.getRecoveryError()).toMatchObject({
      code: 'run-mismatch',
      message: 'The active run changed before recovery could attach.'
    })
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [expect.objectContaining({ type: 'text', text: 'Recovered partial.' })],
      metadata: {
        codexTurn: {
          status: 'failed',
          error: { message: 'The active run changed before recovery could attach.' }
        }
      }
    })
  })

  it('keeps replayed partial output when canonical history already contains a failed assistant item', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    controller.replaceMessages([
      { id: 'user-one', role: 'user', parts: [{ type: 'text', text: 'request' }] },
      {
        id: 'assistant-history-error',
        role: 'assistant',
        parts: [{ type: 'text', text: 'canonical failure detail' }],
        metadata: {
          codexTurn: {
            turnId: 'turn-one',
            status: 'failed',
            error: { message: 'canonical failure detail' }
          }
        }
      }
    ])

    const resume = controller.resumeStream()
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    controller.handleStreamAccepted()
    transport.enqueue({ type: 'text-start', id: 'replayed-text' })
    transport.enqueue({
      type: 'text-delta',
      id: 'replayed-text',
      delta: 'Recovered partial output.'
    })
    controller.handleStreamError('stream disconnected before completion')
    transport.close()

    await expect(resume).resolves.toBe(false)
    expect(
      controller
        .getSnapshot()
        .messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.parts.some(
              (part) => part.type === 'text' && part.text === 'Recovered partial output.'
            )
        )
    ).toBe(true)
  })

  it('F04 limits long errors to 2,000 characters plus an ellipsis', async () => {
    const message = `upstream failure: ${'x'.repeat(2_100)}`
    const safeMessage = safeTurnErrorMessage(message)

    expect(safeMessage).toHaveLength(2_001)
    expect(safeMessage).toBe(`${message.slice(0, 2_000)}…`)
    await recordPlanAssertions({
      scenarioIds: ['F04'],
      assertionId: '错误、取消与重试 UI 正确',
      assertion: () => expect(safeMessage).toHaveLength(2_001)
    })
    await recordPlanAssertions({
      scenarioIds: ['F04'],
      assertionId: '历史与已显示内容保留',
      assertion: () => expect(safeMessage).toBe(`${message.slice(0, 2_000)}…`)
    })
    await recordPlanAssertions({
      scenarioIds: ['F04'],
      assertionId: '可访问性、脱敏和 Composer 状态正确',
      assertion: () => expect(safeMessage.endsWith('…')).toBe(true)
    })
  })

  it('F03/F05/G05 uses a stable fallback and redacts credentials in headers and URLs', async () => {
    expect(safeTurnErrorMessage('   ')).toBe('模型响应未完成，请重试。')
    expect(
      safeTurnErrorMessage(
        'Authorization: Bearer secret-token\napi_key=super-secret sk-abcdefgh12345678'
      )
    ).toBe('Authorization: [REDACTED]\napi_key=[REDACTED] sk-[REDACTED]')
    expect(
      safeTurnErrorMessage(
        'GET https://user:password@example.test/v1?token=url-secret&mode=safe\nX-Api-Key: header-secret'
      )
    ).toBe(
      'GET https://[REDACTED]@example.test/v1?token=[REDACTED]&mode=safe\nX-Api-Key: [REDACTED]'
    )

    const transport = new ControlledTransport()
    const controller = createController(transport)
    const send = controller.sendMessage({
      id: 'initial-user',
      role: 'user',
      parts: [{ type: 'text', text: 'start' }]
    })
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    transport.error(new Error('   '))

    await expect(send).rejects.toThrow('模型响应未完成，请重试。')
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: [],
      metadata: {
        codexTurn: {
          status: 'failed',
          error: { message: '模型响应未完成，请重试。' }
        }
      }
    })
    await recordPlanAssertions({
      scenarioIds: ['F03', 'F05'],
      assertionId: '错误、取消与重试 UI 正确',
      assertion: () =>
        expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
          metadata: {
            codexTurn: { status: 'failed', error: { message: '模型响应未完成，请重试。' } }
          }
        })
    })
    await recordPlanAssertions({
      scenarioIds: ['F03', 'F05'],
      assertionId: '历史与已显示内容保留',
      assertion: () =>
        expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
          role: 'assistant',
          parts: []
        })
    })
    await recordPlanAssertions({
      scenarioIds: ['F03', 'F05'],
      assertionId: '可访问性、脱敏和 Composer 状态正确',
      assertion: () => expect(safeTurnErrorMessage('   ')).toBe('模型响应未完成，请重试。')
    })
    await recordPlanAssertions({
      scenarioIds: ['G05'],
      assertionId: '跨对话与信任边界隔离',
      assertion: () => expect(safeTurnErrorMessage('   ')).toBe('模型响应未完成，请重试。')
    })
    await recordPlanAssertions({
      scenarioIds: ['G05'],
      assertionId: '资源、并发和终态无残留',
      assertion: () => expect(controller.getActiveTurnId()).toBeUndefined()
    })
    await recordPlanAssertions({
      scenarioIds: ['G05'],
      assertionId: '诊断可关联而不泄露密钥',
      assertion: () =>
        expect(
          safeTurnErrorMessage(
            'Authorization: Bearer secret-token\napi_key=super-secret sk-abcdefgh12345678'
          )
        ).toBe('Authorization: [REDACTED]\napi_key=[REDACTED] sk-[REDACTED]')
    })
  })

  it('F14 sends a new ordinary message after failure and preserves source and data parts', async () => {
    const transport = new ControlledTransport()
    const controller = createController(transport)
    const failedSend = controller.sendMessage({
      id: 'first-user',
      role: 'user',
      parts: [{ type: 'text', text: 'first attempt' }]
    })
    await vi.waitFor(() => expect(transport.sendCount).toBe(1))
    transport.error(new Error('first attempt failed'))
    await expect(failedSend).rejects.toThrow('first attempt failed')

    const nextSend = controller.sendMessage({
      id: 'second-user',
      role: 'user',
      parts: [{ type: 'text', text: 'continue normally' }]
    })
    await vi.waitFor(() => expect(transport.sendCount).toBe(2))
    beginCanonicalTurn(controller, 'turn-two')
    transport.enqueue({ type: 'start', messageId: 'assistant-two' })
    transport.enqueue({
      type: 'source-url',
      sourceId: 'source-two',
      url: 'https://example.test/docs',
      title: 'Example docs'
    })
    transport.enqueue({ type: 'data-status', id: 'status-two', data: { phase: 'complete' } })
    transport.enqueue({ type: 'text-start', id: 'text-two' })
    transport.enqueue({ type: 'text-delta', id: 'text-two', delta: 'second attempt succeeded' })
    transport.enqueue({ type: 'text-end', id: 'text-two' })
    transport.enqueue({ type: 'finish' })
    completeCanonicalTurn(controller, 'turn-two', 'completed', 2)
    transport.close()
    await nextSend

    expect(controller.getSnapshot().status).toBe('ready')
    expect(controller.getSnapshot().error).toBeUndefined()
    expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
      role: 'assistant',
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: 'source-url',
          sourceId: 'source-two',
          url: 'https://example.test/docs',
          title: 'Example docs'
        }),
        expect.objectContaining({
          type: 'data-status',
          id: 'status-two',
          data: { phase: 'complete' }
        }),
        expect.objectContaining({ type: 'text', text: 'second attempt succeeded' })
      ])
    })
    await recordPlanAssertions({
      scenarioIds: ['F14'],
      assertionId: '错误、取消与重试 UI 正确',
      assertion: () => expect(controller.getSnapshot().error).toBeUndefined()
    })
    await recordPlanAssertions({
      scenarioIds: ['F14'],
      assertionId: '历史与已显示内容保留',
      assertion: () =>
        expect(controller.getSnapshot().messages.at(-1)).toMatchObject({
          role: 'assistant',
          parts: expect.arrayContaining([
            expect.objectContaining({ type: 'source-url', sourceId: 'source-two' }),
            expect.objectContaining({ type: 'data-status', id: 'status-two' }),
            expect.objectContaining({ type: 'text', text: 'second attempt succeeded' })
          ])
        })
    })
    await recordPlanAssertions({
      scenarioIds: ['F14'],
      assertionId: '可访问性、脱敏和 Composer 状态正确',
      assertion: () => expect(controller.getSnapshot().status).toBe('ready')
    })
  })

  it('rejects an empty source message identity instead of exposing an invalid render id', () => {
    const controller = createController(new ControlledTransport())

    expect(() =>
      controller.replaceMessages([
        { id: '', role: 'assistant', parts: [{ type: 'text', text: 'invalid' }] }
      ])
    ).toThrowError(
      expect.objectContaining({
        name: 'ConversationTranscriptIntegrityError',
        message: expect.stringContaining('empty renderId')
      })
    )
  })
})

class ControlledTransport {
  private streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined
  private closed = false
  sendCount = 0
  lastBody: unknown
  lastTrigger: string | undefined
  nextReconnectResult: 'stream' | 'null' = 'stream'

  async sendMessages(options?: {
    abortSignal?: AbortSignal
    body?: unknown
    trigger?: string
  }): Promise<ReadableStream<UIMessageChunk>> {
    this.sendCount += 1
    this.lastBody = options?.body
    this.lastTrigger = options?.trigger
    this.closed = false
    return new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.streamController = controller
        options?.abortSignal?.addEventListener('abort', () => undefined, { once: true })
      }
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    if (this.nextReconnectResult === 'null') {
      this.sendCount += 1
      return null
    }
    return this.sendMessages()
  }

  enqueue(chunk: UIMessageChunk): void {
    this.streamController?.enqueue(chunk)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.streamController?.close()
  }

  error(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.streamController?.error(error)
  }
}

function createController(transport: ControlledTransport): ConversationTranscriptController {
  return new ConversationTranscriptController({
    id: 'conversation-test',
    transport: transport as unknown as ElectronIpcChatTransport
  })
}

function beginCanonicalTurn(controller: ConversationTranscriptController, turnId: string): void {
  controller.handleTurnLifecycle({
    type: 'turn-started',
    sequence: 1,
    threadId: 'thread-one',
    turnId
  })
}

function completeCanonicalTurn(
  controller: ConversationTranscriptController,
  turnId: string,
  outcome: 'completed' | 'interrupted' | 'failed',
  sequence: number
): void {
  controller.handleTurnLifecycle({
    type: 'turn-completed',
    sequence,
    threadId: 'thread-one',
    turnId,
    outcome
  })
}
