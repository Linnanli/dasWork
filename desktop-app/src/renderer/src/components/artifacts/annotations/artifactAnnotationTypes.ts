export type ArtifactAnnotationTarget =
  | { kind: 'slide'; slideId: string }
  | { kind: 'element'; slideId: string; objectId: string }
  | {
      kind: 'region'
      slideId: string
      x: number
      y: number
      width: number
      height: number
    }

export type ArtifactAnnotation = {
  id: string
  sourceId: string
  generation: number
  target: ArtifactAnnotationTarget
  body: string
  status: 'draft' | 'saved' | 'submitted'
  createdAt: number
  updatedAt: number
}

export type ArtifactAnnotationDraft = {
  id: string
  target: ArtifactAnnotationTarget
  body: string
}

export function annotationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
