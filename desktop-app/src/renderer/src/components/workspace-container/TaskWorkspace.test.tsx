// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TaskWorkspace } from './TaskWorkspace'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

describe('TaskWorkspace', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('shows the live task goal and opens a selected subagent conversation', async () => {
    const onOpenConversation = vi.fn()
    await act(async () => {
      root.render(
        <TaskWorkspace
          onOpenConversation={onOpenConversation}
          summary={{
            conversationId: 'parent',
            threadId: 'parent',
            title: 'Implement task workspace',
            status: 'streaming',
            messageCount: 7,
            canOpenLocalPaths: true,
            goal: {
              threadId: 'parent',
              objective: '完成工作台',
              status: 'active',
              tokenBudget: 100,
              tokensUsed: 42,
              timeUsedSeconds: 12,
              createdAt: 1,
              updatedAt: 2
            },
            agents: [
              {
                eventId: 'review-agent',
                threadId: 'agent-review',
                agentPath: '/root/code_quality_review',
                displayName: 'Review',
                displayStatus: 'active',
                model: 'gpt-5.5'
              }
            ],
            timeline: [],
            outputs: [],
            sources: []
          }}
        />
      )
    })

    expect(container.querySelector('[data-slot="workspace-task-summary"]')?.textContent).toContain(
      'Implement task workspace'
    )
    expect(container.textContent).toContain('状态：正在运行')
    expect(container.textContent).toContain('完成工作台')
    expect(container.textContent).toContain('42 / 100 tokens')
    expect(container.textContent).toContain('角色：code quality review')
    expect(container.textContent).toContain('模型：gpt-5.5')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-agent-thread-id="agent-review"]')?.click()
    })

    expect(onOpenConversation).toHaveBeenCalledWith('agent-review')
  })

  it('aggregates task terminal processes and opens or restarts the selected process', async () => {
    const session = terminalSession({ status: 'exited' })
    const restarted = terminalSession({ status: 'running' })
    const terminal = {
      list: vi.fn().mockResolvedValue({ version: 2, sessions: [session] }),
      restart: vi.fn().mockResolvedValue(restarted),
      close: vi.fn(),
      onEvent: vi.fn(() => () => undefined)
    }
    vi.stubGlobal('desktopApp', { workspace: { terminal } })
    const onOpenTerminal = vi.fn()

    await act(async () => {
      root.render(
        <TaskWorkspace
          target={{ conversationId: 'parent', threadId: 'parent' }}
          onOpenTerminal={onOpenTerminal}
          summary={{
            conversationId: 'parent',
            threadId: 'parent',
            status: 'ready',
            messageCount: 1,
            canOpenLocalPaths: true,
            agents: [],
            timeline: [],
            outputs: [],
            sources: []
          }}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-slot="workspace-task-process"]')?.textContent).toContain(
      'Build server'
    )

    await act(async () => {
      buttonWithText('打开输出')?.click()
    })
    expect(onOpenTerminal).toHaveBeenCalledWith(session)

    await act(async () => {
      buttonWithText('重启')?.click()
      await Promise.resolve()
    })
    expect(terminal.restart).toHaveBeenCalledWith({
      version: 2,
      sessionId: session.sessionId,
      target: { conversationId: 'parent', threadId: 'parent' },
      reason: 'manual'
    })
  })

  it('refreshes terminal state for the newly selected conversation', async () => {
    const terminal = {
      list: vi.fn(async ({ target }: { target?: { conversationId?: string } }) => ({
        version: 2,
        sessions:
          target?.conversationId === 'task-b'
            ? [
                {
                  ...terminalSession({ status: 'running' }),
                  sessionId: 'terminal-b',
                  conversationId: 'task-b',
                  title: 'Process B'
                }
              ]
            : [
                {
                  ...terminalSession({ status: 'running' }),
                  sessionId: 'terminal-a',
                  conversationId: 'task-a',
                  title: 'Process A'
                }
              ]
      })),
      onEvent: vi.fn(() => () => undefined)
    }
    vi.stubGlobal('desktopApp', { workspace: { terminal } })

    await act(async () => {
      root.render(
        <TaskWorkspace
          target={{ conversationId: 'task-a', threadId: 'task-a' }}
          summary={taskSummary('task-a')}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Process A')

    await act(async () => {
      root.render(
        <TaskWorkspace
          target={{ conversationId: 'task-b', threadId: 'task-b' }}
          summary={taskSummary('task-b')}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Process B')
    expect(container.textContent).not.toContain('Process A')
  })

  it('runs a saved project action and opens its terminal output', async () => {
    const session = terminalSession({ status: 'running' })
    const terminal = {
      list: vi.fn().mockResolvedValue({ version: 2, sessions: [] }),
      create: vi.fn().mockResolvedValue(session),
      runAction: vi.fn().mockResolvedValue({ accepted: true }),
      onEvent: vi.fn(() => () => undefined)
    }
    const projects = {
      getState: vi.fn().mockResolvedValue(projectStateWithAction()),
      onStateChange: vi.fn(() => () => undefined),
      upsertAction: vi.fn(),
      removeAction: vi.fn()
    }
    vi.stubGlobal('desktopApp', { projects, workspace: { terminal } })
    const onOpenTerminal = vi.fn()

    await act(async () => {
      root.render(
        <TaskWorkspace
          target={{ conversationId: 'parent', threadId: 'parent' }}
          onOpenTerminal={onOpenTerminal}
          summary={{
            conversationId: 'parent',
            threadId: 'parent',
            projectSelection: { projectKind: 'path', path: '/workspace' },
            status: 'ready',
            messageCount: 1,
            canOpenLocalPaths: true,
            agents: [],
            timeline: [],
            outputs: [],
            sources: []
          }}
        />
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelector('[data-slot="workspace-task-action"]')?.textContent).toContain(
      'Run tests'
    )

    await act(async () => {
      buttonWithText('运行')?.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(terminal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        target: { conversationId: 'parent', threadId: 'parent' },
        purpose: 'action'
      })
    )
    expect(terminal.runAction).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, command: 'npm test', title: 'Run tests' })
    )
    expect(onOpenTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        title: 'Run tests',
        purpose: 'action'
      })
    )
  })

  it('shows the current execution environment and the non-Git capability boundary', async () => {
    await act(async () => {
      root.render(
        <TaskWorkspace
          summary={{
            conversationId: 'projectless-task',
            projectSelection: { projectKind: 'projectless' },
            cwd: '/tmp/projectless-task',
            status: 'ready',
            messageCount: 1,
            canOpenLocalPaths: true,
            agents: [],
            timeline: [],
            outputs: [],
            sources: []
          }}
        />
      )
    })

    const environment = container.querySelector('[data-slot="workspace-task-environment"]')
    expect(environment?.textContent).toContain('项目外工作区')
    expect(environment?.textContent).toContain('/tmp/projectless-task')
    expect(container.textContent).toContain('不能选择分支或 worktree')
  })

  it('keeps an agent visible but non-interactive until it has a conversation id', async () => {
    await act(async () => {
      root.render(
        <TaskWorkspace
          summary={{
            conversationId: 'parent',
            threadId: 'parent',
            status: 'ready',
            messageCount: 1,
            canOpenLocalPaths: true,
            agents: [
              {
                eventId: 'pending-agent',
                agentPath: '/root/investigate',
                displayName: 'Investigate',
                displayStatus: 'active'
              }
            ],
            timeline: [],
            outputs: [],
            sources: []
          }}
        />
      )
    })

    const agent = container.querySelector('[data-slot="workspace-task-agent"]')
    expect(agent?.textContent).toContain('Investigate')
    expect(agent?.tagName).toBe('LI')
    expect(agent?.querySelector('button')).toBeNull()
  })
})

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === text
  )
}

