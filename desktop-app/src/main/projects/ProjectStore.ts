import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ProjectState } from '../../shared/projects/projectTypes'

export type {
  WorkspaceRootOption,
  LocalProject,
  RemoteProject,
  ProjectState
} from '../../shared/projects/projectTypes'

type ProjectStateWriter = (filePath: string, state: ProjectState) => Promise<void>

type ProjectStoreDiskOptions = {
  initialState?: ProjectState
  writeJsonAtomically?: ProjectStateWriter
}

export function createDefaultProjectState(): ProjectState {
  return {
    workspaceRootOptions: [],
    localProjects: {},
    remoteProjects: [],
    projectOrder: [],
    pinnedProjectIds: [],
    projectActions: {},
    projectWritableRoots: {},
    threadProjectAssignments: {},
    threadWritableRoots: {},
    threadWorkspaceRootHints: {},
    threadProjectlessOutputDirectories: {},
    projectlessThreadIds: [],
    projectlessHints: {}
  }
}

function cloneState(state: ProjectState): ProjectState {
  const cloned = JSON.parse(JSON.stringify(state)) as Partial<ProjectState>
  return {
    ...createDefaultProjectState(),
    ...cloned,
    projectActions: cloned.projectActions ?? {}
  }
}

export class ProjectStore {
  private state: ProjectState
  private writeQueue = Promise.resolve()

  private constructor(
    private readonly filePath?: string,
    initialState = createDefaultProjectState(),
    private readonly writeProjectState: ProjectStateWriter = writeJsonAtomically
  ) {
    this.state = cloneState(initialState)
  }

  static inMemory(initialState?: ProjectState): ProjectStore {
    return new ProjectStore(undefined, initialState)
  }

  static onDisk(filePath: string, options?: ProjectState | ProjectStoreDiskOptions): ProjectStore {
    const diskOptions = toDiskOptions(options)

    return new ProjectStore(filePath, diskOptions.initialState, diskOptions.writeJsonAtomically)
  }

  async getState(): Promise<ProjectState> {
    if (!this.filePath) {
      return cloneState(this.state)
    }

    try {
      const contents = await readFile(this.filePath, 'utf8')
      this.state = JSON.parse(contents) as ProjectState
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error
      }
    }

    return cloneState(this.state)
  }

  async setState(state: ProjectState): Promise<void> {
    this.state = cloneState(state)

    if (!this.filePath) {
      return
    }

    const filePath = this.filePath
    const stateToWrite = cloneState(this.state)
    const writeState = (): Promise<void> => this.writeProjectState(filePath, stateToWrite)
    const queuedWrite = this.writeQueue.then(writeState, writeState)
    this.writeQueue = queuedWrite

    await queuedWrite
  }
}

function toDiskOptions(options?: ProjectState | ProjectStoreDiskOptions): ProjectStoreDiskOptions {
  if (!options) {
    return {}
  }

  if (isProjectStoreDiskOptions(options)) {
    return options
  }

  return { initialState: options }
}

function isProjectStoreDiskOptions(
  options: ProjectState | ProjectStoreDiskOptions
): options is ProjectStoreDiskOptions {
  return 'writeJsonAtomically' in options || 'initialState' in options
}

async function writeJsonAtomically(filePath: string, state: ProjectState): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = join(
    directory,
    `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  )

  try {
    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
