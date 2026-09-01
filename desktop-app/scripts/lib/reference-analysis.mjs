/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { createRequire } from 'node:module'
import {
  basename,
  delimiter,
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep
} from 'node:path'
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const DatabaseSync = loadDatabaseSync()
const ts = require('typescript')

export const referenceIndexSchemaVersion = 2
export const referenceIndexDirectoryName = 'reference-index'
export const rawMirrorDirectoryName = 'raw'
export const maxQueryCandidates = 8
export const maxContextCandidates = 3

const searchableExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.map',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
])
const scriptExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const structuredTextExtensions = new Set(['.css', '.html', '.json', '.md', '.txt', '.yaml', '.yml'])
const resolutionExtensions = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css']
const commonIdentifiers = new Set([
  'arguments',
  'boolean',
  'constructor',
  'default',
  'document',
  'element',
  'exports',
  'function',
  'globalThis',
  'import',
  'module',
  'number',
  'object',
  'prototype',
  'require',
  'return',
  'string',
  'undefined',
  'window'
])
const searchStopWords = new Set([
  'and',
  'are',
  'but',
  'const',
  'else',
  'for',
  'from',
  'function',
  'import',
  'into',
  'let',
  'null',
  'return',
  'that',
  'the',
  'this',
  'true',
  'undefined',
  'var',
  'with'
])
const rendererLocaleCodes = new Set([
  'am',
  'ar',
  'bg-BG',
  'bn-BD',
  'bs-BA',
  'ca-ES',
  'cs-CZ',
  'da-DK',
  'de-DE',
  'el-GR',
  'es-419',
  'es-ES',
  'et-EE',
  'fa',
  'fi-FI',
  'fr-CA',
  'fr-FR',
  'gu-IN',
  'hi-IN',
  'hr-HR',
  'hu-HU',
  'hy-AM',
  'id-ID',
  'is-IS',
  'it-IT',
  'ja-JP',
  'ka-GE',
  'kk',
  'kn-IN',
  'ko-KR',
  'lt',
  'lv-LV',
  'mk-MK',
  'ml',
  'mn',
  'mr-IN',
  'ms-MY',
  'my-MM',
  'nb-NO',
  'nl-NL',
  'pa',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ro-RO',
  'ru-RU',
  'sk-SK',
  'sl-SI',
  'so-SO',
  'sq-AL',
  'sr-RS',
  'sv-SE',
  'sw-TZ',
  'ta-IN',
  'te-IN',
  'th-TH',
  'tl',
  'tr-TR',
  'uk-UA',
  'ur',
  'vi-VN',
  'zh-CN',
  'zh-HK',
  'zh-TW'
])

export function preserveRawAnalysisSources(referenceRoot, { force = false } = {}) {
  const root = assertReferenceRoot(referenceRoot)
  const rawRoot = join(root, '_analysis', rawMirrorDirectoryName)

  if (existsSync(rawRoot)) {
    if (!force) return summarizeRawMirror(root, rawRoot)
    rmSync(rawRoot, { force: true, recursive: true })
  }

  mkdirSync(rawRoot, { recursive: true })
  for (const relativePath of collectSearchableFiles(root)) {
    const destination = join(rawRoot, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(root, relativePath), destination)
  }

  const summary = summarizeRawMirror(root, rawRoot)
  writeFileSync(
    join(rawRoot, 'provenance.json'),
    `${JSON.stringify(
      {
        schemaVersion: referenceIndexSchemaVersion,
        purpose: 'Exact pre-format source mirror for line and column provenance',
        ...summary
      },
      null,
      2
    )}\n`
  )
  return summary
}

