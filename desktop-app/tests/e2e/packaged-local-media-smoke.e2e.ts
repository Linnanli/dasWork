import { execFile as execFileCallback } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

import { toAppMediaUrl } from '../../src/main/localMediaProtocol'
import { closeApp, launchApp } from './support/app'
import { createLocalProject, sendComposerMessage } from './support/chatActions'
import { assistantMessageResponse } from './support/mockBackend'
import { startMockBackend, type MockBackend } from './support/mockBackend'

const packagedExecutable = process.env.DASCOWORK_PACKAGED_APP_EXECUTABLE
const execFile = promisify(execFileCallback)

test.describe('packaged local media smoke', () => {
  test.skip(!packagedExecutable, 'run through npm run test:e2e:packaged')

  let app: ElectronApplication | undefined
  let backend: MockBackend
  let tempDir: string

  test.afterEach(async () => {
    await closeApp(app)
    await backend?.close()
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  test('loads asar assets, local media, and a real packaged terminal session', async () => {
    backend = await startMockBackend({
      responses: [
        assistantMessageResponse('packaged-terminal-thread', 'packaged-terminal-message', 'Ready')
      ]
    })
    tempDir = await mkdtemp(join(tmpdir(), 'dascowork-packaged-media-'))
    const projectRoot = join(tempDir, 'project')
    await mkdir(projectRoot, { recursive: true })
    await writeFile(join(projectRoot, 'README.md'), '# Packaged terminal smoke\n', 'utf8')
    const imagePath = join(tempDir, 'packaged-smoke.png')
    await writeFile(
      imagePath,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      )
    )

    app = await launchApp(backend, [], {
      executablePath: packagedExecutable,
      args: [],
      cwd: process.cwd()
    })
    const page = await app.firstWindow()

    const runtimeInfo = await app.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    }))
    expect(runtimeInfo.isPackaged).toBe(true)
    await expectNoBundledAppServerResources(runtimeInfo.resourcesPath)
    await expect.poll(() => page.url()).toBe('app://-/index.html')
    await expect(
      page.evaluate(() => ({
        scripts: [...document.scripts].map((script) => script.src),
        styles: [...document.querySelectorAll('link[rel="stylesheet"]')].map(
          (link) => (link as HTMLLinkElement).href
        )
      }))
    ).resolves.toMatchObject({
      scripts: [expect.stringMatching(/^app:\/\/-\/assets\/.+\.js$/)],
      styles: [expect.stringMatching(/^app:\/\/-\/assets\/.+\.css$/)]
    })

    await expect(
      page.evaluate(
        (url) =>
          new Promise((resolve) => {
            const image = new Image()
            image.onload = () => resolve({ loaded: true, width: image.naturalWidth })
            image.onerror = () => resolve({ loaded: false, width: 0 })
            image.src = url
          }),
        toAppMediaUrl(imagePath)!
      )
    ).resolves.toEqual({ loaded: true, width: 1 })

    await createLocalProject(page, `Packaged smoke ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open packaged terminal smoke.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Ready')
    await expectCodexCliRuntime(page)
    await openRightWorkspace(page)
    await openWorkspaceMenuItem(page, 'Terminal')
    const terminalStarted = await startVisibleTerminalIfAvailable(page)
    expect(terminalStarted, 'packaged app must load the unpacked node-pty ABI').toBe(true)
    const terminalSessionId = await activeTerminalSessionId(page)

    await typeVisibleTerminalCommand(page, 'echo PACKAGED_NODE_PTY_ABI_OK')
    await expectTerminalSnapshot(page, terminalSessionId, ['PACKAGED_NODE_PTY_ABI_OK'])
  })

  test('renders a local PDF review preview with the packaged PDF.js worker', async () => {
    backend = await startMockBackend({
      responses: [assistantMessageResponse('packaged-pdf-thread', 'packaged-pdf-message', 'Ready')]
    })
    tempDir = await mkdtemp(join(tmpdir(), 'dascowork-packaged-pdf-review-'))
    const projectRoot = join(tempDir, 'project')
    await mkdir(projectRoot, { recursive: true })
    await execFile('git', ['init'], { cwd: projectRoot })
    await execFile('git', ['config', 'user.email', 'packaged@example.test'], { cwd: projectRoot })
    await execFile('git', ['config', 'user.name', 'Packaged Smoke'], { cwd: projectRoot })
    await writeFile(join(projectRoot, 'tracked.txt'), 'initial\n', 'utf8')
    await execFile('git', ['add', 'tracked.txt'], { cwd: projectRoot })
    await execFile('git', ['commit', '-m', 'initial'], { cwd: projectRoot })
    await writeFile(join(projectRoot, 'preview.pdf'), onePagePdf())

    app = await launchApp(backend, [], {
      executablePath: packagedExecutable,
      args: [],
      cwd: process.cwd()
    })
    const page = await app.firstWindow()
    await createLocalProject(page, `Packaged PDF ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open the packaged PDF review preview.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Ready')

    await openReviewWorkspace(page)
    const review = page.locator('[data-slot="review-workspace"]')
    await expect(review).toContainText('preview.pdf')
    await review.getByRole('button', { name: '审阅选项', exact: true }).click()
    await page
      .getByRole('menuitem', { name: '富预览（Markdown、图片和 PDF）', exact: true })
      .click()
    await expect(review.locator('.react-pdf__Page__canvas')).toBeVisible()
  })

  test('loads the packaged Review diff worker from app resources', async () => {
    backend = await startMockBackend({
      responses: [
        assistantMessageResponse('packaged-diff-thread', 'packaged-diff-message', 'Ready')
      ]
    })
    tempDir = await mkdtemp(join(tmpdir(), 'dascowork-packaged-diff-review-'))
    const projectRoot = join(tempDir, 'project')
    await mkdir(projectRoot, { recursive: true })
    await execFile('git', ['init'], { cwd: projectRoot })
    await execFile('git', ['config', 'user.email', 'packaged@example.test'], { cwd: projectRoot })
    await execFile('git', ['config', 'user.name', 'Packaged Smoke'], { cwd: projectRoot })
    await writeFile(join(projectRoot, 'example.ts'), 'export const value = 1\n', 'utf8')
    await execFile('git', ['add', 'example.ts'], { cwd: projectRoot })
    await execFile('git', ['commit', '-m', 'initial'], { cwd: projectRoot })
    await writeFile(join(projectRoot, 'example.ts'), 'export const value = 2\n', 'utf8')

    app = await launchApp(backend, [], {
      executablePath: packagedExecutable,
      args: [],
      cwd: process.cwd()
    })
    const page = await app.firstWindow()
    await trackReviewDiffWorkerUrls(page)
    await createLocalProject(page, `Packaged diff ${Date.now().toString(36)}`, projectRoot)
    await sendComposerMessage(page, 'Open the packaged diff worker review.')
    await expect(page.locator('[data-role="assistant"]')).toContainText('Ready')

    await openReviewWorkspace(page)
    const review = page.locator('[data-slot="review-workspace"]')
    await review.getByRole('button', { name: '隐藏文件树' }).click()
    await expect(review.locator('[data-review-file-diff]')).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            (window as typeof window & { reviewDiffWorkerUrls?: string[] }).reviewDiffWorkerUrls ??
            []
          ).some((url) => /^app:\/\/-\/assets\/worker-[A-Za-z0-9_-]+\.js$/u.test(url))
        )
      )
      .toBe(true)
  })
})

