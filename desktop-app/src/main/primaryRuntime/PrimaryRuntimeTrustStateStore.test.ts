import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  FilePrimaryRuntimeTrustStateStore,
  assertMonotonicAcceptance
} from './PrimaryRuntimeTrustStateStore'

const directories: string[] = []
const initial = {
  sequence: 4,
  payloadHash: 'a'.repeat(64),
  keyId: 'manifest-2026-01',
  acceptedAt: '2026-09-10T00:00:00.000Z',
  origin: 'https://runtime.example.test',
  channel: 'stable',
  role: 'manifest' as const
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('PrimaryRuntimeTrustStateStore', () => {
  it('persists exact metadata acceptance and allows only an idempotent replay', async () => {
    const store = new FilePrimaryRuntimeTrustStateStore(await fixturePath())

    await store.accept(initial)
    await store.accept({ ...initial, acceptedAt: '2026-09-10T00:01:00.000Z' })

    expect(await store.read('manifest')).toMatchObject({
      sequence: 4,
      payloadHash: 'a'.repeat(64),
      keyId: 'manifest-2026-01'
    })
  })

  it('rejects rollback and same-sequence equivocation before changing state', async () => {
    const store = new FilePrimaryRuntimeTrustStateStore(await fixturePath())
    await store.accept(initial)

    await expect(store.accept({ ...initial, sequence: 3 })).rejects.toThrow('rolled back')
    await expect(store.accept({ ...initial, payloadHash: 'b'.repeat(64) })).rejects.toThrow(
      'equivocation'
    )
    await expect(store.accept({ ...initial, keyId: 'manifest-2026-02' })).rejects.toThrow(
      'equivocation'
    )
    expect(await store.read('manifest')).toMatchObject({ payloadHash: 'a'.repeat(64) })
  })

  it('does not let a role, channel, or origin switch reuse a trust record', () => {
    expect(() => assertMonotonicAcceptance(initial, { ...initial, role: 'config' })).toThrow('role')
    expect(() => assertMonotonicAcceptance(initial, { ...initial, channel: 'beta' })).toThrow(
      'origin or channel'
    )
    expect(() =>
      assertMonotonicAcceptance(initial, { ...initial, origin: 'https://other.example.test' })
    ).toThrow('origin or channel')
  })
})

async function fixturePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-trust-state-'))
  directories.push(directory)
  return join(directory, 'trust.json')
}
