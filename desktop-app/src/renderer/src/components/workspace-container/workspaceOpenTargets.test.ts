import { describe, expect, it } from 'vitest'

import { createWorkspaceDescriptor, isPptxArtifactPath } from './workspaceOpenTargets'

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

  it('classifies only modern PPTX files as presentation artifacts', () => {
    expect(isPptxArtifactPath('slides/季度汇报.PPTX')).toBe(true)
    expect(isPptxArtifactPath('slides/quarterly.pptx')).toBe(true)
    expect(isPptxArtifactPath('slides/legacy.ppt')).toBe(false)
    expect(isPptxArtifactPath('slides/macro.pptm')).toBe(false)
    expect(isPptxArtifactPath('slides/show.ppsx')).toBe(false)
    expect(isPptxArtifactPath('slides/presentation.pptx.exe')).toBe(false)
  })

  it('creates a stable artifact tab and retains one sanitized navigation command', () => {
    expect(
      createWorkspaceDescriptor({
        type: 'artifact',
        artifactType: 'slides',
        importKind: 'pptx',
        source: { kind: 'workspace-file', relativePath: './slides\\roadmap.PPTX' },
        title: '  路线图  ',
        openSource: 'generated-resource',
        originatingTurn: { threadId: 'thread-1', turnId: 'turn-1' },
        navigation: {
          requestId: 'request-1',
          artifactKind: 'presentation',
          slideNumber: 3,
          objectId: 'shape-5'
        }
      })
    ).toMatchObject({
      id: 'artifact:workspace:slides/roadmap.PPTX',
      kind: 'artifact',
      title: '路线图',
      isPreview: true,
      props: {
        artifactType: 'slides',
        importKind: 'pptx',
        source: { kind: 'workspace-file', relativePath: 'slides/roadmap.PPTX' },
        navigation: {
          requestId: 'request-1',
          artifactKind: 'presentation',
          slideNumber: 3,
          objectId: 'shape-5'
        }
      }
    })
  })

  it('uses opaque local source ids and rejects a forged identifier', () => {
    const sourceId = 'impossible-to-guess-source-id'
    expect(
      createWorkspaceDescriptor({
        type: 'artifact',
        artifactType: 'slides',
        importKind: 'pptx',
        source: { kind: 'authorized-local', sourceId },
        title: '附件.pptx',
        openSource: 'composer-attachment',
        attachmentPreview: { origin: 'composer', requestId: 'preview-request' }
      })
    ).toMatchObject({ id: `artifact:local:${sourceId}`, props: { source: { sourceId } } })

    expect(() =>
      createWorkspaceDescriptor({
        type: 'artifact',
        artifactType: 'slides',
        importKind: 'pptx',
        source: { kind: 'authorized-local', sourceId: '../../not-a-capability' },
        title: '附件.pptx',
        openSource: 'composer-attachment'
      })
    ).toThrow('Artifact source id is invalid')
  })
})
