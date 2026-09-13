/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node test fixtures are validated through their assertions. */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import test from 'node:test'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const auditedRoots = [
  'desktop-app/src',
  'desktop-app/scripts',
  'desktop-app/tests',
  'primary-runtime',
  'services/primary-runtime-feed',
  'docs'
]
const sourceExtensions = new Set(['.json', '.md', '.mjs', '.ts', '.tsx'])

const legacyReferences = [
  {
    label: '@oai/artifact-tool',
    pattern: /@oai\/artifact-tool/giu,
    allowedPaths: new Set([
      'desktop-app/src/main/primaryRuntime/PrimaryRuntimeManifest.ts',
      'desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.test.ts'
    ])
  },
  {
    label: 'openai-primary-runtime',
    pattern: /openai-primary-runtime/giu,
    allowedPaths: new Set([
      'desktop-app/scripts/tests/primary-runtime-synthetic-feed-e2e.node-test.mjs',
      'desktop-app/src/main/primaryRuntime/PrimaryRuntimeService.test.ts',
      'primary-runtime/tests/build-runtime.node-test.mjs'
    ])
  },
  {
    label: 'presentation-engine-v1',
    pattern: /presentation-engine-v1/giu,
    allowedPaths: new Set()
  },
  {
    label: '@openai/presentations',
    pattern: /@openai\/presentations/giu,
    allowedPaths: new Set()
  }
]

test('legacy Presentation identities are restricted to explicit migration compatibility', async () => {
  const violations = []
  for (const file of await collectAuditedFiles()) {
    const path = relative(repositoryRoot, file).split('\\').join('/')
    if (path === 'desktop-app/scripts/tests/primary-runtime-legacy-surface.node-test.mjs') continue
    const source = await readFile(file, 'utf8')
    for (const reference of legacyReferences) {
      reference.pattern.lastIndex = 0
      if (!reference.pattern.test(source)) continue
      if (!reference.allowedPaths.has(path)) {
        violations.push(`${reference.label}: ${path}`)
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'legacy packages may only remain in the v2 cache decoder or migration-specific tests'
  )
})

/**
 * @returns {Promise<string[]>}
 */
async function collectAuditedFiles() {
  const files = []
  for (const root of auditedRoots) {
    await collect(resolve(repositoryRoot, root), files)
  }
  return files.sort((left, right) => left.localeCompare(right))
}

/**
 * @param {string} directory
 * @param {string[]} files
 * @returns {Promise<void>}
 */
async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await collect(path, files)
      continue
    }
    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path)
  }
}
