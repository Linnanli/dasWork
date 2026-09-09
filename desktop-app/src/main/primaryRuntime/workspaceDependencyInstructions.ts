import type { PrimaryRuntimeDependencies } from './primaryRuntimeTypes'

export function formatWorkspaceDependencies(dependencies: PrimaryRuntimeDependencies): string {
  const lines = [
    `Primary Runtime bundle: ${dependencies.bundleVersion}`,
    `Primary Runtime root: ${dependencies.root}`,
    `Node: ${formatPathWithVersion(dependencies.node.path, dependencies.node.version)}`
  ]

  if (dependencies.nodePackages.length > 0) {
    lines.push('Node packages:')
    for (const entry of dependencies.nodePackages) {
      lines.push(`- ${entry.name}: ${formatPathWithVersion(entry.path, entry.version)}`)
    }
  }

  if (dependencies.python) {
    lines.push(
      `Python: ${formatPathWithVersion(dependencies.python.path, dependencies.python.version)}`
    )
    if (dependencies.python.packages.length > 0) {
      lines.push('Python packages:')
      for (const entry of dependencies.python.packages) {
        lines.push(`- ${entry.name}: ${formatPathWithVersion(entry.path, entry.version)}`)
      }
    }
  }

  if (dependencies.binaries.length > 0) {
    lines.push('Binaries:')
    for (const entry of dependencies.binaries) lines.push(`- ${entry.name}: ${entry.path}`)
  }

  return `${lines.join('\n')}\n`
}

function formatPathWithVersion(path: string, version?: string): string {
  return version ? `${path} (${version})` : path
}