async function openReviewWorkspace(page: Page): Promise<void> {
  const openWorkspace = page.getByRole('button', { name: '打开工作区', exact: true })
  if (await openWorkspace.isVisible().catch(() => false)) await openWorkspace.click()

  const newTab = page.getByRole('button', { name: 'Open workspace tab', exact: true })
  if (await newTab.isVisible().catch(() => false)) {
    await newTab.click()
    await page.getByRole('menuitem', { name: /^Review/ }).click()
    return
  }

  await page.getByRole('button', { name: /^审阅/ }).click()
}

function onePagePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'binary'))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets
    .slice(1)
    .map((offset) => `${offset.toString().padStart(10, '0')} 00000 n \n`)
    .join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'binary')
}

async function trackReviewDiffWorkerUrls(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as typeof window & { reviewDiffWorkerUrls?: string[] }
    const NativeWorker = window.Worker
    browserWindow.reviewDiffWorkerUrls = []
    Object.defineProperty(window, 'Worker', {
      configurable: true,
      value: class TrackingWorker extends NativeWorker {
        constructor(specifier: string | URL, options?: WorkerOptions) {
          browserWindow.reviewDiffWorkerUrls?.push(String(specifier))
          super(specifier, options)
        }
      }
    })
  })
}

async function openRightWorkspace(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: '打开工作区', exact: true })
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(page.getByRole('button', { name: '关闭工作区', exact: true })).toBeVisible()
}

