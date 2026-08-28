import {
  Clock3Icon,
  BoxIcon,
  BookOpenTextIcon,
  FilesIcon,
  GitPullRequestIcon,
  GlobeIcon,
  ListTodoIcon,
  TerminalIcon
} from 'lucide-react'
import type { ComponentType } from 'react'

import { Button } from '@/components/ui/button'

import type { WorkspaceOpenTarget } from '../workspace-container'
import { useRightWorkspace } from './RightWorkspaceProvider'

const entries: Array<{
  label: string
  ariaLabel?: string
  shortcut: string
  icon: ComponentType<{ className?: string }>
  target: WorkspaceOpenTarget
}> = [
  {
    label: '审阅',
    shortcut: '⌘ R',
    icon: GitPullRequestIcon,
    target: { type: 'review' }
  },
  {
    label: 'Pull Request',
    shortcut: '',
    icon: GitPullRequestIcon,
    target: { type: 'pull-request' }
  },
  {
    label: '任务',
    shortcut: '',
    icon: ListTodoIcon,
    target: { type: 'task-summary' }
  },
  {
    label: '时间线',
    shortcut: '',
    icon: Clock3Icon,
    target: { type: 'timeline' }
  },
  {
    label: '产物',
    shortcut: '',
    icon: BoxIcon,
    target: { type: 'outputs' }
  },
  {
    label: '来源',
    shortcut: '',
    icon: BookOpenTextIcon,
    target: { type: 'sources' }
  },
  {
    label: '进程',
    shortcut: '',
    icon: TerminalIcon,
    target: { type: 'processes' }
  },
  {
    label: '终端',
    shortcut: '⌘ T',
    icon: TerminalIcon,
    target: { type: 'terminal' }
  },
  {
    label: '浏览器',
    shortcut: '⌘ B',
    icon: GlobeIcon,
    target: { type: 'browser' }
  },
  {
    label: '文件',
    ariaLabel: 'Open Files',
    shortcut: '',
    icon: FilesIcon,
    target: { type: 'file', relativePath: '' }
  }
]

export function WorkspaceLauncher({
  onOpen
}: {
  onOpen?(target: WorkspaceOpenTarget): void
} = {}): React.JSX.Element {
  const actions = useRightWorkspace()
  const open = onOpen ?? ((target: WorkspaceOpenTarget) => openWithRightWorkspace(actions, target))
  return (
    <div className="flex h-full min-h-80 items-center justify-center px-6 pb-[4%]">
      <div className="w-full max-w-115 space-y-2">
        {entries.map((entry) => {
          const Icon = entry.icon
          return (
            <Button
              key={entry.label}
              type="button"
              variant="secondary"
              size="sm"
              aria-label={entry.ariaLabel}
              className="w-full justify-start text-left active:bg-secondary/70"
              onClick={() => open(entry.target)}
            >
              <Icon className="size-[18px] text-muted-foreground" />
              <span className="flex-1 text-base font-medium">{entry.label}</span>
              {entry.shortcut ? (
                <kbd className="text-xs text-muted-foreground">{entry.shortcut}</kbd>
              ) : null}
            </Button>
          )
        })}
      </div>
    </div>
  )
}

function openWithRightWorkspace(
  actions: ReturnType<typeof useRightWorkspace>,
  target: WorkspaceOpenTarget
): void {
  if (target.type === 'review') return actions.openReview(target.source)
  if (target.type === 'file') return actions.openFile(target.relativePath, target.title)
  // MCP Apps are task-bound and need a validated transcript resource, so they
  // are opened from Sources in the workspace-container rather than this legacy launcher.
  if (target.type === 'mcp-app') return
  actions.openTab(target.type)
}
