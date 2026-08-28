import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  GitBranchIcon,
  LaptopIcon,
  PlusIcon,
  XIcon
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ProjectSelection, ProjectWorktree } from '../../../shared/projects/projectTypes'
import { CreateBlankProjectDialog } from './CreateBlankProjectDialog'
import { CreateRemoteProjectDialog, type RemoteProjectInput } from './CreateRemoteProjectDialog'
import {
  buildProjectPickerOptions,
  describeProjectSelection,
  filterProjectPickerOptions,
  type ProjectPickerKind
} from './projectPickerModel'
import type { ProjectStateController } from './useProjectState'

type ProjectPickerPage = 'projects' | 'new-project' | 'worktrees'

const projectPickerGroupClassName =
  'py-1 px-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px]'

const projectPickerItemClassName =
  'cursor-pointer rounded-lg px-2.5 py-2 text-left text-popover-foreground/75 transition-colors hover:bg-foreground/5 hover:text-popover-foreground data-[selected=true]:bg-foreground/5 data-[selected=true]:text-popover-foreground dark:hover:bg-foreground/8 dark:data-[selected=true]:bg-foreground/8'

export type ComposerProjectCardProps = {
  activeSelection: ProjectSelection | undefined
  projectState: ProjectStateController
  trailingControl?: ReactNode
}

