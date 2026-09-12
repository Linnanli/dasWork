import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const releaseWorkflowPath = resolve(repositoryRoot, '.github/workflows/desktop-release.yml')
const testPlanWorkflowPath = resolve(repositoryRoot, '.github/workflows/desktop-test-plan.yml')
const primaryRuntimeBuildWorkflowPath = resolve(
  repositoryRoot,
  '.github/workflows/primary-runtime-build.yml'
)
const primaryRuntimePublishWorkflowPath = resolve(
  repositoryRoot,
  '.github/workflows/primary-runtime-publish.yml'
)
const packageJsonPath = resolve(repositoryRoot, 'desktop-app/package.json')
const packageLockPath = resolve(repositoryRoot, 'desktop-app/package-lock.json')
const clientPackageJsonPath = resolve(
  repositoryRoot,
  'desktop-app/vendors/codex-app-server-client/package.json'
)
const installerSmokePath = resolve(
  repositoryRoot,
  'desktop-app/scripts/run-installer-local-media-smoke.mjs'
)

test('release workflows use the locked Codex CLI without remote script execution', async () => {
  const [
    releaseWorkflow,
    testPlanWorkflow,
    packageJsonSource,
    packageLockSource,
    clientPackageJsonSource
  ] = await Promise.all([
    readFile(releaseWorkflowPath, 'utf8'),
    readFile(testPlanWorkflowPath, 'utf8'),
    readFile(packageJsonPath, 'utf8'),
    readFile(packageLockPath, 'utf8'),
    readFile(clientPackageJsonPath, 'utf8')
  ])
  const packageJson = JSON.parse(packageJsonSource)
  const packageLock = JSON.parse(packageLockSource)
  const clientPackageJson = JSON.parse(clientPackageJsonSource)
  const pinnedVersion = packageJson.devDependencies['@openai/codex']
  const lockedCodex = packageLock.packages['node_modules/@openai/codex']

  assert.match(
    pinnedVersion,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
  )
  assert.equal(packageLock.packages[''].devDependencies['@openai/codex'], pinnedVersion)
  assert.equal(lockedCodex.version, pinnedVersion)
  assert.match(lockedCodex.integrity, /^sha512-/u)
  assert.equal(
    packageLock.packages[''].devDependencies.esbuild,
    packageJson.devDependencies.esbuild
  )
  assert.match(clientPackageJson.scripts.build, /^node scripts\/build\.mjs/u)
  assert.doesNotMatch(releaseWorkflow, /chatgpt\.com\/codex\/install\.(?:sh|ps1)/u)
  assert.doesNotMatch(testPlanWorkflow, /chatgpt\.com\/codex\/install\.(?:sh|ps1)/u)
  assert.doesNotMatch(releaseWorkflow, /(?:curl|wget)[^\n|]*\|[^\n]*(?:sh|bash)/u)
  assert.doesNotMatch(testPlanWorkflow, /(?:curl|wget)[^\n|]*\|[^\n]*(?:sh|bash)/u)
  assert.doesNotMatch(releaseWorkflow, /Invoke-Expression/u)
  assert.match(releaseWorkflow, /^permissions:\n {2}contents: read$/mu)
  assert.doesNotMatch(releaseWorkflow, /contents: write/u)
  assert.doesNotMatch(releaseWorkflow, /gh release (?:create|edit|upload)/u)
  assert.match(testPlanWorkflow, /- "\.github\/workflows\/desktop-release\.yml"/u)
  for (const workflow of [releaseWorkflow, testPlanWorkflow]) {
    assert.match(workflow, /cache-dependency-path: desktop-app\/package-lock\.json/u)
    assert.doesNotMatch(workflow, /codex-app-server-client\/package-lock\.json/u)
    assert.doesNotMatch(workflow, /Install AI-free client dependencies/u)
    assert.match(workflow, /Build AI-free Codex app-server client/u)
    assert.match(workflow, /npm run build:codex-app-server-client/u)
    assert.match(workflow, /npm --prefix vendors\/codex-app-server-client run qa/u)
    assert.match(workflow, /Verify generated Codex app-server protocol contract/u)
    assert.match(workflow, /npm run verify:codex-app-server-protocol-contract/u)
    assert.match(workflow, /Smoke-test real Codex app-server contract/u)
    assert.match(workflow, /npm run verify:real-codex-app-server-contract/u)
    assert.match(workflow, /Run release LLM E2E/u)
    assert.match(workflow, /npm --prefix desktop-app run test:e2e:release-llm/u)
    assert.match(
      workflow,
      /DASCOWORK_RELEASE_LLM_SMOKE: \$\{\{ secrets\.DASCOWORK_RELEASE_LLM_SMOKE \}\}/u
    )
    assert.match(
      workflow,
      /DASCOWORK_RELEASE_ADMIN_BACKEND_URL: \$\{\{ secrets\.DASCOWORK_RELEASE_ADMIN_BACKEND_URL \}\}/u
    )
    for (const setting of [
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL',
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_ALLOWED_ORIGINS',
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_ALLOWED_ORIGINS',
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_CHANNEL',
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON',
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON',
      'DASCOWORK_PRIMARY_RUNTIME_CONFIG_POLL_INTERVAL_MS'
    ]) {
      assert.match(workflow, new RegExp(`${setting}: \\$\\{\\{ secrets\\.${setting} \\}\\}`, 'u'))
    }
    assert.doesNotMatch(workflow, /if:[^\n]*DASCOWORK_RELEASE_LLM_SMOKE/u)
    assert.match(workflow, /Verify native Codex runtime boundaries/u)
    assert.match(workflow, /node scripts\/verify-codex-native-runtime-boundaries\.mjs/u)
    assert.match(workflow, /Upload native runtime boundary report/u)
    assert.match(workflow, /native-runtime-boundaries\.json/u)
    assert.doesNotMatch(workflow, /codex:generate-types/u)
  }
})

