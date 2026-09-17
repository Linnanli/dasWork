import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { PrimaryRuntimeHttpClient } from './PrimaryRuntimeHttpClient'
import { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import { PrimaryRuntimeProductConfigClient } from './PrimaryRuntimeProductConfigClient'
import { PrimaryRuntimeProductReleaseProvider } from './PrimaryRuntimeProductReleaseProvider'
import { canonicalPrimaryRuntimeReleaseManifestPayload } from './PrimaryRuntimeReleaseManifest'
import { SignedPrimaryRuntimeReleaseProvider } from './PrimaryRuntimeReleaseProvider'
import { PrimaryRuntimeService } from './PrimaryRuntimeService'

const performanceEnabled = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE === '1'
const archivePath = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_ARCHIVE
const version = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_VERSION
const expectedSha256 = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_SHA256
const target = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_TARGET
const unpackedBytesValue = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_UNPACKED_BYTES
const outputPath = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_OUTPUT
const evidenceValue = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_EVIDENCE
const normalChatPassed = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_NORMAL_CHAT_PASSED === '1'
const p1aReceiptSha256 = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_P1A_RECEIPT_SHA256
const p1aMeasurementsValue = process.env.DASCOWORK_PRIMARY_RUNTIME_PERFORMANCE_P1A_MEASUREMENTS
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

describe.skipIf(!performanceEnabled)('Primary Runtime P3b performance calibration', () => {
  it('performs ten empty-cache installs through signed product config and records event-loop evidence', async () => {
    const unpackedBytes = positiveInteger(unpackedBytesValue, 'unpacked bytes')
    const evidence = parseEvidence(evidenceValue)
    const p1aMeasurements = parseP1aMeasurements(p1aMeasurementsValue)
    expect(archivePath, 'P3b performance requires a target-native P1a archive').toBeTruthy()
    expect(version, 'P3b performance requires a target-native P1a version').toBeTruthy()
    expect(expectedSha256, 'P3b performance requires an archive digest').toMatch(/^[a-f0-9]{64}$/iu)
    expect(outputPath, 'P3b performance requires an output path').toBeTruthy()
    expect(target).toBe(`${process.platform}-${process.arch}`)
    expect(p1aReceiptSha256, 'P3b performance requires a selected P1a receipt digest').toMatch(
      /^[a-f0-9]{64}$/iu
    )
    expect(p1aMeasurements).toHaveLength(5)
    expect(normalChatPassed, 'P3b performance requires an actual normal chat smoke receipt').toBe(true)

    const archive = await stat(archivePath!)
    await expect(sha256File(archivePath!)).resolves.toBe(expectedSha256!.toLowerCase())

    const coldInstallMs: number[] = []
    const mainEventLoopDelayP99Ms: number[] = []
    const mainEventLoopDelayMaxMs: number[] = []
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const cacheRoot = await mkdtemp(join(tmpdir(), 'primary-runtime-performance-'))
      const eventLoop = monitorEventLoopDelay({ resolution: 1 })
      eventLoop.enable()
      const startedAt = performance.now()
      try {
        await new PrimaryRuntimeService({
          cacheRoot,
          locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
          releaseProvider: createSignedCalibrationFeed({
            archivePath: archivePath!,
            archiveSizeBytes: archive.size,
            archiveSha256: expectedSha256!.toLowerCase(),
            version: version!,
            unpackedBytes
          })
        }).install()
        await new Promise<void>((resolveAttempt) => setImmediate(resolveAttempt))
        eventLoop.disable()
        coldInstallMs.push(toPositiveMilliseconds(performance.now() - startedAt))
        mainEventLoopDelayP99Ms.push(toPositiveMilliseconds(eventLoop.percentile(99) / 1_000_000))
        mainEventLoopDelayMaxMs.push(toPositiveMilliseconds(eventLoop.max / 1_000_000))
      } finally {
        eventLoop.disable()
        await removePerformanceDirectory(cacheRoot)
      }
    }

    await writeFile(
      outputPath!,
      `${JSON.stringify(
        {
          schemaVersion: 'dascowork-primary-runtime-performance-target.v1',
          target,
          evidence,
          runner: evidence.runner,
          candidateArchiveSha256: expectedSha256!.toLowerCase(),
          p1aBuildUnpackReceiptSha256: p1aReceiptSha256!.toLowerCase(),
          normalChatPassed,
          archiveBytes: p1aMeasurements.map((measurement) => measurement.archiveBytes),
          unpackedBytes: p1aMeasurements.map((measurement) => measurement.unpackedBytes),
          coldInstallMs,
          mainEventLoopDelayP99Ms,
          mainEventLoopDelayMaxMs
        },
        null,
        2
      )}\n`
    )
  }, performanceTestTimeoutMs)
})