export function buildReferenceIndex(referenceRoot) {
  const root = assertReferenceRoot(referenceRoot)
  const analysisRoot = join(root, '_analysis')
  const indexRoot = join(analysisRoot, referenceIndexDirectoryName)
  const rawRoot = join(analysisRoot, rawMirrorDirectoryName)
  const hasRawMirror = existsSync(rawRoot)

  rmSync(indexRoot, { force: true, recursive: true })
  mkdirSync(indexRoot, { recursive: true })

  const relativePaths = collectSearchableFiles(root)
  const fileSet = new Set(relativePaths)
  const fileWriter = new JsonlWriter(join(indexRoot, 'files.jsonl'))
  const importWriter = new JsonlWriter(join(indexRoot, 'imports.jsonl'))
  const searchIndex = createSearchIndex(join(indexRoot, 'search.sqlite'))
  const fileRecords = []
  let importCount = 0
  let signalCount = 0
  let indexedSignalCount = 0
  let rawFileCount = 0
  let buildSucceeded = false

  try {
    searchIndex.database.exec('BEGIN')
    for (const relativePath of relativePaths) {
      const searchRecords = new Map()
      const readablePath = join(root, relativePath)
      const rawPath = join(rawRoot, relativePath)
      const readableText = readFileSync(readablePath, 'utf8')
      const rawAvailable = hasRawMirror && existsSync(rawPath)
      const rawText = rawAvailable ? readFileSync(rawPath, 'utf8') : readableText
      const readableAnalysis = analyzeText(relativePath, readableText)
      const rawAnalysis = rawAvailable ? analyzeText(relativePath, rawText) : readableAnalysis
      const readableHash = sha256Buffer(readableText)
      const rawHash = rawAvailable ? sha256Buffer(rawText) : readableHash
      const sourceMappingUrl = findSourceMappingUrl(readableText)

      if (rawAvailable) rawFileCount += 1
      const fileRecord = {
        path: relativePath,
        layer: classifyLayer(relativePath),
        extension: extname(relativePath).toLowerCase(),
        readable: {
          bytes: Buffer.byteLength(readableText),
          lines: countLines(readableText),
          sha256: readableHash
        },
        raw: {
          available: rawAvailable,
          path: rawAvailable ? toPosix(relative(root, rawPath)) : relativePath,
          bytes: Buffer.byteLength(rawText),
          lines: countLines(rawText),
          sha256: rawHash
        },
        sourceMappingUrl,
        sourceMapPath: sourceMappingUrl
          ? resolveImportPath(relativePath, sourceMappingUrl, fileSet)
          : null
      }
      fileRecords.push(fileRecord)
      fileWriter.write(fileRecord)
      collectSearchRecord(searchRecords, {
        path: relativePath,
        kind: 'path',
        value: relativePath,
        readable: { locations: [], occurrences: 1 },
        raw: { locations: [], occurrences: 1 },
        rawAvailable
      })

      for (const record of mergeAnalysisMaps(
        readableAnalysis.imports,
        rawAnalysis.imports,
        ({ key, readable, raw }) => {
          const [kind, source] = splitKey(key)
          return {
            path: relativePath,
            kind,
            source,
            resolvedPath: resolveImportPath(relativePath, source, fileSet),
            readable,
            raw,
            rawAvailable
          }
        }
      )) {
        importWriter.write(record)
        collectSearchRecord(searchRecords, { ...record, kind: 'import', value: record.source })
        importCount += 1
      }

      for (const record of mergeAnalysisMaps(
        readableAnalysis.signals,
        rawAnalysis.signals,
        ({ key, readable, raw }) => {
          const [kind, value] = splitKey(key)
          return { path: relativePath, kind, value, readable, raw, rawAvailable }
        }
      )) {
        signalCount += 1
        if (!isRendererLocaleAsset(relativePath)) {
          collectSearchRecord(searchRecords, record)
          indexedSignalCount += 1
        }
      }
      flushSearchRecords(searchIndex.insert, searchRecords)
    }
    searchIndex.database.exec('COMMIT')
    buildSucceeded = true
  } finally {
    if (!buildSucceeded) {
      try {
        searchIndex.database.exec('ROLLBACK')
      } catch {
        // The database may have failed before BEGIN completed.
      }
    }
    fileWriter.close()
    importWriter.close()
    searchIndex.database.close()
  }

  const entries = discoverEntrypoints(root, fileSet)
  writeFileSync(join(indexRoot, 'entries.json'), `${JSON.stringify(entries, null, 2)}\n`)

  const sourceManifest = readJsonIfPresent(join(analysisRoot, 'manifest.json'))
  const searchDatabase = new DatabaseSync(join(indexRoot, 'search.sqlite'), { readOnly: true })
  const searchTermHits = Number(
    searchDatabase.prepare('SELECT COUNT(*) AS count FROM term_hits').get().count
  )
  searchDatabase.close()
  const sourceMode = sourceModeFor(rawFileCount, fileRecords.length, sourceManifest)
  const manifest = {
    schemaVersion: referenceIndexSchemaVersion,
    sourceFingerprint:
      sourceManifest?.source?.asarSha256 ??
      sha256Buffer(fileRecords.map((file) => file.readable.sha256).join('\n')),
    sourceVersion: sourceManifest?.source?.appVersion ?? null,
    sourceMode,
    guarantees: {
      readableFilesAreNeverRewritten: true,
      rawLocationsUsePreFormatSourceWhenAvailable:
        rawFileCount > 0 || sourceManifest?.reconstruction?.formatted === false,
      completeInventoryIsHashCheckedBeforeQuery: true,
      derivedSlicesCopyReadableBytesExactly: true
    },
    counts: {
      files: fileRecords.length,
      filesWithRawMirror: rawFileCount,
      sourceMaps: fileRecords.filter((file) => file.extension === '.map').length,
      imports: importCount,
      signals: signalCount,
      indexedSignals: indexedSignalCount,
      localeSignalsRoutedToFallback: signalCount - indexedSignalCount,
      searchTermHits,
      entrypoints: entries.length
    },
    files: {
      entries: 'entries.json',
      files: 'files.jsonl',
      imports: 'imports.jsonl',
      searchDatabase: 'search.sqlite'
    }
  }
  writeFileSync(join(indexRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(indexRoot, 'USAGE.md'), createIndexUsage(manifest))

  return { indexRoot, ...manifest }
}

export async function queryReferenceIndex(
  referenceRoot,
  { terms, limit = 8, contextLines = null } = {}
) {
  const root = assertReferenceRoot(referenceRoot)
  const indexRoot = join(root, '_analysis', referenceIndexDirectoryName)
  const manifest = readRequiredJson(join(indexRoot, 'manifest.json'))
  const normalizedTerms = normalizeTerms(terms)
  if (normalizedTerms.length === 0)
    throw new Error('At least one non-empty query term is required.')
  if (!Number.isInteger(limit) || limit < 1 || limit > maxQueryCandidates) {
    throw new Error(`Query limit must be an integer between 1 and ${maxQueryCandidates}.`)
  }
  if (
    contextLines !== null &&
    (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 3)
  ) {
    throw new Error('Context lines must be an integer between 0 and 3.')
  }
  if (contextLines !== null && limit > maxContextCandidates) {
    throw new Error(`Source context may include at most ${maxContextCandidates} candidate windows.`)
  }

  const files = await loadJsonlMap(join(indexRoot, 'files.jsonl'), (record) => record.path)
  verifyIndexedInventory(root, files, { verifyHashes: true })
  const candidates = new Map()
  for (const file of files.values()) {
    const pathMatches = scoreValue(file.path, normalizedTerms)
    if (pathMatches.score > 0)
      addCandidateEvidence(candidates, file.path, pathMatches, 'path', null)
  }

  const searchDatabasePath = join(indexRoot, 'search.sqlite')
  if (!existsSync(searchDatabasePath)) {
    throw new Error(
      `Required analysis file is missing: ${searchDatabasePath}. Rebuild the reference index.`
    )
  }
  const searchDatabase = new DatabaseSync(searchDatabasePath, { readOnly: true })
  try {
    const selectHits = searchDatabase.prepare(
      `SELECT term, path, kind, value, readable, raw, raw_available AS rawAvailable, weight
       FROM term_hits
       WHERE term = ?
       ORDER BY weight DESC, path`
    )
    const queryTokens = createQueryTokenMap(normalizedTerms)
    for (const [token, originalTerms] of queryTokens) {
      for (const row of selectHits.all(token)) {
        const record = decodeSearchRow(row)
        const valueMatches = scoreValue(record.value, originalTerms)
        addCandidateEvidence(
          candidates,
          record.path,
          {
            score: 50 + record.weight + valueMatches.score,
            matchedTerms: originalTerms
          },
          record.kind,
          record
        )
      }
    }
  } finally {
    searchDatabase.close()
  }

  const ranked = [...candidates.values()]
    .map((candidate) => finalizeCandidate(candidate, normalizedTerms))
    .sort(compareCandidates)
    .slice(0, limit)

  for (const candidate of ranked) {
    const file = files.get(candidate.path)
    if (!file) throw new Error(`Index is inconsistent: missing file record for ${candidate.path}`)
    verifyFileRecord(root, file)
    candidate.layer = file.layer
    candidate.sourceMode = file.raw.available
      ? 'raw-mirror'
      : manifest.sourceMode === 'extracted-raw'
        ? 'extracted-raw'
        : 'beautified-fallback'
    if (contextLines !== null)
      candidate.context = readCandidateContext(root, file, candidate, contextLines)
    candidate.sha256 = file.raw.available
      ? { readable: file.readable.sha256, raw: file.raw.sha256 }
      : file.readable.sha256
    candidate.evidence = candidate.evidence.map(compactEvidence)
  }

  return {
    schemaVersion: referenceIndexSchemaVersion,
    referenceRoot: root,
    sourceVersion: manifest.sourceVersion,
    sourceMode: manifest.sourceMode,
    query: { terms: normalizedTerms, limit, contextLines },
    candidates: ranked
  }
}

export async function materializeReferenceSlice(
  referenceRoot,
  {
    name,
    terms = [],
    files: requestedFiles = [],
    limit = 5,
    depth = 1,
    maxFiles = 30,
    buildGraph = false
  } = {}
) {
  const root = assertReferenceRoot(referenceRoot)
  if (!Number.isInteger(depth) || depth < 0 || depth > 3)
    throw new Error('Slice depth must be 0-3.')
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
    throw new Error('Slice maxFiles must be an integer between 1 and 100.')
  }

  const indexRoot = join(root, '_analysis', referenceIndexDirectoryName)
  const fileRecords = await loadJsonlMap(join(indexRoot, 'files.jsonl'), (record) => record.path)
  const seeds = new Set(requestedFiles.map(toPosix))
  let queryResult = null
  if (seeds.size === 0) {
    queryResult = await queryReferenceIndex(root, { terms, limit })
    for (const candidate of queryResult.candidates) seeds.add(candidate.path)
  }
  if (seeds.size === 0) throw new Error('The query produced no slice seed files.')
  for (const path of seeds) {
    if (!fileRecords.has(path)) throw new Error(`Slice seed is not indexed: ${path}`)
  }

  const adjacency = await loadImportAdjacency(join(indexRoot, 'imports.jsonl'))
  const selected = expandFileSet(seeds, adjacency, depth, maxFiles)
  const requestedName = name || normalizeTerms(terms).join('-') || 'reference-slice'
  const safeName = sanitizeSliceName(requestedName) || 'reference-slice'
  const sliceRoot = join(root, '_analysis', 'semantic-slices', safeName)
  rmSync(sliceRoot, { force: true, recursive: true })
  mkdirSync(sliceRoot, { recursive: true })

  const provenance = []
  for (const sourcePath of selected) {
    const file = fileRecords.get(sourcePath)
    if (!file) continue
    verifyFileRecord(root, file)
    const slicePath = slicePathFor(sourcePath)
    const destination = join(sliceRoot, slicePath)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(root, sourcePath), destination)
    provenance.push({
      sourcePath,
      slicePath,
      layer: file.layer,
      readable: file.readable,
      raw: file.raw
    })
  }

  writeFileSync(
    join(sliceRoot, 'provenance.json'),
    `${JSON.stringify(
      {
        schemaVersion: referenceIndexSchemaVersion,
        referenceRoot: root,
        sourceVersion:
          queryResult?.sourceVersion ??
          readRequiredJson(join(indexRoot, 'manifest.json')).sourceVersion,
        query: queryResult?.query ?? null,
        depth,
        maxFiles,
        files: provenance
      },
      null,
      2
    )}\n`
  )
  writeFileSync(
    join(sliceRoot, 'jsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          target: 'ES2022'
        },
        include: ['source/**/*']
      },
      null,
      2
    )}\n`
  )
  writeFileSync(join(sliceRoot, 'package.json'), '{\n  "private": true,\n  "type": "module"\n}\n')
  writeFileSync(join(sliceRoot, '.code-review-graphignore'), '_analysis/**\n')

  let graph = { requested: buildGraph, status: 'not-requested' }
  if (buildGraph) graph = buildSliceGraph(sliceRoot)

  return {
    sliceRoot,
    files: provenance.length,
    seeds: [...seeds],
    graph,
    provenance: join(sliceRoot, 'provenance.json')
  }
}

export async function validateReferenceIndex(referenceRoot, { full = true } = {}) {
  const root = assertReferenceRoot(referenceRoot)
  const indexRoot = join(root, '_analysis', referenceIndexDirectoryName)
  const manifest = readRequiredJson(join(indexRoot, 'manifest.json'))
  if (manifest.schemaVersion !== referenceIndexSchemaVersion) {
    throw new Error(`Unsupported reference index schema: ${manifest.schemaVersion}`)
  }

  const fileRecords = []
  for await (const record of readJsonl(join(indexRoot, 'files.jsonl'))) fileRecords.push(record)
  verifyIndexedInventory(root, new Map(fileRecords.map((record) => [record.path, record])), {
    verifyHashes: false
  })
  const checked = full ? fileRecords : fileRecords.slice(0, Math.min(fileRecords.length, 25))
  for (const record of checked) verifyFileRecord(root, record)

  let locationRecordsChecked = 0
  for await (const record of readJsonl(join(indexRoot, 'imports.jsonl'))) {
    if (locationRecordsChecked >= 100) break
    validateLocations(record.readable)
    validateLocations(record.raw)
    locationRecordsChecked += 1
  }
  const searchDatabasePath = join(indexRoot, 'search.sqlite')
  if (!existsSync(searchDatabasePath))
    throw new Error(`Reference search database is missing: ${searchDatabasePath}`)
  const searchDatabase = new DatabaseSync(searchDatabasePath, { readOnly: true })
  try {
    const integrity = searchDatabase.prepare('PRAGMA integrity_check').get().integrity_check
    if (integrity !== 'ok')
      throw new Error(`Reference search database failed integrity check: ${integrity}`)
    for (const row of searchDatabase
      .prepare('SELECT readable, raw FROM term_hits ORDER BY term, path LIMIT 100')
      .all()) {
      validateLocations(decodeLocationGroup(row.readable))
      validateLocations(decodeLocationGroup(row.raw))
      locationRecordsChecked += 1
    }
  } finally {
    searchDatabase.close()
  }

  return {
    valid: true,
    sourceMode: manifest.sourceMode,
    filesChecked: checked.length,
    totalFiles: fileRecords.length,
    locationRecordsChecked
  }
}

export function findLatestReferenceProject(repoRoot) {
  const referenceProjectsRoot = join(resolve(repoRoot), 'reference-projects')
  if (!existsSync(referenceProjectsRoot))
    throw new Error(`Reference projects directory not found: ${referenceProjectsRoot}`)
  const candidates = readdirSync(referenceProjectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^codex-electron-.+-beautified$/u.test(entry.name))
    .map((entry) => join(referenceProjectsRoot, entry.name))
    .filter((path) => existsSync(join(path, '_analysis', 'manifest.json')))
    .sort((left, right) => compareVersionPaths(right, left))
  if (candidates.length === 0)
    throw new Error(
      `No extracted ChatGPT Electron reference project found in ${referenceProjectsRoot}`
    )
  return candidates[0]
}

function assertReferenceRoot(referenceRoot) {
  const root = resolve(referenceRoot)
  if (root === resolve('/') || basename(root).length < 3)
    throw new Error(`Unsafe reference root: ${root}`)
  if (!existsSync(root)) throw new Error(`Reference root does not exist: ${root}`)
  if (
    !existsSync(join(root, 'package.json')) &&
    !existsSync(join(root, 'webview')) &&
    !existsSync(join(root, '.vite'))
  ) {
    throw new Error(`Path is not an extracted Electron reference project: ${root}`)
  }
  return root
}

function collectSearchableFiles(root) {
  const files = []
  const excludedDirectories = new Set(['.code-review-graph', '_analysis', 'node_modules'])
  for (const path of walkFiles(root, { excludedDirectories })) {
    if (searchableExtensions.has(extname(path).toLowerCase())) {
      files.push(toPosix(relative(root, path)))
    }
  }
  return [...new Set(files)].sort()
}

function walkFiles(root, { excludedDirectories = new Set() } = {}) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory() && !excludedDirectories.has(entry.name)) pending.push(path)
      if (entry.isFile()) files.push(path)
    }
  }
  return files
}

function analyzeText(relativePath, text) {
  const extension = extname(relativePath).toLowerCase()
  if (scriptExtensions.has(extension) || extension === '.json')
    return analyzeScript(relativePath, text)
  if (structuredTextExtensions.has(extension)) return analyzeStructuredText(relativePath, text)
  return { imports: new Map(), signals: new Map() }
}

function analyzeScript(relativePath, text) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(relativePath)
  )
  const imports = new Map()
  const signals = new Map()

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      addLocatedValue(
        imports,
        'static',
        node.moduleSpecifier.text,
        node.moduleSpecifier,
        sourceFile
      )
    }
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [firstArgument] = node.arguments
      if (ts.isStringLiteralLike(firstArgument)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          addLocatedValue(imports, 'dynamic', firstArgument.text, firstArgument, sourceFile)
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          addLocatedValue(imports, 'require', firstArgument.text, firstArgument, sourceFile)
        }
      }
    }
    if (ts.isStringLiteralLike(node) && shouldIndexSignal(node.text)) {
      addLocatedValue(signals, 'string', node.text, node, sourceFile)
    }
    if (ts.isIdentifier(node) && shouldIndexIdentifier(node.text)) {
      addLocatedValue(signals, 'identifier', node.text, node, sourceFile)
    }
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const value = node.getText(sourceFile)
      if (shouldIndexSignal(value)) addLocatedValue(signals, 'regexp', value, node, sourceFile)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { imports, signals }
}

function analyzeStructuredText(relativePath, text) {
  const imports = new Map()
  const signals = new Map()
  const lineStarts = computeLineStarts(text)
  const extension = extname(relativePath).toLowerCase()

  if (extension === '.html') {
    const sourcePattern = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["'][^>]*>/giu
    for (const match of text.matchAll(sourcePattern)) {
      const source = match[1]
      if (source && !/^(?:data:|https?:|#)/iu.test(source)) {
        addRegexLocation(
          imports,
          'html',
          source,
          text,
          lineStarts,
          (match.index ?? 0) + match[0].indexOf(source)
        )
      }
    }
  }
  if (extension === '.css') {
    const importPattern = /@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?/giu
    for (const match of text.matchAll(importPattern)) {
      const source = match[1]
      if (source)
        addRegexLocation(
          imports,
          'css',
          source,
          text,
          lineStarts,
          (match.index ?? 0) + match[0].indexOf(source)
        )
    }
  }

  const stringPattern = /["']([^"'\r\n]{3,240})["']/gu
  for (const match of text.matchAll(stringPattern)) {
    const value = match[1]
    if (shouldIndexSignal(value)) {
      addRegexLocation(signals, 'text', value, text, lineStarts, (match.index ?? 0) + 1)
    }
  }
  return { imports, signals }
}

function addLocatedValue(target, kind, value, node, sourceFile) {
  const key = `${kind}\u0000${value}`
  const position = node.getStart(sourceFile)
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(position)
  addLocation(target, key, { line: line + 1, column: character + 1, offset: position })
}

function addRegexLocation(target, kind, value, text, lineStarts, offset) {
  const { line, column } = lineColumnFromStarts(lineStarts, offset)
  addLocation(target, `${kind}\u0000${value}`, { line, column, offset })
}

function addLocation(target, key, location) {
  const existing = target.get(key)
  if (!existing) {
    target.set(key, { locations: [location], occurrences: 1 })
    return
  }
  existing.occurrences += 1
  if (existing.locations.length < 6) existing.locations.push(location)
}

function mergeAnalysisMaps(readableMap, rawMap, createRecord) {
  const records = []
  const keys = new Set([...readableMap.keys(), ...rawMap.keys()])
  for (const key of [...keys].sort()) {
    records.push(
      createRecord({
        key,
        readable: normalizeLocationGroup(readableMap.get(key)),
        raw: normalizeLocationGroup(rawMap.get(key))
      })
    )
  }
  return records
}

function normalizeLocationGroup(group) {
  return group ?? { locations: [], occurrences: 0 }
}

function splitKey(key) {
  const separator = key.indexOf('\u0000')
  return [key.slice(0, separator), key.slice(separator + 1)]
}

function createSearchIndex(path) {
  const database = new DatabaseSync(path)
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE term_hits (
      term TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      readable TEXT NOT NULL,
      raw TEXT NOT NULL,
      raw_available INTEGER NOT NULL,
      weight INTEGER NOT NULL,
      PRIMARY KEY (term, path, kind, value)
    ) WITHOUT ROWID;
  `)
  const insert = database.prepare(`
    INSERT INTO term_hits (
      term, path, kind, value, readable, raw, raw_available, weight
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
  return { database, insert }
}

function collectSearchRecord(records, record) {
  const weight = searchKindWeight(record.kind)
  for (const term of createSearchTerms(record.value)) {
    const key = `${term}\u0000${record.kind}`
    const hits = records.get(key) ?? []
    if (hits.some((hit) => hit.value === record.value)) continue
    hits.push({ term, weight, ...record })
    hits.sort(compareSearchRecords)
    records.set(key, hits.slice(0, 3))
  }
}

function flushSearchRecords(insert, records) {
  for (const hits of records.values()) {
    for (const record of hits) {
      insert.run(
        record.term,
        record.path,
        record.kind,
        record.value,
        encodeLocationGroup(record.readable),
        encodeLocationGroup(record.raw),
        record.rawAvailable ? 1 : 0,
        record.weight
      )
    }
  }
}

function compareSearchRecords(left, right) {
  return (
    searchRecordSpecificity(right) - searchRecordSpecificity(left) ||
    left.value.length - right.value.length ||
    (left.readable?.locations?.[0]?.offset ?? Number.MAX_SAFE_INTEGER) -
      (right.readable?.locations?.[0]?.offset ?? Number.MAX_SAFE_INTEGER) ||
    left.value.localeCompare(right.value)
  )
}

function searchRecordSpecificity(record) {
  const normalized = String(record.value).toLowerCase()
  if (normalized === record.term) return 3
  const escapedTerm = escapeRegExp(record.term)
  if (
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapedTerm}(?:$|[^\\p{L}\\p{N}])`, 'u').test(normalized)
  ) {
    return 2
  }
  return 1
}

