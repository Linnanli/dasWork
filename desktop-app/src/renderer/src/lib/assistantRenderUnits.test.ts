import { describe, expect, it } from 'vitest'
import {
  CodexEventMapper,
  mapCodexThreadItemToUiPart,
  type ThreadItem
} from '@janole/ai-sdk-provider-codex-asp'
import { readUIMessageStream, streamText, type LanguageModel, type UIMessage } from 'ai'

import { LEGACY_CODEX_MESSAGE_METADATA_KEY } from '../../../shared/codexMessageMetadata'
import { buildAssistantRenderUnits, displayNameForSubagentPath } from './assistantRenderUnits'
import { assistantRenderUnitFixtures } from './__fixtures__/assistantRenderUnitFixtures'

// The desktop package deliberately depends on `ai`, not its transitive
// `@ai-sdk/provider` package. Derive the v3 test-double contract from the
// public `LanguageModel` union so pnpm's strict resolver keeps that boundary.
type LanguageModelV3 = Extract<LanguageModel, { specificationVersion: 'v3' }>
type LanguageModelV3GenerateResult = Awaited<ReturnType<LanguageModelV3['doGenerate']>>
type LanguageModelV3StreamResult = Awaited<ReturnType<LanguageModelV3['doStream']>>
type LanguageModelV3StreamPart =
  LanguageModelV3StreamResult['stream'] extends ReadableStream<infer Part> ? Part : never

