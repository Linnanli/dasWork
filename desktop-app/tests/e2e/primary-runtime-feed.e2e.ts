import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'

import {
  attachDiagnostics,
  appRoot,
  closeApp,
  collectRendererLogs,
  launchApp,
  serializeDiagnosticData
} from './support/app'
import { createLocalProject, sendComposerMessage } from './support/chatActions'
import {
  openR07PresentationInWorkspace,
  renderedSlideMetrics,
  verifyR07RenderedSlides,
  verifyR07Presentation,
  withR07PresentationWorkspace,
  type R07RenderQaReceipt,
  type R07PresentationWorkspace
} from './support/r07Presentation'
import {
  createR07EvidenceRecorder,
  requirePositiveDuration,
  type R07EvidenceObservations
} from './support/primaryRuntimeEvidence'
import { captureR07PreviewSlides, writeR07ContactSheet } from './support/r07PreviewCapture'
import {
  assistantMessageResponse,
  dynamicFunctionCallResponse,
  functionCallOutputCount,
  functionCallOutputText,
  providerResponseBodies,
  shellCommandResponse,
  startMockBackend,
  type MockRequest,
  type ResponsesStep
} from './support/mockBackend'

const loaderCallId = 'call-primary-runtime-loader'
const runtimeCommandCallId = 'call-primary-runtime-presentation-command'
const packagedExecutable = process.env['DASCOWORK_PRIMARY_RUNTIME_PACKAGED_APP_EXECUTABLE']?.trim()
const p3bSampleOutput = process.env['DASCOWORK_PRIMARY_RUNTIME_P3B_SAMPLE_OUTPUT']?.trim()
const p3bSampleIndex = Number(process.env['DASCOWORK_PRIMARY_RUNTIME_P3B_SAMPLE_INDEX'] ?? '0')
const appToolsLiveTraceReportPath = process.env['DASCOWORK_APP_TOOLS_LIVE_TRACE_REPORT']?.trim()
const r07VisualArtifactDirectory = process.env['DASCOWORK_R07_VISUAL_ARTIFACT_DIRECTORY']?.trim()
const primaryRuntimeE2eTimeoutMs = 600_000
const primaryRuntimeReadinessTimeoutMs = 300_000

type WorkspaceDependencies = {
  officecli: string
}

type RuntimeOfficeSkillSnapshot = {
  id: string
  normalizedId: string
  name: string
  scope: string | null
  sourceKind: string | null
  enabled: boolean
  installed: boolean
}

type RuntimeOfficeSkillContract = {
  id: string
  name: string
  localPath: string
  normalizedLocalPath: string
  skillRoot: string
  instructionsSha256: string
}

type R07ArtifactPreviewTrace = {
  sourceId: string
  receiptId: string
  generation: number
  checksum: string
}

type R07ArtifactPreviewResult = {
  trace: R07ArtifactPreviewTrace
  renderQaReceipt: R07RenderQaReceipt
}

type RuntimeActivationTrace = {
  operationId?: string
  activeVersion?: string
  manifestSequence?: number
}

const runtimeOfficeSkillSuffix = '/skills/dascowork-primary-runtime/officecli/SKILL.md'

if (p3bSampleOutput) {
  test('AT-P3B-MAIN-OVERLAP records normal chat and Main event-loop evidence during a cold Runtime install', async ({
    browserName
  }, testInfo) => {
    test.setTimeout(primaryRuntimeE2eTimeoutMs)
    expect(browserName).toBe('chromium')
    expect(p3bSampleIndex).toBeGreaterThanOrEqual(1)

    await withR07PresentationWorkspace(async (workspace) => {
      const backend = await startMockBackend({
        responses: [
          assistantMessageResponse(
            `response-p3b-chat-${p3bSampleIndex}`,
            `message-p3b-chat-${p3bSampleIndex}`,
            'The ordinary app-server chat completed while the Runtime install was still active.'
          )
        ]
      })
      const logs: string[] = []
      let app: ElectronApplication | undefined
      const launchStartedAtMs = Date.now()
      try {
        app = await launchApp(backend, logs, {
          cwd: workspace.root,
          launchTimeoutMs: 90_000,
          ...(packagedExecutable
            ? { executablePath: packagedExecutable, args: [] }
            : { args: [appRoot] }),
          environment: {
            CODEX_APP_SERVER_BIN: undefined
          }
        })
        const page = await app.firstWindow()
        collectRendererLogs(page, logs)
        const mainProbeId = await startMainEventLoopProbe(app)
        const diskProbeId = await startMainDiskProbe(app)
        await createLocalProject(page, `Primary Runtime P3b ${p3bSampleIndex}`, workspace.root)

        const firstInstallingAtMs = await waitForPrimaryRuntimeInstalling(page)
        const chatStartedAtMs = Date.now()
        await sendComposerMessage(
          page,
          `P3b sample ${p3bSampleIndex}: confirm ordinary chat during Runtime setup.`
        )
        await expect(page.locator('[data-role="assistant"]')).toContainText(
          'The ordinary app-server chat completed while the Runtime install was still active.'
        )
        const chatCompletedAtMs = Date.now()
        const stateAfterChat = await primaryRuntimeState(page)
        expect(stateAfterChat).not.toBe('ready')
        const readyAtMs = await waitForPrimaryRuntimeReady(page)
        const mainEventLoop = await stopMainEventLoopProbe(app, mainProbeId)
        const diskProbe = await stopMainDiskProbe(app, diskProbeId)
        const sample = {
          sampleIndex: p3bSampleIndex,
          minimumAvailableDiskBytes: diskProbe.minimumAvailableDiskBytes,
          diskProbe,
          coldInstallMs: requirePositiveDuration(readyAtMs - launchStartedAtMs, 'P3b cold install'),
          chatInstallOverlapMs: requirePositiveDuration(
            Math.min(chatCompletedAtMs, readyAtMs) - Math.max(chatStartedAtMs, firstInstallingAtMs),
            'P3b chat/install overlap'
          ),
          installWindow: {
            launchStartedAtMs,
            firstObservedInstallingAtMs: firstInstallingAtMs,
            readyAtMs
          },
          normalChat: {
            passed: true,
            requestedAtMs: chatStartedAtMs,
            completedAtMs: chatCompletedAtMs,
            responseMs: requirePositiveDuration(
              chatCompletedAtMs - chatStartedAtMs,
              'P3b normal chat response'
            ),
            completedDuringInstall: chatCompletedAtMs < readyAtMs
          },
          mainEventLoop
        }
        expect(sample.normalChat.completedDuringInstall).toBe(true)
        await mkdir(dirname(p3bSampleOutput), { recursive: true })
        await writeFile(p3bSampleOutput, `${JSON.stringify(sample, null, 2)}\n`, {
          mode: 0o600
        })
      } finally {
        await attachDiagnostics(testInfo, logs, backend, app)
        await closeApp(app)
        await backend.close()
      }
    })
  })
}