function loadDatabaseSync() {
  try {
    return require('node:sqlite').DatabaseSync
  } catch (error) {
    throw new Error('Reference analysis requires Node.js 22.5 or newer with node:sqlite support.', {
      cause: error
    })
  }
}

function createSearchTerms(value) {
  const original = String(value).trim()
  const expanded = original.replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
  const tokens = expanded.match(/[\p{L}][\p{L}\p{N}]{1,47}/gu) ?? []
  const normalizedFull = original.toLowerCase()
  const result = []
  if (
    normalizedFull.length >= 2 &&
    normalizedFull.length <= 80 &&
    /^[\p{L}\p{N}_.:/@-]+$/u.test(normalizedFull)
  ) {
    result.push(normalizedFull)
  }
  for (const token of tokens) {
    const normalized = token.toLowerCase()
    if (normalized.length < 2 || searchStopWords.has(normalized)) continue
    result.push(normalized)
    if (result.length >= 16) break
  }
  return [...new Set(result)]
}

function createQueryTokenMap(terms) {
  const result = new Map()
  for (const originalTerm of terms) {
    for (const token of createSearchTerms(originalTerm)) {
      if (!result.has(token)) result.set(token, [])
      result.get(token).push(originalTerm)
    }
  }
  return result
}

function searchKindWeight(kind) {
  switch (kind) {
    case 'import':
      return 12
    case 'string':
      return 10
    case 'identifier':
      return 9
    case 'text':
      return 8
    case 'regexp':
      return 7
    case 'path':
      return 6
    default:
      return 5
  }
}

