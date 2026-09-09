import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runtime validation makes JSDoc return annotations redundant in this executable verifier. */

import { AppServerClient, StdioTransport } from '@dascowork/codex-app-server-client'

import protocolManifest from '../vendors/codex-app-server-client/protocol-manifest.json' with { type: 'json' }

const scriptPath = fileURLToPath(import.meta.url)
const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REQUEST_TIMEOUT_MS = 15_000

function fail(message) {
  throw new Error(`Real Codex app-server contract smoke failed: ${message}`)
}

function resolvePinnedCodexExecutable(root) {
  const executable = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  const path = resolve(root, 'node_modules', '.bin', executable)
  if (!existsSync(path)) fail('the pinned Codex executable is missing')
  return realpathSync(path)
}

function requireModelList(response) {
  if (!response || !Array.isArray(response.data)) {
    fail('model/list did not return a typed model catalog')
  }
  return response.data.length
}

function requireThreadId(response) {
  const threadId = response?.thread?.id
  if (typeof threadId !== 'string' || threadId.length === 0) {
    fail('thread/start did not return a thread id')
  }
  return threadId
}

/**
 * Exercises the locked executable through the core transport, not a test
 * double. This credential-free layer proves initialize, catalog, and thread
 * creation; release-LLM E2E owns the real turn/stream/tool/recovery contract.
 */
export async function verifyRealCodexAppServerContract({
  root = desktopRoot,
  command = resolvePinnedCodexExecutable(root),
  createClient
} = {}) {
  const isolatedCodexHome = mkdtempSync(join(tmpdir(), 'dascowork-codex-contract-'))
  const clientFactory =
    createClient ??
    ((settings) =>
      new AppServerClient(
        new StdioTransport({
          command,
          args: ['app-server', '--listen', 'stdio://'],
          cwd: root,
          env: { ...process.env, CODEX_HOME: isolatedCodexHome }
        }),
        settings
      ))
  const client = clientFactory({ requestTimeoutMs: REQUEST_TIMEOUT_MS })
  let connected = false

  try {
    await client.connect()
    connected = true
    await client.request('initialize', {
      clientInfo: protocolManifest.initialize.clientInfo,
      capabilities: protocolManifest.initialize.capabilities
    })
    await client.notification('initialized')

    const modelList = await client.request('model/list', { includeHidden: false })
    const modelCount = requireModelList(modelList)
    const thread = await client.request('thread/start', { cwd: root, ephemeral: true })
    const threadId = requireThreadId(thread)

    return { ok: true, modelCount, threadId }
  } finally {
    if (connected) await client.disconnect()
    rmSync(isolatedCodexHome, { recursive: true, force: true })
  }
}

async function main() {
  try {
    console.log(JSON.stringify(await verifyRealCodexAppServerContract()))
  } catch {
    // The app-server may include environment/configuration details in its own
    // errors. Keep CI output renderer-safe and credential-safe.
    console.error('Real Codex app-server contract smoke failed.')
    process.exitCode = 1
  }
}

if (resolve(process.argv[1] ?? '') === scriptPath) await main()
