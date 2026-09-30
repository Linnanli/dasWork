import { describe, expect, it } from 'vitest'

import { resolveCodexAppServerLaunchOptions } from './codexAppServerLaunch'

describe('codex app-server launch resolution', () => {
  it('uses the Codex CLI from PATH by default', () => {
    expect(resolveCodexAppServerLaunchOptions({ env: {} })).toEqual({
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      displayBinary: 'codex app-server --listen stdio://',
      env: {}
    })
  })

  it('uses CODEX_APP_SERVER_BIN override with stdio listener args', () => {
    expect(
      resolveCodexAppServerLaunchOptions({
        env: { CODEX_APP_SERVER_BIN: '/custom/codex-app-server' }
      })
    ).toEqual({
      command: '/custom/codex-app-server',
      args: ['--listen', 'stdio://'],
      displayBinary: '/custom/codex-app-server --listen stdio://',
      env: { CODEX_APP_SERVER_BIN: '/custom/codex-app-server' }
    })
  })

  it('passes the local model catalog path as a Codex CLI config override', () => {
    expect(
      resolveCodexAppServerLaunchOptions({
        env: {},
        modelCatalogPath: '/tmp/dascowork/local-models.json'
      })
    ).toEqual({
      command: 'codex',
      args: [
        '-c',
        'model_catalog_json="/tmp/dascowork/local-models.json"',
        'app-server',
        '--listen',
        'stdio://'
      ],
      displayBinary:
        'codex -c model_catalog_json="/tmp/dascowork/local-models.json" app-server --listen stdio://',
      env: {}
    })
  })

  it('keeps CODEX_APP_SERVER_BIN independent from Codex CLI catalog flags', () => {
    expect(
      resolveCodexAppServerLaunchOptions({
        env: { CODEX_APP_SERVER_BIN: '/custom/codex-app-server' },
        modelCatalogPath: '/tmp/dascowork/local-models.json'
      })
    ).toEqual({
      command: '/custom/codex-app-server',
      args: ['--listen', 'stdio://'],
      displayBinary: '/custom/codex-app-server --listen stdio://',
      env: { CODEX_APP_SERVER_BIN: '/custom/codex-app-server' }
    })
  })
})
