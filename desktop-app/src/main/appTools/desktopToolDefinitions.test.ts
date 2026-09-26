import { describe, expect, it, vi } from 'vitest'

import { DynamicAppToolRegistry } from './DynamicAppToolRegistry'
import {
  createLoadWorkspaceDependenciesTool,
  createReadThreadTerminalTool
} from './desktopToolDefinitions'

const context = {
  hostId: 'local' as const,
  threadId: 'thread-1',
  signal: new AbortController().signal
}

describe('desktop tool definitions', () => {
  it('keeps read_thread_terminal local, parameterless, and sanitized by the existing reader', async () => {
    const read = vi.fn(async () => ({ terminalAttached: true, output: '\u001b[31mhello\u001b[0m' }))
    const tool = createReadThreadTerminalTool(read)

    await expect(tool.execute(context, {})).resolves.toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: '{"terminalAttached":true,"output":"hello","truncated":false}' }
      ]
    })
    await expect(tool.execute(context, { bad: true })).resolves.toMatchObject({ success: false })
    expect(read).toHaveBeenCalledWith('thread-1')
  })

  it('loads workspace dependencies only with an empty argument object', async () => {
    const loadDependencies = vi.fn(async () => ({
      node: '/runtime/node/bin/node',
      text: 'Use only the following verified Primary Runtime paths.\nRuntime Node: /runtime/node/bin/node\n'
    }))
    const tool = createLoadWorkspaceDependenciesTool({ loadDependencies })

    await expect(tool.execute(context, {})).resolves.toEqual({
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: 'Use only the following verified Primary Runtime paths.\nRuntime Node: /runtime/node/bin/node\n'
        }
      ]
    })
    await expect(tool.execute(context, { root: '/untrusted' })).resolves.toMatchObject({
      success: false
    })
    expect(loadDependencies).toHaveBeenCalledTimes(1)
  })

  it('rejects explicit null arguments instead of treating them as missing', async () => {
    const loadDependencies = vi.fn(async () => ({ text: 'Runtime paths' }))
    const registry = new DynamicAppToolRegistry()
    registry.register(
      createLoadWorkspaceDependenciesTool({
        loadDependencies,
        diagnoseDependencies: async () => ({ status: 'ready' })
      })
    )

    await expect(
      registry.dispatch({
        namespace: 'codex_app',
        tool: 'load_workspace_dependencies',
        arguments: null,
        input: {}
      })
    ).resolves.toMatchObject({
      success: false,
      contentItems: [{ text: expect.stringContaining('object') }]
    })
    expect(loadDependencies).not.toHaveBeenCalled()
  })

  it('publishes the loader while returning structured recovery through registry dispatch when the Runtime is broken', async () => {
    const registry = new DynamicAppToolRegistry()
    registry.register(
      createLoadWorkspaceDependenciesTool({
        loadDependencies: async () => {
          throw new Error('runtime missing')
        },
        diagnoseDependencies: async () => ({
          status: 'broken',
          activeVersion: '1.2.3',
          operationId: 'operation-1',
          issues: [{ code: 'missing-package', message: 'pptxgenjs is missing.', path: '/private' }]
        })
      })
    )

    await expect(registry.availableToolNames({ hostId: 'local' })).resolves.toContain(
      'load_workspace_dependencies'
    )
    await expect(registry.pipeProjection({ hostId: 'local' })).resolves.toMatchObject([
      { namespace: 'codex_app', name: 'load_workspace_dependencies' }
    ])
    await expect(
      registry.dispatch({
        namespace: 'codex_app',
        tool: 'load_workspace_dependencies',
        arguments: {}
      })
    ).resolves.toEqual({
      success: false,
      contentItems: [
        {
          type: 'inputText',
          text: JSON.stringify({
            status: 'broken',
            operationId: 'operation-1',
            activeVersion: '1.2.3',
            issues: [{ code: 'missing-package', message: 'pptxgenjs is missing.' }],
            recovery:
              'Install or repair the Primary Runtime from Plugins & Skills, then create a new task.'
          })
        }
      ]
    })
  })

  it('does not call diagnostics to decide loader publication', async () => {
    const diagnoseDependencies = vi.fn(async () => ({ status: 'ready' as const }))
    const tool = createLoadWorkspaceDependenciesTool({
      loadDependencies: async () => ({ text: 'Runtime paths' }),
      diagnoseDependencies
    })

    await expect(tool.availability({ hostId: 'local' })).resolves.toEqual({ state: 'available' })
    expect(diagnoseDependencies).not.toHaveBeenCalled()
  })

  it('does not publish the loader when Main resolves the product or app-server feature as disabled', async () => {
    const tool = createLoadWorkspaceDependenciesTool({
      loadDependencies: async () => ({ text: 'Runtime paths' })
    })

    await expect(
      tool.availability({ hostId: 'local', workspaceDependenciesEnabled: false })
    ).resolves.toMatchObject({ state: 'unavailable' })
    // Dynamic calls from an already-created thread retain that thread's
    // snapshot; only new projections carry the gate value.
    await expect(
      tool.availability({ hostId: 'local', primaryRuntimeStatus: 'ready' })
    ).resolves.toEqual({ state: 'available' })
  })
})
