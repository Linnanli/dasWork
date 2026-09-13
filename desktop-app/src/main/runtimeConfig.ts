import { isAbsolute } from 'node:path'

export type DesktopRuntimeConfig = {
  adminBackendUrl?: string
  adminBackendModelUserId?: string
  adminBackendModelCacheTtlMs?: number
  remoteCodexCommand?: string
  terminalCommand?: string
  /** Product-owned gate for the local workspace-dependencies capability. */
  workspaceDependenciesFeatureEnabled?: boolean
  primaryRuntimeRelease?: {
    version: string
    archiveUrl: string
    archiveSha256: string
    archiveSizeBytes: number
    allowedOrigins: string[]
  }
  primaryRuntimeManifest?: {
    manifestUrl: string
    allowedOrigins: string[]
    channel: string
  }
  /** Signed config/feed override used by development and managed deployments. */
  primaryRuntimeProductConfig?: {
    configUrl: string
    allowedConfigOrigins: string[]
    allowedManifestOrigins: string[]
    channel: string
    configPublicKeys: Readonly<Record<string, string>>
    manifestPublicKeys: Readonly<Record<string, string>>
    pollIntervalMs?: number
    /** Main-only development input; packaged builds reject it before network use. */
    localTestCaPath?: string
    /**
     * Present only when a packaged engineering test resource binds a loopback
     * feed to an ephemeral local CA. It is never sourced from the environment.
     */
    engineeringTestOnly?: true
  }
}

export function loadDesktopRuntimeConfig(env: NodeJS.ProcessEnv): DesktopRuntimeConfig {
  const adminBackendUrl = env['ADMIN_BACKEND_URL']?.trim()
  const adminBackendModelUserId = env['ADMIN_BACKEND_MODEL_USER_ID']?.trim()
  const adminBackendModelCacheTtlMs = parsePositiveInteger(env['ADMIN_BACKEND_MODEL_CACHE_TTL_MS'])
  const remoteCodexCommand = parseRemoteCodexCommand(env['DASCOWORK_REMOTE_CODEX_COMMAND'])
  const terminalCommand = parseTerminalCommand(env['DASCOWORK_TERMINAL_COMMAND'])
  const workspaceDependenciesFeatureEnabled = parseOptionalBoolean(
    env['DASCOWORK_WORKSPACE_DEPENDENCIES_ENABLED'],
    'DASCOWORK_WORKSPACE_DEPENDENCIES_ENABLED'
  )
  const primaryRuntimeRelease = parsePrimaryRuntimeRelease(env)
  const primaryRuntimeManifest = parsePrimaryRuntimeManifest(env)
  const primaryRuntimeProductConfig = parsePrimaryRuntimeProductConfig(env)
  if (
    [primaryRuntimeRelease, primaryRuntimeManifest, primaryRuntimeProductConfig].filter(Boolean)
      .length > 1
  ) {
    throw new Error(
      'Primary Runtime direct release, signed manifest, and signed product config configuration cannot be used together.'
    )
  }

  if (!adminBackendUrl) {
    return {
      ...(remoteCodexCommand ? { remoteCodexCommand } : {}),
      ...(terminalCommand ? { terminalCommand } : {}),
      ...(workspaceDependenciesFeatureEnabled === undefined
        ? {}
        : { workspaceDependenciesFeatureEnabled }),
      ...(primaryRuntimeRelease ? { primaryRuntimeRelease } : {}),
      ...(primaryRuntimeManifest ? { primaryRuntimeManifest } : {}),
      ...(primaryRuntimeProductConfig ? { primaryRuntimeProductConfig } : {})
    }
  }

  return {
    adminBackendUrl,
    ...(adminBackendModelUserId ? { adminBackendModelUserId } : {}),
    ...(adminBackendModelCacheTtlMs ? { adminBackendModelCacheTtlMs } : {}),
    ...(remoteCodexCommand ? { remoteCodexCommand } : {}),
    ...(terminalCommand ? { terminalCommand } : {}),
    ...(workspaceDependenciesFeatureEnabled === undefined
      ? {}
      : { workspaceDependenciesFeatureEnabled }),
    ...(primaryRuntimeRelease ? { primaryRuntimeRelease } : {}),
    ...(primaryRuntimeManifest ? { primaryRuntimeManifest } : {}),
    ...(primaryRuntimeProductConfig ? { primaryRuntimeProductConfig } : {})
  }
}

