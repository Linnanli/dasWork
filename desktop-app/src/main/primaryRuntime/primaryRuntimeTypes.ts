export type PrimaryRuntimePlatform = NodeJS.Platform
export type PrimaryRuntimeArch = NodeJS.Architecture

export type PrimaryRuntimeRelativePath = string

export type PrimaryRuntimePackageManifest = {
  name: string
  version?: string
  path: PrimaryRuntimeRelativePath
}

export type PrimaryRuntimeBinaryManifest = {
  name: string
  path: PrimaryRuntimeRelativePath
  required?: boolean
}

export type PrimaryRuntimeManifest = {
  bundleFormatVersion: 1 | 2
  bundleVersion: string
  target: {
    platform: PrimaryRuntimePlatform
    arch: PrimaryRuntimeArch
  }
  node: {
    path: PrimaryRuntimeRelativePath
    version?: string
  }
  nodePackages: PrimaryRuntimePackageManifest[]
  python?: {
    path: PrimaryRuntimeRelativePath
    version?: string
    packages?: PrimaryRuntimePackageManifest[]
  }
  binaries?: PrimaryRuntimeBinaryManifest[]
  bundledPlugins?: Array<{
    marketplace: string
    path: PrimaryRuntimeRelativePath
  }>
}

export type PrimaryRuntimeResolvedPackage = {
  name: string
  version?: string
  path: string
}

export type PrimaryRuntimeResolvedBinary = {
  name: string
  path: string
}

export type PrimaryRuntimeDependencies = {
  root: string
  bundleVersion: string
  node: {
    path: string
    version?: string
  }
  nodePackages: PrimaryRuntimeResolvedPackage[]
  python?: {
    path: string
    version?: string
    packages: PrimaryRuntimeResolvedPackage[]
  }
  binaries: PrimaryRuntimeResolvedBinary[]
}

export type WorkspaceDependencyLoadResult = {
  bundleVersion: string
  root: string
  node: string
  nodeModules: string
  nodePackages: PrimaryRuntimeResolvedPackage[]
  python?: string
  pythonPackages: PrimaryRuntimeResolvedPackage[]
  binaries: Record<string, string>
  paths: {
    node: string
    nodeModules: string
    python?: string
    binaries: Record<string, string>
  }
  text: string
}

export type PrimaryRuntimeIssueCode =
  | 'missing-runtime'
  | 'missing-manifest'
  | 'invalid-manifest'
  | 'unsupported-target'
  | 'path-escape'
  | 'missing-file'
  | 'missing-directory'
  | 'not-executable'
  | 'missing-package'
  | 'invalid-package'
  | 'missing-package-entry'

export type PrimaryRuntimeDiagnosticIssue = {
  code: PrimaryRuntimeIssueCode
  message: string
  path?: string
}

export type PrimaryRuntimeDiagnosticStatus = 'ready' | 'missing' | 'broken' | 'unsupported'

export type PrimaryRuntimeDiagnostic = {
  status: PrimaryRuntimeDiagnosticStatus
  root?: string
  manifest?: PrimaryRuntimeManifest
  dependencies?: PrimaryRuntimeDependencies
  issues: PrimaryRuntimeDiagnosticIssue[]
}

export type PrimaryRuntimeReadyDiagnostic = PrimaryRuntimeDiagnostic & {
  status: 'ready'
  root: string
  manifest: PrimaryRuntimeManifest
  dependencies: PrimaryRuntimeDependencies
}

export type PrimaryRuntimeReleaseDescriptor = {
  version: string
  archiveFormat: 'zip'
  archiveSizeBytes: number
  archiveSha256: string
}

export type PrimaryRuntimeUpdateStatus =
  | {
      status: 'idle'
      activeVersion?: string
      cleanedStagingCount: number
    }
  | {
      status: 'installing'
      version: string
    }
  | {
      status: 'failed'
      message: string
      activeVersion?: string
      cleanedStagingCount: number
    }
