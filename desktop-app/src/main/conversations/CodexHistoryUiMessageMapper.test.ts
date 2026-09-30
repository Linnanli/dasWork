import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { CodexTurnInputItem } from '@dascowork/codex-app-server-client'
import { mapCodexTurnToUiMessages } from './CodexHistoryUiMessageMapper'
import { normalizeLocalMediaUrls } from './localMediaUrls'

function historyUserParts(content: CodexTurnInputItem[]): UIMessage['parts'] {
  return mapCodexTurnToUiMessages({
    id: 'turn-image-attachments',
    durationMs: null,
    items: [{ type: 'userMessage', id: 'user-history', clientId: 'user-client', content }]
  })[0]!.parts
}

describe('historical user image attachments', () => {
  it.each([
    ['attachment-large.png', 'image/png'],
    ['空 格#%20.JPEG', 'image/jpeg'],
    ['attachment-small.jpg', 'image/jpeg'],
    ['unknown-image.bin', 'image/*'],
    ['not-an-image.pdf', 'image/*']
  ])('restores the source basename and image MIME for %s', (filename, mediaType) => {
    const path = join(process.platform === 'win32' ? 'C:\\images' : '/images', filename)
    expect(historyUserParts([{ type: 'localImage', path }])).toEqual([
      {
        type: 'file',
        filename,
        mediaType,
        url: pathToFileURL(path).href
      }
    ])
  })
  it('preserves the restored name and specific MIME through local-media URL normalization', () => {
    const path = join(
      process.platform === 'win32' ? 'C:\\images' : '/images',
      'attachment-large.png'
    )
    const parts = historyUserParts([{ type: 'localImage', path }])
    const restored = normalizeLocalMediaUrls([{ id: 'user-client', role: 'user', parts }])[0]!
    expect(restored.parts[0]).toMatchObject({
      type: 'file',
      filename: 'attachment-large.png',
      mediaType: 'image/png',
      url: expect.stringMatching(/^app:\/\/fs\/@fs\//u)
    })
  })
  it('uses the path spelling for a Windows image basename', () => {
    expect(
      historyUserParts([{ type: 'localImage', path: 'C:\\images\\literal%20.JPG' }])[0]
    ).toMatchObject({
      type: 'file',
      filename: 'literal%20.JPG',
      mediaType: 'image/jpeg'
    })
  })
  it('does not invent an original filename for data or remote image inputs', () => {
    const sources = ['data:image/png;base64,YWJj', 'https://example.com/original-name.png']
    const parts = historyUserParts(sources.map((url) => ({ type: 'image', url })))
    expect(parts).toEqual(sources.map((url) => ({ type: 'file', mediaType: 'image/*', url })))
    expect(parts.every((part) => !('filename' in part))).toBe(true)
  })
})
