import { isAbsolute, join } from 'node:path'

export function resolvePrimaryRuntimeCacheRoot({
  userDataPath,
  localFeedCachePath,
  useLocalFeedCache = false,
  isPackaged
}: {
  userDataPath: string
  localFeedCachePath?: string
  useLocalFeedCache?: boolean
  isPackaged: boolean
}): string {
  const override = localFeedCachePath?.trim()
  if (isPackaged && (override || useLocalFeedCache)) {
    throw new Error('Development Primary Runtime cache override is not allowed in packaged builds.')
  }
  if (!override) {
    return join(userDataPath, useLocalFeedCache ? 'primary-runtime-local-feed' : 'primary-runtime')
  }
  if (!isAbsolute(override)) {
    throw new Error('Development Primary Runtime cache path must be absolute.')
  }
  return override
}
