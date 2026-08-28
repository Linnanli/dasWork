import {
  BotIcon,
  CircleAlertIcon,
  HardDriveIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareIcon,
  TargetIcon,
  TerminalIcon,
  Trash2Icon
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ThreadGoalStatus } from '../../../../shared/codexIpcApi'
import type {
  ProjectAction,
  ProjectActionScope,
  ProjectState
} from '../../../../shared/projects/projectTypes'
import { projectActionScopeKey } from '../../../../shared/projects/projectTypes'
import {
  TERMINAL_WORKSPACE_API_VERSION,
  type TerminalWorkspaceEvent,
  type TerminalWorkspaceSessionSnapshot,
  type TerminalWorkspaceTarget
} from '../../../../shared/terminalWorkspaceApi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { projectActionScopeForTask } from '@/projects/projectActions'

import type { WorkspaceTaskAgent, WorkspaceTaskSummary } from './taskWorkspaceTypes'
import {
  isRestartableTerminalProcess,
  terminalProcessStatusClass,
  terminalProcessStatusLabel
} from './terminalProcessPresentation'

export function TaskWorkspace({
  summary,
  target,
  onOpenConversation,
  onOpenTerminal
}: {
  summary?: WorkspaceTaskSummary
  target?: TerminalWorkspaceTarget
  onOpenConversation?(conversationId: string): void
  onOpenTerminal?(session?: TerminalWorkspaceSessionSnapshot): void
}): React.JSX.Element {
  const terminalSessions = useTaskTerminalSessions(target)
  const projectActions = useTaskProjectActions(summary)

  if (!summary) {
    return (
      <div
        data-slot="workspace-task-summary-empty"
        className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <ListTodoIcon aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">打开一个任务后可在这里查看摘要。</p>
      </div>
    )
  }

  const title = summary.title?.trim() || '当前任务'
  const goal = summary.goal

  return (
    <section data-slot="workspace-task-summary" className="h-full overflow-y-auto p-4">
      <div className="space-y-5">
        <header>
          <div className="flex items-center gap-2 text-sm font-medium">
            <ListTodoIcon aria-hidden className="size-4 text-muted-foreground" />
            <h2>任务摘要</h2>
          </div>
          <p className="mt-2 break-words text-base font-medium text-foreground">{title}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span data-slot="workspace-task-status">状态：{taskStatusLabel(summary.status)}</span>
            <span>消息：{summary.messageCount}</span>
          </div>
        </header>

        <TaskSection icon={<TargetIcon aria-hidden className="size-4" />} title="目标">
          {goal ? (
            <>
              <p className="whitespace-pre-wrap text-sm text-foreground/90">{goal.objective}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                {goalStatusLabel(goal.status)}
                {goal.tokenBudget === null
                  ? ` · 已使用 ${goal.tokensUsed} tokens`
                  : ` · ${goal.tokensUsed} / ${goal.tokenBudget} tokens`}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">尚未设置任务目标。</p>
          )}
        </TaskSection>

        <TaskEnvironment summary={summary} state={projectActions.projectState} />

        <TaskSection icon={<BotIcon aria-hidden className="size-4" />} title="子代理">
          {summary.agents.length ? (
            <ul data-slot="workspace-task-agents" className="space-y-2">
              {summary.agents.map((agent) => (
                <TaskAgentRow
                  key={agent.eventId}
                  agent={agent}
                  onOpenConversation={onOpenConversation}
                />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">这个任务尚未启动子代理。</p>
          )}
        </TaskSection>

        <TaskTerminalProcesses
          sessions={terminalSessions}
          onOpenTerminal={onOpenTerminal}
          target={target}
        />

        <TaskProjectActions
          summary={summary}
          target={target}
          scope={projectActions.scope}
          actions={projectActions.actions}
          onUpsert={projectActions.upsert}
          onRemove={projectActions.remove}
          onOpenTerminal={onOpenTerminal}
        />
      </div>
    </section>
  )
}

type TaskProjectActionsState = {
  projectState?: ProjectState
  scope?: ProjectActionScope
  actions: readonly ProjectAction[]
  upsert(input: {
    scope: ProjectActionScope
    action: Pick<ProjectAction, 'title' | 'command'> & { id?: string }
  }): Promise<void>
  remove(input: { scope: ProjectActionScope; actionId: string }): Promise<void>
}

function useTaskProjectActions(summary: WorkspaceTaskSummary | undefined): TaskProjectActionsState {
  const [state, setState] = useState<ProjectState>()

  useEffect(() => {
    const projects = window.desktopApp?.projects
    if (!projects) return
    let cancelled = false
    const stateRequest = projects.getState()
    if (stateRequest && typeof stateRequest.then === 'function') {
      void stateRequest.then((nextState) => {
        if (!cancelled) setState(nextState)
      })
    }
    const unsubscribe = projects.onStateChange((nextState) => setState(nextState))
    return () => {
      cancelled = true
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const scope =
    state && summary
      ? projectActionScopeForTask(state, {
          conversationId: summary.conversationId,
          ...(summary.threadId ? { threadId: summary.threadId } : {}),
          ...(summary.projectSelection ? { projectSelection: summary.projectSelection } : {})
        })
      : undefined
  const actions = scope && state ? (state.projectActions?.[projectActionScopeKey(scope)] ?? []) : []

  return {
    projectState: state,
    scope,
    actions,
    upsert: async (input) => {
      const upsertAction = window.desktopApp.projects.upsertAction
      if (!upsertAction) throw new Error('当前版本不支持保存可复用操作。')
      const nextState = await upsertAction(input)
      setState(nextState)
    },
    remove: async (input) => {
      const removeAction = window.desktopApp.projects.removeAction
      if (!removeAction) throw new Error('当前版本不支持删除可复用操作。')
      const nextState = await removeAction(input)
      setState(nextState)
    }
  }
}

function TaskEnvironment({
  summary,
  state
}: {
  summary: WorkspaceTaskSummary
  state?: ProjectState
}): React.JSX.Element {
  const environment = taskEnvironmentPresentation(summary, state)
  return (
    <TaskSection icon={<HardDriveIcon aria-hidden className="size-4" />} title="执行环境">
      <dl data-slot="workspace-task-environment" className="space-y-2 text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-muted-foreground">目标</dt>
          <dd className="text-right text-foreground">{environment.target}</dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-muted-foreground">位置</dt>
          <dd className="max-w-[70%] break-all text-right text-foreground">{environment.location}</dd>
        </div>
        {environment.branch ? (
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">分支</dt>
            <dd className="text-right text-foreground">{environment.branch}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">{environment.capability}</p>
    </TaskSection>
  )
}

function taskEnvironmentPresentation(
  summary: WorkspaceTaskSummary,
  state: ProjectState | undefined
): {
  target: string
  location: string
  branch?: string
  capability: string
} {
  const assignment = summary.threadId
    ? state?.threadProjectAssignments[summary.threadId]
    : state?.threadProjectAssignments[summary.conversationId]
  const fallbackLocation = summary.cwd ?? '尚未分配工作目录'

  if (assignment?.projectKind === 'local') {
    const project = state?.localProjects[assignment.projectId]
    const worktree = assignment.managedWorktree
    return {
      target: worktree ? `本地 · 受管 worktree · ${project?.name ?? assignment.projectId}` : `本地 · ${project?.name ?? assignment.projectId}`,
      location: worktree?.worktreePath ?? assignment.cwd ?? fallbackLocation,
      ...(worktree ? { branch: worktree.branch } : {}),
      capability: worktree
        ? '这是应用创建并管理的 Git worktree。'
        : '可在 Git 审核界面使用本地分支操作。'
    }
  }

  if (assignment?.projectKind === 'remote') {
    const project = state?.remoteProjects.find(
      (candidate) => candidate.id === assignment.projectId && candidate.hostId === assignment.hostId
    )
    return {
      target: `远程 · ${project?.label ?? assignment.projectId} · ${assignment.hostId}`,
      location: assignment.cwd ?? fallbackLocation,
      capability: '远程执行目标由已配置主机提供；当前任务页不会伪造本地分支或 worktree 操作。'
    }
  }

  if (summary.projectSelection?.projectKind === 'path') {
    return {
      target: '本地 · 已注册路径',
      location: summary.projectSelection.path,
      capability: '仅当该路径是 Git 仓库时，Git 审核界面才会提供分支操作。'
    }
  }

  if (summary.projectSelection?.projectKind === 'remote') {
    return {
      target: `远程 · ${summary.projectSelection.projectId} · ${summary.projectSelection.hostId}`,
      location: fallbackLocation,
      capability: '远程项目尚未返回可验证的工作目录。'
    }
  }

  if (summary.projectSelection?.projectKind === 'local') {
    const project = state?.localProjects[summary.projectSelection.projectId]
    return {
      target: `本地 · ${project?.name ?? summary.projectSelection.projectId}`,
      location: fallbackLocation,
      capability: '可在 Git 审核界面使用本地分支操作。'
    }
  }

  return {
    target: '项目外工作区',
    location: fallbackLocation,
    capability: '此任务未关联 Git 项目，因此不能选择分支或 worktree。'
  }
}

function TaskProjectActions({
  summary,
  target,
  scope,
  actions,
  onUpsert,
  onRemove,
  onOpenTerminal
}: {
  summary: WorkspaceTaskSummary
  target?: TerminalWorkspaceTarget
  scope?: ProjectActionScope
  actions: readonly ProjectAction[]
  onUpsert: TaskProjectActionsState['upsert']
  onRemove: TaskProjectActionsState['remove']
  onOpenTerminal?(session?: TerminalWorkspaceSessionSnapshot): void
}): React.JSX.Element {
  const [draft, setDraft] = useState<ProjectActionDraft>()
  const [runningActionId, setRunningActionId] = useState<string>()
  const [operationError, setOperationError] = useState<string>()

  const save = (): void => {
    if (!scope || !draft) return
    setOperationError(undefined)
    void onUpsert({
      scope,
      action: {
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title,
        command: draft.command
      }
    })
      .then(() => setDraft(undefined))
      .catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : '无法保存操作。')
      )
  }

  const remove = (action: ProjectAction): void => {
    if (!scope) return
    setOperationError(undefined)
    void onRemove({ scope, actionId: action.id }).catch((error: unknown) =>
      setOperationError(error instanceof Error ? error.message : '无法删除操作。')
    )
  }

  const run = (action: ProjectAction): void => {
    if (!target) return
    setRunningActionId(action.id)
    setOperationError(undefined)
    const sessionId = `action:${randomWorkspaceId()}`
    void window.desktopApp.workspace.terminal
      .create({
        version: TERMINAL_WORKSPACE_API_VERSION,
        sessionId,
        workspaceId: `actions:${summary.conversationId}`,
        target,
        cols: 120,
        rows: 30,
        purpose: 'action'
      })
      .then(async (session) => {
        await window.desktopApp.workspace.terminal.runAction({
          version: TERMINAL_WORKSPACE_API_VERSION,
          sessionId,
          command: action.command,
          title: action.title
        })
        onOpenTerminal?.({
          ...session,
          purpose: 'action',
          fixedTitle: action.title,
          title: action.title
        })
      })
      .catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : '无法运行操作。')
      )
      .finally(() => setRunningActionId(undefined))
  }

  return (
    <TaskSection icon={<PlayIcon aria-hidden className="size-4" />} title="可复用操作">
      {!scope ? (
        <p className="text-sm text-muted-foreground">此任务没有可配置操作的已注册项目。</p>
      ) : (
        <>
          {actions.length ? (
            <ul data-slot="workspace-task-actions" className="space-y-2">
              {actions.map((action) => {
                const isRunning = runningActionId === action.id
                return (
                  <li
                    key={action.id}
                    data-slot="workspace-task-action"
                    className="rounded-md border border-border/60 bg-background px-2.5 py-2"
                  >
                    <p className="truncate text-sm font-medium">{action.title}</p>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {action.command}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="h-7"
                        disabled={!target || isRunning}
                        onClick={() => run(action)}
                      >
                        <PlayIcon aria-hidden className="size-3.5" />
                        运行
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7"
                        aria-label={`编辑 ${action.title}`}
                        onClick={() => setDraft(action)}
                      >
                        <PencilIcon aria-hidden className="size-3.5" />
                        编辑
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 text-destructive hover:text-destructive"
                        aria-label={`删除 ${action.title}`}
                        onClick={() => remove(action)}
                      >
                        <Trash2Icon aria-hidden className="size-3.5" />
                        删除
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">还没有保存任何操作。</p>
          )}

          {draft ? (
            <form
              className="mt-3 space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                save()
              }}
            >
              <Input
                aria-label="操作名称"
                value={draft.title}
                maxLength={80}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="例如：运行测试"
              />
              <textarea
                aria-label="操作命令"
                value={draft.command}
                maxLength={32_768}
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                placeholder="例如：npm test"
                className="min-h-20 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!draft.title.trim() || !draft.command.trim()}
                >
                  保存操作
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(undefined)}>
                  取消
                </Button>
              </div>
            </form>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setDraft({ title: '', command: '' })}
            >
              <PlusIcon aria-hidden className="size-3.5" />
              添加操作
            </Button>
          )}
        </>
      )}
      {!target && scope ? (
        <p className="mt-2 text-xs text-muted-foreground">当前任务没有可运行操作的工作目录。</p>
      ) : null}
      {operationError ? <p className="mt-2 text-xs text-destructive">{operationError}</p> : null}
    </TaskSection>
  )
}

type ProjectActionDraft = {
  id?: string
  title: string
  command: string
}

function randomWorkspaceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2)
}

function TaskTerminalProcesses({
  sessions,
  target,
  onOpenTerminal
}: {
  sessions: TaskTerminalSessions
  target?: TerminalWorkspaceTarget
  onOpenTerminal?(session?: TerminalWorkspaceSessionSnapshot): void
}): React.JSX.Element {
  const [operatingSessionId, setOperatingSessionId] = useState<string>()
  const [operationError, setOperationError] = useState<string>()

  const stop = (session: TerminalWorkspaceSessionSnapshot): void => {
    setOperatingSessionId(session.sessionId)
    setOperationError(undefined)
    void window.desktopApp.workspace.terminal
      .close({ version: TERMINAL_WORKSPACE_API_VERSION, sessionId: session.sessionId })
      .then(sessions.replace)
      .catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : '无法停止后台进程。')
      )
      .finally(() => setOperatingSessionId(undefined))
  }

  const restart = (session: TerminalWorkspaceSessionSnapshot): void => {
    if (!target) return
    setOperatingSessionId(session.sessionId)
    setOperationError(undefined)
    void window.desktopApp.workspace.terminal
      .restart({
        version: TERMINAL_WORKSPACE_API_VERSION,
        sessionId: session.sessionId,
        target,
        reason: 'manual'
      })
      .then(sessions.replace)
      .catch((error: unknown) =>
        setOperationError(error instanceof Error ? error.message : '无法重启后台进程。')
      )
      .finally(() => setOperatingSessionId(undefined))
  }

  return (
    <TaskSection icon={<TerminalIcon aria-hidden className="size-4" />} title="后台进程">
      {sessions.status === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          正在读取后台进程…
        </p>
      ) : sessions.values.length ? (
        <ul data-slot="workspace-task-processes" className="space-y-2">
          {sessions.values.map((session) => {
            const isOperating = operatingSessionId === session.sessionId
            return (
              <li
                key={session.sessionId}
                data-slot="workspace-task-process"
                data-process-status={session.status}
                className="rounded-md border border-border/60 bg-background px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {session.title}
                  </span>
                  <span
                    className={cn('shrink-0 text-xs', terminalProcessStatusClass(session.status))}
                  >
                    {terminalProcessStatusLabel(session.status)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7"
                    onClick={() => onOpenTerminal?.(session)}
                  >
                    打开输出
                  </Button>
                  {isRestartableTerminalProcess(session) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      disabled={isOperating || !target}
                      onClick={() => restart(session)}
                    >
                      <RotateCcwIcon aria-hidden className="size-3.5" />
                      重启
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-destructive hover:text-destructive"
                      disabled={isOperating}
                      onClick={() => stop(session)}
                    >
                      <SquareIcon aria-hidden className="size-3.5" />
                      停止
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">这个任务当前没有后台进程。</p>
      )}
      {sessions.error || operationError ? (
        <p className="mt-2 text-xs text-destructive">{operationError ?? sessions.error}</p>
      ) : null}
    </TaskSection>
  )
}

type TaskTerminalSessions = {
  status: 'loading' | 'ready'
  values: readonly TerminalWorkspaceSessionSnapshot[]
  error?: string
  replace(session: TerminalWorkspaceSessionSnapshot): void
}

function useTaskTerminalSessions(
  target: TerminalWorkspaceTarget | undefined
): TaskTerminalSessions {
  const targetKey = target ? `${target.conversationId}\u0000${target.threadId ?? ''}` : undefined
  const [state, setState] = useState<
    Omit<TaskTerminalSessions, 'replace'> & { targetKey?: string }
  >({
    status: 'loading',
    values: []
  })

  useEffect(() => {
    let cancelled = false
    const terminal = window.desktopApp?.workspace?.terminal
    if (!target || !terminal) {
      return () => {
        cancelled = true
      }
    }

    const replace = (session: TerminalWorkspaceSessionSnapshot): void => {
      if (session.conversationId !== target.conversationId) return
      setState((current) => ({
        ...current,
        values: [
          ...current.values.filter((candidate) => candidate.sessionId !== session.sessionId),
          session
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      }))
    }
    const refresh = async (): Promise<void> => {
      try {
        const result = await terminal.list({
          version: TERMINAL_WORKSPACE_API_VERSION,
          target
        })
        if (cancelled) return
        setState({
          status: 'ready',
          values: [...result.sessions].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt)
          ),
          targetKey
        })
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'ready',
            values: [],
            targetKey,
            error: error instanceof Error ? error.message : '无法读取后台进程。'
          })
        }
      }
    }
    const unsubscribe = terminal.onEvent((event: TerminalWorkspaceEvent) => {
      if (event.type !== 'data') replace(event.session)
    })
    void refresh()
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [target, targetKey])

  const replace = (session: TerminalWorkspaceSessionSnapshot): void => {
    if (!target || session.conversationId !== target.conversationId) return
    setState((current) => ({
      ...current,
      values: [
        ...current.values.filter((candidate) => candidate.sessionId !== session.sessionId),
        session
      ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    }))
  }
  if (!target) return { status: 'ready', values: [], replace }
  if (state.targetKey !== targetKey) return { status: 'loading', values: [], replace }
  return { ...state, replace }
}

function TaskSection({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border/60 bg-muted/15 p-3">
      <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function TaskAgentRow({
  agent,
  onOpenConversation
}: {
  agent: WorkspaceTaskAgent
  onOpenConversation?: (conversationId: string) => void
}): React.JSX.Element {
  const content = (
    <>
      {isProblemStatus(agent.displayStatus) ? (
        <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
      ) : (
        <BotIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{agent.displayName}</span>
        <span
          data-slot="workspace-task-agent-role"
          className="block truncate text-xs text-muted-foreground"
        >
          角色：{agentRoleLabel(agent.agentPath)}
        </span>
        {agent.model ? (
          <span
            data-slot="workspace-task-agent-model"
            className="block truncate text-xs text-muted-foreground"
          >
            模型：{agent.model}
          </span>
        ) : null}
      </span>
      <span className={cn('shrink-0 text-xs', agentStatusClass(agent.displayStatus))}>
        {agentStatusLabel(agent.displayStatus)}
      </span>
    </>
  )

  return agent.threadId && onOpenConversation ? (
    <li>
      <button
        type="button"
        data-slot="workspace-task-agent"
        data-agent-thread-id={agent.threadId}
        className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={`打开 ${agent.displayName} 的会话`}
        onClick={() => onOpenConversation(agent.threadId!)}
      >
        {content}
      </button>
    </li>
  ) : (
    <li
      data-slot="workspace-task-agent"
      className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2"
    >
      {content}
    </li>
  )
}

function taskStatusLabel(status: string): string {
  if (status === 'loading') return '正在加载'
  if (status === 'submitted' || status === 'streaming') return '正在运行'
  if (status === 'error') return '需要处理'
  return '就绪'
}

function goalStatusLabel(status: ThreadGoalStatus): string {
  if (status === 'complete') return '已完成'
  if (status === 'paused') return '已暂停'
  if (status === 'blocked') return '已阻塞'
  if (status === 'usageLimited') return '用量受限'
  if (status === 'budgetLimited') return '预算已用尽'
  return '进行中'
}

function agentStatusLabel(status: WorkspaceTaskAgent['displayStatus']): string {
  if (status === 'finished') return '已完成'
  if (status === 'interrupted') return '已中断'
  if (status === 'updated') return '已更新'
  return '正在工作'
}

function isProblemStatus(status: WorkspaceTaskAgent['displayStatus']): boolean {
  return status === 'interrupted'
}

function agentStatusClass(status: WorkspaceTaskAgent['displayStatus']): string {
  if (status === 'interrupted') return 'text-destructive'
  if (status === 'finished') return 'text-emerald-600 dark:text-emerald-400'
  return 'text-muted-foreground'
}

function agentRoleLabel(agentPath: string): string {
  const role = agentPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== 'root')
    .at(-1)
  return role?.replaceAll(/[_-]+/g, ' ') ?? '未提供'
}
