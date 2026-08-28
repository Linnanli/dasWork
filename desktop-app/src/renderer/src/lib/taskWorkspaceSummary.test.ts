import { describe, expect, it } from 'vitest'

import { LOCAL_FILE_ATTACHMENT_MEDIA_TYPE } from '../../../shared/composerContext'
import { createTaskWorkspaceSummary } from './taskWorkspaceSummary'

describe('createTaskWorkspaceSummary', () => {
  it('derives the latest subagent states from transcript tool activity', () => {
    const summary = createTaskWorkspaceSummary(
      {
        localId: 'local-parent',
        context: { conversationId: 'parent', threadId: 'parent-thread' },
        status: 'streaming',
        threadGoal: null,
        messages: [
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-1',
            sourceMessageId: 'assistant-1',
            parts: [
              activityPart('review-started', 'started', 'agent-review', '/root/review'),
              activityPart('review-updated', 'interacted', 'agent-review', '/root/review'),
              activityPart('test-started', 'started', 'agent-test', '/root/test')
            ]
          }
        ]
      } as never,
      { conversationId: 'parent', threadId: 'parent-thread', title: 'Parent task' }
    )

    expect(summary).toMatchObject({
      conversationId: 'parent',
      threadId: 'parent-thread',
      title: 'Parent task',
      status: 'streaming',
      messageCount: 1,
      timeline: [
        {
          id: 'subagent:review-updated',
          type: 'subagent',
          label: 'Review：已更新'
        },
        {
          id: 'subagent:test-started',
          type: 'subagent',
          label: 'Test：正在工作'
        }
      ],
      agents: [
        {
          eventId: 'review-updated',
          threadId: 'agent-review',
          displayName: 'Review',
          displayStatus: 'updated'
        },
        {
          eventId: 'test-started',
          threadId: 'agent-test',
          displayName: 'Test',
          displayStatus: 'active'
        }
      ]
    })
  })

  it('aggregates generated files from every completed assistant message', () => {
    const summary = createTaskWorkspaceSummary(
      {
        localId: 'local-parent',
        context: {
          conversationId: 'parent',
          threadId: 'parent-thread',
          cwd: '/workspace'
        },
        status: 'ready',
        threadGoal: null,
        messages: [
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-1',
            sourceMessageId: 'assistant-1',
            parts: [{ type: 'text', text: '已生成 [报告](out/report.pdf)。' }]
          },
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-2',
            sourceMessageId: 'assistant-2',
            parts: [{ type: 'text', text: '已生成 [图表](out/chart.png)。' }]
          }
        ]
      } as never,
      { conversationId: 'parent', threadId: 'parent-thread', cwd: '/workspace' }
    )

    expect(summary.outputs).toEqual([
      {
        id: 'file:out/report.pdf',
        type: 'file',
        title: '报告',
        path: 'out/report.pdf',
        cwd: '/workspace'
      },
      {
        id: 'file:out/chart.png',
        type: 'file',
        title: '图表',
        path: 'out/chart.png',
        cwd: '/workspace'
      }
    ])
  })

  it('aggregates files and remote resources from the complete transcript', () => {
    const summary = createTaskWorkspaceSummary(
      {
        localId: 'local-parent',
        context: { conversationId: 'parent', threadId: 'parent-thread', cwd: '/workspace' },
        status: 'ready',
        threadGoal: null,
        messages: [
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-file',
            sourceMessageId: 'assistant-file',
            parts: [{ type: 'text', text: '文件：[报告](out/report.pdf)' }]
          },
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-website',
            sourceMessageId: 'assistant-website',
            parts: [{ type: 'text', text: '网站：https://example.test/dashboard' }]
          },
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-published',
            sourceMessageId: 'assistant-published',
            parts: [
              toolPart('published', 'mcpToolCall', {
                server: 'reports',
                tool: 'publish',
                result: { structuredContent: { url: 'https://reports.example.test/monthly' } }
              })
            ]
          }
        ]
      } as never,
      { conversationId: 'parent', threadId: 'parent-thread', cwd: '/workspace' }
    )

    expect(summary.outputs).toEqual(
      expect.arrayContaining([
        {
          id: 'file:out/report.pdf',
          type: 'file',
          title: '报告',
          path: 'out/report.pdf',
          cwd: '/workspace'
        },
        {
          id: 'website:https://example.test/dashboard',
          type: 'website',
          title: 'example.test',
          url: 'https://example.test/dashboard'
        },
        {
          id: 'website:https://reports.example.test/monthly',
          type: 'website',
          title: 'reports.example.test',
          url: 'https://reports.example.test/monthly'
        }
      ])
    )
  })

  it('aggregates standard sources across the complete transcript and counts repeated use', () => {
    const summary = createTaskWorkspaceSummary(
      {
        localId: 'local-parent',
        context: { conversationId: 'parent', threadId: 'parent-thread' },
        status: 'ready',
        threadGoal: null,
        messages: [
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-1',
            sourceMessageId: 'assistant-1',
            parts: [
              {
                type: 'source-url',
                sourceId: 'source-one',
                url: 'https://example.test/docs',
                title: '产品文档'
              }
            ]
          },
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-2',
            sourceMessageId: 'assistant-2',
            parts: [
              {
                type: 'source-url',
                sourceId: 'source-two',
                url: 'https://example.test/docs',
                title: '产品文档'
              },
              {
                type: 'source-document',
                sourceId: 'source-document',
                title: '设计说明',
                filename: 'design.pdf',
                mediaType: 'application/pdf'
              }
            ]
          }
        ]
      } as never,
      { conversationId: 'parent', threadId: 'parent-thread' }
    )

    expect(summary.sources).toEqual([
      {
        id: 'source-one',
        sourceType: 'url',
        title: '产品文档',
        url: 'https://example.test/docs',
        usageCount: 2
      },
      {
        id: 'source-document',
        sourceType: 'document',
        title: '设计说明',
        filename: 'design.pdf',
        mediaType: 'application/pdf',
        usageCount: 1
      }
    ])
  })

  it('aggregates local attachments, file activity, Web searches, and MCP App calls', () => {
    const summary = createTaskWorkspaceSummary(
      {
        localId: 'local-parent',
        context: { conversationId: 'parent', threadId: 'parent-thread', cwd: '/workspace' },
        status: 'ready',
        threadGoal: null,
        messages: [
          {
            kind: 'message',
            role: 'user',
            renderId: 'user-1',
            sourceMessageId: 'user-1',
            parts: [
              {
                type: 'file',
                filename: 'brief.md',
                mediaType: LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
                url: 'file:///workspace/brief.md'
              }
            ]
          },
          {
            kind: 'message',
            role: 'assistant',
            renderId: 'assistant-1',
            sourceMessageId: 'assistant-1',
            parts: [
              toolPart('read-1', 'commandExecution', {
                commandActions: [{ type: 'read', path: '/workspace/src/app.ts' }]
              }),
              toolPart('change-1', 'fileChange', {
                changes: [{ path: '/workspace/out/report.md', kind: { type: 'add' }, diff: '' }]
              }),
              toolPart('search-1', 'webSearch', { query: 'Codex app server MCP Apps' }),
              toolPart('mcp-1', 'mcpToolCall', {
                server: 'github',
                tool: 'read_issue',
                appContext: {
                  connectorId: 'github-app',
                  appName: 'GitHub',
                  resourceUri: 'app://github'
                }
              })
            ]
          }
        ]
      } as never,
      { conversationId: 'parent', threadId: 'parent-thread', cwd: '/workspace' }
    )

    expect(summary.sources).toEqual(
      expect.arrayContaining([
        {
          id: 'user-file:file:///workspace/brief.md',
          sourceType: 'file',
          title: 'brief.md',
          url: 'file:///workspace/brief.md',
          filename: 'brief.md',
          mediaType: LOCAL_FILE_ATTACHMENT_MEDIA_TYPE,
          detail: '用户提供的文件',
          usageCount: 1
        },
        {
          id: 'file:/workspace/src/app.ts',
          sourceType: 'file',
          title: 'app.ts',
          filename: '/workspace/src/app.ts',
          detail: '已读取的文件',
          usageCount: 1
        },
        {
          id: 'file:/workspace/out/report.md',
          sourceType: 'file',
          title: 'report.md',
          filename: '/workspace/out/report.md',
          detail: '已创建的文件',
          usageCount: 1
        },
        {
          id: 'web-search:Codex app server MCP Apps',
          sourceType: 'web-search',
          title: 'Web 搜索：Codex app server MCP Apps',
          detail: '搜索词',
          usageCount: 1
        },
        {
          id: 'mcp:app:github-app:app://github',
          sourceType: 'app',
          title: 'GitHub',
          detail: 'github · read_issue',
          mcpServer: 'github',
          resourceUri: 'app://github',
          usageCount: 1
        }
      ])
    )
    expect(summary.sources.some((source) => source.url === 'app://github')).toBe(false)
  })
})

function activityPart(
  id: string,
  kind: 'started' | 'interacted',
  agentThreadId: string,
  agentPath: string
): Record<string, unknown> {
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName: 'codex_sub_agent_activity',
    status: { type: 'complete' },
    result: {
      item: {
        id,
        type: 'subAgentActivity',
        status: 'completed',
        kind,
        agentThreadId,
        agentPath
      }
    }
  }
}

function toolPart(
  id: string,
  itemType: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const item = {
    id,
    type: itemType,
    status: 'completed',
    ...overrides
  }
  return {
    type: 'tool-call',
    toolCallId: id,
    toolName: toolNameForItemType(itemType, overrides),
    status: { type: 'complete' },
    result: { item }
  }
}

function toolNameForItemType(itemType: string, item: Record<string, unknown>): string {
  if (itemType === 'commandExecution') return 'codex_command_execution'
  if (itemType === 'fileChange') return 'codex_file_change'
  if (itemType === 'webSearch') return 'codex_web_search'
  if (itemType === 'mcpToolCall') return `mcp:${item.server ?? 'server'}/${item.tool ?? 'tool'}`
  return itemType
}
