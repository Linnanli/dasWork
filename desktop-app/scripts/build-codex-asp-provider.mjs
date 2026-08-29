import { cpSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const providerRoot = resolve(desktopRoot, 'vendors', 'ai-sdk-provider-codex-asp')
const providerDist = resolve(providerRoot, 'dist')
const installedProviderRoot = resolve(
  desktopRoot,
  'node_modules',
  '@janole',
  'ai-sdk-provider-codex-asp'
)
const codexCommand = process.platform === 'win32' ? 'codex.cmd' : 'codex'
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const generateTypes = spawnSync(
  codexCommand,
  ['app-server', 'generate-ts', '--experimental', '-o', 'src/protocol/app-server-protocol'],
  {
    cwd: providerRoot,
    stdio: 'inherit'
  }
)

if (generateTypes.error) throw generateTypes.error
if (generateTypes.status !== 0) process.exit(generateTypes.status ?? 1)

const build = spawnSync(npmCommand, ['run', 'build'], {
  cwd: providerRoot,
  stdio: 'inherit'
})

if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
if (!existsSync(providerDist)) {
  throw new Error('Codex ASP provider build did not produce dist/.')
}
if (!existsSync(installedProviderRoot)) {
  throw new Error('Codex ASP provider is not installed. Run the desktop dependency install first.')
}

const sourceRoot = realpathSync(providerRoot)
const installedRoot = realpathSync(installedProviderRoot)

if (sourceRoot === installedRoot) {
  console.log('Built Codex ASP provider.')
  process.exit(0)
}

const installedDist = resolve(installedRoot, 'dist')
rmSync(installedDist, { recursive: true, force: true })
cpSync(providerDist, installedDist, { recursive: true })

console.log('Built and synchronized Codex ASP provider.')