test('internal build workflow smoke-tests built installers without publishing them', async () => {
  const [releaseWorkflow, installerSmoke] = await Promise.all([
    readFile(releaseWorkflowPath, 'utf8'),
    readFile(installerSmokePath, 'utf8')
  ])

  assert.match(releaseWorkflow, /run-installer-local-media-smoke\.mjs/u)
  assert.match(releaseWorkflow, /Prepare signed Primary Runtime product configuration/u)
  assert.match(releaseWorkflow, /Restore disabled Primary Runtime product configuration/u)
  assert.match(releaseWorkflow, /write-primary-runtime-product-config\.mjs --disabled/u)
  assert.match(releaseWorkflow, /for kind in appimage deb snap/u)
  for (const kind of ['dmg', 'nsis', 'appimage', 'deb', 'snap']) {
    assert.match(installerSmoke, new RegExp(`kind === '${kind}'`, 'u'))
  }
  assert.match(releaseWorkflow, /Upload installer artifact/u)
  assert.doesNotMatch(releaseWorkflow, /Create or update GitHub prerelease/u)
})

test('Primary Runtime CI has only the reviewed engineering artifact path', async () => {
  const [buildWorkflow, publishWorkflow, testPlanWorkflow] = await Promise.all([
    readFile(primaryRuntimeBuildWorkflowPath, 'utf8'),
    readFile(primaryRuntimePublishWorkflowPath, 'utf8'),
    readFile(testPlanWorkflowPath, 'utf8')
  ])

  assert.match(testPlanWorkflow, /- "\.github\/workflows\/primary-runtime-build\.yml"/u)
  assert.match(testPlanWorkflow, /- "\.github\/workflows\/primary-runtime-publish\.yml"/u)
  assert.match(buildWorkflow, /^permissions:\n {2}contents: read\n {2}actions: read$/mu)
  assert.doesNotMatch(buildWorkflow, /continue-on-error:\s*true/u)
  assert.doesNotMatch(buildWorkflow, /NODE_TLS_REJECT_UNAUTHORIZED/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime test/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:hard-limits/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run fetch:sources/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run materialize:inputs/u)
  assert.match(buildWorkflow, /DASCOWORK_PRIMARY_RUNTIME_BUILDER_IMAGE/u)
  assert.match(buildWorkflow, /ImageOS/u)
  assert.match(buildWorkflow, /ImageVersion/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:inputs/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run measure:unpack/u)
  assert.match(buildWorkflow, /PRIMARY_RUNTIME_MODE/u)
  assert.match(buildWorkflow, /- calibrate/u)
  assert.match(buildWorkflow, /- final/u)
  assert.match(buildWorkflow, /prepare-final-calibration/u)
  assert.match(buildWorkflow, /calibration_run_id/u)
  assert.match(buildWorkflow, /P3b measure ten cold installs and Main event-loop delay/u)
  assert.match(
    buildWorkflow,
    /P3b run ordinary app-server chat through the signed local calibration feed/u
  )
  assert.match(buildWorkflow, /test:e2e:primary-runtime-calibration-feed/u)
  assert.match(buildWorkflow, /--normal-chat-receipt/u)
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:primary-runtime:performance/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run assemble:performance/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:budgets/u)
  assert.match(buildWorkflow, /Rebuild final candidate from reviewed calibration evidence/u)
  assert.match(buildWorkflow, /aggregate-engineering-feed/u)
  assert.match(buildWorkflow, /primary-runtime-engineering-feed/u)
  assert.match(buildWorkflow, /four-target-summary\.json/u)
  assert.match(buildWorkflow, /primary-runtime-darwin-x64-candidate-staging/u)
  assert.match(buildWorkflow, /primary-runtime-darwin-x64-staging/u)
  for (const target of ['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64']) {
    assert.match(buildWorkflow, new RegExp(`target: ${target}`, 'u'))
  }
  assert.match(buildWorkflow, /macos-15-intel/u)
  assert.match(buildWorkflow, /macos-15/u)
  assert.match(buildWorkflow, /windows-2025/u)
  assert.match(buildWorkflow, /ubuntu-24\.04/u)
  assert.match(buildWorkflow, /needs: source-and-contract/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run build/u)
  assert.match(buildWorkflow, /Install desktop dependencies for P3a\/P3b installer gates/u)
  assert.match(
    buildWorkflow,
    /P3a install the generated archive through the real desktop installer/u
  )
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:primary-runtime-real/u)
  assert.match(buildWorkflow, /P3a stress-install the generated archive/u)
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:primary-runtime:stress/u)
  assert.ok(
    buildWorkflow.indexOf('Produce five P1a build and unpack measurements') <
      buildWorkflow.indexOf('P3a install the generated archive through the real desktop installer')
  )
  assert.ok(
    buildWorkflow.indexOf('P3a install the generated archive through the real desktop installer') <
      buildWorkflow.indexOf(
        'P3b run ordinary app-server chat through the signed local calibration feed'
      )
  )
  assert.ok(
    buildWorkflow.indexOf(
      'P3b run ordinary app-server chat through the signed local calibration feed'
    ) < buildWorkflow.indexOf('P3b measure ten cold installs and Main event-loop delay')
  )
  assert.doesNotMatch(buildWorkflow, /DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:platform/u)
  assert.doesNotMatch(buildWorkflow, /verify:platform-trust/u)
  assert.doesNotMatch(buildWorkflow, /build:matrix|verify:matrix/u)
  assert.doesNotMatch(
    buildWorkflow,
    /production_ready|contents: write|NODE_TLS_REJECT_UNAUTHORIZED/u
  )

  assert.match(publishWorkflow, /^on:\n {2}workflow_dispatch:/mu)
  assert.match(publishWorkflow, /^permissions:\n {2}actions: read\n {2}contents: read$/mu)
  assert.doesNotMatch(publishWorkflow, /contents: write/u)
  assert.doesNotMatch(publishWorkflow, /NODE_TLS_REJECT_UNAUTHORIZED/u)
  assert.match(publishWorkflow, /source_run_id/u)
  assert.doesNotMatch(publishWorkflow, /metadata_artifact|_artifact:/u)
  for (const target of ['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64']) {
    assert.match(publishWorkflow, new RegExp(`primary-runtime-${target}-staging`, 'u'))
  }
  assert.equal((publishWorkflow.match(/actions\/download-artifact@v8/g) ?? []).length, 4)
  assert.equal(
    (publishWorkflow.match(/run-id: \$\{\{ inputs\.source_run_id \}\}/g) ?? []).length,
    4
  )
  assert.match(publishWorkflow, /github-token: \$\{\{ github\.token \}\}/u)
  assert.match(publishWorkflow, /generate:engineering-key/u)
  assert.match(publishWorkflow, /create:metadata/u)
  assert.match(publishWorkflow, /sign:config/u)
  assert.match(publishWorkflow, /sign:manifest/u)
  assert.match(publishWorkflow, /assemble-release-staging/u)
  assert.match(publishWorkflow, /npm --prefix services\/primary-runtime-feed run publish-release/u)
  assert.match(publishWorkflow, /primary-runtime-engineering-feed-revalidated/u)
  assert.doesNotMatch(publishWorkflow, /secrets\.|production_ready|deploy|cdn|contents: write/u)
})

