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
  createRemoteProject: vi.fn(),
  listWorktrees: vi.fn(async () => []),
  selectWorktree: vi.fn(async () => undefined),
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
    collapsedGroupIds: [],
    pinnedConversationIds: []
  },
  refresh: vi.fn(async () => undefined),
  openConversation: vi.fn(async () => undefined),
  archiveConversation: vi.fn(async () => undefined),
  unarchiveConversation: vi.fn(async () => undefined),
  deleteConversation: vi.fn(async () => undefined),
  deleteArchivedConversations: vi.fn(async () => undefined),
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

  it('focuses task search when requested by the command palette', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
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

    const taskSearch = container.querySelector<HTMLInputElement>('input[aria-label="搜索所有任务"]')
    expect(taskSearch).not.toBeNull()

    await act(async () => window.dispatchEvent(new Event('dascowork:focus-task-search')))

    expect(document.activeElement).toBe(taskSearch)
    root.unmount()
    container.remove()
  })

  it('filters the archived task drawer without hiding its restore controls', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const archivedConversationState: ConversationStateController = {
      ...conversationState,
      state: {
        ...conversationState.state,
        archivedConversationIds: ['thread-archive-refactor', 'thread-archive-notes'],
        conversations: [
          ...conversationState.state.conversations,
          {
            id: 'thread-archive-refactor',
            threadId: 'thread-archive-refactor',
            title: 'Refactor archived workspace',
            archived: true,
            threadSource: 'automation',
            projectAssignment: {
              projectKind: 'local',
              projectId: 'local',
              cwd: '/repo/workspace'
            },
            cwd: '/repo/workspace'
          },
          {
            id: 'thread-archive-notes',
            title: 'Release notes',
            archived: true,
            projectAssignment: {
              projectKind: 'projectless',
              cwd: '/repo/notes',
              workspaceRoot: '/repo/notes',
              outputDirectory: '/repo/notes/out'
            },
            cwd: '/repo/notes'
          }
        ]
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={archivedConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const archivedDrawer = container.querySelector<HTMLElement>('[data-slot="archived-chats"]')
    const search = archivedDrawer?.querySelector<HTMLInputElement>(
      'input[aria-label="搜索已归档任务"]'
    )
    const projectFilter = archivedDrawer?.querySelector<HTMLSelectElement>(
      'select[aria-label="筛选归档任务项目"]'
    )
    const typeFilter = archivedDrawer?.querySelector<HTMLSelectElement>(
      'select[aria-label="筛选归档任务类型"]'
    )
    expect(archivedDrawer?.textContent).toContain('已归档任务 (2)')
    expect(search).not.toBeNull()
    expect(projectFilter).not.toBeNull()
    expect(typeFilter).not.toBeNull()
    expect(
      [...((projectFilter?.options ?? []) as HTMLOptionsCollection)].map((option) => option.value)
    ).toEqual(['all', 'local:local', 'projectless'])
    expect(archivedDrawer?.textContent).toContain('Refactor archived workspace')
    expect(archivedDrawer?.textContent).toContain('Release notes')
    expect(archivedDrawer?.textContent).toContain('Desktop App (1)')
    expect(archivedDrawer?.textContent).toContain('临时任务 (1)')

    await act(async () => {
      if (projectFilter) {
        projectFilter.value = 'local:local'
        projectFilter.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    expect(archivedDrawer?.textContent).toContain('Refactor archived workspace')
    expect(archivedDrawer?.textContent).not.toContain('Release notes')

    await act(async () => {
      if (typeFilter) {
        typeFilter.value = 'automation'
        typeFilter.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    expect(archivedDrawer?.textContent).toContain('Refactor archived workspace')
    expect(archivedDrawer?.textContent).not.toContain('Release notes')

    await act(async () => {
      if (search) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(search, 'workspace')
        search.dispatchEvent(new Event('input', { bubbles: true }))
        search.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })

    expect(archivedDrawer?.textContent).toContain('Refactor archived workspace')
    expect(archivedDrawer?.textContent).not.toContain('Release notes')
    root.unmount()
  })

  it('shows archived tasks in pages for a large project archive', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const archivedConversations = Array.from({ length: 51 }, (_, index) => ({
      id: `thread-archive-large-${index}`,
      title: `Archived large ${index}`,
      archived: true,
      projectAssignment: { projectKind: 'local' as const, projectId: 'local', cwd: '/repo/local' }
    }))
    const archivedConversationState: ConversationStateController = {
      ...conversationState,
      state: {
        ...conversationState.state,
        archivedConversationIds: archivedConversations.map((conversation) => conversation.id),
        conversations: [...conversationState.state.conversations, ...archivedConversations]
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={archivedConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    expect(container.querySelectorAll('button[aria-label^="Archived large"]').length).toBe(50)
    const showMore = container.querySelector<HTMLButtonElement>(
      'button[aria-label="显示更多归档任务：Desktop App"]'
    )
    expect(showMore?.textContent).toContain('剩余 1')

    await act(async () => showMore?.click())

    expect(container.querySelectorAll('button[aria-label^="Archived large"]').length).toBe(51)
    expect(container.querySelector('button[aria-label="显示更多归档任务：Desktop App"]')).toBeNull()
    root.unmount()
  })

  it('confirms before permanently deleting every archived task in a project', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const deleteArchivedConversations = vi.fn(async () => undefined)
    const archivedConversationState: ConversationStateController = {
      ...conversationState,
      deleteArchivedConversations,
      state: {
        ...conversationState.state,
        archivedConversationIds: ['thread-archive-a', 'thread-archive-b'],
        conversations: [
          ...conversationState.state.conversations,
          {
            id: 'thread-archive-a',
            title: 'Archived A',
            archived: true,
            projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/repo/local' }
          },
          {
            id: 'thread-archive-b',
            title: 'Archived B',
            archived: true,
            projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/repo/local' }
          }
        ]
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={archivedConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const clearProjectArchive = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '清空项目归档'
    )
    act(() => clearProjectArchive?.click())

    expect(document.body.textContent).toContain('此操作无法恢复')
    const confirm = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === '永久删除'
    )
    await act(async () => confirm?.click())

    expect(deleteArchivedConversations).toHaveBeenCalledWith({
      conversationIds: ['thread-archive-a', 'thread-archive-b']
    })
    root.unmount()
  })

  it('keeps the batch-delete confirmation open when deletion fails', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const archivedConversationState: ConversationStateController = {
      ...conversationState,
      deleteArchivedConversations: vi.fn(async () => {
        throw new Error('任务仍在运行，无法永久删除。')
      }),
      state: {
        ...conversationState.state,
        archivedConversationIds: ['thread-archive-a'],
        conversations: [
          ...conversationState.state.conversations,
          {
            id: 'thread-archive-a',
            title: 'Archived A',
            archived: true,
            projectAssignment: { projectKind: 'local', projectId: 'local', cwd: '/repo/local' }
          }
        ]
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={archivedConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const clearProjectArchive = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '清空项目归档'
    )
    act(() => clearProjectArchive?.click())
    const confirm = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent === '永久删除'
    )
    await act(async () => confirm?.click())

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('任务仍在运行')
    expect(document.body.textContent).toContain('永久删除项目归档任务？')
    root.unmount()
  })

  it('searches tasks across projects and includes archived tasks', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const searchableConversationState: ConversationStateController = {
      ...conversationState,
      state: {
        ...conversationState.state,
        archivedConversationIds: ['thread-archive-notes'],
        conversations: [
          ...conversationState.state.conversations,
          {
            id: 'thread-archive-notes',
            title: 'Release notes',
            archived: true,
            projectAssignment: {
              projectKind: 'projectless',
              cwd: '/tmp/release-notes',
              workspaceRoot: '/tmp/release-notes',
              outputDirectory: '/tmp/release-notes/out'
            }
          }
        ]
      }
    }

    await act(async () => {
      root.render(
        <SidebarRoot
          nativeBackdrop={false}
          projectState={projectState}
          conversationState={searchableConversationState}
          onNewChat={onNewChat}
        />
      )
    })

    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索所有任务"]')
    expect(search).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(search, 'release')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
      search?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const results = container.querySelector<HTMLElement>(
      '[data-slot="sidebar-task-search-results"]'
    )
    expect(results?.textContent).toContain('Release notes')
    expect(results?.textContent).not.toContain('Local thread')
    expect(results?.textContent).toContain('已归档临时任务')
    root.unmount()
  })
})
