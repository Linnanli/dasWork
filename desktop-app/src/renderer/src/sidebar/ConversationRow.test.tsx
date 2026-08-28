// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { ConversationRow } from './ConversationRow'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('ConversationRow', () => {
  it('combines running, unread, attention, and active state accessibly', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onOpen = vi.fn()
    act(() => {
      root.render(
        <ConversationRow
          conversation={{
            id: 'thread-a',
            title: 'Conversation A',
            active: true,
            attention: true,
            running: true,
            unread: true
          }}
          nativeBackdrop={false}
          onOpenConversation={onOpen}
        />
      )
    })

    const row = container.querySelector('button')
    expect(row?.getAttribute('aria-current')).toBe('page')
    expect(row?.getAttribute('aria-label')).toBe('Conversation A, running, unread, needs attention')
    expect(row?.className).toContain('w-full')
    expect(row?.textContent).toContain('Conversation A')
    expect(row?.querySelector('span')?.className).toContain('w-full')
    expect(row?.querySelector('span')?.className).toContain('truncate')
    expect(row?.querySelector('.lucide-loader')).not.toBeNull()

    act(() => row?.click())
    expect(onOpen).toHaveBeenCalledOnce()
    root.unmount()
  })

  it('labels automation tasks without treating other thread sources as automation', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <ConversationRow
          conversation={{
            id: 'automation-thread',
            title: 'Daily status',
            archived: true,
            threadSource: 'automation'
          }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })

    expect(
      container.querySelector('[data-slot="conversation-automation-badge"]')?.textContent
    ).toBe('自动化')
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Daily status, automation'
    )

    root.unmount()
  })

  it('provides archive, pin, and copy actions from a separate overflow button', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const actions = {
      archiveConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      togglePinnedConversation: vi.fn(async () => undefined)
    }

    await act(async () => {
      root.render(
        <ConversationRow
          actions={actions}
          conversation={{
            id: 'thread-a',
            title: 'Conversation A',
            active: true,
            cwd: '/repo/app'
          }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="更多操作：Conversation A"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    const archive = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes('归档任务')
    )
    expect(archive).toBeTruthy()
    await act(async () => archive?.click())
    expect(actions.archiveConversation).toHaveBeenCalledWith('thread-a', true)

    root.unmount()
  })

  it('keeps actions available for a running background conversation', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const actions = {
      archiveConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      togglePinnedConversation: vi.fn(async () => undefined)
    }

    await act(async () => {
      root.render(
        <ConversationRow
          actions={actions}
          conversation={{ id: 'thread-running', title: 'Running task', running: true }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="更多操作：Running task"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    const archive = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes('归档任务')
    )
    await act(async () => archive?.click())
    expect(actions.archiveConversation).toHaveBeenCalledWith('thread-running', false)

    root.unmount()
  })

  it('creates a local scheduled task from the conversation menu', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const create = vi.fn(async () => ({ id: 'automation-1' }))
    window.desktopApp = {
      automations: {
        list: vi.fn(async () => []),
        create,
        update: vi.fn(),
        setStatus: vi.fn(),
        remove: vi.fn(),
        runNow: vi.fn()
      }
    } as never
    const actions = {
      archiveConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      togglePinnedConversation: vi.fn(async () => undefined)
    }

    await act(async () => {
      root.render(
        <ConversationRow
          actions={actions}
          conversation={{
            id: 'thread-schedule',
            threadId: 'thread-schedule',
            title: 'Weekly report'
          }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="更多操作：Weekly report"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const schedule = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes('创建或管理定时任务')
    )
    await act(async () => schedule?.click())
    const createButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('创建定时任务')
    )
    await act(async () => createButton?.click())
    root.unmount()

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceConversationId: 'thread-schedule',
        sourceThreadId: 'thread-schedule',
        title: 'Weekly report 定时任务',
        prompt: '继续处理“Weekly report”中的工作，并汇报最新进展。',
        schedule: { kind: 'daily', time: '09:00' }
      })
    )
  })

  it('opens a task in a separate window only when the desktop capability is available', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const actions = {
      archiveConversation: vi.fn(async () => undefined),
      openConversationInNewWindow: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      togglePinnedConversation: vi.fn(async () => undefined)
    }

    await act(async () => {
      root.render(
        <ConversationRow
          actions={actions}
          conversation={{ id: 'thread-window', title: 'Window task' }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="更多操作：Window task"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const openInNewWindow = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ].find((item) => item.textContent?.includes('在新窗口打开'))

    await act(async () => openInNewWindow?.click())

    expect(actions.openConversationInNewWindow).toHaveBeenCalledWith('thread-window')
    root.unmount()
  })

  it('offers restore for an archived conversation', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const actions = {
      archiveConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      deleteConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      togglePinnedConversation: vi.fn(async () => undefined)
    }

    await act(async () => {
      root.render(
        <ConversationRow
          actions={actions}
          conversation={{ id: 'thread-archived', title: 'Archived task', archived: true }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="更多操作：Archived task"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    const restore = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes('恢复任务')
    )
    expect(restore).toBeTruthy()
    await act(async () => restore?.click())
    expect(actions.unarchiveConversation).toHaveBeenCalledWith('thread-archived')

    root.unmount()
  })

  it('requires a confirmation before permanently deleting an archived conversation', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const actions = {
      archiveConversation: vi.fn(async () => undefined),
      unarchiveConversation: vi.fn(async () => undefined),
      deleteConversation: vi.fn(async () => undefined),
      renameConversation: vi.fn(async () => undefined),
      togglePinnedConversation: vi.fn(async () => undefined)
    }

    await act(async () => {
      root.render(
        <ConversationRow
          actions={actions}
          conversation={{ id: 'thread-delete', title: 'Remove me', archived: true }}
          nativeBackdrop={false}
          onOpenConversation={vi.fn()}
        />
      )
    })

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="更多操作：Remove me"]'
    )
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    })
    const deleteMenuItem = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ].find((item) => item.textContent?.includes('永久删除'))
    await act(async () => deleteMenuItem?.click())

    const dialog = document.body.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('此操作无法撤销')
    expect(dialog?.textContent).toContain('工作文件不会被删除')
    const confirm = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.includes('永久删除')
    )
    await act(async () => confirm?.click())

    expect(actions.deleteConversation).toHaveBeenCalledWith('thread-delete')
    root.unmount()
  })
})
