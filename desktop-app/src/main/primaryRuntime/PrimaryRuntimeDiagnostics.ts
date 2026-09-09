import { access, readFile, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  PRIMARY_RUNTIME_MANIFEST_FILENAME,
  readPrimaryRuntimeManifest
} from './PrimaryRuntimeManifest'
import type {
  PrimaryRuntimeBinaryManifest,
  PrimaryRuntimeDependencies,
  PrimaryRuntimeDiagnostic,
  PrimaryRuntimeDiagnosticIssue,
  PrimaryRuntimeManifest,
  PrimaryRuntimePackageManifest,
  PrimaryRuntimeResolvedPackage
} from './primaryRuntimeTypes'

export type PrimaryRuntimeDiagnosticsInput = {
  platform?: NodeJS.Platform
  arch?: NodeJS.Architecture
}

const REQUIRED_NODE_PACKAGE = '@oai/artifact-tool'

export class PrimaryRuntimeDiagnostics {
  private readonly platform: NodeJS.Platform
  private readonly arch: NodeJS.Architecture

  constructor(input: PrimaryRuntimeDiagnosticsInput = {}) {
    this.platform = input.platform ?? process.platform
    this.arch = input.arch ?? process.arch
  }

  async diagnose(root: string): Promise<PrimaryRuntimeDiagnostic> {
    const issues: PrimaryRuntimeDiagnosticIssue[] = []
    const runtimeRoot = await resolveRuntimeRoot(root)
    if (!runtimeRoot) {
      return {
        status: 'missing',
        issues: [{ code: 'missing-runtime', message: 'Primary Runtime root is missing.' }]
      }
    }

    let manifest: PrimaryRuntimeManifest
    try {
      manifest = await readPrimaryRuntimeManifest(
        join(runtimeRoot, PRIMARY_RUNTIME_MANIFEST_FILENAME)
      )
    } catch {
      return {
        status: 'broken',
        root: runtimeRoot,
        issues: [
          {
            code: 'invalid-manifest',
            message: 'Primary Runtime manifest is missing or invalid.',
            path: join(runtimeRoot, PRIMARY_RUNTIME_MANIFEST_FILENAME)
          }
        ]
      }
    }

    if (manifest.target.platform !== this.platform || manifest.target.arch !== this.arch) {
      return {
        status: 'unsupported',
        root: runtimeRoot,
        manifest,
        issues: [
          {
            code: 'unsupported-target',
            message: `Primary Runtime targets ${manifest.target.platform}/${manifest.target.arch}, not ${this.platform}/${this.arch}.`
          }
        ]
      }
    }

    const nodePath = await resolveRuntimeFile(runtimeRoot, manifest.node.path, issues, {
      executable: true
    })
    const nodePackages = await resolveNodePackages(runtimeRoot, manifest.nodePackages, issues)
    if (!nodePackages.some((entry) => entry.name === REQUIRED_NODE_PACKAGE)) {
      issues.push({
        code: 'missing-package',
        message: `Primary Runtime is missing ${REQUIRED_NODE_PACKAGE}.`
      })
    }

    const pythonPath = manifest.python
      ? await resolveRuntimeFile(runtimeRoot, manifest.python.path, issues, { executable: true })
      : null
    const pythonPackages = manifest.python?.packages
      ? await resolveDirectories(runtimeRoot, manifest.python.packages, issues)
      : []
    const binaries = await resolveBinaries(runtimeRoot, manifest.binaries ?? [], issues)

    if (issues.length > 0 || !nodePath) {
      return { status: 'broken', root: runtimeRoot, manifest, issues }
    }

    const dependencies: PrimaryRuntimeDependencies = {
      root: runtimeRoot,
      bundleVersion: manifest.bundleVersion,
      node: {
        path: nodePath,
        ...(manifest.node.version ? { version: manifest.node.version } : {})
      },
      nodePackages,
      ...(manifest.python && pythonPath
        ? {
            python: {
              path: pythonPath,
              ...(manifest.python.version ? { version: manifest.python.version } : {}),
              packages: pythonPackages
            }
          }
        : {}),
      binaries
    }

    return { status: 'ready', root: runtimeRoot, manifest, dependencies, issues: [] }
  }
}