function encodeLocationGroup(group) {
  return JSON.stringify([
    group?.occurrences ?? 0,
    (group?.locations ?? []).map((location) => [location.line, location.column, location.offset])
  ])
}

function decodeLocationGroup(value) {
  const [occurrences, locations] = JSON.parse(value)
  return {
    occurrences,
    locations: locations.map(([line, column, offset]) => ({ line, column, offset }))
  }
}

function decodeSearchRow(row) {
  return {
    path: row.path,
    kind: row.kind,
    value: row.value,
    readable: decodeLocationGroup(row.readable),
    raw: decodeLocationGroup(row.raw),
    rawAvailable: Boolean(row.rawAvailable),
    weight: Number(row.weight)
  }
}

function shouldIndexSignal(value) {
  const trimmed = value.trim()
  if (trimmed.length < 3 || trimmed.length > 240) return false
  if (/^(?:data:|blob:)/iu.test(trimmed)) return false
  if (/^[A-Za-z0-9+/]{80,}={0,2}$/u.test(trimmed)) return false
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false
  return true
}

function shouldIndexIdentifier(value) {
  if (value.length < 4 || commonIdentifiers.has(value)) return false
  return value.length >= 10 || /[A-Z_]/u.test(value)
}

function scriptKindForPath(path) {
  switch (extname(path).toLowerCase()) {
    case '.json':
      return ts.ScriptKind.JSON
    case '.jsx':
      return ts.ScriptKind.JSX
    case '.ts':
    case '.mts':
      return ts.ScriptKind.TS
    case '.tsx':
      return ts.ScriptKind.TSX
    default:
      return ts.ScriptKind.JS
  }
}

