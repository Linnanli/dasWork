import { spawn } from 'node:child_process'

import type { WorktreeRepository } from './GitManager'
import type { GitReadCacheMetadata } from './GitReadCache'

export type GitCliResult = {
  stdout: string
  stderr: string
}

export type GitInvocationRecord = {
  target: string
  args: readonly string[]
  durationMs: number
  success: boolean
  exitCode?: number | null
  maxOutputBytes?: number
}

export type GitInvocationObserver = (record: GitInvocationRecord) => void

export type GitCliOptions = {
  input?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
  env?: Record<string, string | undefined>
  priority?: 'background'
}

export type GitDiffCliOptions = GitCliOptions & {
  binary?: boolean
  configOverrides?: readonly string[]
}

export const gitOutputExceededLimitMessage = 'git output exceeded limit'
export const gitDiffOutputLimitBytes = 32 * 1024 * 1024
const gitDiffConfigOverrides = [
  'diff.mnemonicPrefix=false',
  'diff.noprefix=false',
  'core.quotePath=false'
] as const
const gitDiffPrefix = [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--color=never',
  '--src-prefix=a/',
  '--dst-prefix=b/'
] as const

let gitInvocationObserver: GitInvocationObserver | undefined

export class GitCliError extends Error {
  readonly code = 'GIT_COMMAND_FAILED'

  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(message)
  }
}

export function setGitInvocationObserver(observer: GitInvocationObserver | undefined): () => void {
  const previous = gitInvocationObserver
  gitInvocationObserver = observer
  return () => {
    gitInvocationObserver = previous
  }
}

export async function runGit(
  target: string | WorktreeRepository,
  args: readonly string[],
  options: GitCliOptions = {}
): Promise<GitCliResult> {
  const start = Date.now()
  if (typeof target !== 'string') {
    try {
      const result = await target.git(args, options)
      recordGitInvocation(target.root, args, start, result.success, result.code, options)
      if (result.success) return { stdout: result.stdout, stderr: result.stderr }
      throw new GitCliError(
        `git ${args.join(' ')} failed with exit code ${result.code ?? 'unknown'}`,
        result.code,
        result.stdout,
        result.stderr
      )
    } catch (error) {
      if (!isGitCliError(error)) {
        recordGitInvocation(target.root, args, start, false, undefined, options)
      }
      throw error
    }
  }

  const timeoutMs = options.timeoutMs ?? 15_000
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024

  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: target,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      recordGitInvocation(target, args, start, false, undefined, options)
      reject(new GitCliError(`git ${args[0] ?? ''} timed out`, null, stdout, stderr))
    }, timeoutMs)
    const abort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      recordGitInvocation(target, args, start, false, undefined, options)
      const error = new GitCliError('git process aborted', null, stdout, stderr)
      error.name = 'AbortError'
      reject(error)
    }

    const collect = (chunk: Buffer, current: string): string => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next) > maxOutputBytes) {
        child.kill('SIGKILL')
        throw new GitCliError(gitOutputExceededLimitMessage, null, stdout, stderr)
      }
      return next
    }

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdout = collect(chunk, stdout)
      } catch (error) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          recordGitInvocation(target, args, start, false, undefined, options)
          reject(error)
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      try {
        stderr = collect(chunk, stderr)
      } catch (error) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          recordGitInvocation(target, args, start, false, undefined, options)
          reject(error)
        }
      }
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      recordGitInvocation(target, args, start, false, undefined, options)
      reject(error)
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      recordGitInvocation(target, args, start, exitCode === 0, exitCode, options)
      if (exitCode === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new GitCliError(
          `git ${args.join(' ')} failed with exit code ${exitCode ?? 'unknown'}`,
          exitCode,
          stdout,
          stderr
        )
      )
    })

    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      abort()
      return
    }
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function recordGitInvocation(
  target: string,
  args: readonly string[],
  start: number,
  success: boolean,
  exitCode?: number | null,
  options?: GitCliOptions
): void {
  gitInvocationObserver?.({
    target,
    args: [...args],
    durationMs: Date.now() - start,
    success,
    exitCode,
    maxOutputBytes: options?.maxOutputBytes
  })
}

/**
 * Runs Git's diff machinery with the same deterministic output contract used
 * by the reference GitManager. Keeping this here prevents individual review
 * call sites from accidentally accepting external diffs, text conversions, or
 * host-specific path quoting.
 */
export function runGitDiff(
  target: string | WorktreeRepository,
  args: readonly string[],
  options: GitDiffCliOptions = {}
): Promise<GitCliResult> {
  const { maxOutputBytes, ...runOptions } = options
  const outputLimit =
    maxOutputBytes === undefined
      ? gitDiffOutputLimitBytes
      : Math.min(maxOutputBytes, gitDiffOutputLimitBytes)
  return runGit(target, createGitDiffArgs(args, options), {
    ...runOptions,
    maxOutputBytes: outputLimit
  })
}

/**
 * Cached read counterpart to runGit. Callers must choose a semantic key and
 * invalidation metadata instead of caching arbitrary command strings.
 */
export function runCachedGitRead(
  repository: WorktreeRepository,
  cacheType: string,
  cacheParts: readonly string[],
  args: readonly string[],
  options: GitCliOptions = {},
  cacheOptions: { staleTime?: number; metadata?: GitReadCacheMetadata } = {}
): Promise<GitCliResult> {
  return repository.readCached(
    cacheType,
    cacheParts,
    () => runGit(repository, args, options),
    cacheOptions
  )
}

export function createGitDiffArgs(
  args: readonly string[],
  options: Pick<GitDiffCliOptions, 'binary' | 'configOverrides'> = {}
): string[] {
  const configArgs = [...gitDiffConfigOverrides, ...(options.configOverrides ?? [])].flatMap(
    (value) => ['-c', value]
  )
  return [...configArgs, ...gitDiffPrefix, ...(options.binary ? ['--binary'] : []), ...args]
}

export function isGitCliError(error: unknown): error is GitCliError {
  return error instanceof GitCliError
}

export function isGitOutputLimitError(error: unknown): error is GitCliError {
  if (!isGitCliError(error)) return false
  return [error.message, error.stderr, error.stdout].some(
    (output) => output.trim() === gitOutputExceededLimitMessage
  )
}
