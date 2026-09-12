import { sep } from 'node:path'

import type { PrimaryRuntimeDependencies } from './primaryRuntimeTypes'

export function formatWorkspaceDependencies(dependencies: PrimaryRuntimeDependencies): string {
  const lines = [
    'Use only the following verified Primary Runtime paths. Do not use a system toolchain,',
    'discover a Runtime root, or install dependencies online.',
    `Runtime Node: ${formatPathWithVersion(dependencies.node.path, dependencies.node.version)}`
  ]

  const nodeModules = nodeModulesRootFrom(dependencies.nodePackages[0]?.path)
  if (nodeModules) lines.push(`Runtime Node modules: ${nodeModules}`)

  if (dependencies.python) {
    lines.push(`Runtime Python: ${formatPathWithVersion(dependencies.python.path, dependencies.python.version)}`)
  }

  if (dependencies.binaries.length > 0) {
    lines.push('Runtime binaries:')
    for (const entry of dependencies.binaries) lines.push(`- ${entry.name}: ${entry.path}`)
  }

  return `${lines.join('\n')}\n`
}

function formatPathWithVersion(path: string, version?: string): string {
  return version ? `${path} (${version})` : path
}

function nodeModulesRootFrom(path: string | undefined): string | null {
  if (!path) return null
  const segments = path.split(sep)
  const nodeModulesIndex = segments.lastIndexOf('node_modules')
  if (nodeModulesIndex < 0) return null
  return segments.slice(0, nodeModulesIndex + 1).join(sep) || sep
}