export function ComposerProjectCard({
  activeSelection,
  projectState,
  trailingControl
}: ComposerProjectCardProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ProjectPickerPage>('projects')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [worktrees, setWorktrees] = useState<ProjectWorktree[] | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createRemoteDialogOpen, setCreateRemoteDialogOpen] = useState(false)
  const state = projectState.state
  const selectionDescription = state
    ? describeProjectSelection(state, activeSelection)
    : {
        kind: 'projectless' as const,
        label: '加载项目…',
        detail: null,
        missing: false
      }
  const isProjectless = selectionDescription.kind === 'projectless'
  const options = useMemo(
    () => (state ? buildProjectPickerOptions(state, activeSelection) : []),
    [activeSelection, state]
  )
  const visibleOptions = useMemo(() => filterProjectPickerOptions(options, query), [options, query])

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setPage('projects')
      setQuery('')
      setError(null)
      setWorktrees(null)
    }
  }

  const finishProjectChange = (): void => {
    setOpen(false)
    setPage('projects')
    setQuery('')
  }

  const runProjectAction = async (action: () => Promise<boolean>): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      if (await action()) finishProjectChange()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    } finally {
      setPending(false)
    }
  }

  const selectProject = (selection: ProjectSelection): void => {
    void runProjectAction(async () => {
      await projectState.selectProject(selection)
      return true
    })
  }

  const pickWorkspaceRoot = (): void => {
    void runProjectAction(async () => Boolean(await projectState.pickWorkspaceRoot()))
  }

  const openWorktreePicker = (): void => {
    if (!activeSelection) return
    setPending(true)
    setError(null)
    void projectState
      .listWorktrees(activeSelection)
      .then((nextWorktrees) => {
        setWorktrees(nextWorktrees)
        setPage('worktrees')
      })
      .catch((actionError: unknown) => {
        setError(actionError instanceof Error ? actionError.message : String(actionError))
      })
      .finally(() => setPending(false))
  }

  const selectWorktree = (worktree: ProjectWorktree): void => {
    if (!activeSelection) return
    void runProjectAction(async () => {
      await projectState.selectWorktree({ source: activeSelection, path: worktree.path })
      return true
    })
  }

  const createBlankProject = async (name: string, operationId: string): Promise<void> => {
    await projectState.createBlankProject(name, operationId)
    finishProjectChange()
  }

  const openCreateDialog = (): void => {
    setOpen(false)
    setCreateDialogOpen(true)
  }

  const openCreateRemoteDialog = (): void => {
    setOpen(false)
    setCreateRemoteDialogOpen(true)
  }

  const createRemoteProject = async (input: RemoteProjectInput): Promise<void> => {
    await projectState.createRemoteProject(input)
    finishProjectChange()
  }

  const triggerLabel = isProjectless ? '选择项目' : `更改项目：${selectionDescription.label}`

  return (
    <>
      <div
        className="mx-6 flex h-10 min-w-0 items-center rounded-t-3xl bg-muted/70 px-5 shadow-[0_-1px_2px_rgba(0,0,0,0.02)]"
        data-slot="composer-project-card-shell"
      >
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <Button
              aria-label={triggerLabel}
              className="min-w-0 max-w-full justify-start rounded-full !font-normal"
              data-slot="composer-project-card"
              disabled={state === null || pending}
              size="sm"
              title={selectionDescription.detail ?? triggerLabel}
              type="button"
              variant="ghost"
            >
              <ProjectIcon
                className="mt-0 size-3 shrink-0 text-muted-foreground"
                kind={selectionDescription.kind}
              />
              <span className="min-w-0 truncate">{selectionDescription.label}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="aui-composer-project-panel overflow-hidden rounded-2xl border border-border bg-popover/90 p-1 font-normal text-popover-foreground shadow-lg backdrop-blur-md"
            collisionPadding={12}
            side="top"
            sideOffset={8}
            onEscapeKeyDown={(event) => {
              if (page === 'projects') return
              event.preventDefault()
              setPage('projects')
            }}
          >
            <Command
              className="rounded-xl bg-transparent font-normal [&_[data-slot=command-input-wrapper]]:h-10 [&_[data-slot=command-input-wrapper]]:border-0 [&_[data-slot=command-input-wrapper]]:px-2.5"
              shouldFilter={false}
            >
              {page === 'projects' ? (
                <>
                  <CommandInput
                    autoFocus
                    placeholder="搜索项目"
                    value={query}
                    onValueChange={setQuery}
                  />
                  <CommandList className="max-h-none overflow-visible">
                    <div className="max-h-[260px] overflow-y-auto">
                      <CommandEmpty className="px-3 py-4 text-muted-foreground">
                        未找到项目
                      </CommandEmpty>
                      <CommandGroup
                        aria-label="项目"
                        className={projectPickerGroupClassName}
                        heading="项目"
                      >
                        {visibleOptions.map((option) => (
                          <CommandItem
                            key={option.id}
                            className={projectPickerItemClassName}
                            disabled={option.missing || pending}
                            value={option.id}
                            onSelect={() => selectProject(option.selection)}
                          >
                            <ProjectIcon kind={option.kind} />
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {option.selected ? (
                              <CheckIcon aria-label="当前项目" className="size-4 text-foreground" />
                            ) : null}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </div>
                    <CommandGroup
                      aria-label="项目操作"
                      className={projectPickerGroupClassName}
                      heading="操作"
                    >
                      {isProjectless ? null : (
                        <CommandItem
                          className={projectPickerItemClassName}
                          disabled={pending}
                          value="projectless"
                          onSelect={() => selectProject({ projectKind: 'projectless' })}
                        >
                          <XIcon className="size-4" />
                          <span>不在项目中工作</span>
                        </CommandItem>
                      )}
                      {activeSelection &&
                      !isProjectless &&
                      activeSelection.projectKind !== 'remote' ? (
                        <CommandItem
                          className={projectPickerItemClassName}
                          disabled={pending}
                          value="select-git-worktree"
                          onSelect={openWorktreePicker}
                        >
                          <GitBranchIcon className="size-4" />
                          <span>选择 Git worktree</span>
                          <ChevronRightIcon className="ml-auto size-4" />
                        </CommandItem>
                      ) : null}
                      <CommandItem
                        className={projectPickerItemClassName}
                        disabled={pending}
                        value="new-project"
                        onSelect={() => {
                          setError(null)
                          setPage('new-project')
                        }}
                      >
                        <PlusIcon className="size-4" />
                        <span>新建项目</span>
                        <ChevronRightIcon className="ml-auto size-4" />
                      </CommandItem>
                    </CommandGroup>
                    {error ? (
                      <p className="px-3 pb-3 text-sm text-destructive" role="alert">
                        {error}
                      </p>
                    ) : null}
                  </CommandList>
                </>
              ) : page === 'new-project' ? (
                <CommandList className="max-h-none overflow-visible">
                  <div className="flex items-center gap-2 px-1.5 py-1">
                    <button
                      aria-label="返回项目列表"
                      className="grid size-8 place-items-center rounded-lg text-popover-foreground/75 outline-none transition-colors hover:bg-foreground/5 hover:text-popover-foreground focus-visible:bg-foreground/5 dark:hover:bg-foreground/8 dark:focus-visible:bg-foreground/8"
                      type="button"
                      onClick={() => setPage('projects')}
                    >
                      <ChevronLeftIcon className="size-4" />
                    </button>
                    <span className="text-sm font-normal">新建项目</span>
                  </div>
                  <CommandGroup className={projectPickerGroupClassName} heading="创建方式">
                    <CommandItem
                      className={projectPickerItemClassName}
                      value="new-blank-project"
                      onSelect={openCreateDialog}
                    >
                      <PlusIcon className="size-4" />
                      <span>新建空白项目</span>
                    </CommandItem>
                    <CommandItem
                      className={projectPickerItemClassName}
                      value="use-existing-folder"
                      onSelect={pickWorkspaceRoot}
                    >
                      <FolderOpenIcon className="size-4" />
                      <span>使用现有文件夹</span>
                    </CommandItem>
                    <CommandItem
                      className={projectPickerItemClassName}
                      value="connect-remote-project"
                      onSelect={openCreateRemoteDialog}
                    >
                      <LaptopIcon className="size-4" />
                      <span>连接远程项目</span>
                    </CommandItem>
                  </CommandGroup>
                  {error ? (
                    <p className="px-3 pb-3 text-sm text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                </CommandList>
              ) : (
                <CommandList className="max-h-none overflow-visible">
                  <div className="flex items-center gap-2 px-1.5 py-1">
                    <button
                      aria-label="返回项目列表"
                      className="grid size-8 place-items-center rounded-lg text-popover-foreground/75 outline-none transition-colors hover:bg-foreground/5 hover:text-popover-foreground focus-visible:bg-foreground/5 dark:hover:bg-foreground/8 dark:focus-visible:bg-foreground/8"
                      type="button"
                      onClick={() => setPage('projects')}
                    >
                      <ChevronLeftIcon className="size-4" />
                    </button>
                    <span className="text-sm font-normal">选择 Git worktree</span>
                  </div>
                  <CommandGroup
                    className={projectPickerGroupClassName}
                    heading="当前项目的 worktree"
                  >
                    {worktrees?.map((worktree) => (
                      <CommandItem
                        key={worktree.path}
                        className={projectPickerItemClassName}
                        disabled={pending}
                        value={worktree.path}
                        onSelect={() => selectWorktree(worktree)}
                      >
                        <GitBranchIcon className="size-4" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {worktree.branch ?? 'Detached HEAD'}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {worktree.path}
                          </span>
                        </span>
                        {worktree.isCurrent ? (
                          <CheckIcon
                            aria-label="当前 worktree"
                            className="size-4 text-foreground"
                          />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                  {worktrees?.length === 0 ? (
                    <CommandEmpty className="px-3 py-4 text-muted-foreground">
                      当前项目没有可用的 Git worktree
                    </CommandEmpty>
                  ) : null}
                  {error ? (
                    <p className="px-3 pb-3 text-sm text-destructive" role="alert">
                      {error}
                    </p>
                  ) : null}
                </CommandList>
              )}
            </Command>
          </PopoverContent>
        </Popover>
        {trailingControl}
      </div>
      <CreateBlankProjectDialog
        open={createDialogOpen}
        onCreate={createBlankProject}
        onOpenChange={setCreateDialogOpen}
      />
      <CreateRemoteProjectDialog
        open={createRemoteDialogOpen}
        onCreate={createRemoteProject}
        onOpenChange={setCreateRemoteDialogOpen}
      />
    </>
  )
}

function ProjectIcon({
  className = 'mt-0.5 size-4 shrink-0 text-muted-foreground',
  kind
}: {
  className?: string
  kind: ProjectPickerKind | 'projectless'
}): React.JSX.Element {
  if (kind === 'remote') {
    return <LaptopIcon className={className} />
  }
  return <FolderIcon className={className} />
}
