export type R07ObservationName = 'loader' | 'command' | 'artifact' | 'preview'

export type R07EvidenceObservation = {
  observedAt: string
  monotonicNs: string
}

export type R07EvidenceObservations = Record<R07ObservationName, R07EvidenceObservation>

const r07ObservationOrder: readonly R07ObservationName[] = [
  'loader',
  'command',
  'artifact',
  'preview'
]

export function createR07EvidenceRecorder(input?: {
  now?: () => Date
  monotonicNow?: () => bigint
}): {
  observe: (name: R07ObservationName) => void
  snapshot: () => R07EvidenceObservations
} {
  const now = input?.now ?? (() => new Date())
  const monotonicNow = input?.monotonicNow ?? (() => process.hrtime.bigint())
  const observations = new Map<R07ObservationName, R07EvidenceObservation>()

  return {
    observe(name) {
      const expected = r07ObservationOrder[observations.size]
      if (name !== expected) {
        throw new Error(
          `R07 evidence observation ${name} was recorded out of order; expected ${expected ?? 'no further event'}.`
        )
      }
      const observedAt = now()
      const monotonicNs = monotonicNow()
      if (!Number.isFinite(observedAt.getTime())) {
        throw new Error(`R07 evidence observation ${name} has an invalid wall-clock timestamp.`)
      }
      const previousName = r07ObservationOrder[observations.size - 1]
      const previous = previousName ? observations.get(previousName) : undefined
      if (monotonicNs <= 0n || (previous && monotonicNs <= BigInt(previous.monotonicNs))) {
        throw new Error(`R07 evidence observation ${name} is not strictly monotonic.`)
      }
      observations.set(name, {
        observedAt: observedAt.toISOString(),
        monotonicNs: monotonicNs.toString()
      })
    },
    snapshot() {
      if (observations.size !== r07ObservationOrder.length) {
        throw new Error(
          `R07 evidence observations are incomplete: recorded ${observations.size} of ${r07ObservationOrder.length}.`
        )
      }
      return Object.fromEntries(observations) as R07EvidenceObservations
    }
  }
}

export function requirePositiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`${label} must be a finite positive duration; received ${String(value)}.`)
  }
  return Math.ceil(value)
}
