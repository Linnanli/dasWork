import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { scheduledAutomationListSchema, type ScheduledAutomation } from '../../shared/automationApi'

export class AutomationStore {
  private automations: ScheduledAutomation[] = []
  private writeQueue = Promise.resolve()

  private constructor(private readonly filePath: string | undefined) {}

  static inMemory(): AutomationStore {
    return new AutomationStore(undefined)
  }

  static onDisk(filePath: string): AutomationStore {
    return new AutomationStore(filePath)
  }

  async load(): Promise<ScheduledAutomation[]> {
    if (!this.filePath) return this.get()
    try {
      const parsed = scheduledAutomationListSchema.safeParse(
        JSON.parse(await readFile(this.filePath, 'utf8'))
      )
      if (parsed.success) this.automations = cloneAutomations(parsed.data)
    } catch (error) {
      if (!isFileNotFoundError(error) && !(error instanceof SyntaxError)) throw error
    }
    return this.get()
  }

  get(): ScheduledAutomation[] {
    return cloneAutomations(this.automations)
  }

  async set(automations: ScheduledAutomation[]): Promise<void> {
    this.automations = cloneAutomations(automations)
    if (!this.filePath) return

    const snapshot = this.get()
    const write = (): Promise<void> => writeJsonAtomically(this.filePath!, snapshot)
    const queued = this.writeQueue.then(write, write)
    this.writeQueue = queued
    await queued
  }
}

function cloneAutomations(automations: ScheduledAutomation[]): ScheduledAutomation[] {
  return JSON.parse(JSON.stringify(automations)) as ScheduledAutomation[]
}

async function writeJsonAtomically(filePath: string, value: ScheduledAutomation[]): Promise<void> {
  const directory = dirname(filePath)
  const temporaryPath = join(
    directory,
    `.${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  )
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
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
