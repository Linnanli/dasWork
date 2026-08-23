import { describe, expect, it } from 'vitest'

import {
  FILE_WORKSPACE_API_VERSION,
  fileWorkspaceEventSchema,
  fileWorkspaceListDirectoryRequestSchema,
  normalizeFileWorkspaceRelativePath,
  fileWorkspaceReadFileRequestSchema,
  fileWorkspaceRelativePathSchema,
  fileWorkspaceSearchRequestSchema,
  fileWorkspaceSearchSessionEventSchema,
  fileWorkspaceSearchSessionUpdateRequestSchema
} from './fileWorkspaceApi'

describe('file workspace API schemas', () => {
  it('canonicalizes harmless relative path spelling without resolving traversal', () => {
    expect(normalizeFileWorkspaceRelativePath('./src//./main.ts')).toBe('src/main.ts')
    expect(normalizeFileWorkspaceRelativePath('src/../secret.ts')).toBe('src/../secret.ts')
    expect(normalizeFileWorkspaceRelativePath('/repo/./main.ts')).toBe('/repo/main.ts')
  })

  it('accepts root ids and normalized relative paths', () => {
    expect(
      fileWorkspaceListDirectoryRequestSchema.parse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'src/main'
      })
    ).toEqual({
      version: FILE_WORKSPACE_API_VERSION,
      rootId: 'project-1',
      path: 'src/main'
    })

    expect(fileWorkspaceRelativePathSchema.parse('')).toBe('')
  })

  it('rejects absolute, windows, traversal, null, and non-normalized paths', () => {
    for (const path of [
      '/repo/file.ts',
      'C:\\repo\\file.ts',
      '../secret',
      'src/../secret',
      'a\0b',
      'src/./file.ts'
    ]) {
      expect(fileWorkspaceRelativePathSchema.safeParse(path).success).toBe(false)
    }
  })

  it('bounds read and search requests', () => {
    expect(
      fileWorkspaceReadFileRequestSchema.safeParse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        path: 'file.txt',
        textByteLimit: 1
      }).success
    ).toBe(true)
    expect(
      fileWorkspaceSearchRequestSchema.safeParse({
        version: FILE_WORKSPACE_API_VERSION,
        rootId: 'project-1',
        query: '',
        limit: 1
      }).success
    ).toBe(false)
  })

  it('only exposes workspace-relative file change events', () => {
    expect(
      fileWorkspaceEventSchema.safeParse({
        version: FILE_WORKSPACE_API_VERSION,
        type: 'changed',
        rootId: 'project-1',
        path: 'src/main.ts'
      }).success
    ).toBe(true)
    expect(
      fileWorkspaceEventSchema.safeParse({
        version: FILE_WORKSPACE_API_VERSION,
        type: 'changed',
        rootId: 'project-1',
        path: '../outside.ts'
      }).success
    ).toBe(false)
  })

  it('bounds incremental search session updates and results', () => {
    expect(
      fileWorkspaceSearchSessionUpdateRequestSchema.safeParse({
        version: FILE_WORKSPACE_API_VERSION,
        sessionId: 'search-1',
        query: ''
      }).success
    ).toBe(true)
    expect(
      fileWorkspaceSearchSessionEventSchema.safeParse({
        version: FILE_WORKSPACE_API_VERSION,
        type: 'search-results',
        rootId: 'project-1',
        sessionId: 'search-1',
        query: 'button',
        matches: [{ path: '../outside.ts', kind: 'path' }],
        complete: false
      }).success
    ).toBe(false)
  })
})
