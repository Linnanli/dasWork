#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- This E2E runner is covered by its Node contract test. */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  PACKAGED_PRODUCT_CONFIG_FILE,
  engineeringTestPackagedProductConfigFromEnvironment,
  writePackagedProductConfig
} from './write-primary-runtime-product-config.mjs'
import {
  primaryRuntimeFeedChildEnvironment,
  resolvePrimaryRuntimeFeedDevelopmentConfiguration,
  startPrimaryRuntimeFeed
} from './dev-with-primary-runtime-feed.mjs'
import { requirePrimaryRuntimeFeedE2eEnvironment } from './run-primary-runtime-feed-e2e.mjs'

const appRoot = resolve(import.meta.dirname, '..')

process.exitCode = await main()

async function main() {
  requirePrimaryRuntimeFeedE2eEnvironment()

  const configuration = resolvePrimaryRuntimeFeedDevelopmentConfiguration()
  const environment = primaryRuntimeFeedChildEnvironment(configuration, {
    ...process.env,
    DASCOWORK_PRIMARY_RUNTIME_FEED_E2E: '1'
  })
  const originalProductConfig = await readFile(PACKAGED_PRODUCT_CONFIG_FILE)
  const server = await startPrimaryRuntimeFeed(configuration)
  try {
    await writePackagedProductConfig(
      engineeringTestPackagedProductConfigFromEnvironment(environment)
    )
    const packageStatus = await run('npm', ['run', 'build:unpack'], environment)
    if (packageStatus !== 0) return packageStatus

    const executable = await packagedExecutable(join(appRoot, 'dist'))
    if (!executable) {
      throw new Error(
        `Could not find a packaged application for ${process.platform}/${process.arch}.`
      )
    }
    return await run(
      'npx',
      ['playwright', 'test', 'tests/e2e/primary-runtime-feed.e2e.ts', '--reporter=line'],
      {
        ...environment,
        DASCOWORK_PRIMARY_RUNTIME_PACKAGED_APP_EXECUTABLE: executable
      }
    )
  } finally {
    await writeFile(PACKAGED_PRODUCT_CONFIG_FILE, originalProductConfig, { mode: 0o600 })
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  }
}

function run(command, args, environment) {
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

async function packagedExecutable(distRoot) {
  if (process.platform === 'win32') return join(distRoot, 'win-unpacked', 'desktop-app.exe')
  if (process.platform === 'linux') return join(distRoot, 'linux-unpacked', 'desktop-app')

  const macDirectory = (await readdir(distRoot, { withFileTypes: true }))
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