test('AT-E2E-01/OFFICECLI-RUNTIME installs a signed Feed Runtime and creates an R07 presentation through a normal command', async ({
  browserName
}, testInfo) => {
  // The target-native calibration archive is intentionally large enough that
  // download, staging, activation, plugin sync, QA, and render can exceed the
  // generic 60-second default. P3b separately measures the numeric cold-install
  // budget; this timeout only keeps the real end-to-end acceptance path intact.
  test.setTimeout(primaryRuntimeE2eTimeoutMs)
  expect(browserName).toBe('chromium')

  await withR07PresentationWorkspace(async (workspace) => {
    let runtimeOfficeSkillContract: RuntimeOfficeSkillContract | undefined
    const evidenceRecorder = createR07EvidenceRecorder()
    const backend = await startMockBackend({
      responses: [
        assistantMessageResponse(
          'response-runtime-normal-chat',
          'message-runtime-normal-chat',
          'The ordinary app-server chat stayed responsive while the Runtime installation ran.'
        ),
        dynamicFunctionCallResponse(
          'response-runtime-loader',
          loaderCallId,
          'load_workspace_dependencies',
          {},
          { namespace: 'codex_app' }
        ),
        (request) => {
          const response = runtimeOfficeCommandResponse(
            request,
            workspace,
            runtimeOfficeSkillContract
          )
          evidenceRecorder.observe('loader')
          return response
        },
        assistantMessageResponse(
          'response-runtime-final',
          'message-runtime-final',
          'The signed Primary Runtime created, rendered, checked, and previewed the six-page presentation through the native desktop command path.'
        )
      ]
    })
    const logs: string[] = []
    let app: ElectronApplication | undefined

    try {
      app = await launchApp(backend, logs, {
        cwd: workspace.root,
        // The P3b job boots a fresh Electron process beside a target-native
        // Runtime archive. Hosted macOS/Linux runners can need longer than
        // Playwright's generic 30-second debugger-connect default, while the
        // test's own end-to-end bound still limits the full path.
        launchTimeoutMs: 90_000,
        // Electron resolves the development entrypoint from its first argument,
        // independently of the workspace used for app-server commands.
        ...(packagedExecutable
          ? { executablePath: packagedExecutable, args: [] }
          : { args: [appRoot] }),
        environment: {
          // The runner supplies only signed engineering-feed inputs and removes
          // all direct root/archive overrides before this process is started.
          CODEX_APP_SERVER_BIN: undefined
        }
      })
      const page = await app.firstWindow()
      collectRendererLogs(page, logs)
      await expect
        .poll(() => app!.evaluate(({ app: electronApp }) => electronApp.isPackaged))
        .toBe(Boolean(packagedExecutable))
      await createLocalProject(page, 'Primary Runtime R07 project', workspace.root)

      // A Runtime update is deliberately non-blocking for ordinary chat. This
      // response is asserted before waiting for Runtime readiness, so the test
      // cannot pass by serialising normal app-server traffic behind installation.
      await sendComposerMessage(
        page,
        'Please confirm that normal chat remains available during Runtime setup.'
      )
      await expect(page.locator('[data-role="assistant"]')).toContainText(
        'The ordinary app-server chat stayed responsive while the Runtime installation ran.'
      )
      const runtimeActivation = await expectPrimaryRuntimeReady(page, logs)
      runtimeOfficeSkillContract = await expectRuntimeOfficeSkill(page)
      await sendComposerMessage(
        page,
        'Read the workspace HTML, load the verified Runtime dependencies, then create and QA the six-page presentation.'
      )

      const approvalPanel = page.locator('[data-slot="server-request-panel"]')
      // The P3b command is explicitly escalated and must pass through the
      // renderer approval surface. GitHub's Linux runner forbids Bubblewrap
      // from creating its loopback interface, so using the approved command
      // path is the only faithful way to exercise the desktop command flow
      // there without weakening the product's sandbox or approval defaults.
      await expect(approvalPanel).toContainText('是否允许执行以下命令？', {
        timeout: 20_000
      })
      // The command payload is Base64-encoded to preserve Windows quoting, so
      // assert the renderer-visible escalation reason rather than a source
      // filename that is intentionally absent from the displayed shell text.
      await expect(approvalPanel).toContainText(
        'The signed Primary Runtime presentation command needs its one-time approved execution path.'
      )
      evidenceRecorder.observe('command')
      await approvalPanel.getByRole('button', { name: '允许一次', exact: true }).click()

      const runtimeSuccessMessage = page.locator('[data-role="assistant"]').filter({
        hasText:
          'The signed Primary Runtime created, rendered, checked, and previewed the six-page presentation through the native desktop command path.'
      })
      await expect(runtimeSuccessMessage).toHaveCount(1, { timeout: 120_000 })

      const providerBodies = providerResponseBodies(backend)
      // Follow-up Responses requests retain earlier tool outputs as context.
      // Presence proves each desktop tool ran; counting replayed provider input
      // as a second invocation would make this product gate flaky.
      expect(functionCallOutputCount(providerBodies, loaderCallId)).toBeGreaterThanOrEqual(1)
      expect(functionCallOutputCount(providerBodies, runtimeCommandCallId)).toBeGreaterThanOrEqual(
        1
      )

      const runtimeCommandOutput = providerBodies
        .map((body) => functionCallOutputText(body, runtimeCommandCallId))
        .find((output): output is string => Boolean(output))
      expect(runtimeCommandOutput).toBeTruthy()
      expect(serializeDiagnosticData({ runtimeCommandOutput })).toContain('officecli:created:6')

      const loaderRequest = providerBodies.find((body) =>
        Boolean(functionCallOutputText(body, loaderCallId))
      )
      const loaderOutput = loaderRequest
        ? functionCallOutputText(loaderRequest, loaderCallId)
        : undefined
      expect(loaderOutput).toBeTruthy()
      const dependencies = parseWorkspaceDependencies(loaderOutput!)
      expect(isAbsolute(dependencies.officecli)).toBe(true)
      expect(loaderOutput).toContain('Use only the following verified Primary Runtime paths.')
      expect(loaderOutput).toContain('OfficeCLI:')
      expect(loaderOutput).not.toContain('Primary Runtime root:')

      await expect
        .poll(
          async () => {
            try {
              await access(join(workspace.root, workspace.outputFile))
              return true
            } catch {
              return false
            }
          },
          { timeout: 120_000 }
        )
        .toBe(true)
      await verifyR07Presentation(join(workspace.root, workspace.outputFile))
      await expectR07QaOutputs(workspace)
      evidenceRecorder.observe('artifact')
      const previewResult = await openR07PresentationPreviewAndReadArtifact(
        page,
        workspace,
        testInfo
      )
      evidenceRecorder.observe('preview')
      const exportedVisualArtifactDirectory = r07VisualArtifactDirectory
        ? await exportR07VisualArtifacts({
            directory: r07VisualArtifactDirectory,
            workspace,
            previewTrace: previewResult.trace,
            renderQaReceipt: previewResult.renderQaReceipt
          })
        : undefined
      if (appToolsLiveTraceReportPath) {
        await writeR07LiveTraceReport({
          path: appToolsLiveTraceReportPath,
          logs,
          workspace,
          skillContract: runtimeOfficeSkillContract,
          activation: runtimeActivation,
          loaderOutput: loaderOutput!,
          runtimeCommandOutput: runtimeCommandOutput!,
          previewTrace: previewResult.trace,
          renderQaReceipt: previewResult.renderQaReceipt,
          visualArtifactDirectory: exportedVisualArtifactDirectory,
          observations: evidenceRecorder.snapshot()
        })
      }
    } finally {
      await attachDiagnostics(testInfo, logs, backend, app)
      await closeApp(app)
      await backend.close()
    }
  })
})

