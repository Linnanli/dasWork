import { access, chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@playwright/test'
import electronExecutable from 'electron'
import type { MockBackend } from './mockBackend'

export const appRoot = resolve(__dirname, '..', '..', '..')
export const repoRoot = resolve(appRoot, '..')

export type LaunchAppOptions = {
  configureCodexHome?: (codexHomeDir: string) => Promise<void>
  userDataDir?: string
  codexHomeDir?: string
  preserveDataDirectories?: boolean
  executablePath?: string
  args?: string[]
  cwd?: string
  launchTimeoutMs?: number
  /** Extra environment values for an E2E launch. Undefined values remove inherited variables. */
  environment?: NodeJS.ProcessEnv
}

const appTempDirs = new WeakMap<ElectronApplication, string[]>()
const e2eLaunchCooldownMs = 1_500
let nextE2eLaunchAt = 0

export type AppReadinessSnapshot = {
  bridgeReady: boolean
  modelCatalogReady: boolean
  composerMounted: boolean
  composerEditable: boolean
  sendButtonPresent: boolean
  stopButtonPresent: boolean
  probeError: string | null
}

export async function launchApp(
  backend: Pick<MockBackend, 'baseUrl'>,
  logs: string[],
  options: LaunchAppOptions = {}
): Promise<ElectronApplication> {
  const userDataDir =
    options.userDataDir ?? (await mkdtemp(join(tmpdir(), 'dascowork-e2e-user-data-')))
  const codexHomeDir =
    options.codexHomeDir ?? (await mkdtemp(join(tmpdir(), 'dascowork-e2e-codex-home-')))
  const dataDirectories = [userDataDir, codexHomeDir]
  const documentsDir = join(userDataDir, 'Documents')
  let app: ElectronApplication | undefined

  try {
    await waitForE2eLaunchCooldown()
    await mkdir(documentsDir, { recursive: true })
    await options.configureCodexHome?.(codexHomeDir)
    app = await electron.launch({
      executablePath: options.executablePath ?? electronExecutable,
      args: options.args ?? ['.'],
      cwd: options.cwd ?? appRoot,
      env: {
        ...process.env,
        ADMIN_BACKEND_URL: backend.baseUrl,
        ADMIN_BACKEND_MODEL_USER_ID: 'e2e-user',
        ADMIN_BACKEND_MODEL_CACHE_TTL_MS: '1000',
        CODEX_ASP_DEBUG_PACKETS: '1',
        CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1',
        CODEX_HOME: codexHomeDir,
        DASCOWORK_E2E_DOCUMENTS_DIR: documentsDir,
        DASCOWORK_E2E_USER_DATA_DIR: userDataDir,
        ELECTRON_ENABLE_LOGGING: '1',
        ...options.environment
      },
      timeout: options.launchTimeoutMs ?? 30_000
    })
    appTempDirs.set(app, options.preserveDataDirectories ? [] : dataDirectories)
    app.process().stdout?.on('data', (chunk) => logs.push(`[main:stdout] ${String(chunk)}`))
    app.process().stderr?.on('data', (chunk) => logs.push(`[main:stderr] ${String(chunk)}`))
    await expectAppReady(await app.firstWindow())
  } catch (error) {
    if (app) await terminateElectronApp(app)
    else markE2eLaunchClosed()
    if (app) appTempDirs.delete(app)
    if (!options.preserveDataDirectories) await cleanupTempDirs(dataDirectories)
    throw error
  }

  return app
}

/**
 * Waits for the renderer, public preload API, model catalog, and composer to
 * agree that the application is ready for an E2E interaction.
 */
export async function expectAppReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded')
  await expect
    .poll(() => page.evaluate(collectAppReadinessSnapshot), { timeout: 20_000 })
    .toEqual({
      bridgeReady: true,
      modelCatalogReady: true,
      composerMounted: true,
      composerEditable: true,
      sendButtonPresent: true,
      stopButtonPresent: false,
      probeError: null
    })
}

/**
 * Browser-side readiness probe. Keep this closure-free so Playwright can
 * serialize it for both the ready gate and captured diagnostics.
 */
