import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { verifyCodexNativeRuntimeBoundaries } from '../verify-codex-native-runtime-boundaries.mjs'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node test fixtures are validated through their assertions. */

const desktopRoot = resolve(new URL('../..', import.meta.url).pathname)
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function makeProtocolRoot(root) {
  mkdirSync(join(root, 'vendors/codex-app-server-client/src/protocol/app-server-protocol'), {
    recursive: true
  })
}

function makeClassifiedFixture(root) {
  const productionRoots = ['renderer', 'preload', 'shared', 'main', 'core'].map((label) => {
    const directory = join(root, label)
    mkdirSync(directory, { recursive: true })
    return { label, root: directory, rules: [] }
  })
  const testRoots = productionRoots.map(({ label, root: directory }) => ({
    label,
    root: directory
  }))
  const compatibilityFixtureRoot = join(root, 'compatibility')
  mkdirSync(compatibilityFixtureRoot, { recursive: true })
  for (const [index, extension] of sourceExtensions.entries()) {
    writeFileSync(
      join(productionRoots[index % productionRoots.length].root, `source${extension}`),
      ''
    )
    writeFileSync(
      join(testRoots[index % testRoots.length].root, `source.test${extension}`),
      'streamText({})\n'
    )
    writeFileSync(join(compatibilityFixtureRoot, `fixture${extension}`), '')
  }
  makeProtocolRoot(root)
  return {
    productionRoots,
    testRoots,
    compatibilityFixtureRoots: [{ label: 'legacy-provider-tests', root: compatibilityFixtureRoot }],
    protocolSearchRoot: root
  }
}

test('native runtime production roots satisfy the boundary rules', () => {
  const report = verifyCodexNativeRuntimeBoundaries()
  assert.equal(report.ok, true)
  assert.deepEqual(report.violations, [])
  assert.equal(report.allowlist.length, 0)
  for (const label of ['renderer', 'preload', 'shared', 'main', 'core']) {
    assert.ok(report.scanned.production.roots[label], `missing production scan root ${label}`)
    assert.ok(report.scanned.tests.roots[label], `missing test scan root ${label}`)
  }
  assert.ok(report.scanned.compatibilityFixtures.roots['legacy-provider-tests'])
})

