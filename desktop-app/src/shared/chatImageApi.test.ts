import { describe, expect, it } from 'vitest'
import {
  chatImageRequestSchema,
  chatImageSaveRequestSchema,
  parseChatImageDataUrl
} from './chatImageApi'

describe('chat image business contract', () => {
  it('preserves the source category and raw path bytes', () => {
    const input = {
      source: '/images/%20#.png',
      sourceKind: 'native-path',
      conversationId: 'one',
      threadId: 'one'
    }
    expect(chatImageRequestSchema.parse(input)).toEqual(input)
  })
  it.each(['../escape.png', 'dir/image.png', 'dir\\image.png', '\0.png'])(
    'rejects non-basename save names: %s',
    (fileName) => {
      expect(
        chatImageSaveRequestSchema.safeParse({
          source: '/one.png',
          sourceKind: 'native-path',
          fileName
        }).success
      ).toBe(false)
    }
  )
  it('accepts image bytes but rejects other MIME and malformed encoding', () => {
    expect(parseChatImageDataUrl('data:image/png;base64,YWJj')).toMatchObject({
      encoding: 'base64',
      data: 'YWJj'
    })
    expect(parseChatImageDataUrl('data:image/png,%89PNG%00')).toMatchObject({ encoding: 'url' })
    for (const source of [
      'data:text/html;base64,YWJj',
      'data:image/png;base64,YWJ',
      'data:image/png,%GG',
      'data:image/png,'
    ]) {
      expect(parseChatImageDataUrl(source)).toBeNull()
    }
  })
})
