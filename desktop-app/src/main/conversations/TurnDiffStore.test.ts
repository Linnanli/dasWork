import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it } from 'vitest'

import { TurnDiffStore } from './TurnDiffStore'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('TurnDiffStore', () => {
  it('persists the latest final diff, including an authoritative empty diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turn-diff-store-'))
    temporaryRoots.push(root)
    const store = new TurnDiffStore(root)

    await store.save({
      threadId: 'thread-1',
      turnId: 'turn-1',
      diff: 'diff --git a/file.ts b/file.ts\n+temporary\n'
    })
    await store.save({ threadId: 'thread-1', turnId: 'turn-1', diff: '' })

    await expect(store.read('thread-1', 'turn-1')).resolves.toBe('')
    await expect(store.read('thread-1', 'missing-turn')).resolves.toBeUndefined()
    await expect(store.readMany('thread-1', ['turn-1', 'missing-turn'])).resolves.toEqual(
      new Map([['turn-1', '']])
    )
  })

  it('removes every saved diff for a permanently deleted task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'turn-diff-store-'))
    temporaryRoots.push(root)
    const store = new TurnDiffStore(root)

    await store.save({ threadId: 'thread-delete', turnId: 'turn-a', diff: 'first' })
    await store.save({ threadId: 'thread-delete', turnId: 'turn-b', diff: 'second' })
    await store.save({ threadId: 'thread-keep', turnId: 'turn-c', diff: 'keep' })
    await store.removeThread('thread-delete')

    await expect(store.read('thread-delete', 'turn-a')).resolves.toBeUndefined()
    await expect(store.read('thread-delete', 'turn-b')).resolves.toBeUndefined()
    await expect(store.read('thread-keep', 'turn-c')).resolves.toBe('keep')
  })
})
