import { loadDesktopRuntimeConfig, type DesktopRuntimeConfig } from '../runtimeConfig'
import { readPackagedPrimaryRuntimeProductConfig } from './PrimaryRuntimePackagedProductConfig'

export type PrimaryRuntimeStartupConfigOptions = {
  isPackaged: boolean
  resourcesPath: string
  env: NodeJS.ProcessEnv
  logError?: (message: string, error: unknown) => void
}

/**
 * A packaged app may receive only its code-signed resource trust root. Runtime
 * environment overrides remain useful for development and managed diagnostics,
 * but must not let an end user replace a production feed endpoint or keyring.
 */
export async function loadPrimaryRuntimeStartupConfig({
  isPackaged,
  resourcesPath,
  env,
  logError
}: PrimaryRuntimeStartupConfigOptions): Promise<DesktopRuntimeConfig> {
  if (!isPackaged) return loadDesktopRuntimeConfig(env)

  const runtimeConfig = loadDesktopRuntimeConfig(withoutPrimaryRuntimeEnvironmentOverrides(env))
  try {
    const packagedRuntimeConfig = await readPackagedPrimaryRuntimeProductConfig(resourcesPath)
    return {
      ...runtimeConfig,
      ...(packagedRuntimeConfig ?? {})
    }
  } catch (error) {
    // A bad optional Runtime resource must leave normal chat usable. The
    // PrimaryRuntimeService presents a safe disabled state instead of trying a
    // user-supplied or direct-download fallback.
    logError?.('[primary-runtime] packaged product config rejected', error)
    return runtimeConfig
  }
}

function withoutPrimaryRuntimeEnvironmentOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env }
  for (const key of PRIMARY_RUNTIME_ENVIRONMENT_OVERRIDE_KEYS) delete sanitized[key]
  return sanitized
}

const PRIMARY_RUNTIME_ENVIRONMENT_OVERRIDE_KEYS = [
  'DASCOWORK_WORKSPACE_DEPENDENCIES_ENABLED',
  'DASCOWORK_PRIMARY_RUNTIME_VERSION',
  'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL',
  'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256',
  'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES',
  'DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL',
  'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS',
  'DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH'
] as const
