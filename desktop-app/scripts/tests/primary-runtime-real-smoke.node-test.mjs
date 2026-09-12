import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const executeFile = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const runnerPath = resolve(repositoryRoot, 'desktop-app/scripts/run-primary-runtime-real-smoke.mjs')

test('real Runtime smoke accepts only a P1a archive identity, never a direct Runtime root', async () => {
  await assert.rejects(
    () => executeFile(process.execPath, [runnerPath], { cwd: repositoryRoot }),
    /Expected --archive, --version, and --sha256/u
  )
  await assert.rejects(
    () =>
      executeFile(process.execPath, [runnerPath], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT: '/tmp/forbidden-runtime-root'
        }
      }),
    /accepts a P1a archive/u
  )
})
