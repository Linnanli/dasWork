import type { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import {
  PrimaryRuntimeInstaller,
  type PrimaryRuntimeInstallBudget,
  type PrimaryRuntimeInstallResult,
  type PrimaryRuntimeInstallerProgress
} from './PrimaryRuntimeInstaller'
import { PrimaryRuntimeDiagnostics } from './PrimaryRuntimeDiagnostics'
import { PrimaryRuntimePostInstallError } from './PrimaryRuntimePostInstallError'
import {
  PrimaryRuntimeActivationTransaction,
  type PrimaryRuntimeActivationProgress,
  type PrimaryRuntimeActivationResult
} from './PrimaryRuntimeActivationTransaction'
import type { PrimaryRuntimeReleaseProvider } from './PrimaryRuntimeReleaseProvider'
import { formatWorkspaceDependencies } from './workspaceDependencyInstructions'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, sep } from 'node:path'

import type {
  PrimaryRuntimeDependencies,
  PrimaryRuntimeDiagnostic,
  PrimaryRuntimeDiagnosticIssue,
  PrimaryRuntimeReleaseDescriptor,
  PrimaryRuntimeUserState,
  PrimaryRuntimeUserStatus,
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
    releaseBudget?: PrimaryRuntimeInstallBudget
  }
  activationTransaction?: Pick<PrimaryRuntimeActivationTransaction, 'activate' | 'recover'>
  /** Runs after Runtime publication to synchronize its app-server-owned plugins and skills. */
  postActivation?: (result: PrimaryRuntimeActivationResult) => Promise<void>
  /**
   * Main-owned telemetry sink. It receives only correlation-safe metadata and
   * an irreversible fingerprint for sensitive failure detail.
   */
  onTelemetry?: (event: PrimaryRuntimeTelemetryEvent) => void | Promise<void>
  /** Enables only the repository-owned synthetic Runtime used by Feed E2E. */
  allowSyntheticTestRuntime?: boolean
}

export type PrimaryRuntimeTelemetryEvent = {
  name:
    | 'primary_runtime_install_call_joined'
    | 'primary_runtime_install_call_completed'
    | 'primary_runtime_install_operation_failed'
  safe: {
    callId: string
    operationId: string
    trigger: 'install' | 'repair' | 'manual-update' | 'scheduled-update'
    release: string | null
    target: string
    bundleVersion: string | null
    phase: PrimaryRuntimeUserState
    failureCategory?: NonNullable<PrimaryRuntimeUserStatus['failureCategory']>
    failureStage?: NonNullable<PrimaryRuntimeUserStatus['failureStage']>
    failureDomain?: NonNullable<PrimaryRuntimeUserStatus['failureDomain']>
    errorCode?: string
    retryable?: boolean
  }
  /** Raw paths, URLs, headers, and errors never leave Main through this shape. */
  sensitive?: {
    redactionApplied: true
    errorFingerprint: string
  }
}

/**
 * One caller's view of an install request. Concurrent callers intentionally
 * receive different call IDs while sharing the same durable operation ID.
 */
export type PrimaryRuntimeInstallCallResult = PrimaryRuntimeInstallResult & {
  callId: string
  operationId: string
}

export type PrimaryRuntimeInstallCallError = Error & {
  callId: string
  operationId: string
}

export type PrimaryRuntimeUpdateCheck = {
  available: boolean
  version: string
  activeVersion?: string
}

export class PrimaryRuntimeService {
  private readonly diagnostics: PrimaryRuntimeDiagnostics
  private readonly installer: PrimaryRuntimeInstaller | null
  private readonly activationTransaction: Pick<
    PrimaryRuntimeActivationTransaction,
    'activate' | 'recover'
  > | null
  private inFlightInstall: {
    version: string | null
    versionPromise: Promise<string>
    controller: AbortController
    promise: Promise<PrimaryRuntimeActivationResult>
    state: Extract<
      PrimaryRuntimeUserState,
      | 'resolving'
      | 'checking'
      | 'downloading'
      | 'verifying'
      | 'extracting'
      | 'validating'
      | 'installing'
      | 'activating'
      | 'configuring'
      | 'committing'
      | 'rolling-back'
    >
    callId: string
    operationId: string
    trigger: PrimaryRuntimeTelemetryEvent['safe']['trigger']
    downloadedBytes?: number
    downloadSizeBytes?: number
    activeVersion?: string
    manifestSequence?: number
    runtimeActive?: boolean
    pluginReady?: boolean
  } | null = null
  private lastFailure: PrimaryRuntimeFailure | null = null
  // Update checks run in the background, but their renderer-safe outcome must
  // not be mistaken for an unconfigured or merely missing Runtime.
  private lastUpdateCheckFailure: PrimaryRuntimeFailure | null = null
  private lastReleaseDescriptor: PrimaryRuntimeReleaseDescriptor | undefined
  private nextUpdateCheckAt: string | undefined
  private checkingForUpdate = false
  private updateAvailable = false
  private checkedActiveVersion: string | undefined
  private updateCheckPromise: Promise<PrimaryRuntimeUpdateCheck> | null = null
  private postActivation: ((result: PrimaryRuntimeActivationResult) => Promise<void>) | undefined
  private readonly statusListeners = new Set<() => void>()

