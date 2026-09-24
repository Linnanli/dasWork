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
const pinnedCodexCliVerifierPath = resolve(
  repositoryRoot,
  'desktop-app/scripts/verify-pinned-codex-cli.mjs'
)
const linuxSandboxSetupPath = resolve(
  repositoryRoot,
  'desktop-app/scripts/prepare-codex-linux-sandbox.sh'
)

test('locked Codex CLI verification executes the installed package entrypoint directly', async () => {
  const verifierSource = await readFile(pinnedCodexCliVerifierPath, 'utf8')

  assert.match(verifierSource, /node_modules\/@openai\/codex\/package\.json/u)
  assert.match(verifierSource, /spawnSync\(process\.execPath, \[codexEntrypoint, '--version'\]/u)
  assert.doesNotMatch(verifierSource, /npm(?:Command)?/u)
})

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
    assert.doesNotMatch(workflow, /Run release LLM E2E/u)
    assert.doesNotMatch(workflow, /test:e2e:release-llm/u)
    assert.doesNotMatch(workflow, /DASCOWORK_RELEASE_LLM_SMOKE/u)
    assert.doesNotMatch(workflow, /DASCOWORK_RELEASE_ADMIN_BACKEND_/u)
    assert.doesNotMatch(workflow, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_[A-Z_]+: \$\{\{ secrets\./u)
    assert.match(workflow, /Verify native Codex runtime boundaries/u)
    assert.match(workflow, /node scripts\/verify-codex-native-runtime-boundaries\.mjs/u)
    assert.match(workflow, /Upload native runtime boundary report/u)
    assert.match(workflow, /native-runtime-boundaries\.json/u)
    assert.doesNotMatch(workflow, /codex:generate-types/u)
  }
})

test('Linux desktop gates provision and preflight the supported Codex sandbox', async () => {
  const [releaseWorkflow, testPlanWorkflow, sandboxSetup] = await Promise.all([
    readFile(releaseWorkflowPath, 'utf8'),
    readFile(testPlanWorkflowPath, 'utf8'),
    readFile(linuxSandboxSetupPath, 'utf8')
  ])

  assert.match(sandboxSetup, /apt-get install --yes bubblewrap apparmor-profiles apparmor-utils/u)
  assert.match(sandboxSetup, /bwrap-userns-restrict/u)
  assert.match(sandboxSetup, /apparmor_parser -r/u)
  assert.match(sandboxSetup, /codex sandbox -- \/bin\/true/u)
  assert.doesNotMatch(sandboxSetup, /apparmor_restrict_unprivileged_userns=0/u)
  assert.doesNotMatch(sandboxSetup, /unprivileged_userns_clone=1/u)

  for (const workflow of [releaseWorkflow, testPlanWorkflow]) {
    assert.match(workflow, /Prepare Codex workspace sandbox on Linux/u)
    assert.match(workflow, /bash desktop-app\/scripts\/prepare-codex-linux-sandbox\.sh/u)
    assert.ok(
      workflow.indexOf('Prepare Codex workspace sandbox on Linux') <
        workflow.indexOf('Run Mock E2E')
    )
    assert.doesNotMatch(workflow, /apparmor_restrict_unprivileged_userns=0/u)
    assert.doesNotMatch(workflow, /unprivileged_userns_clone=1/u)
  }
})