function resolveImportPath(fromPath, source, fileSet) {
  const cleanSource = source.split(/[?#]/u, 1)[0]
  if (!cleanSource || (!cleanSource.startsWith('.') && !cleanSource.startsWith('/'))) return null
  const bases = cleanSource.startsWith('/')
    ? [
        ...(fromPath.startsWith('webview/')
          ? [normalize(join('webview', cleanSource.slice(1)))]
          : []),
        normalize(cleanSource.slice(1))
      ]
    : [normalize(join(dirname(fromPath), cleanSource))]
  for (const base of bases) {
    const normalizedBase = toPosix(base)
    for (const extension of resolutionExtensions) {
      const candidate = `${normalizedBase}${extension}`
      if (fileSet.has(candidate)) return candidate
      const indexCandidate = `${normalizedBase}/index${extension}`
      if (fileSet.has(indexCandidate)) return indexCandidate
    }
  }
  return null
}

function discoverEntrypoints(root, fileSet) {
  const entries = []
  const packageJson = readJsonIfPresent(join(root, 'package.json'))
  if (typeof packageJson?.main === 'string') {
    const path = toPosix(packageJson.main.replace(/^\.\//u, ''))
    entries.push({ kind: 'electron-main', path, exists: fileSet.has(path) })
  }
  for (const htmlPath of [...fileSet].filter((path) => path.endsWith('.html')).sort()) {
    const text = readFileSync(join(root, htmlPath), 'utf8')
    const sourcePattern = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/giu
    for (const match of text.matchAll(sourcePattern)) {
      const source = match[1]
      entries.push({
        kind: 'renderer-script',
        htmlPath,
        source,
        path: resolveImportPath(htmlPath, source, fileSet)
      })
    }
  }
  return entries
}

function classifyLayer(path) {
  if (path.startsWith('.vite/build/')) return 'electron-main-preload'
  if (path.startsWith('webview/assets/')) return 'renderer'
  if (path.startsWith('webview/')) return 'renderer-shell'
  if (path.startsWith('external/')) return 'external'
  if (path.startsWith('native-menu-locales/')) return 'localization'
  return 'package-root'
}

function isRendererLocaleAsset(path) {
  const match = path.match(/^webview\/assets\/([a-z]{2,3}(?:-[A-Z0-9]{2,3})?)-[^/]+\.js$/u)
  return match ? rendererLocaleCodes.has(match[1]) : false
}

function findSourceMappingUrl(text) {
  const match = /[#@]\s*sourceMappingURL=([^\s*]+)/gu.exec(text)
  return match?.[1] ?? null
}

function sourceModeFor(rawFileCount, totalFileCount, sourceManifest) {
  if (rawFileCount > 0 && rawFileCount === totalFileCount) return 'raw-mirror'
  if (rawFileCount > 0) return 'partial-raw-mirror'
  if (sourceManifest?.reconstruction?.formatted === false) return 'extracted-raw'
  return 'beautified-fallback'
}

function countLines(text) {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1
  return lines
}

function computeLineStarts(text) {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1)
  }
  return starts
}

function lineColumnFromStarts(starts, offset) {
  let low = 0
  let high = starts.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle] <= offset) low = middle + 1
    else high = middle
  }
  const lineIndex = Math.max(0, low - 1)
  return { line: lineIndex + 1, column: offset - starts[lineIndex] + 1 }
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path) {
  return sha256Buffer(readFileSync(path))
}

