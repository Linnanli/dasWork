import { describe, expect, it } from 'vitest'

import {
  projectActionRemovePayloadSchema,
  projectActionUpsertPayloadSchema,
  projectCreateBlankPayloadSchema,
  projectCreateRemotePayloadSchema,
  projectSelectionSchema,
  projectWorktreeListPayloadSchema,
  projectWorktreeSelectPayloadSchema
} from './projectSchemas'

describe('project selection schema', () => {
  it('accepts local, remote, path, and projectless selections', () => {
    expect(
      projectSelectionSchema.safeParse({ projectKind: 'local', projectId: 'project-1' }).success
    ).toBe(true)
    expect(
      projectSelectionSchema.safeParse({
        projectKind: 'remote',
        projectId: 'project-1',
        hostId: 'host-1'
      }).success
    ).toBe(true)
    expect(
      projectSelectionSchema.safeParse({ projectKind: 'path', path: '/Users/test/project' }).success
    ).toBe(true)
    expect(
      projectSelectionSchema.safeParse({
        projectKind: 'path',
        path: '/Users/test/project',
        hostId: 'local'
      }).success
    ).toBe(true)
    expect(projectSelectionSchema.safeParse({ projectKind: 'projectless' }).success).toBe(true)
  })

  it('rejects invalid selections', () => {
    expect(projectSelectionSchema.safeParse({ projectKind: 'local', projectId: '' }).success).toBe(
      false
    )
    expect(
      projectSelectionSchema.safeParse({
        projectKind: 'remote',
        projectId: 'project-1',
        hostId: ''
      }).success
    ).toBe(false)
    expect(projectSelectionSchema.safeParse({ projectKind: 'path', path: '' }).success).toBe(false)
    expect(
      projectSelectionSchema.safeParse({
        projectKind: 'path',
        path: '/Users/test/project',
        hostId: 'remote-host'
      }).success
    ).toBe(false)
    expect(projectSelectionSchema.safeParse({ projectKind: 'unknown' }).success).toBe(false)
  })
})

describe('project worktree payload schemas', () => {
  it('accepts a local source and absolute worktree path', () => {
    expect(
      projectWorktreeListPayloadSchema.safeParse({
        source: { projectKind: 'local', projectId: 'project-1' }
      }).success
    ).toBe(true)
    expect(
      projectWorktreeSelectPayloadSchema.safeParse({
        source: { projectKind: 'path', path: '/workspace/app' },
        path: '/workspace/app-feature'
      }).success
    ).toBe(true)
  })

  it.each(['relative/path', '//network/share', '\\\\network\\share', '/workspace/line\nbreak'])(
    'rejects an unsafe worktree path %j',
    (path) => {
      expect(
        projectWorktreeSelectPayloadSchema.safeParse({
          source: { projectKind: 'path', path: '/workspace/app' },
          path
        }).success
      ).toBe(false)
    }
  )
})

describe('blank project payload schema', () => {
  it('trims and accepts a safe directory name', () => {
    expect(
      projectCreateBlankPayloadSchema.parse({
        operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
        name: '  New App  '
      })
    ).toEqual({
      operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
      name: 'New App'
    })
  })

  it.each(['', '   ', '.', '..', 'nested/project', 'nested\\project', 'bad\0name'])(
    'rejects unsafe project name %j',
    (name) => {
      expect(
        projectCreateBlankPayloadSchema.safeParse({
          operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
          name
        }).success
      ).toBe(false)
    }
  )

  it('rejects names longer than 80 characters', () => {
    expect(
      projectCreateBlankPayloadSchema.safeParse({
        operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
        name: 'a'.repeat(81)
      }).success
    ).toBe(false)
  })

  it('requires a valid idempotency operation id', () => {
    expect(
      projectCreateBlankPayloadSchema.safeParse({
        operationId: 'not-a-uuid',
        name: 'New App'
      }).success
    ).toBe(false)
  })
})

describe('remote terminal command schema', () => {
  it('accepts a main-validated host terminal command and normalized execution server URL', () => {
    expect(
      projectCreateRemotePayloadSchema.parse({
        hostId: 'build-host',
        label: 'Build host',
        remotePath: '/srv/app',
        execServerUrl: '  wss://exec.example.test/codex  ',
        terminalCommand: '/bin/zsh'
      })
    ).toMatchObject({
      execServerUrl: 'wss://exec.example.test/codex',
      terminalCommand: '/bin/zsh'
    })
  })

  it('rejects command lines and unsafe remote execution URLs', () => {
    expect(
      projectCreateRemotePayloadSchema.safeParse({
        hostId: 'build-host',
        label: 'Build host',
        remotePath: '/srv/app',
        execServerUrl: 'wss://exec.example.test/codex',
        terminalCommand: 'zsh -l'
      }).success
    ).toBe(false)
    for (const execServerUrl of [
      'https://exec.example.test',
      'wss://user:secret@exec.example.test',
      'wss://exec.example.test?token=secret',
      'not a URL'
    ]) {
      expect(
        projectCreateRemotePayloadSchema.safeParse({
          hostId: 'build-host',
          label: 'Build host',
          remotePath: '/srv/app',
          execServerUrl
        }).success
      ).toBe(false)
    }
  })
})

describe('project action payload schemas', () => {
  it('accepts a named action for a project scope', () => {
    expect(
      projectActionUpsertPayloadSchema.parse({
        scope: { projectKind: 'path', path: '/workspace/app' },
        action: { title: '  Test  ', command: '  npm test  ' }
      })
    ).toEqual({
      scope: { projectKind: 'path', path: '/workspace/app' },
      action: { title: 'Test', command: 'npm test' }
    })
  })

  it('rejects projectless scopes, invalid IDs, and NUL commands', () => {
    expect(
      projectActionUpsertPayloadSchema.safeParse({
        scope: { projectKind: 'projectless' },
        action: { title: 'Test', command: 'npm test' }
      }).success
    ).toBe(false)
    expect(
      projectActionRemovePayloadSchema.safeParse({
        scope: { projectKind: 'local', projectId: 'project' },
        actionId: 'not-a-uuid'
      }).success
    ).toBe(false)
    expect(
      projectActionUpsertPayloadSchema.safeParse({
        scope: { projectKind: 'local', projectId: 'project' },
        action: { title: 'Test', command: 'echo bad\0command' }
      }).success
    ).toBe(false)
  })
})
