import { describe, expect, it } from 'vitest'

import {
  CodexAppServerVersionUnsupportedError,
  verifyCodexAppServerVersion
} from './codexAppServerVersionPolicy'

const launch = {
  command: '/test/codex',
  args: ['app-server', '--listen', 'stdio://'],
  displayBinary: '/test/codex app-server --listen stdio://'
}

describe('verifyCodexAppServerVersion', () => {
  it('accepts the manifest-pinned launch executable version', async () => {
    await expect(
      verifyCodexAppServerVersion(launch, async () => 'codex-cli 0.148.0-alpha.21\n')
    ).resolves.toBe('0.148.0-alpha.21')
  })

  it.each(['codex-cli 0.147.0', 'codex-cli 999.0.0', 'unexpected version output'])(
    'rejects missing or unsupported launch evidence: %s',
    async (output) => {
      await expect(verifyCodexAppServerVersion(launch, async () => output)).rejects.toMatchObject({
        code: 'codex_app_server_version_unsupported'
      } satisfies Partial<CodexAppServerVersionUnsupportedError>)
    }
  )

  it('returns a renderer-safe unsupported-version payload without executable details', () => {
    expect(
      new CodexAppServerVersionUnsupportedError(
        ['0.148.0-alpha.21'],
        '0.147.0'
      ).toRendererSafeError()
    ).toEqual({
      code: 'codex_app_server_version_unsupported',
      expected: ['0.148.0-alpha.21'],
      actual: '0.147.0',
      source: 'launch-probe'
    })
  })
})
