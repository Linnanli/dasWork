import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const playwrightArgs = process.argv.slice(2)

process.exitCode = await main()

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function main() {
  requireReleaseEnvironment()
  if (playwrightArgs.length > 0) {
    throw new Error('The release LLM gate always runs the complete R01-R06 suite without filters.')
  }

  const buildStatus = run('npm', ['run', 'build:unpack'])
  if (buildStatus !== 0) return buildStatus

  const executable = packagedExecutable(join(appRoot, 'dist'))
  if (!executable || !existsSync(executable)) {
    throw new Error(`Could not find packaged executable for ${process.platform}/${process.arch}`)
  }

  const releaseEnvironment = {
    DASCOWORK_RELEASE_PACKAGED_APP_EXECUTABLE: executable
  }
  const firstAttemptStatus = runReleaseSuite(1, releaseEnvironment)
  if (firstAttemptStatus === 0) return 0

  // An operator may classify the first failure as an external-service outage.
  // The retry is deliberately whole-suite and capped at one, so R01-R06 cannot
  // become green through per-test retries or an unbounded retry loop.
  if (process.env.DASCOWORK_RELEASE_EXTERNAL_RETRY !== '1') return firstAttemptStatus

  console.error(
    'Release LLM suite failed after an externally classified outage; rerunning the complete R01-R06 suite once.'
  )
  return runReleaseSuite(2, releaseEnvironment)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function requireReleaseEnvironment() {
  if (process.env.DASCOWORK_RELEASE_LLM_SMOKE !== '1') {
    throw new Error('Set DASCOWORK_RELEASE_LLM_SMOKE=1 to run the release LLM smoke test.')
  }
  if (!process.env.DASCOWORK_RELEASE_ADMIN_BACKEND_URL?.trim()) {
    throw new Error('DASCOWORK_RELEASE_ADMIN_BACKEND_URL is required.')
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function runReleaseSuite(attempt, extraEnv) {
  return run(
    'npx',
    [
      'playwright',
      'test',
      'tests/e2e/release-llm.e2e.ts',
      '--reporter=line',
      `--output=test-results/release-llm-attempt-${attempt}`
    ],
    extraEnv
  )
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  // The release gate must prove that the packaged app starts the Codex CLI
  // from PATH instead of inheriting a developer test override.
  delete env.CODEX_APP_SERVER_BIN
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    stdio: 'inherit'
  })
  return result.status ?? 1
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function packagedExecutable(distRoot) {
  if (process.platform === 'win32') return join(distRoot, 'win-unpacked', 'desktop-app.exe')
  if (process.platform === 'linux') return join(distRoot, 'linux-unpacked', 'desktop-app')

  const macDirectory = readdirSync(distRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const preferred = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
      return Number(right === preferred) - Number(left === preferred)
    })[0]
  return macDirectory
    ? join(distRoot, macDirectory, 'desktop-app.app', 'Contents', 'MacOS', 'desktop-app')
    : undefined
}