async function expectPrimaryRuntimeReady(
  page: Page,
  logs: readonly string[]
): Promise<RuntimeActivationTrace> {
  let latestStatus: unknown
  let pollError: unknown
  const activation: RuntimeActivationTrace = {}
  try {
    await expect
      .poll(
        async () => {
          latestStatus = await page.evaluate(async () => {
            const result = await window.desktopApp.plugins.getPrimaryRuntimeStatus({ version: 1 })
            return result.runtime
          })
          if (isRecord(latestStatus)) {
            if (typeof latestStatus.operationId === 'string') {
              activation.operationId = latestStatus.operationId
            }
            if (typeof latestStatus.currentVersion === 'string') {
              activation.activeVersion = latestStatus.currentVersion
            }
            if (typeof latestStatus.manifestSequence === 'number') {
              activation.manifestSequence = latestStatus.manifestSequence
            }
          }
          const state = (latestStatus as { state?: unknown }).state
          return typeof state === 'string' ? state : 'unknown'
        },
        { timeout: primaryRuntimeReadinessTimeoutMs }
      )
      .toMatch(/^(?:ready|failed)$/u)
  } catch (error) {
    pollError = error
  }

  if ((latestStatus as { state?: unknown }).state === 'ready') return activation

  // A verified Runtime whose post-install plugin synchronization failed is a
  // terminal state for this exact candidate. Retrying its update would only
  // spend another full installer interval and hide the original diagnostic.
  const retryStatus =
    (latestStatus as { state?: unknown }).state === 'failed'
      ? undefined
      : await page
          .evaluate(async () => {
            const result = await window.desktopApp.plugins.runPrimaryRuntimeUpdate({ version: 1 })
            return result.runtime
          })
          .catch(() => undefined)
  const diagnosticLogs = safePrimaryRuntimeDiagnosticLogs(logs)
  throw new Error(
    `Primary Runtime did not become ready: ${JSON.stringify(latestStatus)}\n` +
      `Diagnostic retry status: ${JSON.stringify(retryStatus)}\n${diagnosticLogs}`,
    { cause: pollError }
  )
}

async function waitForPrimaryRuntimeInstalling(page: Page): Promise<number> {
  let observedAtMs = 0
  await expect
    .poll(
      async () => {
        const state = await primaryRuntimeState(page)
        if (isInstallingRuntimeState(state) && observedAtMs === 0) observedAtMs = Date.now()
        return isInstallingRuntimeState(state)
      },
      { timeout: primaryRuntimeReadinessTimeoutMs }
    )
    .toBe(true)
  return observedAtMs || Date.now()
}

async function waitForPrimaryRuntimeReady(page: Page): Promise<number> {
  let readyAtMs = 0
  await expect
    .poll(
      async () => {
        const state = await primaryRuntimeState(page)
        if (state === 'ready' && readyAtMs === 0) readyAtMs = Date.now()
        return state
      },
      { timeout: primaryRuntimeReadinessTimeoutMs }
    )
    .toBe('ready')
  return readyAtMs || Date.now()
}

async function primaryRuntimeState(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const result = await window.desktopApp.plugins.getPrimaryRuntimeStatus({ version: 1 })
    const state = result.runtime.state
    return typeof state === 'string' ? state : 'unknown'
  })
}

function isInstallingRuntimeState(state: string): boolean {
  return /^(?:resolving|checking|downloading|verifying|extracting|validating|installing|activating|configuring|committing)$/u.test(
    state
  )
}

async function startMainEventLoopProbe(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => {
    const { monitorEventLoopDelay, performance } = process.getBuiltinModule(
      'node:perf_hooks'
    ) as typeof import('node:perf_hooks')
    const probes = ((
      globalThis as typeof globalThis & {
        __dascoworkPrimaryRuntimeP3bProbes?: Map<
          string,
          {
            startedAtMs: number
            monitor: ReturnType<typeof monitorEventLoopDelay>
          }
        >
      }
    ).__dascoworkPrimaryRuntimeP3bProbes ??= new Map())
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const monitor = monitorEventLoopDelay({ resolution: 1 })
    monitor.enable()
    probes.set(id, { startedAtMs: performance.now(), monitor })
    return id
  })
}

async function stopMainEventLoopProbe(
  app: ElectronApplication,
  id: string
): Promise<{
  source: 'electron-main'
  startedAtMs: number
  stoppedAtMs: number
  p99Ms: number
  maxMs: number
}> {
  const measurement = await app.evaluate((_, probeId) => {
    const { performance } = process.getBuiltinModule(
      'node:perf_hooks'
    ) as typeof import('node:perf_hooks')
    const probes = (
      globalThis as typeof globalThis & {
        __dascoworkPrimaryRuntimeP3bProbes?: Map<
          string,
          {
            startedAtMs: number
            monitor: {
              disable(): void
              percentile(percentile: number): number
              max: number
            }
          }
        >
      }
    ).__dascoworkPrimaryRuntimeP3bProbes
    const probe = probes?.get(probeId)
    if (!probe) throw new Error('Missing Primary Runtime P3b Main event-loop probe.')
    probe.monitor.disable()
    probes?.delete(probeId)
    return {
      source: 'electron-main' as const,
      startedAtMs: probe.startedAtMs,
      stoppedAtMs: performance.now(),
      p99Ms: probe.monitor.percentile(99) / 1_000_000,
      maxMs: probe.monitor.max / 1_000_000
    }
  }, id)
  if (measurement.stoppedAtMs <= measurement.startedAtMs || measurement.p99Ms > measurement.maxMs) {
    throw new Error('P3b Main event-loop probe returned inconsistent measurements.')
  }
  return {
    source: measurement.source,
    startedAtMs: requirePositiveDuration(measurement.startedAtMs, 'P3b Main probe start'),
    stoppedAtMs: requirePositiveDuration(measurement.stoppedAtMs, 'P3b Main probe stop'),
    p99Ms: requirePositiveDuration(measurement.p99Ms, 'P3b Main event-loop p99'),
    maxMs: requirePositiveDuration(measurement.maxMs, 'P3b Main event-loop max')
  }
}

