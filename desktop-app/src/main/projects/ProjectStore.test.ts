import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { ProjectStore, type ProjectState } from './ProjectStore'

const storedState: ProjectState = {
  workspaceRootOptions: [],
  localProjects: {
    abc: {
      id: 'abc',
      kind: 'local',
      name: 'desktop-app',
      hostId: 'local',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      writableRoots: ['/repo']
    }
  },
  remoteProjects: [],
  projectOrder: ['abc'],
  pinnedProjectIds: [],
  projectActions: {},
  projectWritableRoots: {},
  threadProjectAssignments: {},
  threadWritableRoots: {},
  threadWorkspaceRootHints: {},
  threadProjectlessOutputDirectories: {},
  projectlessThreadIds: [],
  projectlessHints: {},
  activeLocalProjectId: 'abc',
  activeWorkspaceRoots: ['/repo']
}

function withProjectId(id: string): ProjectState {
  return {
    ...storedState,
    localProjects: {
      [id]: {
        ...storedState.localProjects.abc,
        id
      }
    },
    projectOrder: [id],
    activeLocalProjectId: id
  }
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

describe('ProjectStore', () => {
  it('stores active roots and local projects', async () => {
    const store = ProjectStore.inMemory()

    await store.setState(storedState)

    expect((await store.getState()).activeLocalProjectId).toBe('abc')
    expect((await store.getState()).activeWorkspaceRoots).toEqual(['/repo'])
  })

  it('loads persisted state from disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-store-'))
    const filePath = join(directory, 'projects.json')

    try {
      const store = ProjectStore.onDisk(filePath)
      await store.setState(storedState)

      const reloadedStore = ProjectStore.onDisk(filePath)

      expect(await reloadedStore.getState()).toEqual(storedState)
      await expect(readFile(filePath, 'utf8')).resolves.toContain('"activeLocalProjectId": "abc"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns cloned state snapshots', async () => {
    const store = ProjectStore.inMemory(storedState)

    const state = await store.getState()
    state.activeWorkspaceRoots?.push('/mutated')
    state.localProjects.abc.writableRoots.push('/mutated')

    expect((await store.getState()).activeWorkspaceRoots).toEqual(['/repo'])
    expect((await store.getState()).localProjects.abc.writableRoots).toEqual(['/repo'])
  })

  it('adds an empty action catalog when loading state saved before project actions existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-store-'))
    const filePath = join(directory, 'projects.json')
    const legacyState = { ...storedState }
    delete legacyState.projectActions

    try {
      await writeFile(filePath, JSON.stringify(legacyState), 'utf8')
      const store = ProjectStore.onDisk(filePath)

      await expect(store.getState()).resolves.toMatchObject({ projectActions: {} })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes overlapping disk writes in invocation order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'project-store-'))
    const filePath = join(directory, 'projects.json')
    const firstWrite = createDeferred()
    const startedWrites: string[] = []

    try {
      const store = ProjectStore.onDisk(filePath, {
        writeJsonAtomically: async (targetPath, state) => {
          startedWrites.push(state.activeLocalProjectId ?? '')

          if (state.activeLocalProjectId === 'first') {
            await firstWrite.promise
          }

          await writeFile(targetPath, `${JSON.stringify(state)}\n`, 'utf8')
        }
      })

      const firstSetState = store.setState(withProjectId('first'))
      const secondSetState = store.setState(withProjectId('second'))

      await Promise.resolve()
      expect(startedWrites).toEqual(['first'])

      firstWrite.resolve()
      await Promise.all([firstSetState, secondSetState])

      expect(startedWrites).toEqual(['first', 'second'])
      expect(JSON.parse(await readFile(filePath, 'utf8')).activeLocalProjectId).toBe('second')
    } finally {
      firstWrite.resolve()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
