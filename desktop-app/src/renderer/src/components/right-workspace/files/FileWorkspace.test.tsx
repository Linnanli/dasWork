// @vitest-environment jsdom

import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileWorkspaceListDirectoryResult } from '../../../../../shared/fileWorkspaceApi'
import { FileWorkspace } from './FileWorkspace'
import { codePreviewSelectionForLocation } from './workspaceFileLocation'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
type ReadFileResult = Awaited<ReturnType<typeof window.desktopApp.workspace.files.readFile>>

describe('FileWorkspace', () => {
  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {
          return undefined
        }
        unobserve(): void {
          return undefined
        }
        disconnect(): void {
          return undefined
        }
      }
    )
    vi.stubGlobal('desktopApp', {
      workspace: {
        files: {
          prepareRoot: vi.fn(async () => ({ rootId: 'root-1', label: 'Project files' })),
          listDirectory: vi.fn(async () => ({ entries: [] })),
          readFile: vi.fn(),
          search: vi.fn(async () => ({ matches: [] })),
          startSearch: vi.fn(async () => ({
            version: 1,
            rootId: 'root-1',
            sessionId: 'search-1'
          })),
          updateSearch: vi.fn(async () => undefined),
          stopSearch: vi.fn(async () => undefined),
          openWithSystem: vi.fn(async () => undefined),
          onEvent: vi.fn(() => () => undefined),
          onSearchEvent: vi.fn(() => () => undefined)
        }
      }
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('shows the file tree by default without requiring RightWorkspaceProvider', async () => {
    window.desktopApp.workspace.files.listDirectory = vi.fn(async () => ({
      version: 1 as const,
      rootId: 'root-1',
      path: '',
      entries: [
        { name: 'README.md', path: 'README.md', kind: 'file' as const, size: 1, mtimeMs: 0 },
        { name: 'src', path: 'src', kind: 'directory' as const, size: 0, mtimeMs: 0 }
      ],
      truncated: false
    }))
    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    expect(container.querySelector('input[placeholder="筛选文件…"]')).not.toBeNull()
    expect(container.textContent).toContain('只读预览')
    await vi.waitFor(() => expect(container.querySelector('file-tree-container')).not.toBeNull())
    const fileTree = container.querySelector('file-tree-container')
    const fileTreeViewport = fileTree?.parentElement?.parentElement
    expect(fileTreeViewport?.classList.contains('flex')).toBe(true)
    expect(window.desktopApp.workspace.files.listDirectory).toHaveBeenCalledWith({
      version: 1,
      rootId: 'root-1',
      path: ''
    })
  })

  it('keeps the file tree visible when the parent workspace is narrow', async () => {
    await act(async () => {
      container.style.width = '320px'
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
    })

    expect(container.querySelector('input[placeholder="筛选文件…"]')).not.toBeNull()
  })

  it('keeps a directory expanded after its children finish loading', async () => {
    let resolveSource: ((result: FileWorkspaceListDirectoryResult) => void) | undefined
    window.desktopApp.workspace.files.listDirectory = vi.fn(({ path }: { path?: string }) => {
      if (path === '') {
        return Promise.resolve({
          version: 1 as const,
          rootId: 'root-1',
          path: '',
          entries: [{ name: 'src', path: 'src', kind: 'directory' as const, size: 0, mtimeMs: 0 }],
          truncated: false
        })
      }
      return new Promise<FileWorkspaceListDirectoryResult>((resolve) => {
        resolveSource = resolve
      })
    })

    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const fileTree = await waitForFileTree()
    const sourceRow = await waitForTreeRow(fileTree, 'src/')
    await act(async () => {
      sourceRow.click()
      await Promise.resolve()
    })
    expect(sourceRow.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      resolveSource?.({
        version: 1,
        rootId: 'root-1',
        path: 'src',
        entries: [
          {
            name: 'index.ts',
            path: 'src/index.ts',
            kind: 'file',
            size: 1,
            mtimeMs: 0
          }
        ],
        truncated: false
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    await vi.waitFor(() => {
      expect(currentTreeRow('src/')?.getAttribute('aria-expanded')).toBe('true')
      expect(currentTreeRow('src/index.ts')).not.toBeNull()
    })
  })

  it('renders matching files in a tree with their directory hierarchy', async () => {
    let onSearchEvent: Parameters<typeof window.desktopApp.workspace.files.onSearchEvent>[0] = () =>
      undefined
    window.desktopApp.workspace.files.onSearchEvent = vi.fn((listener) => {
      onSearchEvent = listener
      return () => undefined
    })
    window.desktopApp.workspace.files.updateSearch = vi.fn(async (request) => {
      if (request.query !== 'index.ts') return
      onSearchEvent({
        version: 1,
        type: 'search-results',
        rootId: 'root-1',
        sessionId: request.sessionId,
        query: request.query,
        matches: [{ path: 'src/components/index.ts', kind: 'path' as const, preview: 'index.ts' }],
        complete: true
      })
    })

    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
    })

    const search = container.querySelector<HTMLInputElement>('input[placeholder="筛选文件…"]')
    expect(search).not.toBeNull()
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(search, 'index.ts')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(window.desktopApp.workspace.files.updateSearch).toHaveBeenCalledWith({
        version: 1,
        sessionId: 'search-1',
        query: 'index.ts'
      })
      expect(currentTreeRow('src/components/index.ts')).not.toBeNull()
    })

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(search, 'pending.ts')
      search!.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await vi.waitFor(() => {
      expect(window.desktopApp.workspace.files.updateSearch).toHaveBeenLastCalledWith({
        version: 1,
        sessionId: 'search-1',
        query: 'pending.ts'
      })
      expect(currentTreeRow('src/components/index.ts')).not.toBeNull()
      expect(container.textContent).not.toContain('正在搜索文件')
    })
  })

  it('shows a quiet text status before the first search result arrives', async () => {
    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
    })

    const search = container.querySelector<HTMLInputElement>('input[placeholder="筛选文件…"]')
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(search, 'loading')
      search?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    await vi.waitFor(() => expect(container.textContent).toContain('正在搜索文件'))
    const status = container.querySelector<HTMLElement>('[role="status"]')
    expect(status?.classList.contains('text-left')).toBe(true)
    expect(status?.querySelector('.animate-spin')).toBeNull()
  })

  it('shows a retry action instead of a blank tree when the project root cannot be read', async () => {
    const prepareRoot = vi.fn().mockRejectedValue(new Error('项目目录暂时不可用。'))
    window.desktopApp.workspace.files.prepareRoot = prepareRoot

    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('无法显示文件树')
      expect(container.textContent).toContain('项目目录暂时不可用。')
    })
    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重新尝试读取文件')
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(prepareRoot).toHaveBeenCalledTimes(2))
  })

  it('persists an explicit file-tree close', async () => {
    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
    })

    const toggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('文件树')
    )
    expect(toggle).toBeDefined()

    await act(async () => {
      toggle?.click()
    })

    expect(container.querySelector('input[placeholder="筛选文件…"]')).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(container)
    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
    })

    expect(container.querySelector('input[placeholder="筛选文件…"]')).toBeNull()
  })

  it('clears preview loading when a pending file selection is cleared', async () => {
    let resolveRead: ((result: ReadFileResult) => void) | undefined
    window.desktopApp.workspace.files.readFile = vi.fn(
      () =>
        new Promise<ReadFileResult>((resolve) => {
          resolveRead = resolve
        })
    )
    const selectedFileProps = baseProps()
    selectedFileProps.tab = {
      ...selectedFileProps.tab,
      relativePath: 'README.md'
    }

    await act(async () => {
      root.render(<FileWorkspace {...selectedFileProps} />)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('正在读取文件')

    await act(async () => {
      root.render(<FileWorkspace {...baseProps()} />)
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('正在读取文件')
    expect(container.textContent).toContain('从右侧文件树选择一个文件。')
    resolveRead?.({
      version: 1,
      rootId: 'root-1',
      entry: { name: 'README.md', path: 'README.md', kind: 'file', size: 0, mtimeMs: 0 },
      content: { kind: 'text', encoding: 'utf8', text: '' }
    })
  })

  it('renders code files with the Pierre file renderer', async () => {
    window.desktopApp.workspace.files.readFile = vi.fn(async () => ({
      version: 1 as const,
      rootId: 'root-1',
      entry: {
        name: 'example.ts',
        path: 'src/example.ts',
        kind: 'file' as const,
        size: 22,
        mtimeMs: 0
      },
      content: {
        kind: 'text' as const,
        encoding: 'utf8' as const,
        text: 'export const value = 1\n'
      }
    }))
    const selectedFileProps = baseProps()
    selectedFileProps.tab = {
      ...selectedFileProps.tab,
      relativePath: 'src/example.ts',
      title: 'example.ts'
    }

    await act(async () => {
      root.render(
        <StrictMode>
          <FileWorkspace {...selectedFileProps} />
        </StrictMode>
      )
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    await vi.waitFor(() => {
      const preview = container.querySelector('[data-workspace-code-preview="pierre"]')
      const diffsContainer = preview?.querySelector('diffs-container')
      expect(preview).not.toBeNull()
      expect(diffsContainer?.shadowRoot?.querySelector('pre')).not.toBeNull()
      expect(diffsContainer?.shadowRoot?.textContent).toContain('export const value = 1')
      expect(container.querySelector('.cm-editor')).toBeNull()
    })
  })

  it('scrolls to a requested line after the Pierre file renderer completes', async () => {
    const scrollTo = vi.fn()
    const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo,
      writable: true
    })
    window.desktopApp.workspace.files.readFile = vi.fn(async () => ({
      version: 1 as const,
      rootId: 'root-1',
      entry: {
        name: 'example.ts',
        path: 'src/example.ts',
        kind: 'file' as const,
        size: 128,
        mtimeMs: 0
      },
      content: {
        kind: 'text' as const,
        encoding: 'utf8' as const,
        text: Array.from({ length: 12 }, (_value, index) => `const line${index + 1} = true`).join(
          '\n'
        )
      }
    }))
    const selectedFileProps = baseProps()
    selectedFileProps.tab = {
      ...selectedFileProps.tab,
      relativePath: 'src/example.ts',
      title: 'example.ts',
      location: { line: 6 }
    }

    try {
      await act(async () => {
        root.render(<FileWorkspace {...selectedFileProps} />)
        await Promise.resolve()
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })

      await vi.waitFor(() => {
        expect(scrollTo).toHaveBeenCalledWith({ behavior: 'instant', top: 110 })
      })
    } finally {
      if (originalScrollTo) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
      } else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
    }
  })

  it('clamps a requested code location and clears selection when none is requested', () => {
    expect(
      codePreviewSelectionForLocation({ line: 99, endLine: 101 }, 'first\nsecond\nthird')
    ).toEqual({
      start: 3,
      end: 3
    })
    expect(
      codePreviewSelectionForLocation({ line: 2, endLine: 3 }, 'first\nsecond\nthird')
    ).toEqual({
      start: 2,
      end: 3
    })
    expect(codePreviewSelectionForLocation(undefined, 'first\nsecond')).toBeUndefined()
  })
})

function baseProps(): Parameters<typeof FileWorkspace>[0] {
  return {
    tab: { id: 'file:readme', type: 'file', title: 'README.md', relativePath: '' },
    workspaceId: 'workspace-1',
    target: { conversationId: 'conversation-1', threadId: 'thread-1' },
    onOpenFile: vi.fn()
  }
}

async function waitForFileTree(): Promise<HTMLElement> {
  await vi.waitFor(() => expect(container.querySelector('file-tree-container')).not.toBeNull())
  return container.querySelector<HTMLElement>('file-tree-container')!
}

async function waitForTreeRow(fileTree: HTMLElement, path: string): Promise<HTMLButtonElement> {
  await vi.waitFor(() => expect(treeRow(fileTree, path)).not.toBeNull())
  return treeRow(fileTree, path)!
}

function treeRow(fileTree: HTMLElement, path: string): HTMLButtonElement | null {
  return (
    fileTree.shadowRoot?.querySelector<HTMLButtonElement>(
      `button[role="treeitem"][data-item-path="${path}"]`
    ) ?? null
  )
}

function currentTreeRow(path: string): HTMLButtonElement | null {
  const fileTree = container.querySelector<HTMLElement>('file-tree-container')
  return fileTree ? treeRow(fileTree, path) : null
}