test('release gates require Primary Runtime performance evidence and packaged R07', async () => {
  const [releaseWorkflow, testPlanWorkflow, packageJsonSource, devRunner, releaseRunner] =
    await Promise.all([
      readFile(releaseWorkflowPath, 'utf8'),
      readFile(testPlanWorkflowPath, 'utf8'),
      readFile(packageJsonPath, 'utf8'),
      readFile(resolve(repositoryRoot, 'desktop-app/scripts/run-dev-llm-smoke.mjs'), 'utf8'),
      readFile(resolve(repositoryRoot, 'desktop-app/scripts/run-release-llm-smoke.mjs'), 'utf8')
    ])
  const packageJson = JSON.parse(packageJsonSource)

  assert.equal(
    packageJson.scripts['test:primary-runtime:performance'],
    'node scripts/run-primary-runtime-performance.mjs'
  )
  assert.match(packageJson.scripts['test:release-contract'], /primary-runtime-performance/u)
  assert.match(releaseWorkflow, /Run release LLM E2E/u)
  assert.match(releaseWorkflow, /npm --prefix desktop-app run test:e2e:release-llm/u)
  assert.match(testPlanWorkflow, /Run release LLM E2E/u)
  assert.match(testPlanWorkflow, /npm --prefix desktop-app run test:e2e:release-llm/u)
  for (const runner of [devRunner, releaseRunner]) {
    assert.match(runner, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_URL/u)
    assert.match(runner, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_PUBLIC_KEYS_JSON/u)
    assert.match(runner, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_MANIFEST_PUBLIC_KEYS_JSON/u)
    assert.match(runner, /delete env\.CODEX_APP_SERVER_BIN/u)
  }
  assert.match(devRunner, /DASCOWORK_REAL_LLM_RUNTIME: 'development'/u)
  assert.match(devRunner, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH/u)
  assert.match(releaseRunner, /DASCOWORK_RELEASE_PACKAGED_APP_EXECUTABLE/u)
  assert.match(releaseRunner, /tests\/e2e\/release-llm\.e2e\.ts/u)
  assert.match(releaseRunner, /The release LLM gate always runs the complete R01-R07 suite/u)
  assert.match(
    releaseRunner,
    /Packaged R07 must not use DASCOWORK_PRIMARY_RUNTIME_CONFIG_LOCAL_TEST_CA_PATH/u
  )
})
