import { describe, expect, it } from 'vitest'

import { DesktopHostCapabilityRuntime } from './DesktopHostCapabilityRuntime'

describe('DesktopHostCapabilityRuntime', () => {
  it('publishes workspace dependencies and matching prompt capability only after runtime diagnostics are ready', async () => {
    let status: 'ready' | 'missing' = 'missing'
    let diagnoseCount = 0
    const runtime = new DesktopHostCapabilityRuntime({
      readThreadTerminal: async () => ({ terminalAttached: false }),
      workspaceDependencies: {
        diagnoseDependencies: async () => {
          diagnoseCount += 1
          return { status }
        },
        loadDependencies: async () => ({ node: '/runtime/node' })
      }
    })

    const missing = await runtime.snapshot()
    expect(diagnoseCount).toBe(1)
    expect(missing.primaryRuntime).toBe('missing')
    expect(missing.nativeTools).toBe('degraded')
    expect(missing.codexAppMcp).toBe('unavailable')
    expect(missing.bundledPlugins).toBe('unavailable')
    expect(missing.degraded).toBe(true)
    expect(missing.availableToolNames).toEqual(['read_thread_terminal'])
    expect(missing.dynamicTools[0]).toMatchObject({
      type: 'namespace',
      tools: [{ name: 'read_thread_terminal' }]
    })

    status = 'ready'
    runtime.refresh()
    const ready = await runtime.snapshot()
    expect(diagnoseCount).toBe(2)
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
})
