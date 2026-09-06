import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const releaseWorkflowPath = resolve(repositoryRoot, '.github/workflows/desktop-release.yml')
const testPlanWorkflowPath = resolve(repositoryRoot, '.github/workflows/desktop-test-plan.yml')
const packageJsonPath = resolve(repositoryRoot, 'desktop-app/package.json')
const packageLockPath = resolve(repositoryRoot, 'desktop-app/package-lock.json')
const installerSmokePath = resolve(
  repositoryRoot,
  'desktop-app/scripts/run-installer-local-media-smoke.mjs'
)

test('release workflows use the locked Codex CLI without remote script execution', async () => {
  const [releaseWorkflow, testPlanWorkflow, packageJsonSource, packageLockSource] =
    await Promise.all([
      readFile(releaseWorkflowPath, 'utf8'),
      readFile(testPlanWorkflowPath, 'utf8'),
      readFile(packageJsonPath, 'utf8'),
      readFile(packageLockPath, 'utf8')
    ])
  const packageJson = JSON.parse(packageJsonSource)
  const packageLock = JSON.parse(packageLockSource)
  const pinnedVersion = packageJson.devDependencies['@openai/codex']
  const lockedCodex = packageLock.packages['node_modules/@openai/codex']

  assert.match(
    pinnedVersion,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
  )
  assert.equal(packageLock.packages[''].devDependencies['@openai/codex'], pinnedVersion)
  assert.equal(lockedCodex.version, pinnedVersion)
  assert.match(lockedCodex.integrity, /^sha512-/u)
  assert.doesNotMatch(releaseWorkflow, /chatgpt\.com\/codex\/install\.(?:sh|ps1)/u)
  assert.doesNotMatch(testPlanWorkflow, /chatgpt\.com\/codex\/install\.(?:sh|ps1)/u)
  assert.doesNotMatch(releaseWorkflow, /(?:curl|wget)[^\n|]*\|[^\n]*(?:sh|bash)/u)
  assert.doesNotMatch(testPlanWorkflow, /(?:curl|wget)[^\n|]*\|[^\n]*(?:sh|bash)/u)
  assert.doesNotMatch(releaseWorkflow, /Invoke-Expression/u)
  assert.match(releaseWorkflow, /^permissions:\n {2}contents: read$/mu)
  assert.match(releaseWorkflow, /release:\n(?:.|\n)*?permissions:\n {6}contents: write/u)
  assert.match(testPlanWorkflow, /- "\.github\/workflows\/desktop-release\.yml"/u)
  for (const workflow of [releaseWorkflow, testPlanWorkflow]) {
    assert.match(workflow, /Build AI-free Codex app-server client/u)
    assert.match(workflow, /npm run build:codex-app-server-client/u)
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
    assert.doesNotMatch(workflow, /if:[^\n]*DASCOWORK_RELEASE_LLM_SMOKE/u)
    assert.match(workflow, /Verify native Codex runtime boundaries/u)
    assert.match(workflow, /node scripts\/verify-codex-native-runtime-boundaries\.mjs/u)
    assert.match(workflow, /Upload native runtime boundary report/u)
    assert.match(workflow, /native-runtime-boundaries\.json/u)
    assert.doesNotMatch(workflow, /codex:generate-types/u)
  }
})

test('release workflow verifies exact assets and smoke-tests built installers', async () => {
  const [releaseWorkflow, installerSmoke] = await Promise.all([
    readFile(releaseWorkflowPath, 'utf8'),
    readFile(installerSmokePath, 'utf8')
  ])

  assert.match(releaseWorkflow, /verify-release-assets\.mjs/u)
  assert.match(releaseWorkflow, /run-installer-local-media-smoke\.mjs/u)
  assert.match(releaseWorkflow, /for kind in appimage deb snap/u)
  for (const kind of ['dmg', 'nsis', 'appimage', 'deb', 'snap']) {
    assert.match(installerSmoke, new RegExp(`kind === '${kind}'`, 'u'))
  }
  assert.match(releaseWorkflow, /SHA256SUMS/u)
})
