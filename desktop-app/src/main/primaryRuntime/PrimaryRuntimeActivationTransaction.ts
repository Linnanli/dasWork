import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { z } from 'zod'

import {
  PrimaryRuntimeActivePointer,
  type PrimaryRuntimeActivePointerRecord
} from './PrimaryRuntimeActivePointer'
import {
  PrimaryRuntimeInstaller,
  type PrimaryRuntimeInstallResult
} from './PrimaryRuntimeInstaller'
import { PrimaryRuntimeDiagnostics } from './PrimaryRuntimeDiagnostics'

const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: z.string().uuid(),
    phase: z.enum(['prepared', 'pointer-committed', 'readback', 'committed']),
    prepared: z.object({
      version: z.string().min(1),
      archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      versionDirectory: z.string().min(1),
      manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u)
    }),
    manifestSequence: z.number().int().positive().optional(),
    previousPointer: z
      .object({
        schemaVersion: z.literal(1),
        generation: z.number().int().positive(),
        version: z.string().min(1),
        archiveSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/u)
          .nullable(),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        directory: z.string().min(1)
      })
      .nullable()
  })
  .strict()

type ActivationJournal = z.infer<typeof journalSchema>

export type PrimaryRuntimeActivationProgress = {
  operationId: string
  phase: 'downloading' | 'verifying' | 'committing' | 'rolling-back'
  activeVersion?: string
  targetVersion?: string
  manifestSequence?: number
}

export type PrimaryRuntimeActivationTransactionInput = {
  cacheRoot: string
  installer: Pick<PrimaryRuntimeInstaller, 'prepare' | 'commitPrepared'>
  diagnostics: Pick<PrimaryRuntimeDiagnostics, 'diagnose'>
  /** Best-effort Main-only progress reporting; it cannot affect correctness. */
  onProgress?: (input: PrimaryRuntimeActivationProgress) => void | Promise<void>
  /** Test-only durable interruption hook. */
  failAt?: (phase: ActivationJournal['phase']) => void | Promise<void>
}

export type PrimaryRuntimeActivationResult = PrimaryRuntimeInstallResult & {
  operationId: string
}

/**
 * Activates a fully diagnosed Runtime candidate. This transaction deliberately
 * owns only Runtime publication: plugin/skill synchronization occurs after a
 * successful pointer switch, through the app-server-owned catalog path.
 */
export class PrimaryRuntimeActivationTransaction {
  private readonly pointer: PrimaryRuntimeActivePointer
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly input: PrimaryRuntimeActivationTransactionInput) {
    this.pointer = new PrimaryRuntimeActivePointer(input.cacheRoot)
  }

  get journalPath(): string {
    return join(this.input.cacheRoot, 'activation-journal.json')
  }

  async activate(
    signal: AbortSignal,
    descriptor?: Parameters<PrimaryRuntimeInstaller['prepare']>[1],
    requestedOperationId?: string
  ): Promise<PrimaryRuntimeActivationResult> {
    const operationId = requestedOperationId ?? randomUUID()
    if (!isUuid(operationId)) {
      throw new Error('Primary Runtime activation operation ID must be a UUID.')
    }
    const task = this.tail.then(() => this.activateOnce(signal, descriptor, operationId))
    this.tail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  async recover(): Promise<void> {
    const task = this.tail.then(() => this.recoverOnce())
    this.tail = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private async recoverOnce(): Promise<void> {
    const journal = await this.readJournal()
    if (!journal) return
    if (journal.phase !== 'committed') {
      this.reportProgress(journal.operationId, 'rolling-back', journal)
      await this.restorePointer(journal.previousPointer)
    }
    await rm(this.journalPath, { force: true })
  }

  private async activateOnce(
    signal: AbortSignal,
    descriptor: Parameters<PrimaryRuntimeInstaller['prepare']>[1] | undefined,
    operationId: string
  ): Promise<PrimaryRuntimeActivationResult> {
    await this.recoverOnce()
    const previousPointer = await this.pointer.read()
    this.reportProgress(operationId, 'downloading', {
      previousPointer,
      targetVersion: descriptor?.version,
      manifestSequence: descriptor?.manifestSequence
    })
    const prepared = await this.input.installer.prepare(signal, descriptor)
    const journal: ActivationJournal = {
      schemaVersion: 1,
      operationId,
      phase: 'prepared',
      prepared: {
        version: prepared.version,
        archiveSha256: prepared.archiveSha256,
        versionDirectory: prepared.versionDirectory,
        manifestSha256: prepared.manifestSha256
      },
      previousPointer,
      ...(descriptor?.manifestSequence ? { manifestSequence: descriptor.manifestSequence } : {})
    }
    await this.writeJournal(journal)
    this.reportProgress(operationId, 'verifying', journal)
    await this.input.failAt?.('prepared')

    try {
      const result = await this.input.installer.commitPrepared(prepared)
      await this.transition(journal, 'pointer-committed')
      const diagnostic = await this.input.diagnostics.diagnose(result.activeRoot)
      if (diagnostic.status !== 'ready') {
        throw new Error(
          'Primary Runtime activation readback did not find a healthy active Runtime.'
        )
      }
      await this.transition(journal, 'readback')
      await this.transition(journal, 'committed')
      await rm(this.journalPath, { force: true })
      return { ...result, operationId }
    } catch (error) {
      this.reportProgress(operationId, 'rolling-back', journal)
      try {
        await this.restorePointer(previousPointer)
        await rm(this.journalPath, { force: true })
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Primary Runtime activation failed and pointer recovery is pending.'
        )
      }
      throw error
    }
  }

  private async transition(
    journal: ActivationJournal,
    phase: ActivationJournal['phase']
  ): Promise<void> {
    journal.phase = phase
    await this.writeJournal(journal)
    this.reportProgress(journal.operationId, 'committing', journal)
    await this.input.failAt?.(phase)
  }

  private reportProgress(
    operationId: string,
    phase: PrimaryRuntimeActivationProgress['phase'],
    context: {
      previousPointer: PrimaryRuntimeActivePointerRecord | null
      prepared?: { version: string }
      targetVersion?: string
      manifestSequence?: number
    }
  ): void {
    try {
      void Promise.resolve(
        this.input.onProgress?.({
          operationId,
          phase,
          ...(context.previousPointer?.version
            ? { activeVersion: context.previousPointer.version }
            : {}),
          ...(context.prepared?.version || context.targetVersion
            ? { targetVersion: context.prepared?.version ?? context.targetVersion }
            : {}),
          ...(context.manifestSequence ? { manifestSequence: context.manifestSequence } : {})
        })
      ).catch(() => undefined)
    } catch {
      // Progress reporting must never change activation semantics.
    }
  }

  private async writeJournal(journal: ActivationJournal): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true })
    const temporaryPath = `${this.journalPath}.next-${randomUUID()}`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(journal)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    await rename(temporaryPath, this.journalPath)
  }

  private async readJournal(): Promise<ActivationJournal | null> {
    try {
      return journalSchema.parse(JSON.parse(await readFile(this.journalPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async restorePointer(previous: PrimaryRuntimeActivePointerRecord | null): Promise<void> {
    if (previous) await this.pointer.restore(previous)
    else await this.pointer.clear()
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}
