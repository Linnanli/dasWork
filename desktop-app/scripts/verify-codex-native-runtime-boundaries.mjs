import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runtime validation makes JSDoc return annotations redundant in this executable verifier. */

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

const MAIN_FORBIDDEN = [
  ['legacy-provider-import', /@janole\/ai-sdk-provider-codex-asp/u],
  ['ai-sdk-stream-text', /\bstreamText\s*\(/u],
  ['ai-sdk-model-message-conversion', /\bconvertToModelMessages\s*\(/u],
  ['provider-call-options', /\bcodexCallOptions\s*\(/u],
  ['ai-sdk-language-model', /\bLanguageModelV3\b/u],
  ['legacy-codex-language-model', /\bCodexLanguageModel\b/u]
]

const CORE_FORBIDDEN = [
  ['ai-sdk', /from\s+['"](?:ai|@ai-sdk\/provider|@ai-sdk\/provider-utils)['"]/u],
  ['renderer-or-electron', /from\s+['"](?:react|electron)['"]/u],
  [
    'desktop-reverse-dependency',
    /(?:desktop-app\/src\/(?:main|renderer|shared)|\.\.\/\.\.\/\.\.\/src\/)/u
  ]
]

const RENDERER_BOUNDARY_FORBIDDEN = [
  [
    'legacy-provider-import',
    /(?:from\s+|import\s*\(\s*)['"]@janole\/ai-sdk-provider-codex-asp(?:\/[^'"]*)?['"]/u
  ],
  [
    'generic-app-server-request',
    /(?:\bmethod\??\s*:\s*string[\s\S]{0,240}\bparams\??\s*:\s*unknown|\bparams\??\s*:\s*unknown[\s\S]{0,240}\bmethod\??\s*:\s*string)/u
  ]
]

const GENERATED_PROTOCOL_DIRECTORY = 'app-server-protocol'
const CANONICAL_PROTOCOL_TREE = 'vendors/codex-app-server-client/src/protocol/app-server-protocol'
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const IGNORED_DIRECTORIES = new Set(['dist', 'node_modules', '.git'])
const REQUIRED_PRODUCTION_ROOTS = ['renderer', 'preload', 'shared', 'main', 'core']

const DEFAULT_PRODUCTION_ROOTS = [
  {
    label: 'renderer',
    root: resolve(desktopRoot, 'src/renderer'),
    rules: RENDERER_BOUNDARY_FORBIDDEN
  },
  {
    label: 'preload',
    root: resolve(desktopRoot, 'src/preload'),
    rules: RENDERER_BOUNDARY_FORBIDDEN
  },
  {
    label: 'shared',
    root: resolve(desktopRoot, 'src/shared'),
    rules: RENDERER_BOUNDARY_FORBIDDEN
  },
  { label: 'main', root: resolve(desktopRoot, 'src/main'), rules: MAIN_FORBIDDEN },
  {
    label: 'core',
    root: resolve(desktopRoot, 'vendors/codex-app-server-client/src'),
    rules: CORE_FORBIDDEN
  }
]

const DEFAULT_TEST_ROOTS = [
  { label: 'renderer', root: resolve(desktopRoot, 'src/renderer') },
  { label: 'preload', root: resolve(desktopRoot, 'src/preload') },
  { label: 'shared', root: resolve(desktopRoot, 'src/shared') },
  { label: 'main', root: resolve(desktopRoot, 'src/main') },
  { label: 'core', root: resolve(desktopRoot, 'vendors/codex-app-server-client/src') }
]

const DEFAULT_COMPATIBILITY_FIXTURE_ROOTS = [
  {
    label: 'legacy-provider-tests',
    root: resolve(desktopRoot, 'vendors/ai-sdk-provider-codex-asp/tests')
  }
]

/**
 * Exceptions must name exactly one file and one rule. Keep this empty unless a
 * compatibility fixture has a documented, bounded migration reason.
 */
const ALLOWLIST = []

function sourceExtensionSet(sourceExtensions) {
  return new Set(sourceExtensions)
}

function isSourceFile(path, sourceExtensions) {
  return sourceExtensionSet(sourceExtensions).has(extname(path))
}

function isTestFile(path) {
  return /(?:^|[./-])(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)
}

function walk(root, sourceExtensions = SOURCE_EXTENSIONS) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) return []
      const path = resolve(root, entry.name)
      return entry.isDirectory()
        ? walk(path, sourceExtensions)
        : isSourceFile(path, sourceExtensions)
          ? [path]
          : []
    })
}

function walkDirectories(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (IGNORED_DIRECTORIES.has(entry.name)) return []
      const path = resolve(root, entry.name)
      return entry.isDirectory() ? [path, ...walkDirectories(path)] : []
    })
}

function scan(files, rules, label, allowlist, usedAllowlist) {
  const violations = []
  for (const path of files) {
    const source = readFileSync(path, 'utf8')
    for (const [rule, expression] of rules) {
      const ruleId = `${label}:${rule}`
      const flags = expression.flags.includes('g') ? expression.flags : `${expression.flags}g`
      const matches = [...source.matchAll(new RegExp(expression.source, flags))]
      const file = relative(desktopRoot, path)
      const allowance = allowlist.find((entry) => entry.file === file && entry.rule === ruleId)
      if (allowance && matches.length === allowance.expectedMatches) {
        usedAllowlist.add(`${allowance.file}\0${allowance.rule}`)
        continue
      }
      if (matches.length > 0 || allowance) {
        violations.push({ rule: ruleId, file, matches: matches.length })
      }
    }
  }
  return violations
}

function normalizeRootEntries(entries, optionName) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`Codex native runtime boundary check failed: ${optionName} is empty`)
  }
  return entries.map((entry) => {
    if (typeof entry === 'string') return { label: entry, root: entry, rules: [] }
    return { rules: [], ...entry }
  })
}

