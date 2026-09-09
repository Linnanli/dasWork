export type DesktopRuntimeConfig = {
  adminBackendUrl?: string
  adminBackendModelUserId?: string
  adminBackendModelCacheTtlMs?: number
  remoteCodexCommand?: string
  terminalCommand?: string
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
}

export function loadDesktopRuntimeConfig(env: NodeJS.ProcessEnv): DesktopRuntimeConfig {
  const adminBackendUrl = env['ADMIN_BACKEND_URL']?.trim()
  const adminBackendModelUserId = env['ADMIN_BACKEND_MODEL_USER_ID']?.trim()
  const adminBackendModelCacheTtlMs = parsePositiveInteger(env['ADMIN_BACKEND_MODEL_CACHE_TTL_MS'])
  const remoteCodexCommand = parseRemoteCodexCommand(env['DASCOWORK_REMOTE_CODEX_COMMAND'])
  const terminalCommand = parseTerminalCommand(env['DASCOWORK_TERMINAL_COMMAND'])
  const primaryRuntimeRelease = parsePrimaryRuntimeRelease(env)
  const primaryRuntimeManifest = parsePrimaryRuntimeManifest(env)
  if (primaryRuntimeRelease && primaryRuntimeManifest) {
    throw new Error(
      'Primary Runtime direct release override and signed manifest configuration cannot be used together.'
    )
  }

  if (!adminBackendUrl) {
    return {
      ...(remoteCodexCommand ? { remoteCodexCommand } : {}),
      ...(terminalCommand ? { terminalCommand } : {}),
      ...(primaryRuntimeRelease ? { primaryRuntimeRelease } : {}),
      ...(primaryRuntimeManifest ? { primaryRuntimeManifest } : {})
    }
  }

  return {
    adminBackendUrl,
    ...(adminBackendModelUserId ? { adminBackendModelUserId } : {}),
    ...(adminBackendModelCacheTtlMs ? { adminBackendModelCacheTtlMs } : {}),
    ...(remoteCodexCommand ? { remoteCodexCommand } : {}),
    ...(terminalCommand ? { terminalCommand } : {}),
    ...(primaryRuntimeRelease ? { primaryRuntimeRelease } : {}),
    ...(primaryRuntimeManifest ? { primaryRuntimeManifest } : {})
  }
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
