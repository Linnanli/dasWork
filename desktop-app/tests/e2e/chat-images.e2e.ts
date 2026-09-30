import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

import {
  test,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo
} from '@playwright/test'
import { CodexHistoryClient } from '@dascowork/codex-app-server-client'
import {
  attachDiagnostics,
  closeApp,
  collectRendererLogs,
  expectAppReady,
  launchApp
} from './support/app'
import { createLocalProject, sendComposerMessage } from './support/chatActions'
import {
  assistantMessageResponse,
  deferred,
  providerResponseBodies,
  responseCompleted,
  responseCreated,
  startMockBackend,
  type ResponsesStreamStep
} from './support/mockBackend'

const previewSelector = '[data-slot="image-preview-dialog"]'
const previewImageSelector = '[data-slot="image-preview-image"]'
const readyImageSelector = '[data-chat-image-ready="true"]'
const realAppServerOptions = { environment: { CODEX_APP_SERVER_BIN: undefined } }

// These fixtures are valid PNGs decoded by Chromium and the real view_image
// tool. A large image makes fit, zoom, and scrolling observable; no onLoad stub
// or app-server replacement is involved in this suite.
const largePng = makePng(1600, 1200)
const smallPng = makePng(80, 60)

test('decodes Markdown local URLs, keeps galleries per message, and restores the original thread root', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'dsc-chat-images-'))
  const otherRoot = await mkdtemp(join(tmpdir(), 'dsc-chat-images-other-'))
  const paths = {
    absolute: join(root, 'absolute.png'),
    file: join(root, 'file image.png'),
    sandbox: join(root, 'sandbox.png'),
    relative: join(root, 'relative.png'),
    special: join(root, process.platform === 'win32' ? '空 格 #.png' : '空 格 #?.png'),
    literalPercent: join(root, 'literal%20.png'),
    broken: join(root, 'broken.png')
  }
  const jpegPath = join(root, 'decoded-jpeg.jpg')
  await Promise.all(
    Object.values(paths).map((path) =>
      writeFile(path, path === paths.broken ? Buffer.from('not an image') : largePng)
    )
  )
  await writeFile(join(otherRoot, 'relative.png'), smallPng)
  const imagesServer = await startImageServer(largePng)
  const firstText = [
    'Gallery A',
    markdownImage('absolute image', paths.absolute),
    markdownImage('file image', pathToFileURL(paths.file).href),
    markdownImage('sandbox image', `sandbox:${paths.sandbox}`)
  ].join('\n\n')
  const secondText = [
    'Gallery B',
    markdownImage('relative image', './relative.png'),
    markdownImage('space 中文 hash query image', paths.special),
    markdownImage('literal percent image', paths.literalPercent),
    markdownImage('JPEG image', jpegPath),
    markdownImage('missing image', join(root, 'missing.png')),
    markdownImage('broken image', paths.broken),
    markdownImage('forbidden image', `${imagesServer.baseUrl}/forbidden.png`),
    markdownImage('not found image', `${imagesServer.baseUrl}/missing.png`)
  ].join('\n\n')
  const backend = await startMockBackend({
    capabilities: ['text', 'image'],
    responses: [
      assistantMessageResponse('resp-gallery-a', 'msg-gallery-a', firstText),
      assistantMessageResponse('resp-gallery-b', 'msg-gallery-b', secondText)
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, realAppServerOptions)
    const jpegBytes = await app.evaluate(
      ({ nativeImage }, png) =>
        nativeImage.createFromBuffer(Buffer.from(png, 'base64')).toJPEG(90).toString('base64'),
      smallPng.toString('base64')
    )
    await writeFile(jpegPath, Buffer.from(jpegBytes, 'base64'))
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, 'Chat images original', root)
    await sendComposerMessage(page, '查看正文图片 A')
    const firstMessage = page.locator('[data-role="assistant"]').filter({ hasText: 'Gallery A' })
    await expect(firstMessage.locator(readyImageSelector)).toHaveCount(3)
    await expectDecoded(firstMessage.locator('img'), 1600, /^app:\/\/fs\//u)
    await sendComposerMessage(page, '查看正文图片 B')
    const secondMessage = page.locator('[data-role="assistant"]').filter({ hasText: 'Gallery B' })
    await expect(secondMessage.locator(readyImageSelector)).toHaveCount(4)
    await expect(secondMessage.locator('[data-chat-image-state="unavailable"]')).toHaveCount(4)
    await expectDecoded(
      secondMessage.locator('img:not([alt="JPEG image"])'),
      1600,
      /^app:\/\/fs\//u
    )
    await expectDecoded(secondMessage.locator('img[alt="JPEG image"]'), 80, /^app:\/\/fs\//u)
    const renderedSources = await secondMessage
      .locator('img')
      .evaluateAll((images) => images.map((image) => image.getAttribute('src')))
    expect(renderedSources.some((src) => src?.includes('literal%2520.png'))).toBe(true)
    await screenshot(page, testInfo, 'markdown-local-images')
    await secondMessage
      .locator('[data-chat-image-state="unavailable"]')
      .last()
      .scrollIntoViewIfNeeded()
    await screenshot(page, testInfo, 'markdown-image-unavailable')

    // Opening the middle image uses the three images from A, never B.
    const middleTrigger = firstMessage.locator(readyImageSelector).nth(1)
    await middleTrigger.click()
    const dialog = page.locator(previewSelector)
    await expect(dialog).toBeVisible()
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute('alt', 'file image')
    await expectDecoded(dialog.locator(previewImageSelector), 1600, /^app:\/\/fs\//u)
    const initialPercent = await zoomPercent(dialog)
    expect(initialPercent).toBeGreaterThan(0)
    expect(initialPercent).toBeLessThanOrEqual(100)
    await page.keyboard.press('ArrowRight')
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute('alt', 'sandbox image')
    await expect(dialog.getByRole('button', { name: '下一张图片', exact: true })).toBeDisabled()
    await page.keyboard.press('ArrowLeft')
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute('alt', 'file image')
    await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
    expect(await zoomPercent(dialog)).toBeGreaterThan(initialPercent)
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click()
    expect(await zoomPercent(dialog)).toBeCloseTo(initialPercent, 0)

    while ((await zoomPercent(dialog)) < 150) {
      await dialog.getByRole('button', { name: '放大图片', exact: true }).click()
    }

    const viewport = dialog.locator('[data-slot="image-preview-viewport"]')
    const box = await viewport.boundingBox()
    if (!box) throw new Error('Image preview viewport was not measurable')
    const pointer = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.4 }
    const beforeImage = await dialog.locator(previewImageSelector).boundingBox()
    if (!beforeImage) throw new Error('Zoomed image was not measurable')
    const anchor = {
      x: (pointer.x - beforeImage.x) / beforeImage.width,
      y: (pointer.y - beforeImage.y) / beforeImage.height
    }
    const beforeWheel = await zoomPercent(dialog)
    await page.mouse.move(pointer.x, pointer.y)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -150)
    await page.keyboard.up('Control')
    await expect.poll(() => zoomPercent(dialog)).toBeGreaterThan(beforeWheel)
    const afterImage = await dialog.locator(previewImageSelector).boundingBox()
    if (!afterImage) throw new Error('Image after Ctrl+wheel was not measurable')
    expect(Math.abs(afterImage.x + anchor.x * afterImage.width - pointer.x)).toBeLessThanOrEqual(2)
    expect(Math.abs(afterImage.y + anchor.y * afterImage.height - pointer.y)).toBeLessThanOrEqual(2)
    const afterCtrlWheel = await zoomPercent(dialog)
    const beforeOrdinaryWheel = await viewport.evaluate((node) => node.scrollTop)
    await page.mouse.wheel(0, 70)
    await expect
      .poll(() => viewport.evaluate((node) => node.scrollTop))
      .toBeGreaterThan(beforeOrdinaryWheel)
    await viewport.evaluate(async (node) => {
      let previous = node.scrollTop
      let stableFrames = 0
      for (let frame = 0; frame < 30 && stableFrames < 3; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        stableFrames = node.scrollTop === previous ? stableFrames + 1 : 0
        previous = node.scrollTop
      }
    })
    expect(await zoomPercent(dialog)).toBe(afterCtrlWheel)
    const beforeDrag = await viewport.evaluate((node) => ({
      x: node.scrollLeft,
      y: node.scrollTop
    }))
    await page.mouse.down()
    await page.mouse.move(pointer.x - 60, pointer.y - 60, { steps: 5 })
    await page.mouse.up()
    await expect
      .poll(() => viewport.evaluate((node) => ({ x: node.scrollLeft, y: node.scrollTop })))
      .toEqual({ x: beforeDrag.x + 60, y: beforeDrag.y + 60 })
    const beforePinch = await zoomPercent(dialog)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: pointer.x - 30, y: pointer.y, id: 1 },
        { x: pointer.x + 30, y: pointer.y, id: 2 }
      ]
    })
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: pointer.x - 45, y: pointer.y, id: 1 },
        { x: pointer.x + 45, y: pointer.y, id: 2 }
      ]
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => zoomPercent(dialog)).toBeGreaterThan(beforePinch)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false })
    await cdp.detach()
    await screenshot(page, testInfo, 'image-preview-zoom-and-navigation')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(middleTrigger).toBeFocused()

    await createLocalProject(page, 'Chat images different root', otherRoot)
    await page.reload()
    await expectAppReady(page)
    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: /^查看正文图片 A/u })
      .click()
    const restored = page.locator('[data-role="assistant"]').filter({ hasText: 'Gallery B' })
    await expect(restored.locator(readyImageSelector)).toHaveCount(4)
    await expectDecoded(restored.locator('img:not([alt="JPEG image"])'), 1600, /^app:\/\/fs\//u)
    await expectDecoded(restored.locator('img[alt="JPEG image"]'), 80, /^app:\/\/fs\//u)
    expect(providerResponseBodies(backend)).toHaveLength(2)
  } finally {
    await attachImageDiagnostics(testInfo, app)
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await imagesServer.close()
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(otherRoot, { recursive: true, force: true })
    ])
  }
})

