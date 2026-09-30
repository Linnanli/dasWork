import { useContext, type ReactElement } from 'react'
import { ImageOffIcon, LoaderCircleIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatImageSource, type ChatImageDescriptor } from './chatImageSource'
import { ImagePreviewContext } from './imagePreviewContext'

export interface ChatImageProps {
  image: ChatImageDescriptor
  variant?: 'body' | 'thumbnail' | 'attachment'
  className?: string
  imageClassName?: string
  hideWhileResolving?: boolean
  onPreview?: (image: ChatImageDescriptor, trigger: HTMLButtonElement) => void
}

export function ChatImage({
  image,
  variant = 'body',
  className,
  imageClassName,
  hideWhileResolving = variant === 'body',
  onPreview
}: ChatImageProps): ReactElement | null {
  const source = useChatImageSource(image)
  const preview = useContext(ImagePreviewContext)
  const label = image.alt || image.title || source.fileName || '图片'
  if (source.status === 'resolving' && hideWhileResolving) return null
  const fixedSize = variant === 'thumbnail' ? 'size-20' : variant === 'attachment' ? 'size-14' : ''
  if (source.status === 'unavailable') {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground',
          fixedSize,
          variant === 'body' && 'my-3 max-w-[200px]',
          className
        )}
        role="img"
        aria-label={`${label}：图片不可用`}
        title={source.reason}
        data-chat-image-state="unavailable"
        data-chat-image-id={image.id}
      >
        <ImageOffIcon className="size-4 shrink-0" aria-hidden="true" />
        <span className="line-clamp-2">{image.alt || '图片不可用'}</span>
      </span>
    )
  }
  const ready = source.status === 'ready'
  return (
    <button
      type="button"
      disabled={!ready}
      aria-label={`预览${label}`}
      aria-busy={!ready}
      title={image.title}
      data-chat-image-id={image.id}
      data-chat-image-ready={ready ? 'true' : 'false'}
      data-chat-image-state={source.status}
      className={cn(
        'relative block overflow-hidden rounded-md border shadow-md focus-visible:outline-2 focus-visible:outline-ring',
        fixedSize,
        variant === 'body' && 'my-3 max-h-[200px] max-w-[200px]',
        variant === 'body' && !ready && 'min-h-20 min-w-20',
        !ready && 'bg-muted/30',
        className
      )}
      onClick={(event) => {
        if (onPreview) onPreview(image, event.currentTarget)
        else preview?.open([image], 0, event.currentTarget)
      }}
    >
      {source.displaySrc && (
        <img
          key={source.displaySrc}
          src={source.displaySrc}
          alt={image.alt || ''}
          loading="lazy"
          onLoad={source.onLoad}
          onError={source.onError}
          className={cn(
            variant === 'body'
              ? 'block h-auto max-h-[200px] max-w-[200px] object-contain'
              : 'size-full object-cover',
            !ready && 'opacity-0',
            imageClassName
          )}
        />
      )}
      {!ready && (
        <span
          className={cn(
            'flex items-center justify-center',
            source.displaySrc && 'absolute inset-0',
            variant === 'body' && 'min-h-20 min-w-20'
          )}
        >
          <LoaderCircleIcon
            className="size-4 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
          <span className="sr-only">图片加载中</span>
        </span>
      )}
    </button>
  )
}
