/// <reference lib="webworker" />

import { parsePresentationBytes } from './presentationParser'
import type { PresentationWorkerRequest, PresentationWorkerResponse } from './presentationTypes'

self.onmessage = (event: MessageEvent<PresentationWorkerRequest>) => {
  const request = event.data
  if (request.type !== 'parse') return
  void parsePresentationBytes(request.bytes)
    .then((result) => {
      const response: PresentationWorkerResponse = {
        type: 'parsed',
        requestId: request.requestId,
        result
      }
      self.postMessage(response)
    })
    .catch((error: unknown) => {
      const response: PresentationWorkerResponse = {
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : '无法解析 PPTX。'
      }
      self.postMessage(response)
    })
}