test('runs real view_image calls and preserves two-level disclosure and fixed counts in history', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'dsc-image-view-'))
  const nativePath = join(root, 'literal%20.png')
  await writeFile(nativePath, largePng)
  const codexHomeDir = await mkdtemp(join(tmpdir(), 'dsc-image-view-history-'))
  const allowFinal = deferred()
  const allowComplete = deferred()
  const backend = await startMockBackend({
    capabilities: ['text', 'image'],
    responses: [
      imageViewResponse('resp-view-images', nativePath, 2),
      {
        ...assistantPhaseResponse(
          'resp-after-images',
          'msg-after-images',
          '图片分析完成',
          'final_answer'
        ),
        beforeResponse: () => allowFinal.promise,
        beforeEvent: (event) =>
          event.type === 'response.completed' ? allowComplete.promise : undefined
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, { ...realAppServerOptions, codexHomeDir })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, 'Native image viewing', root)
    await sendComposerMessage(page, '检查图片原生查看记录')
    const message = page.locator('[data-role="assistant"]').last()
    const processGroup = message.locator('[data-slot="reasoning-group"]')
    await expect(processGroup).toHaveAttribute('data-state', 'open')
    const record = processGroup.locator('[data-tool-group-kind="image-view"]')
    await expect(record).toContainText('已查看 2 张图片')
    await expect(record).toHaveAttribute('data-state', 'closed')
    await expect(record.locator(readyImageSelector)).toHaveCount(0)
    await screenshot(page, testInfo, 'image-view-record-in-running-process')

    allowFinal.resolve()
    await expect(message).toContainText('图片分析完成')
    await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
    await expect(processGroup).toHaveAttribute('data-state', 'closed')
    await screenshot(page, testInfo, 'image-view-process-collapsed-during-final')
    await processGroup.locator('[data-slot="reasoning-group-trigger"]').click()
    await expect(record).toHaveAttribute('data-state', 'closed')
    await record.getByRole('button').first().click()
    await expect(record.locator(readyImageSelector)).toHaveCount(2)
    await expectDecoded(record.locator('img'), 1600, /^app:\/\/fs\//u)
    for (const trigger of await record.locator(readyImageSelector).all()) {
      expect((await trigger.boundingBox())?.width).toBe(80)
      expect((await trigger.boundingBox())?.height).toBe(80)
    }
    await screenshot(page, testInfo, 'image-view-expanded-thumbnails')
    await record.locator(readyImageSelector).first().click()
    await expect(page.locator(previewSelector)).toBeVisible()
    await page.keyboard.press('Escape')
    allowComplete.resolve()
    await expectAppReady(page)
    expect(providerResponseBodies(backend)).toHaveLength(2)
    const toolOutputRequest = JSON.stringify(providerResponseBodies(backend)[1])
    expect(toolOutputRequest).toContain('view_image')
    expect(logs.join('\n')).toContain('imageView')
    const persistedViews = await attachHistoryDiagnostics(
      testInfo,
      page,
      '检查图片原生查看记录',
      codexHomeDir
    )
    expect(persistedViews).toHaveLength(2)
    expect(new Set(persistedViews.map((item) => item.id)).size).toBe(2)
    expect(persistedViews.map((item) => item.path)).toEqual([nativePath, nativePath])

    await page.reload()
    await expectAppReady(page)
    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: /^检查图片原生查看记录/u })
      .click()
    const restoredProcess = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: '图片分析完成' })
      .locator('[data-slot="reasoning-group"]')
    await expect(restoredProcess).toHaveAttribute('data-state', 'closed')
    await restoredProcess.locator('[data-slot="reasoning-group-trigger"]').click()
    await attachHistoryDiagnostics(testInfo, page, '检查图片原生查看记录', codexHomeDir)
    const restoredRecord = restoredProcess.locator('[data-tool-group-kind="image-view"]')
    await expect(restoredRecord).toContainText('已查看 2 张图片')
    await expect(restoredRecord).toHaveAttribute('data-state', 'closed')
    await restoredRecord.getByRole('button').first().click()
    await expect(restoredRecord.locator(readyImageSelector)).toHaveCount(2)
    await expectDecoded(restoredRecord.locator('img'), 1600, /^app:\/\/fs\//u)
    // A missing source changes image availability, never the occurrence count.
    await rm(nativePath)
    await page.reload()
    await expectAppReady(page)
    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: /^检查图片原生查看记录/u })
      .click()
    const missingProcess = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: '图片分析完成' })
      .locator('[data-slot="reasoning-group"]')
    await missingProcess.locator('[data-slot="reasoning-group-trigger"]').click()
    const missingRecord = missingProcess.locator('[data-tool-group-kind="image-view"]')
    await missingRecord.getByRole('button').first().click()
    await expect(missingRecord).toContainText('已查看 2 张图片')
    await expect(missingRecord.locator('[data-chat-image-state="unavailable"]')).toHaveCount(2)
    expect(providerResponseBodies(backend)).toHaveLength(2)
  } finally {
    allowFinal.resolve()
    allowComplete.resolve()
    await attachImageDiagnostics(testInfo, app)
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(root, { recursive: true, force: true })
    await rm(codexHomeDir, { recursive: true, force: true })
  }
})

