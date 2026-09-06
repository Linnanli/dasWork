import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { verifyProtocolContract } from '../verify-codex-app-server-protocol-contract.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const coreRoot = resolve(desktopRoot, 'vendors/codex-app-server-client')

test('accepts the pinned generated protocol and runtime evidence', () => {
  const result = verifyProtocolContract({ coreRoot, regenerate: false })
  assert.equal(result.ok, true)
  assert.equal(result.pinnedVersion, '0.148.0-alpha.21')
})

test('rejects a manifest whose generator version diverges from the lockfile', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'dascowork-protocol-contract-test-'))
  try {
    symlinkSync(join(coreRoot, 'src'), join(temporaryRoot, 'src'), 'dir')
    const manifest = JSON.parse(readFileSync(join(coreRoot, 'protocol-manifest.json'), 'utf8'))
    manifest.schemaGenerator.version = '0.0.0'
    writeFileSync(join(temporaryRoot, 'protocol-manifest.json'), JSON.stringify(manifest))

    assert.throws(
      () => verifyProtocolContract({ coreRoot: temporaryRoot, regenerate: false }),
      /does not match pinned/u
    )
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
