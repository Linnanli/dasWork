import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

import { attachDiagnostics, closeApp, collectRendererLogs, launchApp } from './support/app'
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

const loaderCallId = 'call-synthetic-runtime-loader'
const runtimeCommandCallId = 'call-synthetic-runtime-package'
const syntheticPackageName = '@dascowork/test-artifact-tool'

type WorkspaceDependencies = {
  node: string
  nodeModules: string
}

test('AT-E2E-SYNTHETIC-01 installs a test-only signed Feed Runtime and loads its owned synthetic package', async ({
  browserName
}, testInfo) => {
  // Initial app-plugin reconciliation runs against the real app-server and
  // can consume most of the generic E2E budget before Feed installation.
  testInfo.setTimeout(180_000)
  expect(browserName).toBe('chromium')

  const backend = await startMockBackend({
    responses: [
      dynamicFunctionCallResponse(
        'response-synthetic-runtime-loader',
        loaderCallId,
        'load_workspace_dependencies',
        {},
        { namespace: 'codex_app' }
      ),
      syntheticRuntimeCommandResponse,
      assistantMessageResponse(
        'response-synthetic-runtime-final',
        'message-synthetic-runtime-final',
        'The synthetic signed Runtime completed the local Feed test through the native desktop registry.'
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, {
      environment: {
        CODEX_APP_SERVER_BIN: undefined,
        DASCOWORK_PRIMARY_RUNTIME_ALLOW_SYNTHETIC_TEST_RUNTIME: '1'
      }
    })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)

    // Do not make this test's first install depend on startup reconciliation
    // timing. This uses the same Main-owned plugin-center operation a user
    // invokes, while the runner still supplies only signed Feed inputs.
    await page.evaluate(async () => {
      await window.desktopApp.plugins.installOrRepairPrimaryRuntime({ version: 1 })
    })
    await expectPrimaryRuntimeReady(page)
    await expectSyntheticPresentationSkill(page)
    await sendMessage(page, 'Load the signed synthetic test Runtime and confirm its owned package.')

    await expect(page.locator('[data-role="assistant"]')).toContainText(
      'The synthetic signed Runtime completed the local Feed test through the native desktop registry.'
    )

    const providerBodies = providerResponseBodies(backend)
    // Follow-up Responses requests retain preceding tool outputs as context,
    // so count their presence rather than treating that replay as a second
    // desktop tool invocation.
    expect(functionCallOutputCount(providerBodies, loaderCallId)).toBeGreaterThanOrEqual(1)
    expect(functionCallOutputCount(providerBodies, runtimeCommandCallId)).toBeGreaterThanOrEqual(1)
    expect(
      providerBodies
        .map((body) => functionCallOutputText(body, runtimeCommandCallId))
        .find((output): output is string => Boolean(output))
    ).toContain('synthetic-artifact-tool:0.0.0-synthetic.1')

    const loaderOutput = functionCallOutputText(providerBodies[1], loaderCallId)
    expect(loaderOutput).toBeTruthy()
    const dependencies = parseWorkspaceDependencies(loaderOutput!)
    expect(dependencies.node.startsWith('/')).toBe(true)
    expect(dependencies.nodeModules.startsWith('/')).toBe(true)
    expect(loaderOutput).not.toContain('Primary Runtime root:')
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

async function expectPrimaryRuntimeReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.desktopApp.plugins.getPrimaryRuntimeStatus({ version: 1 })
          return result.runtime.state
        }),
      { timeout: 120_000 }
    )
    .toBe('ready')
}

async function expectSyntheticPresentationSkill(page: Page): Promise<void> {
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

function syntheticRuntimeCommandResponse(request: MockRequest): ResponsesStep {
  const loaderOutput = functionCallOutputText(JSON.parse(request.body) as unknown, loaderCallId)
  if (!loaderOutput) {
    throw new Error(
      'The synthetic Runtime command was requested before loader output was returned.'
    )
  }
  const dependencies = parseWorkspaceDependencies(loaderOutput)
  const command = [
    `NODE_PATH=${shellQuote(dependencies.nodeModules)}`,
    shellQuote(dependencies.node),
    '--input-type=module',
    '-e',
    shellQuote(
      [
        `import * as module from '${syntheticPackageName}'`,
        `if (module.syntheticTestOnly !== true || module.identify().name !== '${syntheticPackageName}') process.exit(3)`,
        "process.stdout.write('synthetic-artifact-tool:0.0.0-synthetic.1')"
      ].join('; ')
    )
  ].join(' ')

  return shellCommandResponse('response-synthetic-runtime-command', runtimeCommandCallId, {
    command
  })
}

function parseWorkspaceDependencies(value: string): WorkspaceDependencies {
  const node = readInstructionPath(value, 'Runtime Node', true)
  const nodeModules = readInstructionPath(value, 'Runtime Node modules', false)
  if (!node || !nodeModules) {
    throw new Error(
      'load_workspace_dependencies did not return the synthetic Runtime Node instructions.'
    )
  }
  return { node, nodeModules }
}

function readInstructionPath(value: string, label: string, hasVersion: boolean): string | undefined {
  const line = value.split('\n').find((candidate) => candidate.startsWith(`${label}: `))
  if (!line) return undefined
  const path = line.slice(`${label}: `.length)
  return hasVersion ? path.replace(/ \([^\n]*\)$/u, '') : path
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
