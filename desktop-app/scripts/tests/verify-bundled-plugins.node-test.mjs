/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node test fixtures are validated through their assertions. */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const appRoot = resolve(import.meta.dirname, '..', '..')
const repoRoot = resolve(appRoot, '..')

test('verify-bundled-plugins accepts the pinned repository resources', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-bundled-plugins.mjs'], {
    cwd: appRoot,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Bundled plugin resources verified: 8 files/u)
})

test('sync-codex-app-tools-bundle regenerates only the repository-owned lock', () => {
  const regenerate = spawnSync(process.execPath, ['scripts/sync-codex-app-tools-bundle.mjs'], {
    cwd: appRoot,
    encoding: 'utf8'
  })
  assert.equal(regenerate.status, 0, regenerate.stderr)

  const externalSource = spawnSync(
    process.execPath,
    ['scripts/sync-codex-app-tools-bundle.mjs', '--source', '/tmp/codex-app-tools'],
    {
      cwd: appRoot,
      encoding: 'utf8'
    }
  )
  assert.notEqual(externalSource.status, 0)
  assert.match(externalSource.stderr, /external --source input is not supported/u)
})

test('verify-bundled-plugins fails closed for public release before independent review', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/verify-bundled-plugins.mjs', '--public-release'],
    {
      cwd: appRoot,
      encoding: 'utf8'
    }
  )
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /has not passed independent review/u)
})

test('verify-bundled-plugins rejects any allowlist drift', async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), 'dascowork-bundled-verifier-'))
  try {
    await copyFixtureDirectory(resolve(repoRoot, 'desktop-app'), join(tempRepo, 'desktop-app'))
    await writeFile(
      join(
        tempRepo,
        'desktop-app',
        'resources',
        'bundled-plugins',
        'openai-bundled',
        'plugins',
        'codex-app-tools',
        'unexpected.txt'
      ),
      'unexpected'
    )
    const result = spawnSync(process.execPath, ['scripts/verify-bundled-plugins.mjs'], {
      cwd: join(tempRepo, 'desktop-app'),
      encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Unexpected bundled plugin files/u)
  } finally {
    await rm(tempRepo, { recursive: true, force: true })
  }
})

test('verify-bundled-plugins rejects pinned SHA drift', async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), 'dascowork-bundled-verifier-'))
  try {
    await copyFixtureDirectory(resolve(repoRoot, 'desktop-app'), join(tempRepo, 'desktop-app'))
    await writeFile(
      join(
        tempRepo,
        'desktop-app',
        'resources',
        'bundled-plugins',
        'openai-bundled',
        'plugins',
        'codex-app-tools',
        'server.mjs'
      ),
      'tampered'
    )
    const result = spawnSync(process.execPath, ['scripts/verify-bundled-plugins.mjs'], {
      cwd: join(tempRepo, 'desktop-app'),
      encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /server\.mjs SHA mismatch/u)
  } finally {
    await rm(tempRepo, { recursive: true, force: true })
  }
})

test('verify-bundled-plugins rejects reference-project provenance', async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), 'dascowork-bundled-verifier-'))
  try {
    await copyFixtureDirectory(resolve(repoRoot, 'desktop-app'), join(tempRepo, 'desktop-app'))
    const lockPath = join(
      tempRepo,
      'desktop-app',
      'resources',
      'bundled-plugins',
      'openai-bundled',
      'bundle-lock.json'
    )
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    lock.plugins[0].provenance.sourcePath = 'desktop-app/reference-projects/codex-app-tools'
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

    const result = spawnSync(process.execPath, ['scripts/verify-bundled-plugins.mjs'], {
      cwd: join(tempRepo, 'desktop-app'),
      encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /outside reference-projects/u)
  } finally {
    await rm(tempRepo, { recursive: true, force: true })
  }
})

test('verify-bundled-plugins rejects the known proprietary server digest', async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), 'dascowork-bundled-verifier-'))
  try {
    await copyFixtureDirectory(resolve(repoRoot, 'desktop-app'), join(tempRepo, 'desktop-app'))
    const lockPath = join(
      tempRepo,
      'desktop-app',
      'resources',
      'bundled-plugins',
      'openai-bundled',
      'bundle-lock.json'
    )
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    lock.plugins[0].files.find((file) => file.path === 'server.mjs').sha256 =
      '2a5a64f192b672261e9bb22ebf2a84d550714ba002f58e5a89eeeaca951da222'
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`)

    const result = spawnSync(process.execPath, ['scripts/verify-bundled-plugins.mjs'], {
      cwd: join(tempRepo, 'desktop-app'),
      encoding: 'utf8'
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /forbidden proprietary server digest/u)
  } finally {
    await rm(tempRepo, { recursive: true, force: true })
  }
})

/**
 * @param {string} sourceAppRoot
 * @param {string} targetAppRoot
 * @returns {Promise<void>}
 */
async function copyFixtureDirectory(sourceAppRoot, targetAppRoot) {
  const files = [
    'scripts/verify-bundled-plugins.mjs',
    'resources/bundled-plugins/openai-bundled/bundle-lock.json',
    'resources/bundled-plugins/openai-bundled/.agents/plugins/marketplace.json',
    'resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/.codex-plugin/plugin.json',
    'resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/.mcp.json',
    'resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/LICENSE',
    'resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/server.mjs',
    'resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/scripts/launch_codex_app_tools_mcp',
    'resources/bundled-plugins/openai-bundled/plugins/codex-app-tools/scripts/launch_codex_app_tools_mcp.cmd'
  ]
  for (const file of files) {
    const target = join(targetAppRoot, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(sourceAppRoot, file), target)
  }
}
