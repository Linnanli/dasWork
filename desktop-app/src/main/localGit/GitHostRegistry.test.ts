import { describe, expect, it, vi } from 'vitest'

import type { CodexCommandClient, CodexCommandExecResult } from '@dascowork/codex-app-server-client'

import { GitHostRegistry, RemoteGitHost } from './GitHostRegistry'

describe('GitHostRegistry', () => {
  it('reuses one remote host and command connection for the same SSH alias', () => {
    const client = createCommandClient()
    const createRemoteCommandClient = vi.fn(() => client)
    const registry = new GitHostRegistry({ createRemoteCommandClient })

    expect(registry.get('devbox')).toBe(registry.get('devbox'))
    expect(createRemoteCommandClient).toHaveBeenCalledTimes(1)
  })

  it('validates remote Codex before checking the workspace root', async () => {
    const client = createCommandClient([
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 })
    ])
    const registry = new GitHostRegistry({
      createRemoteCommandClient: () => client
    })

    await expect(registry.validateRemoteRoot('devbox', '/srv/repo')).resolves.toBeUndefined()
    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.exec).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: ['codex', '--version'],
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: ['test', '-d', '/srv/repo'],
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
  })

  it('coalesces concurrent validation of the same remote workspace', async () => {
    let resolveRootCheck: (() => void) | undefined
    const client = createCommandClient()
    client.exec = vi.fn(async (options) => {
      if (options.command[0] === 'codex') {
        return commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 })
      }
      await new Promise<void>((resolve) => {
        resolveRootCheck = resolve
      })
      return commandResult({ stdout: '', stderr: '', exitCode: 0 })
    })
    const registry = new GitHostRegistry({ createRemoteCommandClient: () => client })

    const validations = [
      registry.validateRemoteRoot('devbox', '/srv/repo'),
      registry.validateRemoteRoot('devbox', '/srv/repo')
    ]
    await vi.waitFor(() => expect(resolveRootCheck).toBeTypeOf('function'))
    expect(client.exec).toHaveBeenCalledTimes(2)

    resolveRootCheck?.()
    await Promise.all(validations)
  })

  it('rechecks a remote workspace after a successful validation', async () => {
    const client = createCommandClient([
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: 'workspace missing', exitCode: 1 })
    ])
    const registry = new GitHostRegistry({ createRemoteCommandClient: () => client })

    await expect(registry.validateRemoteRoot('devbox', '/srv/repo')).resolves.toBeUndefined()
    await expect(registry.validateRemoteRoot('devbox', '/srv/repo')).rejects.toThrow(
      'Remote workspace is unavailable on devbox: /srv/repo'
    )

    expect(client.exec).toHaveBeenCalledTimes(3)
    expect(client.exec).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: ['test', '-d', '/srv/repo'] })
    )
  })

  it('runs remote read-only Git commands concurrently', async () => {
    const deferredResults: Array<() => void> = []
    const client = createCommandClient()
    client.exec = vi.fn(async (options) => {
      if (options.command[0] === 'codex') {
        return commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 })
      }
      return new Promise<CodexCommandExecResult>((resolve) => {
        deferredResults.push(() =>
          resolve(commandResult({ stdout: '', stderr: '', exitCode: 0 }))
        )
      })
    })
    const host = new RemoteGitHost('devbox', client)

    const first = host.runGit(['status', '--porcelain=v1'], '/srv/repo')
    const second = host.runGit(['diff', '--name-only'], '/srv/repo')

    await vi.waitFor(() => expect(deferredResults).toHaveLength(2))
    deferredResults.forEach((resolve) => resolve())
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true })
    ])
  })

  it('waits for active remote reads before starting a write', async () => {
    let resolveRead: (() => void) | undefined
    const client = createCommandClient()
    client.exec = vi.fn(async (options) => {
      if (options.command[1] !== 'status') {
        return commandResult({ stdout: '', stderr: '', exitCode: 0 })
      }
      await new Promise<void>((resolve) => {
        resolveRead = resolve
      })
      return commandResult({ stdout: '', stderr: '', exitCode: 0 })
    })
    const host = new RemoteGitHost('devbox', client)

    const read = host.runCommand(['git', 'status'], { readOnly: true })
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf('function'))
    const write = host.runCommand(['git', 'add', 'notes.txt'], {
      writableRoots: ['/srv/repo']
    })

    await Promise.resolve()
    expect(client.exec).toHaveBeenCalledTimes(1)
    resolveRead?.()
    await expect(Promise.all([read, write])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true })
    ])
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: ['git', 'add', 'notes.txt'] })
    )
  })

  it('retries availability after an incompatible remote command response', async () => {
    const client = createCommandClient([
      commandResult({ stdout: '', stderr: 'unknown command', exitCode: 1 }),
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 })
    ])
    const registry = new GitHostRegistry({
      createRemoteCommandClient: () => client
    })

    await expect(registry.validateRemoteRoot('devbox', '/srv/repo')).rejects.toThrow(
      'unknown command'
    )
    await expect(registry.validateRemoteRoot('devbox', '/srv/repo')).resolves.toBeUndefined()
    expect(client.connect).toHaveBeenCalledTimes(2)
  })

  it('runs Git in the remote cwd and grants mutations only repository roots', async () => {
    const client = createCommandClient([
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '../.git\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 })
    ])
    const host = new RemoteGitHost('devbox', client)

    await expect(host.runGit(['add', '--all'], '/srv/repo/worktree')).resolves.toMatchObject({
      success: true
    })
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: ['git', 'rev-parse', '--git-common-dir'],
        cwd: '/srv/repo/worktree',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
    expect(client.exec).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        command: ['git', 'add', '--all'],
        cwd: '/srv/repo/worktree',
        env: expect.objectContaining({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }),
        sandboxPolicy: expect.objectContaining({
          type: 'workspaceWrite',
          writableRoots: ['/srv/repo/worktree', '/srv/repo/.git']
        })
      })
    )
  })

  it('keeps configured diff commands read-only', async () => {
    const client = createCommandClient([
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 })
    ])
    const host = new RemoteGitHost('devbox', client)

    await expect(
      host.runGit(['-c', 'diff.mnemonicPrefix=false', 'diff', '--numstat'], '/srv/repo')
    ).resolves.toMatchObject({ success: true })

    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: ['git', '-c', 'diff.mnemonicPrefix=false', 'diff', '--numstat'],
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
  })

  it('reads remote index fingerprints with GNU stat and a BSD fallback', async () => {
    const client = createCommandClient([
      commandResult({ stdout: '', stderr: 'illegal option -- c', exitCode: 1 }),
      commandResult({ stdout: '12\t3\t4\t5\n', stderr: '', exitCode: 0 })
    ])
    const host = new RemoteGitHost('devbox', client)

    await expect(host.statFile('/srv/repo/.git/index')).resolves.toEqual({
      size: 12,
      mtimeMs: 3_000,
      ctimeMs: 4_000,
      ino: 5
    })
    expect(client.exec).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: ['stat', '-c', '%s\\t%Y\\t%Z\\t%i', '--', '/srv/repo/.git/index'],
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
    expect(client.exec).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: ['stat', '-f', '%z\\t%m\\t%c\\t%i', '--', '/srv/repo/.git/index'],
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
  })

  it('forgets remote availability and common-dir caches after transport termination', async () => {
    let terminateTransport: ((error: Error) => void) | undefined
    const client = createCommandClient([
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '../.git\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 }),
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '../.git\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 })
    ])
    client.onTransportTermination = vi.fn((listener) => {
      terminateTransport = listener
      return () => undefined
    })
    const host = new RemoteGitHost('devbox', client)

    await host.runGit(['add', 'first.txt'], '/srv/repo/worktree')
    terminateTransport?.(new Error('transport closed'))
    await host.runGit(['add', 'second.txt'], '/srv/repo/worktree')

    expect(client.connect).toHaveBeenCalledTimes(2)
    expect(client.exec).toHaveBeenCalledTimes(6)
  })

  it('rejects unsafe SSH aliases and closes all persistent clients on shutdown', async () => {
    const client = createCommandClient()
    const registry = new GitHostRegistry({
      createRemoteCommandClient: () => client
    })

    expect(() => registry.get('-oProxyCommand=bad')).toThrow('Invalid SSH host alias')
    registry.get('devbox')
    await registry.shutdown()
    expect(client.shutdown).toHaveBeenCalledOnce()
  })

  it('uses the configured remote Codex command and scopes mutation writable roots', async () => {
    const client = createCommandClient([
      commandResult({ stdout: 'codex-cli 1.2.3\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '../.git\n', stderr: '', exitCode: 0 }),
      commandResult({ stdout: '', stderr: '', exitCode: 0 })
    ])
    const createRemoteCommandClient = vi.fn(() => client)
    const registry = new GitHostRegistry({
      remoteCodexCommand: 'codex-remote',
      createRemoteCommandClient
    })
    const host = registry.get('devbox')

    await expect(host.runGit(['apply', '-'], '/srv/repo/worktree')).resolves.toMatchObject({
      success: true
    })

    expect(createRemoteCommandClient).toHaveBeenCalledWith({
      hostId: 'devbox',
      remoteCodexCommand: 'codex-remote'
    })
    expect(client.exec).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        command: ['codex-remote', '--version'],
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      })
    )
    expect(client.exec).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        command: ['git', 'apply', '-'],
        cwd: '/srv/repo/worktree',
        sandboxPolicy: expect.objectContaining({
          type: 'workspaceWrite',
          writableRoots: ['/srv/repo/worktree', '/srv/repo/.git']
        })
      })
    )
  })
})

function createCommandClient(results: CodexCommandExecResult[] = []): CodexCommandClient {
  return {
    serverInfo: { name: 'codex-app-server', version: '1.2.3' },
    connect: vi.fn(async () => undefined),
    exec: vi.fn(async () => {
      const result = results.shift()
      if (!result) return commandResult({ stdout: '', stderr: '', exitCode: 0 })
      return result
    }),
    onTransportTermination: vi.fn(() => () => undefined),
    shutdown: vi.fn(async () => undefined)
  } as unknown as CodexCommandClient
}

function commandResult(input: {
  stdout: string
  stderr: string
  exitCode: number
}): CodexCommandExecResult {
  return {
    processId: 'process',
    stdoutCapReached: false,
    stderrCapReached: false,
    ...input
  }
}
