import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PrimaryRuntimeTlsPolicy } from './PrimaryRuntimeTlsPolicy'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('PrimaryRuntimeTlsPolicy', () => {
  it('accepts an explicit public CA only for configured loopback development origins', async () => {
    const certificatePath = await testCertificatePath()
    const policy = await PrimaryRuntimeTlsPolicy.create({
      production: false,
      localTestCaPath: certificatePath,
      allowedOrigins: ['https://127.0.0.1:9443']
    })

    expect(policy).toBeDefined()
    await expect(policy!.fetchImpl('https://example.test/v1/runtime/config.json')).rejects.toThrow(
      'loopback'
    )
    const controller = new AbortController()
    controller.abort()
    await expect(
      policy!.fetchImpl('https://127.0.0.1:9443/v1/runtime/config.json', {
        signal: controller.signal
      })
    ).rejects.toThrow('Request aborted')
  })

  it('rejects non-loopback, relative, malformed, and packaged configuration before requesting', async () => {
    const certificatePath = await testCertificatePath()
    await expect(
      PrimaryRuntimeTlsPolicy.create({
        production: true,
        localTestCaPath: certificatePath,
        allowedOrigins: ['https://127.0.0.1:9443']
      })
    ).rejects.toThrow('Production')
    await expect(
      PrimaryRuntimeTlsPolicy.create({
        production: false,
        localTestCaPath: 'relative-ca.pem',
        allowedOrigins: ['https://127.0.0.1:9443']
      })
    ).rejects.toThrow('absolute')
    await expect(
      PrimaryRuntimeTlsPolicy.create({
        production: false,
        localTestCaPath: certificatePath,
        allowedOrigins: ['https://feed.example.test']
      })
    ).rejects.toThrow('loopback')
  })
})

async function testCertificatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-tls-policy-'))
  directories.push(directory)
  const path = join(directory, 'test-ca.pem')
  await writeFile(path, '-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n')
  return path
}
