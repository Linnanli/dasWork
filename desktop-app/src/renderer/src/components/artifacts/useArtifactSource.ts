import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'

import {
  ARTIFACT_PREVIEW_API_VERSION,
  isArtifactPreviewUnavailableResult,
  type ArtifactPreviewMetadata
} from '../../../../shared/artifactPreviewApi'
import type { GitConversationTarget } from '../../../../shared/localGitApi'
import type { ArtifactTabDescriptor } from './artifactTabDescriptor'
import type { ArtifactPreviewSource } from '../workspace-container/workspaceOpenTargets'

export type ArtifactRuntime = { artifactSourceId?: string; artifactSourceKey?: string }

export type ArtifactBinary = {
  sourceId: string
  generation: number
  checksum: string
  base64: string
}

type SourceState = {
  sourceId?: string
  metadata?: ArtifactPreviewMetadata
  binary?: ArtifactBinary
  loading: boolean
  error?: string
  tooLarge?: boolean
}

export function useArtifactSource({
  artifact,
  workspaceId,
  target,
  runtime,
  onRuntimeChange
}: {
  artifact: ArtifactTabDescriptor
  workspaceId: string
  target?: GitConversationTarget
  runtime?: ArtifactRuntime
  onRuntimeChange(runtime: ArtifactRuntime): void
}): SourceState & { refresh(): void } {
  const relativePath =
    artifact.source.kind === 'workspace-file' ? artifact.source.relativePath : undefined
  const authorizedSourceId =
    artifact.source.kind === 'authorized-local' ? artifact.source.sourceId : undefined
  // Workspace focus rebuilds descriptors and callbacks. Only a changed source
  // or conversation should restart the load and discard the current preview.
  const previewSource = useMemo<ArtifactPreviewSource>(
    () =>
      relativePath !== undefined
        ? { kind: 'workspace-file', relativePath }
        : { kind: 'authorized-local', sourceId: authorizedSourceId ?? '' },
    [relativePath, authorizedSourceId]
  )
  const conversationId = target?.conversationId
  const threadId = target?.threadId
  const sourceTarget = useMemo<GitConversationTarget | undefined>(
    () => (conversationId ? { conversationId, threadId } : undefined),
    [conversationId, threadId]
  )
  const reportRuntime = useEffectEvent(onRuntimeChange)
  const sourceKey =
    previewSource.kind === 'workspace-file'
      ? `workspace:${JSON.stringify([workspaceId, previewSource.relativePath, conversationId ?? null, threadId ?? null])}`
      : `local:${previewSource.sourceId}`
  const [refreshKey, setRefreshKey] = useState(0)
  const [state, setState] = useState<SourceState>({ loading: true })
  const sourceId =
    previewSource.kind === 'authorized-local'
      ? previewSource.sourceId
      : runtime?.artifactSourceKey === sourceKey
        ? runtime.artifactSourceId
        : undefined

  const refresh = useCallback(() => setRefreshKey((current) => current + 1), [])
  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      setState({ sourceId, loading: true })
      try {
        const resolvedSourceId = await ensureSourceId(
          previewSource,
          workspaceId,
          sourceTarget,
          sourceId
        )
        if (!active) return
        if (previewSource.kind === 'workspace-file' && resolvedSourceId !== sourceId) {
          reportRuntime({ artifactSourceId: resolvedSourceId, artifactSourceKey: sourceKey })
        }
        const metadataResult = await window.desktopApp.workspace.artifacts.metadata({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId: resolvedSourceId
        })
        if (!active) return
        if (isArtifactPreviewUnavailableResult(metadataResult)) {
          setState({
            sourceId: resolvedSourceId,
            loading: false,
            error: unavailableMessage(metadataResult.unavailable)
          })
          return
        }
        const binaryResult = await window.desktopApp.workspace.artifacts.readBinary({
          version: ARTIFACT_PREVIEW_API_VERSION,
          sourceId: resolvedSourceId
        })
        if (!active) return
        if (isArtifactPreviewUnavailableResult(binaryResult)) {
          setState({
            sourceId: resolvedSourceId,
            loading: false,
            error: unavailableMessage(binaryResult.unavailable)
          })
          return
        }
        if (binaryResult.content.kind === 'too-large') {
          setState({
            sourceId: resolvedSourceId,
            metadata: metadataResult.metadata,
            loading: false,
            tooLarge: true
          })
          return
        }
        setState({
          sourceId: resolvedSourceId,
          metadata: metadataResult.metadata,
          loading: false,
          binary: { sourceId: resolvedSourceId, ...binaryResult.content }
        })
      } catch (error) {
        if (active)
          setState({
            sourceId,
            loading: false,
            error: error instanceof Error ? error.message : '无法读取演示文稿。'
          })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [previewSource, refreshKey, sourceId, sourceKey, sourceTarget, workspaceId])

  useEffect(() => {
    if (!relativePath) return
    return window.desktopApp.workspace.files.onEvent((event) => {
      if (event.rootId === workspaceId && (!event.path || event.path === relativePath)) refresh()
    })
  }, [relativePath, refresh, workspaceId])

  useEffect(() => {
    if (!sourceId) return
    return window.desktopApp.workspace.artifacts.onEvent((event) => {
      if (event.sourceId === sourceId) refresh()
    })
  }, [refresh, sourceId])

  return { ...state, refresh }
}

async function ensureSourceId(
  source: ArtifactPreviewSource,
  workspaceId: string,
  target: GitConversationTarget | undefined,
  sourceId: string | undefined
): Promise<string> {
  if (sourceId) return sourceId
  if (source.kind === 'authorized-local') return source.sourceId
  if (!target) throw new Error('当前会话没有可用的本地工作区。')
  const root = await window.desktopApp.workspace.files.prepareRoot({ workspaceId, target })
  const result = await window.desktopApp.workspace.artifacts.registerWorkspaceSource({
    version: ARTIFACT_PREVIEW_API_VERSION,
    rootId: root.rootId,
    path: source.relativePath
  })
  return result.sourceId
}

function unavailableMessage(reason: string): string {
  switch (reason) {
    case 'identity-changed':
      return '文件已被替换，出于安全原因不能继续预览。'
    case 'workspace-unavailable':
      return '当前会话的本地工作区不可用。'
    case 'expired':
      return '文件预览授权已失效，请重新打开该文件。'
    default:
      return '文件来源已不可用。'
  }
}
