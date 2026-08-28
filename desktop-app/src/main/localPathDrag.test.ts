import { describe, expect, it, vi } from 'vitest'

import { createStartLocalPathDragHandler } from './localPathDrag'

describe('localPathDrag', () => {
  it('starts a native drag only for an existing regular local file', () => {
    const startDrag = vi.fn()
    const handler = createStartLocalPathDragHandler(
      startDrag,
      vi.fn(() => ({ isFile: () => true })) as never
    )

    handler({ path: 'reports/summary.pdf', cwd: '/tmp/dasCowork' })

    expect(startDrag).toHaveBeenCalledWith('/tmp/dasCowork/reports/summary.pdf')
  })

  it.each([
    [{ path: '../outside.pdf', cwd: '/tmp/dasCowork' }, 'unsafe path'],
    [{ path: '/tmp/folder' }, 'directory'],
    [{ path: '/tmp/missing.pdf' }, 'missing file']
  ])('does not start a drag for a $1', (payload, _reason) => {
    void _reason
    const startDrag = vi.fn()
    const getFileStats = vi.fn((path: string) => {
      if (path === '/tmp/folder') return { isFile: () => false }
      throw new Error('missing')
    })
    const handler = createStartLocalPathDragHandler(startDrag, getFileStats as never)

    handler(payload)

    expect(startDrag).not.toHaveBeenCalled()
  })
})
