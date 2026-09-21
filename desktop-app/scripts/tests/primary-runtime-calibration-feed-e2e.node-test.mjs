import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const executeFile = promisify(execFile)
const appRoot = resolve(import.meta.dirname, '../..')
const packageJsonPath = resolve(appRoot, 'package.json')
const runnerPath = resolve(appRoot, 'scripts/run-primary-runtime-calibration-feed-e2e.mjs')
const e2ePath = resolve(appRoot, 'tests/e2e/primary-runtime-feed.e2e.ts')
const tlsPolicyPath = resolve(appRoot, 'src/main/primaryRuntime/PrimaryRuntimeTlsPolicy.ts')

test('P3b calibration feed runner is local-only, P1a-bound, and cannot use a test app-server', async () => {
  const [packageJsonSource, runnerSource, e2eSource, tlsPolicySource] = await Promise.all([
    readFile(packageJsonPath, 'utf8'),
    readFile(runnerPath, 'utf8'),
    readFile(e2ePath, 'utf8'),
    readFile(tlsPolicyPath, 'utf8')
  ])
  const packageJson = JSON.parse(packageJsonSource)

  assert.equal(
    packageJson.scripts['test:e2e:primary-runtime-calibration-feed'],
    'node scripts/run-primary-runtime-calibration-feed-e2e.mjs'
  )
  await assert.rejects(
    () => executeFile(process.execPath, [runnerPath], { cwd: appRoot }),
    /Expected --target/u
  )
  assert.match(runnerSource, /allowCalibrationCandidate: true/u)
  assert.match(runnerSource, /createP1aCalibrationFeedFixture/u)
  assert.match(runnerSource, /P3b Main-overlap feed target .*native runner/u)
  assert.match(runnerSource, /tests\/e2e\/primary-runtime-feed\.e2e\.ts/u)
  assert.match(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_E2E_BUILD_READY/u)
  assert.match(runnerSource, /node_modules\/@playwright\/test\/cli\.js/u)
  assert.match(runnerSource, /node_modules\/typescript\/bin\/tsc/u)
  assert.match(runnerSource, /node_modules\/electron-vite\/bin\/electron-vite\.js/u)
  assert.doesNotMatch(runnerSource, /npm\.cmd|npx\.cmd/u)
  assert.match(runnerSource, /P3b prebuilt desktop output is missing/u)
  assert.match(runnerSource, /out\/main\/index\.js/u)
  assert.match(runnerSource, /out\/preload\/index\.js/u)
  assert.match(runnerSource, /out\/renderer\/index\.html/u)
  assert.match(runnerSource, /delete env\.CODEX_APP_SERVER_BIN/u)
  assert.match(runnerSource, /function withPinnedCodexCliOnPath/u)
  assert.match(runnerSource, /process\.platform === 'win32' \? 'Path' : 'PATH'/u)
  assert.match(runnerSource, /join\(appRoot, 'node_modules', '\.bin'\)/u)
  assert.match(runnerSource, /key\.toUpperCase\(\) !== 'PATH'/u)
  assert.match(runnerSource, /extendedKeyUsage=serverAuth/u)
  assert.match(runnerSource, /basicConstraints=critical,CA:TRUE/u)
  assert.match(runnerSource, /basicConstraints=critical,CA:FALSE/u)
  assert.match(runnerSource, /subjectAltName=IP:127\.0\.0\.1/u)
  assert.match(runnerSource, /'-CAcreateserial'/u)
  assert.match(runnerSource, /'-extensions',\s*'v3_leaf'/u)
  assert.match(runnerSource, /'verify', '-CAfile'/u)
  assert.doesNotMatch(runnerSource, /NODE_TLS_REJECT_UNAUTHORIZED/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_ROOT/u)
  assert.doesNotMatch(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL/u)
  assert.match(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_P3B_SAMPLE_OUTPUT/u)
  assert.match(runnerSource, /p3b-main-overlap-sample-\$\{sampleIndex\}\.json/u)
  assert.match(runnerSource, /dascowork-primary-runtime-main-overlap-performance\.v1/u)
  assert.match(runnerSource, /'AT-P3B-MAIN-OVERLAP'/u)
  assert.match(runnerSource, /'AT-E2E-01\/PRESENTATION-SKILL-RUNTIME'/u)
  assert.ok(
    runnerSource.indexOf("'AT-P3B-MAIN-OVERLAP'") <
      runnerSource.indexOf("'AT-E2E-01/PRESENTATION-SKILL-RUNTIME'")
  )
  assert.match(e2eSource, /AT-P3B-MAIN-OVERLAP/u)
  assert.match(e2eSource, /startMainDiskProbe/u)
  assert.match(e2eSource, /stopMainDiskProbe/u)
  assert.match(e2eSource, /process\.getBuiltinModule\(\s*'node:perf_hooks'/u)
  assert.match(e2eSource, /process\.getBuiltinModule\(\s*'node:fs\/promises'/u)
  assert.doesNotMatch(e2eSource, /Function\('return require'\)|requireFromMain/u)
  assert.match(e2eSource, /minimumAvailableDiskBytes/u)
  assert.doesNotMatch(e2eSource, /test\.skip/u)
  assert.match(e2eSource, /const primaryRuntimeE2eTimeoutMs = 600_000/u)
  assert.match(e2eSource, /test\.setTimeout\(primaryRuntimeE2eTimeoutMs\)/u)
  assert.match(e2eSource, /const primaryRuntimeReadinessTimeoutMs = 300_000/u)
  assert.match(e2eSource, /args: \[appRoot\]/u)
  assert.match(e2eSource, /await expectPrimaryRuntimeReady\(page(?:, logs)?\)/u)
  assert.match(e2eSource, /\{ timeout: primaryRuntimeReadinessTimeoutMs \}/u)
  assert.match(e2eSource, /Primary Runtime did not become ready/u)
  assert.match(e2eSource, /Diagnostic retry status/u)
  assert.match(e2eSource, /safePrimaryRuntimeDiagnosticLogs/u)
  assert.match(e2eSource, /\[bundled-plugins\]/u)
  assert.match(e2eSource, /\^\(\?:ready\|failed\)\$/u)
  assert.match(e2eSource, /post-install plugin synchronization failed/u)
  assert.match(e2eSource, /sandbox_permissions: 'require_escalated'/u)
  assert.match(
    e2eSource,
    /shellCommandResponse\('response-runtime-command', runtimeCommandCallId, \{[\s\S]*?timeout_ms: 60_000/u
  )
  assert.match(e2eSource, /data:text\/javascript;base64/u)
  assert.match(
    e2eSource,
    /process\.platform === 'win32'[\s\S]*?& \$\{shellQuote\(dependencies\.node\)\}/u
  )
  assert.match(e2eSource, /invalid `,;` separators/u)
  assert.match(e2eSource, /runtimeSystemPaths/u)
  assert.match(
    e2eSource,
    /PATH: \[dirname\(dependencies\.soffice\), dirname\(dependencies\.pdftoppm\), \.\.\.runtimeSystemPaths, process\.env\.PATH\]\.filter\(Boolean\)\.join\(delimiter\)/u
  )
  assert.match(e2eSource, /renderer approval surface/u)
  assert.match(e2eSource, /await expect\(approvalPanel\)\.toContainText\('是否允许执行以下命令？'/u)
  assert.match(e2eSource, /\{ timeout: 120_000 \}/u)
  assert.match(e2eSource, /runtimeSuccessMessage/u)
  assert.match(e2eSource, /\.filter\(\{\s*hasText:/u)
  assert.match(e2eSource, /toHaveCount\(1, \{ timeout: 120_000 \}\)/u)
  assert.match(e2eSource, /retain earlier tool outputs as context/u)
  assert.match(
    e2eSource,
    /functionCallOutputCount\(providerBodies, loaderCallId\)\)\.toBeGreaterThanOrEqual\(1\)/u
  )
  assert.match(e2eSource, /runtimeCommandOutput/u)
  assert.match(e2eSource, /expect\(runtimeCommandOutput\)\.toBeTruthy\(\)/u)
  assert.match(e2eSource, /presentation-skill:created:6/u)
  assert.match(e2eSource, /runPrimaryRuntimeUpdate\(\{ version: 1 \}\)/u)
  assert.match(e2eSource, /serializeDiagnosticData/u)
  assert.match(
    e2eSource,
    /window\.desktopApp\.plugins\.getPrimaryRuntimeStatus\(\{ version: 1 \}\)/u
  )
  assert.match(
    await readFile(resolve(appRoot, 'src/main/index.ts'), 'utf8'),
    /void bundledPluginReconciler\.run\('startup'\)[\s\S]*void primaryRuntimeUpdates\?\.start\(\)/u
  )
  assert.match(tlsPolicySource, /ca: input\.ca/u)
  assert.match(tlsPolicySource, /rejectUnauthorized: true/u)
  assert.match(tlsPolicySource, /local test CA may only contact its configured loopback feed/u)
  assert.doesNotMatch(tlsPolicySource, /NODE_TLS_REJECT_UNAUTHORIZED/u)
})
