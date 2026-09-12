#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executable environment validation is covered by its Node contract test. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'

import {
  primaryRuntimeFeedChildEnvironment,
  resolvePrimaryRuntimeFeedDevelopmentConfiguration,
  startPrimaryRuntimeFeed
} from './dev-with-primary-runtime-feed.mjs'

const appRoot = resolve(import.meta.dirname, '..')

if (resolve(process.argv[1] ?? '') === new URL(import.meta.url).pathname) {
  process.exitCode = await main()
}

export function requirePrimaryRuntimeFeedE2eEnvironment(env = process.env) {
  if (env.DASCOWORK_PRIMARY_RUNTIME_FEED_E2E !== '1') {
    throw new Error(
      'Set DASCOWORK_PRIMARY_RUNTIME_FEED_E2E=1 to run the signed Primary Runtime Feed E2E gate.'
    )
  }
}

async function main() {
  requirePrimaryRuntimeFeedE2eEnvironment()

  const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration()
  const server = await startPrimaryRuntimeFeed(configuration)
  try {
    const buildStatus = await run('npm', ['run', 'build'])
    if (buildStatus !== 0) return buildStatus
    return await run(
      'npx',
      ['playwright', 'test', 'tests/e2e/primary-runtime-feed.e2e.ts', '--reporter=line'],
      primaryRuntimeFeedChildEnvironment(configuration, {
        ...process.env,
        DASCOWORK_PRIMARY_RUNTIME_FEED_E2E: '1'
      })
    )
  } finally {
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  }
}

function run(command, args, extraEnv = {}) {
  const environment = { ...extraEnv }
  // The real app-server executable is the only supported runtime for this
  // gate. A test-only JSON-RPC stand-in would invalidate the result.
  delete environment.CODEX_APP_SERVER_BIN
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, {
      cwd: appRoot,
      env: environment,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}
