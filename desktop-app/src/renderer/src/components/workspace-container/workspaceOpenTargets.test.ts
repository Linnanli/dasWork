import { describe, expect, it } from 'vitest'

import { createWorkspaceDescriptor } from './workspaceOpenTargets'

describe('createWorkspaceDescriptor', () => {
  it('creates a stable file identity and a preview by default', () => {
    expect(
      createWorkspaceDescriptor({ type: 'file', relativePath: './src\\App.tsx' })
    ).toMatchObject({
      id: 'file:src/App.tsx',
      kind: 'file',
      title: 'App.tsx',
      props: { relativePath: 'src/App.tsx' },
      isPreview: true
    })
  })

  it('canonicalizes dot segments before creating a file tab', () => {
    expect(
      createWorkspaceDescriptor({ type: 'file', relativePath: 'src/./components//App.tsx' })
    ).toMatchObject({
      id: 'file:src/components/App.tsx',
      props: { relativePath: 'src/components/App.tsx' }
    })
  })

  it('uses a pinned singleton descriptor for the Files launcher', () => {
    expect(createWorkspaceDescriptor({ type: 'file', relativePath: '' })).toMatchObject({
      id: 'files:explorer',
      title: 'Files',
      isPreview: false
    })
  })

  it('keeps file locations out of the stable tab identity and carries folder reveal state', () => {
    expect(
      createWorkspaceDescriptor({
        type: 'file',
        relativePath: 'src/App.tsx',
        location: { line: 42, column: 3, endLine: 45 }
      })
    ).toMatchObject({
      id: 'file:src/App.tsx',
      props: { relativePath: 'src/App.tsx', line: 42, column: 3, endLine: 45 }
    })
    expect(
      createWorkspaceDescriptor({ type: 'file', relativePath: '', revealPath: 'src/components/' })
    ).toMatchObject({
      id: 'files:explorer',
      props: { relativePath: '', revealPath: 'src/components' },
      isPreview: false
    })
  })

  it('keeps review, terminal, and browser tabs pinned', () => {
    expect(createWorkspaceDescriptor({ type: 'review' }).isPreview).toBe(false)
    expect(createWorkspaceDescriptor({ type: 'terminal', id: 'terminal:1' }).isPreview).toBe(false)
    expect(createWorkspaceDescriptor({ type: 'browser', id: 'browser:1' }).isPreview).toBe(false)
  })
})
