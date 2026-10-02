import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const expectedVersion = packageJson.devDependencies['@openai/codex']
const codexPackage = JSON.parse(
  await readFile(new URL('../node_modules/@openai/codex/package.json', import.meta.url), 'utf8')
)
const codexEntrypoint = resolve(appRoot, 'node_modules/@openai/codex/bin/codex.js')
if (codexPackage.version !== expectedVersion) {
  throw new Error(
    `Expected installed Codex CLI ${expectedVersion}, received ${codexPackage.version}`
  )
}
const result = spawnSync(process.execPath, [codexEntrypoint, '--version'], {
  cwd: appRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
})

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(
    `Locked Codex CLI exited with ${result.status ?? 'an unknown status'}: ${result.stderr.trim()}`
  )
}
const versionOutput = result.stdout.trim()
const reportedVersion = versionOutput.split(/\s+/u).at(-1)
if (reportedVersion !== expectedVersion) {
  throw new Error(`Expected Codex CLI ${expectedVersion}, received: ${versionOutput}`)
}
console.log(versionOutput)
