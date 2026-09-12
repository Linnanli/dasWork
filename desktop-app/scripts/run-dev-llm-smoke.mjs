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
  requirePrimaryRuntimeProductConfig()
  if (!process.env.DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH?.trim()) {
    throw new Error('DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH is required for dev R07.')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function requirePrimaryRuntimeProductConfig() {
  const required = [
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL',
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS',
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS',
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL',
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON',
    'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON'
  ]
  const missing = required.filter((name) => !process.env[name]?.trim())
  if (missing.length > 0) {
    throw new Error(
      `Signed Primary Runtime product config is required for dev R07: ${missing.join(', ')}`
    )
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
