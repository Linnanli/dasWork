import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  createSyntheticFeedFixture,
  requirePrimaryRuntimeSyntheticFeedE2eEnvironment
} from '../run-primary-runtime-synthetic-feed-e2e.mjs'
import { validateReleaseTree } from '../../../services/primary-runtime-feed/src/repository.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const packageJsonPath = resolve(appRoot, 'package.json')
const playwrightConfigPath = resolve(appRoot, 'playwright.config.ts')
const e2ePath = resolve(appRoot, 'tests/e2e/primary-runtime-synthetic-feed.e2e.ts')
const runnerPath = resolve(appRoot, 'scripts/run-primary-runtime-synthetic-feed-e2e.mjs')

test('synthetic Feed E2E requires an explicit test-only opt-in', () => {
  assert.throws(
    () => requirePrimaryRuntimeSyntheticFeedE2eEnvironment({}),
    /DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E=1/u
  )
  assert.doesNotThrow(() =>
    requirePrimaryRuntimeSyntheticFeedE2eEnvironment({
      DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E: '1'
    })
  )
})

test('synthetic Feed fixture has a signed complete matrix and uses no real package inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dascowork-synthetic-feed-contract-'))
  try {
    const fixture = await createSyntheticFeedFixture(root, { host: '127.0.0.1', port: 9444 })
    const control = JSON.parse(await readFile(fixture.controlPath, 'utf8'))
    assert.equal(control.repositoryRoot, fixture.repositoryRoot)
    assert.match(control.bundleVersions.v1, /^0\.0\.0-synthetic\.1\+/u)
    assert.match(control.bundleVersions.v2, /^0\.0\.0-synthetic\.2\+/u)
    assert.match(control.archiveUrls.v1, /\/v1\/runtime\/archives\/0\.0\.0-synthetic\.1\//u)
    assert.equal(control.metadataSnapshots.v2Refresh.config.sequence, 3)
    assert.equal(control.metadataSnapshots.v2Refresh.manifest.sequence, 3)
    assert.equal(control.metadataSnapshots.v1Return.config.sequence, 4)
    assert.equal(control.metadataSnapshots.v1Return.manifest.sequence, 4)
    assert.equal(
      control.metadataSnapshots.v2Refresh.manifest.releases[0].version,
      '0.0.0-synthetic.2'
    )
    assert.equal(
      control.metadataSnapshots.v1Return.manifest.releases[0].version,
      '0.0.0-synthetic.1'
    )
    for (const stagedRoot of [control.staged.v1, control.staged.v2]) {
      await assert.doesNotReject(() =>
        validateReleaseTree(stagedRoot, {
          configPublicKeys: JSON.parse(fixture.configPublicKeys),
          manifestPublicKeys: JSON.parse(fixture.manifestPublicKeys),
          allowSyntheticTestOnly: true
        })
      )
    }
    await assert.rejects(
      validateReleaseTree(fixture.stagedRoot, {
        configPublicKeys: JSON.parse(fixture.configPublicKeys),
        manifestPublicKeys: JSON.parse(fixture.manifestPublicKeys)
      }),
      /synthetic and cannot enter engineering staging/u
    )
    const sourceLock = await readFile(fixture.sourceLockPath, 'utf8')
    assert.match(sourceLock, /@dascowork\/test-artifact-tool/u)
    assert.doesNotMatch(sourceLock, /@oai\/artifact-tool|openai-primary-runtime-plugins/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('synthetic Feed E2E stays in a separate test-only runner and cannot use direct Runtime overrides', async () => {
  const [packageJsonSource, playwrightConfig, e2eSource, runnerSource] = await Promise.all([
    readFile(packageJsonPath, 'utf8'),
    readFile(playwrightConfigPath, 'utf8'),
    readFile(e2ePath, 'utf8'),
    readFile(runnerPath, 'utf8')
  ])
  const packageJson = JSON.parse(packageJsonSource)

  assert.equal(
    packageJson.scripts['test:e2e:primary-runtime-synthetic-feed'],
    'node scripts/run-primary-runtime-synthetic-feed-e2e.mjs'
  )
  assert.match(playwrightConfig, /DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_E2E/u)
  assert.match(runnerSource, /buildSyntheticRuntime/u)
  assert.match(runnerSource, /publishDevelopmentRepositorySnapshot/u)
  assert.match(runnerSource, /createDevelopmentPrimaryRuntimeFeedServer/u)
  assert.match(runnerSource, /primaryRuntimeFeedChildEnvironment/u)
  assert.match(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_CONTROL_PATH/u)
  assert.match(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL/u)
  assert.match(e2eSource, /AT-E2E-SYNTHETIC-01/u)
  assert.match(e2eSource, /runPrimaryRuntimeUpdate/u)
  assert.match(e2eSource, /publishDevelopmentRepositorySnapshot/u)
  assert.match(e2eSource, /publishDevelopmentMetadataSnapshot/u)
  assert.match(e2eSource, /runtimeInstallMarker/u)
  assert.match(e2eSource, /@dascowork\/test-artifact-tool/u)
  assert.doesNotMatch(e2eSource, /@oai\/artifact-tool/u)
  assert.doesNotMatch(e2eSource, /test\.skip/u)
})