function createSignedCalibrationFeed(input: {
  archivePath: string
  archiveSizeBytes: number
  archiveSha256: string
  version: string
  unpackedBytes: number
}): PrimaryRuntimeProductReleaseProvider {
  const origin = 'https://primary-runtime-calibration.invalid'
  const now = new Date()
  const issuedAt = new Date(now.getTime() - 60_000).toISOString()
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  const { privateKey: configPrivateKey, publicKey: configPublicKey } =
    generateKeyPairSync('ed25519')
  const { privateKey: manifestPrivateKey, publicKey: manifestPublicKey } =
    generateKeyPairSync('ed25519')
  const budget = {
    maxArchiveBytes: input.archiveSizeBytes,
    maxUnpackedBytes: input.unpackedBytes,
    minimumFreeDiskBytes: 1,
    maxColdInstallMs: 86_400_000,
    maxMainEventLoopDelayP99Ms: 60_000,
    maxMainEventLoopDelayMaxMs: 60_000
  }
  const unsignedConfig = {
    schemaVersion: 1,
    sequence: 1,
    channel: 'calibration',
    manifestUrl: `${origin}/v1/runtime/channels/calibration/manifest.json`,
    pollIntervalMs: 3_600_000,
    issuedAt,
    expiresAt,
    keyId: 'calibration-config'
  }
  const config = signed(unsignedConfig, configPrivateKey)
  const unsignedManifest = {
    schemaVersion: 1,
    sequence: 1,
    channel: 'calibration',
    issuedAt,
    expiresAt,
    keyId: 'calibration-manifest',
    releases: [
      {
        platform: process.platform,
        arch: process.arch,
        version: input.version,
        archiveFormat: 'zip',
        archiveUrl: `${origin}/v1/runtime/archives/${encodeURIComponent(input.version)}/primary-runtime.zip`,
        archiveSizeBytes: input.archiveSizeBytes,
        archiveSha256: input.archiveSha256,
        budget
      }
    ]
  }
  const manifest = signed(unsignedManifest, manifestPrivateKey)
  const fetchImpl: typeof fetch = async (request) => {
    const url = new URL(
      typeof request === 'string' ? request : request instanceof URL ? request.href : request.url
    )
    if (url.pathname === '/v1/runtime/config.json') return new Response(JSON.stringify(config))
    if (url.pathname === '/v1/runtime/channels/calibration/manifest.json') {
      return new Response(JSON.stringify(manifest))
    }
    if (url.pathname.endsWith('/primary-runtime.zip')) {
      return new Response(Readable.toWeb(createReadStream(input.archivePath)) as ReadableStream)
    }
    return new Response('not found', { status: 404 })
  }
  const httpClient = new PrimaryRuntimeHttpClient({ allowedOrigins: [origin], fetchImpl })
  const trustState = { read: async () => undefined, accept: async () => undefined }
  const configClient = new PrimaryRuntimeProductConfigClient({
    configUrl: `${origin}/v1/runtime/config.json`,
    channel: 'calibration',
    configPublicKeys: { 'calibration-config': configPublicKey },
    allowedConfigOrigins: [origin],
    allowedManifestOrigins: [origin],
    httpClient,
    trustState,
    now: () => now
  })
  let highestSequence: number | undefined
  return new PrimaryRuntimeProductReleaseProvider({
    configClient,
    createManifestProvider: (verifiedConfig) =>
      new SignedPrimaryRuntimeReleaseProvider({
        manifestUrl: verifiedConfig.manifestUrl,
        allowedOrigins: [origin],
        channel: 'calibration',
        publicKeys: { 'calibration-manifest': manifestPublicKey },
        httpClient,
        trustState,
        sequenceStore: {
          readHighestSequence: async () => highestSequence,
          persistHighestSequence: async (sequence) => {
            highestSequence = sequence
          }
        },
        now: () => now
      })
  })
}

function signed<T extends Record<string, unknown>>(
  value: T,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
): T & { signature: string } {
  return {
    ...value,
    signature: sign(
      null,
      Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(value), 'utf8'),
      privateKey
    ).toString('base64')
  }
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`P3b performance ${label} is invalid.`)
  return parsed
}

function parseEvidence(value: string | undefined): {
  sourceRunId: string
  sourceCommit: string
  installerCommit: string
  hardLimitsSha256: string
  sourceLockSha256: string
  toolchainsLockSha256: string
  runner: string
} {
  if (!value) throw new Error('P3b performance evidence is missing.')
  const parsed = JSON.parse(value) as Record<string, unknown>
  const fields = [
    'sourceRunId',
    'sourceCommit',
    'installerCommit',
    'hardLimitsSha256',
    'sourceLockSha256',
    'toolchainsLockSha256',
    'runner'
  ] as const
  for (const field of fields) {
    if (typeof parsed[field] !== 'string' || parsed[field].length === 0) {
      throw new Error(`P3b performance evidence ${field} is invalid.`)
    }
  }
  return parsed as {
    sourceRunId: string
    sourceCommit: string
    installerCommit: string
    hardLimitsSha256: string
    sourceLockSha256: string
    toolchainsLockSha256: string
    runner: string
  }
}

function parseP1aMeasurements(
  value: string | undefined
): Array<{ archiveBytes: number; unpackedBytes: number }> {
  if (!value) throw new Error('P3b performance P1a measurement set is missing.')
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.length !== 5) {
    throw new Error('P3b performance requires exactly five P1a build/unpack measurements.')
  }
  return parsed.map((measurement) => {
    if (
      !measurement ||
      typeof measurement !== 'object' ||
      !Number.isSafeInteger((measurement as { archiveBytes?: unknown }).archiveBytes) ||
      !Number.isSafeInteger((measurement as { unpackedBytes?: unknown }).unpackedBytes)
    ) {
      throw new Error('P3b performance P1a measurement is invalid.')
    }
    return measurement as { archiveBytes: number; unpackedBytes: number }
  })
}

function toPositiveMilliseconds(value: number): number {
  return Math.max(1, Math.ceil(Number.isFinite(value) ? value : 1))
}

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

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
