/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { resolve } from 'node:path'

import {
  buildReferenceIndex,
  findLatestReferenceProject,
  materializeReferenceSlice,
  queryReferenceIndex,
  validateReferenceIndex
} from './lib/reference-analysis.mjs'

const desktopRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(desktopRoot, '..')
const options = parseArguments(process.argv.slice(2))

if (options.help) {
  printHelp()
  process.exit(0)
}

const referenceRoot = options.root
  ? resolve(repoRoot, options.root)
  : findLatestReferenceProject(repoRoot)

switch (options.command) {
  case 'build':
    printResult(buildReferenceIndex(referenceRoot))
    break
  case 'query':
    printResult(
      await queryReferenceIndex(referenceRoot, {
        terms: options.terms,
        limit: options.limit,
        contextLines: options.contextLines
      })
    )
    break
  case 'slice':
    printResult(
      await materializeReferenceSlice(referenceRoot, {
        name: options.name,
        terms: options.terms,
        files: options.files,
        limit: options.limit,
        depth: options.depth,
        maxFiles: options.maxFiles,
        buildGraph: options.graph
      })
    )
    break
  case 'validate':
    printResult(await validateReferenceIndex(referenceRoot, { full: !options.quick }))
    break
  default:
    throw new Error(`Unknown command: ${options.command}`)
}

function parseArguments(args) {
  const parsed = {
    command: 'query',
    contextLines: null,
    depth: 1,
    files: [],
    graph: false,
    help: false,
    limit: 8,
    maxFiles: 30,
    name: undefined,
    quick: false,
    root: undefined,
    terms: []
  }
  const commands = new Set(['build', 'query', 'slice', 'validate'])
  let index = 0
  if (commands.has(args[0])) {
    parsed.command = args[0]
    index = 1
  }

  for (; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
      continue
    }
    if (argument === '--graph') {
      parsed.graph = true
      continue
    }
    if (argument === '--quick') {
      parsed.quick = true
      continue
    }
    if (
      [
        '--context',
        '--depth',
        '--file',
        '--limit',
        '--max-files',
        '--name',
        '--root',
        '--term'
      ].includes(argument)
    ) {
      const value = args[index + 1]
      if (!value) throw new Error(`${argument} requires a value`)
      switch (argument) {
        case '--context':
          parsed.contextLines = parseInteger(value, argument)
          break
        case '--depth':
          parsed.depth = parseInteger(value, argument)
          break
        case '--file':
          parsed.files.push(value)
          break
        case '--limit':
          parsed.limit = parseInteger(value, argument)
          break
        case '--max-files':
          parsed.maxFiles = parseInteger(value, argument)
          break
        case '--name':
          parsed.name = value
          break
        case '--root':
          parsed.root = value
          break
        case '--term':
          parsed.terms.push(value)
          break
      }
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}`)
  }
  return parsed
}

function parseInteger(value, argument) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || String(parsed) !== value)
    throw new Error(`${argument} requires an integer`)
  return parsed
}

function printResult(value) {
  console.log(JSON.stringify(value, null, 2))
}

function printHelp() {
  console.log(`Usage: npm --prefix desktop-app run reference:chatgpt:<command> -- [options]

Commands:
  build       Build or refresh the low-token index
  query       Return at most 8 ranked source candidates by default
  slice       Copy an exact, small source/import neighborhood for LSP or graph analysis
  validate    Verify indexed files still match their recorded SHA256 values

Common options:
  --root <path>       Reference project (default: newest extracted version)
  --term <value>      Search term; repeat for multiple English anchors
  --limit <count>     Candidate/seed limit (query max/default: 8)
  --context <0-3>     Include bounded readable/raw source context; omitted by default

Slice options:
  --file <path>       Exact indexed seed file; repeatable and overrides query seeds
  --name <value>      Stable slice directory name
  --depth <0-3>       Import-neighborhood depth (default: 1)
  --max-files <count> Hard cap, 1-100 (default: 30)
  --graph              Build code-review-graph inside the bounded slice when available

Validate options:
  --quick             Hash-check only the first 25 indexed files

Examples:
  npm --prefix desktop-app run reference:chatgpt:index -- --root reference-projects/codex-electron-26.818.21641-beautified
  npm --prefix desktop-app run reference:chatgpt:query -- --term approval --term sandbox
  npm --prefix desktop-app run reference:chatgpt:slice -- --term review --term staged --name review --graph`)
}
