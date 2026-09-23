import { describe, expect, it } from 'vitest'

import { createR07EvidenceRecorder, requirePositiveDuration } from './primaryRuntimeEvidence'

describe('Primary Runtime evidence helpers', () => {
  it('records the actual observation order with wall-clock and monotonic timestamps', () => {
    let wallClockMs = Date.parse('2026-09-23T00:00:00.000Z')
    let monotonicNs = 100n
    const recorder = createR07EvidenceRecorder({
      now: () => new Date((wallClockMs += 10)),
      monotonicNow: () => (monotonicNs += 10n)
    })

    recorder.observe('loader')
    recorder.observe('command')
    recorder.observe('artifact')
    recorder.observe('preview')

    expect(recorder.snapshot()).toEqual({
      loader: { observedAt: '2026-09-23T00:00:00.010Z', monotonicNs: '110' },
      command: { observedAt: '2026-09-23T00:00:00.020Z', monotonicNs: '120' },
      artifact: { observedAt: '2026-09-23T00:00:00.030Z', monotonicNs: '130' },
      preview: { observedAt: '2026-09-23T00:00:00.040Z', monotonicNs: '140' }
    })
  })

  it('rejects missing, duplicate, and out-of-order observations', () => {
    const recorder = createR07EvidenceRecorder()
    expect(() => recorder.observe('command')).toThrow('out of order')
    recorder.observe('loader')
    expect(() => recorder.observe('loader')).toThrow('out of order')
    expect(() => recorder.snapshot()).toThrow('incomplete')
  })

  it('rejects non-monotonic clocks instead of synthesizing an order', () => {
    const recorder = createR07EvidenceRecorder({ monotonicNow: () => 1n })
    recorder.observe('loader')
    expect(() => recorder.observe('command')).toThrow('not strictly monotonic')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1])(
    'rejects invalid performance duration %s',
    (value) => {
      expect(() => requirePositiveDuration(value, 'chat overlap')).toThrow(
        'must be a finite positive duration'
      )
    }
  )

  it('preserves a real positive duration', () => {
    expect(requirePositiveDuration(12.2, 'chat overlap')).toBe(13)
  })
})
