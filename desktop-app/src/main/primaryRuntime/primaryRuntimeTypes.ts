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

export type PrimaryRuntimeSourceDigest = {
  path: PrimaryRuntimeRelativePath
  sha256: string
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
  /**
   * Runtime-owned standalone skills. Their source files remain inside the
   * verified Runtime; Main materializes them into its dedicated Codex skills
   * namespace only after the Runtime becomes active.
   */
  bundledSkills?: Array<{
    path: PrimaryRuntimeRelativePath
    sha256: string
  }>
  /** Legacy skill directories, relative to CODEX_HOME/skills, to retire safely. */
  skillsToRemove?: PrimaryRuntimeRelativePath[]
  /** Source receipts declared by a generic v2 Runtime release. */
  sourceDigests?: PrimaryRuntimeSourceDigest[]
  /** Read-only decoder marker for pre-generic v2 cache entries. */
  legacyV2?: true
  /**
   * Narrow marker for the repository-owned synthetic Runtime used exclusively
   * by the local signed-Feed test. It is deliberately not a general package
   * override: production manifests use only their declared package inventory.
   */
  syntheticTestOnly?: {
    kind: 'dascowork-primary-runtime-synthetic-test.v1'
    requiredNodePackage: '@dascowork/test-artifact-tool'
  }
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
  node: string
  nodeModules: string
  python?: string
  binaries: Record<string, string>
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
  | 'missing-plugin-marketplace'
  | 'bundled-skill-digest-mismatch'
  | 'bundled-skill-unreadable'
  | 'source-digest-mismatch'
  | 'synthetic-test-runtime-disallowed'

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

/**
 * Release-engineering limits signed alongside a single target archive. They
 * are deliberately distinct from the installer's broad abuse ceilings.
 */
export type PrimaryRuntimeReleaseBudget = {
  maxArchiveBytes: number
  maxUnpackedBytes: number
  minimumFreeDiskBytes: number
  maxColdInstallMs: number
  maxMainEventLoopDelayP99Ms: number
  maxMainEventLoopDelayMaxMs: number
}

export type PrimaryRuntimeReleaseDescriptor = {
  version: string
  archiveFormat: 'zip'
  archiveSizeBytes: number
  archiveSha256: string
  /** Present for signed, target-specific production feed releases. */
  budget?: PrimaryRuntimeReleaseBudget
  /** Signed manifest sequence when this descriptor came from a product feed. */
  manifestSequence?: number
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

/**
 * Renderer-safe operational state. It reports progress without exposing local
 * paths, feed endpoints, credentials, or raw implementation errors.
 */
export type PrimaryRuntimeUserState =
  | 'disabled'
  | 'resolving'
  | 'checking'
  | 'missing'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'validating'
  | 'installing'
  | 'activating'
  | 'configuring'
  | 'committing'
  | 'rolling-back'
  | 'ready'
  | 'update-available'
  | 'broken'
  | 'unsupported'
  | 'failed'

/**
 * Safe, renderer-facing Runtime state. It intentionally excludes roots,
 * archive URLs, trust origins, and raw errors.
 */
export type PrimaryRuntimeUserStatus = {
  state: PrimaryRuntimeUserState
  /** Opaque operation identity for status correlation; never a filesystem path or feed identifier. */
  operationId?: string
  /** Opaque API-call identity. It is distinct from a shared installation operation. */
  callId?: string
  currentVersion?: string
  targetVersion?: string
  manifestSequence?: number
  /** Progress counters are safe aggregate values; no archive path or endpoint is exposed. */
  downloadedBytes?: number
  downloadSizeBytes?: number
  /** The Main-owned scheduler's next planned check, never a feed endpoint. */
  nextCheckAt?: string
  failureKind?: 'network' | 'integrity' | 'storage' | 'unsupported' | 'provenance' | 'unavailable'
  /** Stable error category for support, retry policy, and safe telemetry. */
  failureCategory?:
    | 'aborted'
    | 'unsupported_host'
    | 'invalid_manifest'
    | 'disk_full'
    | 'permission_denied'
    | 'network_fetch_failed'
    | 'timeout'
    | 'checksum_mismatch'
    | 'http_client_error'
    | 'http_server_error'
    | 'archive_processing_failed'
    | 'validation_failed'
    | 'post_install_failed'
    | 'filesystem_error'
    | 'unknown'
  /** Internal lifecycle stage expressed as a renderer-safe, stable enum. */
  failureStage?:
    | 'resolve_manifest'
    | 'create_staging_directory'
    | 'prepare_archive'
    | 'download_archive'
    | 'verify_checksum'
    | 'list_archive'
    | 'extract_archive'
    | 'validate_payload'
    | 'activate_runtime'
    | 'validate_cached_runtime'
    | 'sync_plugins'
    | 'sync_skills'
    | 'reload_skills'
    | 'cleanup'
  /** Broad failure boundary; no URL, local path, header, or raw exception is exposed. */
  failureDomain?:
    | 'metadata'
    | 'network'
    | 'archive'
    | 'payload'
    | 'activation'
    | 'post_install'
    | 'filesystem'
    | 'unknown'
  /** Stable safe code, never the underlying Node/system error message. */
  errorCode?: string
  retryable?: boolean
  /** A post-install failure leaves the verified Runtime active but its plugin capability unavailable. */
  runtimeActive?: boolean
  pluginReady?: boolean
  message: string
  recovery: string
  canInstallOrRepair: boolean
  canRunUpdate: boolean
  canCancel: boolean
}