  constructor(private readonly input: PrimaryRuntimeServiceInput) {
    this.diagnostics =
      input.diagnostics ??
      new PrimaryRuntimeDiagnostics({
        allowSyntheticTestRuntime: input.allowSyntheticTestRuntime
      })
    this.installer = input.cacheRoot
      ? new PrimaryRuntimeInstaller({
          cacheRoot: input.cacheRoot,
          ...(input.releaseProvider ? { releaseProvider: input.releaseProvider } : {}),
          diagnostics: this.diagnostics,
          onProgress: (progress) => this.setInstallerProgress(progress),
          ...input.installerOptions
        })
      : null
    this.postActivation = input.postActivation
    this.activationTransaction =
      this.installer && input.cacheRoot
        ? (input.activationTransaction ??
          new PrimaryRuntimeActivationTransaction({
            cacheRoot: input.cacheRoot,
            installer: this.installer,
            diagnostics: this.diagnostics,
            onProgress: (progress) => this.setInstallProgress(progress)
          }))
        : null
  }

  /** Plugin/skill sync may change only between installations. */
  setPostActivationHook(
    hook: ((result: PrimaryRuntimeActivationResult) => Promise<void>) | undefined
  ): void {
    if (this.inFlightInstall) {
      throw new Error('Primary Runtime post-activation hook cannot change during an installation.')
    }
    this.postActivation = hook
  }