async function openWorkspaceMenuItem(page: Page, label: string): Promise<void> {
  const menuTrigger = page.getByRole('button', { name: 'Open workspace tab', exact: true })
  if (await menuTrigger.isVisible().catch(() => false)) {
    await menuTrigger.click()
    await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click()
    return
  }
  await page.getByRole('button', { name: label === 'Terminal' ? /^终端/u : label }).click()
}

async function startVisibleTerminalIfAvailable(page: Page): Promise<boolean> {
  const xterm = page.locator('.xterm')
  const unavailable = page.getByText(/终端原生模块不可用|无法启动终端|node-pty/u)
  return Promise.race([
    xterm.waitFor({ state: 'visible', timeout: 7_500 }).then(() => true),
    unavailable.waitFor({ state: 'visible', timeout: 7_500 }).then(() => false)
  ])
}

async function activeTerminalSessionId(page: Page): Promise<string> {
  const tabId = await page
    .locator('[role="tab"][aria-selected="true"][data-workspace-tab-id^="terminal:"]')
    .getAttribute('data-workspace-tab-id')
  if (!tabId?.startsWith('terminal:')) throw new Error('Missing active terminal tab id')
  return tabId.slice('terminal:'.length)
}

async function typeVisibleTerminalCommand(page: Page, command: string): Promise<void> {
  const terminalInput = page.locator('.xterm-helper-textarea').last()
  await terminalInput.focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

async function expectTerminalSnapshot(
  page: Page,
  sessionId: string,
  expectedFragments: string[]
): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async (id) => {
          const snapshot = await window.desktopApp.workspace.terminal.snapshot({
            version: 2,
            sessionId: id
          })
          return snapshot.output
        }, sessionId),
      { timeout: 10_000 }
    )
    .toEqual(expect.stringContaining(expectedFragments.at(-1) ?? ''))
}

async function expectCodexCliRuntime(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.desktopApp.codex.getStatus()))
    .toMatchObject({ state: 'ready' })
  const status = await page.evaluate(() => window.desktopApp.codex.getStatus())
  expect(status.binary).toBe('codex app-server --listen stdio://')
}

async function expectNoBundledAppServerResources(resourcesPath: string): Promise<void> {
  await expect(
    access(join(resourcesPath, 'codex-app-server')),
    'packaged app must not include a bundled codex-app-server resource'
  ).rejects.toThrow()
  const appAsarPath = join(resourcesPath, 'app.asar')
  const { stdout } = await execFile('npx', ['asar', 'list', appAsarPath])
  const archiveEntries = stdout.split(/\r?\n/u)
  const bundledAppServerExecutables = archiveEntries.filter((entry) =>
    /(?:^|\/)(?:codex|codex-app-server)(?:\.exe)?(?:\/|$)/u.test(entry)
  )
  expect(bundledAppServerExecutables).toEqual([])
  expect(
    archiveEntries.filter((entry) => /(?:^|\/)ai-sdk-provider-codex-asp(?:\/|$)/u.test(entry)),
    'the AI SDK compatibility provider must not ship in the desktop production package'
  ).toEqual([])
}
