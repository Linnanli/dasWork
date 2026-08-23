import type { WorkspaceFileLocation } from '../../workspace-container/workspaceOpenTargets'

export type CodePreviewSelection = { start: number; end: number }

export function codePreviewSelectionForLocation(
  location: WorkspaceFileLocation | undefined,
  text: string
): CodePreviewSelection | undefined {
  if (!location?.line) return undefined
  const lineCount = Math.max(1, text.split('\n').length)
  const start = Math.min(location.line, lineCount)
  const requestedEnd =
    location.endLine && location.endLine >= location.line ? location.endLine : start
  return { start, end: Math.min(Math.max(start, requestedEnd), lineCount) }
}
