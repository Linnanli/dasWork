import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')

run('npm', ['run', 'build'])
run('npm', ['run', 'verify:pdf-worker-bundle'])
run('npm', ['run', 'verify:pptx-worker-bundle'])
run('npm', ['run', 'verify:review-diff-worker-bundle'])
run('npx', ['electron-builder', '--dir'])

const executable = packagedExecutable(join(appRoot, 'dist'))
if (!executable || !existsSync(executable)) {
  throw new Error(`Could not find packaged executable for ${process.platform}/${process.arch}`)
}

run(
  'npx',
  ['playwright', 'test', 'tests/e2e/packaged-local-media-smoke.e2e.ts', '--reporter=line'],
  {
    DASCOWORK_PACKAGED_APP_EXECUTABLE: executable
  }
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function run(command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  delete env.CODEX_APP_SERVER_BIN
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    stdio: 'inherit'
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
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