function terminalSession({ status }: { status: 'running' | 'exited' }): Record<string, unknown> {
  return {
    sessionId: 'terminal-build',
    workspaceId: 'conversation:parent',
    conversationId: 'parent',
    threadId: 'parent',
    hostId: 'local',
    backendKind: 'local-pty',
    purpose: 'action',
    cwd: '/workspace',
    shell: '/bin/zsh',
    shellKind: 'posix',
    title: 'Build server',
    cols: 120,
    rows: 30,
    status,
    exitCode: status === 'exited' ? 1 : null,
    signal: null,
    truncated: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(status === 'exited' ? { exitedAt: '2026-01-01T00:00:00.000Z' } : {})
  }
}

function taskSummary(conversationId: string): import('./taskWorkspaceTypes').WorkspaceTaskSummary {
  return {
    conversationId,
    threadId: conversationId,
    status: 'ready',
    messageCount: 1,
    canOpenLocalPaths: true,
    agents: [],
    timeline: [],
    outputs: [],
    sources: []
  }
}

function projectStateWithAction(): Record<string, unknown> {
  return {
    workspaceRootOptions: [{ root: '/workspace', hostId: 'local', addedAt: '', lastOpenedAt: '' }],
    localProjects: {},
    remoteProjects: [],
    projectOrder: [],
    pinnedProjectIds: [],
    projectActions: {
      'path:/workspace': [
        {
          id: 'c2a58c2f-14ba-4111-a1bc-5105403c551a',
          title: 'Run tests',
          command: 'npm test',
          createdAt: '',
          updatedAt: ''
        }
      ]
    },
    projectWritableRoots: {},
    threadProjectAssignments: {},
    threadWritableRoots: {},
    threadWorkspaceRootHints: {},
    threadProjectlessOutputDirectories: {},
    projectlessThreadIds: [],
    projectlessHints: {}
  }
}