test('saves original local, data and HTTP bytes and reports download cancellation and interruption', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'dsc-image-save-'))
  const imagePath = join(root, 'original.png')
  await writeFile(imagePath, largePng)
  const imagesServer = await startImageServer(largePng)
  const remoteUrl = `${imagesServer.baseUrl}/redirect.png`
  const backend = await startMockBackend({
    capabilities: ['text', 'image'],
    responses: [
      assistantMessageResponse(
        'resp-image-save',
        'msg-image-save',
        [
          'Images for saving',
          markdownImage('local save image', imagePath),
          markdownImage('HTTP save image', remoteUrl)
        ].join('\n\n')
      )
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined
  const savedPaths = [
    join(root, 'saved-local.png'),
    join(root, 'saved-data.png'),
    join(root, 'saved-http.png')
  ]

  try {
    app = await launchApp(backend, logs, realAppServerOptions)
    await app.evaluate(({ dialog }, destination) => {
      Object.assign(dialog, {
        showSaveDialog: async () => ({ canceled: false, filePath: destination })
      })
    }, savedPaths[0])
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, 'Saving chat images', root)
    await sendComposerMessage(page, '保存聊天图片')
    const message = page.locator('[data-role="assistant"]').filter({ hasText: 'Images for saving' })
    await expect(message.locator(readyImageSelector)).toHaveCount(2)
    await message.locator(readyImageSelector).first().click()
    await page
      .locator(previewSelector)
      .getByRole('button', { name: '保存图片', exact: true })
      .click()
    await expectSavedBytes(savedPaths[0], largePng)
    await app.evaluate(({ dialog }) => {
      Object.assign(dialog, { showSaveDialog: async () => ({ canceled: true }) })
    })
    await page
      .locator(previewSelector)
      .getByRole('button', { name: '保存图片', exact: true })
      .click()
    await expect(
      page.locator(previewSelector).getByRole('button', { name: '保存图片', exact: true })
    ).toBeEnabled()
    await expect(page.locator(previewSelector).getByRole('status')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await app.evaluate(({ dialog }, destination) => {
      Object.assign(dialog, {
        showSaveDialog: async () => ({ canceled: false, filePath: destination })
      })
    }, savedPaths[1])
    const dataResult = await page.evaluate(
      (source) =>
        window.desktopApp.codex.saveImage({
          source,
          sourceKind: 'media-url',
          fileName: 'original-data.png'
        }),
      `data:image/png;base64,${largePng.toString('base64')}`
    )
    expect(dataResult.status).toBe('saved')
    await expectSavedBytes(savedPaths[1], largePng)

    // Replaces only native user destination selection. Production downloadURL,
    // session will-download, DownloadItem done, and HTTP bytes stay real.
    await app.evaluate(({ BrowserWindow }, destination) => {
      const webContents = BrowserWindow.getAllWindows()[0].webContents
      const evidence: Array<{
        urls: string[]
        state: string
        receivedBytes: number
        path: string
        updates: Array<{ state: string; receivedBytes: number; resumable: boolean }>
      }> = []
      Reflect.set(webContents, '__chatImageDownloadEvidence', evidence)
      webContents.session.on('will-download', (_event, item) => {
        item.setSavePath(destination)
        const entry = {
          urls: item.getURLChain(),
          state: 'started',
          receivedBytes: 0,
          path: destination,
          updates: [] as Array<{ state: string; receivedBytes: number; resumable: boolean }>
        }
        evidence.push(entry)
        item.on('updated', (_event, state) => {
          entry.updates.push({
            state,
            receivedBytes: item.getReceivedBytes(),
            resumable: item.canResume()
          })
        })
        item.once('done', (_event, state) => {
          entry.state = state
          entry.receivedBytes = item.getReceivedBytes()
        })
      })
    }, savedPaths[2])
    await message.locator(readyImageSelector).nth(1).click()
    const dialog = page.locator(previewSelector)
    const originalUrl = page.url()
    await expectDecoded(dialog.locator(previewImageSelector), 1600, /^http:/u)
    imagesServer.interruptImageRequests()
    await dialog.getByRole('button', { name: '保存图片', exact: true }).click()
    await expect(dialog.getByRole('status')).toBeVisible()
    await expect(dialog.getByRole('status')).not.toHaveText('图片已保存')
    await expect(dialog.getByRole('button', { name: '保存图片', exact: true })).toBeEnabled()
    imagesServer.resumeImageRequests()
    await dialog.getByRole('button', { name: '保存图片', exact: true }).click()
    await expectSavedBytes(savedPaths[2], largePng)
    expect(page.url()).toBe(originalUrl)
    const downloadEvidence = await app.evaluate(({ BrowserWindow }) =>
      Reflect.get(BrowserWindow.getAllWindows()[0].webContents, '__chatImageDownloadEvidence')
    )
    expect(downloadEvidence).toEqual([
      expect.objectContaining({
        state: expect.stringMatching(/^(?:interrupted|cancelled)$/u),
        updates: expect.arrayContaining([expect.objectContaining({ state: 'interrupted' })])
      }),
      expect.objectContaining({
        state: 'completed',
        receivedBytes: largePng.length,
        urls: [remoteUrl, `${imagesServer.baseUrl}/image.png`]
      })
    ])
    await attachJson(testInfo, 'native-http-download-events', downloadEvidence)
    const hashes = await Promise.all(
      savedPaths.map(async (path) => ({ path, sha256: sha(await readFile(path)) }))
    )
    await attachJson(testInfo, 'saved-image-sha256', hashes)
    await screenshot(page, testInfo, 'image-preview-save-results')
  } finally {
    await attachImageDiagnostics(testInfo, app)
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await imagesServer.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('keeps a stopped turn without a final answer expanded and restores only persisted image views', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'dsc-image-view-stop-'))
  const nativePath = join(root, 'stop-view.png')
  await writeFile(nativePath, smallPng)
  const codexHomeDir = await mkdtemp(join(tmpdir(), 'dsc-image-view-stop-history-'))
  const allowResponse = deferred()
  const backend = await startMockBackend({
    capabilities: ['text', 'image'],
    responses: [
      imageViewResponse('resp-stop-view', nativePath, 1),
      {
        ...assistantMessageResponse(
          'resp-never-final',
          'msg-never-final',
          'This final must never arrive'
        ),
        beforeResponse: () => allowResponse.promise
      }
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, { ...realAppServerOptions, codexHomeDir })
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, 'Stopped image viewing', root)
    await sendComposerMessage(page, '停止没有最终回答的图片查看')
    const message = page.locator('[data-role="assistant"]').filter({ hasText: '先查看图片' })
    const processGroup = message.locator('[data-slot="reasoning-group"]')
    await expect(processGroup).toHaveAttribute('data-state', 'open')
    await expect(processGroup.locator('[data-tool-group-kind="image-view"]')).toContainText(
      '已查看 1 张图片'
    )
    await expect.poll(() => providerResponseBodies(backend).length).toBe(2)
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expectAppReady(page)
    await expect(processGroup).toHaveAttribute('data-state', 'open')
    await expect(processGroup.locator('[data-slot="reasoning-group-trigger"]')).toBeDisabled()
    await expect(message).not.toContainText('This final must never arrive')
    const persistedViews = await attachHistoryDiagnostics(
      testInfo,
      page,
      '停止没有最终回答的图片查看',
      codexHomeDir
    )
    expect(persistedViews).toEqual([expect.objectContaining({ path: nativePath })])
    await page.reload()
    await expectAppReady(page)
    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: /^停止没有最终回答的图片查看/u })
      .click()
    const restored = page
      .locator('[data-role="assistant"]')
      .filter({ hasText: '先查看图片' })
      .locator('[data-slot="reasoning-group"]')
    await expect(restored).toHaveAttribute('data-state', 'open')
    const record = restored.locator('[data-tool-group-kind="image-view"]')
    await expect(record).toContainText('已查看 1 张图片')
    await expect(record).toHaveAttribute('data-state', 'closed')
    await record.getByRole('button').first().click()
    await expect(record.locator(readyImageSelector)).toHaveCount(1)
    await expectDecoded(record.locator('img'), 80, /^app:\/\/fs\//u)
    await screenshot(page, testInfo, 'stopped-image-view-history-without-final')
    await attachHistoryDiagnostics(testInfo, page, '停止没有最终回答的图片查看', codexHomeDir)
  } finally {
    allowResponse.resolve()
    await attachImageDiagnostics(testInfo, app)
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(root, { recursive: true, force: true })
    await rm(codexHomeDir, { recursive: true, force: true })
  }
})

