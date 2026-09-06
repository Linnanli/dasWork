import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import {
  CodexCommandClient,
  type CodexCommandExecOptions,
  type CodexCommandExecResult
} from '@dascowork/codex-app-server-client'

import type { GitBytesResult, GitHost, GitRunOptions, GitRunResult } from './GitManager'
import { createCodexClientInfo } from '../codexClientInfo'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const GIT_NON_INTERACTIVE_ENV = {
  LC_MESSAGES: 'C',
  LANGUAGE: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
} as const
const SSH_ALIAS_PATTERN = /^[A-Za-z0-9_.@:-]+$/u
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9._+-]+$/u
const READ_ONLY_SUBCOMMANDS = new Set([
  'branch',
  'check-ref-format',
  'config',
  'diff',
  'for-each-ref',
  'log',
  'ls-files',
  'merge-base',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
  'worktree'
])

export class GitHostRegistry {
  private readonly localHost = new LocalGitHost()
  private readonly remoteHosts = new Map<string, RemoteGitHost>()

  constructor(
    private readonly options: {
      remoteCodexCommand?: string
      createRemoteCommandClient?: (input: {
        hostId: string
        remoteCodexCommand: string
      }) => CodexCommandClient
    } = {}
  ) {}

  get(hostId: string): GitHost {
    if (hostId === 'local') return this.localHost
    const existing = this.remoteHosts.get(hostId)
    if (existing) return existing

    const remoteCodexCommand = this.options.remoteCodexCommand ?? 'codex'
    const commandClient =
      this.options.createRemoteCommandClient?.({ hostId, remoteCodexCommand }) ??
      createSshCommandClient(hostId, remoteCodexCommand)
    const host = new RemoteGitHost(hostId, commandClient, remoteCodexCommand)
    this.remoteHosts.set(hostId, host)
    return host
  }

  async validateRemoteRoot(hostId: string, path: string): Promise<void> {
    await this.getRemoteHost(hostId).validateRoot(path)
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.remoteHosts.values()].map((host) => host.shutdown()))
    this.remoteHosts.clear()
  }

  private getRemoteHost(hostId: string): RemoteGitHost {
    const host = this.get(hostId)
    if (host instanceof RemoteGitHost) return host
    throw new Error('Remote Git requires a non-local host ID')
  }

}

export class LocalGitHost implements GitHost {
  readonly id = 'local'
  readonly isLocal = true
  readonly platformFamily = process.platform === 'win32' ? 'windows' : 'posix'

  runGit(args: readonly string[], cwd: string, options: GitRunOptions = {}): Promise<GitRunResult> {
    return runLocalCommand(['git', ...args], cwd, options)
  }

  runGitBytes(
    args: readonly string[],
    cwd: string,
    options: GitRunOptions = {}
  ): Promise<GitBytesResult> {
    return runLocalCommandBytes(['git', ...args], cwd, options)
  }

  async readFileBytes(
    path: string,
    options: { maxBytes?: number; signal?: AbortSignal } = {}
  ): Promise<Uint8Array> {
    options.signal?.throwIfAborted()
    if (options.maxBytes === undefined) return readFile(path)
    const file = await open(path, 'r')
    try {
      options.signal?.throwIfAborted()
      const buffer = Buffer.allocUnsafe(options.maxBytes)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await file.close()
    }
  }

  async realpathFile(path: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    options.signal?.throwIfAborted()
    return realpath(path)
  }

  createTempDirectory(prefix: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    options.signal?.throwIfAborted()
    return mkdtemp(join(tmpdir(), prefix))
  }

  async copyFile(
    source: string,
    destination: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    options.signal?.throwIfAborted()
    await copyFile(source, destination)
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
    return rm(path, options)
  }

