import { describe, expect, it } from 'vitest'

import { summarizeToolGroup } from './toolGroupSummary'

describe('summarizeToolGroup', () => {
  it('uses a fixed image view count while calls are running, replayed, or errored', () => {
    const started = {
      type: 'dynamic-tool',
      toolName: 'codex_image_view',
      toolCallId: 'image-a',
      state: 'input-available',
      input: { path: '/same.png' }
    }
    const completed = {
      ...started,
      state: 'output-available',
      output: { item: { type: 'imageView', id: 'image-a', path: '/same.png' } }
    }
    const failed = {
      type: 'dynamic-tool',
      toolName: 'codex_image_view',
      toolCallId: 'image-b',
      state: 'output-error',
      input: { path: '/same.png' },
      errorText: 'File deleted'
    }
    expect(summarizeToolGroup([started, completed, failed, started])).toMatchObject({
      label: '已查看 2 张图片',
      icon: 'image-view',
      count: 2,
      expandable: true
    })
    expect(summarizeToolGroup([started])).toMatchObject({ label: '已查看 1 张图片' })
  })

  it('summarizes completed command read actions from tool results', () => {
    const summary = summarizeToolGroup([
      commandResultPart('read-a', 'read'),
      commandResultPart('read-b', 'read'),
      commandResultPart('read-c', 'read')
    ])

    expect(summary).toMatchObject({
      label: '已读取 3 个文件',
      icon: 'read-files',
      active: false,
      count: 3,
      expandable: true
    })
  })

  it('summarizes running command actions from tool input', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_command_execution',
        status: { type: 'running' },
        argsText: JSON.stringify({
          command: 'rg "needle"',
          cwd: '/repo',
          commandActions: [{ type: 'search', command: 'rg "needle"', query: 'needle', path: null }]
        })
      }
    ])

    expect(summary).toMatchObject({
      label: '正在搜索 1 次代码',
      icon: 'code-searching',
      active: true,
      count: 1,
      expandable: true
    })
  })

  it('treats assistant-ui requires-action tool status as active', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_command_execution',
        status: { type: 'requires-action', reason: 'interrupt' },
        argsText: JSON.stringify({
          command: 'npm test',
          cwd: '/repo',
          commandActions: [{ type: 'unknown', command: 'npm test' }]
        })
      }
    ])

    expect(summary).toMatchObject({
      label: '正在运行 1 条命令',
      icon: 'run-command',
      active: true,
      count: 1,
      expandable: true
    })
  })

  it('summarizes file change actions by patch kind', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_file_change',
        result: {
          item: {
            type: 'fileChange',
            status: 'completed',
            changes: [
              { path: '/repo/new.ts', kind: { type: 'add' }, diff: '' },
              { path: '/repo/old.ts', kind: { type: 'delete' }, diff: '' },
              { path: '/repo/edit.ts', kind: { type: 'update', move_path: null }, diff: '' }
            ]
          }
        }
      }
    ])

    expect(summary).toMatchObject({
      label: '已创建 1 个文件，已编辑 1 个文件，已删除 1 个文件',
      icon: 'edit-files',
      active: false,
      count: 1,
      expandable: true
    })
  })

  it('uses the web search icon when a grouped call includes web activity', () => {
    const summary = summarizeToolGroup([
      { type: 'tool-call', toolName: 'codex_web_search', status: { type: 'running' } },
      commandResultPart('read-a', 'read')
    ])

    expect(summary).toMatchObject({
      label: '已读取 1 个文件，正在搜索网页',
      icon: 'web-search',
      active: true,
      count: 2,
      expandable: true
    })
  })

  it('falls back to a Chinese generic tool summary for unknown grouped calls', () => {
    const summary = summarizeToolGroup([
      { type: 'tool-call', toolName: 'unknown_tool_a' },
      { type: 'tool-call', toolName: 'unknown_tool_b' }
    ])

    expect(summary).toMatchObject({
      label: '已调用 2 个工具',
      icon: 'generic-tool',
      active: false,
      count: 2,
      expandable: true
    })
  })

  it('summarizes folder creation loaded tools and automatic approval denials', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_command_execution',
        result: {
          item: {
            id: 'mkdir-1',
            type: 'commandExecution',
            status: 'completed',
            commandActions: [{ type: 'mkdir', command: 'mkdir src/new' }]
          }
        }
      },
      {
        type: 'tool-call',
        toolName: 'codex_loaded_tool',
        result: { item: { id: 'load-1', type: 'loadedTool', status: 'completed' } }
      },
      {
        type: 'tool-call',
        toolName: 'codex_automatic_approval_review',
        result: {
          item: {
            id: 'approval-1',
            type: 'automaticApprovalReview',
            status: 'completed',
            outcome: 'denied'
          }
        }
      }
    ])

    expect(summary).toMatchObject({
      label: '已创建 1 个文件夹，已加载 1 个工具定义，已拒绝 1 次自动审批',
      icon: 'edit-files',
      active: false,
      count: 3,
      expandable: true
    })
  })

  it('summarizes sleep and automatic approval approved/in-progress states', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_sleep',
        result: { item: { id: 'sleep-1', type: 'sleep', durationMs: 1000 } }
      },
      {
        type: 'tool-call',
        toolName: 'codex_automatic_approval_review',
        result: {
          item: {
            id: 'approval-approved',
            type: 'automaticApprovalReview',
            status: 'completed',
            outcome: 'approved'
          }
        }
      },
      {
        type: 'tool-call',
        toolName: 'codex_automatic_approval_review',
        status: { type: 'running' },
        result: {
          item: {
            id: 'approval-running',
            type: 'automaticApprovalReview',
            status: 'inProgress',
            outcome: 'inProgress'
          }
        }
      }
    ])

    expect(summary).toMatchObject({
      label: '已等待 1 次，已通过 1 次自动审批，正在审核 1 次自动审批',
      icon: 'generic-tool',
      active: true,
      count: 3,
      expandable: true
    })
  })

  it('summarizes automatic approval timeouts', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_automatic_approval_review',
        result: {
          item: {
            id: 'approval-timeout',
            type: 'automaticApprovalReview',
            status: 'completed',
            outcome: 'timedOut'
          }
        }
      }
    ])

    expect(summary).toMatchObject({
      label: '已超时 1 次自动审批',
      icon: 'review-mode',
      active: false,
      count: 1
    })
  })

  it('treats AI SDK preliminary dynamic-tool outputs as active', () => {
    const summary = summarizeToolGroup([
      {
        type: 'dynamic-tool',
        toolName: 'codex_sleep',
        toolCallId: 'sleep-running',
        state: 'output-available',
        preliminary: true,
        output: { item: { id: 'sleep-running', type: 'sleep', durationMs: 1000 } },
        providerExecuted: true
      }
    ])

    expect(summary).toMatchObject({
      label: '正在等待 1 次',
      icon: 'generic-tool',
      active: true,
      count: 1
    })
  })

  it('records MCP source summaries when source metadata is available', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'mcp:github/read',
        result: {
          item: {
            id: 'mcp-1',
            type: 'mcpToolCall',
            status: 'completed',
            server: 'github'
          }
        }
      }
    ])

    expect(summary).toMatchObject({
      label: '已调用 1 个 MCP 工具',
      icon: 'mcp-tools',
      sourceSummary: 'github',
      details: ['MCP：github / read']
    })
  })

  it('records active web search command details', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_web_search',
        status: { type: 'running' },
        argsText: JSON.stringify({ query: 'render unit parity' })
      }
    ])

    expect(summary).toMatchObject({
      activeSummary: '正在搜索网页：render unit parity',
      details: ['网页搜索：render unit parity']
    })
  })

  it('records changed line counts and stopped file creation details', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_file_change',
        result: {
          item: {
            id: 'patch-1',
            type: 'fileChange',
            status: 'stopped',
            changes: [
              {
                path: '/repo/new.ts',
                kind: { type: 'add' },
                diff: '--- /dev/null\n+++ b/new.ts\n+const a = 1\n+const b = 2\n'
              },
              {
                path: '/repo/edit.ts',
                kind: { type: 'update' },
                diff: '--- a/edit.ts\n+++ b/edit.ts\n-old\n+new\n'
              }
            ]
          }
        }
      }
    ])

    expect(summary.details).toEqual(['变更 +3/-1 行', '已停止创建 1 个文件'])
  })

  it('records loaded tool source names', () => {
    const summary = summarizeToolGroup([
      {
        type: 'tool-call',
        toolName: 'codex_loaded_tool',
        result: {
          item: {
            id: 'load-1',
            type: 'loadedTool',
            status: 'completed',
            name: 'browser.open'
          }
        }
      }
    ])

    expect(summary.details).toEqual(['已加载工具：browser.open'])
  })
})

function commandResultPart(id: string, actionType: string): unknown {
  return {
    type: 'tool-call',
    toolName: 'codex_command_execution',
    result: {
      item: {
        id,
        type: 'commandExecution',
        command: `tool ${id}`,
        cwd: '/repo',
        status: 'completed',
        commandActions: [
          { type: actionType, command: `tool ${id}`, name: id, path: `/repo/${id}.ts` }
        ]
      }
    }
  }
}
