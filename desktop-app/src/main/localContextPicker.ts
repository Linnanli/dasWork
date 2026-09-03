import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  localContextPickerPayloadSchema,
  localContextReferenceSchema,
  localContextReferenceListSchema,
  type LocalContextPickerKind,
  type LocalContextReference
} from '../shared/codexIpcApi'
import type { LocalImageFileIdentity } from './localImageCapabilityStore'
import type { LocalPathFileIdentity } from './localPathCapabilityStore'
import type { ArtifactPreviewFileIdentity } from '../shared/artifactPreviewApi'
import { mediaTypeForPath, toAppMediaUrl } from './localMediaProtocol'

type LocalContextDialogKind = LocalContextPickerKind | 'files' | 'folders'

export type LocalContextPickerDialogOptions = {
  properties: Array<'openFile' | 'openDirectory' | 'multiSelections'>
}

export type LocalContextPickerDependencies = {
  choosePickerKind?: () => Promise<'files' | 'folders' | null>
  issueLocalImageCapability?: (
    path: string,
    mediaType: string,
    identity: LocalImageFileIdentity
  ) => string
  issueLocalPathCapability?: (
    path: string,
    kind: 'file' | 'folder',
    identity: LocalPathFileIdentity
  ) => string
  issueArtifactPreviewCapability?: (path: string, identity: ArtifactPreviewFileIdentity) => string
  showOpenDialog(options: LocalContextPickerDialogOptions): Promise<{
    canceled: boolean
    filePaths: string[]
  }>
  stat(path: string): Promise<{
    isFile(): boolean
    isDirectory(): boolean
    dev?: number
    ino?: number
    size?: number
    mtimeMs?: number
  }>
}

export async function pickLocalContext(
  dependencies: LocalContextPickerDependencies,
  pickerKind: LocalContextPickerKind
): Promise<LocalContextReference[]> {
  const dialogKind = dependencies.choosePickerKind
    ? await dependencies.choosePickerKind()
    : pickerKind
  if (dialogKind === null) return []

  const result = await dependencies.showOpenDialog({
    properties: dialogPropertiesFor(dialogKind)
  })

  if (result.canceled) return []

  const references: LocalContextReference[] = []
  const seenPaths = new Set<string>()

  for (const path of result.filePaths) {
    if (seenPaths.has(path)) continue
    seenPaths.add(path)

    const parsedPath = localContextReferenceSchema.safeParse({
      kind: 'file',
      path,
      label: path,
      fileUrl: pathToFileURL(path).href
    })
    if (!parsedPath.success) continue

    let stats: Awaited<ReturnType<LocalContextPickerDependencies['stat']>>
    try {
      stats = await dependencies.stat(path)
    } catch (error) {
      if (isMissingPathError(error)) continue
      throw new Error(`Unable to inspect selected path: ${errorMessage(error)}`)
    }

    const selectedKind = selectedPathKind(stats)
    if (!acceptsSelectedKind(dialogKind, selectedKind)) continue

    const label = basename(path) || path
    const fileUrl = pathToFileURL(path).href
    const mediaType = selectedKind === 'file' ? mediaTypeForPath(path) : undefined
    const previewUrl = mediaType?.startsWith('image/') ? toAppMediaUrl(path) : null

    if (mediaType && previewUrl) {
      const identity = localImageIdentityFrom(stats)
      const capabilityToken =
        identity && dependencies.issueLocalImageCapability
          ? dependencies.issueLocalImageCapability(path, mediaType, identity)
          : undefined
      references.push({
        kind: 'image',
        path,
        label,
        mediaType,
        previewUrl,
        ...(capabilityToken ? { capabilityToken } : {})
      })
    } else {
      const identity = localPathIdentityFrom(stats)
      const capabilityToken =
        identity && dependencies.issueLocalPathCapability
          ? dependencies.issueLocalPathCapability(path, selectedKind, identity)
          : undefined
      const artifactPreviewToken =
        selectedKind === 'file' && identity && dependencies.issueArtifactPreviewCapability
          ? dependencies.issueArtifactPreviewCapability(path, identity)
          : undefined
      references.push({
        kind: selectedKind,
        path,
        label,
        fileUrl,
        ...(capabilityToken ? { capabilityToken } : {}),
        ...(artifactPreviewToken ? { artifactPreviewToken } : {})
      })
    }
  }

  return localContextReferenceListSchema.parse(references)
}

function localPathIdentityFrom(
  stats: Awaited<ReturnType<LocalContextPickerDependencies['stat']>>
): LocalPathFileIdentity | null {
  if (
    typeof stats.dev !== 'number' ||
    typeof stats.ino !== 'number' ||
    typeof stats.size !== 'number' ||
    typeof stats.mtimeMs !== 'number'
  ) {
    return null
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  }
}

function localImageIdentityFrom(
  stats: Awaited<ReturnType<LocalContextPickerDependencies['stat']>>
): LocalImageFileIdentity | null {
  if (
    typeof stats.dev !== 'number' ||
    typeof stats.ino !== 'number' ||
    typeof stats.size !== 'number' ||
    typeof stats.mtimeMs !== 'number'
  ) {
    return null
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  }
}

function selectedPathKind(
  stats: Awaited<ReturnType<LocalContextPickerDependencies['stat']>>
): 'file' | 'folder' | null {
  if (stats.isFile()) return 'file'
  if (stats.isDirectory()) return 'folder'
  return null
}

export function createPickLocalContextHandler(dependencies: LocalContextPickerDependencies) {
  return async (_event: unknown, payload: unknown): Promise<LocalContextReference[]> => {
    const { kind } = localContextPickerPayloadSchema.parse(payload)
    return pickLocalContext(dependencies, kind)
  }
}

function dialogPropertiesFor(
  kind: LocalContextDialogKind
): LocalContextPickerDialogOptions['properties'] {
  if (kind === 'files') return ['openFile', 'multiSelections']
  if (kind === 'folders') return ['openDirectory', 'multiSelections']
  return ['openFile', 'openDirectory', 'multiSelections']
}

function acceptsSelectedKind(
  dialogKind: LocalContextDialogKind,
  selectedKind: 'file' | 'folder' | null
): selectedKind is 'file' | 'folder' {
  if (selectedKind === null) return false
  if (dialogKind === 'files') return selectedKind === 'file'
  if (dialogKind === 'folders') return selectedKind === 'folder'
  return true
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
