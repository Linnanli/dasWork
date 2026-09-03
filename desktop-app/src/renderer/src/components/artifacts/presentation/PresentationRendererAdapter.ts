import type {
  PresentationParseResult,
  PresentationWorkerRequest,
  PresentationWorkerResponse
} from './presentationTypes'

const cache = new Map<string, PresentationParseResult>()
const MAX_CACHE_ENTRIES = 8

export function parsePresentationInWorker(
  bytes: ArrayBuffer,
  cacheKey: string,
  signal?: AbortSignal
): Promise<PresentationParseResult> {
  const cached = cache.get(cacheKey)
  if (cached) return Promise.resolve(cached)
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise<PresentationParseResult>((resolve, reject) => {
    const worker = new Worker(new URL('./presentation.worker.ts', import.meta.url), {
      type: 'module'
    })
    const requestId = crypto.randomUUID()
    const settle = (result: PresentationParseResult | Error): void => {
      cleanup()
      if (result instanceof Error) reject(result)
      else {
        cache.set(cacheKey, result)
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!)
        resolve(result)
      }
    }
    const onMessage = (event: MessageEvent<PresentationWorkerResponse>): void => {
      const response = event.data
      if (response.requestId !== requestId) return
      settle(response.type === 'parsed' ? response.result : new Error(response.message))
    }
    const onError = (): void => settle(new Error('PPTX 解析 Worker 初始化失败。'))
    const onAbort = (): void => settle(abortError())
    const cleanup = (): void => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    const request: PresentationWorkerRequest = { type: 'parse', requestId, bytes }
    worker.postMessage(request, [bytes])
  })
}

export function clearPresentationCache(cacheKey?: string): void {
  if (cacheKey) cache.delete(cacheKey)
  else cache.clear()
}

function abortError(): DOMException {
  return new DOMException('PPTX 解析已取消。', 'AbortError')
}
