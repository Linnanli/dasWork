import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')

requireDevelopmentEnvironment()
run('npm', ['run', 'build'])
run('npx', ['playwright', 'test', 'tests/e2e/release-llm.e2e.ts', '--reporter=line'], {
  DASCOWORK_REAL_LLM_RUNTIME: 'development'
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function requireDevelopmentEnvironment() {
  if (process.env.DASCOWORK_DEV_LLM_SMOKE !== '1') {
    throw new Error('Set DASCOWORK_DEV_LLM_SMOKE=1 to run the development LLM smoke test.')
  }
  if (!process.env.DASCOWORK_DEV_ADMIN_BACKEND_URL?.trim()) {
    throw new Error('DASCOWORK_DEV_ADMIN_BACKEND_URL is required.')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  // This checks the normal Codex CLI launch path, not a test-only executable override.
  delete env.CODEX_APP_SERVER_BIN
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    stdio: 'inherit'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
