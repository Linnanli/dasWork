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
  assert.match(runnerSource, /P3b normal-chat feed target .*native runner/u)
  assert.match(runnerSource, /tests\/e2e\/primary-runtime-feed\.e2e\.ts/u)
  assert.match(runnerSource, /DASCOWORK_PRIMARY_RUNTIME_E2E_BUILD_READY/u)
  assert.match(runnerSource, /process\.platform === 'win32' \? 'npm\.cmd' : 'npm'/u)
  assert.match(runnerSource, /process\.platform === 'win32' \? 'npx\.cmd' : 'npx'/u)
  assert.match(runnerSource, /P3b prebuilt desktop output is missing/u)
  assert.match(runnerSource, /out\/main\/index\.js/u)
  assert.match(runnerSource, /out\/preload\/index\.js/u)
  assert.match(runnerSource, /out\/renderer\/index\.html/u)
  assert.match(runnerSource, /delete env\.CODEX_APP_SERVER_BIN/u)
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
  assert.match(e2eSource, /ordinary app-server chat stayed responsive/u)
  assert.match(e2eSource, /test\.setTimeout\(180_000\)/u)
  assert.match(e2eSource, /args: \[appRoot\]/u)
  assert.match(e2eSource, /await expectPrimaryRuntimeReady\(page(?:, logs)?\)/u)
  assert.match(e2eSource, /Primary Runtime did not become ready/u)
  assert.match(e2eSource, /Diagnostic retry status/u)
  assert.match(e2eSource, /safePrimaryRuntimeDiagnosticLogs/u)
  assert.match(e2eSource, /\[bundled-plugins\]/u)
  assert.match(e2eSource, /\^\(\?:ready\|failed\)\$/u)
  assert.match(e2eSource, /post-install plugin synchronization failed/u)
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
