export type ConversationStreamPerformanceEvent =
  | 'publish'
  | 'commit'
  | 'next-frame'
  | 'chat-commit'
  | 'viewport-ref-attach'
  | 'viewport-ref-detach'
  | 'viewport-node-replaced'
  | 'scroll-restore-setup'
  | 'scroll-restore-schedule'
  | 'scroll-restore-apply'
  | 'scroll-restore-cleanup'

declare global {
  var __DASCOWORK_CONVERSATION_PERF__: boolean | undefined
}

export type ConversationStreamPerformanceCounter =
  | 'conversationWorkspaceLayout'
  | 'activeConversationPane'
  | 'chatThread'
  | 'assistantMessage'
  | 'forwardedRefAttachCount'
  | 'forwardedRefDetachCount'
  | 'nodeReplacementCount'
  | 'scrollRestoreSetupCount'
  | 'scrollRestoreScheduleCount'
  | 'scrollRestoreApplyCount'
  | 'scrollRestoreCleanupCount'

export function isConversationStreamPerformanceEnabled(): boolean {
  return globalThis.__DASCOWORK_CONVERSATION_PERF__ === true
}

function markName(
  event: ConversationStreamPerformanceEvent,
  controllerId?: string,
  version?: number
): string {
  const parts = ['conversation-stream', event]
  if (controllerId !== undefined) parts.push(controllerId)
  if (version !== undefined) parts.push(String(version))
  return parts.join(':')
}

export function markConversationStreamEvent(
  event: ConversationStreamPerformanceEvent,
  controllerId?: string,
  version?: number
): void {
  if (!isConversationStreamPerformanceEnabled() || typeof performance === 'undefined') return
  performance.mark(markName(event, controllerId, version))
}

export function countConversationStreamPerformance(
  counter: ConversationStreamPerformanceCounter
): void {
  if (!isConversationStreamPerformanceEnabled()) return
  const target = globalThis as typeof globalThis & {
    __DASCOWORK_CONVERSATION_PERF_COUNTS__?: Partial<
      Record<ConversationStreamPerformanceCounter, number>
    >
  }
  const counts = (target.__DASCOWORK_CONVERSATION_PERF_COUNTS__ ??= {})
  counts[counter] = (counts[counter] ?? 0) + 1
}

export function markConversationStreamPublish(controllerId: string, version: number): void {
  markConversationStreamEvent('publish', controllerId, version)
}

export function markConversationStreamCommit(controllerId: string, version: number): void {
  if (!isConversationStreamPerformanceEnabled() || typeof performance === 'undefined') return
  const publish = markName('publish', controllerId, version)
  const commit = markName('commit', controllerId, version)
  performance.mark(commit)
  try {
    performance.measure(
      `conversation-stream:publish-to-commit:${controllerId}:${version}`,
      publish,
      commit
    )
  } catch {
    return
  }
}

export function scheduleConversationStreamNextFrame(controllerId: string, version: number): void {
  if (!isConversationStreamPerformanceEnabled() || typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    if (!isConversationStreamPerformanceEnabled() || typeof performance === 'undefined') return
    const nextFrame = markName('next-frame', controllerId, version)
    performance.mark(nextFrame)
    try {
      performance.measure(
        `conversation-stream:commit-to-next-frame:${controllerId}:${version}`,
        markName('commit', controllerId, version),
        nextFrame
      )
    } catch {
      return
    }
  })
}

export function clearConversationStreamPerformance(): void {
  if (typeof performance === 'undefined') return
  const target = globalThis as typeof globalThis & {
    __DASCOWORK_CONVERSATION_PERF_COUNTS__?: Partial<
      Record<ConversationStreamPerformanceCounter, number>
    >
  }
  target.__DASCOWORK_CONVERSATION_PERF_COUNTS__ = {}
  for (const entry of performance.getEntriesByType('mark')) {
    if (entry.name.startsWith('conversation-stream:')) performance.clearMarks(entry.name)
  }
  for (const entry of performance.getEntriesByType('measure')) {
    if (entry.name.startsWith('conversation-stream:')) performance.clearMeasures(entry.name)
  }
}