  async statFile(
    path: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ size?: number; mtimeMs?: number; ctimeMs?: number; ino?: number } | null> {
    options.signal?.throwIfAborted()
    try {
      const result = await stat(path)
      return {
        size: result.size,
        mtimeMs: result.mtimeMs,
        ctimeMs: result.ctimeMs,
        ino: result.ino
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}

export class RemoteGitHost implements GitHost {
  readonly isLocal = false
  readonly platformFamily = 'posix' as const
  private readonly ownedTempDirectories = new Set<string>()
  private readonly commonDirectories = new Map<string, string>()
  private readonly rootValidationsInFlight = new Map<string, Promise<void>>()
  private availabilityPromise: Promise<void> | undefined
  private writeTail: Promise<void> = Promise.resolve()
  private readonly activeReadCommands = new Set<Promise<void>>()
  private readonly removeTransportTerminationListener: () => void

  constructor(
    readonly id: string,
    private readonly commandClient: CodexCommandClient,
    private readonly remoteCodexCommand = 'codex'
  ) {
    assertSafeSshAlias(id)
    assertSafeRemoteExecutable(remoteCodexCommand)
    this.removeTransportTerminationListener = this.commandClient.onTransportTermination(() => {
      this.availabilityPromise = undefined
      this.commonDirectories.clear()
      this.rootValidationsInFlight.clear()
    })
  }

  async runGit(
    args: readonly string[],
    cwd: string,
    options: GitRunOptions = {}
  ): Promise<GitRunResult> {
    await this.ensureAvailable()
    const readOnly = isReadOnlyGitCommand(args)
    const writableRoots = readOnly ? undefined : await this.resolveWritableRoots(cwd)
    return this.runCommand(['git', ...args], {
      ...options,
      env: { ...GIT_NON_INTERACTIVE_ENV, ...options.env },
      cwd,
      readOnly,
      // All public Git mutations are local-only except the fixed publish
      // operation. `LocalPushService` is the sole caller that can construct a
      // push command, so remote workspaces do not get generic network access.
      networkAccess: gitSubcommand(args) === 'push',
      writableRoots
    })
  }

  async ensureAvailable(): Promise<void> {
    this.availabilityPromise ??= this.checkAvailability().catch((error: unknown) => {
      this.availabilityPromise = undefined
      throw error
    })
    await this.availabilityPromise
  }

  async validateRoot(path: string): Promise<void> {
    const existingValidation = this.rootValidationsInFlight.get(path)
    if (existingValidation) {
      await existingValidation
      return
    }

    const validation = this.checkRoot(path)
    this.rootValidationsInFlight.set(path, validation)
    try {
      await validation
    } finally {
      if (this.rootValidationsInFlight.get(path) === validation) {
        this.rootValidationsInFlight.delete(path)
      }
    }
  }

  async runCommand(
    command: string[],
    options: GitRunOptions & {
      cwd?: string
      readOnly?: boolean
      networkAccess?: boolean
      writableRoots?: string[]
    } = {}
  ): Promise<GitRunResult> {
    const execute = (): Promise<GitRunResult> => this.executeCommand(command, options)
    return options.readOnly ? this.runReadCommand(execute) : this.runWriteCommand(execute)
  }

  private async executeCommand(
    command: string[],
    options: GitRunOptions & {
      cwd?: string
      readOnly?: boolean
      networkAccess?: boolean
      writableRoots?: string[]
    }
  ): Promise<GitRunResult> {
    try {
      const execOptions: CodexCommandExecOptions = {
        command,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {}),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        outputBytesCap: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.input !== undefined ? { stdin: options.input } : {}),
        sandboxPolicy: options.readOnly
          ? { type: 'readOnly', networkAccess: false }
          : {
              type: 'workspaceWrite',
              writableRoots: options.writableRoots ?? [],
              networkAccess: options.networkAccess ?? false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false
            }
      }
      return commandResult(await this.commandClient.exec(execOptions))
    } catch (error) {
      return {
        success: false,
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private async runReadCommand(
    execute: () => Promise<GitRunResult>
  ): Promise<GitRunResult> {
    const execution = this.writeTail.then(execute)
    const tracking = execution.then(
      () => undefined,
      () => undefined
    )
    this.activeReadCommands.add(tracking)
    try {
      return await execution
    } finally {
      this.activeReadCommands.delete(tracking)
    }
  }

  private runWriteCommand(execute: () => Promise<GitRunResult>): Promise<GitRunResult> {
    const priorWrites = this.writeTail
    const priorReads = Promise.allSettled([...this.activeReadCommands])
    const execution = Promise.all([priorWrites, priorReads]).then(execute)
    this.writeTail = execution.then(
      () => undefined,
      () => undefined
    )
    return execution
  }

  async createTempDirectory(
    prefix: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<string> {
    const safePrefix = prefix.replace(/[^A-Za-z0-9._-]/gu, '-')
    const result = await this.runCommand(['mktemp', '-d', '-t', `${safePrefix}XXXXXX`], {
      signal: options.signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      writableRoots: []
    })
    const directory = result.stdout.trim()
    if (!result.success || !directory.startsWith('/')) {
      throw new Error(result.stderr || 'Unable to create a remote Git temporary directory')
    }
    this.ownedTempDirectories.add(directory)
    return directory
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void> {
    if (!this.ownedTempDirectories.delete(path)) {
      throw new Error('Refusing to remove a remote path not owned by the Git host')
    }
    const args = ['rm']
    if (options.recursive) args.push('-r')
    if (options.force) args.push('-f')
    args.push('--', path)
    const result = await this.runCommand(args, {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      writableRoots: [path]
    })
    if (!result.success) throw new Error(result.stderr || `Unable to remove ${path}`)
  }

  async copyFile(
    source: string,
    destination: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<void> {
    const result = await this.runCommand(['cp', '--', source, destination], {
      signal: options.signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      writableRoots: [posix.dirname(destination)]
    })
    if (!result.success && !/no such file|not found/iu.test(result.stderr)) {
      throw new Error(result.stderr || `Unable to copy ${source}`)
    }
  }

  async statFile(
    path: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<{ size?: number; mtimeMs?: number; ctimeMs?: number; ino?: number } | null> {
    const formats = [
      ['stat', '-c', '%s\\t%Y\\t%Z\\t%i', '--', path],
      ['stat', '-f', '%z\\t%m\\t%c\\t%i', '--', path]
    ]
    for (const command of formats) {
      const result = await this.runCommand(command, {
        signal: options.signal,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        readOnly: true
      })
      const value = parseRemoteStat(result.stdout)
      if (result.success && value) return value
    }
    return null
  }

  shutdown(): Promise<void> {
    this.availabilityPromise = undefined
    this.commonDirectories.clear()
    this.rootValidationsInFlight.clear()
    this.removeTransportTerminationListener()
    return this.commandClient.shutdown()
  }

  private async checkAvailability(): Promise<void> {
    await this.commandClient.connect()
    const result = await this.runCommand([this.remoteCodexCommand, '--version'], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      readOnly: true
    })
    if (!result.success || !isCodexVersionOutput(result.stdout, result.stderr)) {
      throw new Error(
        result.stderr || `Remote Codex on ${this.id} did not report a compatible command interface`
      )
    }
  }

  private async checkRoot(path: string): Promise<void> {
    await this.ensureAvailable()
    const result = await this.runCommand(['test', '-d', path], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      readOnly: true
    })
    if (!result.success) {
      throw new Error(`Remote workspace is unavailable on ${this.id}: ${path}`)
    }
  }

  private async resolveWritableRoots(cwd: string): Promise<string[]> {
    const cached = this.commonDirectories.get(cwd)
    if (cached) return cached === cwd ? [cwd] : [cwd, cached]

    const result = await this.runCommand(['git', 'rev-parse', '--git-common-dir'], {
      cwd,
      readOnly: true,
      timeoutMs: DEFAULT_TIMEOUT_MS
    })
    if (!result.success) return [cwd]
    const rawCommonDir = result.stdout.trim()
    const commonDir = rawCommonDir.startsWith('/')
      ? posix.normalize(rawCommonDir)
      : posix.resolve(cwd, rawCommonDir)
    this.commonDirectories.set(cwd, commonDir)
    return commonDir === cwd ? [cwd] : [cwd, commonDir]
  }
}

function parseRemoteStat(
  output: string
): { size?: number; mtimeMs?: number; ctimeMs?: number; ino?: number } | null {
  const values = output
    .trim()
    .split('\t')
    .map((value) => Number(value))
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return null
  return {
    size: values[0],
    mtimeMs: values[1] * 1000,
    ctimeMs: values[2] * 1000,
    ino: values[3]
  }
}

function createSshCommandClient(hostId: string, remoteCodexCommand: string): CodexCommandClient {
  return new CodexCommandClient({
    transport: createSshCodexAppServerTransport(hostId, remoteCodexCommand),
    experimentalApi: true,
    clientInfo: createCodexClientInfo('dascowork_git', 'dasCowork Git')
  })
}

export function createSshCodexAppServerTransport(
  hostId: string,
  remoteCodexCommand: string
): {
  type: 'stdio'
  stdio: { command: string; args: string[] }
} {
  assertSafeSshAlias(hostId)
  assertSafeRemoteExecutable(remoteCodexCommand)
  const remoteCommand = [
    'exec',
    quotePosixShellWord(remoteCodexCommand),
    'app-server',
    '--listen',
    'stdio://'
  ].join(' ')
  return { type: 'stdio', stdio: { command: 'ssh', args: [hostId, remoteCommand] } }
}

function runLocalCommand(
  command: readonly string[],
  cwd: string,
  options: GitRunOptions
): Promise<GitRunResult> {
  const [executable, ...args] = command
  if (!executable) {
    return Promise.resolve({ success: false, code: null, stdout: '', stderr: 'Empty command' })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        ...GIT_NON_INTERACTIVE_ENV,
        ...options.env
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let outputExceeded = false

    const finish = (result: GitRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolveResult(result)
    }
    const abort = (): void => {
      child.kill('SIGKILL')
      finish({ success: false, code: null, stdout, stderr: 'git process aborted' })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        success: false,
        code: null,
        stdout,
        stderr: `git process timed out after ${String(timeoutMs)}ms`
      })
    }, timeoutMs)
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled || outputExceeded) return
      if (stream === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= maxOutputBytes) return
      outputExceeded = true
      child.kill('SIGKILL')
      finish({
        success: false,
        code: null,
        stdout,
        stderr: 'git output exceeded limit'
      })
    }

    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.on('error', (error) =>
      finish({ success: false, code: null, stdout, stderr: error.message })
    )
    child.on('close', (code) =>
      finish({
        success: code === 0,
        code,
        stdout,
        stderr
      })
    )

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    child.stdin.end(options.input)
  })
}

