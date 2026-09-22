import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

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
  verifyR07Presentation,
  verifyR07RenderedSlides,
  withR07PresentationWorkspace,
  type R07RenderQaReceipt,
  type R07PresentationWorkspace
} from './support/r07Presentation'
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
const primaryRuntimeE2eTimeoutMs = 600_000
const primaryRuntimeReadinessTimeoutMs = 300_000

type WorkspaceDependencies = {
  node: string
  nodeModules: string
  python: string
  pythonPackages: string[]
  soffice: string
  pdftoppm: string
  font: string
}

type RuntimePresentationSkillSnapshot = {
  id: string
  normalizedId: string
  name: string
  scope: string | null
  sourceKind: string | null
  enabled: boolean
  installed: boolean
}

type RuntimePresentationSkillContract = {
  id: string
  name: string
  localPath: string
  normalizedLocalPath: string
  skillRoot: string
  instructionsSha256: string
  scripts: {
    build: string
    layout: string
    render: string
  }
}

type R07ArtifactPreviewTrace = {
  sourceId: string
  receiptId: string
  generation: number
  checksum: string
}

type RuntimeActivationTrace = {
  operationId?: string
  activeVersion?: string
  manifestSequence?: number
}

const runtimePresentationSkillSuffix =
  '/skills/dascowork-primary-runtime/presentation-skill/SKILL.md'
