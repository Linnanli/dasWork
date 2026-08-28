import { KeyboardIcon, PanelLeftIcon, PlusIcon, PuzzleIcon, SearchIcon } from 'lucide-react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'

export function AppCommandPalette({
  open,
  sidebarCollapsed,
  onFocusTaskSearch,
  onNewConversation,
  onOpenChange,
  onOpenKeyboardShortcuts,
  onOpenPlugins,
  onToggleSidebar
}: {
  open: boolean
  sidebarCollapsed: boolean
  onFocusTaskSearch: () => void
  onNewConversation: () => void
  onOpenChange: (open: boolean) => void
  onOpenKeyboardShortcuts: () => void
  onOpenPlugins: () => void
  onToggleSidebar: () => void
}): React.JSX.Element {
  const run = (action: () => void): void => {
    onOpenChange(false)
    action()
  }

  return (
    <CommandDialog
      open={open}
      title="命令面板"
      description="搜索并执行应用操作"
      onOpenChange={onOpenChange}
    >
      <CommandInput placeholder="搜索命令…" />
      <CommandList>
        <CommandEmpty>没有匹配的命令。</CommandEmpty>
        <CommandGroup heading="任务">
          <CommandItem value="new task 新建任务 新对话" onSelect={() => run(onNewConversation)}>
            <PlusIcon aria-hidden />
            新建任务
          </CommandItem>
          <CommandItem value="search tasks 搜索任务" onSelect={() => run(onFocusTaskSearch)}>
            <SearchIcon aria-hidden />
            搜索任务
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="工作区">
          <CommandItem value="plugins 插件中心" onSelect={() => run(onOpenPlugins)}>
            <PuzzleIcon aria-hidden />
            打开插件中心
          </CommandItem>
          <CommandItem value="sidebar 侧栏" onSelect={() => run(onToggleSidebar)}>
            <PanelLeftIcon aria-hidden />
            {sidebarCollapsed ? '显示侧栏' : '隐藏侧栏'}
          </CommandItem>
          <CommandItem value="keyboard shortcuts 快捷键" onSelect={() => run(onOpenKeyboardShortcuts)}>
            <KeyboardIcon aria-hidden />
            配置键盘快捷键
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
