import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { loadDesktopRuntimeConfig, type DesktopRuntimeConfig } from '../runtimeConfig'

export const PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE =
  'primary-runtime-product-config.json' as const
export const PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA =
  'dascowork-primary-runtime-product-config.v1' as const

export type PackagedPrimaryRuntimeRuntimeConfig = Pick<
  DesktopRuntimeConfig,
  'primaryRuntimeProductConfig' | 'workspaceDependenciesFeatureEnabled'
>

type PackagedPrimaryRuntimeProductConfig = {
  schemaVersion: typeof PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA
  enabled: boolean
  configUrl?: string
  allowedConfigOrigins?: string[]
  allowedManifestOrigins?: string[]
  channel?: string
  configPublicKeys?: Record<string, string>
  manifestPublicKeys?: Record<string, string>
  pollIntervalMs?: number
  workspaceDependenciesEnabled?: boolean
}

/**
 * Reads only the signed app resource for a packaged client. The file contains
 * public trust material, never credentials or private signing keys. A disabled
 * resource keeps ordinary packaged smoke builds Runtime-free without allowing
 * environment variables to substitute a production trust root.
 */
export async function readPackagedPrimaryRuntimeProductConfig(
  resourcesPath: string
): Promise<PackagedPrimaryRuntimeRuntimeConfig | undefined> {
  const root = resolve(resourcesPath)
  const path = resolve(root, PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_FILE)
  if (!isInside(root, path)) {
    throw new Error('Packaged Primary Runtime config path escapes application resources.')
  }

  let source: string
  try {
    const details = await lstat(path)
    if (!details.isFile()) {
      throw new Error('Packaged Primary Runtime config must be a regular file.')
    }
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('Packaged Primary Runtime config is not valid JSON.')
  }
  const productConfig = parsePackagedProductConfig(parsed)
  if (!productConfig.enabled) return undefined

  const runtimeConfig = loadDesktopRuntimeConfig({
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL: productConfig.configUrl,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS: productConfig.allowedConfigOrigins?.join(','),
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS:
      productConfig.allowedManifestOrigins?.join(','),
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL: productConfig.channel,
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON: JSON.stringify(
      productConfig.configPublicKeys
    ),
    DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON: JSON.stringify(
      productConfig.manifestPublicKeys
    ),
    ...(productConfig.workspaceDependenciesEnabled === undefined
      ? {}
      : {
          DASCOWORK_WORKSPACE_DEPENDENCIES_ENABLED: String(
            productConfig.workspaceDependenciesEnabled
          )
        }),
    ...(productConfig.pollIntervalMs === undefined
      ? {}
      : { DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS: String(productConfig.pollIntervalMs) })
  })
  if (!runtimeConfig.primaryRuntimeProductConfig) {
    throw new Error(
      'Packaged Primary Runtime config did not produce a product release configuration.'
    )
  }
  return {
    primaryRuntimeProductConfig: runtimeConfig.primaryRuntimeProductConfig,
    ...(runtimeConfig.workspaceDependenciesFeatureEnabled === undefined
      ? {}
      : { workspaceDependenciesFeatureEnabled: runtimeConfig.workspaceDependenciesFeatureEnabled })
  }
}

function parsePackagedProductConfig(value: unknown): PackagedPrimaryRuntimeProductConfig {
  if (!isRecord(value) || value.schemaVersion !== PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA) {
    throw new Error('Packaged Primary Runtime config has an invalid schema version.')
  }
  if (
    value.enabled === false &&
    Object.keys(value).every((key) => key === 'schemaVersion' || key === 'enabled')
  ) {
    return { schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA, enabled: false }
  }
  const pollIntervalMs = value.pollIntervalMs
  if (
    value.enabled !== true ||
    typeof value.configUrl !== 'string' ||
    !isStringArray(value.allowedConfigOrigins) ||
    !isStringArray(value.allowedManifestOrigins) ||
    typeof value.channel !== 'string' ||
    !isStringRecord(value.configPublicKeys) ||
    !isStringRecord(value.manifestPublicKeys) ||
    (pollIntervalMs !== undefined &&
      (typeof pollIntervalMs !== 'number' ||
        !Number.isSafeInteger(pollIntervalMs) ||
        pollIntervalMs <= 0)) ||
    (value.workspaceDependenciesEnabled !== undefined &&
      typeof value.workspaceDependenciesEnabled !== 'boolean')
  ) {
    throw new Error('Packaged Primary Runtime config is incomplete or invalid.')
  }
  return {
    schemaVersion: PRIMARY_RUNTIME_PACKAGED_PRODUCT_CONFIG_SCHEMA,
    enabled: true,
    configUrl: value.configUrl,
    allowedConfigOrigins: value.allowedConfigOrigins,
    allowedManifestOrigins: value.allowedManifestOrigins,
    channel: value.channel,
    configPublicKeys: value.configPublicKeys,
    manifestPublicKeys: value.manifestPublicKeys,
    ...(value.workspaceDependenciesEnabled === undefined
      ? {}
      : { workspaceDependenciesEnabled: value.workspaceDependenciesEnabled }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs })
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isInside(root: string, path: string): boolean {
  const difference = relative(root, path)
  return difference !== '' && !difference.startsWith('..') && !isAbsolute(difference)
}