  async diagnoseDependencies(): Promise<PrimaryRuntimeDiagnostic> {
    if (!this.inFlightInstall) {
      await this.activationTransaction?.recover()
      await this.installer?.recoverActivation()
    }
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

  async install(): Promise<PrimaryRuntimeInstallCallResult> {
    return this.installOnce(undefined, 'install')
  }

  async repair(): Promise<PrimaryRuntimeInstallCallResult> {
    return this.installOnce(undefined, 'repair')
  }

  async cancelInstall(): Promise<void> {
    this.inFlightInstall?.controller.abort()
    if (this.inFlightInstall) this.inFlightInstall.state = 'rolling-back'
    this.notifyStatusListeners()
    return undefined
  }

  /** Main-only change notification for fixed UI state, never a Runtime path or feed value. */
  subscribeStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  /** Main-owned scheduler hint for the renderer-safe status surface. */
  setNextUpdateCheckAt(nextCheckAt: Date | undefined): void {
    this.nextUpdateCheckAt = nextCheckAt?.toISOString()
    this.notifyStatusListeners()
  }

  /** Returns user-safe state without leaking feed configuration or local paths. */
  async getUserStatus(): Promise<PrimaryRuntimeUserStatus> {
    const configured = Boolean(this.installer && this.input.releaseProvider)
    if (!configured) {
      return {
        state: 'disabled',
        message: '此版本尚未配置 Primary Runtime 发布服务。',
        recovery: '请联系管理员配置受信任的 Runtime 发布服务。',
        canInstallOrRepair: false,
        canRunUpdate: false,
        canCancel: false,
        ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
      }
    }

    if (this.inFlightInstall) {
      return {
        state: this.inFlightInstall.state,
        callId: this.inFlightInstall.callId,
        ...(this.inFlightInstall.operationId
          ? { operationId: this.inFlightInstall.operationId }
          : {}),
        ...(this.inFlightInstall.version ? { targetVersion: this.inFlightInstall.version } : {}),
        ...(this.inFlightInstall.activeVersion
          ? { currentVersion: this.inFlightInstall.activeVersion }
          : {}),
        ...(this.inFlightInstall.manifestSequence
          ? { manifestSequence: this.inFlightInstall.manifestSequence }
          : {}),
        ...(this.inFlightInstall.runtimeActive !== undefined
          ? { runtimeActive: this.inFlightInstall.runtimeActive }
          : {}),
        ...(this.inFlightInstall.pluginReady !== undefined
          ? { pluginReady: this.inFlightInstall.pluginReady }
          : {}),
        ...(this.inFlightInstall.state === 'downloading' &&
        this.inFlightInstall.downloadedBytes !== undefined
          ? { downloadedBytes: this.inFlightInstall.downloadedBytes }
          : {}),
        ...(this.inFlightInstall.state === 'downloading' &&
        this.inFlightInstall.downloadSizeBytes !== undefined
          ? { downloadSizeBytes: this.inFlightInstall.downloadSizeBytes }
          : {}),
        message: progressMessage(this.inFlightInstall.state),
        recovery: progressRecovery(this.inFlightInstall.state),
        canInstallOrRepair: false,
        canRunUpdate: false,
        canCancel: true,
        ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
      }
    }

    if (this.checkingForUpdate) {
      return {
        state: 'checking',
        ...(this.checkedActiveVersion ? { currentVersion: this.checkedActiveVersion } : {}),
        ...(this.lastReleaseDescriptor?.version
          ? { targetVersion: this.lastReleaseDescriptor.version }
          : {}),
        message: progressMessage('checking'),
        recovery: progressRecovery('checking'),
        canInstallOrRepair: false,
        canRunUpdate: false,
        canCancel: false,
        ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
      }
    }

    const diagnostic = await this.diagnoseDependencies()
    const currentVersion =
      diagnostic.status === 'ready' ? diagnostic.manifest?.bundleVersion : undefined
    const targetVersion = this.lastReleaseDescriptor?.version
    const failure = this.lastFailure ?? this.lastUpdateCheckFailure
    if (failure) {
      const { error, ...safeFailure } = failure
      const failureKind = classifyUserFailure(error)
      return {
        state: 'failed',
        ...(safeFailure.callId ? { callId: safeFailure.callId } : {}),
        ...(safeFailure.operationId ? { operationId: safeFailure.operationId } : {}),
        ...(currentVersion ? { currentVersion } : {}),
        ...(targetVersion ? { targetVersion } : {}),
        failureKind,
        failureCategory: safeFailure.category,
        failureStage: safeFailure.stage,
        failureDomain: safeFailure.domain,
        errorCode: safeFailure.errorCode,
        retryable: safeFailure.retryable,
        runtimeActive: safeFailure.runtimeActive,
        pluginReady: safeFailure.pluginReady,
        message: userFailureMessage(failureKind),
        recovery: userFailureRecovery(failureKind),
        canInstallOrRepair: true,
        canRunUpdate: true,
        canCancel: false,
        ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
      }
    }

    if (diagnostic.status === 'ready') {
      if (this.updateAvailable) {
        return {
          state: 'update-available',
          ...(currentVersion ? { currentVersion } : {}),
          ...(targetVersion ? { targetVersion } : {}),
          message: '有可用的 Primary Runtime 更新。',
          recovery: '可在插件中心更新；更新完成后请新建任务以使用新增能力。',
          canInstallOrRepair: true,
          canRunUpdate: true,
          canCancel: false,
          ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
        }
      }
      return {
        state: 'ready',
        ...(currentVersion ? { currentVersion } : {}),
        ...(targetVersion ? { targetVersion } : {}),
        message: 'Primary Runtime 已就绪。',
        recovery: '新建任务即可使用与此 Runtime 同代的技能和工作区依赖。',
        canInstallOrRepair: true,
        canRunUpdate: true,
        canCancel: false,
        ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
      }
    }

    const message =
      diagnostic.status === 'unsupported'
        ? '当前设备不支持 Primary Runtime。'
        : diagnostic.status === 'broken'
          ? '已安装的 Primary Runtime 无法通过完整性检查。'
          : 'Primary Runtime 尚未安装。'
    return {
      state: diagnostic.status,
      ...(targetVersion ? { targetVersion } : {}),
      message,
      recovery:
        diagnostic.status === 'unsupported'
          ? '请在受支持的设备上继续，或联系管理员。'
          : '可以从插件中心安装或修复 Primary Runtime；普通聊天不受影响。',
      canInstallOrRepair: diagnostic.status !== 'unsupported',
      canRunUpdate: diagnostic.status !== 'unsupported',
      canCancel: false,
      ...(this.nextUpdateCheckAt ? { nextCheckAt: this.nextUpdateCheckAt } : {})
    }
  }

  async installOrRepair(): Promise<PrimaryRuntimeInstallCallResult> {
    return this.installOnce(undefined, 'repair')
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
    const failure = this.lastFailure ?? this.lastUpdateCheckFailure
    if (failure) {
      return {
        status: 'failed',
        message: userFailureMessage(classifyUserFailure(failure.error)),
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

  async runUpdateNow(): Promise<PrimaryRuntimeInstallCallResult | undefined> {
    return this.updateIfAvailable('manual-update')
  }

  /** Resolves trusted release metadata without changing the active Runtime. */
  async checkForUpdate(): Promise<PrimaryRuntimeUpdateCheck> {
    return this.resolveUpdateCheck()
  }

  /** Applies a trusted release only when it differs from the active bundle version. */
  async updateIfAvailable(
    trigger: PrimaryRuntimeTelemetryEvent['safe']['trigger'] = 'scheduled-update'
  ): Promise<PrimaryRuntimeInstallCallResult | undefined> {
    if (this.inFlightInstall) return this.joinInFlightInstall(this.inFlightInstall)
    const check = await this.resolveUpdateCheck()
    if (!check.available) return undefined
    return this.installOnce(this.lastReleaseDescriptor, trigger)
  }

  dispose(): void {
    this.inFlightInstall?.controller.abort()
    return undefined
  }

  private installOnce(
    descriptor?: PrimaryRuntimeReleaseDescriptor,
    trigger: PrimaryRuntimeTelemetryEvent['safe']['trigger'] = 'install'
  ): Promise<PrimaryRuntimeInstallCallResult> {
    if (!this.installer || !this.input.releaseProvider) {
      throw new Error('Primary Runtime release provider is not configured.')
    }
    if (this.inFlightInstall) return this.joinInFlightInstall(this.inFlightInstall)
    if (!descriptor && this.updateCheckPromise) {
      return this.updateCheckPromise.then(() =>
        this.installOnce(this.lastReleaseDescriptor, trigger)
      )
    }

    const controller = new AbortController()
    const inFlight: {
      version: string | null
      versionPromise: Promise<string>
      controller: AbortController
      promise: Promise<PrimaryRuntimeActivationResult>
      state: Extract<
        PrimaryRuntimeUserState,
        | 'resolving'
        | 'checking'
        | 'downloading'
        | 'verifying'
        | 'extracting'
        | 'validating'
        | 'installing'
        | 'activating'
        | 'configuring'
        | 'committing'
        | 'rolling-back'
      >
      callId: string
      operationId: string
      trigger: PrimaryRuntimeTelemetryEvent['safe']['trigger']
      downloadedBytes?: number
      downloadSizeBytes?: number
      activeVersion?: string
      manifestSequence?: number
      runtimeActive?: boolean
      pluginReady?: boolean
    } = {
      version: null,
      versionPromise: Promise.resolve('pending'),
      controller,
      state: 'resolving',
      callId: randomUUID(),
      operationId: randomUUID(),
      trigger,
      promise: Promise.resolve(null as unknown as PrimaryRuntimeActivationResult)
    }

    const descriptorPromise = (
      descriptor ? Promise.resolve(descriptor) : this.getReleaseDescriptor()
    ).then((resolvedDescriptor) => {
      inFlight.version = resolvedDescriptor.version
      inFlight.state = 'checking'
      this.notifyStatusListeners()
      return resolvedDescriptor
    })
    // Status reads may await this value while metadata retrieval fails. Keep
    // the failure on the installation promise so it is handled once, instead
    // of creating an unrelated unhandled rejection in the UI status path.
    inFlight.versionPromise = descriptorPromise.then(
      (resolvedDescriptor) => resolvedDescriptor.version,
      () => 'pending'
    )

    const promise = descriptorPromise
      .then((descriptor) => {
        if (!this.activationTransaction) {
          throw new Error('Primary Runtime activation transaction is not configured.')
        }
        return this.activationTransaction.activate(
          controller.signal,
          descriptor,
          inFlight.operationId
        )
      })
      .then(async (result) => {
        inFlight.state = 'configuring'
        inFlight.runtimeActive = true
        inFlight.pluginReady = false
        this.notifyStatusListeners()
        await this.postActivation?.(result)
        inFlight.pluginReady = true
        this.notifyStatusListeners()
        return result
      })
      .then((result) => {
        this.lastFailure = null
        this.lastUpdateCheckFailure = null
        this.updateAvailable = false
        return result
      })
      .catch((error) => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        const failure = classifyRuntimeFailure(normalized, inFlight)
        this.lastFailure = failure
        this.emitTelemetry({
          name: 'primary_runtime_install_operation_failed',
          safe: this.telemetrySafeFields(inFlight, {
            failureCategory: failure.category,
            failureStage: failure.stage,
            failureDomain: failure.domain,
            errorCode: failure.errorCode,
            retryable: failure.retryable
          }),
          sensitive: redactedSensitiveFailure(normalized)
        })
        throw error
      })
      .finally(() => {
        if (this.inFlightInstall?.promise === promise) {
          this.inFlightInstall = null
          this.notifyStatusListeners()
        }
      })

    inFlight.promise = promise
    this.inFlightInstall = inFlight
    this.notifyStatusListeners()
    return this.joinInFlightInstall(inFlight)
  }

  private joinInFlightInstall(
    inFlight: NonNullable<PrimaryRuntimeService['inFlightInstall']>
  ): Promise<PrimaryRuntimeInstallCallResult> {
    const callId = randomUUID()
    this.emitTelemetry({
      name: 'primary_runtime_install_call_joined',
      safe: this.telemetrySafeFields(inFlight, { callId })
    })
    return inFlight.promise.then(
      (result) => {
        const callResult = { ...result, callId, operationId: inFlight.operationId }
        this.emitTelemetry({
          name: 'primary_runtime_install_call_completed',
          safe: this.telemetrySafeFields(inFlight, {
            callId,
            phase: 'ready',
            bundleVersion: result.version
          })
        })
        return callResult
      },
      (cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        throw correlateInstallError(error, callId, inFlight.operationId)
      }
    )
  }

  private notifyStatusListeners(): void {
    for (const listener of this.statusListeners) listener()
  }

  private telemetrySafeFields(
    inFlight: NonNullable<PrimaryRuntimeService['inFlightInstall']>,
    overrides: Partial<PrimaryRuntimeTelemetryEvent['safe']> = {}
  ): PrimaryRuntimeTelemetryEvent['safe'] {
    return {
      callId: inFlight.callId,
      operationId: inFlight.operationId,
      trigger: inFlight.trigger,
      release: inFlight.version,
      target: `${process.platform}-${process.arch}`,
      bundleVersion: inFlight.activeVersion ?? null,
      phase: inFlight.state,
      ...overrides
    }
  }

  private emitTelemetry(event: PrimaryRuntimeTelemetryEvent): void {
    try {
      void Promise.resolve(this.input.onTelemetry?.(event)).catch(() => undefined)
    } catch {
      // Observability cannot alter installation or recovery semantics.
    }
  }

  private setInstallProgress(input: PrimaryRuntimeActivationProgress): void {
    const current = this.inFlightInstall
    if (!current) return
    current.operationId = input.operationId
    current.state = activationPhaseToUserState(input.phase)
    current.activeVersion = input.activeVersion
    current.manifestSequence = input.manifestSequence
    this.notifyStatusListeners()
  }

  private setInstallerProgress(progress: PrimaryRuntimeInstallerProgress): void {
    const current = this.inFlightInstall
    if (!current) return
    current.state = installerPhaseToUserState(progress.phase)
    if (progress.phase === 'downloading') {
      current.downloadedBytes = progress.downloadedBytes
      current.downloadSizeBytes = progress.totalBytes
    } else {
      current.downloadedBytes = undefined
      current.downloadSizeBytes = undefined
    }
    this.notifyStatusListeners()
  }

  private async getReleaseDescriptor(): Promise<PrimaryRuntimeReleaseDescriptor> {
    const provider = this.input.releaseProvider
    if (!provider) throw new Error('Primary Runtime release provider is not configured.')
    const descriptor = await provider.getRelease()
    if (!descriptor) throw new Error('Primary Runtime release descriptor is not configured.')
    this.lastReleaseDescriptor = descriptor
    return descriptor
  }

  private async resolveUpdateCheck(): Promise<PrimaryRuntimeUpdateCheck> {
    if (this.updateCheckPromise) return this.updateCheckPromise
    this.checkingForUpdate = true
    this.notifyStatusListeners()
    const check = (async (): Promise<PrimaryRuntimeUpdateCheck> => {
      try {
        const descriptor = await this.getReleaseDescriptor()
        const diagnostic = await this.diagnoseDependencies()
        const activeVersion =
          diagnostic.status === 'ready' ? diagnostic.manifest?.bundleVersion : undefined
        // A legacy v2 decoder is read-only compatibility, never a desired
        // Runtime capability. It stays usable if an upgrade fails, but a
        // product release replaces it even when a version label was reused.
        const available =
          diagnostic.status !== 'unsupported' &&
          (diagnostic.manifest?.legacyV2 === true || activeVersion !== descriptor.version)
        this.checkedActiveVersion = activeVersion
        this.updateAvailable = available
        this.lastUpdateCheckFailure = null
        return {
          available,
          version: descriptor.version,
          ...(activeVersion ? { activeVersion } : {})
        }
      } catch (error) {
        this.lastUpdateCheckFailure = classifyUpdateCheckFailure(normalizeError(error))
        throw error
      } finally {
        this.checkingForUpdate = false
        this.notifyStatusListeners()
      }
    })()
    this.updateCheckPromise = check
    void check.then(
      () => {
        if (this.updateCheckPromise === check) this.updateCheckPromise = null
      },
      () => {
        if (this.updateCheckPromise === check) this.updateCheckPromise = null
      }
    )
    return check
  }

  private async activeVersion(): Promise<string | undefined> {
    const diagnostic = await this.diagnoseDependencies()
    return diagnostic.status === 'ready' ? diagnostic.manifest?.bundleVersion : undefined
  }
}

function correlateInstallError(
  cause: Error,
  callId: string,
  operationId: string
): PrimaryRuntimeInstallCallError {
  // Preserve established error identity (notably AbortError and validation
  // errors) while giving each joining caller a separate correlation record.
  const error = new Error(cause.message) as PrimaryRuntimeInstallCallError
  Object.setPrototypeOf(error, Object.getPrototypeOf(cause))
  Object.assign(error, cause)
  Object.defineProperties(error, {
    name: { value: cause.name, enumerable: false, configurable: true },
    message: { value: cause.message, enumerable: false, configurable: true },
    stack: { value: cause.stack, enumerable: false, configurable: true },
    callId: { value: callId, enumerable: true, configurable: false },
    operationId: { value: operationId, enumerable: true, configurable: false }
  })
  return error
}

function redactedSensitiveFailure(
  error: Error
): NonNullable<PrimaryRuntimeTelemetryEvent['sensitive']> {
  return {
    redactionApplied: true,
    errorFingerprint: createHash('sha256').update(error.message).digest('hex')
  }
}

function classifyUserFailure(error: Error): NonNullable<PrimaryRuntimeUserStatus['failureKind']> {
  const message = error.message.toLowerCase()
  if (/signature|hash|checksum|integrity|verification|archive/i.test(message)) return 'integrity'
  if (/disk|space|storage/i.test(message)) return 'storage'
  if (/unsupported|platform|architecture/i.test(message)) return 'unsupported'
  if (/provenance|authorization|authorized source|supply.?chain/i.test(message)) return 'provenance'
  if (/network|fetch|http|https|timeout|offline|connect/i.test(message)) return 'network'
  return 'unavailable'
}

type PrimaryRuntimeFailure = {
  error: Error
  callId?: string
  operationId?: string
  category: NonNullable<PrimaryRuntimeUserStatus['failureCategory']>
  stage: NonNullable<PrimaryRuntimeUserStatus['failureStage']>
  domain: NonNullable<PrimaryRuntimeUserStatus['failureDomain']>
  errorCode: string
  retryable: boolean
  runtimeActive: boolean
  pluginReady: boolean
}

type PrimaryRuntimeInFlight = NonNullable<PrimaryRuntimeService['inFlightInstall']>

function classifyRuntimeFailure(
  error: Error,
  inFlight: PrimaryRuntimeInFlight
): PrimaryRuntimeFailure {
  const message = error.message.toLowerCase()
  const category = classifyFailureCategory(error, message, inFlight.state)
  const stage =
    error instanceof PrimaryRuntimePostInstallError
      ? error.stage
      : failureStageFor(category, inFlight.state)
  const domain = failureDomainFor(category, stage)
  return {
    error,
    callId: inFlight.callId,
    ...(inFlight.operationId ? { operationId: inFlight.operationId } : {}),
    category,
    stage,
    domain,
    errorCode: `primary_runtime_${category}`,
    retryable: isRetryableFailure(category, message),
    runtimeActive: inFlight.runtimeActive === true,
    pluginReady: inFlight.pluginReady === true
  }
}

/** Converts background metadata failures into a stable status without retaining raw details. */
function classifyUpdateCheckFailure(error: Error): PrimaryRuntimeFailure {
  const message = error.message.toLowerCase()
  const category = classifyFailureCategory(error, message, 'resolving')
  const stage = failureStageFor(category, 'resolving')
  return {
    error,
    category,
    stage,
    domain: failureDomainFor(category, stage),
    errorCode: updateCheckErrorCode(error, message, category),
    retryable: isRetryableFailure(category, message),
    runtimeActive: false,
    pluginReady: false
  }
}

function updateCheckErrorCode(
  error: Error,
  message: string,
  category: NonNullable<PrimaryRuntimeUserStatus['failureCategory']>
): string {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (/tls|ssl|certificate|unable to verify/u.test(`${message} ${code}`)) {
    return 'primary_runtime_tls_validation_failed'
  }
  if (/config.*(signature|key|valid)|product config/u.test(message)) {
    return 'primary_runtime_config_validation_failed'
  }
  if (/manifest.*(signature|key|valid)|sequence/u.test(message)) {
    return 'primary_runtime_manifest_validation_failed'
  }
  return `primary_runtime_${category}`
}

function classifyFailureCategory(
  error: Error,
  message: string,
  state: PrimaryRuntimeInFlight['state']
): NonNullable<PrimaryRuntimeUserStatus['failureCategory']> {
  if (error.name === 'AbortError' || /cancelled|canceled|aborted/u.test(message)) return 'aborted'
  if (error instanceof PrimaryRuntimePostInstallError || state === 'configuring') {
    return 'post_install_failed'
  }
  if (/unsupported.*(format|platform|architecture)|platform.*unsupported/u.test(message)) {
    return 'unsupported_host'
  }
  if (/enospace|enospc|not enough free disk|disk space|disk full/u.test(message)) return 'disk_full'
  if (/eacces|eperm|permission denied/u.test(message)) return 'permission_denied'
  if (/timeout|timed out/u.test(message)) return 'timeout'
  const httpStatus = httpStatusFromMessage(message)
  if (httpStatus !== undefined) return httpStatus >= 500 ? 'http_server_error' : 'http_client_error'
  if (/checksum|sha-?256|hash mismatch|final file verification/u.test(message)) {
    return 'checksum_mismatch'
  }
  if (/archive|zip|path outside|symbolic link|encrypted entry|too many entries/u.test(message)) {
    return 'archive_processing_failed'
  }
  if (
    error.name === 'PrimaryRuntimeInstallValidationError' ||
    /diagnostic|validation|payload/u.test(message)
  ) {
    return 'validation_failed'
  }
  if (
    /manifest|descriptor|signature|sequence|origin|provenance|authorization|authorized source/u.test(
      message
    )
  ) {
    return 'invalid_manifest'
  }
  if (/fetch|network|offline|connect|dns|econn|socket|tls|ssl|certificate/u.test(message)) {
    return 'network_fetch_failed'
  }
  if (/enoent|eio|erofs|filesystem|file system/u.test(message)) return 'filesystem_error'
  return 'unknown'
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function failureStageFor(
  category: NonNullable<PrimaryRuntimeUserStatus['failureCategory']>,
  state: PrimaryRuntimeInFlight['state']
): NonNullable<PrimaryRuntimeUserStatus['failureStage']> {
  if (category === 'post_install_failed') return 'sync_plugins'
  if (category === 'invalid_manifest') return 'resolve_manifest'
  if (category === 'disk_full' && state === 'resolving') return 'create_staging_directory'
  if (category === 'checksum_mismatch') return 'verify_checksum'
  if (category === 'archive_processing_failed') {
    return state === 'extracting' ? 'extract_archive' : 'list_archive'
  }
  if (category === 'validation_failed') return 'validate_payload'
  if (category === 'unsupported_host') return 'prepare_archive'
  if (category === 'permission_denied' || category === 'filesystem_error') {
    return state === 'activating' || state === 'committing'
      ? 'activate_runtime'
      : state === 'extracting'
        ? 'extract_archive'
        : 'create_staging_directory'
  }
  if (state === 'activating' || state === 'committing') return 'activate_runtime'
  if (state === 'extracting') return 'extract_archive'
  if (state === 'validating' || state === 'verifying') return 'validate_payload'
  if (state === 'downloading') return 'download_archive'
  return 'resolve_manifest'
}

function failureDomainFor(
  category: NonNullable<PrimaryRuntimeUserStatus['failureCategory']>,
  stage: NonNullable<PrimaryRuntimeUserStatus['failureStage']>
): NonNullable<PrimaryRuntimeUserStatus['failureDomain']> {
  if (category === 'post_install_failed') return 'post_install'
  if (category === 'invalid_manifest') return 'metadata'
  if (
    category === 'network_fetch_failed' ||
    category === 'timeout' ||
    category.startsWith('http_')
  ) {
    return 'network'
  }
  if (
    category === 'disk_full' ||
    category === 'permission_denied' ||
    category === 'filesystem_error'
  ) {
    return 'filesystem'
  }
  if (stage === 'activate_runtime' || stage === 'validate_cached_runtime') return 'activation'
  if (stage === 'validate_payload') return 'payload'
  if (
    stage === 'prepare_archive' ||
    stage === 'verify_checksum' ||
    stage === 'list_archive' ||
    stage === 'extract_archive'
  ) {
    return 'archive'
  }
  return 'unknown'
}

function isRetryableFailure(
  category: NonNullable<PrimaryRuntimeUserStatus['failureCategory']>,
  message: string
): boolean {
  if (
    category === 'network_fetch_failed' ||
    category === 'timeout' ||
    category === 'http_server_error'
  ) {
    return true
  }
  return category === 'http_client_error' && /\b(?:408|429)\b/u.test(message)
}

function httpStatusFromMessage(message: string): number | undefined {
  const match = /\b(?:http(?: status)?\s*)?(4\d\d|5\d\d)\b/iu.exec(message)
  return match ? Number(match[1]) : undefined
}

function activationPhaseToUserState(
  phase: PrimaryRuntimeActivationProgress['phase']
): PrimaryRuntimeInFlight['state'] {
  switch (phase) {
    case 'downloading':
      return 'downloading'
    case 'verifying':
      return 'validating'
    case 'committing':
      return 'activating'
    case 'rolling-back':
      return 'rolling-back'
  }
}

function installerPhaseToUserState(
  phase: PrimaryRuntimeInstallerProgress['phase']
): PrimaryRuntimeInFlight['state'] {
  switch (phase) {
    case 'downloading':
      return 'downloading'
    case 'installing':
      return 'extracting'
    case 'verifying':
      return 'validating'
  }
}

function userFailureMessage(kind: NonNullable<PrimaryRuntimeUserStatus['failureKind']>): string {
  switch (kind) {
    case 'integrity':
      return '下载的 Primary Runtime 未通过安全校验，未启用该版本。'
    case 'storage':
      return '安装 Primary Runtime 时可用磁盘空间不足。'
    case 'unsupported':
      return '当前设备不支持此 Primary Runtime。'
    case 'provenance':
      return 'Primary Runtime 的授权来源或供应链证明尚未满足要求。'
    case 'network':
      return '暂时无法连接受信任的 Primary Runtime 发布服务。'
    case 'unavailable':
      return 'Primary Runtime 暂时不可用。'
  }
}

function userFailureRecovery(kind: NonNullable<PrimaryRuntimeUserStatus['failureKind']>): string {
  switch (kind) {
    case 'integrity':
      return '请稍后重试；安全校验失败的文件不会被安装。'
    case 'storage':
      return '释放足够磁盘空间后再尝试修复。'
    case 'unsupported':
      return '请在受支持的设备上继续，或联系管理员。'
    case 'provenance':
      return '请联系管理员提供已授权、可审计的 Runtime 发布版本；不会安装替代依赖。'
    case 'network':
      return '检查网络后重试。已有 Runtime 和普通聊天可继续使用。'
    case 'unavailable':
      return '请重试；若问题持续，请联系管理员。'
  }
}

function progressMessage(
  state: Extract<
    PrimaryRuntimeUserState,
    | 'resolving'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'validating'
    | 'installing'
    | 'activating'
    | 'configuring'
    | 'committing'
    | 'rolling-back'
  >
): string {
  switch (state) {
    case 'resolving':
      return '正在解析受信任的 Primary Runtime 发布信息。'
    case 'checking':
      return '正在检查受信任的 Primary Runtime 更新。'
    case 'downloading':
      return '正在下载受信任的 Primary Runtime。'
    case 'verifying':
      return '正在验证 Primary Runtime 的完整性和依赖。'
    case 'extracting':
      return '正在解压 Primary Runtime 候选版本。'
    case 'validating':
      return '正在验证 Primary Runtime 候选版本。'
    case 'installing':
      return '正在准备不可变的 Primary Runtime 候选版本。'
    case 'activating':
      return '正在启用已验证的 Primary Runtime。'
    case 'configuring':
      return '正在同步 Primary Runtime 的插件和技能。'
    case 'committing':
      return '正在启用 Primary Runtime 并同步内置插件。'
    case 'rolling-back':
      return '正在恢复上一代可用的 Primary Runtime。'
  }
}

function progressRecovery(
  state: Extract<
    PrimaryRuntimeUserState,
    | 'resolving'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'extracting'
    | 'validating'
    | 'installing'
    | 'activating'
    | 'configuring'
    | 'committing'
    | 'rolling-back'
  >
): string {
  return state === 'rolling-back'
    ? '恢复完成前请勿关闭应用；已有任务不会被中断。'
    : '完成后请新建任务以使用与此 Runtime 同代的工作区能力。'
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
  const nodeModules =
    nodeModulesRootFrom(dependencies.nodePackages[0]?.path) ??
    join(dependencies.root, 'node_modules')

  return {
    bundleVersion: dependencies.bundleVersion,
    node: dependencies.node.path,
    nodeModules,
    ...(dependencies.python ? { python: dependencies.python.path } : {}),
    binaries,
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
