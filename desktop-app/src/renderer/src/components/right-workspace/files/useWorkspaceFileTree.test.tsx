// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  FileWorkspaceEvent,
  FileWorkspaceListDirectoryResult,
  FileWorkspaceSearchSessionEvent
} from '../../../../../shared/fileWorkspaceApi'
import { useWorkspaceFileTree, type WorkspaceFileTreeController } from './useWorkspaceFileTree'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let controller: WorkspaceFileTreeController | undefined

describe('useWorkspaceFileTree', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    controller = undefined
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads the root and persisted expanded directory ancestors without eager sibling requests', async () => {
    const listDirectory = vi.fn(async ({ path }: { path: string }) => directory(path))
    stubWorkspaceApi({ listDirectory })

    await render({ initialExpandedPaths: ['src/components'] })

    expect(window.desktopApp.workspace.files.prepareRoot).toHaveBeenCalledTimes(1)
    expect(listDirectory.mock.calls.map(([request]) => request.path)).toEqual([
      '',
      'src',
      'src/components'
    ])
  })

  it('deduplicates concurrent requests for the same unloaded directory', async () => {
    let resolveSource: ((result: FileWorkspaceListDirectoryResult) => void) | undefined
    const listDirectory = vi.fn(({ path }: { path: string }) => {
      if (path !== 'src') return Promise.resolve(directory(path))
      return new Promise<FileWorkspaceListDirectoryResult>((resolve) => {
        resolveSource = resolve
      })
    })
    stubWorkspaceApi({ listDirectory })

    await render()
    let requests: Promise<void>[] = []
    act(() => {
      requests = [controller!.ensureDirectory('src'), controller!.ensureDirectory('src')]
    })
    expect(listDirectory.mock.calls.filter(([request]) => request.path === 'src')).toHaveLength(1)

    await act(async () => {
      resolveSource?.(directory('src'))
      await Promise.all(requests)
    })
  })

  it('reveals an active file by loading and expanding its ancestors', async () => {
    const listDirectory = vi.fn(async ({ path }: { path: string }) => directory(path))
    stubWorkspaceApi({ listDirectory })

    await render({ selectedPath: 'src/components/Button.ts' })

    await vi.waitFor(() => {
      expect(listDirectory.mock.calls.map(([request]) => request.path)).toEqual([
        '',
        'src',
        'src/components'
      ])
    })
    expect(controller?.expandedPaths).toEqual(new Set(['src', 'src/components']))
  })

  it('validates and expands a selected directory', async () => {
    const listDirectory = vi.fn(async ({ path }: { path: string }) => directory(path))
    stubWorkspaceApi({ listDirectory })

    await render({ selectedPath: 'src/components', selectedPathIsDirectory: true })

    await vi.waitFor(() => {
      expect(listDirectory.mock.calls.map(([request]) => request.path)).toEqual([
        '',
        'src',
        'src/components'
      ])
    })
    expect(controller?.expandedPaths).toEqual(new Set(['src', 'src/components']))
    expect(controller?.error).toBeUndefined()
  })

  it('reports a controlled error when a selected directory is not a directory', async () => {
    const listDirectory = vi.fn(async ({ path }: { path: string }) => {
      if (path !== 'src/components') return directory(path)
      return {
        version: 1 as const,
        rootId: 'root-1',
        path,
        unavailable: 'not-directory' as const
      }
    })
    stubWorkspaceApi({ listDirectory })

    await render({ selectedPath: 'src/components', selectedPathIsDirectory: true })

    await vi.waitFor(() => {
      expect(controller?.error).toBe('“src/components”不是文件夹。')
    })
    expect(controller?.expandedPaths).toEqual(new Set())
  })

  it('updates one app-server search session without changing the loaded tree', async () => {
    const listDirectory = vi.fn(async ({ path }: { path: string }) => directory(path))
    const updateSearch = vi.fn(async () => undefined)
    stubWorkspaceApi({ listDirectory, updateSearch })

    await render()
    await act(async () => {
      controller?.setSearch('Button')
      await Promise.resolve()
    })

    expect(window.desktopApp.workspace.files.startSearch).toHaveBeenCalledWith({
      version: 1,
      rootId: 'root-1'
    })
    expect(updateSearch).toHaveBeenCalledWith({
      version: 1,
      sessionId: 'search-1',
      query: 'Button'
    })

    await act(async () => {
      controller?.setSearch('')
      await Promise.resolve()
    })
    expect(updateSearch).toHaveBeenLastCalledWith({
      version: 1,
      sessionId: 'search-1',
      query: ''
    })
    expect(listDirectory.mock.calls.map(([request]) => request.path)).toEqual([''])
  })

  it('keeps the latest results visible while the next search query is loading', async () => {
    const listDirectory = vi.fn(async ({ path }: { path: string }) => directory(path))
    let onSearchEvent: ((event: FileWorkspaceSearchSessionEvent) => void) | undefined
    stubWorkspaceApi({
      listDirectory,
      onSearchEvent: vi.fn((listener: (event: FileWorkspaceSearchSessionEvent) => void) => {
        onSearchEvent = listener
        return () => undefined
      })
    })

    await render()
    await act(async () => {
      controller?.setSearch('Button')
      await Promise.resolve()
    })
    await act(async () => {
      onSearchEvent?.({
        version: 1,
        type: 'search-results',
        rootId: 'root-1',
        sessionId: 'search-1',
        query: 'stale',
        matches: [{ path: 'src/stale.ts', kind: 'path' }],
        complete: false
      })
      onSearchEvent?.({
        version: 1,
        type: 'search-results',
        rootId: 'root-1',
        sessionId: 'search-1',
        query: 'Button',
        matches: [{ path: 'src/Button.tsx', kind: 'path' }],
        complete: true
      })
    })

    expect(controller?.searchResult).toEqual({
      query: 'Button',
      matches: [{ path: 'src/Button.tsx', kind: 'path' }]
    })
    expect(controller?.searching).toBe(false)

    await act(async () => {
      controller?.setSearch('Dialog')
      await Promise.resolve()
    })

    expect(controller?.searchResult).toEqual({
      query: 'Button',
      matches: [{ path: 'src/Button.tsx', kind: 'path' }]
    })
    expect(controller?.searching).toBe(true)

    await act(async () => {
      onSearchEvent?.({
        version: 1,
        type: 'search-results',
        rootId: 'root-1',
        sessionId: 'search-1',
        query: 'Dialog',
        matches: [{ path: 'src/Dialog.tsx', kind: 'path' }],
        complete: true
      })
    })

    expect(controller?.searchResult).toEqual({
      query: 'Dialog',
      matches: [{ path: 'src/Dialog.tsx', kind: 'path' }]
    })
    expect(controller?.searching).toBe(false)
  })

  it('coalesces file events into one refresh of the loaded parent directory', async () => {
    vi.useFakeTimers()
    const listDirectory = vi.fn(async ({ path }: { path: string }) => directory(path))
    let onEvent: ((event: FileWorkspaceEvent) => void) | undefined
    stubWorkspaceApi({
      listDirectory,
      onEvent: vi.fn((listener: (event: FileWorkspaceEvent) => void) => {
        onEvent = listener
        return () => undefined
      })
    })

    await render()
    act(() => {
      onEvent?.({ version: 1, type: 'changed', rootId: 'root-1', path: 'README.md' })
      onEvent?.({ version: 1, type: 'changed', rootId: 'root-1', path: 'CHANGELOG.md' })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(listDirectory.mock.calls.map(([request]) => request.path)).toEqual(['', ''])
  })
})

