import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { requirePrimaryRuntimeFeedE2eEnvironment } from '../run-primary-runtime-feed-e2e.mjs'
import { writePackagedAppAssetReceipt } from '../packaged-app-assets.mjs'

const appRoot = resolve(import.meta.dirname, '../..')
const packageJsonPath = resolve(appRoot, 'package.json')
const playwrightConfigPath = resolve(appRoot, 'playwright.config.ts')
const e2ePath = resolve(appRoot, 'tests/e2e/primary-runtime-feed.e2e.ts')
const r07SupportPath = resolve(appRoot, 'tests/e2e/support/r07Presentation.ts')
const runnerPath = resolve(appRoot, 'scripts/run-primary-runtime-feed-e2e.mjs')
const packagedRunnerPath = resolve(appRoot, 'scripts/run-primary-runtime-packaged-feed-e2e.mjs')
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
  const [
    packageJsonSource,
    playwrightConfig,
    e2eSource,
    r07SupportSource,
    runnerSource,
    packagedRunnerSource,
    presentationSmokeSource
  ] = await Promise.all([
    readFile(packageJsonPath, 'utf8'),
    readFile(playwrightConfigPath, 'utf8'),
    readFile(e2ePath, 'utf8'),
    readFile(r07SupportPath, 'utf8'),
    readFile(runnerPath, 'utf8'),
    readFile(packagedRunnerPath, 'utf8'),
    readFile(presentationSmokePath, 'utf8')
  ])
  const packageJson = JSON.parse(packageJsonSource)

  assert.equal(
    packageJson.scripts['test:e2e:primary-runtime-feed'],
    'node scripts/run-primary-runtime-feed-e2e.mjs'
  )
  assert.equal(
    packageJson.scripts['test:e2e:primary-runtime-feed:packaged'],
    'node scripts/run-primary-runtime-packaged-feed-e2e.mjs'
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
  assert.match(packagedRunnerSource, /packagedProductConfigFromEnvironment/u)
  assert.match(packagedRunnerSource, /DASCOWORK_PRIMARY_RUNTIME_PACKAGED_E2E_LOCAL_CA_PATH/u)
  assert.doesNotMatch(packagedRunnerSource, /engineeringTestLocalCaPath/u)
  assert.match(packagedRunnerSource, /build:unpack/u)
  assert.match(packagedRunnerSource, /DASCOWORK_PRIMARY_RUNTIME_PACKAGED_APP_EXECUTABLE/u)
  assert.match(packagedRunnerSource, /DASCOWORK_PRIMARY_RUNTIME_PACKAGED_ASSET_RECEIPT/u)
  assert.match(packagedRunnerSource, /writePackagedAppAssetReceipt/u)
  assert.doesNotMatch(packagedRunnerSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(packagedRunnerSource, /DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL/u)
  assert.doesNotMatch(e2eSource, /createRuntimeFixture/u)
  assert.doesNotMatch(e2eSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(e2eSource, /test\.skip/u)
  assert.match(e2eSource, /AT-E2E-01/u)
  assert.match(e2eSource, /load_workspace_dependencies/u)
  assert.doesNotMatch(e2eSource, /@oai\/artifact-tool/u)
  assert.doesNotMatch(e2eSource, /import pptxgen/u)
  assert.match(e2eSource, /build_deck_pptxgenjs\.js/u)
  assert.match(e2eSource, /layout_lint\.py/u)
  assert.match(e2eSource, /render_slides\.py/u)
  assert.match(e2eSource, /verifyR07Presentation/u)
  assert.match(e2eSource, /openR07PresentationInWorkspace/u)
  assert.match(e2eSource, /cwd: workspace\.root/u)
  assert.match(e2eSource, /args: \[appRoot\]/u)
  assert.match(e2eSource, /launchTimeoutMs: 90_000/u)
  assert.match(e2eSource, /contactSheetFile/u)
  assert.match(e2eSource, /runtimePresentationCommandResponse/u)
  assert.match(e2eSource, /getSkillContents/u)
  assert.match(e2eSource, /runtimePresentationSkillContractFromContents/u)
  assert.match(e2eSource, /runtimePresentationSkillSuffix/u)
  const skillLookupStart = e2eSource.indexOf('async function expectRuntimePresentationSkill')
  const skillLookupEnd = e2eSource.indexOf('function runtimePresentationCommandResponse')
  assert.ok(skillLookupStart >= 0 && skillLookupEnd > skillLookupStart)
  const skillLookupSource = e2eSource.slice(skillLookupStart, skillLookupEnd)
  assert.match(skillLookupSource, /page\.evaluate\(async \(skillSuffix\) =>/u)
  assert.match(skillLookupSource, /\.endsWith\(skillSuffix\)/u)
  assert.ok(skillLookupSource.includes('}, runtimePresentationSkillSuffix)'))
  assert.doesNotMatch(skillLookupSource, /\.endsWith\(runtimePresentationSkillSuffix\)/u)
  assert.match(e2eSource, /instructionsSha256/u)
  assert.match(e2eSource, /DASCOWORK_APP_TOOLS_LIVE_TRACE_REPORT/u)
  assert.match(e2eSource, /parseR07AppServerTrace/u)
  assert.match(e2eSource, /workspace\.artifacts\.onEvent/u)
  assert.match(e2eSource, /workspace\.artifacts\.readBinary/u)
  assert.match(e2eSource, /workspacePresentationSha256/u)
  assert.match(e2eSource, /triggerArtifactPreviewChangeRoundTrip/u)
  assert.match(e2eSource, /utimes\(path, now, now\)/u)
  assert.doesNotMatch(
    e2eSource,
    /writeFile\(presentationPath,\s*await readFile\(presentationPath\)\)/u
  )
  assert.match(e2eSource, /data-workspace-tab-id/u)
  assert.match(e2eSource, /dascowork-primary-runtime-r07-live-trace\.v1/u)
  assert.match(e2eSource, /renderQaReceipt/u)
  assert.match(
    e2eSource,
    /renderReportSha256\s*=\s*sha256Text\(JSON\.stringify\(input\.renderQaReceipt\)\)/u
  )
  assert.match(r07SupportSource, /dascowork-r07-render-qa\.v1/u)
  assert.match(r07SupportSource, /nonWhiteRatio/u)
  assert.match(r07SupportSource, /colorBucketCount/u)
  assert.doesNotMatch(e2eSource, /join\(process\.env\.CODEX_HOME/u)
  assert.doesNotMatch(e2eSource, /readFileSync\(join\(skillRoot, 'SKILL\.md'\)/u)
  assert.match(e2eSource, /DASCOWORK_PRIMARY_RUNTIME_PACKAGED_APP_EXECUTABLE/u)
  assert.match(e2eSource, /Buffer\.from\(source, 'utf8'\)\.toString\('base64'\)/u)
  assert.match(e2eSource, /process\.platform === 'win32'/u)
  assert.match(e2eSource, /PPTX_RUNTIME_SOFFICE_USER_INSTALLATION/u)
  assert.match(e2eSource, /libreoffice-profile/u)
  assert.match(presentationSmokeSource, /run-primary-runtime-feed-e2e\.mjs/u)
  assert.doesNotMatch(presentationSmokeSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(presentationSmokeSource, /spawnSync/u)
})

test('packaged asset receipts bind a sorted real file tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dascowork-packaged-assets-'))
  const root = join(directory, 'app')
  const output = join(directory, 'receipt.json')
  try {
    await mkdir(join(root, 'resources'), { recursive: true })
    await writeFile(join(root, 'desktop-app'), 'binary')
    await writeFile(join(root, 'resources', 'app.asar'), 'application')
    const first = await writePackagedAppAssetReceipt({ root, output })
    assert.equal(first.entryCount, 3)
    assert.equal(first.fileCount, 2)
    assert.match(first.assetSha256, /^[a-f0-9]{64}$/u)

    await writeFile(join(root, 'resources', 'app.asar'), 'changed application')
    const second = await writePackagedAppAssetReceipt({ root, output })
    assert.notEqual(second.assetSha256, first.assetSha256)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