test('uses the shared gallery for composer and sent attachments while preserving image input bytes', async ({
  browserName
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Electron E2E runs through Chromium')
  test.setTimeout(90_000)
  const root = await mkdtemp(join(tmpdir(), 'dsc-image-attachments-'))
  const imagePaths = [join(root, 'attachment-large.png'), join(root, 'attachment-small.png')]
  await Promise.all([writeFile(imagePaths[0], largePng), writeFile(imagePaths[1], smallPng)])
  const backend = await startMockBackend({
    capabilities: ['text', 'image'],
    responses: [
      assistantMessageResponse('resp-attachment-gallery', 'msg-attachment-gallery', '附件已接收')
    ]
  })
  const logs: string[] = []
  let app: ElectronApplication | undefined

  try {
    app = await launchApp(backend, logs, realAppServerOptions)
    await app.evaluate(({ dialog }, paths) => {
      Object.assign(dialog, {
        showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
        showOpenDialog: async () => ({ canceled: false, filePaths: paths, bookmarks: [] })
      })
    }, imagePaths)
    const page = await app.firstWindow()
    collectRendererLogs(page, logs)
    await createLocalProject(page, 'Attachment image gallery', root)
    await page.getByRole('button', { name: '添加文件和更多', exact: true }).click()
    await page.getByRole('option', { name: 'Files and folders', exact: true }).click()
    const composer = page.locator('.aui-composer-root')
    await expect(composer.locator('.aui-attachment-tile')).toHaveCount(2)
    await composer.getByRole('button', { name: '预览attachment-large.png', exact: true }).click()
    const dialog = page.locator(previewSelector)
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute(
      'alt',
      'attachment-large.png'
    )
    await page.keyboard.press('ArrowRight')
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute(
      'alt',
      'attachment-small.png'
    )
    await expect.poll(() => zoomPercent(dialog)).toBe(100)
    await page.keyboard.press('Escape')
    await sendComposerMessage(page, '提交两个图片附件')
    await expect(page.locator('[data-role="assistant"]')).toContainText('附件已接收')
    const userMessage = page.locator('[data-role="user"]').filter({ hasText: '提交两个图片附件' })
    await expect(userMessage.locator('.aui-attachment-tile')).toHaveCount(2)
    await userMessage.getByRole('button', { name: '预览attachment-large.png', exact: true }).click()
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute(
      'alt',
      'attachment-large.png'
    )
    await page.keyboard.press('ArrowRight')
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute(
      'alt',
      'attachment-small.png'
    )
    await screenshot(page, testInfo, 'sent-attachment-shared-gallery')
    await page.keyboard.press('Escape')
    const inputs = JSON.stringify(providerResponseBodies(backend))
    expect(inputs).toContain(`data:image/png;base64,${largePng.toString('base64')}`)
    expect(inputs).toContain(`data:image/png;base64,${smallPng.toString('base64')}`)
    await page.reload()
    await expectAppReady(page)
    await page
      .locator('[data-slot="codex-sidebar"]')
      .getByRole('button', { name: /^提交两个图片附件/u })
      .click()
    const restored = page.locator('[data-role="user"]').filter({ hasText: '提交两个图片附件' })
    await expect(restored.locator('.aui-attachment-tile')).toHaveCount(2)
    await restored.getByRole('button', { name: '预览attachment-small.png', exact: true }).click()
    await expect(dialog.locator(previewImageSelector)).toHaveAttribute(
      'alt',
      'attachment-small.png'
    )
    expect(providerResponseBodies(backend)).toHaveLength(1)
  } finally {
    await attachImageDiagnostics(testInfo, app)
    await attachDiagnostics(testInfo, logs, backend, app)
    await closeApp(app)
    await backend.close()
    await rm(root, { recursive: true, force: true })
  }
})

function markdownImage(alt: string, source: string): string {
  // Real Markdown URL syntax: filenames with spaces and URI delimiters pass
  // through Streamdown's URL normalization and the markdown-url Main branch.
  const url = /^(?:file:|https?:)/u.test(source)
    ? source
    : encodeURI(source).replaceAll('#', '%23').replaceAll('?', '%3F')
  return `![${alt}](<${url}>)`
}

function imageViewResponse(responseId: string, path: string, count: number): ResponsesStreamStep {
  return {
    events: [
      responseCreated(responseId),
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          id: `${responseId}-commentary`,
          phase: 'commentary',
          content: [
            { type: 'output_text', text: count === 2 ? '先查看两次同一图片' : '先查看图片' }
          ]
        }
      },
      ...Array.from({ length: count }, (_, index) => ({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: `${responseId}-view-${index}`,
          name: 'view_image',
          arguments: JSON.stringify({ path })
        }
      })),
      responseCompleted(responseId)
    ]
  }
}

