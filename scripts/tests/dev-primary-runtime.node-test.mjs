import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  parseGitHubRepository,
  parsePrimaryRuntimeDevelopmentOptions,
  requiredStagingArtifactNames,
  retryPrimaryRuntimeArtifactDownload,
  selectRequiredStagingArtifacts,
  selectSuccessfulRuntimeRun
} from '../dev-primary-runtime.mjs'

const appRoot = resolve(import.meta.dirname, '../../desktop-app')

test('one-command Runtime launcher is registered separately from ordinary development', async () => {
  const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageJson.scripts.dev, 'electron-vite dev')
  assert.equal(
    packageJson.scripts['dev:primary-runtime'],
    'node ../scripts/dev-primary-runtime.mjs'
  )
})

test('one-command Runtime launcher accepts only its explicit local options', () => {
  const options = parsePrimaryRuntimeDevelopmentOptions([], {})
  assert.equal(options.port, 9443)
  assert.equal(options.sourceRunId, undefined)
  assert.equal(options.cacheRoot, resolve(appRoot, '.primary-runtime-dev-cache'))

  assert.deepEqual(
    parsePrimaryRuntimeDevelopmentOptions(
      ['--source-run', '123', '--cache-dir', '/private/tmp/runtime-cache', '--port', '12443'],
      {}
    ),
    {
      sourceRunId: 123,
      cacheRoot: '/private/tmp/runtime-cache',
      port: 12443
    }
  )
  assert.throws(() => parsePrimaryRuntimeDevelopmentOptions(['--source-run', '0'], {}), /positive/u)
  assert.throws(() => parsePrimaryRuntimeDevelopmentOptions(['--port', '0'], {}), /invalid/u)
  assert.throws(
    () => parsePrimaryRuntimeDevelopmentOptions(['--cache-dir', 'relative-cache'], {}),
    /absolute/u
  )
  assert.throws(
    () => parsePrimaryRuntimeDevelopmentOptions(['--unrelated', 'value'], {}),
    /Expected/u
  )
})

test('one-command Runtime launcher resolves only a GitHub origin', () => {
  assert.equal(
    parseGitHubRepository('https://github.com/example/dasCowork.git'),
    'example/dasCowork'
  )
  assert.equal(parseGitHubRepository('git@github.com:example/dasCowork.git'), 'example/dasCowork')
  assert.throws(
    () => parseGitHubRepository('https://gitlab.com/example/dasCowork.git'),
    /github\.com/u
  )
})

test('one-command Runtime launcher selects the newest successful run for the current commit', () => {
  const selected = selectSuccessfulRuntimeRun(
    [
      {
        databaseId: 2,
        conclusion: 'success',
        headSha: 'current',
        createdAt: '2026-09-18T01:00:00Z'
      },
      {
        databaseId: 1,
        conclusion: 'success',
        headSha: 'current',
        createdAt: '2026-09-17T01:00:00Z'
      },
      {
        databaseId: 3,
        conclusion: 'failure',
        headSha: 'current',
        createdAt: '2026-09-18T02:00:00Z'
      },
      {
        databaseId: 4,
        conclusion: 'success',
        headSha: 'another-commit',
        createdAt: '2026-09-18T03:00:00Z'
      }
    ],
    'current'
  )
  assert.equal(selected.databaseId, 2)
  assert.throws(() => selectSuccessfulRuntimeRun([], 'current'), /No successful/u)
})

test('one-command Runtime launcher requires every unexpired target staging artifact', () => {
  const expected = requiredStagingArtifactNames()
  const artifacts = Object.values(expected).map((name) => ({ name, expired: false }))
  assert.deepEqual(
    Object.keys(selectRequiredStagingArtifacts(artifacts)).sort(),
    Object.keys(expected).sort()
  )
  assert.throws(
    () =>
      selectRequiredStagingArtifacts(
        artifacts.map((artifact) =>
          artifact.name === expected['linux-x64'] ? { ...artifact, expired: true } : artifact
        )
      ),
    /linux-x64/u
  )
})

test('one-command Runtime launcher retries interrupted artifact downloads with bounded backoff', async () => {
  let calls = 0
  const delays = []
  const result = await retryPrimaryRuntimeArtifactDownload({
    artifactName: 'primary-runtime-darwin-arm64-staging',
    operation: async () => {
      calls += 1
      if (calls < 3) throw new Error('unexpected EOF')
      return 'downloaded'
    },
    sleep: async (milliseconds) => delays.push(milliseconds),
    log: () => undefined
  })
  assert.equal(result, 'downloaded')
  assert.equal(calls, 3)
  assert.deepEqual(delays, [1_000, 2_000])

  await assert.rejects(
    retryPrimaryRuntimeArtifactDownload({
      artifactName: 'primary-runtime-darwin-arm64-staging',
      attempts: 2,
      operation: async () => {
        throw new Error('unexpected EOF')
      },
      sleep: async () => undefined,
      log: () => undefined
    }),
    /after 2 attempts/u
  )
})
