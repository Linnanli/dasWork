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
      root: '/runtime',
      node: '/runtime/node/bin/node'
    }))
    const tool = createLoadWorkspaceDependenciesTool({ loadDependencies })

    await expect(tool.execute(context, {})).resolves.toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: '{"root":"/runtime","node":"/runtime/node/bin/node"}' }
      ]
    })
    await expect(tool.execute(context, { root: '/untrusted' })).resolves.toMatchObject({
      success: false
    })
    expect(loadDependencies).toHaveBeenCalledTimes(1)
  })

  it('rejects explicit null arguments instead of treating them as missing', async () => {
    const loadDependencies = vi.fn(async () => ({ root: '/runtime' }))
    const registry = new DynamicAppToolRegistry()
    registry.register(createLoadWorkspaceDependenciesTool({ loadDependencies }))

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

  it('does not advertise workspace dependencies when diagnostics report a broken runtime', async () => {
    const tool = createLoadWorkspaceDependenciesTool({
      loadDependencies: async () => ({ root: '/runtime' }),
      diagnoseDependencies: async () => ({ status: 'broken' })
    })

    await expect(tool.availability({ hostId: 'local' })).resolves.toEqual({
      state: 'unavailable',
      reason: 'Workspace dependencies are unavailable.'
    })
  })
})
