import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import { z } from 'zod'

const trustRecordSchema = z
  .object({
    sequence: z.number().int().positive(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
    keyId: z.string().min(1),
    acceptedAt: z.string().datetime({ offset: true }),
    origin: z.string().url(),
    channel: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
    role: z.enum(['config', 'manifest'])
  })
  .strict()

const trustStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    records: z.record(z.string(), trustRecordSchema)
  })
  .strict()

export type PrimaryRuntimeTrustRole = 'config' | 'manifest'
export type PrimaryRuntimeTrustRecord = z.infer<typeof trustRecordSchema>

export type PrimaryRuntimeTrustStateStore = {
  read(role: PrimaryRuntimeTrustRole): Promise<PrimaryRuntimeTrustRecord | undefined>
  accept(record: PrimaryRuntimeTrustRecord): Promise<void>
}

/**
 * Persists the exact signed metadata accepted for each trust role.  A sequence
 * number alone is insufficient: equal sequence values with different payloads
 * or signing keys are an equivocation attempt and are rejected.
 */
export class FilePrimaryRuntimeTrustStateStore implements PrimaryRuntimeTrustStateStore {
  constructor(private readonly statePath: string) {}

  async read(role: PrimaryRuntimeTrustRole): Promise<PrimaryRuntimeTrustRecord | undefined> {
    const state = await this.readState()
    return state.records[role]
  }

  async accept(record: PrimaryRuntimeTrustRecord): Promise<void> {
    const state = await this.readState()
    const existing = state.records[record.role]
    if (existing) assertMonotonicAcceptance(existing, record)
    if (
      existing &&
      existing.sequence === record.sequence &&
      existing.payloadHash === record.payloadHash &&
      existing.keyId === record.keyId
    ) {
      return
    }

    await mkdir(dirname(this.statePath), { recursive: true })
    const next = {
      schemaVersion: 1 as const,
      records: { ...state.records, [record.role]: record }
    }
    const temporaryPath = `${this.statePath}.next-${randomUUID()}`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close().catch(() => undefined)
    }
    await rename(temporaryPath, this.statePath)
  }

  private async readState(): Promise<z.infer<typeof trustStateSchema>> {
    try {
      return trustStateSchema.parse(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, records: {} }
      }
      throw error
    }
  }
}

export function assertMonotonicAcceptance(
  existing: PrimaryRuntimeTrustRecord,
  candidate: PrimaryRuntimeTrustRecord
): void {
  if (existing.role !== candidate.role) {
    throw new Error('Primary Runtime trust record role cannot change.')
  }
  if (existing.channel !== candidate.channel || existing.origin !== candidate.origin) {
    throw new Error('Primary Runtime trust metadata origin or channel changed unexpectedly.')
  }
  if (candidate.sequence < existing.sequence) {
    throw new Error(`Primary Runtime ${candidate.role} sequence has rolled back.`)
  }
  if (
    candidate.sequence === existing.sequence &&
    (candidate.payloadHash !== existing.payloadHash || candidate.keyId !== existing.keyId)
  ) {
    throw new Error(`Primary Runtime ${candidate.role} metadata equivocation was detected.`)
  }
}
