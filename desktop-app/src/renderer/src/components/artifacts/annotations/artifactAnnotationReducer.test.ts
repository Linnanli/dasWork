import { describe, expect, it } from 'vitest'

import {
  artifactAnnotationReducer,
  initialArtifactAnnotationState
} from './artifactAnnotationReducer'
import type { ArtifactAnnotation } from './artifactAnnotationTypes'

const annotation: ArtifactAnnotation = {
  id: 'annotation-one',
  sourceId: 'source-id-12345678',
  generation: 2,
  target: { kind: 'element', slideId: 'slide-1', objectId: 'slide-1:4' },
  body: '检查标题对齐',
  status: 'saved',
  createdAt: 1,
  updatedAt: 1
}

describe('artifactAnnotationReducer', () => {
  it('creates, saves, updates, and dismisses a stable annotation', () => {
    const editing = artifactAnnotationReducer(initialArtifactAnnotationState, {
      type: 'start',
      draft: { id: annotation.id, target: annotation.target, body: '' }
    })
    const typed = artifactAnnotationReducer(editing, { type: 'change-body', body: annotation.body })
    const saved = artifactAnnotationReducer(typed, { type: 'save', annotation })
    const updated = artifactAnnotationReducer(saved, {
      type: 'update',
      id: annotation.id,
      body: '检查标题和副标题对齐',
      updatedAt: 2
    })

    expect(updated.annotations).toEqual([
      expect.objectContaining({ body: '检查标题和副标题对齐', status: 'saved', updatedAt: 2 })
    ])
    expect(artifactAnnotationReducer(updated, { type: 'dismiss', id: annotation.id })).toEqual({
      annotations: []
    })
  })

  it('clears only stale annotations for a changed source generation', () => {
    const state = {
      annotations: [annotation, { ...annotation, id: 'annotation-two', generation: 3 }]
    }

    expect(
      artifactAnnotationReducer(state, {
        type: 'clear-source',
        sourceId: annotation.sourceId,
        generation: 2
      }).annotations
    ).toEqual([expect.objectContaining({ id: 'annotation-two' })])
  })
})
