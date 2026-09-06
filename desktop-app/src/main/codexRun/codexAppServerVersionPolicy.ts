import { spawn } from 'node:child_process'

import protocolManifest from '../../../vendors/codex-app-server-client/protocol-manifest.json'
import type { CodexAppServerLaunchOptions } from '../codexAppServerLaunch'

export class CodexAppServerVersionUnsupportedError extends Error {
  readonly code = 'codex_app_server_version_unsupported'

  constructor(
    readonly expected: readonly string[],
    readonly actual: string | undefined
  ) {
    super(
      actual
        ? `Unsupported Codex App Server version ${actual}.`
        : 'Codex App Server version could not be verified.'
    )
    this.name = 'CodexAppServerVersionUnsupportedError'
  }

  toRendererSafeError(): {
    code: string
    expected: readonly string[]
    actual?: string
    source: 'launch-probe'
  } {
    return {
      code: this.code,
      expected: this.expected,
      ...(this.actual ? { actual: this.actual } : {}),
      source: 'launch-probe'
    }
  }
}

export async function verifyCodexAppServerVersion(
  launch: CodexAppServerLaunchOptions,
  probe: (launch: CodexAppServerLaunchOptions) => Promise<string> = probeLaunchExecutableVersion
): Promise<string> {
  const output = await probe(launch)
  const parser = new RegExp(protocolManifest.runtimeVersionParser.pattern)
  const match = parser.exec(output.trim())
  const actual = match?.groups?.[protocolManifest.runtimeVersionParser.capture]
  const supported = protocolManifest.supportedAppServerVersions
  if (!actual || !supported.includes(actual)) {
    throw new CodexAppServerVersionUnsupportedError(supported, actual)
  }
  return actual
}

export function probeLaunchExecutableVersion(launch: CodexAppServerLaunchOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, ['--version'], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (output.length < 4096) output += chunk.slice(0, 4096 - output.length)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(
          new CodexAppServerVersionUnsupportedError(
            protocolManifest.supportedAppServerVersions,
            undefined
          )
        )
        return
      }
      resolve(output)
    })
  })
}