describe('buildAssistantRenderUnits', () => {
  it('marks text as streaming only while the assistant message is running', () => {
    const content = [{ type: 'text', text: 'Visible response' }]

    expect(buildAssistantRenderUnits({ status: { type: 'running' }, content }).units).toMatchObject(
      [{ type: 'text', streaming: true }]
    )
    expect(
      buildAssistantRenderUnits({ status: { type: 'complete' }, content }).units
    ).toMatchObject([{ type: 'text', streaming: false }])
  })

  it.each(assistantRenderUnitFixtures)('$name', (fixture) => {
    const model = buildAssistantRenderUnits({
      status: fixture.status,
      content: fixture.parts
    })

    expect(
      model.units.map((unit) => ({
        type: unit.type,
        kind: unit.type === 'tool-group' ? unit.kind : undefined,
        key: unit.key,
        partIndices: unit.partIndices,
        action: 'action' in unit ? unit.action : undefined,
        renderMode: unit.type === 'entry' ? unit.renderMode : undefined,
        targetIds: unit.target.itemIds,
        childCount: unit.type === 'tool-group' ? unit.children.length : undefined,
        mcpSourceType: unit.type === 'tool-group' ? unit.mcpSource?.sourceType : undefined,
        dynamicRepeatCount:
          unit.type === 'tool-group' ? unit.dynamicMetadata?.repeatCount : undefined,
        dynamicHasRegistryMetadata:
          unit.type === 'tool-group' ? unit.dynamicMetadata?.hasRegistryMetadata : undefined,
        summaryOnly: unit.type === 'tool-group' ? unit.summaryOnly : undefined,
        summaryLabel: unit.summary?.label,
        active: unit.active,
        processItemCount: unit.type === 'reasoning-group' ? unit.children.length : undefined
      }))
    ).toMatchObject(fixture.expectedUnits)
  })

  it('hides internal reasoning summaries and groups commentary with process activity', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        { type: 'reasoning', text: '**Clarifying state initialization and active flags**' },
        { type: 'text', text: '我会先收集实际证据。' },
        toolPart('cmd-1', 'commandExecution'),
        { type: 'reasoning', text: '**Confirming reasoning visibility handling**' },
        { type: 'text', text: '现已核对实时流和历史记录。' },
        { type: 'text', text: '## 结论\n\n根因已经确认。' }
      ],
      textPhases: ['commentary', 'commentary', 'final_answer'],
      processDurationMs: 1250
    })

    expect(model.isThinkingOnly).toBe(false)
    expect(model.units.map((unit) => unit.type)).toEqual(['reasoning-group', 'text'])
    expect(model.units[0]).toMatchObject({
      type: 'reasoning-group',
      key: 'reasoning-group',
      partIndices: [1, 2, 4],
      active: false,
      state: 'completed',
      durationMs: 1250,
      turnRunning: false,
      children: [{ type: 'text' }, { type: 'tool-group' }, { type: 'text' }]
    })
    expect(model.units[1]).toMatchObject({ type: 'text', phase: 'final_answer' })
    expect(JSON.stringify(model.units)).not.toContain('Clarifying state initialization')
    expect(JSON.stringify(model.units)).not.toContain('Confirming reasoning visibility')
  })

  it('moves a completed live turn diff after the final answer', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        { type: 'text', text: '我会创建页面。' },
        toolPart('live-diff', 'turnDiff', {
          diff: 'diff --git a/report.html b/report.html\n+new file mode 100644\n'
        }),
        { type: 'text', text: '页面已创建。' }
      ],
      textPhases: ['commentary', 'final_answer']
    })

    expect(model.units.map((unit) => unit.type)).toEqual(['reasoning-group', 'text', 'entry'])
    expect(model.units[1]).toMatchObject({ text: '页面已创建。', phase: 'final_answer' })
    expect(model.units[2]).toMatchObject({
      itemType: 'turnDiff',
      item: { status: 'completed' }
    })
  })

  it('keeps an unphased final answer outside the process group before a completed turn diff', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('patch', 'fileChange'),
        { type: 'text', text: '文件已更新。' },
        toolPart('live-diff', 'turnDiff', {
          diff: 'diff --git a/report.html b/report.html\n+new file mode 100644\n'
        })
      ]
    })

    expect(model.units.map((unit) => unit.type)).toEqual(['reasoning-group', 'text', 'entry'])
    expect(model.units[1]).toMatchObject({ text: '文件已更新。' })
    expect(model.units[2]).toMatchObject({ itemType: 'turnDiff' })
  })

  it('extracts completed final-answer code comments, removes directives, and appends one card', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        {
          type: 'text',
          text: [
            '检查完成。',
            '::code-comment{title="空值未处理" body="这里可能抛出异常。" file="src/app.ts" start=12 end=14 priority=1}',
            '',
            '其余逻辑正常。'
          ].join('\n')
        }
      ],
      textPhases: ['final_answer'],
      workspaceCwd: '/repo'
    })

    expect(model.units.map((unit) => unit.type)).toEqual(['text', 'review-comments'])
    expect(model.units[0]).toMatchObject({
      type: 'text',
      text: '检查完成。\n\n其余逻辑正常。',
      phase: 'final_answer'
    })
    expect(model.units[1]).toMatchObject({
      type: 'review-comments',
      workspaceCwd: '/repo',
      canOpenLocalPaths: true,
      comments: [
        {
          title: '[P1] 空值未处理',
          body: '这里可能抛出异常。',
          file: 'src/app.ts',
          priority: 'P1',
          startLine: 12,
          endLine: 14
        }
      ]
    })
    expect(JSON.stringify(model.units)).not.toContain('::code-comment')
  })

  it('does not parse code comments from commentary or a running message', () => {
    const directive =
      '::code-comment{title="不应出现" body="仍应作为原始文本显示。" file="src/app.ts" priority=1}'
    const commentary = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [{ type: 'text', text: directive }],
      textPhases: ['commentary']
    })
    const running = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [{ type: 'text', text: directive }],
      textPhases: ['final_answer']
    })

    expect(commentary.units.some((unit) => unit.type === 'review-comments')).toBe(false)
    expect(JSON.stringify(commentary.units)).toContain('::code-comment')
    expect(running.units.some((unit) => unit.type === 'review-comments')).toBe(false)
    expect(JSON.stringify(running.units)).toContain('::code-comment')
  })

  it('derives completed output resources but excludes HTML files', () => {
    const visualizationPath =
      '/repo/.codex/visualizations/2026/08/19/agent_123/security-market-analysis.html'
    const htmlExportPath = '/repo/exports/metrics-dashboard.html'
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      content: [
        toolPart('generated-files', 'fileChange', {
          changes: [
            { path: '/repo/report.pdf', kind: { type: 'add' }, diff: '' },
            { path: visualizationPath, kind: { type: 'add' }, diff: '' },
            { path: htmlExportPath, kind: { type: 'add' }, diff: '' },
            { path: 'exports/metrics.xlsx', kind: { type: 'add' }, diff: '' },
            { path: '/repo/src/index.ts', kind: { type: 'add' }, diff: '' },
            { path: '/repo/removed.csv', kind: { type: 'delete' }, diff: '' },
            { path: '/repo/report.pdf', kind: { type: 'update', move_path: null }, diff: '' }
          ]
        })
      ]
    })

    const resourcesUnit = model.units.find(
      (unit) => unit.type === 'entry' && unit.itemType === 'endResources'
    )

    expect(resourcesUnit).toMatchObject({
      key: 'end-resources:generated-files',
      partIndices: [0],
      target: { itemIds: ['generated-files'] },
      item: {
        resources: [
          { type: 'file', path: '/repo/report.pdf', title: 'report.pdf', cwd: '/repo' },
          { type: 'file', path: 'exports/metrics.xlsx', title: 'metrics.xlsx', cwd: '/repo' }
        ]
      }
    })
    expect(JSON.stringify(resourcesUnit)).not.toContain(visualizationPath)
    expect(JSON.stringify(resourcesUnit)).not.toContain(htmlExportPath)
  })

  it('does not derive HTML output resources for historical messages without an explicit status', () => {
    const model = buildAssistantRenderUnits({
      workspaceCwd: '/repo',
      content: [
        toolPart('historical-html', 'fileChange', {
          changes: [
            {
              path: '/repo/outputs/security-market.html',
              kind: { type: 'add' },
              diff: '<!doctype html>'
            }
          ]
        })
      ]
    })

    expect(
      model.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
    ).toBe(false)
  })

  it('does not derive local HTML resources from inline-code paths in final replies', () => {
    const message = {
      workspaceCwd:
        '/Users/nallylin/Library/Application Support/desktop-app/projectless/ai-agent-html-edc2de110440',
      content: [
        {
          type: 'text',
          text: '页面已生成并校验通过：`out/index.html`（自包含单文件，双击即可打开）。'
        }
      ]
    }
    const models = [
      buildAssistantRenderUnits({ ...message, status: { type: 'complete' } }),
      buildAssistantRenderUnits(message)
    ]

    for (const model of models) {
      expect(
        model.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
      ).toBe(false)
    }
  })

  it('does not derive generated file resources before completion or for remote conversations', () => {
    const content = [
      toolPart('generated-html', 'fileChange', {
        changes: [
          {
            path: '/repo/.codex/visualizations/2026/08/19/agent_123/preview.html',
            kind: { type: 'add' },
            diff: ''
          }
        ]
      })
    ]

    const running = buildAssistantRenderUnits({
      status: { type: 'running' },
      workspaceCwd: '/repo',
      content
    })
    const remote = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      canOpenLocalPaths: false,
      content
    })

    expect(
      running.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
    ).toBe(false)
    expect(
      remote.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
    ).toBe(false)
  })

  it('keeps external resources available for remote conversations', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      canOpenLocalPaths: false,
      content: [{ type: 'text', text: '部署地址：https://example.test/reports/latest' }]
    })

    const resourcesUnit = model.units.find(
      (unit) => unit.type === 'entry' && unit.itemType === 'endResources'
    )

    expect(resourcesUnit).toMatchObject({
      item: {
        resources: [
          { type: 'website', url: 'https://example.test/reports/latest', title: 'example.test' }
        ]
      }
    })
  })

  it('preserves encoded URL paths and keeps case-distinct local files separate', () => {
    const encodedUrl = 'https://example.test/downloads/report%2F2026'
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      content: [
        { type: 'text', text: `[下载](${encodedUrl})` },
        toolPart('case-distinct-files', 'fileChange', {
          changes: [
            { path: '/repo/Report.pdf', kind: { type: 'add' }, diff: '' },
            { path: '/repo/report.pdf', kind: { type: 'add' }, diff: '' }
          ]
        })
      ]
    })

    const resourcesUnit = model.units.find(
      (unit) => unit.type === 'entry' && unit.itemType === 'endResources'
    )

    expect(resourcesUnit).toMatchObject({
      item: {
        resources: [
          { type: 'website', url: encodedUrl },
          { type: 'file', path: '/repo/report.pdf' },
          { type: 'file', path: '/repo/Report.pdf' }
        ]
      }
    })
    expect(JSON.stringify(model.units)).not.toContain('https://example.test/downloads/report/2026')
  })

  it('derives markdown links, drive links, websites, and appgen results', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      content: [
        {
          type: 'text',
          text: [
            '文件：[报告](/repo/report.pdf)',
            '云文档：[表格](https://docs.google.com/spreadsheets/d/sheet-1/edit)',
            '网站：https://example.test:4173/dashboard'
          ].join('\n')
        },
        toolPart('sites-1', 'mcpToolCall', {
          server: 'sites',
          tool: 'publish',
          result: {
            structuredContent: {
              current_preview_url: 'https://preview.example.test/app',
              title: '市场分析应用'
            }
          }
        })
      ]
    })

    const resourcesUnit = model.units.find(
      (unit) => unit.type === 'entry' && unit.itemType === 'endResources'
    )
    expect(resourcesUnit).toMatchObject({
      item: {
        resources: [
          { type: 'appgen-app', url: 'https://preview.example.test/app', title: '市场分析应用' },
          { type: 'website', url: 'https://example.test:4173/dashboard', title: 'example.test' },
          { type: 'file', path: '/repo/report.pdf', title: '报告' },
          {
            type: 'google-drive',
            url: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
            title: '表格'
          }
        ]
      }
    })
    const websiteOnlyModel = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [{ type: 'text', text: '网站：https://example.test:4173/dashboard' }]
    })
    expect(JSON.stringify(websiteOnlyModel.units)).toContain('https://example.test:4173/dashboard')

    const ordinaryLinkModel = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [{ type: 'text', text: '参考：https://example.test/dashboard' }]
    })
    expect(JSON.stringify(ordinaryLinkModel.units)).toContain('https://example.test/dashboard')

    const visualizationOnlyModel = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('visualization-only', 'fileChange', {
          changes: [
            {
              path: '/repo/.codex/visualizations/2026/08/19/agent_123/preview.html',
              kind: { type: 'add' },
              diff: ''
            }
          ]
        })
      ]
    })
    expect(JSON.stringify(visualizationOnlyModel.units)).toContain('preview.html')
  })

  it('does not derive a resource card from a local HTML Markdown link', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        {
          type: 'text',
          text: '[市场分析](/Users/nallylin/Documents/Codex/2026-08-19/ai-agent-html/outputs/ai-agent-security-market.html:1)'
        }
      ]
    })

    expect(model.units).toMatchObject([{ type: 'text' }])
    expect(
      model.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
    ).toBe(false)
  })

  it('derives generic output files and every completed remote resource', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      content: [
        {
          type: 'text',
          text: [
            '[结果数据](/repo/exports/results.json)',
            '[演示站点](https://demo.example.test/overview)',
            'https://docs.google.com/document/d/doc-1/edit'
          ].join('\n')
        },
        toolPart('resource-tool', 'mcpToolCall', {
          server: 'reports',
          tool: 'publish',
          result: { structuredContent: { url: 'https://reports.example.test/monthly' } }
        })
      ]
    })

    const resourcesUnit = model.units.find(
      (unit) => unit.type === 'entry' && unit.itemType === 'endResources'
    )
    expect(resourcesUnit).toMatchObject({
      item: {
        resources: [
          {
            type: 'website',
            url: 'https://demo.example.test/overview',
            title: 'demo.example.test'
          },
          {
            type: 'website',
            url: 'https://reports.example.test/monthly',
            title: 'reports.example.test'
          },
          { type: 'file', path: '/repo/exports/results.json', title: '结果数据' },
          {
            type: 'google-drive',
            url: 'https://docs.google.com/document/d/doc-1/edit',
            title: 'docs.google.com'
          }
        ]
      }
    })
  })

  it('does not derive resources from failed tool parts', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('failed-file', 'fileChange', {
          status: { type: 'error' },
          isError: true,
          changes: [{ path: '/repo/failed.pdf', kind: { type: 'add' }, diff: '' }]
        })
      ]
    })

    expect(
      model.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
    ).toBe(false)
  })

  it('derives completed artifact metadata and historical diff paths without file changes', () => {
    const artifactModel = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      metadata: {
        artifacts: {
          editedFilePaths: ['/repo/notes.md'],
          referencedFilePaths: ['/repo/data.csv']
        }
      },
      content: []
    })
    const diffModel = buildAssistantRenderUnits({
      status: { type: 'complete' },
      workspaceCwd: '/repo',
      content: [
        toolPart('historic-diff', 'turnDiff', {
          diff:
            'diff --git a/.codex/visualizations/preview.html b/.codex/visualizations/preview.html\n' +
            '--- a/.codex/visualizations/preview.html\n' +
            '+++ b/.codex/visualizations/preview.html\n'
        })
      ]
    })

    expect(JSON.stringify(artifactModel.units)).toContain('/repo/data.csv')
    expect(JSON.stringify(artifactModel.units)).toContain('/repo/notes.md')
    expect(
      diffModel.units.some((unit) => unit.type === 'entry' && unit.itemType === 'endResources')
    ).toBe(false)
  })

  it('parses completed historical text without phase metadata', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        {
          type: 'text',
          text: '::code-comment{title="历史评论" body="兼容旧消息。" file="src/legacy.ts" start=7}'
        }
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'review-comments',
        comments: [{ title: '历史评论', file: 'src/legacy.ts', startLine: 7, endLine: 7 }]
      }
    ])
  })

  it('deduplicates identical comments across completed final-answer text parts', () => {
    const first =
      '::code-comment{title="重复评论" body="同一问题。" file="src/repeated.ts" start=4 priority=2 confidence=0.9}'
    const duplicate =
      '::code-comment{title="[P2] 重复评论" body="同一问题。" file="src/repeated.ts" start=4 priority=2 confidence=0.4}'
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        { type: 'text', text: `第一段。\n${first}` },
        { type: 'text', text: `第二段。\n${duplicate}` }
      ],
      textPhases: ['final_answer', 'final_answer']
    })

    expect(model.units.map((unit) => unit.type)).toEqual(['text', 'text', 'review-comments'])
    expect(model.units.filter((unit) => unit.type === 'review-comments')).toMatchObject([
      {
        comments: [{ title: '[P2] 重复评论', confidence: 0.9 }]
      }
    ])
  })

  it('keeps the commentary process group active until the final answer starts', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'reasoning', text: '**Internal summary**' },
        { type: 'text', text: '正在检查结果。' },
        toolPart('cmd-1', 'commandExecution')
      ],
      textPhases: ['commentary']
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        key: 'reasoning-group',
        partIndices: [1, 2],
        active: true,
        state: 'thinking',
        showThinkingFallback: false,
        children: [{ type: 'text' }, { type: 'tool-group' }]
      },
      { type: 'message-thinking', active: true, showThinkingFallback: true }
    ])
    expect(model.units).toHaveLength(2)
  })

  it('does not append thinking after a commentary command has completed with output', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: '请确认这条命令。' },
        toolPart('cmd-approval', 'commandExecution', {
          aggregatedOutput: '/workspace\nE2E_APPROVED_COMMAND'
        })
      ],
      textPhases: ['commentary']
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: true,
        state: 'thinking',
        children: [{ type: 'text' }, { type: 'tool-group', kind: 'command', active: false }]
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('keeps a blocked commentary process group without a thinking presentation', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [{ type: 'text', text: '等待用户批准。' }],
      textPhases: ['commentary'],
      hasBlockingRequest: true
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: true,
        state: 'blocked',
        showThinkingFallback: false,
        children: [{ type: 'text', phase: 'commentary' }]
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('ends the commentary process group before unphased visible answer text', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: '先检查一下。' },
        { type: 'text', text: '这是当前结果。' }
      ],
      textPhases: ['commentary', undefined]
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: false,
        state: 'completed',
        showThinkingFallback: false,
        children: [{ type: 'text', phase: 'commentary' }]
      },
      { type: 'text', phase: undefined, text: '这是当前结果。' }
    ])
  })

  it('prevents older tools from owning thinking when text follows them', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [toolPart('cmd-1', 'commandExecution'), { type: 'text', text: '结果如下' }]
    })

    expect(model.units.map((unit) => unit.type)).toEqual(['reasoning-group', 'text'])
    expect(model.units[0]).toMatchObject({
      type: 'reasoning-group',
      active: false,
      state: 'completed',
      turnRunning: true,
      showThinkingFallback: false,
      children: [{ type: 'tool-group' }]
    })
    expect(model.units[1]).toMatchObject({ type: 'text', text: '结果如下' })
  })

  it('keeps thinking after completed tools when earlier process text has no phase', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: 'Let me explore the repository first.' },
        toolPart('cmd-1', 'commandExecution'),
        toolPart('file-1', 'fileChange')
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: true,
        state: 'thinking',
        turnRunning: true,
        showThinkingFallback: false,
        children: [
          { type: 'text', phase: undefined },
          { type: 'tool-group', kind: 'composite', active: false }
        ]
      },
      { type: 'message-thinking', active: true, showThinkingFallback: true }
    ])
    expect(model.units.some((unit) => unit.type === 'message-thinking')).toBe(true)
  })

  it('uses only the latest activity boundary for repeated unphased process text', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: 'Let me inspect the repository.' },
        toolPart('read-1', 'commandExecution', {
          commandActions: [{ type: 'read', path: '/repo/README.md', command: 'cat README.md' }]
        }),
        { type: 'text', text: 'Let me check one more file.' },
        toolPart('cmd-2', 'commandExecution')
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: true,
        state: 'thinking',
        turnRunning: true,
        showThinkingFallback: false,
        children: [
          { type: 'text', text: 'Let me inspect the repository.' },
          { type: 'tool-group' },
          { type: 'text', text: 'Let me check one more file.' },
          { type: 'tool-group', kind: 'command', active: false }
        ]
      },
      { type: 'message-thinking', active: true, showThinkingFallback: true }
    ])
    expect(model.units.some((unit) => unit.type === 'message-thinking')).toBe(true)
  })

  it('hides thinking while unphased visible text follows the latest tool', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: 'Let me inspect the repository.' },
        toolPart('cmd-1', 'commandExecution'),
        { type: 'text', text: '这是最终分析。' }
      ]
    })

    expect(model.units.map((unit) => unit.type)).toEqual(['reasoning-group', 'text'])
    expect(model.units[0]).toMatchObject({
      type: 'reasoning-group',
      active: false,
      state: 'completed',
      turnRunning: true,
      showThinkingFallback: false,
      children: [{ type: 'text' }, { type: 'tool-group' }]
    })
    expect(model.units.at(-1)).toMatchObject({
      type: 'text',
      phase: undefined,
      text: '这是最终分析。',
      showThinkingFallback: false
    })
    expect(model.units.some((unit) => unit.showThinkingFallback)).toBe(false)
  })

  it('moves an earlier unphased candidate into process when later activity arrives', () => {
    const beforeLaterActivity = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: '先检查项目。' },
        toolPart('cmd-1', 'commandExecution'),
        { type: 'text', text: '目前看是配置问题。' }
      ]
    })
    const afterLaterActivity = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: '先检查项目。' },
        toolPart('cmd-1', 'commandExecution'),
        { type: 'text', text: '目前看是配置问题。' },
        toolPart('cmd-2', 'commandExecution')
      ]
    })

    expect(beforeLaterActivity.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: false,
        turnRunning: true,
        children: [{ type: 'text' }, { type: 'tool-group' }]
      },
      { type: 'text', text: '目前看是配置问题。' }
    ])
    expect(afterLaterActivity.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: true,
        turnRunning: true,
        children: [
          { type: 'text', text: '先检查项目。' },
          { type: 'tool-group' },
          { type: 'text', text: '目前看是配置问题。' },
          { type: 'tool-group' }
        ]
      },
      { type: 'message-thinking', active: true, showThinkingFallback: true }
    ])
  })

  it('does not append standalone thinking while grouped activity is still active', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        { type: 'text', text: '开始执行命令。' },
        toolPart('cmd-running', 'commandExecution', { status: { type: 'running' } })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        active: true,
        showThinkingFallback: false,
        children: [{ type: 'text' }, { type: 'tool-group', active: true }]
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('keeps a single unphased assistant text as the standalone candidate answer', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [{ type: 'text', text: '只有最终答案。' }]
    })

    expect(model.units).toMatchObject([{ type: 'text', text: '只有最终答案。' }])
  })

  it('keeps active latest tool groups on their active summary instead of generic thinking', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        toolPart('cmd-1', 'commandExecution', { status: { type: 'running' } }),
        toolPart('file-1', 'fileChange', { status: { type: 'running' } })
      ]
    })

    expect(model.units).toHaveLength(1)
    expect(model.units[0]).toMatchObject({
      type: 'tool-group',
      kind: 'composite',
      active: true,
      showThinkingFallback: false
    })
  })

  it('keeps tools waiting for approval on their specific activity summary', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        toolPart('cmd-approval', 'commandExecution', {
          status: { type: 'requires-action', reason: 'approval' }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        active: true,
        showThinkingFallback: false
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('puts thinking fallback on a completed eligible tool group while the turn runs', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [toolPart('cmd-1', 'commandExecution'), toolPart('file-1', 'fileChange')]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'composite',
        active: false,
        showThinkingFallback: true
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('hides thinking while the thread has a blocking request', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [],
      hasBlockingRequest: true
    })

    expect(model.units).toEqual([])
    expect(model.isThinkingOnly).toBe(false)
  })

  it.each([
    {
      name: 'exploration',
      content: [
        toolPart('read-1', 'commandExecution', {
          commandActions: [{ type: 'read', path: '/repo/src/a.ts', command: 'cat src/a.ts' }]
        })
      ],
      kind: 'exploration'
    },
    {
      name: 'web search',
      content: [toolPart('web-1', 'webSearch')],
      kind: 'web-search'
    },
    {
      name: 'multi-agent activity',
      content: [
        toolPart('agent-1', 'collabAgentToolCall'),
        toolPart('agent-2', 'collabAgentToolCall')
      ],
      kind: 'multi-agent'
    }
  ])('uses standalone thinking after completed $name', ({ content, kind }) => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind, active: false, showThinkingFallback: false },
      { type: 'message-thinking', active: true, showThinkingFallback: true }
    ])
  })

  it('keeps adjacent completed and active tools in the same activity group', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        toolPart('cmd-complete', 'commandExecution'),
        toolPart('file-active', 'fileChange', { status: { type: 'running' } })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'composite',
        partIndices: [0, 1],
        status: 'running',
        active: true,
        showThinkingFallback: false
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('keeps the same group key when a second adjacent tool joins a running turn', () => {
    const afterFirstTool = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [toolPart('cmd-complete', 'commandExecution')]
    })
    const whileSecondToolRuns = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        toolPart('cmd-complete', 'commandExecution'),
        toolPart('file-active', 'fileChange', { status: { type: 'running' } })
      ]
    })

    expect(afterFirstTool.units[0]).toMatchObject({
      type: 'tool-group',
      key: 'tool-group:cmd-complete'
    })
    expect(whileSecondToolRuns.units).toHaveLength(1)
    expect(whileSecondToolRuns.units[0]).toMatchObject({
      type: 'tool-group',
      key: 'tool-group:cmd-complete',
      kind: 'composite',
      partIndices: [0, 1]
    })
  })

  it('hides completed low-value internals in steps prose detail level', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      detailLevel: 'stepsProse',
      content: [
        toolPart('sleep-complete', 'sleep'),
        toolPart('loaded-tool-complete', 'loadedTool'),
        toolPart('file-visible', 'fileChange')
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'file-change'
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('groups a loaded tool definition and preserves its name', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [toolPart('load-1', 'loadedTool', { name: 'functions.exec' })]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'generic',
        partIndices: [0],
        summary: {
          label: '已加载 1 个工具定义',
          details: ['已加载工具：functions.exec']
        },
        children: [{ label: 'functions.exec' }]
      }
    ])
  })

  it('keeps active low-value internals visible in steps prose detail level', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      detailLevel: 'stepsProse',
      content: [toolPart('sleep-running', 'sleep', { status: { type: 'running' } })]
    })

    expect(model.units).toMatchObject([
      {
        type: 'entry',
        itemType: 'sleep',
        active: true
      }
    ])
  })

  it('groups consecutive web searches', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [toolPart('web-1', 'webSearch'), toolPart('web-2', 'webSearch')]
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind: 'web-search', partIndices: [0, 1] }
    ])
  })

  it('keeps mixed web search and command activity in a composite tool group', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [toolPart('web-1', 'webSearch'), toolPart('cmd-1', 'commandExecution')]
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind: 'composite', partIndices: [0, 1] }
    ])
  })

  it('groups historical dynamic-tool webSearch parts like live tool-call parts', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        historicalDynamicToolPart('web-1', 'codex_web_search', {
          id: 'web-1',
          type: 'webSearch',
          query: 'codex app server'
        }),
        historicalDynamicToolPart('web-2', 'codex_web_search', {
          id: 'web-2',
          type: 'webSearch',
          query: 'assistant ui'
        })
      ]
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind: 'web-search', partIndices: [0, 1] }
    ])
  })

  it('normalizes read list and search command activity into an exploration entry', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('read-1', 'commandExecution', {
          commandActions: [{ type: 'read', path: '/repo/src/a.ts', command: 'sed -n 1,80p' }]
        }),
        toolPart('list-1', 'commandExecution', {
          commandActions: [{ type: 'listFiles', path: '/repo/src', command: 'ls src' }]
        }),
        toolPart('search-1', 'commandExecution', {
          commandActions: [{ type: 'search', query: 'needle', command: 'rg needle' }]
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'exploration',
        partIndices: [0, 1, 2]
      }
    ])
    expect(model.units[0]?.target.itemIds).toEqual(
      expect.arrayContaining(['read-1', 'list-1', 'search-1'])
    )
    expect(model.units[0]?.type === 'tool-group' ? model.units[0].children : []).toHaveLength(3)
  })

  it('recognizes reference exec parsed command exploration actions', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('exec-read', 'exec', {
          parsedCmd: { type: 'read', path: '/repo/README.md' }
        }),
        toolPart('exec-search', 'exec', {
          parsedCmd: { type: 'search', query: 'renderUnit' }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'exploration',
        partIndices: [0, 1]
      }
    ])
    expect(model.units[0]?.target.itemIds).toEqual(
      expect.arrayContaining(['exec-read', 'exec-search'])
    )
  })

  it('groups live web search tool input before a result item is available', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        {
          type: 'dynamic-tool',
          toolCallId: 'web-live',
          toolName: 'codex_web_search',
          state: 'input-available',
          input: { query: 'live render unit query', action: { type: 'search' } },
          providerExecuted: true
        }
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'web-search',
        active: true,
        partIndices: [0],
        target: { itemIds: ['web-live'] },
        summary: {
          activeSummary: '正在搜索网页：live render unit query',
          details: ['网页搜索：live render unit query']
        }
      }
    ])
  })

  it('does not claim final web search support from completed input-only tool parts', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        {
          type: 'dynamic-tool',
          toolCallId: 'web-input-only',
          toolName: 'codex_web_search',
          state: 'output-available',
          input: { query: 'input only query', action: { type: 'search' } },
          providerExecuted: true
        }
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'dynamic'
      }
    ])
  })

  it('groups historical dynamic-tool MCP parts by app context source metadata', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        historicalDynamicToolPart('mcp-1', 'mcp:github/read', {
          id: 'mcp-1',
          type: 'mcpToolCall',
          server: 'github',
          tool: 'read',
          appContext: {
            connectorId: 'github-app',
            appName: 'GitHub',
            resourceUri: 'app://github'
          }
        }),
        historicalDynamicToolPart('mcp-2', 'mcp:github/write', {
          id: 'mcp-2',
          type: 'mcpToolCall',
          server: 'github',
          tool: 'write',
          appContext: {
            connectorId: 'github-app',
            appName: 'GitHub',
            resourceUri: 'app://github'
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'mcp',
        partIndices: [0, 1],
        mcpSource: {
          sourceType: 'app',
          groupKey: 'app:github-app',
          label: 'GitHub',
          resourceUri: 'app://github'
        }
      }
    ])
  })

  it('uses preliminary dynamic-tool output item for live MCP source before final result arrives', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        {
          type: 'dynamic-tool',
          toolCallId: 'mcp-live',
          toolName: 'mcp:github/read',
          state: 'output-available',
          preliminary: true,
          providerExecuted: true,
          input: { path: 'README.md' },
          output: {
            item: {
              id: 'mcp-live',
              type: 'mcpToolCall',
              server: 'github',
              tool: 'read',
              status: 'inProgress',
              arguments: {},
              appContext: {
                connectorId: 'github-app',
                appName: 'GitHub',
                resourceUri: 'app://github'
              },
              pluginId: 'github-plugin',
              result: null,
              error: null,
              durationMs: null
            }
          }
        }
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'mcp',
        active: true,
        mcpSource: {
          sourceType: 'app',
          groupKey: 'app:github-app',
          label: 'GitHub',
          pluginId: 'github-plugin'
        }
      }
    ])
  })

  it('groups consecutive dynamic tool calls', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [toolPart('dyn-1', 'dynamicToolCall'), toolPart('dyn-2', 'dynamicToolCall')]
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind: 'dynamic', partIndices: [0, 1] }
    ])
  })

  it('renders the safe terminal-read dynamic tool as a standalone labeled activity', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        {
          type: 'dynamic-tool',
          toolCallId: 'terminal-read-1',
          toolName: 'read_thread_terminal',
          state: 'output-available',
          input: {},
          output: { success: true, terminalAttached: false },
          providerExecuted: true
        }
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'dynamic',
        partIndices: [0],
        dynamicMetadata: {
          standaloneInConversation: true,
          displayLabels: [{ completedLabel: '已读取线程终端' }]
        }
      }
    ])
  })

  it('keeps dynamic tool fallback metadata explicit when registry metadata is absent', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        historicalDynamicToolPart('dyn-1', 'lookup', {
          id: 'dyn-1',
          type: 'dynamicToolCall',
          tool: 'lookup',
          arguments: { id: 'A' }
        }),
        historicalDynamicToolPart('dyn-2', 'lookup', {
          id: 'dyn-2',
          type: 'dynamicToolCall',
          tool: 'lookup',
          arguments: { id: 'B' }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'dynamic',
        dynamicMetadata: {
          hasRegistryMetadata: false,
          repeatCount: 2,
          displayLabels: [
            {
              completedLabel: 'Lookup',
              count: 2,
              hasRegistryMetadata: false
            }
          ]
        }
      }
    ])
  })

  it('normalizes successful automation_update dynamic tools into compact entries', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        historicalDynamicToolPart('automation-1', 'automation_update', {
          id: 'automation-1',
          type: 'dynamicToolCall',
          tool: 'automation_update',
          status: 'completed',
          success: true,
          arguments: {
            name: 'daily digest',
            action: 'updated',
            summary: 'daily digest updated'
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'entry',
        itemType: 'automationUpdate',
        renderMode: 'custom',
        item: {
          type: 'automationUpdate',
          name: 'daily digest',
          action: 'updated',
          summary: 'daily digest updated'
        }
      }
    ])
  })

  it('keeps failed automation_update calls in dynamic tool fallback instead of compact success UI', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        historicalDynamicToolPart('automation-1', 'automation_update', {
          id: 'automation-1',
          type: 'dynamicToolCall',
          tool: 'automation_update',
          status: 'completed',
          success: false,
          error: 'permission denied',
          arguments: { name: 'daily digest' }
        })
      ]
    })

    expect(model.units).toMatchObject([{ type: 'tool-group', kind: 'dynamic' }])
  })

  it('marks summary-only dynamic groups as non-expandable render units', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('dyn-1', 'dynamicToolCall', {
          registryMetadata: {
            summaryOnlyInConversationGroup: true,
            completedSummaryKey: 'docs'
          }
        }),
        toolPart('dyn-2', 'dynamicToolCall', {
          registryMetadata: {
            summaryOnlyInConversationGroup: true,
            completedSummaryKey: 'docs'
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'dynamic',
        summaryOnly: true
      }
    ])
  })

  it('keeps completed dynamic groups live between calls while the message runs', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        toolPart('dyn-1', 'dynamicToolCall', {
          registryMetadata: {
            completedSummaryKey: 'docs',
            continuesLiveActivityBetweenCalls: true
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'dynamic',
        active: true,
        showThinkingFallback: false
      }
    ])
    expect(model.units).toHaveLength(1)
  })

  it('groups consecutive MCP tool calls by server', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('mcp-1', 'mcpToolCall', { server: 'github', tool: 'read' }),
        toolPart('mcp-2', 'mcpToolCall', { server: 'github', tool: 'write' })
      ]
    })

    expect(model.units).toMatchObject([{ type: 'tool-group', kind: 'mcp', partIndices: [0, 1] }])
  })

  it('renders a single regular MCP server call through the MCP group renderer', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [toolPart('mcp-1', 'mcpToolCall', { server: 'github', tool: 'read' })]
    })

    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'mcp',
        partIndices: [0],
        mcpSource: {
          sourceType: 'server',
          label: 'github'
        }
      }
    ])
  })

  it('groups consecutive collab agent calls as multi-agent groups', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('agent-1', 'collabAgentToolCall'),
        toolPart('agent-2', 'collabAgentToolCall')
      ]
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind: 'multi-agent', partIndices: [0, 1] }
    ])
  })

  it('groups consecutive subagent activity and keeps the latest event per thread', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        subagentActivityPart('activity-a-started', 'started', 'thread-a', '/root/review_changes'),
        subagentActivityPart('activity-b-started', 'started', 'thread-b', '/root/run-tests'),
        subagentActivityPart('activity-a-updated', 'interacted', 'thread-a', '/root/review_changes')
      ]
    })

    expect(model.units).toHaveLength(1)
    expect(model.units[0]).toMatchObject({
      type: 'subagent-activity-group',
      key: 'subagent-activity-group:activity-a-started',
      partIndices: [0, 1, 2],
      status: 'updated',
      active: true,
      agents: [
        {
          threadId: 'thread-a',
          eventId: 'activity-a-updated',
          agentPath: '/root/review_changes',
          displayName: 'Review changes',
          displayStatus: 'updated'
        },
        {
          threadId: 'thread-b',
          eventId: 'activity-b-started',
          displayName: 'Run tests',
          displayStatus: 'active'
        }
      ]
    })
  })

  it('keeps non-consecutive subagent activity in separate groups', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        subagentActivityPart('activity-a', 'started', 'thread-a', '/root/first'),
        { type: 'text', text: '中间有一条消息。' },
        subagentActivityPart('activity-b', 'interrupted', 'thread-b', '/root/second')
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        turnRunning: false,
        children: [
          { type: 'subagent-activity-group', status: 'active' },
          { type: 'text', text: '中间有一条消息。' },
          { type: 'subagent-activity-group', status: 'interrupted' }
        ]
      }
    ])
  })

  it('projects nine activity events into five groups and eight agent rows', () => {
    const activity = (
      id: string,
      threadId: string,
      kind: 'started' | 'interacted' | 'interrupted',
      path = `/root/${threadId}`
    ): Record<string, unknown> => subagentActivityPart(id, kind, threadId, path)
    const separator = (text: string): Record<string, unknown> => ({ type: 'text', text })
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        activity('g1-a', 'a', 'started'),
        activity('g1-b', 'b', 'started'),
        separator('一'),
        activity('g2-c', 'c', 'started'),
        collabAgentPart('g2-c-wait', {
          tool: 'wait',
          receiverThreadIds: ['c'],
          agentsStates: { c: { status: 'completed', message: 'done' } }
        }),
        separator('二'),
        activity('g3-d-interrupted', 'd', 'interrupted'),
        activity('g3-e', 'e', 'started'),
        activity('g3-d-interacted', 'd', 'interacted'),
        separator('三'),
        activity('g4-f', 'f', 'started'),
        activity('g4-g', 'g', 'started'),
        collabAgentPart('g4-g-wait', {
          tool: 'wait',
          receiverThreadIds: ['g'],
          agentsStates: { g: { status: 'completed', message: 'done' } }
        }),
        separator('四'),
        activity('g5-h', 'h', 'started')
      ]
    })

    const process = model.units[0]
    expect(process).toMatchObject({ type: 'reasoning-group', turnRunning: false })
    const groups =
      process?.type === 'reasoning-group'
        ? process.children.filter((unit) => unit.type === 'subagent-activity-group')
        : []
    expect(groups).toHaveLength(5)
    expect(groups.reduce((count, group) => count + group.agents.length, 0)).toBe(8)
    expect(groups[2]).toMatchObject({
      status: 'updated',
      agents: [
        { threadId: 'd', eventId: 'g3-d-interacted', displayStatus: 'updated' },
        { threadId: 'e', eventId: 'g3-e', displayStatus: 'active' }
      ]
    })
  })

  it('applies collab completion only to the latest activity for the same thread', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        subagentActivityPart('activity-a-first', 'started', 'thread-a', '/root/first-step'),
        { type: 'text', text: '开始下一阶段。' },
        subagentActivityPart('activity-a-latest', 'interacted', 'thread-a', '/root/latest-step'),
        collabAgentPart('wait-status', {
          tool: 'wait',
          receiverThreadIds: ['thread-a'],
          agentsStates: {
            'thread-a': { status: 'completed', message: 'done' }
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'reasoning-group',
        turnRunning: false,
        children: [
          {
            type: 'subagent-activity-group',
            status: 'active',
            agents: [{ threadId: 'thread-a', eventId: 'activity-a-first', displayStatus: 'active' }]
          },
          { type: 'text', text: '开始下一阶段。' },
          {
            type: 'subagent-activity-group',
            status: 'finished',
            agents: [
              {
                threadId: 'thread-a',
                eventId: 'activity-a-latest',
                displayStatus: 'finished'
              }
            ]
          }
        ]
      }
    ])
  })

  it('uses hidden wait state to finish visible subagent activity', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        subagentActivityPart('activity-a', 'started', 'thread-a', '/root/finished-agent'),
        collabAgentPart('wait-status', {
          tool: 'wait',
          receiverThreadIds: ['thread-a'],
          agentsStates: {
            'thread-a': { status: 'completed', message: 'done' }
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'subagent-activity-group',
        status: 'finished',
        agents: [{ threadId: 'thread-a', displayStatus: 'finished' }]
      }
    ])
    expect(model.units).toHaveLength(1)
    expect(JSON.stringify(model.units)).not.toContain('wait-status')
  })

  it('does not invent interrupted activity from an errored wait state', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        subagentActivityPart('activity-a', 'started', 'thread-a', '/root/failed-agent'),
        collabAgentPart('wait-status', {
          tool: 'wait',
          status: 'failed',
          receiverThreadIds: ['thread-a'],
          agentsStates: {
            'thread-a': { status: 'errored', message: 'failed' }
          }
        })
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'subagent-activity-group',
        status: 'active',
        agents: [{ threadId: 'thread-a', displayStatus: 'active' }]
      }
    ])
    expect(JSON.stringify(model.units)).not.toContain('wait-status')
    expect(JSON.stringify(model.units)).not.toContain('"message":"failed"')
  })

  it('does not let a hidden wait call split consecutive activity', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        subagentActivityPart('activity-a', 'started', 'thread-a', '/root/first-agent'),
        collabAgentPart('wait-between', { tool: 'wait' }),
        subagentActivityPart('activity-b', 'interacted', 'thread-b', '/root/second-agent')
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'subagent-activity-group',
        partIndices: [0, 2],
        status: 'updated',
        agents: [{ threadId: 'thread-a' }, { threadId: 'thread-b' }]
      }
    ])
    expect(model.units).toHaveLength(1)
    expect(JSON.stringify(model.units)).not.toContain('wait-between')
  })

  it('reads canonical multi-agent items and filters wait', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        collabAgentPart('spawn-item-tool', { tool: 'spawnAgent' }),
        collabAgentPart('resume-item-tool', {
          tool: 'resumeAgent',
          receiverThreadIds: ['thread-a'],
          agentsStates: {
            'thread-a': { status: 'completed', message: 'resumed' }
          }
        }),
        collabAgentPart('wait-item', { tool: 'wait' })
      ]
    })

    expect(model.units).toMatchObject([
      { type: 'tool-group', kind: 'multi-agent', action: 'spawnAgent' },
      {
        type: 'tool-group',
        kind: 'multi-agent',
        action: 'resumeAgent',
        children: [
          {
            receiverAgents: [
              {
                threadId: 'thread-a',
                status: 'completed',
                message: 'resumed'
              }
            ]
          }
        ]
      }
    ])
    expect(model.units).toHaveLength(2)
    expect(JSON.stringify(model.units)).not.toContain('wait-item')
  })

  it('enriches multi-agent children with activity names and agent state', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        subagentActivityPart(
          'activity-a',
          'started',
          'thread-a',
          '/root/check_uncommitted_changes'
        ),
        collabAgentPart('spawn-a', {
          tool: 'spawnAgent',
          receiverThreadIds: ['thread-a'],
          agentsStates: {
            'thread-a': { status: 'running', message: 'Inspecting files' }
          }
        })
      ]
    })

    expect(model.units[1]).toMatchObject({
      type: 'tool-group',
      kind: 'multi-agent',
      children: [
        {
          action: 'spawnAgent',
          receiverAgents: [
            {
              threadId: 'thread-a',
              displayName: 'Check uncommitted changes',
              status: 'running',
              message: 'Inspecting files'
            }
          ]
        }
      ]
    })
  })

  it('derives readable subagent names from agent paths', () => {
    expect(displayNameForSubagentPath('/root/agent_data-flow')).toBe('Agent data flow')
    expect(displayNameForSubagentPath('/root')).toBe('子 agent')
  })

  it('keeps stable keys and target ids for grouped internal items', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'complete' },
      content: [
        toolPart('agent-1', 'collabAgentToolCall', { action: 'review' }),
        toolPart('agent-2', 'collabAgentToolCall', { action: 'review' })
      ]
    })

    expect(model.units[0]).toMatchObject({
      key: 'tool-group:agent-1',
      target: {
        id: 'render-unit-tool-group-agent-1',
        itemIds: ['agent-1', 'agent-2']
      }
    })
  })

  it('uses standalone thinking after renderable unknown content', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [{ type: 'file', mediaType: 'image/png', data: 'abc' }]
    })

    expect(model.isThinkingOnly).toBe(false)
    expect(model.units).toMatchObject([
      { type: 'unknown', showThinkingFallback: false },
      { type: 'message-thinking', showThinkingFallback: true }
    ])
  })

  it('preserves agent message phases through the provider and AI SDK UI stream', async () => {
    const mapper = new CodexEventMapper()
    const streamParts = [
      { method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn-phase' } } },
      {
        method: 'item/started',
        params: {
          threadId: 'thr',
          turnId: 'turn-phase',
          item: {
            type: 'agentMessage',
            id: 'commentary',
            text: '',
            phase: 'commentary',
            memoryCitation: null
          }
        }
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr',
          turnId: 'turn-phase',
          itemId: 'commentary',
          delta: '先收集实际证据。'
        }
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thr',
          turnId: 'turn-phase',
          item: {
            type: 'agentMessage',
            id: 'commentary',
            text: '先收集实际证据。',
            phase: 'commentary',
            memoryCitation: null
          }
        }
      },
      {
        method: 'item/started',
        params: {
          threadId: 'thr',
          turnId: 'turn-phase',
          item: {
            type: 'agentMessage',
            id: 'final',
            text: '',
            phase: 'final_answer',
            memoryCitation: null
          }
        }
      },
      {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thr',
          turnId: 'turn-phase',
          itemId: 'final',
          delta: '## 结论\n\n根因已确认。'
        }
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'thr',
          turnId: 'turn-phase',
          item: {
            type: 'agentMessage',
            id: 'final',
            text: '## 结论\n\n根因已确认。',
            phase: 'final_answer',
            memoryCitation: null
          }
        }
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thr',
          turn: { id: 'turn-phase', items: [], status: 'completed', error: null }
        }
      }
    ].flatMap((event) => mapper.map(event))

    const aiSdkParts = await messagePartsFromProviderStreamParts(streamParts)

    expect(aiSdkParts).toMatchObject([
      { type: 'step-start' },
      {
        type: 'text',
        text: '先收集实际证据。',
        providerMetadata: {
          [LEGACY_CODEX_MESSAGE_METADATA_KEY]: { messagePhase: 'commentary' }
        }
      },
      {
        type: 'text',
        text: '## 结论\n\n根因已确认。',
        providerMetadata: {
          [LEGACY_CODEX_MESSAGE_METADATA_KEY]: { messagePhase: 'final_answer' }
        }
      }
    ])
  })

  it('keeps provider mapper MCP lifecycle as one Render-Unit with completed source metadata', async () => {
    const mapper = new CodexEventMapper()
    const startedItem = {
      type: 'mcpToolCall',
      id: 'mcp-chain',
      server: 'github',
      tool: 'read',
      status: 'inProgress',
      arguments: { path: 'README.md' },
      appContext: {
        connectorId: 'github-app',
        appName: 'GitHub',
        resourceUri: 'app://github'
      },
      pluginId: 'github-plugin',
      result: null,
      error: null,
      durationMs: null
    }
    const completedItem = {
      ...startedItem,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'ok' }], isError: false },
      durationMs: 30
    }
    const streamParts = [
      { method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn' } } },
      { method: 'item/started', params: { threadId: 'thr', turnId: 'turn', item: startedItem } },
      {
        method: 'item/mcpToolCall/progress',
        params: { threadId: 'thr', turnId: 'turn', itemId: 'mcp-chain', message: 'Reading...' }
      },
      { method: 'item/completed', params: { threadId: 'thr', turnId: 'turn', item: completedItem } }
    ].flatMap((event) => mapper.map(event))
    streamParts.push(
      ...mapper.map({
        method: 'turn/completed',
        params: {
          threadId: 'thr',
          turn: { id: 'turn', items: [], status: 'completed', error: null }
        }
      })
    )

    const aiSdkParts = await messagePartsFromProviderStreamParts(streamParts)
    const model = buildAssistantRenderUnits({ status: { type: 'complete' }, content: aiSdkParts })

    expect(aiSdkParts).toMatchObject([
      { type: 'step-start' },
      {
        type: 'dynamic-tool',
        toolCallId: 'mcp-chain',
        state: 'output-available',
        output: { item: completedItem }
      }
    ])
    expect(model.units).toMatchObject([
      {
        type: 'tool-group',
        kind: 'mcp',
        partIndices: [1],
        mcpSource: {
          sourceType: 'app',
          groupKey: 'app:github-app',
          label: 'GitHub'
        },
        summary: {
          label: '已调用 1 个 MCP 工具',
          sourceSummary: 'GitHub'
        }
      }
    ])
  })

  it('maps provider sleep events through real AI SDK UI parts into custom entries', async () => {
    const mapper = new CodexEventMapper()
    const item = { type: 'sleep', id: 'sleep-chain', durationMs: 1000 }
    const streamParts = [
      { method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn' } } },
      { method: 'item/started', params: { threadId: 'thr', turnId: 'turn', item } },
      { method: 'item/completed', params: { threadId: 'thr', turnId: 'turn', item } },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thr',
          turn: { id: 'turn', items: [], status: 'completed', error: null }
        }
      }
    ].flatMap((event) => mapper.map(event))

    const aiSdkParts = await messagePartsFromProviderStreamParts(streamParts)
    const model = buildAssistantRenderUnits({ status: { type: 'complete' }, content: aiSdkParts })

    expect(aiSdkParts).toMatchObject([
      { type: 'step-start' },
      {
        type: 'dynamic-tool',
        toolCallId: 'sleep-chain',
        state: 'output-available',
        output: { item }
      }
    ])
    expect(model.units).toMatchObject([
      {
        type: 'entry',
        itemType: 'sleep',
        renderMode: 'custom',
        summary: { label: '已等待 1 次' }
      }
    ])
  })

  it('maps provider plan updates into live todoList custom entries', async () => {
    const mapper = new CodexEventMapper()
    const streamParts = [
      { method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn-plan' } } },
      {
        method: 'turn/plan/updated',
        params: {
          threadId: 'thr',
          turnId: 'turn-plan',
          explanation: 'Working',
          plan: [
            { step: 'Read files', status: 'completed' },
            { step: 'Patch renderer', status: 'inProgress' }
          ]
        }
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thr',
          turn: { id: 'turn-plan', items: [], status: 'completed', error: null }
        }
      }
    ].flatMap((event) => mapper.map(event))

    const aiSdkParts = await messagePartsFromProviderStreamParts(streamParts)
    const model = buildAssistantRenderUnits({ status: { type: 'running' }, content: aiSdkParts })

    expect(aiSdkParts).toMatchObject([
      { type: 'step-start' },
      {
        type: 'dynamic-tool',
        toolCallId: 'plan:turn-plan:1',
        toolName: 'codex_todo_list',
        state: 'output-available',
        output: {
          item: {
            type: 'todoList',
            items: [
              { label: 'Read files', status: 'completed' },
              { label: 'Patch renderer', status: 'inProgress' }
            ]
          }
        }
      }
    ])
    expect(model.units).toMatchObject([
      {
        type: 'entry',
        itemType: 'todoList',
        renderMode: 'custom',
        active: true
      }
    ])
  })

  it('maps provider turn diff updates into capped turnDiff custom entries', async () => {
    const mapper = new CodexEventMapper()
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n'
    const streamParts = [
      { method: 'turn/started', params: { threadId: 'thr', turn: { id: 'turn-diff' } } },
      {
        method: 'turn/diff/updated',
        params: { threadId: 'thr', turnId: 'turn-diff', diff }
      },
      {
        method: 'turn/completed',
        params: {
          threadId: 'thr',
          turn: { id: 'turn-diff', items: [], status: 'completed', error: null }
        }
      }
    ].flatMap((event) => mapper.map(event))

    const aiSdkParts = await messagePartsFromProviderStreamParts(streamParts)
    const model = buildAssistantRenderUnits({ status: { type: 'complete' }, content: aiSdkParts })

    expect(aiSdkParts).toMatchObject([
      { type: 'step-start' },
      {
        type: 'dynamic-tool',
        toolCallId: 'turn-diff:turn-diff',
        toolName: 'codex_turn_diff',
        state: 'output-available',
        output: { item: { type: 'turnDiff', diff } }
      }
    ])
    expect(model.units).toMatchObject([
      {
        type: 'entry',
        itemType: 'turnDiff',
        renderMode: 'custom',
        active: false
      }
    ])
  })

  it('keeps preliminary dynamic-tool sleep output active while the turn is running', () => {
    const model = buildAssistantRenderUnits({
      status: { type: 'running' },
      content: [
        {
          type: 'dynamic-tool',
          toolCallId: 'sleep-running',
          toolName: 'codex_sleep',
          state: 'output-available',
          preliminary: true,
          output: { item: { type: 'sleep', id: 'sleep-running', durationMs: 1000 } },
          providerExecuted: true
        }
      ]
    })

    expect(model.units).toMatchObject([
      {
        type: 'entry',
        active: true,
        showThinkingFallback: false,
        summary: { label: '正在等待 1 次' }
      }
    ])
  })
})

