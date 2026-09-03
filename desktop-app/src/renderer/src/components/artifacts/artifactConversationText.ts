import type { ArtifactAnnotation } from './annotations/artifactAnnotationTypes'

export type ArtifactConversationReference = {
  sourceId: string
  generation: number
  title: string
}

export function artifactConversationText(
  reference: ArtifactConversationReference,
  annotation?: ArtifactAnnotation
): string {
  const target = annotation ? annotationTargetText(annotation) : '整个演示文稿'
  const body = annotation ? `\n批注：${annotation.body}` : ''
  return `[Artifact PPTX：${reference.title}；目标：${target}；来源：${reference.sourceId}；版本：${reference.generation}]${body}`
}

function annotationTargetText(annotation: ArtifactAnnotation): string {
  switch (annotation.target.kind) {
    case 'slide':
      return `幻灯片 ${annotation.target.slideId}`
    case 'element':
      return `幻灯片 ${annotation.target.slideId} 的元素 ${annotation.target.objectId}`
    case 'region':
      return `幻灯片 ${annotation.target.slideId} 的选区`
  }
}