const runtimePresentationSkillScriptRefs = {
  build: 'scripts/build_deck_pptxgenjs.js',
  layout: 'scripts/layout_lint.py',
  render: 'scripts/render_slides.py'
} as const

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
          coldInstallMs: positiveDuration(readyAtMs - launchStartedAtMs),
          chatInstallOverlapMs: positiveDuration(
            Math.min(chatCompletedAtMs, readyAtMs) - Math.max(chatStartedAtMs, firstInstallingAtMs)
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
            responseMs: positiveDuration(chatCompletedAtMs - chatStartedAtMs),
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

test('AT-E2E-01/PRESENTATION-SKILL-RUNTIME installs a signed Feed Runtime and creates an R07 presentation through a normal command', async ({
  browserName
}, testInfo) => {
  // The target-native calibration archive is intentionally large enough that
  // download, staging, activation, plugin sync, QA, and render can exceed the
  // generic 60-second default. P3b separately measures the numeric cold-install
  // budget; this timeout only keeps the real end-to-end acceptance path intact.
  test.setTimeout(primaryRuntimeE2eTimeoutMs)
  expect(browserName).toBe('chromium')

  await withR07PresentationWorkspace(async (workspace) => {
    let runtimePresentationSkillContract: RuntimePresentationSkillContract | undefined
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
        (request) =>
          runtimePresentationCommandResponse(request, workspace, runtimePresentationSkillContract),
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
      runtimePresentationSkillContract = await expectRuntimePresentationSkill(page)
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
      expect(serializeDiagnosticData({ runtimeCommandOutput })).toContain(
        'presentation-skill:created:6'
      )

      const loaderRequest = providerBodies.find((body) =>
        Boolean(functionCallOutputText(body, loaderCallId))
      )
      const loaderOutput = loaderRequest
        ? functionCallOutputText(loaderRequest, loaderCallId)
        : undefined
      expect(loaderOutput).toBeTruthy()
      const dependencies = parseWorkspaceDependencies(loaderOutput!)
      for (const value of [
        dependencies.node,
        dependencies.nodeModules,
        dependencies.python,
        ...dependencies.pythonPackages,
        dependencies.soffice,
        dependencies.pdftoppm,
        dependencies.font
      ]) {
        expect(isAbsolute(value)).toBe(true)
      }
      expect(loaderOutput).toContain('Use only the following verified Primary Runtime paths.')
      expect(loaderOutput).toContain('Runtime Python packages:')
      expect(loaderOutput).toContain('Runtime fonts:')
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
      const renderQaReceipt = await expectR07QaOutputs(workspace)
      const previewTrace = await openR07PresentationPreviewAndReadArtifact(page, workspace)
      if (appToolsLiveTraceReportPath) {
        await writeR07LiveTraceReport({
          path: appToolsLiveTraceReportPath,
          logs,
          workspace,
          skillContract: runtimePresentationSkillContract,
          activation: runtimeActivation,
          loaderOutput: loaderOutput!,
          runtimeCommandOutput: runtimeCommandOutput!,
          previewTrace,
          renderQaReceipt
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
  return app.evaluate((_, probeId) => {
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
    const positiveMainDuration = (value: number): number =>
      Math.max(1, Math.ceil(Number.isFinite(value) ? value : 1))
    return {
      source: 'electron-main' as const,
      startedAtMs: positiveMainDuration(probe.startedAtMs),
      stoppedAtMs: positiveMainDuration(performance.now()),
      p99Ms: positiveMainDuration(probe.monitor.percentile(99) / 1_000_000),
      maxMs: positiveMainDuration(probe.monitor.max / 1_000_000)
    }
  }, id)
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
        const available = Math.max(1, Math.floor(filesystem.bavail * filesystem.bsize))
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
  return app.evaluate(async (_, probeId) => {
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
    const available = Math.max(1, Math.floor(filesystem.bavail * filesystem.bsize))
    probe.minimumAvailableDiskBytes = Math.min(probe.minimumAvailableDiskBytes, available)
    probe.sampleCount += 1
    probes?.delete(probeId)
    return {
      source: 'electron-main' as const,
      pathKind: 'userData' as const,
      minimumAvailableDiskBytes: Math.max(1, Math.floor(probe.minimumAvailableDiskBytes)),
      sampleCount: probe.sampleCount
    }
  }, id)
}

function positiveDuration(value: number): number {
  return Math.max(1, Math.ceil(Number.isFinite(value) ? value : 1))
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

async function expectRuntimePresentationSkill(
  page: Page
): Promise<RuntimePresentationSkillContract> {
  let runtimeSkill: RuntimePresentationSkillSnapshot | null = null
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
              candidate.name === 'presentation-skill' &&
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
        }, runtimePresentationSkillSuffix)
        return runtimeSkill
      },
      { timeout: 120_000 }
    )
    .toMatchObject({
      name: 'presentation-skill',
      scope: 'personal',
      sourceKind: 'personal',
      enabled: true,
      installed: true
    })
  if (!runtimeSkill) throw new Error('Runtime-owned presentation skill was not listed.')

  const contents = await page.evaluate(async (skill) => {
    return window.desktopApp.plugins.getSkillContents({
      version: 1,
      skill: { id: skill.id, name: skill.name },
      forceRefresh: true
    })
  }, runtimeSkill)
  if (contents.status !== 'ready') {
    throw new Error(
      `Runtime-owned presentation skill contents were unavailable: ${contents.status}`
    )
  }
  return runtimePresentationSkillContractFromContents(runtimeSkill, contents)
}

function runtimePresentationCommandResponse(
  request: MockRequest,
  workspace: R07PresentationWorkspace,
  skillContract: RuntimePresentationSkillContract | undefined
): ResponsesStep {
  if (!skillContract) {
    throw new Error(
      'The Runtime presentation command was requested before skill contents were verified.'
    )
  }
  const loaderOutput = functionCallOutputText(JSON.parse(request.body) as unknown, loaderCallId)
  if (!loaderOutput) {
    throw new Error('The Runtime Node command was requested before loader output was returned.')
  }
  const dependencies = parseWorkspaceDependencies(loaderOutput)
  const source = runtimePresentationCommandSource(dependencies, workspace, skillContract)
  // Passing a base64 payload prevents shell quoting from changing the command
  // source on Windows. The only executable remains the Runtime Node path from
  // load_workspace_dependencies; this is still one ordinary command item.
  const encodedSource = Buffer.from(source, 'utf8').toString('base64')
  // The Windows desktop command shell is PowerShell. A quoted executable path
  // is parsed as a string there unless it is prefixed with the call operator;
  // keep the POSIX form unchanged for the native Linux/macOS runners.
  const nodeExecutable =
    process.platform === 'win32'
      ? `& ${shellQuote(dependencies.node)}`
      : shellQuote(dependencies.node)
  const command = [
    nodeExecutable,
    '--input-type=module',
    '-e',
    // `eval` parses its input as a classic script even when Node itself is
    // running in ESM mode. Importing the same Base64 payload as a data module
    // preserves the source's top-level imports on every target platform.
    shellQuote(`await import('data:text/javascript;base64,${encodedSource}')`)
  ].join(' ')

  return shellCommandResponse('response-runtime-command', runtimeCommandCallId, {
    command,
    // Rendering the generated PDF pages can exceed the app-server command
    // default on cold macOS runners. This is an acceptance-path allowance;
    // P3b still measures and enforces the cold-install performance budget.
    timeout_ms: 60_000,
    sandbox_permissions: 'require_escalated',
    justification:
      'The signed Primary Runtime presentation command needs its one-time approved execution path.'
  })
}

function runtimePresentationCommandSource(
  dependencies: WorkspaceDependencies,
  workspace: R07PresentationWorkspace,
  skillContract: RuntimePresentationSkillContract
): string {
  const facts = workspace.facts.map((fact) => fact.value)
  return [
    "import { execFileSync } from 'node:child_process'",
    "import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { dirname, join, delimiter, resolve, sep } from 'node:path'",
    "import { pathToFileURL } from 'node:url'",
    `const dependencies = ${JSON.stringify(dependencies)}`,
    `const skillContract = ${JSON.stringify(skillContract)}`,
    `const workspace = ${JSON.stringify({
      root: workspace.root,
      inputFile: workspace.inputFile,
      outputFile: workspace.outputFile,
      imageFile: workspace.imageFile,
      layoutReceiptFile: workspace.layoutReceiptFile,
      renderedSlidesDirectory: workspace.renderedSlidesDirectory,
      contactSheetFile: workspace.contactSheetFile,
      requiredImageAltText: workspace.requiredImageAltText,
      facts
    })}`,
    'const skillRoot = skillContract.skillRoot',
    "if (!skillRoot || !existsSync(skillRoot) || !existsSync(skillContract.localPath)) throw new Error('Verified Runtime-owned presentation skill is unavailable.')",
    'const resolveSkillScript = (relativePath) => { const resolved = resolve(skillRoot, relativePath); const boundary = `${resolve(skillRoot)}${sep}`; if (!resolved.startsWith(boundary)) throw new Error(`Runtime presentation script escapes skill root: ${relativePath}`); if (!existsSync(resolved)) throw new Error(`Runtime presentation script is missing: ${relativePath}`); return resolved }',
    'const scripts = { build: resolveSkillScript(skillContract.scripts.build), layout: resolveSkillScript(skillContract.scripts.layout), render: resolveSkillScript(skillContract.scripts.render) }',
    "const inputHtml = readFileSync(join(workspace.root, workspace.inputFile), 'utf8')",
    'for (const fact of workspace.facts) if (!inputHtml.includes(fact)) throw new Error(`Workspace HTML is missing required fact: ${fact}`)',
    "const outlinePath = join(workspace.root, 'r07-outline.json')",
    'const outputPath = join(workspace.root, workspace.outputFile)',
    'const layoutPath = join(workspace.root, workspace.layoutReceiptFile)',
    'const renderedSlides = join(workspace.root, workspace.renderedSlidesDirectory)',
    'const contactSheet = join(workspace.root, workspace.contactSheetFile)',
    'const imagePath = join(workspace.root, workspace.imageFile)',
    "const libreOfficeProfile = join(workspace.root, 'libreoffice-profile')",
    "const outline = { title: 'AI Agent 安全市场', deck_style: { font_pair: 'dascowork_cjk_v1', visual_density: 'medium', emoji_mode: 'none' }, slides: [",
    "  { type: 'title', title: '封面｜AI Agent 安全市场', subtitle: '从市场机会到可审计的工具调用治理' },",
    "  { type: 'section', title: '议程｜市场机会与风险', subtitle: '市场规模、需求结构、风险优先级与下一步行动' },",
    "  { type: 'content', variant: 'standard', title: '摘要｜核心结论', subtitle: '来自工作区 HTML 的五项可验证事实', bullets: workspace.facts, footer: '来源：工作区 AI Agent 安全市场 HTML' },",
    "  { type: 'content', variant: 'table', title: '数据表｜细分需求对比', subtitle: '客户需求按控制面归类', table: { headers: ['细分需求', '需求占比', '建议控制'], rows: [['身份与权限治理', '46%', '最小权限与强制审批'], ['提示注入防护', '高优先级', '输入隔离与策略检测'], ['工具调用审计', '第一优先行动', '记录参数、结果与责任主体']], caption: '需求结构来自工作区输入', footnotes: ['表格用于决策对比，不替代完整市场研究'] } },",
    "  { type: 'content', variant: 'chart', title: '数据图｜市场规模与渗透率', subtitle: '市场规模与企业试点采用的可视化读数', chart: { type: 'bar', series: [{ name: '市场指标', labels: ['市场规模（亿元）', '企业试点渗透率（%）'], values: [18.4, 37] }], facts: [{ value: '18.4 亿元', label: '2026 年 AI Agent 安全市场规模' }, { value: '37%', label: '企业试点渗透率' }], options: { showValue: true, catAxisTitle: '指标', valAxisTitle: '数值' } }, message: '市场规模与企业试点渗透率均来自工作区输入。' },",
    "  { type: 'content', variant: 'image-sidebar', title: '图片｜安全控制图示', subtitle: '把高优先级风险映射到可审计动作', image_alt_text: workspace.requiredImageAltText, image_side: 'left', assets: { image: workspace.imageFile }, caption: '本地工作区图片；无网络下载。', sidebar_sections: [{ title: '高优先级风险', body: workspace.facts[3] }, { title: '第一优先行动', body: workspace.facts[4] }, { title: '执行边界', body: '通过普通 command 保留 sandbox 与审批。' }] }",
    '] }',
    "writeFileSync(outlinePath, `${JSON.stringify(outline, null, 2)}\\n`, 'utf8')",
    "const fontConfig = join(workspace.root, 'r07-fonts.conf')",
    "const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\\\"', '&quot;').replaceAll(\"'\", '&apos;')",
    'writeFileSync(fontConfig, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapeXml(dirname(dependencies.font))}</dir></fontconfig>`, \'utf8\')',
    'const commonEnv = { ...process.env, PPTX_NODE_MODULES: dependencies.nodeModules, NODE_PATH: dependencies.nodeModules }',
    "execFileSync(dependencies.node, [scripts.build, '--outline', outlinePath, '--output', outputPath, '--asset-root', workspace.root], { cwd: workspace.root, env: commonEnv, stdio: 'inherit' })",
    "const pythonEnv = { ...process.env, PYTHONPATH: [join(skillRoot, 'scripts'), ...dependencies.pythonPackages].join(delimiter), PYTHONNOUSERSITE: '1' }",
    'mkdirSync(libreOfficeProfile, { recursive: true })',
    "execFileSync(dependencies.python, [scripts.layout, '--input', outputPath, '--outline', outlinePath, '--output', layoutPath, '--fail-on-error'], { cwd: workspace.root, env: pythonEnv, stdio: 'inherit' })",
    // Keep runtime-native tools ahead of the host while retaining the system
    // utilities that the bundled LibreOffice launcher invokes internally.
    "const runtimeSystemPaths = process.platform === 'win32' ? [`${process.env.SystemRoot || 'C:\\\\Windows'}\\\\System32`, process.env.SystemRoot || 'C:\\\\Windows'] : process.platform === 'darwin' ? ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] : ['/usr/bin', '/bin']",
    "const renderEnv = { ...pythonEnv, FONTCONFIG_FILE: fontConfig, FONTCONFIG_PATH: dirname(dependencies.font), PPTX_RUNTIME_SOFFICE: dependencies.soffice, PPTX_RUNTIME_PDFTOPPM: dependencies.pdftoppm, ...(process.platform === 'win32' ? { APPDATA: join(libreOfficeProfile, 'AppData', 'Roaming'), LOCALAPPDATA: join(libreOfficeProfile, 'AppData', 'Local'), PPTX_RUNTIME_SOFFICE_USER_INSTALLATION: `-env:UserInstallation=${pathToFileURL(libreOfficeProfile).href}`, USERPROFILE: libreOfficeProfile } : {}), PATH: [dirname(dependencies.soffice), dirname(dependencies.pdftoppm), ...runtimeSystemPaths, process.env.PATH].filter(Boolean).join(delimiter) }",
    "execFileSync(dependencies.python, [scripts.render, '--input', outputPath, '--outdir', renderedSlides, '--format', 'png'], { cwd: workspace.root, env: renderEnv, stdio: 'inherit' })",
    "const contactSheetScript = `from pathlib import Path\\nfrom PIL import Image, ImageDraw\\nimport sys\\nsource=Path(sys.argv[1])\\nout=Path(sys.argv[2])\\npaths=sorted(source.glob('slide-*.png'))\\nif len(paths) < 6: raise SystemExit('expected six rendered slides')\\nthumbs=[]\\nfor path in paths:\\n    image=Image.open(path).convert('RGB')\\n    image.thumbnail((420, 236))\\n    canvas=Image.new('RGB', (432, 268), 'white')\\n    canvas.paste(image, ((432-image.width)//2, 8))\\n    ImageDraw.Draw(canvas).text((8, 246), path.name, fill='black')\\n    thumbs.append(canvas)\\nsheet=Image.new('RGB', (864, ((len(thumbs)+1)//2)*268), 'white')\\nfor i, image in enumerate(thumbs): sheet.paste(image, ((i%2)*432, (i//2)*268))\\nsheet.save(out, 'PNG')`",
    "execFileSync(dependencies.python, ['-c', contactSheetScript, renderedSlides, contactSheet], { cwd: workspace.root, env: renderEnv, stdio: 'inherit' })",
    'const rendered = readdirSync(renderedSlides).filter((name) => /^slide-\\d+\\.png$/u.test(name))',
    "if (rendered.length < 6 || !existsSync(contactSheet) || !existsSync(layoutPath) || !existsSync(outputPath) || !existsSync(imagePath)) throw new Error('Runtime presentation QA outputs are incomplete.')",
    'process.stdout.write(`presentation-skill:created:${rendered.length}`)'
    // Source rows already carry the commas needed by the outline's slide array.
    // Newlines preserve that syntax, whereas semicolon joining would inject
    // invalid `,;` separators between array elements.
  ].join('\n')
}

function runtimePresentationSkillContractFromContents(
  skill: RuntimePresentationSkillSnapshot,
  result: {
    status: 'ready'
    contents: string
    localPath?: string
  }
): RuntimePresentationSkillContract {
  if (!result.localPath) {
    throw new Error('Runtime-owned presentation skill contents did not include a localPath.')
  }
  const normalizedLocalPath = result.localPath.replaceAll('\\', '/')
  if (
    skill.normalizedId !== normalizedLocalPath ||
    !normalizedLocalPath.endsWith(runtimePresentationSkillSuffix)
  ) {
    throw new Error(
      `Runtime presentation skill contents were not loaded from the exact Runtime-owned SKILL.md: ${normalizedLocalPath}`
    )
  }
  if (!/\bload_workspace_dependencies\b/u.test(result.contents)) {
    throw new Error(
      'Runtime presentation skill instructions do not require load_workspace_dependencies.'
    )
  }
  for (const relativePath of Object.values(runtimePresentationSkillScriptRefs)) {
    if (!result.contents.includes(relativePath)) {
      throw new Error(`Runtime presentation skill instructions are missing ${relativePath}.`)
    }
  }
  const skillRoot = result.localPath.slice(0, -'/SKILL.md'.length)
  return {
    id: skill.id,
    name: skill.name,
    localPath: result.localPath,
    normalizedLocalPath,
    skillRoot,
    instructionsSha256: createHash('sha256').update(result.contents).digest('hex'),
    scripts: { ...runtimePresentationSkillScriptRefs }
  }
}

function parseWorkspaceDependencies(value: string): WorkspaceDependencies {
  const node = readInstructionPath(value, 'Runtime Node', true)
  const nodeModules = readInstructionPath(value, 'Runtime Node modules', false)
  const python = readInstructionPath(value, 'Runtime Python', true)
  const pythonPackages = readInstructionList(value, 'Runtime Python packages:')
  const soffice = readNamedInstructionPath(value, 'Runtime binaries:', 'soffice')
  const pdftoppm = readNamedInstructionPath(value, 'Runtime binaries:', 'pdftoppm')
  const font = readNamedInstructionPath(value, 'Runtime fonts:', 'noto-sans-cjk-sc')
  if (
    !node ||
    !nodeModules ||
    !python ||
    !pythonPackages.length ||
    !soffice ||
    !pdftoppm ||
    !font
  ) {
    throw new Error(
      'load_workspace_dependencies did not return the required Runtime Node, Python, binary, and font instructions.'
    )
  }
  return { node, nodeModules, python, pythonPackages, soffice, pdftoppm, font }
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

function readInstructionList(value: string, heading: string): string[] {
  const lines = value.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) return []
  const paths: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break
    paths.push(line.slice(2))
  }
  return paths
}

function readNamedInstructionPath(
  value: string,
  heading: string,
  name: string
): string | undefined {
  const prefix = `${name}: `
  return readInstructionList(value, heading)
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
}

async function expectR07QaOutputs(
  workspace: R07PresentationWorkspace
): Promise<R07RenderQaReceipt> {
  const [layoutSource, renderedSlides] = await Promise.all([
    readFile(join(workspace.root, workspace.layoutReceiptFile), 'utf8'),
    readdir(join(workspace.root, workspace.renderedSlidesDirectory))
  ])
  const layout = JSON.parse(layoutSource) as { summary?: { slide_count?: number } }
  expect(layout.summary?.slide_count).toBeGreaterThanOrEqual(6)
  expect(renderedSlides.filter((name) => /^slide-\d+\.png$/u.test(name))).toHaveLength(6)
  const renderQaReceipt = await verifyR07RenderedSlides(workspace)
  await expect(access(join(workspace.root, workspace.contactSheetFile))).resolves.toBeUndefined()
  return renderQaReceipt
}

async function openR07PresentationPreviewAndReadArtifact(
  page: Page,
  workspace: R07PresentationWorkspace
): Promise<R07ArtifactPreviewTrace> {
  const sourceEvent = page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          unsubscribe()
          reject(new Error('Timed out waiting for the workspace artifact preview source event.'))
        }, 20_000)
        const unsubscribe = window.desktopApp.workspace.artifacts.onEvent((event) => {
          window.clearTimeout(timeout)
          unsubscribe()
          resolve(event.sourceId)
        })
      })
  )
  await openR07PresentationInWorkspace(page, workspace.outputFile)
  const receiptId = await page
    .locator('[data-slot="right-workspace-shell"]')
    .locator(`[role="tab"][data-workspace-tab-id="artifact:workspace:${workspace.outputFile}"]`)
    .getAttribute('data-workspace-tab-id')
  if (!receiptId) throw new Error('Workspace presentation preview tab did not expose a receipt id.')
  const presentationPath = join(workspace.root, workspace.outputFile)
  await triggerArtifactPreviewChangeRoundTrip(presentationPath)
  const sourceId = await sourceEvent
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
  return {
    sourceId,
    receiptId,
    generation: binary.content.generation,
    checksum: binary.content.checksum
  }
}

