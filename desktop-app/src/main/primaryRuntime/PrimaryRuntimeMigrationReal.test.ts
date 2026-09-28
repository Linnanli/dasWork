import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  AppServerClient,
  createCodexContextCatalogClient,
  StdioTransport
} from '@dascowork/codex-app-server-client'
import type { ThreadStartResponse } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/ThreadStartResponse'
import type { TurnCompletedNotification } from '@dascowork/codex-app-server-client/protocol/app-server-protocol/v2/TurnCompletedNotification'
import { describe, expect, it } from 'vitest'

import { assistantMessageResponse, startMockBackend } from '../../../tests/e2e/support/mockBackend'
import {
  DesktopHostCapabilityRuntime,
  type DesktopCapabilitySnapshot
} from '../appTools/DesktopHostCapabilityRuntime'
import {
  BundledPluginManager,
  type BundledPluginCatalogClient
} from '../bundledPlugins/BundledPluginManager'
import {
  readInstalledPrimaryRuntimePluginCatalog,
  readPrimaryRuntimeBundledPluginDescriptors,
  readRetiredPrimaryRuntimeBundledPluginDescriptors
} from '../bundledPlugins/BundledPluginDescriptors'
import { RuntimeOwnedSkillManager } from '../bundledPlugins/RuntimeOwnedSkillManager'
import { PrimaryRuntimeActivePointer } from './PrimaryRuntimeActivePointer'
import { PrimaryRuntimeHttpClient } from './PrimaryRuntimeHttpClient'
import { PrimaryRuntimeLocator } from './PrimaryRuntimeLocator'
import {
  canonicalPrimaryRuntimeReleaseManifestPayload,
  FilePrimaryRuntimeManifestSequenceStore
} from './PrimaryRuntimeReleaseManifest'
import { SignedPrimaryRuntimeReleaseProvider } from './PrimaryRuntimeReleaseProvider'
import { PrimaryRuntimePostInstallError } from './PrimaryRuntimePostInstallError'
import { PrimaryRuntimeService } from './PrimaryRuntimeService'
import { PrimaryRuntimeTlsPolicy } from './PrimaryRuntimeTlsPolicy'
import { FilePrimaryRuntimeTrustStateStore } from './PrimaryRuntimeTrustStateStore'

type Options = Record<
  | 'target'
  | 'v2-archive'
  | 'v2-version'
  | 'v2-sha256'
  | 'v2-provenance'
  | 'v3-archive'
  | 'v3-version'
  | 'v3-sha256'
  | 'v3-provenance'
  | 'output',
  string
> & { 'retain-cache'?: string }
type Version = 'v2' | 'v3'
type Fault = 'none' | 'sync_skills' | 'reload_skills' | 'retire_plugin'
const enabled = process.env.DASCOWORK_PRIMARY_RUNTIME_MIGRATION === '1'
const timeout = 30 * 60_000