type CollabAgentThreadItem = Extract<ThreadItem, { type: 'collabAgentToolCall' }>
type SubagentActivityThreadItem = Extract<ThreadItem, { type: 'subAgentActivity' }>

function collabAgentPart(
  id: string,
  overrides: Pick<CollabAgentThreadItem, 'tool'> &
    Partial<Omit<CollabAgentThreadItem, 'type' | 'id' | 'tool'>>
): Record<string, unknown> {
  const item: CollabAgentThreadItem = {
    type: 'collabAgentToolCall',
    id,
    status: 'completed',
    senderThreadId: 'thread-parent',
    receiverThreadIds: [],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
    ...overrides
  }

  return mappedThreadItemPart(item)
}

function subagentActivityPart(
  id: string,
  kind: SubagentActivityThreadItem['kind'],
  agentThreadId: string,
  agentPath: string
): Record<string, unknown> {
  return mappedThreadItemPart({
    type: 'subAgentActivity',
    id,
    kind,
    agentThreadId,
    agentPath
  })
}

function mappedThreadItemPart(
  item: CollabAgentThreadItem | SubagentActivityThreadItem
): Record<string, unknown> {
  const part = mapCodexThreadItemToUiPart(item)
  if (!part) throw new Error(`Expected ${item.type} to map to a UI message part`)
  return part as unknown as Record<string, unknown>
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
    status: overrides.status ?? { type: 'complete' },
    result: { item }
  }
}

