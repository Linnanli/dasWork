import { statSync } from 'node:fs'

import {
  codexStartLocalPathDragPayloadSchema,
  type CodexStartLocalPathDragPayload
} from '../shared/codexIpcApi'
import { resolveLocalOpenPath } from './localPathOpen'

type StartDrag = (path: string) => void

export function createStartLocalPathDragHandler(
  startDrag: StartDrag,
  getFileStats: typeof statSync = statSync
): (payload: unknown) => void {
  return (payload) => {
    const request = codexStartLocalPathDragPayloadSchema.safeParse(payload)
    if (!request.success) return

    const resolvedPath = safeResolvePath(request.data)
    if (!resolvedPath || !isRegularFile(resolvedPath, getFileStats)) return
    startDrag(resolvedPath)
  }
}

function safeResolvePath(request: CodexStartLocalPathDragPayload): string | undefined {
  try {
    return resolveLocalOpenPath(request)
  } catch {
    return undefined
  }
}

function isRegularFile(path: string, getFileStats: typeof statSync): boolean {
  try {
    return getFileStats(path).isFile()
  } catch {
    return false
  }
}
