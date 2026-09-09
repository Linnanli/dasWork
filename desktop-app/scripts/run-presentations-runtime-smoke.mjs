#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- Executable smoke scripts use runtime assertions instead of TypeScript annotations. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import JSZip from 'jszip'

if (process.env.DASCOWORK_PRESENTATIONS_RUNTIME_SMOKE !== '1') {
  throw new Error(
    'Set DASCOWORK_PRESENTATIONS_RUNTIME_SMOKE=1 to run the deterministic Presentations Runtime gate.'
  )
}

const configuredRuntimeRoot = process.env.DASCOWORK_PRIMARY_RUNTIME_ROOT?.trim()
const configuredEvidenceRoot = process.env.DASCOWORK_PRESENTATIONS_RUNTIME_SMOKE_OUTPUT_DIR?.trim()
assert(
  configuredRuntimeRoot && configuredEvidenceRoot,
  'Deterministic Presentations Runtime smoke requires DASCOWORK_PRIMARY_RUNTIME_ROOT and DASCOWORK_PRESENTATIONS_RUNTIME_SMOKE_OUTPUT_DIR.'
)

const runtimeRoot = await realpath(resolve(configuredRuntimeRoot))
const evidenceRoot = resolve(configuredEvidenceRoot)
const runRoot = join(
  evidenceRoot,
  `run-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`
)
const buildRoot = join(runRoot, 'build')
const outputRoot = join(runRoot, 'output')
const renderRoot = join(runRoot, 'rendered')
await mkdir(buildRoot, { recursive: true })
await mkdir(outputRoot, { recursive: true })
await mkdir(renderRoot, { recursive: true })

await main()

async function main() {
  const dependencies = await resolveRuntimeDependencies(runtimeRoot)
  const presentations = await resolvePresentationsSkill(runtimeRoot, dependencies.manifest)
  const finalPath = join(outputRoot, 'presentation-smoke.pptx')
  const candidatePath = join(buildRoot, 'candidate.pptx')
  const receiptPath = join(buildRoot, 'presentation-smoke.validation.json')
  const authoringScript = join(buildRoot, 'create-presentation.mjs')
  await symlink(
    dependencies.nodeModules,
    join(buildRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await writeFile(
    authoringScript,
    authoringSource({
      candidatePath,
      finalPath,
      receiptPath,
      skillDirectory: presentations.skillDirectory,
      workspaceDirectory: runRoot,
      pythonExecutable: dependencies.python
    })
  )

  const runtimeEnv = {
    ...process.env,
    PATH: dependencies.runtimeBinDirectory,
    NODE_PATH: dependencies.nodeModules,
    RUNTIME_NODE: dependencies.node,
    RUNTIME_NODE_MODULES: dependencies.nodeModules,
    RUNTIME_BIN_DIR: dependencies.runtimeBinDirectory,
    RUNTIME_PYTHON: dependencies.python,
    SKILL_DIR: presentations.skillDirectory,
    TMP_DIR: buildRoot
  }
  const markerPath = join(
    presentations.skillDirectory,
    'container_tools',
    'mark_artifact_operation_started.mjs'
  )
  await assertFile(markerPath, 'artifact-operation marker')
  const markerArguments = [
    markerPath,
    '--operation-kind',
    'create',
    '--expected-output-count',
    '1',
    '--output-format',
    'pptx'
  ]
  const markerStartedAt = new Date().toISOString()
  runChecked(dependencies.node, markerArguments, {
    cwd: presentations.skillDirectory,
    env: runtimeEnv,
    label: 'artifact-operation marker'
  })

  const authoringStartedAt = new Date().toISOString()
  runChecked(dependencies.node, [authoringScript], {
    cwd: buildRoot,
    env: runtimeEnv,
    label: 'Presentations authoring and finalization'
  })

  const renderScript = join(
    presentations.skillDirectory,
    'container_tools',
    'render_presentation.mjs'
  )
  const renderResult = runChecked(
    dependencies.node,
    [renderScript, '--input', finalPath, '--output_dir', renderRoot, '--scale', '1'],
    { cwd: buildRoot, env: runtimeEnv, label: 'Presentations render' }
  )
  const renderReport = JSON.parse(renderResult.stdout)
  assert(renderReport.slideCount === 1, 'Render report did not contain exactly one slide.')
  assert(
    Array.isArray(renderReport.paths) && renderReport.paths.length === 1,
    'Render report did not contain exactly one image.'
  )
  const renderedSlide = await realpath(renderReport.paths[0])
  assertPathInside(renderRoot, renderedSlide, 'Rendered slide')
  const renderedBytes = await readFile(renderedSlide)
  assert(
    renderedBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'Rendered slide is not a PNG image.'
  )

  const overflowScript = join(presentations.skillDirectory, 'container_tools', 'slides_test.py')
  const overflowResult = runChecked(dependencies.python, [overflowScript, finalPath], {
    cwd: buildRoot,
    env: runtimeEnv,
    label: 'Presentations overflow check'
  })
  assert(
    overflowResult.stdout.includes('Test passed. No overflow detected.') &&
      !overflowResult.stdout.includes('ERROR:'),
    `Presentations overflow check did not pass:\n${overflowResult.stdout}`
  )

  const pptx = await readFile(finalPath)
  const zip = await JSZip.loadAsync(pptx)
  const requiredParts = [
    '[Content_Types].xml',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slides/slide1.xml'
  ]
  for (const part of requiredParts) assert(zip.file(part), `Generated PPTX is missing ${part}.`)
  const slideXml = await zip.file('ppt/slides/slide1.xml').async('string')
  assert(
    slideXml.includes('dasCowork Presentations Smoke'),
    'Generated PPTX does not contain the authored title.'
  )
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const finalSha256 = createHash('sha256').update(pptx).digest('hex')
  assert(
    receipt.schemaVersion === 'presentation-finalization.v1' && receipt.finalSha256 === finalSha256,
    'Presentation finalization receipt does not match the final PPTX.'
  )

  const evidence = {
    schemaVersion: 'dascowork-presentations-smoke.v1',
    status: 'passed',
    mode: 'deterministic-primary-runtime',
    runtime: {
      root: runtimeRoot,
      bundleVersion: dependencies.bundleVersion,
      node: dependencies.node,
      nodeModules: dependencies.nodeModules,
      artifactToolPackage: dependencies.artifactToolPackage,
      python: dependencies.python,
      runtimeBinDirectory: dependencies.runtimeBinDirectory
    },
    presentations: {
      marketplacePath: presentations.marketplacePath,
      pluginRoot: presentations.pluginRoot,
      skillDirectory: presentations.skillDirectory,
      pluginVersion: presentations.pluginVersion
    },
    operationMarker: {
      executable: dependencies.node,
      arguments: markerArguments,
      startedAt: markerStartedAt,
      completedBeforeAuthoring: markerStartedAt <= authoringStartedAt
    },
    artifact: {
      path: finalPath,
      sha256: finalSha256,
      byteCount: pptx.byteLength,
      requiredParts,
      validationReceipt: receiptPath
    },
    rendering: {
      slideCount: 1,
      paths: [renderedSlide],
      overflow: overflowResult.stdout.trim()
    }
  }
  const evidencePath = join(runRoot, 'evidence.json')
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ ok: true, finalPath, evidencePath, renderedSlide }))
}

