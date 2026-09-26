import { readFile, stat } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { dirname, join, resolve } from 'node:path'

import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'

import {
  loadPublishedRuntimeFeedSnapshot,
  parseFeedPublicKeyring,
  publishDevelopmentMetadataSnapshot,
  publishDevelopmentRepositorySnapshot
} from '../../../services/primary-runtime-feed/src/repository.mjs'
import { attachDiagnostics, closeApp, collectRendererLogs, launchApp } from './support/app'
import { sendComposerMessage, sendMessage } from './support/chatActions'
import {
  assistantMessageResponse,
  dynamicFunctionCallResponse,
  functionCallOutputCount,
  functionCallOutputText,
  type MockBackend,
  providerResponseBodies,
  shellCommandResponse,
  startMockBackend,
  type MockRequest,
  type ResponsesStep
} from './support/mockBackend'

const loaderCallId = 'call-synthetic-runtime-loader'
const upgradedLoaderCallId = 'call-synthetic-runtime-loader-upgraded'
const refreshedLoaderCallId = 'call-synthetic-runtime-loader-refreshed'
const returnedLoaderCallId = 'call-synthetic-runtime-loader-returned'
const runtimeCommandCallId = 'call-synthetic-runtime-package'
const syntheticPackageName = '@dascowork/test-artifact-tool'

type WorkspaceDependencies = {
  node: string
  nodeModules: string
}

type SyntheticFeedControl = {
  repositoryRoot: string
  staged: {
    v1: string
    v2: string
  }
  metadataSnapshots: {
    v2Refresh: SignedSyntheticFeedMetadata
    v1Return: SignedSyntheticFeedMetadata
  }
  bundleVersions: {
    v1: string
    v2: string
  }
  archiveUrls: {
    v1: string
  }
  tls: {
    caPath: string
  }
  configPublicKeys: string
  manifestPublicKeys: string
}

type SignedSyntheticFeedMetadata = {
  config: unknown
  manifest: unknown
}

type RuntimeInstallMarker = {
  root: string
  rootIno: number
  rootMtimeMs: number
  manifestIno: number
  manifestMtimeMs: number
  manifestSize: number
}

test('AT-E2E-SYNTHETIC-01 installs and hot-upgrades a test-only signed Feed Runtime', async ({
  browserName
}, testInfo) => {
  // Initial app-plugin reconciliation runs against the real app-server and
  // can consume most of the generic E2E budget before Feed installation.
  testInfo.setTimeout(180_000)
  expect(browserName).toBe('chromium')
  const control = await readSyntheticFeedControl()

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
      ),
      dynamicFunctionCallResponse(
        'response-synthetic-runtime-loader-upgraded',
        upgradedLoaderCallId,
        'load_workspace_dependencies',
        {},
        { namespace: 'codex_app' }
      ),
      assistantMessageResponse(
        'response-synthetic-runtime-upgraded-final',
        'message-synthetic-runtime-upgraded-final',
        'The synthetic signed Runtime upgraded through the local Feed.'
      ),
      dynamicFunctionCallResponse(
        'response-synthetic-runtime-loader-refreshed',
        refreshedLoaderCallId,
        'load_workspace_dependencies',
        {},
        { namespace: 'codex_app' }
      ),
      assistantMessageResponse(
        'response-synthetic-runtime-refreshed-final',
        'message-synthetic-runtime-refreshed-final',
        'The same-version synthetic Feed refresh did not reinstall the Runtime.'
      ),
      dynamicFunctionCallResponse(
        'response-synthetic-runtime-loader-returned',
        returnedLoaderCallId,
        'load_workspace_dependencies',
        {},
        { namespace: 'codex_app' }
      ),
      assistantMessageResponse(
        'response-synthetic-runtime-returned-final',
        'message-synthetic-runtime-returned-final',
        'The synthetic signed Runtime returned to v1 with a higher Feed sequence.'
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
    await expectPrimaryRuntimeReady(page, control.bundleVersions.v1)
    await expectSyntheticPresentationSkill(page)
    await sendMessage(page, 'Load the signed synthetic test Runtime and confirm its owned package.')

    await expect(page.locator('[data-role="assistant"]').last()).toContainText(
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
    const initialDependencies = dependencies

    await publishSyntheticSnapshot(control, control.staged.v2)
    await expectArchiveReachable(control.archiveUrls.v1, control.tls.caPath)
    await page.evaluate(async () => {
      await window.desktopApp.plugins.runPrimaryRuntimeUpdate({ version: 1 })
    })
    await expectPrimaryRuntimeReady(page, control.bundleVersions.v2)
    await sendComposerMessage(page, 'Load the upgraded signed synthetic Runtime dependencies.')
    const upgradedOutput = await waitForCallOutput(backend, upgradedLoaderCallId)
    const upgradedDependencies = parseWorkspaceDependencies(upgradedOutput)
    expect(upgradedDependencies.node).not.toBe(initialDependencies.node)
    expect(upgradedDependencies.nodeModules).not.toBe(initialDependencies.nodeModules)
    const upgradedMarker = await runtimeInstallMarker(upgradedDependencies)

    await publishSyntheticMetadataSnapshot(control, control.metadataSnapshots.v2Refresh)
    await page.evaluate(async () => {
      await window.desktopApp.plugins.runPrimaryRuntimeUpdate({ version: 1 })
    })
    await expectPrimaryRuntimeReady(page, control.bundleVersions.v2)
    await sendComposerMessage(page, 'Load the refreshed signed synthetic Runtime dependencies.')
    const refreshedOutput = await waitForCallOutput(backend, refreshedLoaderCallId)
    expect(parseWorkspaceDependencies(refreshedOutput)).toEqual(upgradedDependencies)
    await expect(runtimeInstallMarker(upgradedDependencies)).resolves.toEqual(upgradedMarker)

    await publishSyntheticMetadataSnapshot(control, control.metadataSnapshots.v1Return)
    await page.evaluate(async () => {
      await window.desktopApp.plugins.runPrimaryRuntimeUpdate({ version: 1 })
    })
    await expectPrimaryRuntimeReady(page, control.bundleVersions.v1)
    await sendComposerMessage(page, 'Load the returned signed synthetic Runtime dependencies.')
    const returnedOutput = await waitForCallOutput(backend, returnedLoaderCallId)
    expect(parseWorkspaceDependencies(returnedOutput)).toEqual(initialDependencies)
  } finally {
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
  }
})

