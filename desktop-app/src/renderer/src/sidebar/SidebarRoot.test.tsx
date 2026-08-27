// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { SidebarRoot } from './SidebarRoot'
import type { ProjectStateController } from '../projects/useProjectState'
import type { ConversationStateController } from './useConversationState'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@assistant-ui/react', () => ({
  ThreadListPrimitive: {
    New: ({ children }: { children: React.ReactNode }) => (
      <div data-primitive="ThreadList.New">{children}</div>
    )
  }
}))

const projectState: ProjectStateController = {
  state: {
    workspaceRootOptions: [
      {
        root: '/repo/path',
        label: 'Path Repo',
        hostId: 'local',
        addedAt: '2026-06-30T00:00:00.000Z',
        lastOpenedAt: '2026-06-30T00:00:00.000Z'
      }
    ],
    localProjects: {
      local: {
        id: 'local',
        kind: 'local',
        name: 'Desktop App',
        hostId: 'local',
        createdAt: '2026-06-30T00:00:00.000Z',
        updatedAt: '2026-06-30T00:00:00.000Z',
        writableRoots: ['/repo/local']
      }
    },
    remoteProjects: [],
    projectOrder: ['local'],
    pinnedProjectIds: [],
    projectWritableRoots: {},
    threadProjectAssignments: {},
    threadWritableRoots: {},
    threadWorkspaceRootHints: {},
    threadProjectlessOutputDirectories: {},
    projectlessThreadIds: [],
    projectlessHints: {},
    activeProjectSelection: { projectKind: 'local', projectId: 'local' },
    activeWorkspaceRoots: ['/repo/local']
  },
  hasSelection: true,
  currentLabel: 'Desktop App',
  currentDetail: '/repo/local',
  pickWorkspaceRoot: vi.fn(async () => null),
  createBlankProject: vi.fn(),
  createLocalProject: vi.fn(),
  selectProject: vi.fn(async () => undefined),
  renameProject: vi.fn(async () => undefined),
  removeProject: vi.fn(async () => undefined)
}

const conversationState: ConversationStateController = {
  state: {
    loaded: true,
    error: undefined,
    archivedConversationIds: [],
    conversations: [
      {
        id: 'thread-local',
        title: 'Local thread',
        projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/repo/local' },
        updatedAt: '2026-06-30T03:00:00.000Z',
        cwd: '/repo/local'
      },
      {
        id: 'thread-quick',
        title: 'Scratch',
        projectAssignment: {
          projectKind: 'projectless',
          cwd: '/tmp/thread-quick',
          workspaceRoot: '/tmp/thread-quick',
          outputDirectory: '/tmp/thread-quick/out'
        },
        updatedAt: '2026-06-30T04:00:00.000Z',
        cwd: '/tmp/thread-quick'
      }
    ]
  },
  preferences: {
    organizeMode: 'project',
    sortKey: 'updated_at',
    collapsedSectionIds: [],
    collapsedGroupIds: []
  },
  refresh: vi.fn(async () => undefined),
  openConversation: vi.fn(async () => undefined),
  archiveConversation: vi.fn(async () => undefined),
  unarchiveConversation: vi.fn(async () => undefined),
  renameConversation: vi.fn(async () => undefined),
  interruptConversation: vi.fn(async () => undefined),
  setPreferences: vi.fn(async () => undefined)
}

