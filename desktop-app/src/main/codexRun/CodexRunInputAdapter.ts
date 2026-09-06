import { randomUUID } from 'node:crypto'
import { unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import type { UIMessage } from 'ai'
import {
  buildFilesMentionedContext,
  buildReferencedTasksContext,
  extractComposerContextDirectives,
  normalizeReferencedTask,
  threadIdFromTaskReference,
  type CodexTurnInputItem,
  type CodexTurnInputText,
  type LocalContextReference,
  type ReferencedTaskContext
} from '@dascowork/codex-app-server-client'

export const LOCAL_FILE_ATTACHMENT_MEDIA_TYPE = 'application/vnd.dascowork.local-file'
export const LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE = 'application/vnd.dascowork.local-folder'

export type CodexRunInput = {
  input: CodexTurnInputItem[]
  developerInstructions?: string
  cleanup(): Promise<void>
}

export type CodexRunInputAdapterOptions = {
  loadTask?: (threadId: string) => Promise<{ thread: unknown }>
}

/**
 * Desktop-owned UI projection for app-server `UserInput[]`. It deliberately
 * takes only the latest user message for both fresh and resumed turns, keeping
 * the former provider's attachment and composer-context semantics explicit.
 */
export class CodexRunInputAdapter {
  private readonly temporaryFiles: URL[] = []

  constructor(private readonly options: CodexRunInputAdapterOptions = {}) {}

  async resolve(
    messages: readonly UIMessage[],
    options: {
      developerInstructions?: string
      activeThreadId?: string
      goalFirstTurnObjective?: string
    } = {}
  ): Promise<CodexRunInput> {
    const input = await this.resolveLatestUserMessage(
      messages,
      options.activeThreadId,
      options.goalFirstTurnObjective
    )
    return {
      input,
      ...(options.developerInstructions?.trim()
        ? { developerInstructions: options.developerInstructions.trim() }
        : {}),
      cleanup: () => this.cleanup()
    }
  }

  async cleanup(): Promise<void> {
    const files = this.temporaryFiles.splice(0)
    await Promise.allSettled(
      files.filter((url) => url.protocol === 'file:').map((url) => unlink(url))
    )
  }

  private async resolveLatestUserMessage(
    messages: readonly UIMessage[],
    activeThreadId: string | undefined,
    goalFirstTurnObjective: string | undefined
  ): Promise<CodexTurnInputItem[]> {
    const framedGoal = goalFirstTurnObjective?.trim()
      ? goalFirstTurnText(goalFirstTurnObjective.trim())
      : undefined
    const message = messages.findLast((candidate) => candidate.role === 'user')
    if (!message) return [textInput(framedGoal ?? '')]

    const textChunks: string[] = []
    const contextInputs: CodexTurnInputItem[] = []
    const contextInputKeys = new Set<string>()
    const localReferences: LocalContextReference[] = []
    const localReferencePaths = new Set<string>()
    const taskThreadIds = new Set<string>()
    const attachments: CodexTurnInputItem[] = []

    for (const part of message.parts) {
      if (part.type === 'text') {
        if (framedGoal) continue
        const extracted = extractComposerContextDirectives(part.text)
        for (const input of extracted.inputs) {
          const key = `${input.type}:${input.path}`
          if (!contextInputKeys.has(key)) {
            contextInputKeys.add(key)
            contextInputs.push(input)
          }
        }
        for (const reference of extracted.references) {
          if (
            (reference.type === 'file' || reference.type === 'folder') &&
            !localReferencePaths.has(reference.path)
          ) {
            localReferencePaths.add(reference.path)
            localReferences.push({
              type: reference.type,
              label: reference.label,
              path: reference.path
            })
          }
          if (reference.type === 'chat') {
            const threadId = threadIdFromTaskReference(reference.path)
            if (threadId && threadId !== activeThreadId) taskThreadIds.add(threadId)
          }
        }
        const text = extracted.text.trim()
        if (text) textChunks.push(text)
        continue
      }
      if (part.type !== 'file') continue

      const localReference = localReferenceForFilePart(part)
      if (localReference) {
        if (!localReferencePaths.has(localReference.path)) {
          localReferencePaths.add(localReference.path)
          localReferences.push(localReference)
        }
        continue
      }

      const mapped = await this.resolveFilePart(part)
      if (mapped?.type === 'text') textChunks.push(mapped.text)
      else if (mapped) attachments.push(mapped)
    }

    if (taskThreadIds.size > 3) {
      throw new Error('thread_reference_limit_exceeded: each message can reference at most 3 tasks')
    }
    const referencedTasks = await this.loadReferencedTasks(taskThreadIds)
    const requestText = framedGoal ?? textChunks.join('\n\n')
    const filesText = buildFilesMentionedContext(localReferences, requestText)
    const text = buildReferencedTasksContext(referencedTasks, filesText, localReferences.length > 0)
    return [textInput(text), ...contextInputs, ...attachments]
  }

  private async loadReferencedTasks(threadIds: Set<string>): Promise<ReferencedTaskContext[]> {
    if (threadIds.size === 0) return []
    if (!this.options.loadTask) {
      throw new Error('thread_reference_read_failed: task loader is unavailable')
    }
    try {
      return await Promise.all(
        [...threadIds].map(async (threadId) =>
          normalizeReferencedTask((await this.options.loadTask!(threadId)).thread as never)
        )
      )
    } catch (error) {
      throw new Error('thread_reference_read_failed: unable to load referenced task', {
        cause: error
      })
    }
  }

  private async resolveFilePart(
    part: Extract<UIMessage['parts'][number], { type: 'file' }>
  ): Promise<CodexTurnInputItem | null> {
    const mediaType = part.mediaType
    const url = part.url
    if (mediaType.startsWith('text/')) return textInput(await readTextAttachment(url))
    if (!mediaType.startsWith('image/')) return null

    const parsed = tryUrl(url)
    if (parsed?.protocol === 'file:') return { type: 'localImage', path: fileURLToPath(parsed) }
    if (parsed?.protocol === 'http:' || parsed?.protocol === 'https:')
      return { type: 'image', url: parsed.href }
    if (url.startsWith('data:')) {
      const temporary = await this.writeInlineAttachment(url, mediaType)
      return { type: 'localImage', path: fileURLToPath(temporary) }
    }
    return { type: 'image', url }
  }

  private async writeInlineAttachment(data: string, mediaType: string): Promise<URL> {
    const extension = extensionForMediaType(mediaType)
    const path = join(tmpdir(), `dascowork-codex-${randomUUID()}${extension}`)
    const payload = data.includes(';base64,')
      ? data.slice(data.indexOf(';base64,') + ';base64,'.length)
      : data
    await writeFile(path, Buffer.from(payload, 'base64'))
    const url = pathToFileURL(path)
    this.temporaryFiles.push(url)
    return url
  }
}

function goalFirstTurnText(objective: string): string {
  return `Begin working toward this long-running goal.\n\nGoal:\n${objective}`
}

function textInput(text: string): CodexTurnInputText {
  return { type: 'text', text, text_elements: [] }
}

function localReferenceForFilePart(
  part: Extract<UIMessage['parts'][number], { type: 'file' }>
): LocalContextReference | null {
  const type = part.mediaType === LOCAL_FOLDER_ATTACHMENT_MEDIA_TYPE ? 'folder' : 'file'
  if (type === 'file' && part.mediaType !== LOCAL_FILE_ATTACHMENT_MEDIA_TYPE) return null
  const url = tryUrl(part.url)
  if (!url || url.protocol !== 'file:') return null
  const path = fileURLToPath(url)
  return { type, path, label: part.filename?.trim() || basename(path) }
}

async function readTextAttachment(url: string): Promise<string> {
  if (!url.startsWith('data:')) return url
  const marker = ';base64,'
  const payload = url.includes(marker) ? url.slice(url.indexOf(marker) + marker.length) : url
  return Buffer.from(payload, 'base64').toString('utf-8')
}

function tryUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

function extensionForMediaType(mediaType: string): string {
  return (
    (
      {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg'
      } as Record<string, string>
    )[mediaType] ?? '.bin'
  )
}
