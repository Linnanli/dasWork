// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ResourceFileIcon } from './resourceFileIcon'
import { resourceFileIconKind } from './resourceFileIconKind'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('ResourceFileIcon', () => {
  it.each([
    ['SKILL.md', undefined, 'skill'],
    ['src/app.ts', undefined, 'typescript'],
    ['src/App.tsx', undefined, 'react'],
    ['assets/logo.png', undefined, 'image'],
    ['document.unknown', 'application/pdf', 'pdf'],
    ['archive.bin', 'application/gzip', 'folder']
  ])('classifies %s as %s', (path, mimeType, expected) => {
    expect(resourceFileIconKind(path, mimeType)).toBe(expected)
  })

  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the classified icon marker instead of only exposing a kind helper', () => {
    act(() => root.render(<ResourceFileIcon path="src/App.tsx" />))
    expect(container.querySelector('[data-file-icon="react"]')).not.toBeNull()
  })
})
