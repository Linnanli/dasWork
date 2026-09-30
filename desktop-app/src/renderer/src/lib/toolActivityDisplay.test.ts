import { describe, expect, it } from 'vitest'

import { buildAssistantRenderUnits, type AssistantRenderUnit } from './assistantRenderUnits'
import {
  buildToolActivityDisplayModel,
  shellMetadata,
  shellOutputText
} from './toolActivityDisplay'

type ToolGroupUnit = Extract<AssistantRenderUnit, { type: 'tool-group' }>

describe('buildToolActivityDisplayModel', () => {
  it.each(['input-available', 'output-available', 'output-error'])(
    'keeps image-view appearance independent of %s tool status',
    (state) => {
      const group = runningToolGroup([
        {
          type: 'dynamic-tool',
          toolName: 'codex_image_view',
          toolCallId: 'image-a',
          state,
          input: { path: '/missing.png' },
          ...(state === 'output-error' ? { errorText: 'Missing file' } : {})
        }
      ])
      expect(buildToolActivityDisplayModel(group).group).toMatchObject({
        label: '已查看 1 张图片',
        icon: 'image-view',
        showShimmer: false,
        count: 1,
        expandable: true
      })
    }
  )

  it('keeps running command activity in the group header and full shell data on the item', () => {
    const group = runningToolGroup([
      {
        type: 'tool-call',
        toolCallId: 'cmd-running',
        toolName: 'codex_command_execution',
        status: { type: 'running' },
        argsText: JSON.stringify({
          command: "npm test -- --runInBand --grep 'tool activity display'",
          cwd: '/repo',
          commandActions: [
            {
              type: 'unknown',
              command: "npm test -- --runInBand --grep 'tool activity display'"
            }
          ]
        })
      }
    ])

    const display = buildToolActivityDisplayModel(group)

    expect(display.group).toMatchObject({
      label: "正在运行：npm test -- --runInBand --grep 'tool activity display'",
      icon: 'run-command',
      status: 'running',
      showShimmer: true,
      count: 1,
      expandable: true,
      detailRows: []
    })
    expect(display.items[0]).toMatchObject({
      label: "正在运行：npm test -- --runInBand --grep 'tool activity display'",
      status: 'running',
      toolName: 'codex_command_execution',
      details: {
        shell: {
          command: "npm test -- --runInBand --grep 'tool activity display'",
          cwd: '/repo'
        }
      }
    })
  })

  it('places file line totals on the file edit item instead of the group details', () => {
    const group = completedToolGroup([
      {
        type: 'tool-call',
        toolCallId: 'patch-1',
        toolName: 'codex_file_change',
        result: {
          item: {
            id: 'patch-1',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: 'src/a.ts',
                kind: { type: 'update' },
                diff: '--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+again\n'
              }
            ]
          }
        }
      }
    ])

    const display = buildToolActivityDisplayModel(group)

    expect(display.group.label).toBe('已编辑 1 个文件')
    expect(display.group.detailRows).toEqual([])
    expect(display.items[0]?.label).toBe('已编辑：src/a.ts')
    expect(display.items[0]?.fileChangeStats).toEqual({ additions: 2, deletions: 1 })
  })

  it('renders one file edit item and line total for every changed file in a result', () => {
    const group = completedToolGroup([
      {
        type: 'tool-call',
        toolCallId: 'patch-many',
        toolName: 'codex_file_change',
        result: {
          item: {
            id: 'patch-many',
            type: 'fileChange',
            status: 'completed',
            changes: [
              {
                path: 'src/App.test.tsx',
                kind: { type: 'update' },
                diff: '--- a/src/App.test.tsx\n+++ b/src/App.test.tsx\n-old\n+new\n'
              },
              {
                path: 'src/components/assistant-ui/tool-fallback.tsx',
                kind: { type: 'update' },
                diff: '--- a/src/components/assistant-ui/tool-fallback.tsx\n+++ b/src/components/assistant-ui/tool-fallback.tsx\n+first\n+second\n'
              }
            ]
          }
        }
      }
    ])

    const display = buildToolActivityDisplayModel(group)

    expect(display.group.label).toBe('已编辑 2 个文件')
    expect(display.items).toHaveLength(2)
    expect(display.items.map((item) => item.filePath)).toEqual([
      'src/App.test.tsx',
      'src/components/assistant-ui/tool-fallback.tsx'
    ])
    expect(display.items.map((item) => item.fileChangeStats)).toEqual([
      { additions: 1, deletions: 1 },
      { additions: 2, deletions: 0 }
    ])
  })

  it('maps requires-action stopped and error states to display statuses', () => {
    const requiresAction = buildToolActivityDisplayModel(
      runningToolGroup([
        {
          type: 'tool-call',
          toolCallId: 'needs-approval',
          toolName: 'codex_command_execution',
          status: { type: 'requires-action', reason: 'interrupt' },
          argsText: JSON.stringify({ command: 'npm test' }),
          approval: { id: 'approval-1' }
        }
      ])
    )
    const stopped = buildToolActivityDisplayModel(
      completedToolGroup([
        {
          type: 'tool-call',
          toolCallId: 'stopped-file',
          toolName: 'codex_file_change',
          result: {
            item: {
              id: 'stopped-file',
              type: 'fileChange',
              status: 'stopped',
              changes: [{ path: 'src/new.ts', kind: { type: 'add' }, diff: '+new\n' }]
            }
          }
        }
      ])
    )
    const errored = buildToolActivityDisplayModel(
      completedToolGroup([
        {
          type: 'tool-call',
          toolCallId: 'errored-command',
          toolName: 'codex_command_execution',
          status: { type: 'incomplete', reason: 'error', error: 'boom' },
          argsText: JSON.stringify({ command: 'npm test' })
        }
      ])
    )

    expect(requiresAction.group.status).toBe('requiresAction')
    expect(requiresAction.group.label).toBe('等待审批：npm test')
    expect(requiresAction.items[0]?.label).toBe('等待审批：npm test')
    expect(requiresAction.items[0]?.statusLabel).toBe('等待审批')
    expect(requiresAction.items[0]?.details.approval).toEqual({ id: 'approval-1' })
    expect(stopped.group.status).toBe('stopped')
    expect(stopped.group.label).toBe('已停止创建：src/new.ts')
    expect(stopped.items[0]?.label).toBe('已停止创建：src/new.ts')
    expect(stopped.items[0]?.statusLabel).toBe('已停止')
    expect(errored.group.status).toBe('error')
    expect(errored.group.label).toBe('命令出错：npm test')
    expect(errored.items[0]?.label).toBe('命令出错：npm test')
    expect(errored.items[0]?.statusLabel).toBe('出错')
    expect(errored.items[0]?.details.error).toBe('boom')
  })

  it('uses mixed status for terminal groups with different item outcomes', () => {
    const display = buildToolActivityDisplayModel(
      completedToolGroup([
        fileChangePart('patch-completed', 'completed'),
        fileChangePart('patch-stopped', 'stopped')
      ])
    )

    expect(display.group.status).toBe('mixed')
    expect(display.group.showShimmer).toBe(false)
    expect(display.items.map((item) => item.status)).toEqual(['completed', 'stopped'])
  })

  it('uses semantic labels for every multi-agent action and failure', () => {
    const labelFor = (action: string, status = 'completed'): string => {
      const display = buildToolActivityDisplayModel(
        completedToolGroup([
          {
            type: 'tool-call',
            toolCallId: `${action}-${status}`,
            toolName: 'codex_collab_agent',
            result: {
              item: {
                id: `${action}-${status}`,
                type: 'collabAgentToolCall',
                tool: action,
                status,
                receiverThreadIds: ['agent-a'],
                agentsStates: {}
              }
            }
          }
        ])
      )
      return display.group.label
    }

    expect(labelFor('spawnAgent')).toBe('已启动 1 个子 agent')
    expect(labelFor('sendInput')).toBe('已向 1 个子 agent 发送消息')
    expect(labelFor('resumeAgent')).toBe('已恢复 1 个子 agent')
    expect(labelFor('closeAgent')).toBe('已关闭 1 个子 agent')
    expect(labelFor('spawnAgent', 'failed')).toBe('启动 1 个子 agent 失败')
  })

  it('normalizes MCP web search dynamic and Node REPL labels', () => {
    const mcp = buildToolActivityDisplayModel(
      completedToolGroup([
        {
          type: 'tool-call',
          toolCallId: 'mcp-read',
          toolName: 'mcp:github/read',
          result: {
            item: {
              id: 'mcp-read',
              type: 'mcpToolCall',
              status: 'completed',
              server: 'github',
              tool: 'read'
            }
          }
        }
      ])
    )
    const web = buildToolActivityDisplayModel(
      runningToolGroup([
        {
          type: 'dynamic-tool',
          toolCallId: 'web-live',
          toolName: 'codex_web_search',
          state: 'input-available',
          input: { query: 'render unit parity' },
          providerExecuted: true
        }
      ])
    )
    const dynamic = buildToolActivityDisplayModel(
      completedToolGroup([
        dynamicToolPart('lookup-1', 'lookup'),
        dynamicToolPart('lookup-2', 'lookup')
      ])
    )
    const nodeRepl = buildToolActivityDisplayModel(
      completedToolGroup([
        {
          type: 'tool-call',
          toolCallId: 'node-js',
          toolName: 'mcp:node_repl/js',
          result: {
            item: {
              id: 'node-js',
              type: 'mcpToolCall',
              status: 'completed',
              server: 'node_repl',
              tool: 'js'
            }
          }
        }
      ])
    )

    expect(mcp.group.label).toBe('已使用 github')
    expect(mcp.group.detailRows).toEqual([{ label: '来源', value: 'github' }])
    expect(mcp.items[0]?.label).toBe('MCP：github / read')
    expect(web.group.label).toBe('正在搜索网页：render unit parity')
    expect(web.items[0]?.label).toBe('网页搜索：render unit parity')
    expect(dynamic.group.label).toBe('Lookup（2 次）')
    expect(nodeRepl.group.label).toBe('已运行命令')
  })

  it('uses group summaries instead of a single active query for multiple active web searches', () => {
    const display = buildToolActivityDisplayModel(
      runningToolGroup([
        webSearchPart('web-live-a', 'first active query'),
        webSearchPart('web-live-b', 'second active query')
      ])
    )

    expect(display.group.label).toBe('正在搜索网页')
    expect(display.group.label).not.toContain('first active query')
    expect(display.items.map((item) => item.label)).toEqual([
      '网页搜索：first active query',
      '网页搜索：second active query'
    ])
  })

  it('shows thinking in a completed group header without changing its completed state', () => {
    const group = runningToolGroup([
      {
        type: 'tool-call',
        toolCallId: 'cmd-complete',
        toolName: 'codex_command_execution',
        status: { type: 'complete' },
        argsText: JSON.stringify({ command: 'npm test' }),
        result: {
          item: {
            id: 'cmd-complete',
            type: 'commandExecution',
            status: 'completed',
            command: 'npm test',
            aggregatedOutput: 'PASS\n',
            exitCode: 0
          }
        }
      }
    ])

    expect(group).toMatchObject({ status: 'complete', active: false, showThinkingFallback: true })

    const display = buildToolActivityDisplayModel(group)

    expect(display.group).toMatchObject({
      label: '正在思考',
      status: 'completed',
      showShimmer: true,
      expandable: true
    })
    expect(display.group.icon).toBeUndefined()
    expect(display.items[0]).toMatchObject({
      status: 'completed',
      label: '已运行：npm test'
    })
  })

  it('formats command shell output and metadata for item details', () => {
    const shell = {
      command: 'npm test',
      cwd: '/repo',
      output: 'PASS src/App.test.tsx\n',
      exitCode: 0,
      durationMs: 1250
    }

    expect(shellOutputText(shell)).toBe('$ npm test\nPASS src/App.test.tsx\n')
    expect(shellMetadata(shell)).toEqual(['cwd: /repo', 'exit 0', '1.3s'])
  })
})