function parsePrimaryRuntimeProductConfig(
  env: NodeJS.ProcessEnv
): DesktopRuntimeConfig['primaryRuntimeProductConfig'] {
  const configUrl = env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL']?.trim()
  const allowedConfigOrigins = env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS']?.trim()
  const allowedManifestOrigins =
    env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS']?.trim()
  const channel = env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL']?.trim()
  const configPublicKeys = env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON']?.trim()
  const manifestPublicKeys =
    env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON']?.trim()
  const localTestCaPath = env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH']?.trim()
  const configured = [
    configUrl,
    allowedConfigOrigins,
    allowedManifestOrigins,
    channel,
    configPublicKeys,
    manifestPublicKeys
  ].filter((value) => value !== undefined && value !== '').length
  if (configured === 0) {
    if (localTestCaPath) {
      throw new Error('Primary Runtime local test CA requires signed product config settings.')
    }
    return undefined
  }
  if (
    configured !== 6 ||
    !configUrl ||
    !allowedConfigOrigins ||
    !allowedManifestOrigins ||
    !channel ||
    !configPublicKeys ||
    !manifestPublicKeys
  ) {
    throw new Error(
      'Primary Runtime signed product config must provide URL, config/manifest origins, channel, and both public keyrings together.'
    )
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(channel)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL is invalid.')
  }
  const url = new URL(configUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL must be an HTTPS URL without credentials or fragment.'
    )
  }
  const configOrigins = parseAllowedHttpsOrigins(allowedConfigOrigins)
  if (!configOrigins.includes(url.origin)) {
    throw new Error('Primary Runtime config URL origin is not in the configured allowlist.')
  }
  const pollIntervalMs = parsePositiveInteger(
    env['DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS']
  )
  if (pollIntervalMs !== undefined && pollIntervalMs < 30_000) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS must be at least 30000.')
  }
  if (localTestCaPath && !isAbsolute(localTestCaPath)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH must be absolute.')
  }
  return {
    configUrl: url.toString(),
    allowedConfigOrigins: configOrigins,
    allowedManifestOrigins: parseAllowedHttpsOrigins(allowedManifestOrigins),
    channel,
    configPublicKeys: parseRuntimePublicKeyring(
      configPublicKeys,
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON'
    ),
    manifestPublicKeys: parseRuntimePublicKeyring(
      manifestPublicKeys,
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON'
    ),
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    ...(localTestCaPath ? { localTestCaPath } : {})
  }
}

function parseRuntimePublicKeyring(
  value: string,
  variable: string
): Readonly<Record<string, string>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`${variable} must contain a JSON public key map.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${variable} must contain a JSON public key map.`)
  }
  const entries = Object.entries(parsed)
  if (
    entries.length === 0 ||
    entries.some(
      ([keyId, key]) =>
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(keyId) ||
        typeof key !== 'string' ||
        !key.includes('BEGIN PUBLIC KEY') ||
        key.includes('PRIVATE KEY')
    )
  ) {
    throw new Error(`${variable} must contain non-empty PEM public keys only.`)
  }
  return Object.freeze(Object.fromEntries(entries))
}