async function resolveRuntimeDependencies(root) {
  const manifest = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  const v2 = manifest.bundleFormatVersion === 2
  assert(v2 || manifest.bundleFormatVersion === 1, 'Unsupported Primary Runtime manifest format.')
  const node = await ownedFile(
    root,
    v2 ? 'dependencies/node/bin/node' : manifest.node?.path,
    'Primary Runtime Node'
  )
  const artifactToolPackage = await ownedDirectory(
    root,
    v2
      ? 'dependencies/node/node_modules/@oai/artifact-tool'
      : manifest.nodePackages?.find((entry) => entry.name === '@oai/artifact-tool')?.path,
    '@oai/artifact-tool package'
  )
  const artifactPackage = JSON.parse(
    await readFile(join(artifactToolPackage, 'package.json'), 'utf8')
  )
  assert(artifactPackage.name === '@oai/artifact-tool', 'artifact-tool package name mismatch.')
  assert(
    typeof artifactPackage.version === 'string' && artifactPackage.version.length > 0,
    'artifact-tool package version is missing.'
  )
  await ownedFile(
    artifactToolPackage,
    artifactPackage.exports?.['.']?.import ??
      artifactPackage.exports?.['.']?.default ??
      artifactPackage.exports?.['.'] ??
      artifactPackage.module ??
      artifactPackage.main,
    '@oai/artifact-tool entry'
  )
  const nodeModules = await realpath(
    v2 ? join(root, 'dependencies', 'node', 'node_modules') : findNodeModules(artifactToolPackage)
  )
  assertPathInside(root, nodeModules, 'Primary Runtime node_modules')
  const python = await ownedFile(
    root,
    v2 ? 'dependencies/python/bin/python' : manifest.python?.path,
    'Primary Runtime Python'
  )
  const runtimeBinDirectory = await ownedDirectory(
    root,
    v2
      ? 'dependencies/bin/override'
      : dirname(
          manifest.binaries?.find((entry) => entry.name === 'pdfinfo')?.path ??
            manifest.binaries?.[0]?.path ??
            ''
        ),
    'Primary Runtime binary directory'
  )
  for (const binary of ['pdfinfo', 'pdftoppm']) {
    await assertFile(join(runtimeBinDirectory, executableName(binary)), `Primary Runtime ${binary}`)
  }
  return {
    manifest,
    bundleVersion: manifest.bundleVersion,
    node,
    nodeModules,
    artifactToolPackage,
    python,
    runtimeBinDirectory
  }
}

