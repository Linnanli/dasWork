import { describe, expect, it } from 'vitest'

import { rasterizePresentationSvg } from './rasterizePresentationSvg'

describe('rasterizePresentationSvg', () => {
  it('rejects oversized SVG dimensions before creating an Electron window', async () => {
    await expect(
      rasterizePresentationSvg('<svg width="4097" height="1080"></svg>', 100)
    ).rejects.toThrow('unsupported presentation slide dimensions')
    await expect(
      rasterizePresentationSvg('<svg width="4096" height="4096"></svg>', 100)
    ).rejects.toThrow('unsupported presentation slide dimensions')
  })
})
