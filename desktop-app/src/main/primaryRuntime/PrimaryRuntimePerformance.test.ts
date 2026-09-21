import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

// Intel macOS hosted runners have needed almost sixteen minutes to extract the
// ten target-native Runtime archives. This is only the collection ceiling; the
// reviewed P3b budget remains the enforceable product limit.
const performanceTestTimeoutMs = 3_600_000
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => removePerformanceDirectory(directory)))
}, performanceTestTimeoutMs)

describe('Primary Runtime performance cleanup', () => {
  it('removes the locked Runtime trees created by each cold install', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-performance-cleanup-'))
    directories.push(directory)
    const dependencyDirectory = join(directory, 'versions', 'candidate', 'dependencies')
    await mkdir(dependencyDirectory, { recursive: true })
    await writeFile(join(dependencyDirectory, 'runtime.txt'), 'fixture\n')
    await chmod(dependencyDirectory, 0o500)
    await chmod(join(directory, 'versions', 'candidate'), 0o500)

    await removePerformanceDirectory(directory)

    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

async function removePerformanceDirectory(directory: string): Promise<void> {
  await makePerformanceTreeWritable(directory)
  await rm(directory, { recursive: true, force: true })
}

async function makePerformanceTreeWritable(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await makePerformanceTreeWritable(path)
      await chmod(path, 0o700)
    } else if (entry.isFile()) {
      await chmod(path, 0o600)
    }
  }
  await chmod(root, 0o700).catch(() => undefined)
}
