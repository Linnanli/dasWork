import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  defaultKeyboardShortcutConfig,
  keyboardShortcutConfigSchema,
  type KeyboardShortcutConfig,
  type KeyboardShortcutUpdateRequest
} from '../../shared/keyboardShortcutsApi'

export class KeyboardShortcutService {
  private config: KeyboardShortcutConfig = cloneConfig(defaultKeyboardShortcutConfig)
  private writeQueue = Promise.resolve()

  private constructor(private readonly filePath: string | undefined) {}

  static inMemory(): KeyboardShortcutService {
    return new KeyboardShortcutService(undefined)
  }

  static onDisk(filePath: string): KeyboardShortcutService {
    return new KeyboardShortcutService(filePath)
  }

  async load(): Promise<KeyboardShortcutConfig> {
    if (!this.filePath) return this.get()
    try {
      const parsed = keyboardShortcutConfigSchema.safeParse(
        JSON.parse(await readFile(this.filePath, 'utf8'))
      )
      if (parsed.success) this.config = parsed.data
    } catch (error) {
      if (!isFileNotFoundError(error) && !(error instanceof SyntaxError)) throw error
    }
    return this.get()
  }

  get(): KeyboardShortcutConfig {
    return cloneConfig(this.config)
  }

  async update(request: KeyboardShortcutUpdateRequest): Promise<KeyboardShortcutConfig> {
    const nextConfig = keyboardShortcutConfigSchema.parse({
      ...this.config,
      [request.command]: request.binding
    })
    await this.persist(nextConfig)
    return this.get()
  }

  async reset(): Promise<KeyboardShortcutConfig> {
    await this.persist(defaultKeyboardShortcutConfig)
    return this.get()
  }

  private async persist(nextConfig: KeyboardShortcutConfig): Promise<void> {
    this.config = cloneConfig(nextConfig)
    if (!this.filePath) return

    const filePath = this.filePath
    const configToWrite = cloneConfig(this.config)
    const write = (): Promise<void> => writeJsonAtomically(filePath, configToWrite)
    const queuedWrite = this.writeQueue.then(write, write)
    this.writeQueue = queuedWrite
    await queuedWrite
  }
}

function cloneConfig(config: KeyboardShortcutConfig): KeyboardShortcutConfig {
  return { ...config }
}

async function writeJsonAtomically(filePath: string, config: KeyboardShortcutConfig): Promise<void> {
  const directory = dirname(filePath)
  const tempPath = join(
    directory,
    `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  )
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
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
