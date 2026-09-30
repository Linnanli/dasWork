export type CodexAppServerLaunchOptions = {
  command: string
  args: string[]
  cwd?: string
  displayBinary: string
  env?: NodeJS.ProcessEnv
}

export type CodexAppServerLaunchOptionsInput = {
  env?: NodeJS.ProcessEnv
  modelCatalogPath?: string
}

const SERVER_ARGS = ['--listen', 'stdio://']
const CODEX_CLI_ARGS = ['app-server', ...SERVER_ARGS]

export function resolveCodexAppServerLaunchOptions(
  options: CodexAppServerLaunchOptionsInput = {}
): CodexAppServerLaunchOptions {
  const env = options.env ?? process.env
  const catalogArgs = options.modelCatalogPath
    ? ['-c', `model_catalog_json=${JSON.stringify(options.modelCatalogPath)}`]
    : []
  const explicitBinary = env.CODEX_APP_SERVER_BIN
  if (explicitBinary) {
    return {
      command: explicitBinary,
      args: [...SERVER_ARGS],
      displayBinary: `${explicitBinary} ${SERVER_ARGS.join(' ')}`,
      env
    }
  }

  const args = [...catalogArgs, ...CODEX_CLI_ARGS]

  return {
    command: 'codex',
    args,
    displayBinary: `codex ${args.join(' ')}`,
    env
  }
}
