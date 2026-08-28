import { beforeEach, describe, expect, it, vi } from 'vitest'

const providerState = vi.hoisted(() => ({
  listModels: vi.fn(),
  shutdown: vi.fn(),
  startThread: vi.fn()
}))

vi.mock('../codexAspProvider', () => ({
  createCodexAspProvider: vi.fn(() => ({
    listModels: providerState.listModels,
    shutdown: providerState.shutdown,
    startThread: providerState.startThread,
    chat: vi.fn()
  }))
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/app',
    isPackaged: false
  }
}))

import { CodexChatRuntimeService, type CodexPortLike } from '../codexChatRuntimeService'
import { ProjectService } from '../projects/ProjectService'
import { ProjectStore, createDefaultProjectState } from '../projects/ProjectStore'
import type { CodexTurnLifecycleEvent } from '../../shared/codexIpcApi'
import { startConversation } from './startConversation'

class FakePort implements CodexPortLike {
  readonly messages: unknown[] = []
  private handler: ((event: { data: unknown }) => void) | undefined

  postMessage(message: unknown): void {
    this.messages.push(message)
    const event =
      typeof message === 'object' && message !== null && 'event' in message
        ? (message as { event: unknown }).event
        : message
    if (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'thread-bound' &&
      'threadId' in event &&
      typeof event.threadId === 'string'
    ) {
      this.handler?.({
        data: { type: 'thread-bound-ack', threadId: event.threadId }
      })
    }
  }

  on(_event: 'message', handler: (event: { data: unknown }) => void): void {
    this.handler = handler
  }

  start(): void {
    return undefined
  }

  close(): void {
    return undefined
  }
}

function streamEvents(port: FakePort): unknown[] {
  return port.messages.map((message) => {
    if (typeof message === 'object' && message !== null && 'event' in message) {
      return (message as { event: unknown }).event
    }
    return message
  })
}

async function* emptyUiMessageStream(): AsyncGenerator<never, void, unknown> {
  if (process.env['NODE_ENV'] === '__unused_test_stream__') {
    yield undefined as never
  }
}

type RuntimeStreamTextInput = {
  onThreadStarted?: (thread: { threadId: string; threadPath?: string }) => void | Promise<void>
  onTurnLifecycle?: (event: CodexTurnLifecycleEvent) => void | Promise<void>
}

