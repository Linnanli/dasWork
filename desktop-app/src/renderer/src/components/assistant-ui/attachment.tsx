'use client'

import {
  createContext,
  type FC,
  type KeyboardEvent,
  useCallback,
  useContext,
  useMemo,
  useState
} from 'react'
import { AlertCircleIcon, Loader2Icon, PlusIcon, XIcon } from 'lucide-react'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  type Attachment,
  useAui,
  useAuiState
} from '@assistant-ui/react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { ChatImage, useImagePreview, type ChatImageDescriptor } from '@/components/images'
import { useChatImageConversation } from '@/components/conversation/chatImageConversationContext'
import { useOptionalRightWorkspace } from '@/components/right-workspace'
import { isPptxArtifactPath } from '@/components/workspace-container'
import {
  artifactSourceAttachmentIdentityFromId,
  artifactSourceIdFromUrl,
  localPathAttachmentIdentityFromId
} from '@/composer/imageAttachmentAdapter'
import { cn } from '@/lib/utils'

const AttachmentImagesContext = createContext<readonly ChatImageDescriptor[]>([])
const EMPTY_ATTACHMENTS: readonly Attachment[] = []

function asImageSource(data: unknown): string | undefined {
  return typeof data === 'string' ? data : undefined
}

const AttachmentThumb: FC = () => {
  const attachmentId = useAuiState((state) => state.attachment.id)
  const images = useContext(AttachmentImagesContext)
  const preview = useImagePreview()
  const index = images.findIndex((image) => image.id === attachmentId)
  const image = images[index]

  if (!image) {
    return (
      <AttachmentPrimitive.unstable_Thumb className="aui-attachment-tile-fallback flex size-full items-center justify-center bg-muted px-1 text-center text-[10px] font-medium text-muted-foreground" />
    )
  }

  return (
    <ChatImage
      image={image}
      variant="attachment"
      className="aui-attachment-preview-trigger aui-attachment-tile-avatar h-full w-full rounded-none"
      imageClassName="aui-attachment-tile-image size-full object-cover"
      onPreview={(_image, trigger) => preview.open(images, index, trigger)}
    />
  )
}

function attachmentImages(
  attachments: readonly Attachment[],
  owner: { conversationId?: string; threadId?: string }
): ChatImageDescriptor[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type !== 'image') return []
    const content = attachment.content?.find(
      (part) => part.type === 'image' || part.type === 'file'
    )
    const source = content
      ? content.type === 'image'
        ? content.image
        : asImageSource(content.data)
      : undefined
    if (!attachment.file && !source) return []
    return [
      {
        id: attachment.id,
        source: source ?? attachment.name,
        sourceKind: 'media-url' as const,
        alt: attachment.name || '图片附件',
        title: attachment.name,
        file: attachment.file,
        ...owner
      }
    ]
  })
}