async function expectPrimaryRuntimeReady(page: Page, currentVersion?: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const result = await window.desktopApp.plugins.getPrimaryRuntimeStatus({ version: 1 })
          return {
            state: result.runtime.state,
            currentVersion:
              'currentVersion' in result.runtime ? result.runtime.currentVersion : null
          }
        }),
      { timeout: 120_000 }
    )
    .toMatchObject({
      state: 'ready',
      ...(currentVersion ? { currentVersion } : {})
    })
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
  const syntheticPackageEntrypoint = `${dependencies.nodeModules}/${syntheticPackageName}/index.js`
  const command = [
    'unset npm_config_prefix;',
    `NODE_PATH=${shellQuote(dependencies.nodeModules)}`,
    shellQuote(dependencies.node),
    '--input-type=module',
    '-e',
    shellQuote(
      [
        "import { pathToFileURL } from 'node:url'",
        `const module = await import(pathToFileURL(${jsString(syntheticPackageEntrypoint)}).href)`,
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

function outputForCall(providerBodies: unknown[], callId: string): string {
  const output = providerBodies
    .map((body) => functionCallOutputText(body, callId))
    .find((candidate): candidate is string => Boolean(candidate))
  if (!output) throw new Error(`Missing function call output for ${callId}.`)
  return output
}

async function waitForCallOutput(backend: MockBackend, callId: string): Promise<string> {
  await expect
    .poll(
      () =>
        providerResponseBodies(backend).some((body) =>
          Boolean(functionCallOutputText(body, callId))
        ),
      { timeout: 60_000 }
    )
    .toBe(true)
  return outputForCall(providerResponseBodies(backend), callId)
}

async function readSyntheticFeedControl(): Promise<SyntheticFeedControl> {
  const path = process.env.DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_CONTROL_PATH
  if (!path) throw new Error('DASCOWORK_PRIMARY_RUNTIME_SYNTHETIC_FEED_CONTROL_PATH is required.')
  return JSON.parse(await readFile(path, 'utf8')) as SyntheticFeedControl
}

async function publishSyntheticSnapshot(
  control: SyntheticFeedControl,
  stagedRoot: string
): Promise<void> {
  await publishDevelopmentRepositorySnapshot({
    repositoryRoot: control.repositoryRoot,
    stagedRoot,
    configPublicKeys: parseFeedPublicKeyring(control.configPublicKeys, 'config'),
    manifestPublicKeys: parseFeedPublicKeyring(control.manifestPublicKeys, 'manifest'),
    allowSyntheticTestOnly: true
  })
}

async function publishSyntheticMetadataSnapshot(
  control: SyntheticFeedControl,
  metadata: SignedSyntheticFeedMetadata
): Promise<void> {
  const keyring = feedKeyring(control)
  const snapshot = await loadPublishedRuntimeFeedSnapshot({
    repositoryRoot: control.repositoryRoot,
    ...keyring
  })
  await publishDevelopmentMetadataSnapshot({
    repositoryRoot: control.repositoryRoot,
    config: metadata.config,
    manifest: metadata.manifest,
    archiveIndex: snapshot.archiveIndex,
    ...keyring
  })
}

function feedKeyring(control: SyntheticFeedControl): {
  configPublicKeys: Record<string, string>
  manifestPublicKeys: Record<string, string>
} {
  return {
    configPublicKeys: parseFeedPublicKeyring(control.configPublicKeys, 'config'),
    manifestPublicKeys: parseFeedPublicKeyring(control.manifestPublicKeys, 'manifest')
  }
}

async function runtimeInstallMarker(
  dependencies: WorkspaceDependencies
): Promise<RuntimeInstallMarker> {
  const root = resolve(dirname(dependencies.node), '..', '..', '..')
  const [rootStatus, manifestStatus] = await Promise.all([
    stat(root),
    stat(join(root, 'runtime.json'))
  ])
  return {
    root,
    rootIno: rootStatus.ino,
    rootMtimeMs: rootStatus.mtimeMs,
    manifestIno: manifestStatus.ino,
    manifestMtimeMs: manifestStatus.mtimeMs,
    manifestSize: manifestStatus.size
  }
}

async function expectArchiveReachable(url: string, caPath: string): Promise<void> {
  const ca = await readFile(caPath, 'utf8')
  const statusCode = await new Promise<number>((resolveStatus, reject) => {
    const request = httpsRequest(url, { ca, rejectUnauthorized: true }, (response) => {
      response.resume()
      response.once('error', reject)
      response.once('end', () => resolveStatus(response.statusCode ?? 0))
    })
    request.setTimeout(5_000, () =>
      request.destroy(new Error('Synthetic archive probe timed out.'))
    )
    request.once('error', reject)
    request.end()
  })
  expect(statusCode).toBe(200)
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

function jsString(value: string): string {
  return JSON.stringify(value)
}
