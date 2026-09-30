import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  isChatImageMimeType,
  parseChatImageDataUrl,
  type ChatImageSourceKind
} from '../../../../shared/chatImageApi'

export type { ChatImageSourceKind } from '../../../../shared/chatImageApi'

export interface ChatImageDescriptor {
  id: string
  source: string
  sourceKind: ChatImageSourceKind
  alt?: string
  title?: string
  conversationId?: string
  threadId?: string
  file?: File
}

export interface ChatImageSourceState {
  status: 'resolving' | 'loading' | 'ready' | 'unavailable'
  displaySrc?: string
  fileName?: string
  reason?: string
}

interface SourceEntry {
  image: ChatImageDescriptor
  state: ChatImageSourceState
  listeners: Set<() => void>
  releaseTimer?: ReturnType<typeof setTimeout>
  started: boolean
  version: number
  objectUrl?: string
}

const sources = new Map<string, SourceEntry>()
const fileIds = new WeakMap<File, number>()
let nextFileId = 0
const RELEASE_DELAY_MS = 15_000

/** A File is the authority for blob sources; a URL mentioned by the model is not. */
export function isSafeDirectImageSource(source: string): boolean {
  if (/^data:/i.test(source)) return parseChatImageDataUrl(source) !== null
  try {
    const url = new URL(source)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

export function chatImageSourceKey(image: ChatImageDescriptor): string {
  let fileId: number | undefined
  if (image.file) {
    fileId = fileIds.get(image.file)
    if (!fileId) {
      fileId = ++nextFileId
      fileIds.set(image.file, fileId)
    }
  }
  return JSON.stringify([
    image.conversationId ?? null,
    image.threadId ?? null,
    image.sourceKind,
    image.source,
    fileId ?? null
  ])
}

function notify(entry: SourceEntry, state: ChatImageSourceState): void {
  entry.state = state
  entry.listeners.forEach((listener) => listener())
}

function getEntry(key: string, image: ChatImageDescriptor): SourceEntry {
  let entry = sources.get(key)
  if (!entry) {
    entry = {
      image,
      state: { status: 'resolving' },
      listeners: new Set(),
      started: false,
      version: 0
    }
    sources.set(key, entry)
    // A render can be abandoned before subscribing (for example during Suspense).
    // Even that entry must have a bounded lifetime.
    releaseEntry(key, entry)
  }
  return entry
}

async function resolveEntry(entry: SourceEntry): Promise<void> {
  entry.started = true
  const version = ++entry.version
  const image = entry.image
  try {
    if (image.file) {
      if (!isChatImageMimeType(image.file.type)) throw new Error('文件不是图片')
      entry.objectUrl ??= URL.createObjectURL(image.file)
      notify(entry, { status: 'loading', displaySrc: entry.objectUrl, fileName: image.file.name })
      return
    }
    if (image.source.startsWith('blob:')) throw new Error('图片来源不可用')
    if (/^(?:data:|https?:)/i.test(image.source)) {
      if (!isSafeDirectImageSource(image.source)) throw new Error('图片地址无效')
    }
    const result = await window.desktopApp.codex.resolveImageSource({
      source: image.source,
      sourceKind: image.sourceKind,
      conversationId: image.conversationId,
      threadId: image.threadId
    })
    if (entry.version !== version) return
    if (result.status === 'unavailable') {
      notify(entry, { status: 'unavailable', reason: result.reason })
    } else {
      const safe =
        result.displaySrc.startsWith('app://fs/@fs/') || isSafeDirectImageSource(result.displaySrc)
      if (!safe) throw new Error('图片来源不可用')
      notify(entry, { status: 'loading', displaySrc: result.displaySrc, fileName: result.fileName })
    }
  } catch (error) {
    if (entry.version !== version) return
    notify(entry, {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : '图片不可用'
    })
  }
}

function releaseEntry(key: string, entry: SourceEntry): void {
  if (entry.listeners.size > 0) return
  entry.releaseTimer = setTimeout(
    () => {
      if (entry.listeners.size > 0 || sources.get(key) !== entry) return
      sources.delete(key)
      entry.version++
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl)
    },
    entry.state.status === 'unavailable' ? 0 : RELEASE_DELAY_MS
  )
}

export function useChatImageSource(image: ChatImageDescriptor): ChatImageSourceState & {
  onLoad: () => void
  onError: () => void
  retry: () => void
} {
  const key = chatImageSourceKey(image)
  // A descriptor can be recreated for each streaming token; its source identity cannot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const entry = useMemo(() => getEntry(key, image), [key])
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!sources.has(key)) sources.set(key, entry)
      if (entry.releaseTimer) clearTimeout(entry.releaseTimer)
      entry.listeners.add(listener)
      if (!entry.started) void resolveEntry(entry)
      return () => {
        entry.listeners.delete(listener)
        releaseEntry(key, entry)
      }
    },
    [entry, key]
  )
  const snapshot = useCallback(() => entry.state, [entry])
  const state = useSyncExternalStore(subscribe, snapshot, snapshot)
  return {
    ...state,
    onLoad: useCallback(() => {
      if (entry.state.status === 'loading') notify(entry, { ...entry.state, status: 'ready' })
    }, [entry]),
    onError: useCallback(() => {
      notify(entry, { status: 'unavailable', reason: '图片不可用' })
    }, [entry]),
    retry: useCallback(() => {
      notify(entry, { status: 'resolving' })
      void resolveEntry(entry)
    }, [entry])
  }
}

/** File bytes are read only for an explicit save, never for thumbnail rendering. */
export function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () =>
      typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败'))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}
