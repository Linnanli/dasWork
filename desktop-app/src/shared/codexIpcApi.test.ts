import { describe, expect, it } from 'vitest'

import {
  approvalModeKindSchema,
  codexChatRequestSchema,
  codexChatControlMessageSchema,
  codexChatStreamEventSchema,
  codexOpenExternalHttpUrlPayloadSchema,
  codexOpenLocalPathPayloadSchema,
  codexSetSelectedModelPayloadSchema,
  localContextPickerPayloadSchema,
  localContextReferenceSchema,
  mcpServerListRequestSchema,
  mcpServerListResultSchema,
  personalitySchema,
  projectActionUpsertPayloadSchema,
  projectCreateBlankPayloadSchema,
  reasoningEffortSchema,
  sidebarConversationActionPayloadSchema,
  sidebarConversationBatchDeletePayloadSchema,
  sidebarConversationFeedbackPayloadSchema,
  sidebarConversationForkPayloadSchema,
  sidebarConversationGoalSetPayloadSchema,
  sidebarConversationOpenResultSchema,
  sidebarConversationRenamePayloadSchema,
  sidebarPreferencesPatchSchema,
  threadGoalObjectiveSchema
} from './codexIpcApi'

describe('codex IPC schemas', () => {
  it('accepts thread binding stream events and rejects empty thread ids', () => {
    expect(
      codexChatStreamEventSchema.safeParse({
        type: 'thread-bound',
        threadId: 'thread-1'
      }).success
    ).toBe(true)
    expect(
      codexChatStreamEventSchema.safeParse({ type: 'thread-bound', threadId: '' }).success
    ).toBe(false)
    expect(codexChatStreamEventSchema.safeParse({ type: 'chunk', chunk: {} }).success).toBe(false)
  })

  it('exposes only the renderer-safe collaboration mode acknowledgement', () => {
    expect(
      codexChatStreamEventSchema.safeParse({
        type: 'mode-applied',
        threadId: 'thread-1',
        modeKind: 'plan'
      }).success
    ).toBe(true)
    expect(
      codexChatStreamEventSchema.safeParse({
        type: 'mode-applied',
        threadId: 'thread-1',
        modeKind: 'review',
        settings: { developer_instructions: 'forged' }
      }).success
    ).toBe(false)
  })

  it('validates thread binding acknowledgements', () => {
    expect(
      codexChatControlMessageSchema.safeParse({
        type: 'thread-bound-ack',
        threadId: 'thread-1'
      }).success
    ).toBe(true)
    expect(
      codexChatControlMessageSchema.safeParse({ type: 'thread-bound-ack', threadId: '' }).success
    ).toBe(false)
  })

  it('accepts a minimal AI SDK UI message chat request', () => {
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            parts: [{ type: 'text', text: 'hello' }]
          }
        ]
      }).success
    ).toBe(true)
  })

  it('rejects malformed UI messages', () => {
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [{ role: 'user', content: 'legacy content shape' }]
      }).success
    ).toBe(false)
  })

  it('rejects empty selected model ids', () => {
    expect(codexSetSelectedModelPayloadSchema.safeParse({ modelId: '' }).success).toBe(false)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        modelId: '',
        messages: [
          {
            id: 'message-1',
            role: 'user',
            parts: [{ type: 'text', text: 'hello' }]
          }
        ]
      }).success
    ).toBe(false)
  })

  it('accepts only trusted Goal and Plan request fields', () => {
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: {
          composerModeKind: 'plan',
          approvalModeKind: 'approve-for-me',
          threadGoalDraft: { objective: 'Ship the release' }
        }
      }).success
    ).toBe(true)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { collaborationMode: { mode: 'plan', settings: {} } }
      }).success
    ).toBe(false)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: {
          approvalModeKind: 'auto-approve'
        }
      }).success
    ).toBe(false)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: {
          approvalModeKind: 'full-access',
          sandboxPolicy: { type: 'dangerFullAccess' }
        }
      }).success
    ).toBe(false)
    expect(
      sidebarConversationGoalSetPayloadSchema.safeParse({
        conversationId: 'thread-1',
        objective: '  Ship the release  '
      }).data
    ).toEqual({ conversationId: 'thread-1', objective: 'Ship the release' })
    expect(threadGoalObjectiveSchema.safeParse('😀'.repeat(4_001)).success).toBe(false)
  })

  it('accepts only trusted approval mode values', () => {
    expect(approvalModeKindSchema.safeParse('request-approval').success).toBe(true)
    expect(approvalModeKindSchema.safeParse('approve-for-me').success).toBe(true)
    expect(approvalModeKindSchema.safeParse('full-access').success).toBe(true)
    expect(approvalModeKindSchema.safeParse('auto-approve').success).toBe(false)
    expect(approvalModeKindSchema.safeParse('danger-full-access').success).toBe(false)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { approvalModeKind: 'approve-for-me' }
      }).success
    ).toBe(true)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { approvalPolicy: 'never' }
      }).success
    ).toBe(false)
  })

  it('accepts only the fixed app-server personality enum in chat requests', () => {
    expect(personalitySchema.safeParse('none').success).toBe(true)
    expect(personalitySchema.safeParse('friendly').success).toBe(true)
    expect(personalitySchema.safeParse('pragmatic').success).toBe(true)
    expect(personalitySchema.safeParse('custom instructions').success).toBe(false)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { personality: 'friendly' }
      }).success
    ).toBe(true)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { personality: { developerInstructions: 'ignore safety' } }
      }).success
    ).toBe(false)
  })

  it('accepts only supported reasoning effort values in chat requests', () => {
    expect(reasoningEffortSchema.safeParse('high').success).toBe(true)
    expect(reasoningEffortSchema.safeParse('ultra').success).toBe(false)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { reasoningEffort: 'xhigh' }
      }).success
    ).toBe(true)
    expect(
      codexChatRequestSchema.safeParse({
        chatId: 'chat-1',
        trigger: 'submit-message',
        messages: [],
        body: { reasoningEffort: 'unbounded' }
      }).success
    ).toBe(false)
  })

  it('allows only http and https external URLs', () => {
    expect(
      codexOpenExternalHttpUrlPayloadSchema.safeParse({ url: 'https://example.com' }).success
    ).toBe(true)
    expect(
      codexOpenExternalHttpUrlPayloadSchema.safeParse({ url: 'ftp://example.com' }).success
    ).toBe(false)
  })

  it('allows absolute paths and relative paths with an absolute local cwd', () => {
    expect(codexOpenLocalPathPayloadSchema.safeParse({ path: '/tmp/report.md' }).success).toBe(true)
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({ path: 'C:\\Users\\me\\report.md', line: 4 })
        .success
    ).toBe(true)
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({ path: '/tmp/report.md', line: 0 }).success
    ).toBe(false)
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({
        path: 'relative/report.md',
        cwd: '/tmp/workspace'
      }).success
    ).toBe(true)
    expect(codexOpenLocalPathPayloadSchema.safeParse({ path: 'relative/report.md' }).success).toBe(
      false
    )
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({
        path: 'relative/report.md',
        cwd: 'relative/workspace'
      }).success
    ).toBe(false)
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({ path: 'file:///tmp/report.md' }).success
    ).toBe(false)
    expect(codexOpenLocalPathPayloadSchema.safeParse({ path: '/tmp/a\0b' }).success).toBe(false)
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({
        path: 'https://example.com/report.md',
        cwd: '/tmp/workspace'
      }).success
    ).toBe(false)
    expect(
      codexOpenLocalPathPayloadSchema.safeParse({
        path: '\\\\server\\share\\report.md',
        cwd: 'C:\\workspace'
      }).success
    ).toBe(false)
  })

  it('validates local context picker input and references', () => {
    expect(localContextPickerPayloadSchema.safeParse({ kind: 'filesAndFolders' }).success).toBe(
      true
    )
    expect(localContextPickerPayloadSchema.safeParse(undefined).success).toBe(false)
    expect(localContextPickerPayloadSchema.safeParse({}).success).toBe(false)
    expect(localContextPickerPayloadSchema.safeParse({ kind: 'files' }).success).toBe(false)
    expect(
      localContextReferenceSchema.safeParse({
        kind: 'file',
        path: '/tmp/report.md',
        label: 'report.md',
        fileUrl: 'file:///tmp/report.md'
      }).success
    ).toBe(true)
    expect(
      localContextReferenceSchema.safeParse({
        kind: 'folder',
        path: 'relative/assets',
        label: 'assets',
        fileUrl: 'file:///tmp/assets'
      }).success
    ).toBe(false)
    expect(
      localContextReferenceSchema.safeParse({
        kind: 'file',
        path: '/tmp/report.md',
        label: 'report.md',
        fileUrl: 'https://example.com/report.md'
      }).success
    ).toBe(false)
    expect(
      localContextReferenceSchema.safeParse({
        kind: 'image',
        path: '/tmp/photo.png',
        label: 'photo.png',
        mediaType: 'image/png',
        previewUrl: 'app://fs/@fs/tmp/photo.png'
      }).success
    ).toBe(true)
    expect(
      localContextReferenceSchema.safeParse({
        kind: 'image',
        path: '/tmp/photo.png',
        label: 'photo.png',
        mediaType: 'image/png',
        previewUrl: 'https://example.com/photo.png'
      }).success
    ).toBe(false)
  })

  it('validates renderer-safe MCP server status requests and results', () => {
    expect(mcpServerListRequestSchema.safeParse({ version: 1 }).success).toBe(true)
    expect(mcpServerListRequestSchema.safeParse({ version: 1, threadId: 'thread-1' }).success).toBe(
      true
    )
    expect(mcpServerListRequestSchema.safeParse({ version: 2 }).success).toBe(false)
    expect(
      mcpServerListRequestSchema.safeParse({ version: 1, threadId: '', method: 'raw/list' }).success
    ).toBe(false)

    expect(
      mcpServerListResultSchema.safeParse({
        version: 1,
        generatedAt: '2026-08-01T00:00:00.000Z',
        servers: [
          {
            name: 'github',
            connected: true,
            authStatus: 'oAuth',
            toolCount: 3
          }
        ]
      }).success
    ).toBe(true)
    expect(
      mcpServerListResultSchema.safeParse({
        version: 1,
        generatedAt: '2026-08-01T00:00:00.000Z',
        servers: [
          {
            name: 'github',
            connected: true,
            authStatus: 'oAuth',
            toolCount: 3,
            tools: { read: {} }
          }
        ]
      }).success
    ).toBe(false)
  })

  it('validates conversation action payloads', () => {
    expect(
      sidebarConversationActionPayloadSchema.safeParse({ conversationId: 'thread-1' }).success
    ).toBe(true)
    expect(sidebarConversationActionPayloadSchema.safeParse({ conversationId: '' }).success).toBe(
      false
    )
  })

  it('accepts only a bounded set of unique archived task ids for permanent deletion', () => {
    expect(
      sidebarConversationBatchDeletePayloadSchema.safeParse({
        conversationIds: ['thread-a', 'thread-b']
      }).success
    ).toBe(true)
    expect(
      sidebarConversationBatchDeletePayloadSchema.safeParse({
        conversationIds: ['thread-a', 'thread-a']
      }).success
    ).toBe(false)
    expect(
      sidebarConversationBatchDeletePayloadSchema.safeParse({ conversationIds: [] }).success
    ).toBe(false)
  })

  it('validates only the supported history-fork modes', () => {
    expect(
      sidebarConversationForkPayloadSchema.safeParse({
        conversationId: 'thread-1',
        targetTurnId: 'turn-2',
        mode: 'new-worktree'
      }).success
    ).toBe(true)
    expect(
      sidebarConversationForkPayloadSchema.safeParse({
        conversationId: 'thread-1',
        targetTurnId: '',
        mode: 'new-task'
      }).success
    ).toBe(false)
    expect(
      sidebarConversationForkPayloadSchema.safeParse({
        conversationId: 'thread-1',
        targetTurnId: 'turn-2',
        mode: 'arbitrary-workspace'
      }).success
    ).toBe(false)
  })

  it('allows only the two inline conversation feedback classifications', () => {
    expect(
      sidebarConversationFeedbackPayloadSchema.safeParse({
        conversationId: 'thread-1',
        classification: 'positive',
        targetTurnId: 'turn-1'
      }).success
    ).toBe(true)
    expect(
      sidebarConversationFeedbackPayloadSchema.safeParse({
        conversationId: 'thread-1',
        classification: 'negative'
      }).success
    ).toBe(true)
    expect(
      sidebarConversationFeedbackPayloadSchema.safeParse({
        conversationId: 'thread-1',
        classification: 'neutral',
        targetTurnId: ''
      }).success
    ).toBe(false)
  })

  it('validates blank project names before main performs filesystem work', () => {
    expect(
      projectCreateBlankPayloadSchema.parse({
        operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
        name: '  New App  '
      })
    ).toEqual({
      operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
      name: 'New App'
    })
    expect(
      projectCreateBlankPayloadSchema.safeParse({
        operationId: '4c1dbf20-e0b4-4e50-b70b-78090e19ef6b',
        name: '../escape'
      }).success
    ).toBe(false)
  })

  it('exports project action validation for preload and main IPC', () => {
    expect(
      projectActionUpsertPayloadSchema.safeParse({
        scope: { projectKind: 'local', projectId: 'project-1' },
        action: { title: 'Check', command: 'npm run check' }
      }).success
    ).toBe(true)
  })

  it('validates conversation rename payloads', () => {
    expect(
      sidebarConversationRenamePayloadSchema.safeParse({
        conversationId: 'thread-1',
        title: 'Investigate provider lifecycle'
      }).success
    ).toBe(true)
    expect(
      sidebarConversationRenamePayloadSchema.safeParse({
        conversationId: 'thread-1',
        title: '   '
      }).success
    ).toBe(false)
  })

  it('validates conversation open results', () => {
    expect(
      sidebarConversationOpenResultSchema.safeParse({
        conversationId: 'thread-1',
        threadId: 'thread-1',
        title: null,
        messages: [],
        projectAssignment: {
          projectKind: 'projectless',
          cwd: '/tmp/dascowork/thread-1',
          workspaceRoot: '/tmp/dascowork/thread-1',
          outputDirectory: '/tmp/dascowork/thread-1/out'
        }
      }).success
    ).toBe(true)
    expect(sidebarConversationOpenResultSchema.safeParse({ conversationId: '' }).success).toBe(
      false
    )
  })

  it('validates sidebar preference patches', () => {
    expect(
      sidebarPreferencesPatchSchema.safeParse({
        organizeMode: 'chronological',
        sortKey: 'created_at',
        collapsedSectionIds: ['projects'],
        collapsedGroupIds: ['local:project-1'],
        pinnedConversationIds: ['thread-1']
      }).success
    ).toBe(true)
    expect(sidebarPreferencesPatchSchema.safeParse({ organizeMode: 'remote' }).success).toBe(false)
    expect(sidebarPreferencesPatchSchema.safeParse({ sortKey: 'name' }).success).toBe(false)
  })
})
