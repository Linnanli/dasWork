'use client'

import {
  type FC,
  type KeyboardEvent,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useState
} from 'react'
import { AlertCircleIcon, FileText, Loader2Icon, PlusIcon, XIcon } from 'lucide-react'
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAui,
  useAuiState
} from '@assistant-ui/react'
import { useShallow } from 'zustand/shallow'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { useOptionalRightWorkspace } from '@/components/right-workspace'
import { isPptxArtifactPath } from '@/components/workspace-container'
import {
  artifactSourceAttachmentIdentityFromId,
  artifactSourceIdFromUrl,
  localPathAttachmentIdentityFromId
} from '@/composer/imageAttachmentAdapter'
import { cn } from '@/lib/utils'

const useFileSrc = (file: File | undefined): string | undefined => {
  const [src, setSrc] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!file) {
      // The attachment lifecycle owns this object URL state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSrc(undefined)
      return
    }

    const objectUrl = URL.createObjectURL(file)
    setSrc(objectUrl)

    return () => URL.revokeObjectURL(objectUrl)
  }, [file])

  return src
}

const useAttachmentSrc = (): string | undefined => {
  const { file, src } = useAuiState(
    useShallow((state): { file?: File; src?: string } => {
      if (state.attachment.type !== 'image') return {}
      if (state.attachment.file) return { file: state.attachment.file }

      const content = state.attachment.content?.find(
        (item) => item.type === 'image' || item.type === 'file'
      )
      if (!content) return {}
      return {
        src: content.type === 'image' ? content.image : asImageSource(content.data)
      }
    })
  )

  return useFileSrc(file) ?? src
}

function asImageSource(data: unknown): string | undefined {
  return typeof data === 'string' ? data : undefined
}

const AttachmentPreview: FC<{ src: string }> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false)

  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        'block h-auto max-h-[80vh] w-auto max-w-full object-contain',
        isLoaded
          ? 'aui-attachment-preview-image-loaded'
          : 'aui-attachment-preview-image-loading invisible'
      )}
      onLoad={() => setIsLoaded(true)}
    />
  )
}

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc()

  if (!src) return children

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger cursor-pointer transition-colors hover:bg-accent/50"
        asChild
      >
        {children}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&_svg]:text-background [&>button]:hover:[&_svg]:text-destructive p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">Image Attachment Preview</DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc()

  if (!src) {
    return (
      <AttachmentPrimitive.unstable_Thumb className="aui-attachment-tile-fallback flex size-full items-center justify-center bg-muted px-1 text-center text-[10px] font-medium text-muted-foreground" />
    )
  }

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={src}
        alt="Attachment preview"
        className="aui-attachment-tile-image size-full object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground size-6" />
      </AvatarFallback>
    </Avatar>
  )
}

const AttachmentUI: FC = () => {
  const aui = useAui()
  const workspace = useOptionalRightWorkspace()
  const isComposer = aui.attachment.source !== 'message'
  const attachmentId = useAuiState((state) => state.attachment.id)
  const attachmentName = useAuiState((state) => state.attachment.name)
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
          <AttachmentPreviewDialog>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  'aui-attachment-tile bg-muted relative flex size-14 cursor-pointer items-center justify-center overflow-hidden rounded-md border text-muted-foreground transition-opacity hover:opacity-75',
                  isError && 'border-destructive'
                )}
                data-attachment-name={attachmentName}
                role="button"
                tabIndex={0}
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
                    className="aui-attachment-tile-uploading bg-background/60 absolute inset-0 flex items-center justify-center backdrop-blur-[1px]"
                  >
                    <Loader2Icon className="text-muted-foreground size-5 animate-spin" />
                  </div>
                )}
                {isError && (
                  <div
                    aria-hidden="true"
                    className="aui-attachment-tile-error bg-destructive/10 absolute inset-0 flex items-center justify-center"
                  >
                    <AlertCircleIcon className="text-destructive size-5" />
                  </div>
                )}
              </div>
            </TooltipTrigger>
          </AttachmentPreviewDialog>
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
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2">
      <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
    </div>
  )
}

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
    </div>
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