function runLocalCommandBytes(
  command: readonly string[],
  cwd: string,
  options: GitRunOptions
): Promise<GitBytesResult> {
  const [executable, ...args] = command
  if (!executable) {
    return Promise.resolve({
      success: false,
      code: null,
      stdout: new Uint8Array(),
      stderr: 'Empty command'
    })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...process.env,
        ...GIT_NON_INTERACTIVE_ENV,
        ...options.env
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    const chunks: Buffer[] = []
    let stderr = ''
    let outputBytes = 0
    let settled = false
    const finish = (result: GitBytesResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      resolveResult(result)
    }
    const abort = (): void => {
      child.kill('SIGKILL')
      finish({
        success: false,
        code: null,
        stdout: Buffer.concat(chunks),
        stderr: 'git process aborted'
      })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        success: false,
        code: null,
        stdout: Buffer.concat(chunks),
        stderr: `git process timed out after ${String(timeoutMs)}ms`
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL')
        finish({
          success: false,
          code: null,
          stdout: Buffer.concat(chunks),
          stderr: 'git output exceeded limit'
        })
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      stderr += chunk.toString('utf8')
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL')
        finish({
          success: false,
          code: null,
          stdout: Buffer.concat(chunks),
          stderr: 'git output exceeded limit'
        })
      }
    })
    child.on('error', (error) =>
      finish({ success: false, code: null, stdout: Buffer.concat(chunks), stderr: error.message })
    )
    child.on('close', (code) =>
      finish({ success: code === 0, code, stdout: Buffer.concat(chunks), stderr })
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    child.stdin.end(options.input)
  })
}

