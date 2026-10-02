import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE,
  PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA
} from './PrimaryRuntimePackagedProductConfig'
import { loadPrimaryRuntimeStartupConfig } from './PrimaryRuntimeStartupConfig'

const directories: string[] = []
const packagedProductConfig = {
  schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
  enabled: true,
  configUrl: 'https://feed.example.test/v1/runtime/config.json',
  allowedConfigOrigins: ['https://feed.example.test'],
  allowedManifestOrigins: ['https://feed.example.test'],
  channel: 'stable',
  configPublicKeys: { config: '-----BEGIN PUBLIC KEY-----\nconfig\n-----END PUBLIC KEY-----' },
  manifestPublicKeys: {
    manifest: '-----BEGIN PUBLIC KEY-----\nmanifest\n-----END PUBLIC KEY-----'
  },
  workspaceDependenciesEnabled: false
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('Primary Runtime startup config', () => {
  it('uses the package resource and ignores all Primary Runtime environment overrides', async () => {
    const resourcesPath = await resourcesDirectory(packagedProductConfig)

    await expect(
      loadPrimaryRuntimeStartupConfig({
        isPackaged: true,
        resourcesPath,
        env: {
          DASCOWORK_PRIMARY_RUNTIME_VERSION: 'attacker-controlled',
          DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: 'https://attacker.example.test/runtime.zip',
          DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256: 'a'.repeat(64),
          DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES: '123',
          DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS: 'https://attacker.example.test',
          DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL: 'https://attacker.example.test/config.json',
          DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS: 'https://attacker.example.test',
          DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS:
            'https://attacker.example.test',
          DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: 'attacker',
          DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: '{"config":"attacker"}',
          DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: '{"manifest":"attacker"}',
          DASCOWORK_WORKSPACE_DEPENDENCIES_ENABLED: 'true'
        }
      })
    ).resolves.toMatchObject({
      primaryRuntimeProductConfig: {
        configUrl: packagedProductConfig.configUrl,
        channel: packagedProductConfig.channel
      },
      workspaceDependenciesFeatureEnabled: false
    })
  })

  it('keeps packaged Runtime disabled when its resource is unavailable or invalid', async () => {
    const resourcesPath = await resourcesDirectory(undefined)
    const logError = vi.fn()
    await expect(
      loadPrimaryRuntimeStartupConfig({
        isPackaged: true,
        resourcesPath,
        env: releaseOverrideEnvironment(),
        logError
      })
    ).resolves.not.toHaveProperty('primaryRuntimeProductConfig')

    await writeFile(join(resourcesPath, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE), '{broken')
    await expect(
      loadPrimaryRuntimeStartupConfig({
        isPackaged: true,
        resourcesPath,
        env: releaseOverrideEnvironment(),
        logError
      })
    ).resolves.not.toHaveProperty('primaryRuntimeRelease')
    expect(logError).toHaveBeenCalledOnce()
  })

  it('preserves development Runtime overrides outside a packaged app', async () => {
    await expect(
      loadPrimaryRuntimeStartupConfig({
        isPackaged: false,
        resourcesPath: '/unused',
        env: releaseOverrideEnvironment()
      })
    ).resolves.toMatchObject({
      primaryRuntimeRelease: { version: 'development-runtime' }
    })
  })
})

async function resourcesDirectory(config: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'primary-runtime-startup-config-'))
  directories.push(directory)
  if (config) {
    await writeFile(
      join(directory, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE),
      `${JSON.stringify(config)}\n`
    )
  }
  return directory
}

function releaseOverrideEnvironment(): NodeJS.ProcessEnv {
  return {
    DASCOWORK_PRIMARY_RUNTIME_VERSION: 'development-runtime',
    DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL: 'https://development.example.test/runtime.zip',
    DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256: 'a'.repeat(64),
    DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES: '123',
    DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS: 'https://development.example.test'
  }
}
