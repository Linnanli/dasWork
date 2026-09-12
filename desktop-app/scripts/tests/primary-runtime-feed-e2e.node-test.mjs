import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import { requirePrimaryRuntimeFeedE2eEnvironment } from '../run-primary-runtime-feed-e2e.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const packageJsonPath = resolve(appRoot, 'package.json')
const playwrightConfigPath = resolve(appRoot, 'playwright.config.ts')
const e2ePath = resolve(appRoot, 'tests/e2e/primary-runtime-feed.e2e.ts')
const runnerPath = resolve(appRoot, 'scripts/run-primary-runtime-feed-e2e.mjs')
const presentationSmokePath = resolve(appRoot, 'scripts/run-presentations-runtime-smoke.mjs')

test('signed Feed E2E requires an explicit real-Runtime opt-in', () => {
  assert.throws(
    () => requirePrimaryRuntimeFeedE2eEnvironment({}),
    /DASCOWORK_PRIMARY_RUNTIME_FEED_E2E=1/u
  )
  assert.doesNotThrow(() =>
    requirePrimaryRuntimeFeedE2eEnvironment({ DASCOWORK_PRIMARY_RUNTIME_FEED_E2E: '1' })
  )
})

test('signed Feed E2E stays outside fixture tests and runs only through its dedicated runner', async () => {
  const [packageJsonSource, playwrightConfig, e2eSource, runnerSource, presentationSmokeSource] =
    await Promise.all([
    readFile(packageJsonPath, 'utf8'),
    readFile(playwrightConfigPath, 'utf8'),
    readFile(e2ePath, 'utf8'),
    readFile(runnerPath, 'utf8'),
    readFile(presentationSmokePath, 'utf8')
  ])
  const packageJson = JSON.parse(packageJsonSource)

  assert.equal(
    packageJson.scripts['test:e2e:primary-runtime-feed'],
    'node scripts/run-primary-runtime-feed-e2e.mjs'
  )
  assert.equal(
    packageJson.scripts['smoke:presentation-skill-runtime'],
    'node scripts/run-presentations-runtime-smoke.mjs'
  )
  assert.match(playwrightConfig, /DASCOWORK_PRIMARY_RUNTIME_FEED_E2E/u)
  assert.match(playwrightConfig, /primary-runtime-feed\.e2e\.ts/u)
  assert.match(runnerSource, /startPrimaryRuntimeFeed/u)
  assert.match(runnerSource, /primaryRuntimeFeedChildEnvironment/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL/u)
  assert.doesNotMatch(e2eSource, /createRuntimeFixture/u)
  assert.doesNotMatch(e2eSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(e2eSource, /test\.skip/u)
  assert.match(e2eSource, /AT-E2E-01/u)
  assert.match(e2eSource, /load_workspace_dependencies/u)
  assert.doesNotMatch(e2eSource, /@oai\/artifact-tool/u)
  assert.match(e2eSource, /pptxgenjs/u)
  assert.match(e2eSource, /runtimePresentationCommandResponse/u)
  assert.match(presentationSmokeSource, /run-primary-runtime-feed-e2e\.mjs/u)
  assert.doesNotMatch(presentationSmokeSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(presentationSmokeSource, /spawnSync/u)
})