export async function collectAppReadinessSnapshot(
  probeTimeoutMs = 3_000
): Promise<AppReadinessSnapshot> {
  const composerState = {
    composerMounted: Boolean(
      document.querySelector('.aui-composer-root') && document.querySelector('.aui-lexical-input')
    ),
    composerEditable: Boolean(document.querySelector('.aui-lexical-input[contenteditable="true"]')),
    sendButtonPresent: Boolean(
      document.querySelector(
        '[role="button"][aria-label="发送消息"], button[aria-label="发送消息"]'
      )
    ),
    stopButtonPresent: Boolean(
      document.querySelector(
        '[role="button"][aria-label="停止生成"], button[aria-label="停止生成"]'
      )
    )
  }
  const codex = window.desktopApp?.codex
  if (!codex) {
    return {
      bridgeReady: false,
      modelCatalogReady: false,
      ...composerState,
      probeError: 'Desktop Codex API is unavailable'
    }
  }

  const withDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('E2E readiness probe timed out')),
            probeTimeoutMs
          )
        })
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  try {
    const catalog = await withDeadline(codex.listModels())
    const selectedModelExists = catalog.selectedModelId
      ? catalog.models.some((model) => model.id === catalog.selectedModelId)
      : catalog.models.length === 1
    return {
      bridgeReady: true,
      modelCatalogReady: catalog.models.length > 0 && selectedModelExists,
      ...composerState,
      probeError: null
    }
  } catch (error) {
    return {
      bridgeReady: false,
      modelCatalogReady: false,
      ...composerState,
      probeError: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  const tempDirs = appTempDirs.get(app) ?? []
  await terminateElectronApp(app)
  appTempDirs.delete(app)
  await cleanupTempDirs(tempDirs)
}

/** Force-terminates Electron so restart tests cross a real crash boundary. */
export async function crashApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  const tempDirs = appTempDirs.get(app) ?? []
  const process = app.process()
  appTempDirs.delete(app)

  if (process.exitCode === null && process.signalCode === null)
    await killElectronProcessTree(process, 'Electron did not close after SIGKILL')

  markE2eLaunchClosed()
  await cleanupTempDirs(tempDirs)
}

export async function cleanupTempDirs(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      // Primary Runtime versions are deliberately published read-only. E2E owns
      // these temporary user-data roots, so restore write access before asking
      // Node to remove the tree. Do not follow symlinks while doing so.
      await makeTempTreeWritable(path)
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100
      })
      await expectPathRemoved(path)
    })
  )
}

async function makeTempTreeWritable(path: string): Promise<void> {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if (isMissingPathError(error)) return
    throw error
  }

  if (details.isSymbolicLink() || !details.isDirectory()) {
    if (details.isFile()) await chmod(path, 0o600)
    return
  }

  for (const entry of await readdir(path)) {
    await makeTempTreeWritable(join(path, entry))
  }
  await chmod(path, 0o700)
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function terminateElectronApp(app: ElectronApplication): Promise<void> {
  const process = app.process()
  try {
    if (process.exitCode !== null || process.signalCode !== null) return

    const processClosed = observeChildProcessClose(process)
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 5_000))
    ])
    if (!processClosed.hasClosed())
      await killElectronProcessTree(
        process,
        'Electron did not close after graceful shutdown or SIGKILL',
        processClosed
      )
  } finally {
    markE2eLaunchClosed()
  }
}

type ChildProcessCloseObserver = {
  hasClosed(): boolean
  closed: Promise<void>
}

function observeChildProcessClose(
  process: ReturnType<ElectronApplication['process']>
): ChildProcessCloseObserver {
  let hasClosed = false
  const closed = new Promise<void>((resolveClose) => {
    process.once('close', () => {
      hasClosed = true
      resolveClose()
    })
  })
  return { hasClosed: () => hasClosed, closed }
}

async function killElectronProcessTree(
  process: ReturnType<ElectronApplication['process']>,
  timeoutMessage: string,
  processClosed = observeChildProcessClose(process)
): Promise<void> {
  if (process.pid && !processClosed.hasClosed()) {
    try {
      // Playwright launches Electron as a process-group leader on Unix. Killing
      // the group also closes any Codex CLI descendants that otherwise retain
      // the Electron stdout/stderr pipes after a crash.
      globalThis.process.kill(
        globalThis.process.platform === 'win32' ? process.pid : -process.pid,
        'SIGKILL'
      )
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    }
  }

  await waitForChildProcessClose(processClosed.closed, timeoutMessage)
}

