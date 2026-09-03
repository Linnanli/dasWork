import type { ArtifactAnnotation, ArtifactAnnotationDraft } from './artifactAnnotationTypes'

export type ArtifactAnnotationState = {
  annotations: readonly ArtifactAnnotation[]
  editor?: ArtifactAnnotationDraft
}

export type ArtifactAnnotationAction =
  | { type: 'start'; draft: ArtifactAnnotationDraft }
  | { type: 'change-body'; body: string }
  | { type: 'cancel-editor' }
  | { type: 'save'; annotation: ArtifactAnnotation }
  | { type: 'update'; id: string; body: string; updatedAt: number }
  | { type: 'dismiss'; id: string }
  | { type: 'clear-source'; sourceId: string; generation?: number }

export const initialArtifactAnnotationState: ArtifactAnnotationState = { annotations: [] }

export function artifactAnnotationReducer(
  state: ArtifactAnnotationState,
  action: ArtifactAnnotationAction
): ArtifactAnnotationState {
  switch (action.type) {
    case 'start':
      return { ...state, editor: action.draft }
    case 'change-body':
      return state.editor ? { ...state, editor: { ...state.editor, body: action.body } } : state
    case 'cancel-editor':
      return state.editor ? { ...state, editor: undefined } : state
    case 'save':
      return {
        annotations: [
          ...state.annotations.filter((annotation) => annotation.id !== action.annotation.id),
          action.annotation
        ],
        editor: undefined
      }
    case 'update':
      return {
        ...state,
        annotations: state.annotations.map((annotation) =>
          annotation.id === action.id
            ? { ...annotation, body: action.body, updatedAt: action.updatedAt, status: 'saved' }
            : annotation
        )
      }
    case 'dismiss':
      return {
        ...state,
        annotations: state.annotations.filter((annotation) => annotation.id !== action.id),
        editor: state.editor?.id === action.id ? undefined : state.editor
      }
    case 'clear-source':
      return {
        annotations: state.annotations.filter(
          (annotation) =>
            annotation.sourceId !== action.sourceId ||
            (action.generation !== undefined && annotation.generation !== action.generation)
        ),
        editor: undefined
      }
  }
}