function assistantPhaseResponse(
  responseId: string,
  messageId: string,
  text: string,
  phase: 'commentary' | 'final_answer'
): ResponsesStreamStep {
  const step = assistantMessageResponse(responseId, messageId, text)
  const messageEvent = step.events.find((event) => event.type === 'response.output_item.done')
  if (!messageEvent) throw new Error('Assistant fixture has no message event')
  messageEvent.item = { ...(messageEvent.item as Record<string, unknown>), phase }
  return step
}

async function expectDecoded(images: Locator, width: number, sourcePattern: RegExp): Promise<void> {
  expect(await images.count()).toBeGreaterThan(0)
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute('src', sourcePattern)
    await expect
      .poll(() =>
        image.evaluate((node) => ({
          complete: (node as HTMLImageElement).complete,
          width: (node as HTMLImageElement).naturalWidth
        }))
      )
      .toEqual({ complete: true, width })
  }
}

async function zoomPercent(dialog: Locator): Promise<number> {
  return Number.parseFloat(
    await dialog.locator('[data-slot="image-preview-zoom-percent"]').innerText()
  )
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.screenshot({ path })
  await testInfo.attach(name, { contentType: 'image/png', path })
}

async function attachImageDiagnostics(
  testInfo: TestInfo,
  app: ElectronApplication | undefined
): Promise<void> {
  if (!app) return
  try {
    const page = await app.firstWindow()
    const images = await page.evaluate(() => ({
      url: window.location.href,
      resolveApiAvailable: typeof window.desktopApp.codex.resolveImageSource === 'function',
      images: Array.from(document.querySelectorAll('[data-chat-image-id]')).map((node) => ({
        id: node.getAttribute('data-chat-image-id'),
        state: node.getAttribute('data-chat-image-state'),
        title: node.getAttribute('title'),
        img: node.querySelector('img')?.getAttribute('src')
      }))
    }))
    await attachJson(testInfo, 'chat-image-state', images)
    const downloads = await app.evaluate(({ BrowserWindow }) =>
      Reflect.get(BrowserWindow.getAllWindows()[0].webContents, '__chatImageDownloadEvidence')
    )
    if (downloads) await attachJson(testInfo, 'native-http-download-events', downloads)
  } catch {
    // The ordinary diagnostics still capture launches that fail before a window exists.
  }
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const path = testInfo.outputPath(`${name}.json`)
  await writeFile(path, JSON.stringify(value, null, 2))
  await testInfo.attach(`${name}.json`, { contentType: 'application/json', path })
}

