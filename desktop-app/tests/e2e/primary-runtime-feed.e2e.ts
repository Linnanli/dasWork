import { access, readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

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
  withR07PresentationWorkspace,
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

type WorkspaceDependencies = {
  node: string
  nodeModules: string
  python: string
  pythonPackages: string[]
  soffice: string
  pdftoppm: string
  font: string
}

test('AT-E2E-01/PRESENTATION-SKILL-RUNTIME installs a signed Feed Runtime and creates an R07 presentation through a normal command', async ({
  browserName
}, testInfo) => {
  // The target-native calibration archive is intentionally large enough that
  // download, staging, activation, plugin sync, QA, and render can exceed the
  // generic 60-second default. P3b separately measures the numeric cold-install
  // budget; this timeout only keeps the real end-to-end acceptance path intact.
  test.setTimeout(180_000)
  expect(browserName).toBe('chromium')

  await withR07PresentationWorkspace(async (workspace) => {
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
        (request) => runtimePresentationCommandResponse(request, workspace),
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
        // test's own 180-second end-to-end bound still limits the full path.
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
      await expectPrimaryRuntimeReady(page, logs)
      await expectRuntimePresentationSkill(page)
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

      const runtimeSuccessMessage = page
        .locator('[data-role="assistant"]')
        .filter({
          hasText:
            'The signed Primary Runtime created, rendered, checked, and previewed the six-page presentation through the native desktop command path.'
        })
      await expect(runtimeSuccessMessage).toHaveCount(1, { timeout: 120_000 })

      const providerBodies = providerResponseBodies(backend)
      // Follow-up Responses requests retain earlier tool outputs as context.
      // Presence proves each desktop tool ran; counting replayed provider input
      // as a second invocation would make this product gate flaky.
      expect(functionCallOutputCount(providerBodies, loaderCallId)).toBeGreaterThanOrEqual(1)
      expect(functionCallOutputCount(providerBodies, runtimeCommandCallId)).toBeGreaterThanOrEqual(1)

      const runtimeCommandOutput = providerBodies
        .map((body) => functionCallOutputText(body, runtimeCommandCallId))
        .find((output): output is string => Boolean(output))
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
      await expectR07QaOutputs(workspace)
      await openR07PresentationInWorkspace(page, workspace.outputFile)
    } finally {
      await attachDiagnostics(testInfo, logs, backend, app)
      await closeApp(app)
      await backend.close()
    }
  })
})