async function resolveNodePackages(
  root: string,
  packages: readonly PrimaryRuntimePackageManifest[],
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<PrimaryRuntimeResolvedPackage[]> {
  const resolved: PrimaryRuntimeResolvedPackage[] = []
  for (const entry of packages) {
    const path = await resolveRuntimeDirectory(root, entry.path, issues)
    if (!path) continue
    if (!(await validateNodePackage(path, entry, issues))) continue
    resolved.push({
      name: entry.name,
      ...(entry.version ? { version: entry.version } : {}),
      path
    })
  }
  return resolved
}

async function resolveDirectories(
  root: string,
  packages: readonly PrimaryRuntimePackageManifest[],
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<PrimaryRuntimeResolvedPackage[]> {
  const resolved: PrimaryRuntimeResolvedPackage[] = []
  for (const entry of packages) {
    const path = await resolveRuntimeDirectory(root, entry.path, issues)
    if (!path) continue
    resolved.push({
      name: entry.name,
      ...(entry.version ? { version: entry.version } : {}),
      path
    })
  }
  return resolved
}

async function validateNodePackage(
  packageRoot: string,
  entry: PrimaryRuntimePackageManifest,
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<boolean> {
  const packageJsonPath = join(packageRoot, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as Record<string, unknown>
  } catch {
    issues.push({
      code: 'invalid-package',
      message: 'Node package manifest is missing or invalid.',
      path: packageJsonPath
    })
    return false
  }

  if (manifest.name !== entry.name) {
    issues.push({
      code: 'invalid-package',
      message: `Node package name does not match ${entry.name}.`,
      path: packageJsonPath
    })
    return false
  }
  if (entry.version && manifest.version !== entry.version) {
    issues.push({
      code: 'invalid-package',
      message: `Node package version does not match ${entry.version}.`,
      path: packageJsonPath
    })
    return false
  }

  const entryPath = await resolveNodePackageEntry(packageRoot, manifest, issues)
  return Boolean(entryPath)
}

async function resolveNodePackageEntry(
  packageRoot: string,
  manifest: Record<string, unknown>,
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<string | null> {
  const candidates = packageEntryCandidates(manifest)
  for (const candidate of candidates) {
    const resolved = await resolveRuntimeFile(packageRoot, candidate, [], { executable: false })
    if (resolved) return resolved
  }

  issues.push({
    code: 'missing-package-entry',
    message: 'Node package entry point is missing.',
    path: packageRoot
  })
  return null
}

function packageEntryCandidates(manifest: Record<string, unknown>): string[] {
  const candidates: string[] = []
  const bin = manifest.bin
  if (typeof bin === 'string') candidates.push(bin)
  if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === 'string') candidates.push(value)
    }
  }
  for (const field of ['main', 'module']) {
    const value = manifest[field]
    if (typeof value === 'string') candidates.push(value)
  }
  const exportsField = manifest.exports
  if (typeof exportsField === 'string') candidates.push(exportsField)
  if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const dotExport = (exportsField as Record<string, unknown>)['.']
    if (typeof dotExport === 'string') candidates.push(dotExport)
    if (dotExport !== null && typeof dotExport === 'object' && !Array.isArray(dotExport)) {
      for (const value of Object.values(dotExport as Record<string, unknown>)) {
        if (typeof value === 'string') candidates.push(value)
      }
    }
  }
  candidates.push('index.js')
  return [...new Set(candidates)]
}

async function resolveBinaries(
  root: string,
  binaries: readonly PrimaryRuntimeBinaryManifest[],
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<Array<{ name: string; path: string }>> {
  const resolved: Array<{ name: string; path: string }> = []
  for (const entry of binaries) {
    const path = await resolveRuntimeFile(root, entry.path, issues, { executable: true })
    if (path) resolved.push({ name: entry.name, path })
  }
  return resolved
}

async function resolveRuntimeRoot(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(resolve(path))
    const stats = await stat(resolved)
    return stats.isDirectory() ? resolved : null
  } catch {
    return null
  }
}

async function resolveRuntimeFile(
  root: string,
  path: string,
  issues: PrimaryRuntimeDiagnosticIssue[],
  options: { executable: boolean }
): Promise<string | null> {
  const resolved = await resolveContainedPath(root, path, issues)
  if (!resolved) return null

  try {
    const stats = await stat(resolved)
    if (!stats.isFile()) {
      issues.push({ code: 'missing-file', message: 'Expected a file.', path: resolved })
      return null
    }
    if (options.executable) await assertExecutable(resolved, issues)
    return resolved
  } catch {
    issues.push({ code: 'missing-file', message: 'Expected a file.', path: resolved })
    return null
  }
}

async function resolveRuntimeDirectory(
  root: string,
  path: string,
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<string | null> {
  const resolved = await resolveContainedPath(root, path, issues)
  if (!resolved) return null

  try {
    const stats = await stat(resolved)
    if (!stats.isDirectory()) {
      issues.push({ code: 'missing-directory', message: 'Expected a directory.', path: resolved })
      return null
    }
    return resolved
  } catch {
    issues.push({ code: 'missing-directory', message: 'Expected a directory.', path: resolved })
    return null
  }
}

async function resolveContainedPath(
  root: string,
  path: string,
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<string | null> {
  try {
    const candidate = resolve(root, path)
    const resolved = await realpath(candidate)
    if (!isPathInside(root, resolved)) {
      issues.push({
        code: 'path-escape',
        message: 'Primary Runtime path resolves outside the selected runtime root.',
        path: resolved
      })
      return null
    }
    return resolved
  } catch {
    const candidate = resolve(root, path)
    if (!isPathInside(root, candidate)) {
      issues.push({
        code: 'path-escape',
        message: 'Primary Runtime path resolves outside the selected runtime root.',
        path: candidate
      })
      return null
    }
    return candidate
  }
}

async function assertExecutable(
  path: string,
  issues: PrimaryRuntimeDiagnosticIssue[]
): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await access(path, constants.X_OK)
  } catch {
    issues.push({ code: 'not-executable', message: 'Expected an executable file.', path })
  }
}

function isPathInside(root: string, path: string): boolean {
  const diff = relative(root, path)
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff))
}