describe.skipIf(!enabled)('native signed-Feed Runtime migration', () => {
  it(
    'restores pointer, managed skills and real app-server plugins across the migration matrix',
    async () => {
      const options = JSON.parse(
        process.env.DASCOWORK_PRIMARY_RUNTIME_MIGRATION_OPTIONS!
      ) as Options
      expect(options.target).toBe(`${process.platform}-${process.arch}`)
      // Retained v2 previews include LibreOffice's deeply nested Python files.
      // Match the desktop E2E fixture's short Windows runner temp root.
      const tempRoot = process.env.RUNNER_TEMP?.trim() || tmpdir()
      const root = await realpath(await mkdtemp(join(tempRoot, 'dsc-mig-')))
      const cacheRoot = join(root, 'cache')
      const codexHome = join(root, 'codex-home')
      const workspace = join(root, 'workspace')
      await mkdir(workspace, { recursive: true })
      await mkdir(codexHome, { recursive: true })
      const backend = await startMockBackend({
        responses: Array.from({ length: 64 }, (_, i) =>
          assistantMessageResponse(
            `migration-response-${i}`,
            `migration-message-${i}`,
            `migration chat ${i} completed`
          )
        )
      })
      const archives = {
        v2: {
          path: options['v2-archive'],
          version: options['v2-version'],
          sha256: options['v2-sha256'],
          size: (await stat(options['v2-archive'])).size
        },
        v3: {
          path: options['v3-archive'],
          version: options['v3-version'],
          sha256: options['v3-sha256'],
          size: (await stat(options['v3-archive'])).size
        }
      }
      const key = generateKeyPairSync('ed25519')
      let selected: Version = 'v2'
      let sequence = 1
      let feedOffline = false
      let interruptDownload = false
      let archiveRequests = 0
      const receipt: unknown[] = []
      const reloads: unknown[] = []
      let lastPluginCatalog: unknown
      let service: PrimaryRuntimeService | undefined
      let client: AppServerClient | undefined
      let fault: Fault = 'none'
      let origin = ''
      let succeeded = false
      let phase = 'start-feed'
      const issuedAt = new Date(Date.now() - 1000).toISOString()
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
      const feed = createServer(
        {
          key: await readFile(process.env.DASCOWORK_PRIMARY_RUNTIME_MIGRATION_KEY!),
          cert: await readFile(process.env.DASCOWORK_PRIMARY_RUNTIME_MIGRATION_CERT!)
        },
        (request, response) => {
          if (feedOffline) {
            response.writeHead(503)
            response.end('offline fault injection')
            return
          }
          if (request.url === '/manifest.json') {
            const archive = archives[selected]
            const payload = {
              schemaVersion: 1,
              sequence,
              channel: 'migration',
              keyId: 'migration-key',
              issuedAt,
              expiresAt,
              releases: [
                {
                  platform: process.platform,
                  arch: process.arch,
                  version: archive.version,
                  archiveFormat: 'zip',
                  archiveUrl: `${origin}/${selected}.zip`,
                  archiveSizeBytes: archive.size,
                  archiveSha256: archive.sha256,
                  budget: {
                    maxArchiveBytes: archive.size,
                    maxUnpackedBytes: 8 * 1024 ** 3,
                    minimumFreeDiskBytes: 1,
                    maxColdInstallMs: timeout,
                    maxMainEventLoopDelayP99Ms: 60_000,
                    maxMainEventLoopDelayMaxMs: 60_000
                  }
                }
              ]
            }
            const signature = sign(
              null,
              Buffer.from(canonicalPrimaryRuntimeReleaseManifestPayload(payload)),
              key.privateKey
            ).toString('base64')
            response.setHeader('content-type', 'application/json')
            response.end(JSON.stringify({ ...payload, signature }))
            return
          }
          const version =
            request.url === '/v2.zip' ? 'v2' : request.url === '/v3.zip' ? 'v3' : undefined
          if (!version) {
            response.writeHead(404)
            response.end()
            return
          }
          archiveRequests += 1
          response.setHeader('content-length', archives[version].size)
          if (interruptDownload) {
            response.write(Buffer.alloc(1024))
            void service?.cancelInstall().finally(() => response.destroy())
            return
          }
          const stream = createReadStream(archives[version].path)
          response.once('close', () => stream.destroy())
          stream.on('error', () => response.destroy())
          stream.pipe(response)
        }
      )

      try {
        feed.listen(0, '127.0.0.1')
        await once(feed, 'listening')
        const address = feed.address()
        if (!address || typeof address === 'string')
          throw new Error('Migration HTTPS feed has no port.')
        origin = `https://127.0.0.1:${address.port}`
        const tls = await PrimaryRuntimeTlsPolicy.create({
          production: false,
          localTestCaPath: process.env.DASCOWORK_PRIMARY_RUNTIME_MIGRATION_CA!,
          allowedOrigins: [origin]
        })
        const httpClient = new PrimaryRuntimeHttpClient({
          allowedOrigins: [origin],
          fetchImpl: tls!.fetchImpl
        })
        const provider = new SignedPrimaryRuntimeReleaseProvider({
          manifestUrl: `${origin}/manifest.json`,
          allowedOrigins: [origin],
          channel: 'migration',
          publicKeys: { 'migration-key': key.publicKey },
          sequenceStore: new FilePrimaryRuntimeManifestSequenceStore(join(root, 'sequence.json')),
          trustState: new FilePrimaryRuntimeTrustStateStore(join(root, 'trust.json')),
          httpClient
        })
        const startAppServer = async (): Promise<BundledPluginCatalogClient> => {
          // Launch the lockfile-installed CLI entry point directly on every OS.
          // An absolute codex.cmd cannot be spawned without a Windows shell.
          const cliEntryPoint = resolve('node_modules', '@openai', 'codex', 'bin', 'codex.js')
          expect((await stat(cliEntryPoint)).isFile()).toBe(true)
          const appServerEnvironment = {
            ...process.env,
            CODEX_HOME: codexHome,
            NO_PROXY: '127.0.0.1,localhost,::1',
            no_proxy: '127.0.0.1,localhost,::1'
          }
          // This fixture's provider is an in-process loopback server. A host
          // proxy must not route its requests outside the test process.
          for (const name of Object.keys(appServerEnvironment)) {
            if (/^(http|https|all)_proxy$/iu.test(name)) {
              Reflect.deleteProperty(appServerEnvironment, name)
            }
          }
          client = new AppServerClient(
            new StdioTransport({
              command: process.execPath,
              args: [
                cliEntryPoint,
                '-c',
                'features.respect_system_proxy=false',
                'app-server',
                '--listen',
                'stdio://'
              ],
              cwd: workspace,
              env: appServerEnvironment
            }),
            { requestTimeoutMs: 60_000 }
          )
          await client.connect()
          await client.request('initialize', {
            clientInfo: { name: 'dascowork_runtime_migration', version: '1.0.0' },
            capabilities: { experimentalApi: true }
          })
          await client.notification('initialized')
          const catalog = createCodexContextCatalogClient({
            acquireClient: async () => ({ client: client!, release: async () => undefined })
          })
          return {
            listInstalledPluginsForManagement: async (input) => {
              const installed = await catalog.listInstalledPluginsForManagement(input)
              lastPluginCatalog = { cwd: input?.cwd, installed }
              return installed
            },
            installPlugin: (input) => catalog.installPlugin(input),
            listSkillsForManagement: async (input) => {
              if (fault === 'reload_skills') {
                fault = 'none'
                throw new Error('Injected migration reload failure')
              }
              const result = await catalog.listSkillsForManagement({ cwd: workspace, ...input })
              reloads.push(result)
              return result
            },
            setPluginEnabled: async (input) => {
              const result = await catalog.setPluginEnabled(input)
              if (fault === 'retire_plugin' && !input.enabled) {
                fault = 'none'
                throw new Error('Injected failure after real plugin disable')
              }
              return result
            }
          }
        }
        phase = 'start-app-server'
        let catalog = await startAppServer()
        const createService = (): PrimaryRuntimeService =>
          new PrimaryRuntimeService({
            cacheRoot,
            locator: new PrimaryRuntimeLocator({ appCacheRoot: cacheRoot }),
            releaseProvider: provider
          })
        service = createService()
        const capabilities = new DesktopHostCapabilityRuntime({
          workspaceDependencies: {
            diagnoseDependencies: () => service!.diagnoseDependencies(),
            loadDependencies: () => service!.loadDependencies()
          }
        })
        const pointer = new PrimaryRuntimeActivePointer(cacheRoot)
        const reconcile = async (): Promise<void> => {
          phase = `reconcile-${selected}-diagnose`
          const diagnostic = await service!.diagnoseDependencies()
          capabilities.updatePrimaryRuntimeState({ diagnostic, runtimePluginsSynchronized: false })
          const blocked = await capabilities.snapshot()
          if (diagnostic.manifest?.bundleFormatVersion === 3) {
            expect(blocked.availableToolNames).not.toContain('load_workspace_dependencies')
          } else if (diagnostic.status === 'ready') {
            // Legacy v2 keeps its established dependency-loader behavior.
            expect(blocked.availableToolNames).toContain('load_workspace_dependencies')
          }
          phase = `reconcile-${selected}-blocked-chat`
          await chat(blocked)
          phase = `reconcile-${selected}-read-plugins`
          const descriptors = await readPrimaryRuntimeBundledPluginDescriptors(diagnostic)
          const installed = await readInstalledPrimaryRuntimePluginCatalog({
            cacheRoot,
            listInstalledPluginsForManagement: (input) =>
              catalog.listInstalledPluginsForManagement(input)
          })
          const retiredDescriptors = await readRetiredPrimaryRuntimeBundledPluginDescriptors({
            installed,
            cacheRoot,
            activeDescriptors: descriptors
          })
          phase = `reconcile-${selected}-sync-catalog`
          const result = await new BundledPluginManager({
            catalogClient: catalog,
            descriptors,
            retiredDescriptors,
            syncRuntimeSkills: async () => {
              if (fault === 'sync_skills') {
                fault = 'none'
                throw new Error('Injected migration skill sync failure')
              }
              const transaction = await new RuntimeOwnedSkillManager({
                codexHome,
                runtimeRoot: diagnostic.root ?? cacheRoot,
                bundleVersion: diagnostic.manifest?.bundleVersion ?? 'none',
                manifest: diagnostic.manifest ?? { bundledSkills: [] }
              }).reconcileWithRollback()
              return transaction.rollback
            }
          }).reconcile()
          capabilities.updatePrimaryRuntimeState({
            diagnostic,
            runtimePluginsSynchronized: result.status === 'ready'
          })
          if (result.status !== 'ready')
            throw new PrimaryRuntimePostInstallError(
              result.failures[0]!.stage,
              result.failures.map((failure) => failure.message).join('; ')
            )
        }
        service.setPostActivationHook(reconcile)
        const select = (version: Version): void => {
          selected = version
          sequence += 1
        }
        const chat = async (snapshot: DesktopCapabilitySnapshot): Promise<void> => {
          const messages: string[] = []
          let complete: (() => void) | undefined
          let reject: ((error: Error) => void) | undefined
          const completed = new Promise<void>((resolveDone, rejectDone) => {
            complete = resolveDone
            reject = rejectDone
          })
          void completed.catch(() => undefined)
          const offItem = client!.onNotification('item/completed', (value) => {
            const item = (value as { item?: { type?: string; text?: string } }).item
            if (item?.type === 'agentMessage' && item.text) messages.push(item.text)
          })
          const offTurn = client!.onNotification('turn/completed', (value) => {
            const turn = (value as TurnCompletedNotification).turn
            if (turn.status === 'completed') complete!()
            else
              reject!(
                new Error(
                  `Migration chat failed: ${turn.status}: ${turn.error?.message ?? 'no turn error details'}`
                )
              )
          })
          const deadline = setTimeout(() => reject!(new Error('Migration chat timed out')), 60_000)
          try {
            const thread = await client!.request<ThreadStartResponse>('thread/start', {
              cwd: workspace,
              ephemeral: true,
              model: 'qwen3.7-plus',
              modelProvider: 'migration',
              approvalPolicy: 'never',
              sandbox: 'workspace-write',
              dynamicTools: [...snapshot.dynamicTools],
              config: {
                model_provider: 'migration',
                model_providers: {
                  migration: {
                    name: 'migration',
                    base_url: backend.baseUrl,
                    wire_api: 'responses',
                    experimental_bearer_token: 'sk-e2e-test-key',
                    requires_openai_auth: false,
                    supports_websockets: false,
                    request_max_retries: 0,
                    stream_max_retries: 0
                  }
                }
              }
            })
            await client!.request('turn/start', {
              threadId: thread.thread.id,
              input: [
                {
                  type: 'text',
                  text: 'Respond with the migration chat confirmation.',
                  text_elements: []
                }
              ]
            })
            await completed
            expect(messages.some((text) => /migration chat \d+ completed/u.test(text))).toBe(true)
          } finally {
            clearTimeout(deadline)
            offItem()
            offTurn()
          }
        }
        const record = async (
          scenario: string,
          expected: Version
        ): Promise<DesktopCapabilitySnapshot> => {
          phase = `record-${scenario}`
          const diagnostic = await service!.diagnoseDependencies()
          expect(diagnostic.status).toBe('ready')
          expect(diagnostic.manifest!.bundleVersion).toBe(archives[expected].version)
          expect(diagnostic.manifest!.bundleFormatVersion).toBe(expected === 'v2' ? 2 : 3)
          const active = await pointer.read()
          expect(active!.archiveSha256).toBe(archives[expected].sha256)
          const managedRoot = join(codexHome, 'skills', 'dascowork-primary-runtime')
          const marker = JSON.parse(
            await readFile(join(managedRoot, '.dascowork-primary-runtime.json'), 'utf8')
          ) as { bundleVersion: string }
          expect(marker.bundleVersion).toBe(archives[expected].version)
          const names = (await readdir(managedRoot)).filter((name) => !name.startsWith('.')).sort()
          expect(names).toEqual([expected === 'v2' ? 'presentation-skill' : 'officecli'])
          const installed = await readInstalledPrimaryRuntimePluginCatalog({
            cacheRoot,
            listInstalledPluginsForManagement: (input) =>
              catalog.listInstalledPluginsForManagement(input)
          })
          const oldPlugins = installed.marketplaces
            .filter((marketplace) => marketplace.path?.startsWith(cacheRoot))
            .flatMap((marketplace) => marketplace.plugins)
            .filter((plugin) => plugin.name === 'presentation-skill' && plugin.installed)
          expect(oldPlugins.length).toBeGreaterThan(0)
          expect(oldPlugins.every((plugin) => plugin.enabled === (expected === 'v2'))).toBe(true)
          const snapshot = await capabilities.snapshot()
          expect(snapshot.availableToolNames).toContain('load_workspace_dependencies')
          await chat(snapshot)
          receipt.push({
            scenario,
            pointer: active,
            managedSkills: { marker, names },
            plugins: oldPlugins,
            snapshot,
            reloadCount: reloads.length,
            chatCompleted: true
          })
          return snapshot
        }
        phase = 'install-v2-initial'
        const legacyInstall = await service.install()
        const oldSnapshot = await record('v2-initial', 'v2')
        const immutableOldSnapshot = structuredClone(oldSnapshot)

        select('v3')
        interruptDownload = true
        phase = 'interrupt-v3-download'
        await expect(service.install()).rejects.toThrow()
        interruptDownload = false
        await record('interrupted-v3-download', 'v2')
        feedOffline = true
        phase = 'feed-unavailable'
        await expect(service.install()).rejects.toThrow('503')
        feedOffline = false
        await record('feed-unavailable', 'v2')

        for (const injected of ['sync_skills', 'reload_skills', 'retire_plugin'] as const) {
          fault = injected
          phase = `inject-${injected}`
          await expect(service.install()).rejects.toThrow()
          await record(`failed-v2-to-v3-${injected}`, 'v2')
          expect(oldSnapshot).toEqual(immutableOldSnapshot)
        }
        phase = 'install-v3'
        await service.install()
        await record('v2-to-v3', 'v3')
        // A fresh app-server has no in-process descriptor history. Re-enable the
        // retained old plugin to prove startup retirement uses installed ownership.
        const installed = await readInstalledPrimaryRuntimePluginCatalog({
          cacheRoot,
          listInstalledPluginsForManagement: (input) =>
            catalog.listInstalledPluginsForManagement(input)
        })
        const old = installed.marketplaces
          .flatMap((marketplace) => marketplace.plugins)
          .find((plugin) => plugin.name === 'presentation-skill')!
        await catalog.setPluginEnabled({ pluginId: old.id, enabled: true })
        service.dispose()
        await client!.disconnect()
        phase = 'cold-start-app-server'
        catalog = await startAppServer()
        service = createService()
        service.setPostActivationHook(reconcile)
        await reconcile()
        await record('v3-cold-start-retirement', 'v3')

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const downloadsBefore = archiveRequests
          select('v2')
          phase = `rollback-v2-${attempt}`
          await service.install()
          await record(`retained-v2-rollback-${attempt}`, 'v2')
          expect(archiveRequests).toBe(downloadsBefore)
          select('v3')
          phase = `repeat-v3-${attempt}`
          await service.install()
          await record(`repeat-v2-to-v3-${attempt}`, 'v3')
        }
        await mkdir(dirname(options.output), { recursive: true })
        await writeFile(
          options.output,
          `${JSON.stringify(
            {
              schemaVersion: 'dascowork-primary-runtime-migration.v1',
              target: options.target,
              status: 'passed',
              realAppServer: true,
              signedLoopbackFeed: true,
              evidenceScope:
                'migration-correctness; performance and release budgets are verified by separate gates',
              archiveIdentities: archives,
              transitions: receipt,
              reloads,
              ...(options['retain-cache'] === '1'
                ? {
                    previewBaseline: {
                      legacyRuntimeRoot: legacyInstall.activeRoot,
                      cacheRoot,
                      legacyArchiveSha256: archives.v2.sha256
                    }
                  }
                : {})
            },
            null,
            2
          )}\n`
        )
        succeeded = true
      } catch (error) {
        const failure = {
          schemaVersion: 'dascowork-primary-runtime-migration.v1',
          target: options.target,
          status: 'failed',
          phase,
          error: describeMigrationError(error),
          archiveIdentities: archives,
          providerRequests: backend.requests.map(({ method, url }) => ({ method, url })),
          lastPluginCatalog,
          transitions: receipt
        }
        console.error(JSON.stringify(failure, null, 2))
        await mkdir(dirname(options.output), { recursive: true })
        await writeFile(options.output, `${JSON.stringify(failure, null, 2)}\n`)
        throw error
      } finally {
        service?.dispose()
        await client?.disconnect()
        feed.closeAllConnections()
        await new Promise<void>((resolveClose, rejectClose) =>
          feed.close((error) => (error ? rejectClose(error) : resolveClose()))
        )
        await backend.close()
        if (!succeeded || options['retain-cache'] !== '1') {
          await makeWritable(root)
          await rm(root, { recursive: true, force: true })
        }
      }
    },
    timeout
  )
})

function describeMigrationError(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return String(error)
  const value = error as {
    name?: string
    message?: string
    code?: string
    stack?: string
    cause?: unknown
    errors?: unknown[]
  }
  return {
    name: value.name,
    message: value.message,
    code: value.code,
    stack: value.stack,
    ...(value.cause ? { cause: describeMigrationError(value.cause) } : {}),
    ...(Array.isArray(value.errors) ? { errors: value.errors.map(describeMigrationError) } : {})
  }
}

async function makeWritable(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    // The real app-server creates executable symlinks under CODEX_HOME.
    // Cleanup must never chmod their targets outside this temporary fixture.
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) await makeWritable(path)
    await chmod(path, entry.isDirectory() ? 0o700 : 0o600)
  }
  await chmod(root, 0o700)
}
