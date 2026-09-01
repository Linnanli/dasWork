/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import test from 'node:test'

import {
  buildReferenceIndex,
  materializeReferenceSlice,
  preserveRawAnalysisSources,
  queryReferenceIndex,
  validateReferenceIndex
} from '../lib/reference-analysis.mjs'

test('indexes readable and exact pre-format locations, then returns bounded candidates', async () => {
  const fixture = await createReferenceFixture()
  try {
    const summary = buildReferenceIndex(fixture.root)
    const entries = JSON.parse(
      await readFile(join(fixture.root, '_analysis/reference-index/entries.json'), 'utf8')
    )
    const result = await queryReferenceIndex(fixture.root, {
      terms: ['approval', 'codex'],
      limit: 3,
      contextLines: 0
    })

    assert.equal(summary.sourceMode, 'raw-mirror')
    assert.ok(
      entries.some(
        (entry) => entry.kind === 'renderer-script' && entry.path === 'webview/assets/index.js'
      )
    )
    assert.ok(summary.counts.files >= 5)
    assert.ok(summary.counts.localeSignalsRoutedToFallback > 0)
    assert.ok(result.candidates.length <= 3)
    assert.equal(result.candidates[0].path, '.vite/build/early.js')
    assert.ok(!result.candidates.some((candidate) => candidate.path.includes('zh-CN-fixture')))
    assert.ok(!result.candidates.some((candidate) => candidate.path.includes('bg-BG-fixture')))
    assert.ok(!result.candidates.some((candidate) => candidate.path.includes('lv-LV-fixture')))
    assert.equal(result.candidates[0].sourceMode, 'raw-mirror')
    assert.deepEqual(result.candidates[0].matchedTerms, ['approval', 'codex'])
    assert.equal(result.candidates[0].evidence[0].readable.line, 2)
    assert.equal(result.candidates[0].evidence[0].raw.line, 1)
    assert.ok(result.candidates[0].evidence[0].readable.column > 0)
    assert.ok(result.candidates[0].evidence[0].raw.column > 0)
    assert.notEqual(result.candidates[0].sha256.readable, result.candidates[0].sha256.raw)
    assert.match(result.candidates[0].context.readable.text, /codex:approval/u)
    assert.match(result.candidates[0].context.raw.text, /codex:approval/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('materializes an exact bounded import neighborhood with provenance', async () => {
  const fixture = await createReferenceFixture()
  try {
    buildReferenceIndex(fixture.root)
    const fakeBin = join(fixture.root, 'bin')
    const fakeGraph = join(fakeBin, 'code-review-graph')
    await mkdir(fakeBin)
    await writeFile(fakeGraph, '#!/bin/sh\nexit 0\n')
    await chmod(fakeGraph, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ''}`
    let result
    try {
      result = await materializeReferenceSlice(fixture.root, {
        name: 'approval-flow',
        files: ['.vite/build/early.js'],
        depth: 1,
        maxFiles: 5,
        buildGraph: true
      })
    } finally {
      process.env.PATH = originalPath
    }
    const copiedEntry = await readFile(join(result.sliceRoot, 'source/electron-main/early.js'))
    const sourceEntry = await readFile(join(fixture.root, '.vite/build/early.js'))
    const copiedWorker = await readFile(
      join(result.sliceRoot, 'source/electron-main/worker.js'),
      'utf8'
    )
    const provenance = JSON.parse(await readFile(result.provenance, 'utf8'))

    assert.deepEqual(copiedEntry, sourceEntry)
    assert.match(copiedWorker, /respondApproval/u)
    assert.deepEqual(provenance.files.map((file) => file.sourcePath).sort(), [
      '.vite/build/early.js',
      '.vite/build/worker.js'
    ])
    assert.equal(result.graph.status, 'built')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects stale source files instead of returning unverified context', async () => {
  const fixture = await createReferenceFixture()
  try {
    buildReferenceIndex(fixture.root)
    await writeFile(join(fixture.root, '.vite/build/early.js'), 'const changed = true\n')
    await assert.rejects(
      queryReferenceIndex(fixture.root, { terms: ['approval'] }),
      /Reference index is stale for readable source/u
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects a changed searchable inventory before ranking candidates', async () => {
  const fixture = await createReferenceFixture()
  try {
    buildReferenceIndex(fixture.root)
    await writeFile(
      join(fixture.root, '.vite/build/new-approval.js'),
      'export const approval = true\n'
    )
    await assert.rejects(
      queryReferenceIndex(fixture.root, { terms: ['approval'] }),
      /searchable file inventory changed/u
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('keeps multiple high-quality hits of the same kind in one file', async () => {
  const fixture = await createReferenceFixture()
  try {
    buildReferenceIndex(fixture.root)
    const result = await queryReferenceIndex(fixture.root, { terms: ['needle'], limit: 1 })
    assert.deepEqual(result.candidates[0].evidence.map((evidence) => evidence.value).sort(), [
      'needle alpha',
      'needle beta',
      'needle gamma'
    ])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('ranks an exact compound anchor above generic token matches', async () => {
  const fixture = await createReferenceFixture({ createRawMirror: false })
  try {
    await writeFile(
      join(fixture.root, 'webview/assets/exact-compound.js'),
      'export const icon = "a-arrow-down"\n'
    )
    for (let index = 0; index < 10; index += 1) {
      await writeFile(
        join(fixture.root, `webview/assets/generic-arrow-${index}.js`),
        `export const icon${index} = "arrow down ${index}"\n`
      )
    }
    buildReferenceIndex(fixture.root)
    const result = await queryReferenceIndex(fixture.root, {
      terms: ['a-arrow-down'],
      limit: 8
    })

    assert.equal(result.candidates[0].path, 'webview/assets/exact-compound.js')
    assert.equal(result.candidates[0].evidence[0].value, 'a-arrow-down')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('enforces compact query and source-window limits', async () => {
  const fixture = await createReferenceFixture()
  try {
    buildReferenceIndex(fixture.root)
    await assert.rejects(
      queryReferenceIndex(fixture.root, { terms: ['approval'], limit: 9 }),
      /Query limit must be an integer between 1 and 8/u
    )
    await assert.rejects(
      queryReferenceIndex(fixture.root, { terms: ['approval'], limit: 4, contextLines: 1 }),
      /Source context may include at most 3 candidate windows/u
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('keeps hostile slice names inside the generated slice directory', async () => {
  const fixture = await createReferenceFixture()
  try {
    buildReferenceIndex(fixture.root)
    const result = await materializeReferenceSlice(fixture.root, {
      name: '../..',
      files: ['.vite/build/early.js'],
      depth: 0
    })

    assert.equal(basename(result.sliceRoot), 'reference-slice')
    assert.match(result.sliceRoot, /_analysis\/semantic-slices\/reference-slice$/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('preserves the pre-format mirror and validates all indexed hashes', async () => {
  const fixture = await createReferenceFixture({ createRawMirror: false })
  try {
    await writeFile(join(fixture.root, 'webview/assets/logo.webp'), 'not indexed')
    const rawEntry = await readFile(join(fixture.root, '.vite/build/early.js'), 'utf8')
    const mirror = preserveRawAnalysisSources(fixture.root)
    await writeFile(
      join(fixture.root, '.vite/build/early.js'),
      'const channel =\n  "codex:approval"\nrequire("./worker.js")\n'
    )
    const mirroredEntry = await readFile(
      join(fixture.root, '_analysis/raw/.vite/build/early.js'),
      'utf8'
    )
    buildReferenceIndex(fixture.root)
    const validation = await validateReferenceIndex(fixture.root)

    assert.ok(mirror.files >= 5)
    assert.equal(mirroredEntry, rawEntry)
    await assert.rejects(
      readFile(join(fixture.root, '_analysis/raw/webview/assets/logo.webp')),
      /ENOENT/u
    )
    assert.equal(validation.valid, true)
    assert.equal(validation.filesChecked, validation.totalFiles)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('labels files missing from a partial raw mirror as beautified fallback', async () => {
  const fixture = await createReferenceFixture()
  try {
    await rm(join(fixture.root, '_analysis/raw/webview/assets/multiple-signals.js'))
    const summary = buildReferenceIndex(fixture.root)
    const result = await queryReferenceIndex(fixture.root, { terms: ['needle'], limit: 1 })

    assert.equal(summary.sourceMode, 'partial-raw-mirror')
    assert.equal(result.candidates[0].sourceMode, 'beautified-fallback')
    assert.equal(typeof result.candidates[0].sha256, 'string')
    assert.equal(result.candidates[0].evidence[0].raw, null)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

async function createReferenceFixture({ createRawMirror = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dascowork-reference-analysis-'))
  await mkdir(join(root, '.vite/build'), { recursive: true })
  await mkdir(join(root, 'webview/assets'), { recursive: true })
  await mkdir(join(root, '_analysis'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'reference-fixture', main: './.vite/build/early.js' }, null, 2)}\n`
  )
  await writeFile(
    join(root, '.vite/build/early.js'),
    'const channel="codex:approval";require("./worker.js");\n'
  )
  await writeFile(
    join(root, '.vite/build/worker.js'),
    'export function respondApproval(value){return value}\n'
  )
  await writeFile(
    join(root, 'webview/index.html'),
    '<script type="module" src="/assets/index.js"></script>\n'
  )
  await writeFile(
    join(root, 'webview/assets/index.js'),
    'import("./panel.js").then((module) => module.openPanel())\n'
  )
  await writeFile(
    join(root, 'webview/assets/panel.js'),
    'export const openPanel=()=>"Review changes"\n'
  )
  await writeFile(
    join(root, 'webview/assets/multiple-signals.js'),
    'console.log("needle alpha", "needle beta", "needle gamma")\n'
  )
  await writeFile(
    join(root, 'webview/assets/zh-CN-fixture.js'),
    'export const approvalTranslation="approval sandbox"\n'
  )
  await writeFile(
    join(root, 'webview/assets/bg-BG-fixture.js'),
    'export const approvalTranslation="approval sandbox"\n'
  )
  await writeFile(
    join(root, 'webview/assets/lv-LV-fixture.js'),
    'export const approvalTranslation="approval sandbox"\n'
  )
  await writeFile(
    join(root, '_analysis/manifest.json'),
    `${JSON.stringify(
      {
        source: { appVersion: '99.1.2', asarSha256: 'fixture-asar-sha' },
        reconstruction: { formatted: true }
      },
      null,
      2
    )}\n`
  )

  if (createRawMirror) {
    preserveRawAnalysisSources(root)
    await writeFile(
      join(root, '.vite/build/early.js'),
      'const channel =\n  "codex:approval"\nrequire("./worker.js")\n'
    )
  }
  return { root }
}