async function startMainDiskProbe(app: ElectronApplication): Promise<string> {
  return app.evaluate(async ({ app: electronApp }) => {
    const { statfs } = process.getBuiltinModule(
      'node:fs/promises'
    ) as typeof import('node:fs/promises')
    const probes = ((
      globalThis as typeof globalThis & {
        __dascoworkPrimaryRuntimeP3bDiskProbes?: Map<
          string,
          {
            path: string
            sampleCount: number
            minimumAvailableDiskBytes: number
            timer: ReturnType<typeof setInterval>
            sampling: boolean
          }
        >
      }
    ).__dascoworkPrimaryRuntimeP3bDiskProbes ??= new Map())
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const path = electronApp.getPath('userData')
    const probe = {
      path,
      sampleCount: 0,
      minimumAvailableDiskBytes: Number.MAX_SAFE_INTEGER,
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      sampling: false
    }
    const sample = async (): Promise<void> => {
      if (probe.sampling) return
      probe.sampling = true
      try {
        const filesystem = await statfs(path)
        const available = Math.floor(filesystem.bavail * filesystem.bsize)
        probe.minimumAvailableDiskBytes = Math.min(probe.minimumAvailableDiskBytes, available)
        probe.sampleCount += 1
      } finally {
        probe.sampling = false
      }
    }
    await sample()
    probe.timer = setInterval(() => {
      void sample()
    }, 250)
    probes.set(id, probe)
    return id
  })
}

async function stopMainDiskProbe(
  app: ElectronApplication,
  id: string
): Promise<{
  source: 'electron-main'
  pathKind: 'userData'
  minimumAvailableDiskBytes: number
  sampleCount: number
}> {
  const measurement = await app.evaluate(async (_, probeId) => {
    const { statfs } = process.getBuiltinModule(
      'node:fs/promises'
    ) as typeof import('node:fs/promises')
    const probes = (
      globalThis as typeof globalThis & {
        __dascoworkPrimaryRuntimeP3bDiskProbes?: Map<
          string,
          {
            path: string
            sampleCount: number
            minimumAvailableDiskBytes: number
            timer: ReturnType<typeof setInterval>
          }
        >
      }
    ).__dascoworkPrimaryRuntimeP3bDiskProbes
    const probe = probes?.get(probeId)
    if (!probe) throw new Error('Missing Primary Runtime P3b Main disk probe.')
    clearInterval(probe.timer)
    const filesystem = await statfs(probe.path)
    const available = Math.floor(filesystem.bavail * filesystem.bsize)
    probe.minimumAvailableDiskBytes = Math.min(probe.minimumAvailableDiskBytes, available)
    probe.sampleCount += 1
    probes?.delete(probeId)
    return {
      source: 'electron-main' as const,
      pathKind: 'userData' as const,
      minimumAvailableDiskBytes: probe.minimumAvailableDiskBytes,
      sampleCount: probe.sampleCount
    }
  }, id)
  if (
    !Number.isSafeInteger(measurement.minimumAvailableDiskBytes) ||
    measurement.minimumAvailableDiskBytes <= 0 ||
    !Number.isSafeInteger(measurement.sampleCount) ||
    measurement.sampleCount < 2
  ) {
    throw new Error('P3b Main disk probe returned invalid measurements.')
  }
  return measurement
}

function safePrimaryRuntimeDiagnosticLogs(logs: readonly string[]): string {
  try {
    // Keep the failure surface to Main's Primary Runtime and its direct
    // post-install plugin reconciliation diagnostics, then apply the shared
    // serializer before exposing any test attachment output.
    const runtimeAndPluginLogs = logs
      .filter((log) => log.includes('[primary-runtime]') || log.includes('[bundled-plugins]'))
      .slice(-8)
    return serializeDiagnosticData({ runtimeAndPluginLogs }).slice(-8_000)
  } catch {
    return 'Primary Runtime diagnostic logs were unavailable after redaction.'
  }
}

async function expectRuntimeOfficeSkill(page: Page): Promise<RuntimeOfficeSkillContract> {
  let runtimeSkill: RuntimeOfficeSkillSnapshot | null = null
  await expect
    .poll(
      async () => {
        runtimeSkill = await page.evaluate(async (skillSuffix) => {
          const result = await window.desktopApp.plugins.getSnapshot({
            version: 1,
            sections: ['skills']
          })
          const skill = result.snapshot.skills.find(
            (candidate) =>
              candidate.enabled &&
              candidate.name === 'officecli' &&
              candidate.id.replaceAll('\\', '/').endsWith(skillSuffix)
          )
          if (!skill) return null
          return {
            id: skill.id,
            normalizedId: skill.id.replaceAll('\\', '/'),
            name: skill.name,
            scope: skill.scope ?? null,
            sourceKind: skill.sourceKind ?? null,
            enabled: skill.enabled,
            installed: skill.installed
          }
        }, runtimeOfficeSkillSuffix)
        return runtimeSkill
      },
      { timeout: 120_000 }
    )
    .toMatchObject({
      name: 'officecli',
      scope: 'personal',
      sourceKind: 'personal',
      enabled: true,
      installed: true
    })
  if (!runtimeSkill) throw new Error('Runtime-owned OfficeCLI skill was not listed.')

  const contents = await page.evaluate(async (skill) => {
    return window.desktopApp.plugins.getSkillContents({
      version: 1,
      skill: { id: skill.id, name: skill.name },
      forceRefresh: true
    })
  }, runtimeSkill)
  if (contents.status !== 'ready') {
    throw new Error(`Runtime-owned OfficeCLI skill contents were unavailable: ${contents.status}`)
  }
  return runtimeOfficeSkillContractFromContents(runtimeSkill, contents)
}

function runtimeOfficeCommandResponse(
  request: MockRequest,
  workspace: R07PresentationWorkspace,
  skillContract: RuntimeOfficeSkillContract | undefined
): ResponsesStep {
  if (!skillContract) {
    throw new Error(
      'The Runtime OfficeCLI command was requested before skill contents were verified.'
    )
  }
  const loaderOutput = functionCallOutputText(JSON.parse(request.body) as unknown, loaderCallId)
  if (!loaderOutput) {
    throw new Error(
      'The Runtime OfficeCLI command was requested before loader output was returned.'
    )
  }
  const dependencies = parseWorkspaceDependencies(loaderOutput)
  const command = runtimeOfficeCommandSource(dependencies, workspace, skillContract)

  return shellCommandResponse('response-runtime-command', runtimeCommandCallId, {
    command,
    // OfficeCLI creates the deck and emits per-slide SVG render evidence.
    // Hosted runners can exceed the app-server command default on cold start;
    // P3b still measures and enforces the cold-install performance budget.
    timeout_ms: 120_000,
    sandbox_permissions: 'require_escalated',
    justification:
      'The signed Primary Runtime presentation command needs its one-time approved execution path.'
  })
}