const AttachmentUI: FC = () => {
  const aui = useAui()
  const workspace = useOptionalRightWorkspace()
  const isComposer = aui.attachment.source !== 'message'
  const attachmentId = useAuiState((state) => state.attachment.id)
  const attachmentName = useAuiState((state) => state.attachment.name)
  const isImage = useAuiState((state) => state.attachment.type === 'image')
  const attachmentArtifactSourceId = useAuiState((state) => {
    const content = state.attachment.content?.find((item) => item.type === 'file')
    return content ? artifactSourceIdFromUrl(content.data) : undefined
  })
  const [registeredArtifactSourceId, setRegisteredArtifactSourceId] = useState<string>()
  const [artifactOpenError, setArtifactOpenError] = useState<string>()
  const typeLabel = useAuiState((state) => {
    switch (state.attachment.type) {
      case 'image':
        return 'Image'
      case 'document':
        return 'Document'
      case 'file':
        return 'File'
      default:
        return state.attachment.type
    }
  })
  const uploadState = useAuiState((state) =>
    state.attachment.status.type === 'running'
      ? 'uploading'
      : state.attachment.status.type === 'incomplete' && state.attachment.status.reason === 'error'
        ? 'error'
        : undefined
  )
  const errorMessage = useAuiState((state) =>
    state.attachment.status.type === 'incomplete' && state.attachment.status.reason === 'error'
      ? '无法读取本地附件'
      : undefined
  )
  const isUploading = uploadState === 'uploading'
  const isError = uploadState === 'error'
  const localPathAttachment = localPathAttachmentIdentityFromId(attachmentId)
  const artifactAttachment = artifactSourceAttachmentIdentityFromId(attachmentId)
  const artifactAttachmentSourceId = artifactAttachment?.sourceId ?? attachmentArtifactSourceId
  const isPptxAttachment =
    Boolean(artifactAttachmentSourceId) ||
    (localPathAttachment?.kind === 'file' &&
      isPptxArtifactPath(localPathAttachment.path || attachmentName))

  const openPresentation = useCallback(async (): Promise<void> => {
    if (!isPptxAttachment) return
    if (!workspace) {
      setArtifactOpenError('当前工作区不可用。')
      return
    }
    try {
      setArtifactOpenError(undefined)
      const sourceId =
        artifactAttachmentSourceId ??
        registeredArtifactSourceId ??
        (
          await window.desktopApp.workspace.artifacts.registerAuthorizedLocalSource({
            version: 1,
            capabilityToken: localPathAttachment?.artifactPreviewToken ?? ''
          })
        ).sourceId
      setRegisteredArtifactSourceId(sourceId)
      workspace.openArtifact(
        {
          artifactType: 'slides',
          importKind: 'pptx',
          source: { kind: 'authorized-local', sourceId },
          title: attachmentName || '演示文稿',
          openSource: isComposer ? 'composer-attachment' : 'message-attachment',
          attachmentPreview: {
            origin: isComposer ? 'composer' : 'sent-message',
            requestId: requestId()
          }
        },
        { mode: 'pinned' }
      )
    } catch (error) {
      setArtifactOpenError(error instanceof Error ? error.message : '无法打开 PPTX 预览。')
    }
  }, [
    artifactAttachmentSourceId,
    registeredArtifactSourceId,
    attachmentName,
    isComposer,
    isPptxAttachment,
    localPathAttachment,
    workspace
  ])

  const onPresentationKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!isPptxAttachment || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    void openPresentation()
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root className="aui-attachment-root relative">
          <TooltipTrigger asChild>
            <div
              className={cn(
                'aui-attachment-tile bg-muted relative flex size-14 cursor-pointer items-center justify-center overflow-hidden rounded-md border text-muted-foreground transition-opacity hover:opacity-75',
                isError && 'border-destructive'
              )}
              data-attachment-name={attachmentName}
              role={isImage ? undefined : 'button'}
              tabIndex={isImage ? undefined : 0}
              aria-label={`${isPptxAttachment ? '打开 PPTX 预览' : typeLabel} attachment${
                isError ? '，附件不可用' : isUploading ? '，正在检查' : ''
              }`}
              onClick={isPptxAttachment ? () => void openPresentation() : undefined}
              onKeyDown={onPresentationKeyDown}
            >
              <AttachmentThumb />
              {isUploading && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-uploading bg-background/60 pointer-events-none absolute inset-0 flex items-center justify-center backdrop-blur-[1px]"
                >
                  <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
                </div>
              )}
              {isError && (
                <div
                  aria-hidden="true"
                  className="aui-attachment-tile-error bg-destructive/10 pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  <AlertCircleIcon className="text-destructive size-5" />
                </div>
              )}
            </div>
          </TooltipTrigger>
          {isComposer && <AttachmentRemove />}
        </AttachmentPrimitive.Root>
        <TooltipContent side="top">
          <AttachmentPrimitive.Name />
          {errorMessage && <p className="aui-attachment-error-message">{errorMessage}</p>}
          {artifactOpenError && <p className="aui-attachment-error-message">{artifactOpenError}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function requestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove asChild>
      <TooltipIconButton
        tooltip="Remove file"
        className="aui-attachment-tile-remove text-muted-foreground hover:[&_svg]:text-destructive absolute end-1.5 top-1.5 size-3.5 rounded-full bg-white opacity-100 shadow-sm hover:bg-white! [&_svg]:text-black"
        side="top"
      >
        <XIcon className="aui-attachment-remove-icon size-3 dark:stroke-[2.5px]" />
      </TooltipIconButton>
    </AttachmentPrimitive.Remove>
  )
}

export const UserMessageAttachments: FC = () => {
  const attachments = useAuiState((state) =>
    state.message.role === 'user' ? state.message.attachments : EMPTY_ATTACHMENTS
  )
  const owner = useChatImageConversation()
  const images = useMemo(() => attachmentImages(attachments, owner), [attachments, owner])
  return (
    <AttachmentImagesContext.Provider value={images}>
      <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
        <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
      </div>
    </AttachmentImagesContext.Provider>
  )
}

export const ComposerAttachments: FC = () => {
  const attachments = useAuiState((state) => state.composer.attachments)
  const owner = useChatImageConversation()
  const images = useMemo(() => attachmentImages(attachments, owner), [attachments, owner])
  return (
    <AttachmentImagesContext.Provider value={images}>
      <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
        <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
      </div>
    </AttachmentImagesContext.Provider>
  )
}

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment asChild>
      <TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon"
        className="aui-composer-add-attachment hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full p-1 text-xs font-semibold"
        aria-label="Add Attachment"
      >
        <PlusIcon className="aui-attachment-add-icon size-4.5 stroke-[1.5px]" />
      </TooltipIconButton>
    </ComposerPrimitive.AddAttachment>
  )
}
