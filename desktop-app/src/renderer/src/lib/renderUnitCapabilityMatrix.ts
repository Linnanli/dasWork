export type EntryRenderMode = 'text' | 'tool' | 'custom' | 'known-null' | 'fallback'

export type EntryFallbackLevel = 'none' | 'intentional' | 'temporary' | 'legacy-tool'

export type RenderUnitCapability = {
  renderMode: EntryRenderMode
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  renderer: string
  fallbackLevel: EntryFallbackLevel
  reason: string
  testOwner: string
  phase2Done?: boolean
  followUp?: string
}

export const RENDER_UNIT_CAPABILITY_MATRIX: Record<string, RenderUnitCapability> = {
  'assistant-message': {
    renderMode: 'text',
    priority: 'P0',
    renderer: 'AssistantText',
    fallbackLevel: 'none',
    reason: 'Assistant prose is rendered as markdown text.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  reasoning: {
    renderMode: 'known-null',
    priority: 'P1',
    renderer: 'None',
    fallbackLevel: 'intentional',
    reason:
      'Internal reasoning summaries are hidden; the visible analysis panel is built from commentary-phase assistant messages and process activity.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  source: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'SourceReferenceCards',
    fallbackLevel: 'none',
    reason:
      'AI SDK source-url and source-document parts are normalized into non-navigating source entries; only validated HTTP(S) URLs may use the host external-open bridge.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  'worked-for': {
    renderMode: 'fallback',
    priority: 'P3',
    renderer: 'ToolFallback',
    fallbackLevel: 'intentional',
    reason:
      'No app-server ThreadItem or provider event currently exposes a stable worked-for display shape for desktop text threads.',
    testOwner: 'renderUnitCapabilityMatrix.test.ts'
  },
  'todo-list': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'TodoListEntryUnit',
    fallbackLevel: 'none',
    reason:
      'Legacy todo-list shape is supported; canonical live data comes from app-server turn/plan/updated mapped to todoList.',
    testOwner: 'App.test.tsx'
  },
  todoList: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'TodoListEntryUnit',
    fallbackLevel: 'none',
    reason:
      'App-server turn/plan/updated notifications map through the provider into live todoList UI parts.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  'user-input-response': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'User input responses have enough label/content data for a compact renderer.',
    testOwner: 'App.test.tsx'
  },
  userInputResponse: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase user-input response shape.',
    testOwner: 'App.test.tsx'
  },
  'mcp-server-elicitation': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'MCP elicitation requests are visible prompts and need a stable label.',
    testOwner: 'App.test.tsx'
  },
  mcpServerElicitation: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase MCP elicitation shape.',
    testOwner: 'App.test.tsx'
  },
  exploration: {
    renderMode: 'tool',
    priority: 'P2',
    renderer: 'ToolGroupUnit',
    fallbackLevel: 'none',
    reason:
      'Read/list/search command activity is normalized into ToolGroup(kind=exploration) with item details in the group body.',
    testOwner: 'App.test.tsx'
  },
  'permission-request': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Permission requests are user-visible decisions and should show reason/scope.',
    testOwner: 'App.test.tsx'
  },
  permissionRequest: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase permission request shape.',
    testOwner: 'App.test.tsx'
  },
  'stream-error': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'ErrorEntryUnit',
    fallbackLevel: 'none',
    reason: 'Stream errors must be visible without expanding generic tool JSON.',
    testOwner: 'App.test.tsx'
  },
  streamError: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'ErrorEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase stream error shape.',
    testOwner: 'App.test.tsx'
  },
  'system-error': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'ErrorEntryUnit',
    fallbackLevel: 'none',
    reason: 'System errors must be visible without expanding generic tool JSON.',
    testOwner: 'App.test.tsx'
  },
  systemError: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'ErrorEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase system error shape.',
    testOwner: 'App.test.tsx'
  },
  'turn-diff': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'TurnDiffEntryUnit',
    fallbackLevel: 'none',
    reason:
      'Legacy turn-diff shape is supported; canonical live data comes from app-server turn/diff/updated mapped to turnDiff.',
    testOwner: 'App.test.tsx'
  },
  turnDiff: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'TurnDiffEntryUnit',
    fallbackLevel: 'none',
    reason:
      'App-server turn/diff/updated notifications map through the provider into capped turnDiff UI parts.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  'remote-task-created': {
    renderMode: 'custom',
    priority: 'P2',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Remote task creation has a compact label/path shape.',
    testOwner: 'App.test.tsx'
  },
  remoteTaskCreated: {
    renderMode: 'custom',
    priority: 'P2',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase remote task shape.',
    testOwner: 'App.test.tsx'
  },
  'personality-changed': {
    renderMode: 'custom',
    priority: 'P2',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Model/personality notices are small status rows.',
    testOwner: 'App.test.tsx'
  },
  personalityChanged: {
    renderMode: 'custom',
    priority: 'P2',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase personality notice shape.',
    testOwner: 'App.test.tsx'
  },
  'model-changed': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Model changes are user-visible status rows.',
    testOwner: 'App.test.tsx'
  },
  modelChanged: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase model change shape.',
    testOwner: 'App.test.tsx'
  },
  'model-rerouted': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Model reroutes are user-visible status rows.',
    testOwner: 'App.test.tsx'
  },
  modelRerouted: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase model reroute shape.',
    testOwner: 'App.test.tsx'
  },
  'context-compaction': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Context compaction is a small completion status row.',
    testOwner: 'App.test.tsx'
  },
  contextCompaction: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase context compaction shape.',
    testOwner: 'App.test.tsx'
  },
  'worktree-init': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Worktree setup has useful path/status data.',
    testOwner: 'App.test.tsx'
  },
  worktreeInit: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase worktree setup shape.',
    testOwner: 'App.test.tsx'
  },
  'automation-update': {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Automation changes are compact status updates.',
    testOwner: 'App.test.tsx'
  },
  automationUpdate: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase automation update shape.',
    testOwner: 'App.test.tsx'
  },
  'automatic-approval-review': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'AutomaticApprovalReviewEntryUnit',
    fallbackLevel: 'none',
    reason: 'Automatic approval review status is a first-class approval signal.',
    testOwner: 'App.test.tsx'
  },
  automaticApprovalReview: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'AutomaticApprovalReviewEntryUnit',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase automatic approval review shape.',
    testOwner: 'App.test.tsx'
  },
  sleep: {
    renderMode: 'custom',
    priority: 'P2',
    renderer: 'CompactEntryUnit',
    fallbackLevel: 'none',
    reason: 'Sleep is a compact wait status row.',
    testOwner: 'App.test.tsx'
  },
  loadedTool: {
    renderMode: 'tool',
    priority: 'P2',
    renderer: 'ToolGroupUnit',
    fallbackLevel: 'none',
    reason: 'Loaded tool activity is grouped with its tool definition details.',
    testOwner: 'toolGroupSummary.test.ts'
  },
  'loaded-tool': {
    renderMode: 'tool',
    priority: 'P2',
    renderer: 'ToolGroupUnit',
    fallbackLevel: 'none',
    reason: 'Kebab-case loaded tool activity is grouped with its tool definition details.',
    testOwner: 'toolGroupSummary.test.ts'
  },
  'subagent-activity': {
    renderMode: 'tool',
    priority: 'P2',
    renderer: 'SubagentActivityGroup',
    fallbackLevel: 'none',
    reason: 'Subagent activity is grouped by adjacent agent timeline events before rendering.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  subAgentActivity: {
    renderMode: 'tool',
    priority: 'P2',
    renderer: 'SubagentActivityGroup',
    fallbackLevel: 'none',
    reason: 'Canonical camelCase activity is rendered through the adjacent activity group.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  'generated-image': {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'GeneratedImageEntryUnit',
    fallbackLevel: 'none',
    reason:
      'Legacy generated-image item shape renders a pending/gallery card; real app-server imageGeneration output is covered by file-part rendering.',
    testOwner: 'App.test.tsx'
  },
  imageGeneration: {
    renderMode: 'custom',
    priority: 'P0',
    renderer: 'GeneratedImageEntryUnit',
    fallbackLevel: 'none',
    reason: 'App-server imageGeneration items map to the generated image renderer.',
    testOwner: 'App.test.tsx'
  },
  endResources: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'EndResourceCardsUnit',
    fallbackLevel: 'none',
    reason:
      'Client-derived endResources retains completed safe local artifacts plus website, Google Drive, and Sites links, then routes each card to its matching safe open action; app-server protocol does not define this ThreadItem.',
    testOwner: 'assistantRenderUnits.test.ts'
  },
  reviewComments: {
    renderMode: 'custom',
    priority: 'P1',
    renderer: 'ReviewCommentsEntryUnit',
    fallbackLevel: 'none',
    reason:
      'Client-derived reviewComments render-unit shape maps into safe file/line navigation rows; app-server protocol does not define this ThreadItem.',
    testOwner: 'App.test.tsx'
  },
  'review-comments': {
    renderMode: 'custom',
    priority: 'P2',
    renderer: 'ReviewCommentsEntryUnit',
    fallbackLevel: 'none',
    reason:
      'Legacy kebab-case review comments render-unit shape remains supported for local conversation data.',
    testOwner: 'App.test.tsx'
  },
  'plan-implementation': {
    renderMode: 'known-null',
    priority: 'P3',
    renderer: 'None',
    fallbackLevel: 'intentional',
    reason: 'Internal plan implementation details duplicate assistant prose.',
    testOwner: 'renderUnitCapabilityMatrix.test.ts'
  },
  'proposed-plan': {
    renderMode: 'known-null',
    priority: 'P3',
    renderer: 'None',
    fallbackLevel: 'intentional',
    reason: 'Proposed plans are rendered through assistant text or plan updates elsewhere.',
    testOwner: 'renderUnitCapabilityMatrix.test.ts'
  },
  userInput: {
    renderMode: 'known-null',
    priority: 'P3',
    renderer: 'None',
    fallbackLevel: 'intentional',
    reason: 'User input is already rendered as the user message body.',
    testOwner: 'renderUnitCapabilityMatrix.test.ts'
  },
  'realtime-transcript': {
    renderMode: 'known-null',
    priority: 'P3',
    renderer: 'None',
    fallbackLevel: 'intentional',
    reason:
      'Realtime transcript exists only as experimental thread/realtime transcript notifications; it is not a persisted text-thread ThreadItem.',
    testOwner: 'renderUnitCapabilityMatrix.test.ts'
  }
}

export const ENTRY_ITEM_RENDER_MODES: Record<string, EntryRenderMode> = Object.fromEntries(
  Object.entries(RENDER_UNIT_CAPABILITY_MATRIX).map(([itemType, capability]) => [
    itemType,
    capability.renderMode
  ])
)

export function renderUnitCapabilityFor(
  itemType: string | undefined
): RenderUnitCapability | undefined {
  if (!itemType) return undefined
  return RENDER_UNIT_CAPABILITY_MATRIX[itemType]
}
