import { describe, expect, it } from 'vitest'

import { DesktopHostCapabilityRuntime } from './DesktopHostCapabilityRuntime'
import { PrimaryRuntimeCapabilityPolicy } from '../primaryRuntime'

describe('DesktopHostCapabilityRuntime', () => {
  it('publishes the workspace-dependency loader before the Runtime is ready', async () => {
    let status: 'ready' | 'missing' = 'missing'
    let diagnoseCount = 0
    const runtime = new DesktopHostCapabilityRuntime({
      readThreadTerminal: async () => ({ terminalAttached: false }),
      workspaceDependencies: {
        diagnoseDependencies: async () => {
          diagnoseCount += 1
          return { status }
        },
        loadDependencies: async () => {
          if (status !== 'ready') throw new Error('runtime missing')
          return { node: '/runtime/node' }
        }
      }
    })

    const missing = await runtime.snapshot()
    expect(diagnoseCount).toBe(1)
    expect(missing.primaryRuntime).toBe('missing')
    expect(missing.nativeTools).toBe('degraded')
    expect(missing.codexAppMcp).toBe('unavailable')
    expect(missing.bundledPlugins).toBe('unavailable')
    expect(missing.workspaceInstructionsEnabled).toBe(false)
    expect(missing.presentationsEligible).toBe(false)
    expect(missing.degraded).toBe(true)
    expect(missing.availableToolNames).toEqual([
      'read_thread_terminal',
      'load_workspace_dependencies'
    ])
    expect(missing.dynamicTools[0]).toMatchObject({
      type: 'namespace',
      tools: [{ name: 'read_thread_terminal' }, { name: 'load_workspace_dependencies' }]
    })
    await expect(
      runtime.dispatch({
        namespace: 'codex_app',
        tool: 'load_workspace_dependencies',
        arguments: {}
      })
    ).resolves.toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining('"status":"missing"') }]
    })
    expect(diagnoseCount).toBe(2)

    status = 'ready'
    runtime.refresh()
    const ready = await runtime.snapshot()
    expect(diagnoseCount).toBe(3)
    expect(ready.revision).toBe('desktop-capabilities-1')
    expect(ready.primaryRuntime).toBe('ready')
    expect(ready.nativeTools).toBe('degraded')
    expect(ready.availableToolNames).toEqual([
      'read_thread_terminal',
      'load_workspace_dependencies'
    ])
    expect(ready.dynamicTools[0]).toMatchObject({
      tools: [{ name: 'read_thread_terminal' }, { name: 'load_workspace_dependencies' }]
    })
  })

  it('includes bridge and bundled plugin status in the same capability revision', async () => {
    const runtime = new DesktopHostCapabilityRuntime({
      readThreadTerminal: async () => ({ terminalAttached: false }),
      workspaceDependencies: {
        diagnoseDependencies: async () => ({ status: 'ready' }),
        loadDependencies: async () => ({ node: '/runtime/node' })
      }
    })

    const threadConfig = { mcp_servers: { codex_app: { command: '/runtime/launcher' } } }
    runtime.setCodexAppMcp({ status: 'ready', threadConfig })
    runtime.setBundledPluginsStatus('ready')
    const ready = await runtime.snapshot()

    expect(ready).toMatchObject({
      codexAppMcp: 'ready',
      bundledPlugins: 'ready',
      primaryRuntime: 'ready',
      nativeTools: 'ready',
      degraded: false
    })
    expect(ready.threadConfig).toEqual(threadConfig)
    expect(ready.threadConfig).not.toBe(threadConfig)
  })

  it('clears the MCP thread configuration in the same revision that marks it unavailable', async () => {
    const runtime = new DesktopHostCapabilityRuntime({})
    runtime.setCodexAppMcp({
      status: 'ready',
      threadConfig: { mcp_servers: { codex_app: { command: '/runtime/launcher' } } }
    })
    const ready = await runtime.snapshot()

    runtime.setCodexAppMcp({ status: 'unavailable' })
    const unavailable = await runtime.snapshot()

    expect(unavailable.revision).not.toBe(ready.revision)
    expect(unavailable.codexAppMcp).toBe('unavailable')
    expect(unavailable.threadConfig).toBeUndefined()
  })

  it('does not make thread resume depend on a Runtime-specific admission record', async () => {
    const policy = new PrimaryRuntimeCapabilityPolicy(true)
    const runtime = new DesktopHostCapabilityRuntime({
      workspaceDependencies: {
        diagnoseDependencies: async () => ({
          status: 'ready',
          manifest: {
            bundleFormatVersion: 2,
            bundleVersion: 'v2',
            target: { platform: process.platform, arch: process.arch },
            node: { path: 'dependencies/node/bin/node' },
            nodePackages: []
          },
          issues: []
        }),
        loadDependencies: async () => ({ node: '/runtime/node' })
      },
      primaryRuntimeCapabilities: policy
    })
    runtime.updatePrimaryRuntimeState({
      diagnostic: {
        status: 'ready',
        manifest: {
          bundleFormatVersion: 2,
          bundleVersion: 'v2',
          target: { platform: process.platform, arch: process.arch },
          node: { path: 'dependencies/node/bin/node' },
          nodePackages: []
        },
        issues: []
      },
      runtimePluginsSynchronized: true
    })

    expect((await runtime.snapshot()).availableToolNames).toContain('load_workspace_dependencies')
  })

  it('omits the loader from a new-thread snapshot when Main closes the feature gate', async () => {
    const runtime = new DesktopHostCapabilityRuntime({
      workspaceDependencies: {
        diagnoseDependencies: async () => ({ status: 'missing' }),
        loadDependencies: async () => ({ node: '/runtime/node' })
      },
      primaryRuntimeCapabilities: new PrimaryRuntimeCapabilityPolicy({
        productFeatureEnabled: true,
        loaderFeatureGate: { isEnabled: async () => false }
      })
    })

    await expect(runtime.snapshot()).resolves.toMatchObject({
      availableToolNames: [],
      dynamicTools: [],
      workspaceInstructionsEnabled: false
    })
  })
})