describe('startConversation', () => {
  beforeEach(() => {
    providerState.listModels.mockReset()
    providerState.shutdown.mockReset()
    providerState.startThread.mockReset()
    providerState.startThread.mockResolvedValue({ threadId: 'thread-prestarted' })
  })

  it('ignores renderer supplied cwd and uses resolved target', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async (input: RuntimeStreamTextInput) => {
      await input.onThreadStarted?.({ threadId: 'thread-prestarted' })
      await input.onTurnLifecycle?.({
        type: 'turn-started',
        sequence: 1,
        threadId: 'thread-prestarted',
        turnId: 'turn-prestarted'
      })
      await input.onTurnLifecycle?.({
        type: 'turn-completed',
        sequence: 2,
        threadId: 'thread-prestarted',
        turnId: 'turn-prestarted',
        outcome: 'completed'
      })
      return {
        toUIMessageStream: () => emptyUiMessageStream()
      }
    })
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'local',
        cwd: '/repo',
        workspaceRoots: ['/repo'],
        workspaceKind: 'project'
      }),
      resolveExistingThreadTarget: vi.fn()
    }
    const service = new CodexChatRuntimeService({
      cwd: '/fallback',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      projectService
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: {
          projectSelection: { projectKind: 'path', path: '/repo' },
          cwd: '/malicious'
        }
      },
      port
    )

    expect(projectService.resolveNewThreadTarget).toHaveBeenCalledWith({
      selection: { projectKind: 'path', path: '/repo' },
      prompt: ''
    })
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        executionTarget: expect.objectContaining({
          cwd: '/repo',
          runtimeWorkspaceRoots: ['/repo']
        })
      })
    )
    const streamTextInput = streamText.mock.calls[0]?.[0] as
      | { executionTarget?: unknown }
      | undefined
    expect(streamTextInput?.executionTarget).not.toMatchObject({
      cwd: '/malicious'
    })
    expect(streamEvents(port)).toEqual([
      { type: 'thread-bound', threadId: 'thread-prestarted' },
      {
        type: 'turn-lifecycle',
        event: {
          type: 'turn-started',
          sequence: 1,
          threadId: 'thread-prestarted',
          turnId: 'turn-prestarted'
        }
      },
      {
        type: 'turn-lifecycle',
        event: {
          type: 'turn-completed',
          sequence: 2,
          threadId: 'thread-prestarted',
          turnId: 'turn-prestarted',
          outcome: 'completed'
        }
      },
      { type: 'finish', threadId: 'thread-prestarted' }
    ])
  })

  it('returns project assignment for the runtime to persist against the app-server thread id', async () => {
    const projectStore = ProjectStore.inMemory(createDefaultProjectState())
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'local',
        cwd: '/repo',
        workspaceRoots: ['/repo'],
        workspaceKind: 'project',
        projectAssignment: {
          projectKind: 'local',
          projectId: '/repo',
          path: '/repo',
          cwd: '/repo'
        }
      }),
      resolveExistingThreadTarget: vi.fn()
    }

    const result = await startConversation({
      request: {
        chatId: 'chat-fallback',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: {
          projectSelection: { projectKind: 'path', path: '/repo' }
        }
      },
      projectService
    })

    expect(result).toMatchObject({
      executionTarget: {
        cwd: '/repo',
        runtimeWorkspaceRoots: ['/repo']
      },
      projectAssignment: {
        projectKind: 'local',
        projectId: '/repo',
        path: '/repo',
        cwd: '/repo'
      }
    })
    await expect(projectStore.getState()).resolves.toMatchObject({
      threadProjectAssignments: {}
    })
  })

  it('preserves the main-resolved remote execution environment for the provider', async () => {
    const projectService = {
      resolveNewThreadTarget: vi.fn().mockResolvedValue({
        hostId: 'ssh-prod',
        cwd: '/srv/app',
        remoteEnvironment: {
          environmentId: 'ssh-prod',
          cwd: '/srv/app',
          execServerUrl: 'wss://exec.example.test/codex'
        },
        workspaceRoots: ['/srv/app'],
        workspaceKind: 'project'
      }),
      resolveExistingThreadTarget: vi.fn()
    }

    const result = await startConversation({
      request: {
        chatId: 'chat-remote',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: {
          projectSelection: { projectKind: 'remote', projectId: 'remote-1', hostId: 'ssh-prod' }
        }
      },
      projectService
    })

    expect(result.executionTarget).toEqual({
      cwd: '/srv/app',
      remoteEnvironment: {
        environmentId: 'ssh-prod',
        cwd: '/srv/app',
        execServerUrl: 'wss://exec.example.test/codex'
      },
      runtimeWorkspaceRoots: ['/srv/app']
    })
  })

  it('rejects direct chat payloads that forge an unregistered path project', async () => {
    const port = new FakePort()
    const streamText = vi.fn(async () => ({
      toUIMessageStream: () => emptyUiMessageStream()
    }))
    const store = ProjectStore.inMemory({
      ...createDefaultProjectState(),
      activeProjectSelection: { projectKind: 'path', path: '/safe/repo' },
      workspaceRootOptions: [
        {
          root: '/safe/repo',
          hostId: 'local',
          addedAt: '2026-06-29T00:00:00.000Z',
          lastOpenedAt: '2026-06-29T00:00:00.000Z'
        }
      ]
    })
    const projectService = new ProjectService({
      store,
      validateLocalRoot: async (path) => ({ realPath: path }),
      validateRemoteRoot: async () => undefined,
      createProjectlessWorkspace: async () => ({
        cwd: '/tmp/projectless',
        workspaceRoot: '/tmp/projectless',
        outputDirectory: '/tmp/projectless/out'
      })
    })
    const service = new CodexChatRuntimeService({
      cwd: '/fallback',
      launch: {
        command: '/bin/codex-app-server',
        args: ['--listen', 'stdio://'],
        displayBinary: '/bin/codex-app-server --listen stdio://'
      },
      streamText,
      projectService
    })

    await service.startChatStream(
      {
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        modelId: 'gpt-test',
        body: {
          projectSelection: { projectKind: 'path', path: '/malicious' }
        }
      },
      port
    )

    expect(streamText).not.toHaveBeenCalled()
    expect(streamEvents(port)).toEqual([
      {
        type: 'error',
        error: 'Workspace root is not a registered project: /malicious'
      }
    ])
  })
})
