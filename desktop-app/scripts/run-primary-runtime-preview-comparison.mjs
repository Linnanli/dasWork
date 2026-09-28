#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- This launcher validates its own CLI and environment contract. */

import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')

process.exitCode = await main()

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const migrationReport = await readMigrationReport(options.migrationReport)
  const baseline = validatePreviewBaseline(migrationReport)
  await Promise.all([access(baseline.legacyRuntimeRoot), access(options.visualDirectory)])

  return runPlaywright({
    ...sanitizedEnvironment(process.env),
    DASCOWORK_PRIMARY_RUNTIME_PREVIEW_COMPARISON_E2E: '1',
    DASCOWORK_PRIMARY_RUNTIME_PREVIEW_MIGRATION_REPORT: options.migrationReport,
    DASCOWORK_R07_VISUAL_ARTIFACT_DIRECTORY: options.visualDirectory,
    DASCOWORK_PRIMARY_RUNTIME_ROOT: baseline.legacyRuntimeRoot
  })
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`)
    }
    values.set(key.slice(2), value)
    index += 1
  }
  const migrationReport = values.get('migration-report')
  const visualDirectory = values.get('visual-directory')
  if (!migrationReport || !visualDirectory) {
    throw new Error(
      'Usage: node scripts/run-primary-runtime-preview-comparison.mjs --migration-report <json> --visual-directory <r07-visual>'
    )
  }
  return {
    migrationReport: resolve(migrationReport),
    visualDirectory: resolve(visualDirectory)
  }
}

async function readMigrationReport(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function validatePreviewBaseline(report) {
  const baseline = report?.previewBaseline
  if (
    !baseline ||
    typeof baseline.legacyRuntimeRoot !== 'string' ||
    baseline.legacyRuntimeRoot.length === 0 ||
    typeof baseline.legacyArchiveSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(baseline.legacyArchiveSha256) ||
    typeof baseline.cacheRoot !== 'string' ||
    baseline.cacheRoot.length === 0
  ) {
    throw new Error('Migration report previewBaseline does not describe a verified legacy Runtime.')
  }
  const target = typeof baseline.target === 'string' ? baseline.target : reportTarget(report)
  if (target && target !== currentNativeTarget()) {
    throw new Error(`Migration report target ${target} does not match ${currentNativeTarget()}.`)
  }
  return baseline
}

function reportTarget(report) {
  return typeof report?.target === 'string' ? report.target : undefined
}

function currentNativeTarget() {
  return `${process.platform}-${process.arch}`
}

function sanitizedEnvironment(env) {
  const next = { ...env }
  for (const key of Object.keys(next)) {
    if (
      key === 'CODEX_APP_SERVER_BIN' ||
      key === 'DASCOWORK_APP_TOOLS_LIVE_TRACE_REPORT' ||
      key === 'DASCOWORK_R07_VISUAL_ARTIFACT_DIRECTORY' ||
      key === 'DASCOWORK_PRIMARY_RUNTIME_ROOT' ||
      key === 'DASCOWORK_PRIMARY_RUNTIME_ARCHIVE_URL' ||
      key === 'DASCOWORK_PRIMARY_RUNTIME_PREVIEW_COMPARISON_E2E' ||
      key === 'DASCOWORK_PRIMARY_RUNTIME_PREVIEW_MIGRATION_REPORT' ||
      key.startsWith('DASCOWORK_PRIMARY_RUNTIME_CONFIG_') ||
      key.startsWith('DASCOWORK_PRIMARY_RUNTIME_FEED_') ||
      key.startsWith('DASCOWORK_PRIMARY_RUNTIME_PACKAGED_')
    ) {
      delete next[key]
    }
  }
  return next
}

function runPlaywright(environment) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(appRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
        'test',
        'tests/e2e/primary-runtime-preview-comparison.e2e.ts',
        '--reporter=line'
      ],
      {
        cwd: appRoot,
        env: environment,
        stdio: 'inherit'
      }
    )
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}