async function render({
  initialExpandedPaths = [],
  selectedPath = '',
  selectedPathIsDirectory = false
}: {
  initialExpandedPaths?: string[]
  selectedPath?: string
  selectedPathIsDirectory?: boolean
} = {}): Promise<void> {
  await act(async () => {
    root.render(
      <Probe
        initialExpandedPaths={initialExpandedPaths}
        selectedPath={selectedPath}
        selectedPathIsDirectory={selectedPathIsDirectory}
        workspaceId="workspace-1"
      />
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function Probe({
  initialExpandedPaths,
  selectedPath,
  selectedPathIsDirectory,
  workspaceId
}: {
  initialExpandedPaths: string[]
  selectedPath: string
  selectedPathIsDirectory: boolean
  workspaceId: string
}): null {
  // eslint-disable-next-line react-hooks/globals -- the probe exposes current hook state to tests.
  controller = useWorkspaceFileTree({
    initialExpandedPaths,
    selectedPath,
    selectedPathIsDirectory,
    target: { conversationId: 'conversation-1' },
    workspaceId
  })
  return null
}

function directory(path: string): FileWorkspaceListDirectoryResult {
  return { entries: [], path, rootId: 'root-1', truncated: false, version: 1 }
}

function stubWorkspaceApi({
  listDirectory,
  onEvent = vi.fn(() => () => undefined),
  onSearchEvent = vi.fn(() => () => undefined),
  updateSearch = vi.fn(async () => undefined)
}: {
  listDirectory: ReturnType<typeof vi.fn>
  onEvent?: ReturnType<typeof vi.fn>
  onSearchEvent?: ReturnType<typeof vi.fn>
  updateSearch?: ReturnType<typeof vi.fn>
}): void {
  vi.stubGlobal('desktopApp', {
    workspace: {
      files: {
        prepareRoot: vi.fn(async () => ({ rootId: 'root-1', label: 'Project files' })),
        listDirectory,
        onEvent,
        search: vi.fn(),
        startSearch: vi.fn(async () => ({ version: 1, rootId: 'root-1', sessionId: 'search-1' })),
        updateSearch,
        stopSearch: vi.fn(async () => undefined),
        onSearchEvent
      }
    }
  })
}
