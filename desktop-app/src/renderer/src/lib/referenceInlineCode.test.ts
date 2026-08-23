import { describe, expect, it } from 'vitest'

import { inlineCodeReference } from './referenceInlineCode'

describe('inlineCodeReference', () => {
  it('recognizes the reference inline-code decorations', () => {
    expect(inlineCodeReference('@src/App.tsx:42')).toMatchObject({
      kind: 'local-file',
      path: 'src/App.tsx',
      line: 42
    })
    expect(inlineCodeReference('[Prior task](thread://thread-child)')).toMatchObject({
      kind: 'conversation',
      targetId: 'thread-child'
    })
    expect(inlineCodeReference('$review')).toMatchObject({ kind: 'skill' })
  })

  it('leaves ordinary inline code and unsafe links undecorated', () => {
    expect(inlineCodeReference('const value = 1')).toBeUndefined()
    expect(inlineCodeReference('[unsafe](javascript:alert(1))')).toBeUndefined()
    expect(inlineCodeReference('[unknown](unknown://target)')).toBeUndefined()
  })
})
