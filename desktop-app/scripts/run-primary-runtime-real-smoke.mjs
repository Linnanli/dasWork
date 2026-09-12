#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Small process launcher uses inferred JavaScript returns. */

import { spawnSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const options = parseOptions(process.argv.slice(2))
const archive = options.archive ?? process.env.DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_ARCHIVE?.trim()
const version = options.version ?? process.env.DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_VERSION?.trim()
const sha256 = options.sha256 ?? process.env.DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_SHA256?.trim()

if (process.env.DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT?.trim()) {
  throw new Error(
    'The real Runtime gate accepts a P1a archive, not DASCOWORK_REAL_PRIMARY_RUNTIME_ROOT.'
  )
}
if (!archive || !version || !sha256) {
  throw new Error(
    'Expected --archive, --version, and --sha256 from the target-native P1a candidate.'
  )
}
if (!/^[a-f0-9]{64}$/iu.test(sha256)) {
  throw new Error('Primary Runtime candidate SHA256 must be a 64-character hexadecimal digest.')
}
await access(archive)

const result = spawnSync(
  'npm',
  ['exec', '--', 'vitest', 'run', 'src/main/primaryRuntime/PrimaryRuntimeRealSmoke.test.ts'],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      DASCOWORK_REAL_PRIMARY_RUNTIME_SMOKE: '1',
      DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_ARCHIVE: archive,
      DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_VERSION: version,
      DASCOWORK_PRIMARY_RUNTIME_CANDIDATE_SHA256: sha256.toLowerCase()
    },
    stdio: 'inherit'
  }
)

process.exit(result.status ?? 1)

function parseOptions(argv) {
  return {
    archive: optionValue(argv, '--archive'),
    version: optionValue(argv, '--version'),
    sha256: optionValue(argv, '--sha256')
  }
}

function optionValue(argv, name) {
  const equalsPrefix = `${name}=`
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === name) {
      const next = argv[index + 1]
      if (!next || next.startsWith('--')) throw new Error(`Expected a value after ${name}.`)
      return name === '--archive' ? resolve(next) : next
    }
    if (value.startsWith(equalsPrefix)) {
      const option = value.slice(equalsPrefix.length)
      return name === '--archive' ? resolve(option) : option
    }
  }
  return undefined
}