function parsePrimaryRuntimeManifest(
  env: NodeJS.ProcessEnv
): DesktopRuntimeConfig['primaryRuntimeManifest'] {
  const manifestUrl = env['DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL']?.trim()
  const allowedOriginsValue = env['DASCOWORK_PRIMARY_RUNTIME_MANIFEST_ALLOWED_ORIGINS']?.trim()
  const channel = env['DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL']?.trim()
  const configured = [manifestUrl, allowedOriginsValue, channel].filter(
    (value) => value !== undefined && value !== ''
  ).length
  if (configured === 0) return undefined
  if (configured !== 3 || !manifestUrl || !allowedOriginsValue || !channel) {
    throw new Error(
      'Primary Runtime signed manifest must provide HTTPS URL, allowed HTTPS origins, and channel together.'
    )
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(channel)) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_MANIFEST_CHANNEL is invalid.')
  }
  const url = new URL(manifestUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(
      'DASCOWORK_PRIMARY_RUNTIME_MANIFEST_URL must be an HTTPS URL without credentials or fragment.'
    )
  }
  const allowedOrigins = parseAllowedHttpsOrigins(allowedOriginsValue)
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error('Primary Runtime manifest URL origin is not in the configured allowlist.')
  }
  return { manifestUrl: url.toString(), allowedOrigins, channel }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined

  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new Error(`${name} must be true or false when configured.`)
}

function parseRemoteCodexCommand(value: string | undefined): string | undefined {
  return parseExecutableCommand(value, 'DASCOWORK_REMOTE_CODEX_COMMAND')
}

function parseTerminalCommand(value: string | undefined): string | undefined {
  return parseExecutableCommand(value, 'DASCOWORK_TERMINAL_COMMAND')
}

function parsePrimaryRuntimeRelease(
  env: NodeJS.ProcessEnv
): DesktopRuntimeConfig['primaryRuntimeRelease'] {
  const version = env['DASCOWORK_PRIMARY_RUNTIME_VERSION']?.trim()
  const archiveUrl = env['DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL']?.trim()
  const archiveSha256 = env['DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256']?.trim().toLowerCase()
  const archiveSizeBytes = parsePositiveInteger(env['DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SIZE_BYTES'])
  const allowedOriginsValue = env['DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS']?.trim()
  const configured = [
    version,
    archiveUrl,
    archiveSha256,
    archiveSizeBytes,
    allowedOriginsValue
  ].filter((value) => value !== undefined && value !== '').length
  if (configured === 0) return undefined
  if (
    configured !== 5 ||
    !version ||
    !archiveUrl ||
    !archiveSha256 ||
    !archiveSizeBytes ||
    !allowedOriginsValue
  ) {
    throw new Error(
      'Primary Runtime release must provide version, HTTPS archive URL, SHA-256, archive size, and allowed HTTPS origins together.'
    )
  }
  const url = new URL(archiveUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(
      'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL must be an HTTPS URL without credentials or fragment.'
    )
  }
  if (!/^[a-f0-9]{64}$/u.test(archiveSha256)) {
    throw new Error(
      'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_SHA256 must be a lowercase SHA-256 hex digest.'
    )
  }
  const allowedOrigins = parseAllowedHttpsOrigins(allowedOriginsValue)
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error('Primary Runtime archive URL origin is not in the configured allowlist.')
  }
  return { version, archiveUrl: url.toString(), archiveSha256, archiveSizeBytes, allowedOrigins }
}

function parseAllowedHttpsOrigins(value: string): string[] {
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          'DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS must contain HTTPS origins only.'
        )
      }
      return url.origin
    })
  if (origins.length === 0) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_ALLOWED_ORIGINS must not be empty.')
  }
  return [...new Set(origins)]
}

function parseExecutableCommand(value: string | undefined, variable: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  if (
    trimmed.includes('\0') ||
    /[\r\n]/u.test(trimmed) ||
    (!trimmed.startsWith('/') && !/^[A-Za-z0-9._+-]+$/u.test(trimmed))
  ) {
    throw new Error(`${variable} must be an executable name or absolute POSIX path`)
  }
  return trimmed
}