function toolNameForItemType(itemType: string, item: Record<string, unknown>): string {
  if (itemType === 'commandExecution') return 'codex_command_execution'
  if (itemType === 'fileChange') return 'codex_file_change'
  if (itemType === 'webSearch') return 'codex_web_search'
  if (itemType === 'mcpToolCall') return `mcp:${item.server ?? 'server'}/${item.tool ?? 'tool'}`
  if (itemType === 'collabAgentToolCall') return 'codex_collab_agent'
  return itemType
}

function historicalDynamicToolPart(
  id: string,
  toolName: string,
  item: Record<string, unknown>
): Record<string, unknown> {
  return {
    type: 'dynamic-tool',
    toolCallId: id,
    toolName,
    state: 'output-available',
    input: {},
    output: { item },
    providerExecuted: true
  }
}

async function messagePartsFromProviderStreamParts(
  parts: readonly LanguageModelV3StreamPart[]
): Promise<Record<string, unknown>[]> {
  const result = streamText({
    model: new MockUiStreamModel(parts),
    prompt: 'render unit test'
  })

  let lastMessage: UIMessage | undefined
  for await (const message of readUIMessageStream({
    stream: result.toUIMessageStream({
      sendReasoning: true
    }),
    onError(error) {
      throw error
    }
  })) {
    lastMessage = message
  }

  return (lastMessage?.parts ?? []) as Record<string, unknown>[]
}

class MockUiStreamModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3'
  readonly provider = 'test'
  readonly modelId = 'render-unit-test'
  readonly supportedUrls = {}

  constructor(private readonly parts: readonly LanguageModelV3StreamPart[]) {}

  async doGenerate(): Promise<LanguageModelV3GenerateResult> {
    throw new Error('MockUiStreamModel only supports streaming')
  }

  async doStream(): Promise<LanguageModelV3StreamResult> {
    return { stream: streamFromParts(this.parts) }
  }
}

function streamFromParts(
  parts: readonly LanguageModelV3StreamPart[]
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part)
      }
      controller.close()
    }
  })
}