function verifyScanCoverage({ productionRoots, sourceExtensions }) {
  const violations = []
  const labels = new Set(productionRoots.map((entry) => entry.label))
  for (const label of REQUIRED_PRODUCTION_ROOTS) {
    if (!labels.has(label)) {
      violations.push({ rule: 'scanner:missing-production-root', file: label })
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    if (!sourceExtensions.includes(extension)) {
      violations.push({ rule: 'scanner:missing-source-extension', file: extension })
    }
  }
  for (const entry of productionRoots) {
    if (!existsSync(entry.root)) {
      violations.push({ rule: 'scanner:missing-production-root-path', file: entry.label })
    }
  }
  return violations
}

function summarizeFiles(entries, sourceExtensions, predicate) {
  const roots = Object.fromEntries(
    entries.map((entry) => {
      const files = walk(entry.root, sourceExtensions).filter(predicate)
      return [
        entry.label,
        {
          root: relative(desktopRoot, entry.root),
          files: files.length,
          extensions: Object.fromEntries(
            SOURCE_EXTENSIONS.map((extension) => [
              extension,
              files.filter((path) => extname(path) === extension).length
            ])
          )
        }
      ]
    })
  )
  return {
    files: Object.values(roots).reduce((sum, root) => sum + root.files, 0),
    roots
  }
}

function verifyAllowlist(allowlist, usedAllowlist) {
  const violations = []
  for (const entry of allowlist) {
    if (
      typeof entry?.file !== 'string' ||
      typeof entry?.rule !== 'string' ||
      !Number.isInteger(entry?.expectedMatches) ||
      entry.expectedMatches < 1 ||
      typeof entry?.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      violations.push({ rule: 'allowlist:invalid-entry', file: String(entry?.file ?? '') })
    } else if (!usedAllowlist.has(`${entry.file}\0${entry.rule}`)) {
      violations.push({ rule: 'allowlist:stale-entry', file: entry.file })
    }
  }
  return violations
}

function generatedProtocolTreeViolations(protocolSearchRoot) {
  const expected = resolve(protocolSearchRoot, CANONICAL_PROTOCOL_TREE)
  const trees = walkDirectories(protocolSearchRoot).filter(
    (path) => path.endsWith(`/${GENERATED_PROTOCOL_DIRECTORY}`) && statSync(path).isDirectory()
  )
  if (trees.length === 1 && trees[0] === expected) return []
  return trees.length === 0
    ? [{ rule: 'protocol:missing-generated-tree', file: relative(protocolSearchRoot, expected) }]
    : trees
        .filter((tree) => tree !== expected)
        .map((tree) => ({
          rule: 'protocol:duplicate-generated-tree',
          file: relative(protocolSearchRoot, tree)
        }))
        .concat(
          trees.includes(expected)
            ? []
            : [
                {
                  rule: 'protocol:missing-canonical-tree',
                  file: relative(protocolSearchRoot, expected)
                }
              ]
        )
}

/**
 * Static production gate for the native execution path. Tests and archived
 * compatibility fixtures are deliberately outside these roots.
 */
export function verifyCodexNativeRuntimeBoundaries({
  productionRoots = DEFAULT_PRODUCTION_ROOTS,
  testRoots = DEFAULT_TEST_ROOTS,
  compatibilityFixtureRoots = DEFAULT_COMPATIBILITY_FIXTURE_ROOTS,
  protocolSearchRoot = desktopRoot,
  allowlist = ALLOWLIST,
  sourceExtensions = SOURCE_EXTENSIONS
} = {}) {
  const normalizedProductionRoots = normalizeRootEntries(productionRoots, 'productionRoots')
  const normalizedTestRoots = normalizeRootEntries(testRoots, 'testRoots')
  const normalizedCompatibilityFixtureRoots = normalizeRootEntries(
    compatibilityFixtureRoots,
    'compatibilityFixtureRoots'
  )
  const usedAllowlist = new Set()
  const productionFilesByRoot = normalizedProductionRoots.map((entry) => ({
    ...entry,
    files: walk(entry.root, sourceExtensions).filter((path) => !isTestFile(path))
  }))
  const violations = [
    ...verifyScanCoverage({ productionRoots: normalizedProductionRoots, sourceExtensions }),
    ...productionFilesByRoot.flatMap((entry) =>
      scan(entry.files, entry.rules, entry.label, allowlist, usedAllowlist)
    ),
    ...verifyAllowlist(allowlist, usedAllowlist),
    ...generatedProtocolTreeViolations(protocolSearchRoot)
  ]
  const report = {
    ok: violations.length === 0,
    violations,
    scanned: {
      production: summarizeFiles(
        normalizedProductionRoots,
        sourceExtensions,
        (path) => !isTestFile(path)
      ),
      tests: summarizeFiles(normalizedTestRoots, sourceExtensions, isTestFile),
      compatibilityFixtures: summarizeFiles(
        normalizedCompatibilityFixtureRoots,
        sourceExtensions,
        () => true
      )
    },
    allowlist
  }
  if (!report.ok) {
    throw new Error(`Codex native runtime boundary check failed: ${JSON.stringify(report)}`)
  }
  return report
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  console.log(JSON.stringify(verifyCodexNativeRuntimeBoundaries()))
}
