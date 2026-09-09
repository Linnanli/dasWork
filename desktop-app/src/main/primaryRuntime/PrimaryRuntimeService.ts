import type { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import {
  PrimaryRuntimeInstaller,
  type PrimaryRuntimeInstallResult
} from './PrimaryRuntimeInstaller'
import { PrimaryRuntimeDiagnostics } from './PrimaryRuntimeDiagnostics'
import type { PrimaryRuntimeReleaseProvider } from './PrimaryRuntimeReleaseProvider'
import { formatWorkspaceDependencies } from './workspaceDependencyInstructions'
import { dirname, join, sep } from 'node:path'

import type {
  PrimaryRuntimeDependencies,
  PrimaryRuntimeDiagnostic,
  PrimaryRuntimeDiagnosticIssue,
  PrimaryRuntimeUpdateStatus,
  WorkspaceDependencyLoadResult
} from './primaryRuntimeTypes'

export type PrimaryRuntimeServiceInput = {
  locator: Pick<PrimaryRuntimeLocator, 'locate'>
  cacheRoot?: string
  releaseProvider?: PrimaryRuntimeReleaseProvider
  diagnostics?: PrimaryRuntimeDiagnostics
  installerOptions?: {
    availableDiskBytes?: (path: string) => Promise<number>
  }
}

export class PrimaryRuntimeService {
  private readonly diagnostics: PrimaryRuntimeDiagnostics
  private readonly installer: PrimaryRuntimeInstaller | null
  private inFlightInstall: {
    version: string | null
    versionPromise: Promise<string>
    controller: AbortController
    promise: Promise<PrimaryRuntimeInstallResult>
  } | null = null
  private lastFailure: Error | null = null

  constructor(private readonly input: PrimaryRuntimeServiceInput) {
    this.diagnostics = input.diagnostics ?? new PrimaryRuntimeDiagnostics()
    this.installer = input.cacheRoot
      ? new PrimaryRuntimeInstaller({
          cacheRoot: input.cacheRoot,
          ...(input.releaseProvider ? { releaseProvider: input.releaseProvider } : {}),
          diagnostics: this.diagnostics,
          ...input.installerOptions
        })
      : null
  }

  async diagnoseDependencies(): Promise<PrimaryRuntimeDiagnostic> {
    await this.installer?.recoverActivation()
    const candidate = await this.input.locator.locate()
    if (!candidate) {
      return {
        status: 'missing',
        issues: [{ code: 'missing-runtime', message: 'Primary Runtime is not installed.' }]
      }
    }
    return this.diagnostics.diagnose(candidate.path)
  }

  async loadDependencies(): Promise<WorkspaceDependencyLoadResult> {
    const diagnostic = await this.diagnoseDependencies()
    if (diagnostic.status !== 'ready' || !diagnostic.dependencies) {
      throw new PrimaryRuntimeUnavailableError(diagnostic)
    }

    return workspaceDependencyResultFrom(diagnostic.dependencies)
  }

  async install(): Promise<PrimaryRuntimeInstallResult> {
    return this.installOnce()
  }

  async repair(): Promise<PrimaryRuntimeInstallResult> {
    return this.installOnce()
  }

  async cancelInstall(): Promise<void> {
    this.inFlightInstall?.controller.abort()
    return undefined
  }

  async getUpdateStatus(): Promise<PrimaryRuntimeUpdateStatus> {
    if (this.inFlightInstall) {
      return {
        status: 'installing',
        version: this.inFlightInstall.version ?? (await this.inFlightInstall.versionPromise)
      }
    }

    const cleanedStagingCount = this.installer ? await this.installer.cleanupStaging() : 0
    const activeVersion = await this.activeVersion()
    if (this.lastFailure) {
      return {
        status: 'failed',
        message: this.lastFailure.message,
        ...(activeVersion ? { activeVersion } : {}),
        cleanedStagingCount
      }
    }

    return {
      status: 'idle',
      ...(activeVersion ? { activeVersion } : {}),
      cleanedStagingCount
    }
  }

  async runUpdateNow(): Promise<PrimaryRuntimeInstallResult> {
    return this.installOnce()
  }

  dispose(): void {
    this.inFlightInstall?.controller.abort()
    return undefined
  }

  private installOnce(): Promise<PrimaryRuntimeInstallResult> {
    if (!this.installer || !this.input.releaseProvider) {
      throw new Error('Primary Runtime release provider is not configured.')
    }
    if (this.inFlightInstall) return this.inFlightInstall.promise

    const controller = new AbortController()
    const inFlight: {
      version: string | null
      versionPromise: Promise<string>
      controller: AbortController
      promise: Promise<PrimaryRuntimeInstallResult>
    } = {
      version: null,
      versionPromise: Promise.resolve('pending'),
      controller,
      promise: Promise.resolve(null as unknown as PrimaryRuntimeInstallResult)
    }

    const descriptorPromise = this.input.releaseProvider.getRelease().then((descriptor) => {
      if (!descriptor) throw new Error('Primary Runtime release descriptor is not configured.')
      inFlight.version = descriptor.version
      return descriptor
    })
    inFlight.versionPromise = descriptorPromise.then((descriptor) => descriptor.version)

    const promise = descriptorPromise
      .then((descriptor) => {
        return this.installer!.install(controller.signal, descriptor)
      })
      .then((result) => {
        this.lastFailure = null
        return result
      })
      .catch((error) => {
        this.lastFailure = error instanceof Error ? error : new Error(String(error))
        throw error
      })
      .finally(() => {
        if (this.inFlightInstall?.promise === promise) this.inFlightInstall = null
      })

    inFlight.promise = promise
    this.inFlightInstall = inFlight
    return promise
  }

  private async activeVersion(): Promise<string | undefined> {
    const diagnostic = await this.diagnoseDependencies()
    return diagnostic.status === 'ready' ? diagnostic.manifest?.bundleVersion : undefined
  }
}

export class PrimaryRuntimeUnavailableError extends Error {
  readonly status: Exclude<PrimaryRuntimeDiagnostic['status'], 'ready'>
  readonly issues: PrimaryRuntimeDiagnosticIssue[]

  constructor(readonly diagnostic: PrimaryRuntimeDiagnostic) {
    super(reasonForDiagnostic(diagnostic))
    this.name = 'PrimaryRuntimeUnavailableError'
    this.status = diagnostic.status === 'ready' ? 'broken' : diagnostic.status
    this.issues = diagnostic.issues
  }
}

function workspaceDependencyResultFrom(
  dependencies: PrimaryRuntimeDependencies
): WorkspaceDependencyLoadResult {
  const binaries = Object.fromEntries(
    dependencies.binaries.map((entry) => [entry.name, entry.path] as const)
  )
  const artifactToolPath = dependencies.nodePackages.find(
    (entry) => entry.name === '@oai/artifact-tool'
  )?.path
  const nodeModules =
    nodeModulesRootFrom(artifactToolPath ?? dependencies.nodePackages[0]?.path) ??
    join(dependencies.root, 'node_modules')

  return {
    bundleVersion: dependencies.bundleVersion,
    root: dependencies.root,
    node: dependencies.node.path,
    nodeModules,
    nodePackages: dependencies.nodePackages,
    ...(dependencies.python ? { python: dependencies.python.path } : {}),
    pythonPackages: dependencies.python?.packages ?? [],
    binaries,
    paths: {
      node: dependencies.node.path,
      nodeModules,
      ...(dependencies.python ? { python: dependencies.python.path } : {}),
      binaries
    },
    text: formatWorkspaceDependencies(dependencies)
  }
}

function nodeModulesRootFrom(path: string | undefined): string | null {
  if (!path) return null
  const segments = path.split(sep)
  const nodeModulesIndex = segments.lastIndexOf('node_modules')
  if (nodeModulesIndex < 0) return dirname(path)
  return segments.slice(0, nodeModulesIndex + 1).join(sep) || sep
}

function reasonForDiagnostic(diagnostic: PrimaryRuntimeDiagnostic): string {
  const firstIssue = diagnostic.issues[0]
  if (firstIssue) return firstIssue.message
  if (diagnostic.status === 'missing') return 'Primary Runtime is not installed.'
  if (diagnostic.status === 'unsupported') return 'Primary Runtime is not supported on this host.'
  return 'Primary Runtime is not healthy.'
}
