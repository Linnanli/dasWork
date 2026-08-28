const MAX_REMOTE_EXEC_SERVER_URL_LENGTH = 2048

/**
 * Normalizes the WebSocket endpoint used by Codex app-server to reach a
 * configured remote execution environment. Credentials and query strings are
 * intentionally excluded because this value is persisted in project state.
 */
export function normalizeRemoteExecServerUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_REMOTE_EXEC_SERVER_URL_LENGTH) {
    throw new Error('Remote execution server URL must be between 1 and 2048 characters')
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Remote execution server URL must be a valid WebSocket URL')
  }

  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('Remote execution server URL must use ws:// or wss://')
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Remote execution server URL must not include credentials, query parameters, or a fragment'
    )
  }

  return url.toString()
}