let historyDiagnosticIndex = 0

async function attachHistoryDiagnostics(
  testInfo: TestInfo,
  page: Page,
  title: string,
  codexHomeDir: string
): Promise<Array<{ id: string; path: string }>> {
  const projection = await page.evaluate(async (title) => {
    const state = await window.desktopApp.conversations.getConversationList()
    const conversation = state.conversations.find((conversation) => conversation.title === title)
    if (!conversation) throw new Error(`Conversation was not in authoritative list: ${title}`)
    return window.desktopApp.conversations.openConversation({ conversationId: conversation.id })
  }, title)
  const historyClient = new CodexHistoryClient({
    transport: { stdio: { env: { ...process.env, CODEX_HOME: codexHomeDir } } }
  })
  const metadata = await historyClient.readThread(projection.threadId, { includeTurns: false })
  const thread =
    metadata.historyMode === 'paginated'
      ? metadata
      : await historyClient.readThread(projection.threadId, { includeTurns: true })
  const nativeThread = {
    id: thread.id,
    historyMode: thread.historyMode ?? null,
    turns: thread.turns.map((turn) => ({ id: turn.id, status: turn.status, items: turn.items }))
  }
  const fullTurns = await historyClient
    .listTurns(projection.threadId, { itemsView: 'full' })
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
  const imageViews =
    'data' in fullTurns
      ? fullTurns.data.flatMap((turn) =>
          turn.items.flatMap((item) =>
            item.type === 'imageView' ? [{ id: item.id, path: item.path }] : []
          )
        )
      : []
  const persisted: Array<{ path: string; imageRecords: unknown[] }> = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name.endsWith('.jsonl')) {
        const imageRecords = (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
          if (!/view_image|imageView|literal%20/u.test(line)) return []
          try {
            return [JSON.parse(line)]
          } catch {
            return []
          }
        })
        if (imageRecords.length > 0) persisted.push({ path, imageRecords })
      }
    }
  }
  await visit(join(codexHomeDir, 'sessions'))
  await attachJson(testInfo, `image-view-history-${++historyDiagnosticIndex}`, {
    projection,
    nativeThread,
    fullTurns,
    persisted
  })
  return imageViews
}

