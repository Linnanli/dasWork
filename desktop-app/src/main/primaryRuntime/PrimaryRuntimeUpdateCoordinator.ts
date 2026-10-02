import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PrimaryRuntimeInstallResult } from './PrimaryRuntimeInstaller'

export type PrimaryRuntimeUpdateCoordinatorInput = {
  runtime: {
    updateIfAvailable(): Promise<PrimaryRuntimeInstallResult | undefined>
    cancelInstall(): Promise<void>
  }
  pollIntervalMs: number | (() => number)
  onUpdated?: (result: PrimaryRuntimeInstallResult) => void | Promise<void>
  onFailure?: (error: unknown) => void
  onScheduled?: (nextCheckAt: Date) => void | Promise<void>
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void
  /** Persists one per-install jitter sample without storing feed metadata. */
  jitterStore?: PrimaryRuntimeUpdateJitterStore
  /** Injectable only to make the otherwise random schedule deterministic in tests. */
  random?: () => number
  now?: () => Date
}

export type PrimaryRuntimeUpdateJitterStore = {
  read(): Promise<number | undefined>
  write(sample: number): Promise<void>
}

const JITTER_STORE_SCHEMA_VERSION = 1

/** A tiny Main-owned store: only the sampled jitter factor is persisted. */
export class FilePrimaryRuntimeUpdateJitterStore implements PrimaryRuntimeUpdateJitterStore {
  constructor(private readonly path: string) {}

  async read(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== JITTER_STORE_SCHEMA_VERSION ||
        !isJitterSample((parsed as { sample?: unknown }).sample)
      ) {
        return undefined
      }
      return (parsed as { sample: number }).sample
    } catch {
      return undefined
    }
  }

  async write(sample: number): Promise<void> {
    if (!isJitterSample(sample)) {
      throw new Error('Primary Runtime update jitter must be a number in [0, 1).')
    }
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.next-${randomUUID()}`
    const handle = await open(temporaryPath, 'wx', 0o600)
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: JITTER_STORE_SCHEMA_VERSION, sample })}\n`
      )
      await handle.sync()
      await handle.close()
      await rename(temporaryPath, this.path)
    } finally {
      await handle.close().catch(() => undefined)
    }
  }
}

const JITTER_RATIO = 0.1
const MAX_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000
const DUE_TICK_MS = 30_000

/**
 * Main-owned, single-flight Runtime update loop. It is deliberately separate
 * from conversation execution: failed refreshes preserve last-known-good and
 * only report a diagnostic, while ordinary chat continues.
 */
export class PrimaryRuntimeUpdateCoordinator {
  private readonly schedule: NonNullable<PrimaryRuntimeUpdateCoordinatorInput['schedule']>
  private readonly clearSchedule: NonNullable<PrimaryRuntimeUpdateCoordinatorInput['clearSchedule']>
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private tail: Promise<void> = Promise.resolve()
  private consecutiveFailures = 0
  private jitterSample: number | undefined
  private nextCheckAt: Date | undefined

  constructor(private readonly input: PrimaryRuntimeUpdateCoordinatorInput) {
    assertPollInterval(this.pollIntervalMs())
    this.schedule = input.schedule ?? setTimeout
    this.clearSchedule = input.clearSchedule ?? clearTimeout
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    await this.loadOrCreateJitterSample()
    await this.checkNow()
  }

  async checkNow(): Promise<void> {
    if (this.stopped) return
    const task = this.tail.then(async () => {
      let succeeded = false
      try {
        const result = await this.input.runtime.updateIfAvailable()
        if (result) await this.input.onUpdated?.(result)
        succeeded = true
      } catch (error) {
        this.input.onFailure?.(error)
      } finally {
        this.consecutiveFailures = succeeded ? 0 : this.consecutiveFailures + 1
        this.scheduleNext(succeeded)
      }
    })
    this.tail = task.catch(() => undefined)
    return task
  }

  /** Product-config and workspace-feature changes bypass only the wait, not the queue. */
  async refreshAfterConfigurationChange(): Promise<void> {
    if (this.stopped) return
    if (this.timer) this.clearSchedule(this.timer)
    this.timer = undefined
    this.nextCheckAt = undefined
    await this.checkNow()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) this.clearSchedule(this.timer)
    this.timer = undefined
    await this.input.runtime.cancelInstall()
    await this.tail
  }

  private scheduleNext(succeeded: boolean): void {
    if (this.stopped) return
    const delayMs = this.nextDelayMs(succeeded)
    this.nextCheckAt = new Date((this.input.now ?? (() => new Date()))().getTime() + delayMs)
    this.reportNextCheck(this.nextCheckAt)
    this.scheduleDueTick()
  }

  /**
   * The periodic timer deliberately performs no network work before the
   * persisted-jitter due time. It gives product config changes a bounded
   * response time without turning the 30-second UI tick into a feed poll.
   */
  private scheduleDueTick(): void {
    if (this.stopped || this.timer) return
    this.timer = this.schedule(() => {
      this.timer = undefined
      if (this.nextCheckAt && this.now().getTime() >= this.nextCheckAt.getTime()) {
        void this.checkNow()
        return
      }
      this.scheduleDueTick()
    }, DUE_TICK_MS)
  }

  private reportNextCheck(nextCheckAt: Date): void {
    try {
      void Promise.resolve(this.input.onScheduled?.(nextCheckAt)).catch(() => undefined)
    } catch {
      // UI status cannot alter update scheduling or failure recovery.
    }
  }

  private nextDelayMs(succeeded: boolean): number {
    const baseDelay = this.pollIntervalMs()
    const failureMultiplier = succeeded ? 1 : 2 ** Math.min(this.consecutiveFailures - 1, 30)
    const unjitteredDelay = Math.min(baseDelay * failureMultiplier, MAX_FAILURE_BACKOFF_MS)
    const sample = this.jitterSample ?? this.newJitterSample()
    const jitter = (sample * 2 - 1) * JITTER_RATIO
    return Math.max(1, Math.round(unjitteredDelay * (1 + jitter)))
  }

  private pollIntervalMs(): number {
    const value =
      typeof this.input.pollIntervalMs === 'function'
        ? this.input.pollIntervalMs()
        : this.input.pollIntervalMs
    assertPollInterval(value)
    return value
  }

  private now(): Date {
    return (this.input.now ?? (() => new Date()))()
  }

  private async loadOrCreateJitterSample(): Promise<void> {
    const persisted = await this.input.jitterStore?.read().catch(() => undefined)
    if (persisted !== undefined && isJitterSample(persisted)) {
      this.jitterSample = persisted
      return
    }
    const sample = this.newJitterSample()
    this.jitterSample = sample
    await this.input.jitterStore?.write(sample).catch(() => undefined)
  }

  private newJitterSample(): number {
    const sample = (this.input.random ?? Math.random)()
    if (!isJitterSample(sample)) {
      throw new Error('Primary Runtime update jitter source must return a number in [0, 1).')
    }
    return sample
  }
}

function assertPollInterval(value: number): void {
  if (!Number.isSafeInteger(value) || value < 30_000) {
    throw new Error('Primary Runtime update polling interval must be at least 30000 ms.')
  }
}

function isJitterSample(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1
}
