import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import { PrimaryRuntimeService } from './PrimaryRuntimeService'

const enabled = process.env.DASCOWORK_PRIMARY_RUNTIME_STRESS === '1'
const sourceArchive = process.env.DASCOWORK_PRIMARY_RUNTIME_STRESS_ARCHIVE?.trim()
const version = process.env.DASCOWORK_PRIMARY_RUNTIME_STRESS_VERSION?.trim()
const expectedSha256 = process.env.DASCOWORK_PRIMARY_RUNTIME_STRESS_SHA256?.trim().toLowerCase()
const maxRssDeltaMiB = Number(process.env.DASCOWORK_PRIMARY_RUNTIME_STRESS_MAX_RSS_MIB ?? '384')
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeRuntimeCache))
})

describe.skipIf(!enabled)('Primary Runtime install stress', () => {
  it('installs a real archive without an archive-sized main-process allocation', async () => {
    expect(sourceArchive, 'stress gate requires DASCOWORK_PRIMARY_RUNTIME_STRESS_ARCHIVE').toBeTruthy()
    expect(version, 'stress gate requires DASCOWORK_PRIMARY_RUNTIME_STRESS_VERSION').toBeTruthy()
    expect(expectedSha256, 'stress gate requires DASCOWORK_PRIMARY_RUNTIME_STRESS_SHA256').toMatch(
      /^[a-f0-9]{64}$/u
    )
    expect(Number.isFinite(maxRssDeltaMiB) && maxRssDeltaMiB > 0).toBe(true)

    const archiveDetails = await stat(sourceArchive!)
    const cacheRoot = await mkdtemp(join(tmpdir(), 'primary-runtime-install-stress-'))
    directories.push(cacheRoot)
    const baselineRss = process.memoryUsage.rss()
    let maxRss = baselineRss
    const sampler = setInterval(() => {
      maxRss = Math.max(maxRss, process.memoryUsage.rss())
    }, 25)
    try {
      const service = new PrimaryRuntimeService({
        cacheRoot,
        locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
        releaseProvider: {
          getRelease: async () => ({
            version: version!,
            archiveFormat: 'zip',
            archiveSizeBytes: archiveDetails.size,
            archiveSha256: expectedSha256!
          }),
          downloadArchive: async (_descriptor, destinationPath, signal) => {
            await mkdir(dirname(destinationPath), { recursive: true })
            await pipeline(createReadStream(sourceArchive!), createWriteStream(destinationPath), { signal })
            const digest = await sha256File(destinationPath)
            return { path: destinationPath, sizeBytes: archiveDetails.size, sha256: digest }
          }
        }
      })

      const result = await service.install()
      maxRss = Math.max(maxRss, process.memoryUsage.rss())
      expect(result.status).toBe('installed')
      expect(result.version).toBe(version)
      expect(maxRss - baselineRss).toBeLessThanOrEqual(maxRssDeltaMiB * 1024 * 1024)
      const downloads = await readdir(join(cacheRoot, 'downloads'))
      expect(downloads).toEqual([`${expectedSha256}.zip`])
    } finally {
      clearInterval(sampler)
    }
  })
})

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

async function removeRuntimeCache(root: string): Promise<void> {
  await makeWritable(root)
  await rm(root, { recursive: true, force: true })
}

async function makeWritable(root: string): Promise<void> {
  const { chmod, readdir: readDirectory } = await import('node:fs/promises')
  const entries = await readDirectory(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await makeWritable(path)
      await chmod(path, 0o700)
    } else if (entry.isFile()) {
      await chmod(path, 0o600)
    }
  }
  await chmod(root, 0o700).catch(() => undefined)
}
