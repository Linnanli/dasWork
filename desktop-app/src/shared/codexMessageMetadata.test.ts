import { describe, expect, it } from 'vitest'

import {
  CODEX_MESSAGE_METADATA_KEY,
  LEGACY_CODEX_MESSAGE_METADATA_KEY,
  codexMessageProviderMetadata,
  readCodexMessageMetadata
} from './codexMessageMetadata'

describe('Codex message metadata', () => {
  it('writes only the stable key for new native events', () => {
    expect(codexMessageProviderMetadata({ threadId: 'thread-1' })).toEqual({
      [CODEX_MESSAGE_METADATA_KEY]: { threadId: 'thread-1' }
    })
  })

  it('reads persisted legacy metadata when the stable key is absent', () => {
    expect(
      readCodexMessageMetadata({
        [LEGACY_CODEX_MESSAGE_METADATA_KEY]: { turnId: 'turn-1' }
      })
    ).toEqual({ turnId: 'turn-1' })
  })
})
