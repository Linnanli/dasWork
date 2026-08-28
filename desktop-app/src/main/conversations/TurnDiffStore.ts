import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type PersistedTurnDiff = {
  threadId: string
  turnId: string
  diff: string
}

type StoredTurnDiff = PersistedTurnDiff & {
  version: 1
}

export type TurnDiffStoreReader = {
  readMany(threadId: string, turnIds: readonly string[]): Promise<Map<string, string>>
}

export type TurnDiffStoreLookup = {
  read(threadId: string, turnId: string): Promise<string | undefined>
}

export type TurnDiffStoreWriter = {
  save(turnDiff: PersistedTurnDiff): Promise<void>
}

export type TurnDiffStoreRemover = {
  removeThread(threadId: string): Promise<void>
}

export class TurnDiffStore
  implements TurnDiffStoreLookup, TurnDiffStoreReader, TurnDiffStoreWriter, TurnDiffStoreRemover
{
  constructor(private readonly rootPath: string) {}

  async save(turnDiff: PersistedTurnDiff): Promise<void> {
    const filePath = this.filePath(turnDiff.threadId, turnDiff.turnId)
    await writeJsonAtomically(filePath, { version: 1, ...turnDiff })
  }

  async readMany(threadId: string, turnIds: readonly string[]): Promise<Map<string, string>> {
    const entries = await Promise.all(
      turnIds.map(async (turnId): Promise<readonly [string, string] | undefined> => {
        const diff = await this.read(threadId, turnId)
        return diff === undefined ? undefined : [turnId, diff]
      })
    )
    const persistedEntries = entries.filter(
      (entry): entry is readonly [string, string] => entry !== undefined
    )
    return new Map(persistedEntries)
  }

  async read(threadId: string, turnId: string): Promise<string | undefined> {
    try {
      const value = JSON.parse(await readFile(this.filePath(threadId, turnId), 'utf8')) as unknown
      return isStoredTurnDiff(value, threadId, turnId) ? value.diff : undefined
    } catch (error) {
      if (isFileNotFoundError(error) || error instanceof SyntaxError) return undefined
      throw error
    }
  }

  async removeThread(threadId: string): Promise<void> {
    await rm(join(this.rootPath, stableId(threadId)), { recursive: true, force: true })
  }

  private filePath(threadId: string, turnId: string): string {
    return join(this.rootPath, stableId(threadId), `${stableId(turnId)}.json`)
  }
}

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isStoredTurnDiff(
  value: unknown,
  threadId: string,
  turnId: string
): value is StoredTurnDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record['version'] === 1 &&
    record['threadId'] === threadId &&
    record['turnId'] === turnId &&
    typeof record['diff'] === 'string'
  )
}

async function writeJsonAtomically(filePath: string, value: StoredTurnDiff): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = join(
    directory,
    `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  )

  try {
    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, 'utf8')
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