function runtimeOfficeCommandSource(
  dependencies: WorkspaceDependencies,
  workspace: R07PresentationWorkspace,
  skillContract: RuntimeOfficeSkillContract
): string {
  const facts = workspace.facts.map((fact) => fact.value)
  const outputPath = join(workspace.root, workspace.outputFile)
  const renderedSlides = join(workspace.root, workspace.renderedSlidesDirectory)
  const layoutPath = join(workspace.root, workspace.layoutReceiptFile)
  const validationPath = join(workspace.root, 'officecli-validation.json')
  const imagePath = join(workspace.root, workspace.imageFile)
  const office = dependencies.officecli
  const commandArgs: string[][] = [
    [office, 'create', outputPath],
    [
      office,
      'add',
      outputPath,
      '/',
      '--type',
      'slide',
      '--prop',
      'title=封面｜AI Agent 安全市场',
      '--prop',
      'background=EAF2FF'
    ],
    [
      office,
      'add',
      outputPath,
      '/slide[1]',
      '--type',
      'shape',
      '--prop',
      'text=从市场机会到可审计的工具调用治理',
      '--prop',
      'x=1in',
      '--prop',
      'y=2in',
      '--prop',
      'width=8in',
      '--prop',
      'height=1in',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'font.latin=Aptos',
      '--prop',
      'size=24pt',
      '--prop',
      'color=1F2937'
    ],
    [office, 'add', outputPath, '/', '--type', 'slide', '--prop', 'title=议程｜市场机会与风险'],
    [
      office,
      'add',
      outputPath,
      '/slide[2]',
      '--type',
      'shape',
      '--prop',
      'text=市场规模、需求结构、风险优先级与下一步行动',
      '--prop',
      'x=1in',
      '--prop',
      'y=2in',
      '--prop',
      'width=8in',
      '--prop',
      'height=1in',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=22pt'
    ],
    [
      office,
      'add',
      outputPath,
      '/slide[2]',
      '--type',
      'shape',
      '--prop',
      'text=01 市场规模\n2026 年市场规模\n18.4 亿元｜试点 37%',
      '--prop',
      'x=0.7in',
      '--prop',
      'y=3.1in',
      '--prop',
      'width=2.05in',
      '--prop',
      'height=2.05in',
      '--prop',
      'geometry=roundRect',
      '--prop',
      'fill=EAF2FF',
      '--prop',
      'line=4472C4:1.2:solid',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=16pt',
      '--prop',
      'color=1F2937'
    ],
    [
      office,
      'add',
      outputPath,
      '/slide[2]',
      '--type',
      'shape',
      '--prop',
      'text=02 需求结构\n身份与权限治理\n占需求的 46%',
      '--prop',
      'x=2.95in',
      '--prop',
      'y=3.1in',
      '--prop',
      'width=2.05in',
      '--prop',
      'height=2.05in',
      '--prop',
      'geometry=roundRect',
      '--prop',
      'fill=EEF8F2',
      '--prop',
      'line=2F855A:1.2:solid',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=16pt',
      '--prop',
      'color=1F2937'
    ],
    [
      office,
      'add',
      outputPath,
      '/slide[2]',
      '--type',
      'shape',
      '--prop',
      'text=03 风险优先级\n提示注入\n工具权限滥用',
      '--prop',
      'x=5.2in',
      '--prop',
      'y=3.1in',
      '--prop',
      'width=2.05in',
      '--prop',
      'height=2.05in',
      '--prop',
      'geometry=roundRect',
      '--prop',
      'fill=FFF4E6',
      '--prop',
      'line=DD6B20:1.2:solid',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=16pt',
      '--prop',
      'color=1F2937'
    ],
    [
      office,
      'add',
      outputPath,
      '/slide[2]',
      '--type',
      'shape',
      '--prop',
      'text=04 下一步行动\n第一优先行动\n建立工具调用审计',
      '--prop',
      'x=7.45in',
      '--prop',
      'y=3.1in',
      '--prop',
      'width=2.05in',
      '--prop',
      'height=2.05in',
      '--prop',
      'geometry=roundRect',
      '--prop',
      'fill=F3E8FF',
      '--prop',
      'line=7E22CE:1.2:solid',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=16pt',
      '--prop',
      'color=1F2937'
    ],
    [office, 'add', outputPath, '/', '--type', 'slide', '--prop', 'title=摘要｜核心结论'],
    [
      office,
      'add',
      outputPath,
      '/slide[3]',
      '--type',
      'shape',
      '--prop',
      `text=${facts.join('\n')}`,
      '--prop',
      'x=0.9in',
      '--prop',
      'y=1.6in',
      '--prop',
      'width=8.5in',
      '--prop',
      'height=4in',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=20pt'
    ],
    [office, 'add', outputPath, '/', '--type', 'slide', '--prop', 'title=数据表｜细分需求对比'],
    [
      office,
      'add',
      outputPath,
      '/slide[4]',
      '--type',
      'table',
      '--prop',
      'x=0.7in',
      '--prop',
      'y=1.5in',
      '--prop',
      'width=8.6in',
      '--prop',
      'height=3.2in',
      '--prop',
      'data=细分需求,需求占比,建议控制;身份与权限治理,46%,最小权限与强制审批;提示注入防护,高优先级,输入隔离与策略检测;工具调用审计,第一优先行动,记录参数、结果与责任主体',
      '--prop',
      'firstRow=true',
      '--prop',
      'headerFill=4472C4',
      '--prop',
      'bodyFill=F4F6FA',
      '--prop',
      'border.all=1pt solid 666666'
    ],
    [office, 'add', outputPath, '/', '--type', 'slide', '--prop', 'title=数据图｜市场规模与渗透率'],
    [
      office,
      'add',
      outputPath,
      '/slide[5]',
      '--type',
      'chart',
      '--prop',
      'chartType=column',
      '--prop',
      'x=1in',
      '--prop',
      'y=1.5in',
      '--prop',
      'width=8in',
      '--prop',
      'height=4in',
      '--prop',
      'title=市场指标',
      '--prop',
      'categories=市场规模（亿元）,企业试点渗透率（%）',
      '--prop',
      'data=市场指标:18.4,37',
      '--prop',
      'dataLabels=value',
      '--prop',
      'colors=4472C4'
    ],
    [office, 'add', outputPath, '/', '--type', 'slide', '--prop', 'title=图片｜安全控制图示'],
    [
      office,
      'add',
      outputPath,
      '/slide[6]',
      '--type',
      'picture',
      '--prop',
      `src=${imagePath}`,
      '--prop',
      'x=0.7in',
      '--prop',
      'y=1.3in',
      '--prop',
      'width=3.2in',
      '--prop',
      'height=1.8in',
      '--prop',
      `alt=${workspace.requiredImageAltText}`
    ],
    [
      office,
      'add',
      outputPath,
      '/slide[6]',
      '--type',
      'shape',
      '--prop',
      `text=${facts[3]}\n${facts[4]}`,
      '--prop',
      'x=4.2in',
      '--prop',
      'y=1.5in',
      '--prop',
      'width=5in',
      '--prop',
      'height=2.5in',
      '--prop',
      'font.ea=Noto Sans CJK SC',
      '--prop',
      'size=20pt'
    ]
  ]
  commandArgs.push([office, 'save', outputPath])
  const svgCommands = Array.from({ length: 6 }, (_, index) => ({
    args: [
      office,
      'view',
      outputPath,
      'svg',
      '--start',
      String(index + 1),
      '--end',
      String(index + 1)
    ],
    output: join(renderedSlides, `slide-${String(index + 1).padStart(2, '0')}.svg`)
  }))
  if (process.platform === 'win32') {
    return [
      `Set-Location -LiteralPath ${powerShellQuote(workspace.root)}`,
      `$env:OFFICECLI_SKIP_UPDATE = '1'`,
      `$env:OFFICECLI_NO_AUTO_RESIDENT = '1'`,
      `if (-not (Test-Path -LiteralPath ${powerShellQuote(skillContract.localPath)})) { throw 'Verified Runtime-owned OfficeCLI skill is unavailable.' }`,
      `New-Item -ItemType Directory -Force -Path ${powerShellQuote(renderedSlides)} | Out-Null`,
      ...commandArgs.map((args) => powerShellCommand(args)),
      `${powerShellInvocation([office, 'validate', outputPath, '--json'])} | Set-Content -LiteralPath ${powerShellQuote(validationPath)} -Encoding utf8; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      ...svgCommands.map(
        ({ args, output }) =>
          `${powerShellInvocation(args)} | Set-Content -LiteralPath ${powerShellQuote(output)} -Encoding utf8; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
      ),
      `Set-Content -LiteralPath ${powerShellQuote(layoutPath)} -Value ${powerShellQuote(JSON.stringify({ summary: { slide_count: 6 }, renderer: 'officecli-svg' }))} -Encoding utf8`,
      `Write-Output 'officecli:created:6'`
    ].join('; ')
  }
  return [
    `cd ${shellQuote(workspace.root)}`,
    `export OFFICECLI_SKIP_UPDATE=1 OFFICECLI_NO_AUTO_RESIDENT=1`,
    `test -f ${shellQuote(skillContract.localPath)}`,
    `mkdir -p ${shellQuote(renderedSlides)}`,
    ...commandArgs.map((args) => args.map(shellQuote).join(' ')),
    `${[office, 'validate', outputPath, '--json'].map(shellQuote).join(' ')} > ${shellQuote(validationPath)}`,
    ...svgCommands.map(
      ({ args, output }) => `${args.map(shellQuote).join(' ')} > ${shellQuote(output)}`
    ),
    `printf '%s' ${shellQuote(JSON.stringify({ summary: { slide_count: 6 }, renderer: 'officecli-svg' }))} > ${shellQuote(layoutPath)}`,
    `printf '%s' ${shellQuote('officecli:created:6')}`
  ].join(' && ')
}

