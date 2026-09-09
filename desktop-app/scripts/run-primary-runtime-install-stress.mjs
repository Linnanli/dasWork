#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const required = [
  'DASCOWORK_PRIMARY_RUNTIME_STRESS_ARCHIVE',
  'DASCOWORK_PRIMARY_RUNTIME_STRESS_VERSION',
  'DASCOWORK_PRIMARY_RUNTIME_STRESS_SHA256'
]
for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required for the Primary Runtime install stress gate.`)
  }
}

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'src/main/primaryRuntime/PrimaryRuntimeInstallStress.test.ts'],
  {
    cwd: appRoot,
    env: { ...process.env, DASCOWORK_PRIMARY_RUNTIME_STRESS: '1' },
    stdio: 'inherit'
  }
)
process.exit(result.status ?? 1)