async function waitForChildProcessClose(
  closed: Promise<void>,
  timeoutMessage: string
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), 10_000)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function waitForE2eLaunchCooldown(): Promise<void> {
  const waitMs = nextE2eLaunchAt - Date.now()
  if (waitMs <= 0) return
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, waitMs))
}

function markE2eLaunchClosed(): void {
  nextE2eLaunchAt = Date.now() + e2eLaunchCooldownMs
}

export function collectRendererLogs(page: Page, logs: string[]): void {
  page.on('console', (message) => {
    logs.push(`[renderer:${message.type()}] ${message.text()}`)
  })
  page.on('pageerror', (error) => {
    logs.push(`[renderer:pageerror] ${error.stack ?? error.message}`)
  })
}

export async function attachDiagnostics(
  testInfo: TestInfo,
  logs: string[],
  backend: MockBackend,
  app: ElectronApplication | undefined
): Promise<void> {
  let status: unknown = undefined
  let renderedMessages: unknown = undefined
  let visibleState: unknown = undefined
  if (app) {
    const windows = app.windows()
    const page = windows[0]
    if (page) {
      status = await withDiagnosticTimeout(
        page.evaluate(async () => window.desktopApp?.codex?.getStatus?.()),
        'status'
      ).catch((error: unknown) => `status unavailable: ${errorMessage(error)}`)
      renderedMessages = await withDiagnosticTimeout(
        page.locator('[data-role="user"], [data-role="assistant"]').evaluateAll((nodes) =>
          nodes.map((node) => ({
            role: node.getAttribute('data-role'),
            text: node.textContent
          }))
        ),
        'rendered messages'
      ).catch((error: unknown) => `rendered messages unavailable: ${errorMessage(error)}`)
      visibleState = await withDiagnosticTimeout(captureVisibleState(page), 'visible state').catch(
        (error: unknown) => `visible state unavailable: ${errorMessage(error)}`
      )
    }
  }

  const diagnosticsPath = testInfo.outputPath('desktop-chat-diagnostics.json')
  await writeFile(
    diagnosticsPath,
    serializeDiagnosticData({
      status,
      visibleState,
      renderedMessages,
      backendRequests: backend.requests,
      logs
    })
  )
  await testInfo.attach('desktop-chat-diagnostics.json', {
    contentType: 'application/json',
    path: diagnosticsPath
  })
}

export async function attachReleaseDiagnostics(
  testInfo: TestInfo,
  logs: string[],
  app: ElectronApplication | undefined
): Promise<void> {
  let status: unknown = undefined
  let modelCatalog: unknown = undefined
  let visibleState: unknown = undefined
  if (app) {
    const page = app.windows()[0]
    if (page) {
      status = await withDiagnosticTimeout(
        page.evaluate(async () => window.desktopApp?.codex?.getStatus?.()),
        'release status'
      ).catch((error: unknown) => `status unavailable: ${errorMessage(error)}`)
      modelCatalog = await withDiagnosticTimeout(
        page.evaluate(async () => window.desktopApp?.codex?.listModels()),
        'release model catalog'
      ).catch((error: unknown) => `model catalog unavailable: ${errorMessage(error)}`)
      visibleState = await withDiagnosticTimeout(
        captureVisibleState(page),
        'release visible state'
      ).catch((error: unknown) => `visible state unavailable: ${errorMessage(error)}`)
    }
  }

  const diagnosticsPath = testInfo.outputPath('release-llm-diagnostics.json')
  await writeFile(
    diagnosticsPath,
    serializeDiagnosticData({ status, modelCatalog, visibleState, logs })
  )
  await testInfo.attach('release-llm-diagnostics.json', {
    contentType: 'application/json',
    path: diagnosticsPath
  })
}

/**
 * The snapshot uses only public renderer/preload contracts so it is safe to
 * attach for every test without a production-only diagnostics bridge.
 */