async function expectPrimaryRuntimeReady(page: Page, logs: readonly string[]): Promise<void> {
  let latestStatus: unknown
  let pollError: unknown
  try {
    await expect
      .poll(
        async () => {
          latestStatus = await page.evaluate(async () => {
            const result = await window.desktopApp.plugins.getPrimaryRuntimeStatus({ version: 1 })
            return result.runtime
          })
          const state = (latestStatus as { state?: unknown }).state
          return typeof state === 'string' ? state : 'unknown'
        },
        { timeout: 120_000 }
      )
      .toMatch(/^(?:ready|failed)$/u)
  } catch (error) {
    pollError = error
  }

  if ((latestStatus as { state?: unknown }).state === 'ready') return

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

function safePrimaryRuntimeDiagnosticLogs(logs: readonly string[]): string {
  try {
    // Keep the failure surface to Main's Primary Runtime and its direct
    // post-install plugin reconciliation diagnostics, then apply the shared
    // serializer before exposing any test attachment output.
    const runtimeAndPluginLogs = logs
      .filter(
        (log) => log.includes('[primary-runtime]') || log.includes('[bundled-plugins]')
      )
      .slice(-8)
    return serializeDiagnosticData({ runtimeAndPluginLogs }).slice(-8_000)
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

function runtimePresentationCommandResponse(
  request: MockRequest,
  workspace: R07PresentationWorkspace
): ResponsesStep {
  const loaderOutput = functionCallOutputText(JSON.parse(request.body) as unknown, loaderCallId)
  if (!loaderOutput) {
    throw new Error('The Runtime Node command was requested before loader output was returned.')
  }
  const dependencies = parseWorkspaceDependencies(loaderOutput)
  const source = runtimePresentationCommandSource(dependencies, workspace)
  // Passing a base64 payload prevents shell quoting from changing the command
  // source on Windows. The only executable remains the Runtime Node path from
  // load_workspace_dependencies; this is still one ordinary command item.
  const encodedSource = Buffer.from(source, 'utf8').toString('base64')
  const command = [
    shellQuote(dependencies.node),
    '--input-type=module',
    '-e',
    shellQuote(`eval(Buffer.from('${encodedSource}','base64').toString('utf8'))`)
  ].join(' ')

  return shellCommandResponse('response-runtime-command', runtimeCommandCallId, {
    command,
    sandbox_permissions: 'require_escalated',
    justification: 'The signed Primary Runtime presentation command needs its one-time approved execution path.'
  })
}

function runtimePresentationCommandSource(
  dependencies: WorkspaceDependencies,
  workspace: R07PresentationWorkspace
): string {
  const facts = workspace.facts.map((fact) => fact.value)
  return [
    "import { execFileSync } from 'node:child_process'",
    "import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { dirname, join, delimiter } from 'node:path'",
    `const dependencies = ${JSON.stringify(dependencies)}`,
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
    "const skillRoot = join(process.env.CODEX_HOME || '', 'skills', 'dascowork-primary-runtime', 'presentation-skill')",
    "if (!process.env.CODEX_HOME || !existsSync(skillRoot)) throw new Error('Runtime-owned presentation skill is unavailable.')",
    "const scripts = { build: join(skillRoot, 'scripts', 'build_deck_pptxgenjs.js'), layout: join(skillRoot, 'scripts', 'layout_lint.py'), render: join(skillRoot, 'scripts', 'render_slides.py') }",
    "if (Object.values(scripts).some((path) => !existsSync(path))) throw new Error('Locked presentation skill scripts are incomplete.')",
    "const inputHtml = readFileSync(join(workspace.root, workspace.inputFile), 'utf8')",
    'for (const fact of workspace.facts) if (!inputHtml.includes(fact)) throw new Error(`Workspace HTML is missing required fact: ${fact}`)',
    "const outlinePath = join(workspace.root, 'r07-outline.json')",
    'const outputPath = join(workspace.root, workspace.outputFile)',
    'const layoutPath = join(workspace.root, workspace.layoutReceiptFile)',
    'const renderedSlides = join(workspace.root, workspace.renderedSlidesDirectory)',
    'const contactSheet = join(workspace.root, workspace.contactSheetFile)',
    'const imagePath = join(workspace.root, workspace.imageFile)',
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
    "execFileSync(dependencies.python, [scripts.layout, '--input', outputPath, '--outline', outlinePath, '--output', layoutPath, '--fail-on-error'], { cwd: workspace.root, env: pythonEnv, stdio: 'inherit' })",
    'const renderEnv = { ...pythonEnv, FONTCONFIG_FILE: fontConfig, FONTCONFIG_PATH: dirname(dependencies.font), PPTX_RUNTIME_SOFFICE: dependencies.soffice, PPTX_RUNTIME_PDFTOPPM: dependencies.pdftoppm, PATH: [dirname(dependencies.soffice), dirname(dependencies.pdftoppm)].join(delimiter) }',
    "execFileSync(dependencies.python, [scripts.render, '--input', outputPath, '--outdir', renderedSlides, '--format', 'png', '--dpi', '72'], { cwd: workspace.root, env: renderEnv, stdio: 'inherit' })",
    "const contactSheetScript = `from pathlib import Path\\nfrom PIL import Image, ImageDraw\\nimport sys\\nsource=Path(sys.argv[1])\\nout=Path(sys.argv[2])\\npaths=sorted(source.glob('slide-*.png'))\\nif len(paths) < 6: raise SystemExit('expected six rendered slides')\\nthumbs=[]\\nfor path in paths:\\n    image=Image.open(path).convert('RGB')\\n    image.thumbnail((420, 236))\\n    canvas=Image.new('RGB', (432, 268), 'white')\\n    canvas.paste(image, ((432-image.width)//2, 8))\\n    ImageDraw.Draw(canvas).text((8, 246), path.name, fill='black')\\n    thumbs.append(canvas)\\nsheet=Image.new('RGB', (864, ((len(thumbs)+1)//2)*268), 'white')\\nfor i, image in enumerate(thumbs): sheet.paste(image, ((i%2)*432, (i//2)*268))\\nsheet.save(out, 'PNG')`",
    "execFileSync(dependencies.python, ['-c', contactSheetScript, renderedSlides, contactSheet], { cwd: workspace.root, env: renderEnv, stdio: 'inherit' })",
    'const rendered = readdirSync(renderedSlides).filter((name) => /^slide-\\d+\\.png$/u.test(name))',
    "if (rendered.length < 6 || !existsSync(contactSheet) || !existsSync(layoutPath) || !existsSync(outputPath) || !existsSync(imagePath)) throw new Error('Runtime presentation QA outputs are incomplete.')",
    'process.stdout.write(`presentation-skill:created:${rendered.length}`)'
  ].join('; ')
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

async function expectR07QaOutputs(workspace: R07PresentationWorkspace): Promise<void> {
  const [layoutSource, renderedSlides] = await Promise.all([
    readFile(join(workspace.root, workspace.layoutReceiptFile), 'utf8'),
    readdir(join(workspace.root, workspace.renderedSlidesDirectory))
  ])
  const layout = JSON.parse(layoutSource) as { summary?: { slide_count?: number } }
  expect(layout.summary?.slide_count).toBeGreaterThanOrEqual(6)
  expect(renderedSlides.filter((name) => /^slide-\d+\.png$/u.test(name))).toHaveLength(6)
  await expect(access(join(workspace.root, workspace.contactSheetFile))).resolves.toBeUndefined()
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll("'", "'\\''")}'`
}