test('rejects a second generated protocol tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-protocol-tree-'))
  try {
    const canonical = join(root, 'vendors/codex-app-server-client/src/protocol/app-server-protocol')
    const duplicate = join(root, 'vendors/compat/src/protocol/app-server-protocol')
    mkdirSync(canonical, { recursive: true })
    mkdirSync(duplicate, { recursive: true })
    assert.throws(
      () =>
        verifyCodexNativeRuntimeBoundaries({
          productionRoots: [
            { label: 'renderer', root: resolve(desktopRoot, 'src/renderer') },
            { label: 'preload', root: resolve(desktopRoot, 'src/preload') },
            { label: 'shared', root: resolve(desktopRoot, 'src/shared') },
            { label: 'main', root: resolve(desktopRoot, 'src/main') },
            { label: 'core', root: resolve(desktopRoot, 'vendors/codex-app-server-client/src') }
          ],
          protocolSearchRoot: root
        }),
      /protocol:duplicate-generated-tree/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects an accidental AI SDK stream call in the main runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-native-boundary-'))
  try {
    const fixture = makeClassifiedFixture(root)
    const mainRoot = fixture.productionRoots.find((entry) => entry.label === 'main')
    mainRoot.rules = [['ai-sdk-stream-text', /\bstreamText\s*\(/u]]
    writeFileSync(join(mainRoot.root, 'bad.tsx'), 'export const run = () => streamText({})\n')
    assert.throws(
      () =>
        verifyCodexNativeRuntimeBoundaries({
          ...fixture
        }),
      /main:ai-sdk-stream-text/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a generic app-server request surface in renderer-facing source', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-renderer-boundary-'))
  try {
    const fixture = makeClassifiedFixture(root)
    const sharedRoot = fixture.productionRoots.find((entry) => entry.label === 'shared')
    sharedRoot.rules = [
      [
        'generic-app-server-request',
        /(?:\bmethod\??\s*:\s*string[\s\S]{0,240}\bparams\??\s*:\s*unknown|\bparams\??\s*:\s*unknown[\s\S]{0,240}\bmethod\??\s*:\s*string)/u
      ]
    ]
    writeFileSync(
      join(sharedRoot.root, 'unsafe.tsx'),
      'export type UnsafeBridge = { method: string; params: unknown }\n'
    )
    assert.throws(
      () => verifyCodexNativeRuntimeBoundaries(fixture),
      /shared:generic-app-server-request/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects a legacy provider import in renderer-facing JavaScript', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-renderer-provider-boundary-'))
  try {
    const fixture = makeClassifiedFixture(root)
    const rendererRoot = fixture.productionRoots.find((entry) => entry.label === 'renderer')
    rendererRoot.rules = [
      [
        'legacy-provider-import',
        /(?:from\s+|import\s*\(\s*)['"]@janole\/ai-sdk-provider-codex-asp(?:\/[^'"]*)?['"]/u
      ]
    ]
    writeFileSync(
      join(rendererRoot.root, 'unsafe.jsx'),
      "import { legacy } from '@janole/ai-sdk-provider-codex-asp'\n"
    )
    assert.throws(
      () => verifyCodexNativeRuntimeBoundaries(fixture),
      /renderer:legacy-provider-import/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('classifies production, tests, and compatibility fixtures across source extensions', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-native-classification-'))
  try {
    const report = verifyCodexNativeRuntimeBoundaries(makeClassifiedFixture(root))
    assert.equal(report.ok, true)
    assert.equal(report.scanned.production.files, sourceExtensions.length)
    assert.equal(report.scanned.tests.files, sourceExtensions.length)
    assert.equal(report.scanned.compatibilityFixtures.files, sourceExtensions.length)
    for (const extension of sourceExtensions) {
      const productionCount = Object.values(report.scanned.production.roots).reduce(
        (sum, entry) => sum + entry.extensions[extension],
        0
      )
      const testCount = Object.values(report.scanned.tests.roots).reduce(
        (sum, entry) => sum + entry.extensions[extension],
        0
      )
      assert.equal(productionCount, 1, `missing production scan for ${extension}`)
      assert.equal(testCount, 1, `missing test scan for ${extension}`)
      assert.equal(
        report.scanned.compatibilityFixtures.roots['legacy-provider-tests'].extensions[extension],
        1,
        `missing compatibility fixture scan for ${extension}`
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not let test files satisfy production rule scanning', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-native-test-isolation-'))
  try {
    const fixture = makeClassifiedFixture(root)
    const mainRoot = fixture.productionRoots.find((entry) => entry.label === 'main')
    mainRoot.rules = [['ai-sdk-stream-text', /\bstreamText\s*\(/u]]
    const report = verifyCodexNativeRuntimeBoundaries(fixture)
    assert.equal(report.ok, true)
    assert.equal(report.scanned.production.files, sourceExtensions.length)
    assert.equal(report.scanned.tests.files, sourceExtensions.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects scanner config that omits a production root', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-native-missing-root-'))
  try {
    const fixture = makeClassifiedFixture(root)
    assert.throws(
      () =>
        verifyCodexNativeRuntimeBoundaries({
          ...fixture,
          productionRoots: fixture.productionRoots.filter((entry) => entry.label !== 'renderer')
        }),
      /scanner:missing-production-root/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects scanner config that omits a source extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'dascowork-native-missing-extension-'))
  try {
    const fixture = makeClassifiedFixture(root)
    assert.throws(
      () =>
        verifyCodexNativeRuntimeBoundaries({
          ...fixture,
          sourceExtensions: sourceExtensions.filter((extension) => extension !== '.tsx')
        }),
      /scanner:missing-source-extension/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