test('internal build workflow smoke-tests built installers without publishing them', async () => {
  const [releaseWorkflow, installerSmoke] = await Promise.all([
    readFile(releaseWorkflowPath, 'utf8'),
    readFile(installerSmokePath, 'utf8')
  ])

  assert.match(releaseWorkflow, /run-installer-local-media-smoke\.mjs/u)
  assert.match(
    releaseWorkflow,
    /Disable Primary Runtime production configuration for engineering installer builds/u
  )
  assert.match(releaseWorkflow, /write-primary-runtime-product-config\.mjs --disabled/u)
  assert.doesNotMatch(releaseWorkflow, /write-primary-runtime-product-config\.mjs\n/u)
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
  assert.match(
    buildWorkflow,
    /^concurrency:\n {2}# PR\/push fast lanes may supersede an earlier fast lane\./mu
  )
  assert.match(
    buildWorkflow,
    /group: primary-runtime-engineering-build-\$\{\{ github\.event_name == 'pull_request'/u
  )
  assert.match(
    buildWorkflow,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \|\| github\.event_name == 'push' \}\}/u
  )
  assert.doesNotMatch(buildWorkflow, /continue-on-error:\s*true/u)
  assert.doesNotMatch(buildWorkflow, /NODE_TLS_REJECT_UNAUTHORIZED/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime test/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:hard-limits/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run fetch:sources/u)
  assert.match(buildWorkflow, /--timeout-ms 900000/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run materialize:inputs/u)
  assert.doesNotMatch(buildWorkflow, /brew install|apt-get install/u)
  // LibreOffice for Windows is a locked upstream MSI materialized into the
  // staged Runtime; MSYS cannot build LibreOffice on Windows and must not be
  // reintroduced as an unreviewed alternate path.
  assert.doesNotMatch(buildWorkflow, /MSYS2|msys2\/setup-msys2|C:\\msys64/u)
  assert.match(buildWorkflow, /Configure locked Windows MSVC builder environment/u)
  assert.match(buildWorkflow, /ilammy\/msvc-dev-cmd@0b201ec74fa43914dc39ae48a89fd1d8cb592756/u)
  assert.match(buildWorkflow, /arch: x64/u)
  assert.doesNotMatch(buildWorkflow, /DASCOWORK_PRIMARY_RUNTIME_MSYS_ROOT/u)
  assert.match(buildWorkflow, /DASCOWORK_PRIMARY_RUNTIME_BUILDER_IMAGE/u)
  assert.match(buildWorkflow, /ImageVersion/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:inputs/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run measure:unpack/u)
  assert.match(buildWorkflow, /PRIMARY_RUNTIME_MODE/u)
  assert.match(buildWorkflow, /- fast/u)
  assert.match(buildWorkflow, /- calibrate/u)
  assert.match(buildWorkflow, /- final/u)
  assert.match(buildWorkflow, /^ {2}schedule:/mu)
  assert.match(buildWorkflow, /cache: npm/u)
  assert.match(buildWorkflow, /cache-dependency-path: desktop-app\/package-lock\.json/u)
  assert.match(buildWorkflow, /actions\/cache@v4/u)
  assert.match(buildWorkflow, /primary-runtime-source-cache-\$\{\{ matrix\.target \}\}/u)
  const sourceCacheStep = buildWorkflow
    .split('Restore immutable Runtime source object cache')[1]
    ?.split('Fetch only immutable Runtime source objects')[0]
  assert.match(
    sourceCacheStep ?? '',
    /restore-keys: \|\s+primary-runtime-source-cache-\$\{\{ matrix\.target \}\}-/u
  )
  assert.match(buildWorkflow, /Capture observed GitHub-hosted builder image identity/u)
  assert.match(buildWorkflow, /RUNNER_ENVIRONMENT:-/u)
  assert.match(buildWorkflow, /DASCOWORK_PRIMARY_RUNTIME_BUILDER_IMAGE=github-hosted:/u)
  assert.match(buildWorkflow, /"\$GITHUB_ENV"/u)
  assert.match(buildWorkflow, /Restore verified Windows Runtime inputs/u)
  assert.match(buildWorkflow, /Save verified Windows Runtime inputs/u)
  assert.match(buildWorkflow, /primary-runtime-windows-inputs-v1-/u)
  const windowsInputCacheStep = buildWorkflow
    .split('Restore verified Windows Runtime inputs')[1]
    ?.split('Materialize target-native offline Runtime inputs')[0]
  assert.doesNotMatch(windowsInputCacheStep ?? '', /restore-keys:/u)
  assert.match(buildWorkflow, /actions\/cache\/restore@v4/u)
  assert.match(buildWorkflow, /actions\/cache\/save@v4/u)
  assert.match(buildWorkflow, /Stage restartable target-native build artifacts/u)
  assert.match(buildWorkflow, /primary-runtime-\$\{\{ matrix\.target \}\}-build-artifacts/u)
  assert.match(buildWorkflow, /validate-target/u)
  assert.match(
    buildWorkflow,
    /Download the same-run target-native build artifact for P3 validation/u
  )
  assert.match(buildWorkflow, /DASCOWORK_PRIMARY_RUNTIME_E2E_BUILD_READY=1/u)
  assert.match(
    buildWorkflow,
    /validate-target:[\s\S]*?if: \$\{\{ !cancelled\(\) && needs\.build-target\.result != 'skipped'[\s\S]*?needs: build-target[\s\S]*?Download the same-run target-native build artifact for P3 validation[\s\S]*?name: primary-runtime-\$\{\{ matrix\.target \}\}-build-artifacts/u
  )
  assert.match(buildWorkflow, /aggregate-engineering-feed:[\s\S]*?needs: validate-target/u)
  assert.doesNotMatch(buildWorkflow, /^ {2}PRIMARY_RUNTIME_ZIP_COMPRESSION_LEVEL:/mu)
  assert.match(
    buildWorkflow,
    /build-target:[\s\S]*?^ {4}env:\n {6}PRIMARY_RUNTIME_ZIP_COMPRESSION_LEVEL: "6"$/mu
  )
  assert.match(buildWorkflow, /prepare-final-calibration/u)
  assert.match(buildWorkflow, /calibration_run_id/u)
  assert.match(buildWorkflow, /P3b measure ten cold installs and Main event-loop delay/u)
  assert.match(
    buildWorkflow,
    /P3b collect Main overlap performance and dev R07 through the signed local calibration feed/u
  )
  assert.match(buildWorkflow, /test:e2e:primary-runtime-calibration-feed/u)
  assert.match(buildWorkflow, /matrix\.target \}\}" == "linux-x64"/u)
  assert.match(
    buildWorkflow,
    /xvfb-run -a npm --prefix desktop-app run test:e2e:primary-runtime-calibration-feed/u
  )
  assert.match(buildWorkflow, /--main-overlap-receipt/u)
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:primary-runtime:performance/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run assemble:performance/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:budgets/u)
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:codex-verifiers/u)
  assert.match(buildWorkflow, /--hard-limits runtime-hard-limits\.json/u)
  assert.match(buildWorkflow, /--source-lock runtime-sources\.lock\.json/u)
  assert.match(buildWorkflow, /--toolchains-lock runtime-toolchains\.lock\.json/u)
  assert.match(buildWorkflow, /Rebuild final candidate from reviewed calibration evidence/u)
  assert.match(buildWorkflow, /aggregate-engineering-feed/u)
  assert.match(buildWorkflow, /primary-runtime-engineering-feed/u)
  assert.match(buildWorkflow, /four-target-summary\.json/u)
  assert.match(
    buildWorkflow,
    /Run packaged R07 from the same-run engineering feed and an empty cache/u
  )
  assert.match(
    buildWorkflow,
    /Run dev R07 from the same-run engineering feed and record live evidence/u
  )
  assert.match(buildWorkflow, /test:e2e:primary-runtime-feed:packaged/u)
  assert.match(buildWorkflow, /DASCOWORK_APP_TOOLS_LIVE_TRACE_REPORT/u)
  assert.match(buildWorkflow, /r07-dev-live-trace\.json/u)
  assert.match(buildWorkflow, /r07-packaged-live-trace\.json/u)
  assert.match(buildWorkflow, /Produce and verify App Tools R07 release-gate evidence/u)
  assert.match(buildWorkflow, /feed-repository\/evidence\/app-tools-release/u)
  assert.match(buildWorkflow, /write-app-tools-release-evidence\.mjs/u)
  assert.match(buildWorkflow, /--feedRoot "\$RUNNER_TEMP\/feed-repository\/current"/u)
  assert.match(buildWorkflow, /verify:app-tools-release-gates/u)
  assert.match(buildWorkflow, /--gateId AT-E2E-01/u)
  assert.match(buildWorkflow, /--gateId AT-LIVE-01/u)
  assert.match(buildWorkflow, /--gateId AT-LIVE-PKG-01/u)
  assert.match(buildWorkflow, /--asset-sha256 "\$asset_sha"/u)
  assert.match(buildWorkflow, /DASCOWORK_PRIMARY_RUNTIME_PACKAGED_ASSET_RECEIPT/u)
  assert.match(
    buildWorkflow,
    /feed-repository\/evidence\/app-tools-release\/reports\/packaged-app-assets\.json/u
  )
  assert.match(buildWorkflow, /desktop-app\/scripts\/packaged-app-assets\.mjs/u)
  assert.doesNotMatch(buildWorkflow, /asset_sha=.*at-live-pkg-01\.json/u)
  assert.match(buildWorkflow, /--ids AT-E2E-01,AT-LIVE-01,AT-LIVE-PKG-01/u)
  assert.match(buildWorkflow, /desktop-app\/scripts\/run-primary-runtime-packaged-feed-e2e\.mjs/u)
  assert.match(buildWorkflow, /desktop-app\/src\/main\/appTools\/\*\*/u)
  assert.match(buildWorkflow, /desktop-app\/scripts\/verify-app-tools-release-gates\.mjs/u)
  assert.match(buildWorkflow, /desktop-app\/scripts\/write-app-tools-release-evidence\.mjs/u)
  assert.match(
    buildWorkflow,
    /desktop-app\/scripts\/tests\/verify-app-tools-release-gates\.node-test\.mjs/u
  )
  assert.match(buildWorkflow, /desktop-app\/tests\/app-tools-release-gates\.json/u)
  assert.match(buildWorkflow, /desktop-app\/tests\/e2e\/primary-runtime-feed\.e2e\.ts/u)
  assert.match(buildWorkflow, /desktop-app\/tests\/e2e\/support\/r07Presentation\.ts/u)
  assert.match(buildWorkflow, /Create an ephemeral loopback CA for the packaged engineering feed/u)
  assert.match(buildWorkflow, /ENGINEERING_FEED_ORIGIN/u)
  assert.match(buildWorkflow, /primary-runtime-darwin-x64-candidate-staging/u)
  assert.match(buildWorkflow, /primary-runtime-darwin-x64-staging/u)
  assert.match(buildWorkflow, /cp "\$target_root\/THIRD_PARTY_NOTICES\.txt"/u)
  assert.match(buildWorkflow, /cp "\$target_root\/SBOM\.json"/u)
  for (const target of ['darwin-x64', 'darwin-arm64', 'win32-x64', 'linux-x64']) {
    assert.match(buildWorkflow, new RegExp(`target: ${target}`, 'u'))
  }
  assert.match(buildWorkflow, /macos-15-intel/u)
  assert.match(buildWorkflow, /macos-15/u)
  assert.match(buildWorkflow, /windows-2025/u)
  assert.match(buildWorkflow, /ubuntu-24\.04/u)
  assert.match(buildWorkflow, /needs: source-and-contract/u)
  assert.match(buildWorkflow, /Install desktop contract test dependencies/u)
  assert.ok(
    buildWorkflow.indexOf('Install desktop contract test dependencies') <
      buildWorkflow.indexOf('Verify desktop release/workflow contracts')
  )
  assert.match(buildWorkflow, /npm --prefix primary-runtime run build/u)
  assert.match(buildWorkflow, /Install desktop dependencies for P3a\/P3b installer gates/u)
  assert.match(
    buildWorkflow,
    /Install desktop dependencies for P3a\/P3b installer gates\n {8}run: npm --prefix desktop-app ci$/mu
  )
  assert.match(buildWorkflow, /Use locked Codex CLI for P3b Main-overlap validation/u)
  assert.match(
    buildWorkflow,
    /echo "\$GITHUB_WORKSPACE\/desktop-app\/node_modules\/\.bin" >> "\$GITHUB_PATH"/u
  )
  assert.match(buildWorkflow, /node desktop-app\/scripts\/verify-pinned-codex-cli\.mjs/u)
  assert.match(buildWorkflow, /Build desktop test host once for P3b/u)
  assert.match(
    buildWorkflow,
    /Build AI-free Codex app-server client for final P3a installer gates/u
  )
  assert.match(buildWorkflow, /npm --prefix desktop-app run build:codex-app-server-client/u)
  assert.match(
    buildWorkflow,
    /P3a install the downloaded archive through the real desktop installer/u
  )
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:primary-runtime-real/u)
  assert.match(buildWorkflow, /P3a stress-install the downloaded archive/u)
  assert.match(buildWorkflow, /npm --prefix desktop-app run test:primary-runtime:stress/u)
  assert.ok(
    buildWorkflow.indexOf('Produce five P1a build and unpack measurements') <
      buildWorkflow.indexOf('P3a install the downloaded archive through the real desktop installer')
  )
  assert.ok(
    buildWorkflow.indexOf('Verify final archive binds reviewed calibration evidence') <
      buildWorkflow.indexOf('Download the same-run target-native build artifact for P3 validation')
  )
  assert.ok(
    buildWorkflow.indexOf('Download the same-run target-native build artifact for P3 validation') <
      buildWorkflow.indexOf('Install desktop dependencies for P3a/P3b installer gates')
  )
  assert.ok(
    buildWorkflow.indexOf('Install desktop dependencies for P3a/P3b installer gates') <
      buildWorkflow.indexOf('Use locked Codex CLI for P3b Main-overlap validation')
  )
  assert.ok(
    buildWorkflow.indexOf('Use locked Codex CLI for P3b Main-overlap validation') <
      buildWorkflow.indexOf('Build desktop test host once for P3b')
  )
  assert.ok(
    buildWorkflow.indexOf('Build desktop test host once for P3b') <
      buildWorkflow.indexOf('P3a install the downloaded archive through the real desktop installer')
  )
  assert.ok(
    buildWorkflow.indexOf('P3a install the downloaded archive through the real desktop installer') <
      buildWorkflow.indexOf(
        'P3b collect Main overlap performance and dev R07 through the signed local calibration feed'
      )
  )
  assert.ok(
    buildWorkflow.indexOf(
      'P3b collect Main overlap performance and dev R07 through the signed local calibration feed'
    ) < buildWorkflow.indexOf('P3b measure ten cold installs and Main event-loop delay')
  )
  assert.doesNotMatch(buildWorkflow, /DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run verify:platform/u)
  assert.match(buildWorkflow, /Bind target staging provenance to platform validation/u)
  assert.match(buildWorkflow, /npm --prefix primary-runtime run bind:provenance/u)
  assert.match(buildWorkflow, /--platform-validation/u)
  assert.match(buildWorkflow, /--source-lock runtime-sources\.lock\.json/u)
  assert.match(buildWorkflow, /--toolchains-lock runtime-toolchains\.lock\.json/u)
  assert.doesNotMatch(buildWorkflow, /--source-lock primary-runtime\/runtime-sources\.lock\.json/u)
  assert.doesNotMatch(
    buildWorkflow,
    /--toolchains-lock primary-runtime\/runtime-toolchains\.lock\.json/u
  )
  assert.match(buildWorkflow, /--workflow-run-url/u)
  assert.ok(
    buildWorkflow.indexOf('Verify target-native Runtime archive execution and rendering') <
      buildWorkflow.indexOf('Bind target staging provenance to platform validation')
  )
  assert.ok(
    buildWorkflow.indexOf('Bind target staging provenance to platform validation') <
      buildWorkflow.indexOf('Download the same-run target-native build artifact for P3 validation')
  )
  assert.ok(
    buildWorkflow.indexOf('Verify P1a candidate archive and component smoke') <
      buildWorkflow.indexOf('Verify target-native Runtime archive execution and rendering')
  )
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