async function expectSavedBytes(path: string, original: Buffer): Promise<void> {
  await expect
    .poll(async () => {
      try {
        return sha(await readFile(path))
      } catch {
        return null
      }
    })
    .toBe(sha(original))
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function startImageServer(bytes: Buffer): Promise<{
  baseUrl: string
  interruptImageRequests(): void
  resumeImageRequests(): void
  close(): Promise<void>
}> {
  const pending = new Set<ServerResponse>()
  let interrupted = false
  const server = createServer((request, response) => {
    pending.add(response)
    response.once('close', () => pending.delete(response))
    if (request.url === '/redirect.png') {
      response.writeHead(302, { location: '/image.png', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (request.url === '/forbidden.png' || request.url === '/missing.png') {
      response.writeHead(request.url === '/forbidden.png' ? 403 : 404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'image/png',
      'content-length': bytes.length,
      'cache-control': 'no-store'
    })
    if (interrupted) {
      response.write(bytes.subarray(0, 32), () => response.destroy())
      return
    }
    response.end(bytes)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Image HTTP fixture has no port')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    interruptImageRequests: () => {
      interrupted = true
    },
    resumeImageRequests: () => {
      interrupted = false
    },
    close: () =>
      new Promise((resolve, reject) => {
        for (const response of pending) response.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      rows[row + 1 + x * 3] = x % 256
      rows[row + 2 + x * 3] = y % 256
      rows[row + 3 + x * 3] = (x + y) % 256
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type)
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  typeBytes.copy(result, 4)
  data.copy(result, 8)
  let crc = 0xffffffff
  for (const byte of Buffer.concat([typeBytes, data])) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
