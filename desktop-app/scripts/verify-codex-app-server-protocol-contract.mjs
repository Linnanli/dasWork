import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runtime validation makes JSDoc return annotations redundant in this executable verifier. */

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultCoreRoot = resolve(desktopRoot, 'vendors/codex-app-server-client')

function fail(message) {
  throw new Error(`Codex app-server protocol contract failed: ${message}`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function walkFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(root, entry.name)
      return entry.isDirectory() ? walkFiles(path) : [path]
    })
}

export function hashProtocolTree(root) {
  if (!existsSync(root)) fail(`generated protocol tree is missing at ${root}`)

  const hash = createHash('sha256')
  for (const path of walkFiles(root)) {
    hash.update(relative(root, path).replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function fileHashes(root) {
  return new Map(
    walkFiles(root).map((path) => [
      relative(root, path).replaceAll('\\', '/'),
      createHash('sha256').update(readFileSync(path)).digest('hex')
    ])
  )
}

export function diffProtocolTrees(expectedRoot, actualRoot) {
  const expected = fileHashes(expectedRoot)
  const actual = fileHashes(actualRoot)
  const paths = new Set([...expected.keys(), ...actual.keys()])
  return [...paths].sort().filter((path) => expected.get(path) !== actual.get(path))
}

function readPinnedCodexVersion(desktopPackage, desktopLock) {
  const packageVersion = desktopPackage.devDependencies?.['@openai/codex']
  const lockVersion = desktopLock.packages?.['node_modules/@openai/codex']?.version
  if (
    typeof packageVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(packageVersion)
  ) {
    fail('desktop package.json must pin @openai/codex to an exact version')
  }
  if (lockVersion !== packageVersion) {
    fail(
      `desktop lockfile version ${String(lockVersion)} does not match package.json ${packageVersion}`
    )
  }
  return packageVersion
}

function resolveCodexCommand(root) {
  const executable = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  const path = resolve(root, 'node_modules', '.bin', executable)
  if (!existsSync(path)) fail(`pinned Codex executable is missing at ${path}`)
  return realpathSync(path)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(`${basename(command)} ${args.join(' ')} exited ${String(result.status)}: ${result.stderr}`)
  }
  return result.stdout
}

function verifyRuntimeEvidence(manifest, command) {
  const source = manifest.runtimeVersionSource
  const parser = manifest.runtimeVersionParser
  const evidence = manifest.runtimeVersionEvidence
  if (source?.category !== 'launch-probe' || source.sameExecutable !== true) {
    fail('runtimeVersionSource must be a same-executable launch probe')
  }
  if (!Array.isArray(source.command) || source.command.length === 0) {
    fail('runtimeVersionSource command is missing')
  }
  if (typeof parser?.pattern !== 'string' || typeof parser.capture !== 'string') {
    fail('runtimeVersionParser is incomplete')
  }
  const stdout = run(command, source.command)
  const outputHash = createHash('sha256').update(stdout).digest('hex')
  if (outputHash !== evidence?.commandOutputSha256) {
    fail('runtime version probe evidence hash differs from protocol manifest')
  }
  const match = new RegExp(parser.pattern, 'u').exec(stdout)
  const actualVersion = match?.groups?.[parser.capture]
  if (!actualVersion) fail('runtime version probe output is not parseable')
  if (!manifest.supportedAppServerVersions?.includes(actualVersion)) {
    fail(`runtime version ${actualVersion} is not in supportedAppServerVersions`)
  }
  return actualVersion
}

export function verifyProtocolContract({ coreRoot = defaultCoreRoot, regenerate = true } = {}) {
  const manifestPath = resolve(coreRoot, 'protocol-manifest.json')
  const manifest = readJson(manifestPath)
  const desktopPackage = readJson(resolve(desktopRoot, 'package.json'))
  const desktopLock = readJson(resolve(desktopRoot, 'package-lock.json'))
  const pinnedVersion = readPinnedCodexVersion(desktopPackage, desktopLock)
  if (manifest.schemaGenerator?.package !== '@openai/codex') {
    fail('protocol manifest schema generator must be @openai/codex')
  }
  if (manifest.schemaGenerator.version !== pinnedVersion) {
    fail(
      `protocol generator ${manifest.schemaGenerator.version} does not match pinned ${pinnedVersion}`
    )
  }
  if (
    !Array.isArray(manifest.initialize?.requiredMethods) ||
    manifest.initialize.requiredMethods.length === 0
  ) {
    fail('protocol manifest must declare required initialize methods')
  }

  const committedTree = resolve(coreRoot, manifest.generatedTree?.root ?? '')
  const committedHash = hashProtocolTree(committedTree)
  if (committedHash !== manifest.generatedTree?.sha256) {
    fail('committed generated tree hash differs from protocol manifest')
  }

  const command = resolveCodexCommand(desktopRoot)
  const runtimeVersion = verifyRuntimeEvidence(manifest, command)
  let generatedTreeHash
  if (regenerate) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dascowork-codex-protocol-'))
    try {
      const generatedTree = resolve(tempRoot, 'generated')
      run(command, [...manifest.schemaGenerator.command, '-o', generatedTree], { cwd: coreRoot })
      const differences = diffProtocolTrees(committedTree, generatedTree)
      if (differences.length > 0) {
        fail(`temporary regenerated tree differs (${differences.slice(0, 8).join(', ')})`)
      }
      generatedTreeHash = hashProtocolTree(generatedTree)
      if (generatedTreeHash !== committedHash) fail('temporary regenerated tree hash differs')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }

  return {
    ok: true,
    pinnedVersion,
    runtimeVersion,
    committedTreeHash: committedHash,
    ...(generatedTreeHash ? { generatedTreeHash } : {})
  }
}

function main() {
  const regenerate = !process.argv.includes('--skip-regenerate')
  const result = verifyProtocolContract({ regenerate })
  console.log(JSON.stringify(result))
}

if (resolve(process.argv[1] ?? '') === scriptPath) main()
