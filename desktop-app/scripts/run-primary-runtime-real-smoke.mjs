#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = process.env.DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT?.trim()
if (!runtimeRoot) {
  throw new Error('DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT is required for the real Runtime gate.')
}

const result = spawnSync(
  'npm',
  ['exec', '--', 'vitest', 'run', 'src/main/primaryRuntime/PrimaryRuntimeRealSmoke.test.ts'],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      DASCOWORK_REAL_PRIMARY_RUNTIME_SMOKE: '1',
      DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT: runtimeRoot
    },
    stdio: 'inherit'
  }
)

process.exit(result.status ?? 1)