function runtimeOfficeSkillContractFromContents(
  skill: RuntimeOfficeSkillSnapshot,
  result: {
    status: 'ready'
    contents: string
    localPath?: string
  }
): RuntimeOfficeSkillContract {
  if (!result.localPath) {
    throw new Error('Runtime-owned OfficeCLI skill contents did not include a localPath.')
  }
  const normalizedLocalPath = result.localPath.replaceAll('\\', '/')
  if (
    skill.normalizedId !== normalizedLocalPath ||
    !normalizedLocalPath.endsWith(runtimeOfficeSkillSuffix)
  ) {
    throw new Error(
      `Runtime OfficeCLI skill contents were not loaded from the exact Runtime-owned SKILL.md: ${normalizedLocalPath}`
    )
  }
  if (!/\bload_workspace_dependencies\b/u.test(result.contents)) {
    throw new Error(
      'Runtime OfficeCLI skill instructions do not require load_workspace_dependencies.'
    )
  }
  if (!/\bofficecli\b/iu.test(result.contents) || !/\bpptx\b/iu.test(result.contents)) {
    throw new Error('Runtime OfficeCLI skill instructions do not cover OfficeCLI PPTX usage.')
  }
  const skillRoot = result.localPath.slice(0, -'/SKILL.md'.length)
  return {
    id: skill.id,
    name: skill.name,
    localPath: result.localPath,
    normalizedLocalPath,
    skillRoot,
    instructionsSha256: createHash('sha256').update(result.contents).digest('hex')
  }
}

function parseWorkspaceDependencies(value: string): WorkspaceDependencies {
  const officecli = readInstructionPath(value, 'OfficeCLI', false)
  if (!officecli) {
    throw new Error(
      'load_workspace_dependencies did not return the required verified OfficeCLI path.'
    )
  }
  return { officecli }
}

function readInstructionPath(
  value: string,
  label: string,
  hasVersion: boolean
): string | undefined {
  const line = value.split('\n').find((candidate) => candidate.startsWith(`${label}: `))
  if (!line) return undefined
  const path = line.slice(`${label}: `.length)
  return hasVersion ? path.replace(/ \([^\n]*\)$/u, '') : path
}

