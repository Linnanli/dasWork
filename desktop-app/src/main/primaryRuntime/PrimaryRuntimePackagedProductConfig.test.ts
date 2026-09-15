import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE,
  PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
  readPackagedPrimaryRuntimeProductConfig
} from './PrimaryRuntimePackagedProductConfig'

const directories: string[] = []
const configPublicKeys = { config: '-----BEGIN PUBLIC KEY-----\nconfig\n-----END PUBLIC KEY-----' }
const manifestPublicKeys = {
  manifest: '-----BEGIN PUBLIC KEY-----\nmanifest\n-----END PUBLIC KEY-----'
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('packaged Primary Runtime product config', () => {
  it('loads an enabled package resource without accepting a test CA', async () => {
    const resourcesPath = await fixtureDirectory()
    await writeConfig(resourcesPath, {
      schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
      enabled: true,
      configUrl: 'https://feed.example.test/v1/runtime/config.json',
      allowedConfigOrigins: ['https://feed.example.test'],
      allowedManifestOrigins: ['https://feed.example.test'],
      channel: 'stable',
      configPublicKeys,
      manifestPublicKeys,
      pollIntervalMs: 30_000
    })

    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).resolves.toMatchObject({
      primaryRuntimeProductConfig: {
        configUrl: 'https://feed.example.test/v1/runtime/config.json',
        channel: 'stable',
        configPublicKeys,
        manifestPublicKeys,
        pollIntervalMs: 30_000
      }
    })
  })

  it('treats the explicit disabled resource and a missing resource as Runtime-disabled', async () => {
    const resourcesPath = await fixtureDirectory()
    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).resolves.toBeUndefined()
    await writeConfig(resourcesPath, {
      schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
      enabled: false
    })
    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).resolves.toBeUndefined()
  })

  it('carries the package-owned workspace dependency feature gate without accepting an environment override', async () => {
    const resourcesPath = await fixtureDirectory()
    await writeConfig(resourcesPath, {
      schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
      enabled: true,
      configUrl: 'https://feed.example.test/v1/runtime/config.json',
      allowedConfigOrigins: ['https://feed.example.test'],
      allowedManifestOrigins: ['https://feed.example.test'],
      channel: 'stable',
      configPublicKeys,
      manifestPublicKeys,
      workspaceDependenciesEnabled: false
    })

    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).resolves.toMatchObject({
      workspaceDependenciesFeatureEnabled: false
    })
  })

  it('permits an ephemeral local CA only in a loopback engineering test resource', async () => {
    const resourcesPath = await fixtureDirectory()
    await writeConfig(resourcesPath, {
      schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
      enabled: true,
      configUrl: 'https://127.0.0.1:9443/v1/runtime/config.json',
      allowedConfigOrigins: ['https://127.0.0.1:9443'],
      allowedManifestOrigins: ['https://127.0.0.1:9443'],
      channel: 'engineering-test',
      configPublicKeys,
      manifestPublicKeys,
      engineeringTestLocalCaPath: '/private/tmp/engineering-test-ca.pem'
    })

    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).resolves.toMatchObject({
      primaryRuntimeProductConfig: {
        localTestCaPath: '/private/tmp/engineering-test-ca.pem',
        engineeringTestOnly: true
      }
    })

    await writeConfig(resourcesPath, {
      schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
      enabled: true,
      configUrl: 'https://feed.example.test/v1/runtime/config.json',
      allowedConfigOrigins: ['https://feed.example.test'],
      allowedManifestOrigins: ['https://feed.example.test'],
      channel: 'engineering-test',
      configPublicKeys,
      manifestPublicKeys,
      engineeringTestLocalCaPath: '/private/tmp/engineering-test-ca.pem'
    })
    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).rejects.toThrow(
      'incomplete or invalid'
    )
  })

  it('rejects incomplete, malformed, and symlinked package configuration', async () => {
    const resourcesPath = await fixtureDirectory()
    await writeConfig(resourcesPath, {
      schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
      enabled: true
    })
    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).rejects.toThrow(
      'incomplete'
    )

    await writeFile(join(resourcesPath, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE), '{broken')
    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).rejects.toThrow(
      'not valid JSON'
    )

    const externalPath = join(resourcesPath, 'external.json')
    await writeFile(externalPath, '{}')
    await rm(join(resourcesPath, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE), { force: true })
    await symlink(externalPath, join(resourcesPath, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE))
    await expect(readPackagedPrimaryRuntimeProductConfig(resourcesPath)).rejects.toThrow(
      'regular file'
    )
  })
})

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-packaged-config-'))
  directories.push(directory)
  return directory
}

async function writeConfig(resourcesPath: string, value: unknown): Promise<void> {
  await mkdir(resourcesPath, { recursive: true })
  await writeFile(
    join(resourcesPath, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE),
    `${JSON.stringify(value)}\n`
  )
}
