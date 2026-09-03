export type PresentationFrame = {
  x: number
  y: number
  width: number
  height: number
}

export type PresentationElementKind = 'text' | 'shape' | 'image' | 'table' | 'chart'

export type PresentationElement = {
  id: string
  kind: PresentationElementKind
  name: string
  frame: PresentationFrame
  text?: string
  fill?: string
  color?: string
  imageDataUrl?: string
  hyperlink?: string
}

export type PresentationSlide = {
  id: string
  number: number
  name: string
  elements: readonly PresentationElement[]
}

export type PresentationDocument = {
  width: number
  height: number
  slides: readonly PresentationSlide[]
}

export type PresentationParseResult = {
  document: PresentationDocument
  warnings: readonly string[]
}

export type PresentationWorkerRequest = {
  type: 'parse'
  requestId: string
  bytes: ArrayBuffer
}

export type PresentationWorkerResponse =
  | { type: 'parsed'; requestId: string; result: PresentationParseResult }
  | { type: 'error'; requestId: string; message: string }
