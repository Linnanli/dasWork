import { spawn } from 'node:child_process'

export type GithubCliResult = {
  stdout: string
  stderr: string
}

export type GithubCliOptions = {
  timeoutMs?: number
  maxOutputBytes?: number
}

export class GithubCliError extends Error {
  constructor(
    message: string,
    readonly code: 'GITHUB_CLI_UNAVAILABLE' | 'GITHUB_CLI_FAILED' | 'GITHUB_CLI_TIMED_OUT',
    readonly stderr = ''
  ) {
    super(message)
  }
}

export async function runGithubCli(
  cwd: string,
  args: readonly string[],
  options: GithubCliOptions = {}
): Promise<GithubCliResult> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024

  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, {
      cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new GithubCliError('GitHub CLI timed out', 'GITHUB_CLI_TIMED_OUT', stderr)))
    }, timeoutMs)
    const collect = (current: string, chunk: Buffer): string | undefined => {
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next) <= maxOutputBytes) return next
      child.kill('SIGKILL')
      finish(() => reject(new GithubCliError('GitHub CLI output exceeded its limit', 'GITHUB_CLI_FAILED', stderr)))
      return undefined
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const next = collect(stdout, chunk)
      if (next !== undefined) stdout = next
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const next = collect(stderr, chunk)
      if (next !== undefined) stderr = next
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          new GithubCliError(
            error.code === 'ENOENT' ? 'GitHub CLI is not installed' : 'GitHub CLI could not start',
            error.code === 'ENOENT' ? 'GITHUB_CLI_UNAVAILABLE' : 'GITHUB_CLI_FAILED',
            stderr
          )
        )
      )
    })
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }
        reject(new GithubCliError('GitHub CLI command failed', 'GITHUB_CLI_FAILED', stderr))
      })
    })
  })
}
