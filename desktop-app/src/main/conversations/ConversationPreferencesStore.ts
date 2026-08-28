import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { SidebarPreferences } from '../../shared/codexIpcApi'

export const defaultConversationPreferences: SidebarPreferences = {
  organizeMode: 'project',
  sortKey: 'updated_at',
  collapsedSectionIds: [],
  collapsedGroupIds: [],
  pinnedConversationIds: []
}

export class ConversationPreferencesStore {
  private preferences: SidebarPreferences
  private writeQueue = Promise.resolve()

  private constructor(
    private readonly filePath: string | undefined,
    initialPreferences = defaultConversationPreferences
  ) {
    this.preferences = normalizePreferences(initialPreferences)
  }

  static inMemory(initialPreferences?: Partial<SidebarPreferences>): ConversationPreferencesStore {
    return new ConversationPreferencesStore(undefined, {
      ...defaultConversationPreferences,
      ...initialPreferences
    })
  }

  static onDisk(filePath: string): ConversationPreferencesStore {
    return new ConversationPreferencesStore(filePath)
  }

  async get(): Promise<SidebarPreferences> {
    if (!this.filePath) return clonePreferences(this.preferences)

    try {
      this.preferences = normalizePreferences(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error
    }

    return clonePreferences(this.preferences)
  }

  async set(preferences: SidebarPreferences): Promise<void> {
    this.preferences = normalizePreferences(preferences)
    if (!this.filePath) return

    const filePath = this.filePath
    const nextPreferences = clonePreferences(this.preferences)
    const write = (): Promise<void> => writeJsonAtomically(filePath, nextPreferences)
    const queuedWrite = this.writeQueue.then(write, write)
    this.writeQueue = queuedWrite
    await queuedWrite
  }
}

function normalizePreferences(value: Partial<SidebarPreferences>): SidebarPreferences {
  return {
    organizeMode: value.organizeMode ?? defaultConversationPreferences.organizeMode,
    sortKey: value.sortKey ?? defaultConversationPreferences.sortKey,
    collapsedSectionIds: uniqueIds(value.collapsedSectionIds),
    collapsedGroupIds: uniqueIds(value.collapsedGroupIds),
    pinnedConversationIds: uniqueIds(value.pinnedConversationIds)
  }
}

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    )
  ]
}

function clonePreferences(value: SidebarPreferences): SidebarPreferences {
  return {
    ...value,
    collapsedSectionIds: [...value.collapsedSectionIds],
    collapsedGroupIds: [...value.collapsedGroupIds],
    pinnedConversationIds: [...value.pinnedConversationIds]
  }
}

async function writeJsonAtomically(
  filePath: string,
  preferences: SidebarPreferences
): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = join(
    directory,
    `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  )

  try {
    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
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
