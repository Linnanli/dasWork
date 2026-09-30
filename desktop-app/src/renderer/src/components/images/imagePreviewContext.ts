import { createContext, useContext } from 'react'
import type { ChatImageDescriptor } from './chatImageSource'

export interface ImagePreviewActions {
  open: (
    images: readonly ChatImageDescriptor[],
    index?: number,
    trigger?: HTMLElement | null
  ) => void
  close: () => void
}

export const ImagePreviewContext = createContext<ImagePreviewActions | null>(null)

export function useImagePreview(): ImagePreviewActions {
  const context = useContext(ImagePreviewContext)
  if (!context) throw new Error('ImagePreviewProvider is required')
  return context
}