async function captureVisibleState(page: Page): Promise<unknown> {
  const readiness = await page.evaluate(collectAppReadinessSnapshot).catch(
    (error: unknown): AppReadinessSnapshot => ({
      bridgeReady: false,
      modelCatalogReady: false,
      composerMounted: false,
      composerEditable: false,
      sendButtonPresent: false,
      stopButtonPresent: false,
      probeError: `E2E readiness snapshot unavailable: ${errorMessage(error)}`
    })
  )
  return page.evaluate(
    async ({ readinessSnapshot }) => {
      const queueRoots = [...document.querySelectorAll('[data-slot="queued-follow-up-list"]')]
      const queueStates = await Promise.all(
        queueRoots.map(async (root) => {
          const conversationKey = root.getAttribute('data-conversation-key')
          if (!conversationKey) return { conversationKey: null, state: 'unavailable' }
          try {
            return {
              conversationKey,
              state: await window.desktopApp.followUps.getState(conversationKey)
            }
          } catch (error) {
            return {
              conversationKey,
              state: `unavailable: ${error instanceof Error ? error.message : String(error)}`
            }
          }
        })
      )
      const queueDelivery = queueStates.reduce(
        (counts, queue) => {
          if (!queue.state || typeof queue.state !== 'object') return counts
          const items =
            'items' in queue.state && Array.isArray(queue.state.items) ? queue.state.items : []
          counts.leasedItemCount += items.filter((item) => item.lease).length
          counts.inFlightItemCount += items.filter(
            (item) => item.status === 'sending' || item.status === 'steering'
          ).length
          return counts
        },
        { leasedItemCount: 0, inFlightItemCount: 0 }
      )
      return {
        ...readinessSnapshot,
        queueStates,
        queueDelivery,
        errorCardCount: document.querySelectorAll('[data-slot="aui_assistant-message-error"]')
          .length,
        cancelledCardCount: document.querySelectorAll(
          '[data-slot="aui_assistant-message-cancelled"]'
        ).length,
        pendingApprovalCount: document.querySelectorAll(
          '[data-slot="server-request-panel"] article'
        ).length,
        pendingApprovalRequestIds: [
          ...document.querySelectorAll('[data-slot="server-request-panel"] article')
        ]
          .map((card) => card.getAttribute('data-request-id'))
          .filter((requestId): requestId is string => Boolean(requestId))
      }
    },
    { readinessSnapshot: readiness }
  )
}

export function redactDiagnosticData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiagnosticData)
  if (typeof value === 'string') return redactSensitiveText(value)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveDiagnosticKey(key) ? '[redacted]' : redactDiagnosticData(entry)
    ])
  )
}

export function serializeDiagnosticData(value: unknown): string {
  const serialized = JSON.stringify(redactDiagnosticData(value), null, 2)
  assertDiagnosticTextIsSafe(serialized)
  return serialized
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/gu, '').toLowerCase()
  return (
    normalized.includes('authorization') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('cookie') ||
    normalized.includes('providerheaders') ||
    (normalized.includes('api') && normalized.includes('key'))
  )
}

function redactSensitiveText(value: string): string {
  const parsed = parseStructuredDiagnosticText(value)
  if (parsed !== undefined) return JSON.stringify(redactDiagnosticData(parsed))

  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(
      /(["']?(?:api[_-]?key|authorization|proxy[_-]?authorization|[a-z0-9_-]*token|[a-z0-9_-]*secret|credential|password|cookie|provider[_-]?headers?)["']?\s*[:=]\s*["']?)[^"',&\s;}]+/gi,
      '$1[redacted]'
    )
}

function parseStructuredDiagnosticText(value: string): object | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function assertDiagnosticTextIsSafe(value: string): void {
  const unsafeCredential = [
    /\bBearer\s+(?!\[redacted\])\S+/iu,
    /\bsk-[A-Za-z0-9_-]{8,}\b/u,
    /(?:api[_-]?key|authorization|proxy[_-]?authorization|[a-z0-9_-]*token|[a-z0-9_-]*secret|credential|password|cookie|provider[_-]?headers?)[\\"']*\s*[:=]\s*[\\"']?(?!\[redacted\])[^\\"',&\s;}]+/iu
  ].find((pattern) => pattern.test(value))
  if (unsafeCredential) {
    throw new Error('Refusing to attach diagnostics because credential redaction was incomplete')
  }
}

function withDiagnosticTimeout<T>(task: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 2_000)
    task.then(resolve, reject).finally(() => clearTimeout(timeout))
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function expectPathRemoved(path: string): Promise<void> {
  try {
    await access(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`E2E temporary directory was not removed: ${path}`)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