test('optional real-model smoke stays independent from deterministic Runtime presentation gates', async () => {
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
  for (const workflow of [releaseWorkflow, testPlanWorkflow]) {
    assert.doesNotMatch(workflow, /Run release LLM E2E/u)
    assert.doesNotMatch(workflow, /test:e2e:release-llm/u)
    assert.doesNotMatch(workflow, /DASCOWORK_RELEASE_LLM_SMOKE/u)
    assert.doesNotMatch(workflow, /DASCOWORK_RELEASE_ADMIN_BACKEND_/u)
    assert.doesNotMatch(workflow, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_[A-Z_]+: \$\{\{ secrets\./u)
  }
  for (const runner of [devRunner, releaseRunner]) {
    assert.match(runner, /delete env\.CODEX_APP_SERVER_BIN/u)
    assert.doesNotMatch(runner, /DASCOWORK_PRIMARY_RUNTIME_CONFIG_/u)
    assert.doesNotMatch(runner, /writePackagedProductConfig/u)
  }
  assert.match(devRunner, /DASCOWORK_REAL_LLM_RUNTIME: 'development'/u)
  assert.match(releaseRunner, /DASCOWORK_RELEASE_PACKAGED_APP_EXECUTABLE/u)
  assert.match(releaseRunner, /tests\/e2e\/release-llm\.e2e\.ts/u)
  assert.match(releaseRunner, /The release LLM gate always runs the complete R01-R06 suite/u)
})
