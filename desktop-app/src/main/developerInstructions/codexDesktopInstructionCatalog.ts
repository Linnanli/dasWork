export type CodexDesktopInstructionSectionId =
  | 'desktop_context'
  | 'workspace_dependencies'
  | 'automations'
  | 'thread_coordination'
  | 'non_technical_ui'
  | 'inline_code_comments'
  | 'heartbeat'
  | 'git'
  | 'projectless'
  | 'writing_blocks'

export type CodexDesktopInstructionCapability =
  | 'workspaceDependencies'
  | 'threadCoordination'
  | 'nonTechnicalUi'
  | 'heartbeat'
  | 'git'
  | 'writingBlocks'
  | 'projectlessAssignment'

export type CodexDesktopInstructionSection = {
  id: CodexDesktopInstructionSectionId
  marker: string
  contentTemplate: string
  defaultEnabled: boolean
  capability?: CodexDesktopInstructionCapability
  toolInstructions?: readonly {
    toolName: string
    content: string
  }[]
}

export const codexDesktopInstructionCatalog: readonly CodexDesktopInstructionSection[] = [
  {
    id: 'desktop_context',
    marker: '# DasCowork desktop context',
    defaultEnabled: true,
    contentTemplate: `# DasCowork desktop context
- You are running inside the DasCowork desktop app, which can display local media and workspace files in responses.

### Images, visuals, and files
- Display local images, videos, and audio with standard Markdown image syntax using an absolute filesystem path, for example: ![alt](/absolute/path.png). Relative paths and plain text paths do not render as media.
- When referencing a code or workspace file, use its full absolute path rather than a relative path.
- If the user asks about an image or asks to create one, show the image in the response when that would help.
- Use Mermaid diagrams when a diagram makes a complex relationship easier to understand. Quote Mermaid node labels that contain punctuation.
- Return web URLs as Markdown links, for example: [label](https://example.com).`
  },
  {
    id: 'workspace_dependencies',
    marker: '### Workspace Dependencies',
    defaultEnabled: false,
    capability: 'workspaceDependencies',
    contentTemplate: `### Workspace Dependencies
- For Word, Excel, PowerPoint, and PDF work, call \`load_workspace_dependencies\` to locate the verified bundled runtime paths before choosing commands.`
  },
  {
    id: 'automations',
    marker: '### Automations',
    defaultEnabled: false,
    contentTemplate: '### Automations',
    toolInstructions: [
      {
        toolName: 'automation_update',
        content:
          '- For recurring automations, reminders, monitors, follow-ups, and thread wakeups, use `automation_update` and follow its schema instead of writing raw automation directives.'
      },
      {
        toolName: 'set_thread_archived',
        content:
          '- When an automation should archive a task after completion, use `set_thread_archived` instead of emitting an archive directive.'
      }
    ]
  },
  {
    id: 'thread_coordination',
    marker: '### Thread Coordination',
    defaultEnabled: false,
    capability: 'threadCoordination',
    contentTemplate: `### Thread Coordination
- Treat task, thread, chat, and conversation as synonyms when they refer to DasCowork. In user-facing replies, use “task”.
- For task management, use the applicable thread-management tool. Create a user-owned task only when the user explicitly asks for one; use subagents for internal subtasks.
- After successfully creating a task, emit \`::created-thread{threadId="..."}\` on its own line in the final response.`
  },
  {
    id: 'non_technical_ui',
    marker: '### Non-technical UI',
    defaultEnabled: false,
    capability: 'nonTechnicalUi',
    contentTemplate: `### Non-technical UI
- The user has requested a non-technical interface. Prefer plain language and focus on outcomes instead of underlying command details unless the user asks for them.`
  },
  {
    id: 'inline_code_comments',
    marker: '### Inline Code Comments',
    defaultEnabled: true,
    contentTemplate: `### Inline Code Comments
- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.
- Emit one directive per inline comment; emit none when there are no actionable inline comments.
- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).
- Optional attributes: start, end (1-based line numbers), priority (0-3).
- file must be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.
- Keep line ranges tight; end defaults to start.
- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}`
  },
  {
    id: 'heartbeat',
    marker: '## Heartbeats',
    defaultEnabled: false,
    capability: 'heartbeat',
    contentTemplate: `## Heartbeats
- A message enclosed in \`<heartbeat>\` is a system-generated proactive check, not a user message. Respond with the required NOTIFY or DONT_NOTIFY heartbeat XML format, and remove obsolete heartbeat automations when the check is no longer useful.`
  },
  {
    id: 'git',
    marker: '### Git',
    defaultEnabled: false,
    capability: 'git',
    contentTemplate: `### Git
- Emit the supported \`::git-*\` directive only in the final response and only after the corresponding Git action has succeeded. Keep directive attributes on one line.`
  },
  {
    id: 'projectless',
    marker: '### Projectless Chat',
    defaultEnabled: false,
    capability: 'projectlessAssignment',
    contentTemplate: `### Projectless Chat
- This task uses a generated workspace. Workspace root: {{workspaceRoot}}. Working directory: {{cwd}}. User-facing deliverables directory: {{outputDirectory}}.
- Prefer answering inline unless files make the result more useful. Store scratch analysis, scripts, drafts, and temporary assets under {{cwd}}. Store user-facing deliverables only under {{outputDirectory}}.
- When referring to saved deliverables in the final response, link only files under {{outputDirectory}}.
- Do not write directly in the home directory unless the user explicitly asks.`
  },
  {
    id: 'writing_blocks',
    marker: '### Writing blocks',
    defaultEnabled: false,
    capability: 'writingBlocks',
    contentTemplate: `### Writing blocks
- Use the supported :::writing{...} block format only for variants that the desktop UI can parse, edit, and copy. Keep all required fields valid for the selected variant.`
  }
]