describe('SidebarRoot', () => {
  const onNewChat = vi.fn()

  it('renders primary actions, project groups, and quick chats without archive actions', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
        />
      )
    })

    expect(container.textContent).toContain('新对话')
    const navigationContainer = container.querySelector<HTMLDivElement>(
      '[aria-label="Projects and quick chats"]'
    )
    expect(navigationContainer).not.toBeNull()
    expect(navigationContainer?.getAttribute('data-slot')).toBe('scroll-area')
    expect(navigationContainer?.className).toContain('min-w-0')
    expect(navigationContainer?.className).toContain('overflow-hidden')
    const viewport = navigationContainer?.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).not.toBeNull()
    expect(viewport?.className).toContain('[&>div]:!block')
    expect(
      [...(viewport?.querySelectorAll('div') ?? [])].some(
        (element) => element.className.includes('w-full') && element.className.includes('min-w-0')
      )
    ).toBe(true)
    expect(navigationContainer?.textContent).not.toContain('新对话')
    expect(
      [...container.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Quick chat'
      )
    ).toBe(false)
    const quickChatButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New quick chat"]'
    )
    expect(quickChatButton).not.toBeNull()
    expect(quickChatButton?.className).toContain('opacity-0')
    expect(quickChatButton?.className).toContain('group-hover:opacity-100')
    expect(container.textContent).toContain('Projects')
    expect(navigationContainer?.textContent).toContain('Projects')
    expect(container.querySelector('button[aria-label="Open folder"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="插件"]')).toBeNull()
    expect(container.textContent).toContain('Desktop App')
    expect(container.textContent).toContain('Path Repo')
    const desktopProjectLabel = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Desktop App"]'
    )
    const desktopProjectToggleButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Desktop App"]'
    )
    expect(desktopProjectLabel).not.toBeUndefined()
    expect(desktopProjectLabel?.tagName).toBe('BUTTON')
    expect(desktopProjectLabel?.getAttribute('aria-current')).toBe('page')
    expect(desktopProjectLabel?.className).toContain('px-2')
    expect(desktopProjectLabel?.querySelector('.lucide-folder')).not.toBeNull()
    expect(desktopProjectToggleButton).not.toBeNull()
    expect(
      desktopProjectToggleButton?.querySelector('.lucide-chevron-down')?.getAttribute('class')
    ).toContain('transition-transform')
    expect(desktopProjectLabel?.nextElementSibling).toBe(desktopProjectToggleButton)
    expect(desktopProjectToggleButton?.className).toContain('opacity-0')
    expect(desktopProjectToggleButton?.className).toContain('group-hover:opacity-100')
    const desktopProjectConversations =
      desktopProjectToggleButton?.parentElement?.nextElementSibling
    expect(desktopProjectConversations?.className).toContain(
      'transition-[grid-template-rows,opacity]'
    )
    expect(desktopProjectConversations?.className).toContain('grid-rows-[1fr]')
    const projectChatButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="在 Desktop App 中新对话"]'
    )
    expect(projectChatButton).not.toBeNull()
    expect(projectChatButton?.className).toContain('opacity-0')
    expect(projectChatButton?.className).toContain('group-hover:opacity-100')
    const projectRemoveButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Desktop App"]'
    )
    expect(projectRemoveButton).not.toBeNull()
    expect(projectRemoveButton?.className).toContain('opacity-0')
    expect(projectRemoveButton?.className).toContain('group-hover:opacity-100')
    expect(container.querySelector('button[aria-label="Collapse Path Repo"]')).not.toBeNull()
    expect(container.textContent).not.toContain('/repo/local')
    expect(container.textContent).not.toContain('/repo/path')
    expect(container.textContent).toContain('Local thread')
    expect(container.textContent).toContain('暂无对话')
    expect(container.textContent).toContain('Quick chats')
    expect(navigationContainer?.textContent).toContain('Quick chats')
    expect(container.textContent).toContain('Scratch')
    expect(
      [...container.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Local thread'
      )
    ).toBe(false)
    expect(
      [...container.querySelectorAll('button')].some(
        (candidate) => candidate.textContent?.trim() === 'Scratch'
      )
    ).toBe(false)
    expect(container.textContent).not.toContain('Archive')
    expect(container.querySelector('[aria-label*="Archive"]')).toBeNull()
    expect(container.textContent).not.toContain('Delete')
    root.unmount()
  })

  it('starts a new conversation after the project label is selected', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    vi.mocked(projectState.selectProject).mockClear()
    onNewChat.mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Select Desktop App"]'
    )
    await act(async () => button?.click())

    expect(projectState.selectProject).toHaveBeenCalledWith({
      projectKind: 'local',
      projectId: 'local'
    })
    expect(onNewChat).toHaveBeenCalledOnce()
    root.unmount()
  })

  it('does not render conversation list errors below the new chat action', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const erroredConversationState: ConversationStateController = {
      ...conversationState,
      state: {
        ...conversationState.state,
        error: 'The free quota has been exhausted.'
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={erroredConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    expect(container.textContent).toContain('新对话')
    expect(container.textContent).not.toContain('The free quota has been exhausted.')
    root.unmount()
  })

  it('toggles a project group when the project toggle is clicked', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    vi.mocked(projectState.selectProject).mockClear()
    vi.mocked(conversationState.setPreferences).mockClear()
    onNewChat.mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse Desktop App"]'
    )
    await act(async () => button?.click())

    expect(projectState.selectProject).not.toHaveBeenCalled()
    expect(onNewChat).not.toHaveBeenCalled()
    expect(conversationState.setPreferences).toHaveBeenCalledWith({
      collapsedGroupIds: ['local:local']
    })
    root.unmount()
  })

  it('opens a conversation when its row is clicked', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    vi.mocked(conversationState.openConversation).mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const row = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Scratch')
    )
    await act(async () => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(conversationState.openConversation).toHaveBeenCalledWith({
      conversationId: 'thread-quick'
    })
    root.unmount()
  })

  it('routes project conversation clicks through the app callback when provided', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onOpenConversation = vi.fn()
    vi.mocked(conversationState.openConversation).mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
          onOpenConversation={onOpenConversation}
        />
      )
    })

    const row = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('Local thread')
    )
    await act(async () => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(onOpenConversation).toHaveBeenCalledWith('thread-local')
    expect(conversationState.openConversation).not.toHaveBeenCalled()
    root.unmount()
  })

  it('shows a spinning loading icon instead of an interrupt button for running conversations', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const runningConversationState: ConversationStateController = {
      ...conversationState,
      state: {
        ...conversationState.state,
        conversations: [
          ...conversationState.state.conversations,
          {
            id: 'thread-running',
            title: 'Running thread',
            projectAssignment: {
              projectKind: 'projectless',
              cwd: '/tmp/thread-running',
              workspaceRoot: '/tmp/thread-running',
              outputDirectory: '/tmp/thread-running/out'
            },
            updatedAt: '2026-06-30T05:00:00.000Z',
            cwd: '/tmp/thread-running',
            running: true
          }
        ]
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={runningConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    expect(container.querySelector('[aria-label="Interrupt Running thread"]')).toBeNull()
    const runningRow = container.querySelector('[aria-label="Running thread, running"]')
    const loaderIcon = runningRow?.querySelector('.lucide-loader')
    expect(runningRow?.tagName).toBe('BUTTON')
    expect(loaderIcon).not.toBeNull()
    expect(loaderIcon?.getAttribute('class')).toContain('animate-spin')
    root.unmount()
  })

  it('starts a new runtime conversation from the primary action', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    onNewChat.mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === '新对话'
    )
    await act(async () => button?.click())

    expect(onNewChat).toHaveBeenCalledOnce()
    root.unmount()
  })

  it('opens the plugin center from the primary action without starting a chat', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onOpenPlugins = vi.fn()
    onNewChat.mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
          onOpenPlugins={onOpenPlugins}
          pluginsActive
        />
      )
    })

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === '插件'
    )
    await act(async () => button?.click())

    expect(button?.getAttribute('aria-current')).toBe('page')
    expect(button?.getAttribute('aria-label')).toBe('插件')
    expect(button?.getAttribute('title')).toBe('插件')
    expect(onOpenPlugins).toHaveBeenCalledOnce()
    expect(onNewChat).not.toHaveBeenCalled()
    root.unmount()
  })

  it('starts a projectless runtime conversation from the quick chats action', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    onNewChat.mockClear()
    vi.mocked(projectState.selectProject).mockClear()

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={conversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New quick chat"]')
    await act(async () => button?.click())

    expect(onNewChat).toHaveBeenCalledOnce()
    expect(projectState.selectProject).toHaveBeenCalledWith({ projectKind: 'projectless' })
    root.unmount()
  })
})