function runningToolGroup(content: readonly Record<string, unknown>[]): ToolGroupUnit {
  return toolGroup(content, 'running')
}

function completedToolGroup(content: readonly Record<string, unknown>[]): ToolGroupUnit {
  return toolGroup(content, 'complete')
}

function toolGroup(
  content: readonly Record<string, unknown>[],
  messageStatus: 'running' | 'complete'
): ToolGroupUnit {
  const model = buildAssistantRenderUnits({
    status: { type: messageStatus },
    content
  })
  const unit = model.units
    .flatMap((candidate) =>
      candidate.type === 'reasoning-group' ? candidate.children : [candidate]
    )
    .find((candidate) => candidate.type === 'tool-group')
  if (!unit || unit.type !== 'tool-group') {
    throw new Error('Expected a tool group render unit')
  }
  return unit
}

function dynamicToolPart(id: string, tool: string): Record<string, unknown> {
  return {
    type: 'dynamic-tool',
    toolCallId: id,
    toolName: tool,
    state: 'output-available',
    output: {
      item: {
        id,
        type: 'dynamicToolCall',
        tool,
        status: 'completed'
      }
    },
    providerExecuted: true
  }
}

function fileChangePart(id: string, status: string): Record<string, unknown> {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName: 'codex_file_change',
    result: {
      item: {
        id,
        type: 'fileChange',
        status,
        changes: [{ path: `src/${id}.ts`, kind: { type: 'update' }, diff: '+new\n' }]
      }
    }
  }
}

function webSearchPart(id: string, query: string): Record<string, unknown> {
  return {
    type: 'dynamic-tool',
    toolCallId: id,
    toolName: 'codex_web_search',
    state: 'input-available',
    input: { query },
    providerExecuted: true
  }
}
