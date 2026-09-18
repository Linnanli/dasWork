#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Small process launcher uses inferred JavaScript returns. */

import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const feedRunner = resolve(import.meta.dirname, 'run-primary-runtime-feed-e2e.mjs')

if (process.env.DASCOWORK_PRESENTATION_SKILL_RUNTIME_SMOKE !== '1') {
  throw new Error(
    'Set DASCOWORK_PRESENTATION_SKILL_RUNTIME_SMOKE=1 to run the presentation-skill Runtime smoke.'
  )
}

// This is intentionally an alias for the production-shaped Feed E2E. It must
// never accept an active Runtime root or invoke a Runtime executable directly:
// the evidence path is empty cache → signed Feed → Main installer → loader →
// app-server command → artifact/QA/preview.
const exitCode = await run(process.execPath, [feedRunner], {
  ...process.env,
  DASCOWORK_PRIMARY_RUNTIME_FEED_E2E: '1'
})
process.exitCode = exitCode

function run(command, args, env) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: appRoot, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}