async function expectR07QaOutputs(workspace: R07PresentationWorkspace): Promise<void> {
  const [layoutSource, validationSource, renderedSlides] = await Promise.all([
    readFile(join(workspace.root, workspace.layoutReceiptFile), 'utf8'),
    readFile(join(workspace.root, 'officecli-validation.json'), 'utf8'),
    readdir(join(workspace.root, workspace.renderedSlidesDirectory))
  ])
  const layout = JSON.parse(layoutSource) as { summary?: { slide_count?: number } }
  const validation = JSON.parse(validationSource) as {
    success?: boolean
    warnings?: unknown[]
    data?: { count?: number; errors?: unknown[] }
  }
  expect(validation.success).toBe(true)
  expect(validation.warnings ?? []).toHaveLength(0)
  expect(validation.data?.count).toBe(0)
  expect(validation.data?.errors ?? []).toHaveLength(0)
  expect(layout.summary?.slide_count).toBeGreaterThanOrEqual(6)
  const slideFiles = renderedSlides
    .filter((name) => /^slide-\d+\.svg$/u.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
  expect(slideFiles).toEqual(
    Array.from({ length: 6 }, (_, index) => `slide-${String(index + 1).padStart(2, '0')}.svg`)
  )
  await Promise.all(
    slideFiles.map(async (file, index) => {
      const svg = await readFile(
        join(workspace.root, workspace.renderedSlidesDirectory, file),
        'utf8'
      )
      const width = Number(/<svg\b[^>]*\bwidth="(\d+)"/u.exec(svg)?.[1])
      const height = Number(/<svg\b[^>]*\bheight="(\d+)"/u.exec(svg)?.[1])
      expect(width).toBeGreaterThanOrEqual(900)
      expect(height).toBeGreaterThanOrEqual(500)
      expect(svg).toContain(workspace.expectedPageTypes[index]?.titleToken)
      expect(svg).toMatch(/<(?:rect|path|foreignObject|g)\b/u)
    })
  )
}

async function openR07PresentationPreviewAndReadArtifact(
  page: Page,
  workspace: R07PresentationWorkspace,
  testInfo: TestInfo
): Promise<R07ArtifactPreviewResult> {
  await openR07PresentationInWorkspace(page, workspace.outputFile)
  const receiptId = await page
    .locator('[data-slot="right-workspace-shell"]')
    .locator(`[role="tab"][data-workspace-tab-id="artifact:workspace:${workspace.outputFile}"]`)
    .getAttribute('data-workspace-tab-id')
  if (!receiptId) throw new Error('Workspace presentation preview tab did not expose a receipt id.')
  const presentationPath = join(workspace.root, workspace.outputFile)
  const artifact = page.locator('[data-slot="artifact-tab-content"]')
  await expect(artifact).toHaveAttribute('data-artifact-source-id', /.+/u)
  const sourceId = await artifact.getAttribute('data-artifact-source-id')
  if (!sourceId) throw new Error('Workspace presentation preview did not expose a source id.')
  // Start the change round trip after the initial render, and await the
  // subscription before touching the file. Only this source may satisfy it.
  await page.evaluate((artifactSourceId) => {
    const state: { observed: boolean; unsubscribe(): void } = {
      observed: false,
      unsubscribe: () => undefined
    }
    const stateWindow = window as Window & { __r07SourceChange?: typeof state }
    stateWindow.__r07SourceChange = state
    state.unsubscribe = window.desktopApp.workspace.artifacts.onEvent((event) => {
      if (event.sourceId !== artifactSourceId) return
      state.observed = true
      state.unsubscribe()
    })
  }, sourceId)
  try {
    await triggerArtifactPreviewChangeRoundTrip(presentationPath)
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as Window & { __r07SourceChange?: { observed: boolean } }).__r07SourceChange
                ?.observed ?? false
          ),
        { timeout: 20_000, message: 'Workspace artifact preview source event was not received.' }
      )
      .toBe(true)
  } finally {
    await page.evaluate(() => {
      const stateWindow = window as Window & { __r07SourceChange?: { unsubscribe(): void } }
      stateWindow.__r07SourceChange?.unsubscribe()
      delete stateWindow.__r07SourceChange
    })
  }
  const binary = await page.evaluate(async (artifactSourceId) => {
    return window.desktopApp.workspace.artifacts.readBinary({
      version: 1,
      sourceId: artifactSourceId
    })
  }, sourceId)
  if ('unavailable' in binary) {
    throw new Error(`Workspace artifact source became unavailable: ${binary.unavailable}`)
  }
  if (binary.content.kind !== 'binary') {
    throw new Error('Workspace artifact source was too large to hash through readBinary.')
  }
  const workspacePresentationSha256 = await sha256File(presentationPath)
  expect(binary.content.checksum).toBe(workspacePresentationSha256)
  expect(binary.content.generation).toBeGreaterThan(0)
  await expect(artifact).toHaveAttribute('data-artifact-source-id', sourceId)
  await expect(artifact).toHaveAttribute(
    'data-artifact-preview-generation',
    String(binary.content.generation),
    { timeout: 120_000 }
  )
  const previewImages = artifact.locator(
    '[data-slot="presentation-panel"] img[src^="data:image/png;base64,"]'
  )
  await expect(previewImages).toHaveCount(7, { timeout: 120_000 })
  await expect
    .poll(async () =>
      previewImages.first().evaluate((image: HTMLImageElement) => image.naturalWidth)
    )
    .toBeGreaterThan(0)
  const trace = {
    sourceId,
    receiptId,
    generation: binary.content.generation,
    checksum: binary.content.checksum
  }
  const renderedSlideHashes = await writeDisplayedR07PreviewSlides(page, workspace)
  // Preserve the actual inputs and displayed pages even when pixel QA fails.
  await testInfo.attach('r07-presentation.pptx', {
    path: presentationPath,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  })
  for (const file of renderedSlideHashes.keys()) {
    await testInfo.attach(`r07-preview-${file}`, {
      path: join(workspace.root, workspace.renderedSlidesDirectory, file),
      contentType: 'image/png'
    })
  }
  await testInfo.attach('r07-contact-sheet.png', {
    path: join(workspace.root, workspace.contactSheetFile),
    contentType: 'image/png'
  })
  const measuredReceipt = await verifyR07RenderedSlides(workspace)
  const slides = await Promise.all(
    measuredReceipt.slides.map(async (slide) => {
      const sha256 = renderedSlideHashes.get(slide.file)
      if (!sha256) throw new Error(`R07 preview did not capture ${slide.file}.`)
      const metrics = await renderedSlideMetrics(
        join(workspace.root, workspace.renderedSlidesDirectory, slide.file)
      )
      expect(metrics).toMatchObject({
        width: slide.width,
        height: slide.height,
        nonWhiteRatio: slide.nonWhiteRatio,
        colorBucketCount: slide.colorBucketCount
      })
      return {
        ...slide,
        sha256,
        source: {
          kind: 'electron-host-preview' as const,
          artifactSourceId: trace.sourceId,
          receiptId: trace.receiptId,
          generation: trace.generation,
          presentationSha256: trace.checksum
        }
      }
    })
  )
  return {
    trace,
    renderQaReceipt: {
      schemaVersion: 'dascowork-r07-render-qa.v1',
      slides
    }
  }
}

async function writeDisplayedR07PreviewSlides(
  page: Page,
  workspace: R07PresentationWorkspace
): Promise<Map<string, string>> {
  const renderedRoot = join(workspace.root, workspace.renderedSlidesDirectory)
  const slides = await captureR07PreviewSlides({ page, outputDirectory: renderedRoot })
  await writeR07ContactSheet({
    slides,
    outputDirectory: renderedRoot,
    outputPath: join(workspace.root, workspace.contactSheetFile)
  })
  const contactSheetMetrics = await renderedSlideMetrics(
    join(workspace.root, workspace.contactSheetFile)
  )
  expect(contactSheetMetrics).toMatchObject({ width: 1032, height: 456 })
  return new Map(slides.map((slide) => [slide.file, slide.sha256]))
}