function readJsonIfPresent(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function readRequiredJson(path) {
  if (!existsSync(path))
    throw new Error(`Required analysis file is missing: ${path}. Rebuild the reference index.`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function* readJsonl(path) {
  if (!existsSync(path))
    throw new Error(`Required analysis file is missing: ${path}. Rebuild the reference index.`)
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of lines) if (line.trim()) yield JSON.parse(line)
}

async function loadJsonlMap(path, getKey) {
  const result = new Map()
  for await (const record of readJsonl(path)) result.set(getKey(record), record)
  return result
}

function normalizeTerms(terms = []) {
  return [
    ...new Set(
      (Array.isArray(terms) ? terms : [terms])
        .map((term) => String(term).trim().toLowerCase())
        .filter(Boolean)
    )
  ]
}

function scoreValue(value, terms) {
  const normalized = String(value).toLowerCase()
  const matchedTerms = []
  let score = 0
  for (const term of terms) {
    let termScore = 0
    if (normalized === term) termScore = 50
    else if (
      new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(term)}(?:$|[^\\p{L}\\p{N}])`, 'u').test(
        normalized
      )
    )
      termScore = 35
    else if (normalized.includes(term)) termScore = 20
    if (termScore > 0) {
      matchedTerms.push(term)
      score += termScore
    }
  }
  return { score, matchedTerms }
}

function addCandidateEvidence(candidates, path, matches, kind, record) {
  let candidate = candidates.get(path)
  if (!candidate) {
    candidate = { path, termScores: new Map(), evidence: [], evidenceKeys: new Set() }
    candidates.set(path, candidate)
  }
  for (const term of matches.matchedTerms) {
    candidate.termScores.set(term, Math.max(candidate.termScores.get(term) ?? 0, matches.score))
  }
  const evidenceKey = `${kind}\u0000${record?.value ?? record?.source ?? path}\u0000${record?.readable?.locations?.[0]?.offset ?? -1}`
  if (candidate.evidence.length < 8 && !candidate.evidenceKeys.has(evidenceKey)) {
    candidate.evidenceKeys.add(evidenceKey)
    candidate.evidence.push({
      kind,
      value: record?.value ?? record?.source ?? path,
      readable: record?.readable ?? null,
      raw: record?.raw ?? null,
      rawAvailable: record?.rawAvailable ?? false
    })
  }
}

function compactEvidence(evidence) {
  return {
    kind: evidence.kind,
    value: evidence.value,
    readable: compactLocationGroup(evidence.readable),
    raw: evidence.rawAvailable ? compactLocationGroup(evidence.raw) : null
  }
}

function compactLocationGroup(group) {
  const location = group?.locations?.[0]
  if (!location) return null
  return {
    line: location.line,
    column: location.column,
    occurrences: group.occurrences
  }
}

function finalizeCandidate(candidate, terms) {
  const matchedTerms = [...candidate.termScores.keys()].sort()
  const baseScore = [...candidate.termScores.values()].reduce((sum, score) => sum + score, 0)
  const score =
    baseScore + matchedTerms.length * 25 + (matchedTerms.length === terms.length ? 50 : 0)
  return {
    path: candidate.path,
    score,
    matchedTerms,
    evidence: candidate.evidence.slice(0, 3)
  }
}

function compareCandidates(left, right) {
  return (
    right.score - left.score ||
    right.matchedTerms.length - left.matchedTerms.length ||
    left.path.localeCompare(right.path)
  )
}

function verifyFileRecord(root, file) {
  const readablePath = join(root, file.path)
  if (!existsSync(readablePath) || sha256File(readablePath) !== file.readable.sha256) {
    throw new Error(
      `Reference index is stale for readable source: ${file.path}. Rebuild it before analysis.`
    )
  }
  if (file.raw.available) {
    const rawPath = join(root, file.raw.path)
    if (!existsSync(rawPath) || sha256File(rawPath) !== file.raw.sha256) {
      throw new Error(
        `Reference index is stale for raw source: ${file.raw.path}. Rebuild it before analysis.`
      )
    }
  }
}

function verifyIndexedInventory(root, files, { verifyHashes }) {
  const currentPaths = collectSearchableFiles(root)
  const indexedPaths = [...files.keys()].sort()
  if (
    currentPaths.length !== indexedPaths.length ||
    currentPaths.some((path, index) => path !== indexedPaths[index])
  ) {
    throw new Error(
      'Reference index is stale because the searchable file inventory changed. Rebuild it before analysis.'
    )
  }
  if (verifyHashes) for (const file of files.values()) verifyFileRecord(root, file)
}

function readCandidateContext(root, file, candidate, contextLines) {
  const bestEvidence = candidate.evidence.find(
    (evidence) => evidence.readable?.locations?.length > 0
  )
  if (!bestEvidence) return null
  const readableLocation = bestEvidence.readable.locations[0]
  const rawLocation = bestEvidence.raw?.locations?.[0] ?? readableLocation
  return {
    readable: sourceWindow(join(root, file.path), readableLocation, contextLines),
    raw: file.raw.available
      ? sourceWindow(join(root, file.raw.path), rawLocation, contextLines)
      : { ...sourceWindow(join(root, file.path), rawLocation, contextLines), fallback: true }
  }
}

function sourceWindow(path, location, contextLines) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split(/\r?\n/u)
  const lineIndex = Math.max(0, location.line - 1)
  if (lines[lineIndex]?.length > 2_000) {
    const start = Math.max(0, location.column - 121)
    return {
      line: location.line,
      column: location.column,
      text: lines[lineIndex].slice(start, start + 240),
      columnWindowStart: start + 1,
      truncated: true
    }
  }
  const startLine = Math.max(0, lineIndex - contextLines)
  const endLine = Math.min(lines.length, lineIndex + contextLines + 1)
  return {
    line: location.line,
    column: location.column,
    startLine: startLine + 1,
    text: lines.slice(startLine, endLine).join('\n'),
    truncated: false
  }
}

async function loadImportAdjacency(path) {
  const result = new Map()
  const connect = (left, right) => {
    if (!result.has(left)) result.set(left, new Set())
    result.get(left).add(right)
  }
  for await (const edge of readJsonl(path)) {
    if (!edge.resolvedPath) continue
    connect(edge.path, edge.resolvedPath)
    connect(edge.resolvedPath, edge.path)
  }
  return result
}

function expandFileSet(seeds, adjacency, depth, maxFiles) {
  const selected = new Set()
  let frontier = [...seeds].sort()
  for (let level = 0; level <= depth && frontier.length > 0; level += 1) {
    const next = []
    for (const path of frontier) {
      if (selected.size >= maxFiles) break
      if (selected.has(path)) continue
      selected.add(path)
      for (const neighbor of [...(adjacency.get(path) ?? [])].sort()) {
        if (!selected.has(neighbor)) next.push(neighbor)
      }
    }
    frontier = [...new Set(next)]
  }
  return selected
}

function slicePathFor(path) {
  if (path.startsWith('.vite/build/'))
    return `source/electron-main/${path.slice('.vite/build/'.length)}`
  if (path.startsWith('webview/assets/'))
    return `source/renderer/${path.slice('webview/assets/'.length)}`
  if (path.startsWith('webview/')) return `source/renderer-shell/${path.slice('webview/'.length)}`
  if (path.startsWith('external/')) return `source/external/${path.slice('external/'.length)}`
  if (path.startsWith('native-menu-locales/'))
    return `source/locales/${path.slice('native-menu-locales/'.length)}`
  return `source/root/${path}`
}

function sanitizeSliceName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 80)
}

function buildSliceGraph(sliceRoot) {
  const executable = process.env.PATH?.split(delimiter)
    .map((directory) =>
      join(directory, process.platform === 'win32' ? 'code-review-graph.exe' : 'code-review-graph')
    )
    .find(existsSync)
  if (!executable)
    return {
      requested: true,
      status: 'unavailable',
      reason: 'code-review-graph was not found on PATH'
    }
  const result = spawnSync(executable, ['build', '--repo', sliceRoot], { encoding: 'utf8' })
  return {
    requested: true,
    status: result.status === 0 ? 'built' : 'failed',
    exitCode: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-2_000)
  }
}

function validateLocations(group) {
  if (!group || !Array.isArray(group.locations))
    throw new Error('Index location group is malformed.')
  for (const location of group.locations) {
    if (!Number.isInteger(location.line) || location.line < 1)
      throw new Error('Index contains an invalid line number.')
    if (!Number.isInteger(location.column) || location.column < 1)
      throw new Error('Index contains an invalid column number.')
    if (!Number.isInteger(location.offset) || location.offset < 0)
      throw new Error('Index contains an invalid source offset.')
  }
}

function summarizeRawMirror(root, rawRoot) {
  const files = walkFiles(rawRoot).filter((path) => basename(path) !== 'provenance.json')
  return {
    path: toPosix(relative(root, rawRoot)),
    files: files.length,
    bytes: files.reduce((sum, path) => sum + statSync(path).size, 0)
  }
}

function compareVersionPaths(left, right) {
  const leftVersion = basename(left).match(/^codex-electron-(.+)-beautified$/u)?.[1] ?? ''
  const rightVersion = basename(right).match(/^codex-electron-(.+)-beautified$/u)?.[1] ?? ''
  const leftParts = leftVersion.split('.').map(Number)
  const rightParts = rightVersion.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return leftVersion.localeCompare(rightVersion)
}

function createIndexUsage(manifest) {
  return `# Low-token reference index\n\n- Source mode: \`${manifest.sourceMode}\`\n- Files: ${manifest.counts.files}\n- Imports: ${manifest.counts.imports}\n- Search signals: ${manifest.counts.signals}\n\nThe index only narrows candidates. Confirm behavior against the readable source and, when present, the raw pre-format mirror. Derived slices are never sufficient evidence by themselves.\n`
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

class JsonlWriter {
  constructor(path) {
    this.descriptor = openSync(path, 'w')
    this.buffer = ''
  }

  write(value) {
    this.buffer += `${JSON.stringify(value)}\n`
    if (this.buffer.length >= 1024 * 1024) this.flush()
  }

  flush() {
    if (!this.buffer) return
    writeSync(this.descriptor, this.buffer)
    this.buffer = ''
  }

  close() {
    this.flush()
    closeSync(this.descriptor)
  }
}