async function triggerArtifactPreviewChangeRoundTrip(path: string): Promise<void> {
  const now = new Date()
  await utimes(path, now, now)
}

async function writeR07LiveTraceReport(input: {
  path: string
  logs: readonly string[]
  workspace: R07PresentationWorkspace
  skillContract: RuntimePresentationSkillContract
  activation: RuntimeActivationTrace
  loaderOutput: string
  runtimeCommandOutput: string
  previewTrace: R07ArtifactPreviewTrace
  renderQaReceipt: R07RenderQaReceipt
}): Promise<void> {
  const appServerTrace = parseR07AppServerTrace(input.logs)
  if (!input.activation.operationId || !input.activation.activeVersion) {
    throw new Error(
      'R07 live trace requires a real Runtime activation operationId and activeVersion.'
    )
  }
  const renderReportSha256 = sha256Text(JSON.stringify(input.renderQaReceipt))
  const report = {
    schemaVersion: 'dascowork-primary-runtime-r07-live-trace.v1',
    capturedAt: new Date().toISOString(),
    threadId: appServerTrace.threadId,
    turnId: appServerTrace.turnId,
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
      sequence: 1,
      outputSha256: sha256Text(input.loaderOutput)
    },
    command: {
      commandItemId: appServerTrace.command.itemId,
      sequence: 2,
      outputSha256: sha256Text(input.runtimeCommandOutput)
    },
    artifact: {
      artifactSourceId: input.previewTrace.sourceId,
      sequence: 3,
      generation: input.previewTrace.generation,
      presentationSha256: input.previewTrace.checksum
    },
    preview: {
      receiptId: input.previewTrace.receiptId,
      sequence: 4,
      visible: true,
      presentationSha256: input.previewTrace.checksum
    },
    renderReport: input.renderQaReceipt,
    renderReportSha256
  }
  await mkdir(dirname(input.path), { recursive: true })
  await writeFile(input.path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
}

function parseR07AppServerTrace(logs: readonly string[]): {
  threadId: string
  turnId: string
  loader: { callId: string; sequence: number }
  command: { itemId: string; sequence: number }
} {
  let loader: { threadId: string; turnId: string; callId: string; sequence: number } | undefined
  let command: { threadId: string; turnId: string; itemId: string; sequence: number } | undefined

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
        sequence: index + 1
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
        sequence: index + 1
      }
    }
  }

  if (!loader) throw new Error('R07 live trace did not include the app-server loader call.')
  if (!command) throw new Error('R07 live trace did not include the app-server command approval.')
  if (loader.threadId !== command.threadId || loader.turnId !== command.turnId) {
    throw new Error('R07 live trace loader and command belong to different turns.')
  }
  if (loader.sequence >= command.sequence) {
    throw new Error('R07 live trace command was not observed after the loader call.')
  }
  return {
    threadId: loader.threadId,
    turnId: loader.turnId,
    loader: { callId: loader.callId, sequence: loader.sequence },
    command: { itemId: command.itemId, sequence: command.sequence }
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