async function exportR07VisualArtifacts(input: {
  directory: string
  workspace: R07PresentationWorkspace
  previewTrace: R07ArtifactPreviewTrace
  renderQaReceipt: R07RenderQaReceipt
}): Promise<string> {
  const visualRoot = isAbsolute(input.directory)
    ? input.directory
    : join(input.workspace.root, input.directory)
  const slidesRoot = join(visualRoot, 'slides')
  await mkdir(slidesRoot, { recursive: true })
  await Promise.all([
    copyFile(
      join(input.workspace.root, input.workspace.outputFile),
      join(visualRoot, input.workspace.outputFile)
    ),
    copyFile(
      join(input.workspace.root, input.workspace.contactSheetFile),
      join(visualRoot, input.workspace.contactSheetFile)
    ),
    ...input.renderQaReceipt.slides.map((slide) =>
      copyFile(
        join(input.workspace.root, input.workspace.renderedSlidesDirectory, slide.file),
        join(slidesRoot, slide.file)
      )
    )
  ])
  await writeFile(
    join(visualRoot, 'r07-preview-render-receipt.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'dascowork-r07-visual-artifacts.v1',
        previewTrace: input.previewTrace,
        renderReport: input.renderQaReceipt
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
  return visualRoot
}

async function triggerArtifactPreviewChangeRoundTrip(path: string): Promise<void> {
  const now = new Date()
  await utimes(path, now, now)
}

async function writeR07LiveTraceReport(input: {
  path: string
  logs: readonly string[]
  workspace: R07PresentationWorkspace
  skillContract: RuntimeOfficeSkillContract
  activation: RuntimeActivationTrace
  loaderOutput: string
  runtimeCommandOutput: string
  previewTrace: R07ArtifactPreviewTrace
  renderQaReceipt: R07RenderQaReceipt
  visualArtifactDirectory?: string
  observations: R07EvidenceObservations
}): Promise<void> {
  const appServerTrace = parseR07AppServerTrace(input.logs)
  if (!input.activation.operationId || !input.activation.activeVersion) {
    throw new Error(
      'R07 live trace requires a real Runtime activation operationId and activeVersion.'
    )
  }
  const renderReportSha256 = sha256Text(JSON.stringify(input.renderQaReceipt))
  const report = {
    schemaVersion: 'dascowork-primary-runtime-r07-live-trace.v2',
    capturedAt: new Date().toISOString(),
    threadId: appServerTrace.threadId,
    turnId: appServerTrace.turnId,
    modelEvidence: {
      kind: 'scripted-external-model',
      proves: 'deterministic-desktop-runtime-command-path',
      doesNotProve: 'live-model-skill-compliance'
    },
    skill: {
      id: input.skillContract.id,
      name: input.skillContract.name,
      localPath: input.skillContract.normalizedLocalPath,
      instructionsSha256: input.skillContract.instructionsSha256
    },
    activation: {
      operationId: input.activation.operationId,
      activeVersion: input.activation.activeVersion,
      manifestSequence: input.activation.manifestSequence
    },
    loader: {
      loaderCallId: appServerTrace.loader.callId,
      appServerLogIndex: appServerTrace.loader.logIndex,
      ...input.observations.loader,
      outputSha256: sha256Text(input.loaderOutput)
    },
    command: {
      commandItemId: appServerTrace.command.itemId,
      appServerLogIndex: appServerTrace.command.logIndex,
      ...input.observations.command,
      outputSha256: sha256Text(input.runtimeCommandOutput)
    },
    artifact: {
      artifactSourceId: input.previewTrace.sourceId,
      ...input.observations.artifact,
      generation: input.previewTrace.generation,
      presentationSha256: input.previewTrace.checksum
    },
    preview: {
      receiptId: input.previewTrace.receiptId,
      ...input.observations.preview,
      visible: true,
      presentationSha256: input.previewTrace.checksum
    },
    renderReport: input.renderQaReceipt,
    renderReportSha256,
    ...(input.visualArtifactDirectory
      ? {
          visualArtifacts: {
            directory: input.visualArtifactDirectory
          }
        }
      : {})
  }
  await mkdir(dirname(input.path), { recursive: true })
  await writeFile(input.path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

function parseR07AppServerTrace(logs: readonly string[]): {
  threadId: string
  turnId: string
  loader: { callId: string; logIndex: number }
  command: { itemId: string; logIndex: number }
} {
  let loader: { threadId: string; turnId: string; callId: string; logIndex: number } | undefined
  let command: { threadId: string; turnId: string; itemId: string; logIndex: number } | undefined

  for (const [index, line] of logs.entries()) {
    const packet = codexPacketFromLog(line)
    if (!packet || packet.direction !== 'inbound') continue
    const method = packet.message.method
    const params = packet.message.params
    if (!isRecord(params)) continue
    if (
      method === 'item/tool/call' &&
      params.tool === 'load_workspace_dependencies' &&
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.callId === 'string'
    ) {
      loader = {
        threadId: params.threadId,
        turnId: params.turnId,
        callId: params.callId,
        logIndex: index + 1
      }
    } else if (
      method === 'item/commandExecution/requestApproval' &&
      typeof params.threadId === 'string' &&
      typeof params.turnId === 'string' &&
      typeof params.itemId === 'string'
    ) {
      command = {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        logIndex: index + 1
      }
    }
  }

  if (!loader) throw new Error('R07 live trace did not include the app-server loader call.')
  if (!command) throw new Error('R07 live trace did not include the app-server command approval.')
  if (loader.threadId !== command.threadId || loader.turnId !== command.turnId) {
    throw new Error('R07 live trace loader and command belong to different turns.')
  }
  if (loader.logIndex >= command.logIndex) {
    throw new Error('R07 live trace command was not observed after the loader call.')
  }
  return {
    threadId: loader.threadId,
    turnId: loader.turnId,
    loader: { callId: loader.callId, logIndex: loader.logIndex },
    command: { itemId: command.itemId, logIndex: command.logIndex }
  }
}

function codexPacketFromLog(line: string):
  | {
      direction?: unknown
      message: { method?: unknown; params?: unknown }
    }
  | undefined {
  const marker = '[codex packet] '
  const index = line.indexOf(marker)
  if (index < 0) return undefined
  try {
    const packet = JSON.parse(line.slice(index + marker.length)) as unknown
    if (isRecord(packet) && isRecord(packet.message) && typeof packet.message.method === 'string') {
      return {
        direction: packet.direction,
        message: {
          method: packet.message.method,
          params: packet.message.params
        }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powerShellCommand(args: readonly string[]): string {
  return `${powerShellInvocation(args)}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`
}

function powerShellInvocation(args: readonly string[]): string {
  return `& ${args.map(powerShellQuote).join(' ')}`
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
