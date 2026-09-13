import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

import {
  attachDiagnostics,
  closeApp,
  collectRendererLogs,
  launchApp,
  serializeDiagnosticData
} from './support/app'
import { sendMessage } from './support/chatActions'
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

type WorkspaceDependencies = {
  node: string
  nodeModules: string
}

test('AT-E2E-01 installs a signed Feed Runtime and creates a presentation through a normal command', async ({
  browserName
}, testInfo) => {
  // The target-native calibration archive is intentionally large enough that
  // download, staging, activation, and plugin sync can exceed Playwright's
  // generic 60-second default. P3b separately measures the numeric cold-install
  // budget; this timeout only keeps the real end-to-end acceptance path intact.
  test.setTimeout(180_000)
  expect(browserName).toBe('chromium')

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
      runtimePresentationCommandResponse,
      assistantMessageResponse(
        'response-runtime-final',
        'message-runtime-final',
        'The signed Primary Runtime created a presentation through the native desktop command path.'
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      environment: {
        // The runner supplies only signed product-config inputs and removes all
        // direct root/archive overrides before this process is started.
        CODEX_APP_SERVER_BIN: undefined
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    // A Runtime update is deliberately non-blocking for ordinary chat. This
    // response is asserted before waiting for Runtime readiness, so the test
    // cannot pass by serialising normal app-server traffic behind installation.
    await sendMessage(
      page,
      'Please confirm that normal chat remains available during Runtime setup.'
    )
    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'The ordinary app-server chat stayed responsive while the Runtime installation ran.'
    )
    await expectPrimaryRuntimeReady(page, logs)
    await expectRuntimePresentationSkill(page)
    await sendMessage(page, 'Load the verified workspace Runtime and create a new presentation.')

    const approvalPanel = page.locator('[data-slot="server-request-panel"]')
    await expect(approvalPanel).toContainText('是否允许执行以下命令？')
    await expect(approvalPanel).toContainText('pptxgenjs')
    await approvalPanel.getByRole('button', { name: '允许一次', exact: true }).click()

    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'The signed Primary Runtime created a presentation through the native desktop command path.'
    )

    const providerBodies = providerResponseBodies(backend)
    expect(functionCallOutputCount(providerBodies, loaderCallId)).toBe(1)
    expect(functionCallOutputCount(providerBodies, runtimeCommandCallId)).toBe(1)

    const loaderRequest = providerBodies.find((body) =>
      Boolean(functionCallOutputText(body, loaderCallId))
    )
    const loaderOutput = loaderRequest
      ? functionCallOutputText(loaderRequest, loaderCallId)
      : undefined
    expect(loaderOutput).toBeTruthy()
    const dependencies = parseWorkspaceDependencies(loaderOutput!)
    expect(dependencies.node.startsWith('/')).toBe(true)
    expect(dependencies.nodeModules.startsWith('/')).toBe(true)
    expect(loaderOutput).toContain('Use only the following verified Primary Runtime paths.')
    expect(loaderOutput).not.toContain('Primary Runtime root:')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

async function expectPrimaryRuntimeReady(page: Page, logs: readonly string[]): Promise<void> {
  let latestStatus: unknown
  try {
    await expect
      .poll(
        async () => {
          latestStatus = await page.evaluate(async () => {
            const result = await window.desktopApp.plugins.getPrimaryRuntimeStatus({ version: 1 })
            return result.runtime
          })
          return (latestStatus as { state?: unknown }).state
        },
        { timeout: 120_000 }
      )
      .toBe('ready')
  } catch (error) {
    const diagnosticLogs = safePrimaryRuntimeDiagnosticLogs(logs)
    throw new Error(
      `Primary Runtime did not become ready: ${JSON.stringify(latestStatus)}\n${diagnosticLogs}`,
      { cause: error }
    )
  }
}

function safePrimaryRuntimeDiagnosticLogs(logs: readonly string[]): string {
  try {
    // Main output is only included after the shared diagnostic serializer has
    // redacted credentials. Keep the failure surface bounded and relevant.
    return serializeDiagnosticData({ primaryRuntimeLogs: logs.slice(-32) }).slice(-8_000)
  } catch {
    return 'Primary Runtime diagnostic logs were unavailable after redaction.'
  }
}

async function expectRuntimePresentationSkill(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.desktopApp.plugins.getSnapshot({
            version: 1,
            sections: ['skills']
          })
          return result.snapshot.skills.some(
            (skill) => skill.enabled && /presentation/i.test(skill.name)
          )
        }),
      { timeout: 120_000 }
    )
    .toBe(true)
}

function runtimePresentationCommandResponse(request: MockRequest): ResponsesStep {
  const loaderOutput = functionCallOutputText(JSON.parse(request.body) as unknown, loaderCallId)
  if (!loaderOutput) {
    throw new Error('The Runtime Node command was requested before loader output was returned.')
  }
  const dependencies = parseWorkspaceDependencies(loaderOutput)
  const command = [
    `NODE_PATH=${shellQuote(dependencies.nodeModules)}`,
    shellQuote(dependencies.node),
    '--input-type=module',
    '-e',
    shellQuote(
      [
        "import pptxgen from 'pptxgenjs'",
        'const deck = new pptxgen()',
        "deck.layout = 'LAYOUT_WIDE'",
        'const slide = deck.addSlide()',
        "slide.addText('Primary Runtime presentation', { x: 0.7, y: 0.7, w: 10, h: 0.6 })",
        "await deck.writeFile({ fileName: 'primary-runtime-e2e.pptx' })",
        "process.stdout.write('pptxgenjs:created')"
      ].join('; ')
    )
  ].join(' ')

  return shellCommandResponse('response-runtime-command', runtimeCommandCallId, { command })
}

function parseWorkspaceDependencies(value: string): WorkspaceDependencies {
  const node = readInstructionPath(value, 'Runtime Node', true)
  const nodeModules = readInstructionPath(value, 'Runtime Node modules', false)
  if (!node || !nodeModules) {
    throw new Error(
      'load_workspace_dependencies did not return the required Runtime Node instructions.'
    )
  }
  return { node, nodeModules }
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
