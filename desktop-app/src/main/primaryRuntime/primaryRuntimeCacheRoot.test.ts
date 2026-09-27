import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolvePrimaryRuntimeCacheRoot } from './primaryRuntimeCacheRoot'

describe('resolvePrimaryRuntimeCacheRoot', () => {
  const userDataPath = join(tmpdir(), 'app-data')
  const localFeedCachePath = join(tmpdir(), 'local-feed', 'primary-runtime')

  it('keeps ordinary Runtime data under the app user data directory', () => {
    expect(
      resolvePrimaryRuntimeCacheRoot({
        userDataPath,
        isPackaged: false
      })
    ).toBe(join(userDataPath, 'primary-runtime'))
  })

  it('keeps the local Feed installation outside the project checkout', () => {
    expect(
      resolvePrimaryRuntimeCacheRoot({
        userDataPath,
        useLocalFeedCache: true,
        isPackaged: false
      })
    ).toBe(join(userDataPath, 'primary-runtime-local-feed'))
  })

  it('allows an explicit local Feed Runtime cache path', () => {
    expect(
      resolvePrimaryRuntimeCacheRoot({
        userDataPath,
        localFeedCachePath,
        isPackaged: false
      })
    ).toBe(localFeedCachePath)
  })

  it('rejects relative and packaged overrides', () => {
    expect(() =>
      resolvePrimaryRuntimeCacheRoot({
        userDataPath,
        localFeedCachePath: 'relative-cache',
        isPackaged: false
      })
    ).toThrow('must be absolute')
    expect(() =>
      resolvePrimaryRuntimeCacheRoot({
        userDataPath,
        localFeedCachePath,
        isPackaged: true
      })
    ).toThrow('not allowed in packaged builds')
    expect(() =>
      resolvePrimaryRuntimeCacheRoot({
        userDataPath,
        useLocalFeedCache: true,
        isPackaged: true
      })
    ).toThrow('not allowed in packaged builds')
  })
})
