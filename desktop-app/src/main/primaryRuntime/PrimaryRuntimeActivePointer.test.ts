import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PrimaryRuntimeActivePointer,
  parsePrimaryRuntimeActivePointer
} from './PrimaryRuntimeActivePointer'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('PrimaryRuntimeActivePointer', () => {
  it('only exposes complete old or new version roots while swapping generations', async () => {
    const cacheRoot = await fixtureDirectory()
    const oldDirectory = 'versions/old-generation'
    const newDirectory = 'versions/new-generation'
    const oldRoot = join(cacheRoot, oldDirectory)
    const newRoot = join(cacheRoot, newDirectory)
    await Promise.all([mkdir(oldRoot, { recursive: true }), mkdir(newRoot, { recursive: true })])

    const pointer = new PrimaryRuntimeActivePointer(cacheRoot)
    await pointer.publish({
      version: 'old',
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      directory: oldDirectory
    })

    const readers = Array.from({ length: 32 }, async () => {
      for (let read = 0; read < 100; read += 1) {
        const root = await pointer.resolveRoot()
        expect([oldRoot, newRoot]).toContain(root)
      }
    })
    const writer = (async () => {
      for (let generation = 0; generation < 100; generation += 1) {
        await pointer.publish({
          version: generation % 2 === 0 ? 'new' : 'old',
          archiveSha256: (generation % 2 === 0 ? 'c' : 'a').repeat(64),
          manifestSha256: (generation % 2 === 0 ? 'd' : 'b').repeat(64),
          directory: generation % 2 === 0 ? newDirectory : oldDirectory
        })
      }
    })()

    await expect(Promise.all([...readers, writer])).resolves.toHaveLength(33)
    const finalPointer = await pointer.read()
    expect(finalPointer?.generation).toBe(101)
  })

  it('drops an interrupted next file without replacing a healthy published pointer', async () => {
    const cacheRoot = await fixtureDirectory()
    const directory = 'versions/current'
    await mkdir(join(cacheRoot, directory), { recursive: true })
    const pointer = new PrimaryRuntimeActivePointer(cacheRoot)
    await pointer.publish({
      version: 'current',
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      directory
    })
    const published = await readFile(join(cacheRoot, 'active.json'), 'utf8')
    await writeFile(join(cacheRoot, 'active.json.next'), '{"not":"a pointer"}')

    await pointer.recover()

    await expect(readFile(join(cacheRoot, 'active.json'), 'utf8')).resolves.toBe(published)
    await expect(readFile(join(cacheRoot, 'active.json.next'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects malformed and escaping pointer records', () => {
    expect(() => parsePrimaryRuntimeActivePointer('{"schemaVersion":1}')).toThrow()
    expect(() =>
      parsePrimaryRuntimeActivePointer(
        JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          version: 'bad',
          archiveSha256: 'a'.repeat(64),
          manifestSha256: 'b'.repeat(64),
          directory: '../outside'
        })
      )
    ).toThrow('unsafe')
  })
})

async function fixtureDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'primary-runtime-pointer-')))
  directories.push(directory)
  return directory
}