function commandResult(result: CodexCommandExecResult): GitRunResult {
  const outputCapReached = result.stdoutCapReached || result.stderrCapReached
  const capMessage = outputCapReached ? 'git output exceeded limit' : ''
  return {
    success: result.exitCode === 0 && !outputCapReached,
    code: result.exitCode,
    stdout: result.stdout,
    stderr: [result.stderr, capMessage].filter(Boolean).join('\n')
  }
}

function isReadOnlyGitCommand(args: readonly string[]): boolean {
  const subcommand = gitSubcommand(args)
  if (!READ_ONLY_SUBCOMMANDS.has(subcommand)) return false
  return !(subcommand === 'config' && args.some((arg) => /^--?(add|replace-all|unset)/u.test(arg)))
}

function gitSubcommand(args: readonly string[]): string {
  let index = 0
  while (args[index] === '-c' || args[index] === '--config-env') index += 2
  return args[index] ?? ''
}

export function assertSafeSshAlias(hostId: string): void {
  if (!hostId || hostId.startsWith('-') || !SSH_ALIAS_PATTERN.test(hostId)) {
    throw new Error(`Invalid SSH host alias: ${hostId}`)
  }
}

export function assertSafeRemoteExecutable(command: string): void {
  if (
    !command ||
    command.includes('\0') ||
    /[\r\n]/u.test(command) ||
    (!command.startsWith('/') && !EXECUTABLE_NAME_PATTERN.test(command))
  ) {
    throw new Error('Remote Codex command must be an executable name or absolute POSIX path')
  }
}

function quotePosixShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function isCodexVersionOutput(stdout: string, stderr: string): boolean {
  const output = `${stdout}\n${stderr}`.trim()
  return /^codex(?:-cli)?\s+\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(output)
}
