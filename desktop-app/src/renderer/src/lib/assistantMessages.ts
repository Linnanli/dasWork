export const pendingAssistantMessageText = '正在思考'
export const delayedAssistantMessageText = '处理时间比平常更长'
export const delayedAssistantMessageThresholdMs = 24_000
export const processingAssistantMessageText = '处理中'
export const blockedAssistantMessageText = '等待确认'

type AssistantMessageContentPart = {
  readonly type: string
  readonly text?: string
}

export function hasVisibleAssistantTextContent(
  content: readonly AssistantMessageContentPart[]
): boolean {
  return content.some(
    (part) =>
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.trim().length > 0 &&
      part.text !== pendingAssistantMessageText
  )
}
