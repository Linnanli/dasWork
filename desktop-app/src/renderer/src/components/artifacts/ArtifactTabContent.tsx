import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon
} from 'lucide-react'
import { useEffect, useReducer, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import type { GitConversationTarget } from '../../../../shared/localGitApi'
import type { WorkspaceTabRuntime } from '../workspace-container/workspaceTypes'
import type { ArtifactTabDescriptor } from './artifactTabDescriptor'
import { parsePresentationInWorker } from './presentation/PresentationRendererAdapter'
import { PresentationPanel } from './presentation/PresentationPanel'
import type { PresentationParseResult } from './presentation/presentationTypes'
import { useArtifactSource, type ArtifactRuntime } from './useArtifactSource'
import { ArtifactAnnotationEditor } from './annotations/ArtifactAnnotationEditor'
import {
  artifactAnnotationReducer,
  initialArtifactAnnotationState
} from './annotations/artifactAnnotationReducer'
import { annotationId, type ArtifactAnnotationTarget } from './annotations/artifactAnnotationTypes'
import { useArtifactConversationBridge } from './ArtifactConversationBridge'

export function ArtifactTabContent({
  artifact,
  workspaceId,
  target,
  runtime,
  onRuntimeChange
}: {
  artifact: ArtifactTabDescriptor
  workspaceId: string
  target?: GitConversationTarget
  runtime?: WorkspaceTabRuntime
  onRuntimeChange(runtime: ArtifactRuntime): void
}): React.JSX.Element {
  const source = useArtifactSource({
    artifact,
    workspaceId,
    target,
    runtime: artifactRuntime(runtime),
    onRuntimeChange
  })
  const conversation = useArtifactConversationBridge()
  const [parseState, setParseState] = useState<{
    key: string
    parsed?: PresentationParseResult
    error?: string
  }>()
  const [annotationState, dispatchAnnotation] = useReducer(
    artifactAnnotationReducer,
    initialArtifactAnnotationState
  )
  const [actionError, setActionError] = useState<string>()
  const annotationSource = source.binary
    ? { sourceId: source.binary.sourceId, generation: source.binary.generation }
    : undefined
  const previousAnnotationSource = useRef<typeof annotationSource>(undefined)
  const presentationKey = source.binary
    ? `${source.binary.sourceId}:${source.binary.generation}:${source.binary.checksum}`
    : undefined
  const activeParseState = parseState?.key === presentationKey ? parseState : undefined
  const parsed = activeParseState?.parsed
  const parseError = activeParseState?.error

  useEffect(() => {
    const previous = previousAnnotationSource.current
    if (
      previous &&
      (!annotationSource ||
        previous.sourceId !== annotationSource.sourceId ||
        previous.generation !== annotationSource.generation)
    ) {
      dispatchAnnotation({
        type: 'clear-source',
        sourceId: previous.sourceId,
        generation: previous.generation
      })
    }
    previousAnnotationSource.current = annotationSource
  }, [annotationSource])

  useEffect(() => {
    const binary = source.binary
    if (!binary || !presentationKey) return
    const controller = new AbortController()
    void parsePresentationInWorker(
      base64ToArrayBuffer(binary.base64),
      presentationKey,
      controller.signal
    )
      .then((result) => {
        if (!controller.signal.aborted) setParseState({ key: presentationKey, parsed: result })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setParseState({
            key: presentationKey,
            error: error instanceof Error ? error.message : '无法解析 PPTX。'
          })
      })
    return () => controller.abort()
  }, [presentationKey, source.binary])

  const openWithSystem = (): void => {
    if (source.sourceId)
      void window.desktopApp.workspace.artifacts.openWithSystem({
        version: 1,
        sourceId: source.sourceId
      })
  }
  const reference = source.sourceId
    ? {
        sourceId: source.sourceId,
        generation: source.metadata?.generation ?? source.binary?.generation ?? 0,
        title: artifact.title
      }
    : undefined
  const annotationsEnabled = Boolean(
    reference && !artifact.attachmentPreview && conversation.available
  )
  const startAnnotation = (target: ArtifactAnnotationTarget): void => {
    if (!annotationsEnabled) return
    dispatchAnnotation({ type: 'start', draft: { id: annotationId(), target, body: '' } })
  }
  const saveAnnotation = async (mode: 'save' | 'submit'): Promise<void> => {
    if (!reference || !annotationState.editor) return
    const annotation = {
      id: annotationState.editor.id,
      sourceId: reference.sourceId,
      generation: reference.generation,
      target: annotationState.editor.target,
      body: annotationState.editor.body.trim(),
      status: mode === 'save' ? ('saved' as const) : ('submitted' as const),
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    try {
      setActionError(undefined)
      if (mode === 'save') await conversation.addToComposer(reference, annotation)
      else await conversation.directSubmit(reference, annotation)
      dispatchAnnotation({ type: 'save', annotation })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '无法保存 Artifact 批注。')
    }
  }
  const addArtifactToConversation = (): void => {
    if (!reference) return
    void conversation.addToComposer(reference).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : '无法添加 Artifact 到会话。')
    })
  }
  return (
    <section data-slot="artifact-tab-content" className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-13 shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">{artifact.title}</h2>
          <p className="text-xs text-muted-foreground">
            PPTX · 只读预览
            {source.metadata ? ` · ${(source.metadata.size / 1024 / 1024).toFixed(1)} MiB` : ''}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {!artifact.attachmentPreview ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="添加到会话上下文"
              disabled={!reference || !conversation.available}
              onClick={addArtifactToConversation}
            >
              <PlusIcon className="size-4" />
              添加到会话
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="刷新演示文稿"
            onClick={source.refresh}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="使用系统应用打开"
            onClick={openWithSystem}
            disabled={!source.sourceId}
          >
            <ExternalLinkIcon className="size-4" />
            系统打开
          </Button>
        </div>
      </header>
      {actionError ? (
        <p
          role="alert"
          className="border-b border-destructive/25 bg-destructive/5 px-4 py-2 text-xs text-destructive"
        >
          {actionError}
        </p>
      ) : null}
      {annotationState.editor ? (
        <ArtifactAnnotationEditor
          draft={annotationState.editor}
          onBodyChange={(body) => dispatchAnnotation({ type: 'change-body', body })}
          onCancel={() => dispatchAnnotation({ type: 'cancel-editor' })}
          onSave={() => void saveAnnotation('save')}
          onSubmit={() => void saveAnnotation('submit')}
        />
      ) : null}
      {annotationState.annotations.length ? (
        <section className="border-b border-border/70 px-4 py-2" aria-label="演示文稿批注">
          <ul className="flex flex-wrap gap-2">
            {annotationState.annotations.map((annotation, index) => (
              <li
                key={annotation.id}
                className="flex max-w-full items-center gap-1 rounded border bg-muted/40 py-1 pl-2 pr-1 text-xs"
              >
                <span className="truncate">
                  #{index + 1} {annotation.body}
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`编辑批注 ${index + 1}`}
                  onClick={() =>
                    dispatchAnnotation({
                      type: 'start',
                      draft: { id: annotation.id, target: annotation.target, body: annotation.body }
                    })
                  }
                >
                  编辑
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label={`删除批注 ${index + 1}`}
                  onClick={() => dispatchAnnotation({ type: 'dismiss', id: annotation.id })}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {source.loading ? (
        <StateView
          icon={<LoaderCircleIcon className="size-5 animate-spin" />}
          message="正在安全读取演示文稿…"
        />
      ) : null}
      {source.tooLarge ? (
        <StateView
          icon={<AlertTriangleIcon className="size-5" />}
          message="此 PPTX 超过 40 MiB 预览上限。"
          action={openWithSystem}
        />
      ) : null}
      {source.error ? (
        <StateView
          icon={<AlertTriangleIcon className="size-5" />}
          message={source.error}
          action={openWithSystem}
        />
      ) : null}
      {!source.loading && !source.tooLarge && !source.error && !parsed && !parseError ? (
        <StateView
          icon={<LoaderCircleIcon className="size-5 animate-spin" />}
          message="正在解析演示文稿…"
        />
      ) : null}
      {parseError ? (
        <StateView
          icon={<AlertTriangleIcon className="size-5" />}
          message={parseError}
          action={openWithSystem}
        />
      ) : null}
      {parsed ? (
        <div className="min-h-0 flex-1">
          <PresentationPanel
            key={`${presentationKey ?? 'presentation'}:${artifact.navigation?.requestId ?? ''}`}
            document={parsed.document}
            navigation={artifact.navigation}
            annotations={annotationState.annotations.filter(
              (annotation) =>
                reference?.sourceId === annotation.sourceId &&
                reference.generation === annotation.generation
            )}
            onRequestAnnotation={annotationsEnabled ? startAnnotation : undefined}
            onOpenHyperlink={(url) => void window.desktopApp.codex.openExternalHttpUrl(url)}
          />
        </div>
      ) : null}
    </section>
  )
}

function StateView({
  icon,
  message,
  action
}: {
  icon: React.ReactNode
  message: string
  action?: () => void
}): React.JSX.Element {
  return (
    <div className="m-auto flex max-w-md flex-col items-center gap-3 px-6 text-center text-sm text-muted-foreground">
      {icon}
      <p>{message}</p>
      {action ? (
        <Button type="button" variant="outline" size="sm" onClick={action}>
          使用系统应用打开
        </Button>
      ) : null}
    </div>
  )
}

function artifactRuntime(runtime: WorkspaceTabRuntime | undefined): ArtifactRuntime | undefined {
  return runtime && typeof runtime.artifactSourceId === 'string'
    ? {
        artifactSourceId: runtime.artifactSourceId,
        artifactSourceKey:
          typeof runtime.artifactSourceKey === 'string' ? runtime.artifactSourceKey : undefined
      }
    : undefined
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const decoded = atob(base64)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
  return bytes.buffer
}
