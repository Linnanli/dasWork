// @vitest-environment jsdom

import { isValidElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const adapters = vi.hoisted(() => ({
  repositionBrowserWorkspaceView: vi
    .fn<(tabId: string, viewId: string) => Promise<void>>()
    .mockResolvedValue(undefined),
  refitTerminalWorkspace: vi.fn<(tabId: string) => Promise<void>>().mockResolvedValue(undefined)
}))

vi.mock('../right-workspace/browser/browserWorkspaceMove', () => ({
  repositionBrowserWorkspaceView: adapters.repositionBrowserWorkspaceView
}))

vi.mock('../right-workspace/browser/BrowserWorkspace', () => ({ BrowserWorkspace: () => null }))

vi.mock('../right-workspace/terminal/terminalWorkspaceMove', () => ({
  refitTerminalWorkspace: adapters.refitTerminalWorkspace
}))

vi.mock('../right-workspace/terminal/TerminalWorkspace', () => ({ TerminalWorkspace: () => null }))

import { createWorkspaceContentRegistry } from './WorkspaceContentRegistry'
import type {
  WorkspaceContentLifecycleContext,
  WorkspaceContentRenderContext
} from './WorkspaceContentRegistry'
import type { WorkspaceTabRecord } from './workspaceTypes'

const lifecycleContext: WorkspaceContentLifecycleContext = {
  panelId: 'bottom',
  workspaceId: 'conversation:one',
  runtime: undefined
}

afterEach(() => vi.clearAllMocks())

describe('WorkspaceContentRegistry move lifecycle', () => {
  it('refits an existing terminal after it moves to another panel', async () => {
    await createWorkspaceContentRegistry().move(terminalTab('terminal:one'), lifecycleContext)

    expect(adapters.refitTerminalWorkspace).toHaveBeenCalledWith('terminal:one')
  })

  it('repositions and shows an existing browser view after it moves', async () => {
    await createWorkspaceContentRegistry().move(browserTab('browser:one'), {
      ...lifecycleContext,
      runtime: { browserViewId: 'view-1' }
    })

    expect(adapters.repositionBrowserWorkspaceView).toHaveBeenCalledWith('browser:one', 'view-1')
  })

  it('does not schedule browser work when the tab has no native view', async () => {
    await createWorkspaceContentRegistry().move(browserTab('browser:one'), lifecycleContext)

    expect(adapters.repositionBrowserWorkspaceView).not.toHaveBeenCalled()
  })
})

describe('WorkspaceContentRegistry terminal lifecycle', () => {
  it('opens another terminal in the panel that contains the current terminal', () => {
    const openTarget = vi.fn()
    const rendered = createWorkspaceContentRegistry().render(terminalTab('terminal:one'), {
      ...renderContext(openTarget),
      panelId: 'right'
    })

    if (!isValidElement<{ onOpenTerminal(): void }>(rendered)) {
      throw new Error('Expected a terminal workspace element.')
    }
    rendered.props.onOpenTerminal()

    expect(openTarget).toHaveBeenCalledWith({ type: 'terminal' }, { panelId: 'right' })
  })

  it('closes terminal tabs by stable session id from tab id', async () => {
    const close = vi.fn(async () => ({ sessionId: 'one' }))
    vi.stubGlobal('desktopApp', {
      workspace: { terminal: { close } }
    })

    await createWorkspaceContentRegistry().close(terminalTab('terminal:one'), lifecycleContext)

    expect(close).toHaveBeenCalledWith({ version: 2, sessionId: 'one' })
  })
})

describe('WorkspaceContentRegistry file tabs', () => {
  it('replaces the empty Files explorer with the first selected file', () => {
    const openTarget = vi.fn()
    const rendered = createWorkspaceContentRegistry().render(fileTab('files:explorer', ''), {
      ...renderContext(openTarget),
      panelId: 'right'
    })

    if (
      !isValidElement<{
        onOpenFile(relativePath: string, title: string, mode?: 'preview' | 'pinned'): void
      }>(rendered)
    ) {
      throw new Error('Expected a file workspace element.')
    }
    const { onOpenFile } = rendered.props
    onOpenFile('README.md', 'README.md')

    expect(openTarget).toHaveBeenCalledWith(
      { type: 'file', relativePath: 'README.md', title: 'README.md' },
      { panelId: 'right', mode: 'pinned', replaceTabId: 'files:explorer' }
    )
  })

  it('keeps preview behavior when an open file selects another file', () => {
    const openTarget = vi.fn()
    const rendered = createWorkspaceContentRegistry().render(
      fileTab('file:README.md', 'README.md'),
      {
        ...renderContext(openTarget),
        panelId: 'right'
      }
    )

    if (
      !isValidElement<{
        onOpenFile(relativePath: string, title: string, mode?: 'preview' | 'pinned'): void
      }>(rendered)
    ) {
      throw new Error('Expected a file workspace element.')
    }
    rendered.props.onOpenFile('package.json', 'package.json')

    expect(openTarget).toHaveBeenCalledWith(
      { type: 'file', relativePath: 'package.json', title: 'package.json' },
      { panelId: 'right', mode: 'preview' }
    )
  })
})

describe('WorkspaceContentRegistry task summary tabs', () => {
  it('passes the active conversation summary and navigation callback to the task workspace', () => {
    const onOpenConversation = vi.fn()
    const openTarget = vi.fn()
    const summary = {
      conversationId: 'parent',
      status: 'ready',
      messageCount: 2,
      canOpenLocalPaths: true,
      agents: [],
      timeline: [],
      outputs: [],
      sources: []
    } as const
    const rendered = createWorkspaceContentRegistry().render(
      {
        id: 'task-summary',
        kind: 'task-summary',
        title: '任务',
        props: {},
        isPreview: false,
        isClosable: true
      },
      {
        ...renderContext(openTarget),
        target: { conversationId: 'parent', threadId: 'parent' },
        taskSummary: summary,
        onOpenConversation
      }
    )

    if (
      !isValidElement<{
        summary: typeof summary
        onOpenConversation: typeof onOpenConversation
        onOpenTerminal(session: { sessionId: string; title: string }): void
      }>(rendered)
    ) {
      throw new Error('Expected a task workspace element.')
    }
    expect(rendered.props.summary).toBe(summary)
    expect(rendered.props.onOpenConversation).toBe(onOpenConversation)
    rendered.props.onOpenTerminal({ sessionId: 'build', title: 'Build server' })
    expect(openTarget).toHaveBeenCalledWith(
      { type: 'terminal', id: 'terminal:build', title: 'Build server' },
      { panelId: 'bottom' }
    )
  })

  it('passes timeline events from the active conversation to the timeline workspace', () => {
    const timeline = [{ id: 'message', type: 'user' as const, label: '检查工作台' }]
    const rendered = createWorkspaceContentRegistry().render(
      {
        id: 'timeline',
        kind: 'timeline',
        title: '时间线',
        props: {},
        isPreview: false,
        isClosable: true
      },
      {
        ...renderContext(vi.fn()),
        taskSummary: {
          conversationId: 'parent',
          status: 'ready',
          messageCount: 1,
          canOpenLocalPaths: true,
          agents: [],
          timeline,
          outputs: [],
          sources: []
        }
      }
    )

    if (!isValidElement<{ events: typeof timeline }>(rendered)) {
      throw new Error('Expected a timeline workspace element.')
    }
    expect(rendered.props.events).toBe(timeline)
  })

  it('passes complete-conversation outputs and local-path capability to the Outputs workspace', () => {
    const outputs = [
      {
        id: 'file:out/report.pdf',
        type: 'file' as const,
        title: 'report.pdf',
        path: 'out/report.pdf',
        cwd: '/workspace'
      }
    ]
    const rendered = createWorkspaceContentRegistry().render(
      {
        id: 'outputs',
        kind: 'outputs',
        title: 'Outputs',
        props: {},
        isPreview: false,
        isClosable: true
      },
      {
        ...renderContext(vi.fn()),
        taskSummary: {
          conversationId: 'parent',
          status: 'ready',
          messageCount: 1,
          canOpenLocalPaths: true,
          agents: [],
          timeline: [],
          outputs,
          sources: []
        }
      }
    )

    if (
      !isValidElement<{
        resources: typeof outputs
        canOpenLocalPaths: boolean
        onCreateOutput: WorkspaceContentRenderContext['onCreateOutput']
      }>(rendered)
    ) {
      throw new Error('Expected an Outputs workspace element.')
    }
    expect(rendered.props.resources).toBe(outputs)
    expect(rendered.props.canOpenLocalPaths).toBe(true)
    expect(rendered.props.onCreateOutput).toBeDefined()
  })

  it('passes complete-conversation sources to the Sources workspace', () => {
    const sources = [
      {
        id: 'source-one',
        sourceType: 'url' as const,
        title: '产品文档',
        url: 'https://example.test/docs',
        usageCount: 2
      }
    ]
    const rendered = createWorkspaceContentRegistry().render(
      {
        id: 'sources',
        kind: 'sources',
        title: 'Sources',
        props: {},
        isPreview: false,
        isClosable: true
      },
      {
        ...renderContext(vi.fn()),
        taskSummary: {
          conversationId: 'parent',
          status: 'ready',
          messageCount: 1,
          canOpenLocalPaths: true,
          agents: [],
          timeline: [],
          outputs: [],
          sources
        }
      }
    )

    if (!isValidElement<{ sources: typeof sources }>(rendered)) {
      throw new Error('Expected a Sources workspace element.')
    }
    expect(rendered.props.sources).toBe(sources)
  })

  it('opens a selected process terminal in the same workspace panel', () => {
    const openTarget = vi.fn()
    const rendered = createWorkspaceContentRegistry().render(
      {
        id: 'processes',
        kind: 'processes',
        title: '进程',
        props: {},
        isPreview: false,
        isClosable: true
      },
      { ...renderContext(openTarget), panelId: 'right' }
    )

    if (
      !isValidElement<{ onOpenTerminal(session: { sessionId: string; title: string }): void }>(
        rendered
      )
    ) {
      throw new Error('Expected a processes workspace element.')
    }
    rendered.props.onOpenTerminal({ sessionId: 'build', title: 'Build server' })

    expect(openTarget).toHaveBeenCalledWith(
      { type: 'terminal', id: 'terminal:build', title: 'Build server' },
      { panelId: 'right' }
    )
  })
})

function terminalTab(id: string): WorkspaceTabRecord {
  return { id, kind: 'terminal', title: 'Terminal', props: {}, isPreview: false, isClosable: true }
}

function browserTab(id: string): WorkspaceTabRecord {
  return { id, kind: 'browser', title: 'Browser', props: {}, isPreview: false, isClosable: true }
}

function fileTab(id: string, relativePath: string): WorkspaceTabRecord {
  return {
    id,
    kind: 'file',
    title: relativePath || 'Files',
    props: { relativePath },
    isPreview: false,
    isClosable: true
  }
}

function renderContext(
  openTarget: WorkspaceContentRenderContext['openTarget']
): WorkspaceContentRenderContext {
  return {
    ...lifecycleContext,
    panel: {
      id: 'right',
      isOpen: true,
      isMaximized: false,
      size: 400,
      tabIds: ['files:explorer'],
      activeTabId: 'files:explorer',
      activationHistory: ['files:explorer']
    },
    target: undefined,
    onPrepareTask: vi.fn(),
    onCreateOutput: vi.fn(),
    openTarget,
    setTabTitle: vi.fn(),
    setRuntime: vi.fn()
  }
}
