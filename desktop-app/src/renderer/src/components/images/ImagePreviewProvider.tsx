import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement
} from 'react'
import { type ChatImageDescriptor, useChatImageSource } from './chatImageSource'
import { ImagePreviewContext } from './imagePreviewContext'
import { ImagePreviewDialog } from './ImagePreviewDialog'

interface PreviewSession {
  id: number
  images: ChatImageDescriptor[]
  index: number
  trigger?: HTMLElement | null
}

function ImageSourceLease({ image }: { image: ChatImageDescriptor }): null {
  useChatImageSource(image)
  return null
}

/** Lives above message/tool disclosure bodies so collapsing a trigger cannot close its preview. */
export function ImagePreviewProvider({ children }: PropsWithChildren): ReactElement {
  const [session, setSession] = useState<PreviewSession | null>(null)
  const nextSession = useRef(0)
  const close = useCallback(() => setSession(null), [])
  const open = useCallback(
    (images: readonly ChatImageDescriptor[], index = 0, trigger?: HTMLElement | null) => {
      if (!images.length) return
      setSession({
        id: ++nextSession.current,
        images: [...images],
        index: Math.min(images.length - 1, Math.max(0, index)),
        trigger
      })
    },
    []
  )
  const actions = useMemo(() => ({ open, close }), [open, close])
  return (
    <ImagePreviewContext.Provider value={actions}>
      {children}
      {session && (
        <>
          {session.images.map((image, index) => (
            <ImageSourceLease key={`${image.id}:${index}`} image={image} />
          ))}
          <ImagePreviewDialog
            key={session.id}
            images={session.images}
            initialIndex={session.index}
            trigger={session.trigger}
            onClose={close}
          />
        </>
      )}
    </ImagePreviewContext.Provider>
  )
}