async function resolvePresentationsSkill(root, manifest) {
  for (const entry of manifest.bundledPlugins ?? []) {
    const marketplaceRelativePath = typeof entry === 'string' ? entry : entry.path
    const marketplacePath = await ownedDirectory(
      root,
      marketplaceRelativePath,
      'Primary Runtime marketplace'
    )
    const marketplace = JSON.parse(
      await readFile(join(marketplacePath, '.agents', 'plugins', 'marketplace.json'), 'utf8')
    )
    const plugin = marketplace.plugins?.find((candidate) => candidate.name === 'presentations')
    if (!plugin) continue
    assert(
      plugin.source?.source === 'local' && typeof plugin.source.path === 'string',
      'Presentations marketplace entry is not a local plugin.'
    )
    const pluginRoot = await ownedDirectory(
      marketplacePath,
      plugin.source.path,
      'Presentations plugin'
    )
    const pluginManifest = JSON.parse(
      await readFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8')
    )
    assert(pluginManifest.name === 'presentations', 'Presentations plugin manifest name mismatch.')
    const skillDirectory = await ownedDirectory(
      pluginRoot,
      'skills/presentations',
      'Presentations skill'
    )
    return {
      marketplacePath,
      pluginRoot,
      pluginVersion: pluginManifest.version,
      skillDirectory
    }
  }
  throw new Error('Primary Runtime does not declare a Presentations plugin.')
}

function authoringSource(input) {
  return `
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const skillDirectory = ${JSON.stringify(input.skillDirectory)};
const { finalizePresentation, resolvePresentationFont } = await import(
  pathToFileURL(path.join(skillDirectory, 'container_tools', 'artifact_tool_utils.mjs')).href
);
const fontFamily = resolvePresentationFont();
const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const slide = presentation.slides.add();
slide.background.fill = '#FFFFFF';
const title = slide.shapes.add({
  geometry: 'textbox',
  position: { left: 72, top: 72, width: 1136, height: 92 },
  fill: 'none',
  line: { fill: 'none', width: 0 }
});
title.text = 'dasCowork Presentations Smoke';
title.text.style = {
  typeface: fontFamily,
  fontSize: 44,
  bold: true,
  color: '#142735',
  autoFit: 'none'
};
const body = slide.shapes.add({
  geometry: 'textbox',
  position: { left: 72, top: 205, width: 1000, height: 80 },
  fill: 'none',
  line: { fill: 'none', width: 0 }
});
body.text = 'Primary Runtime authoring, validation, rendering, and overflow checks completed.';
body.text.style = {
  typeface: fontFamily,
  fontSize: 22,
  color: '#334155',
  autoFit: 'none'
};
await (await PresentationFile.exportPptx(presentation)).save(${JSON.stringify(input.candidatePath)});
await finalizePresentation({
  workspaceDir: ${JSON.stringify(input.workspaceDirectory)},
  candidatePath: ${JSON.stringify(input.candidatePath)},
  finalPath: ${JSON.stringify(input.finalPath)},
  pythonExecutable: ${JSON.stringify(input.pythonExecutable)},
  integrityValidatorPath: path.join(skillDirectory, 'container_tools', 'inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(skillDirectory, 'container_tools', 'inspect_presentation_layout_geometry.py'),
  layoutArgs: [
    '--expected-slide-size-emu', '12192000,6858000',
    '--expected-aspect', '16:9',
    '--validate-heading-fit',
    '--validate-heading-punctuation'
  ],
  explicitTotalSlideCount: 1,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [],
  fontPolicy: { basis: 'default' },
  verifyArtifactToolImport: true,
  receiptPath: ${JSON.stringify(input.receiptPath)}
});
`
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(
      `${options.label} failed (${result.status ?? result.signal ?? 'unknown'}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }
  return result
}

async function ownedFile(root, path, label) {
  assert(typeof path === 'string' && path.length > 0, `${label} path is missing.`)
  const candidate = await realpath(resolve(root, path))
  assertPathInside(root, candidate, label)
  await assertFile(candidate, label)
  return candidate
}

async function ownedDirectory(root, path, label) {
  assert(typeof path === 'string' && path.length > 0, `${label} path is missing.`)
  const candidate = await realpath(resolve(root, path))
  assertPathInside(root, candidate, label)
  const stats = await stat(candidate)
  assert(stats.isDirectory(), `${label} is not a directory: ${candidate}`)
  return candidate
}

async function assertFile(path, label) {
  const stats = await stat(path)
  assert(stats.isFile(), `${label} is not a file: ${path}`)
}

function assertPathInside(root, candidate, label) {
  const difference = relative(root, candidate)
  assert(
    difference === '' || (!difference.startsWith('..') && !isAbsolute(difference)),
    `${label} escapes its trusted root.`
  )
}

function findNodeModules(packagePath) {
  let current = packagePath
  while (dirname(current) !== current) {
    if (basename(current) === 'node_modules') return current
    current = dirname(current)
  }
  throw new Error('Could not resolve the Primary Runtime node_modules root.')
}

function executableName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
