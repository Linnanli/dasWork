import { LoaderCircleIcon, SquareIcon, TerminalIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  TERMINAL_WORKSPACE_API_VERSION,
  type TerminalWorkspaceEvent,
  type TerminalWorkspaceSessionSnapshot
} from '../../../../shared/terminalWorkspaceApi'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  terminalProcessStatusClass,
  terminalProcessStatusLabel
} from './terminalProcessPresentation'

export function ProcessesWorkspace({
  onOpenTerminal
}: {
  onOpenTerminal?(session: TerminalWorkspaceSessionSnapshot): void
}): React.JSX.Element {
  const sessions = useWindowTerminalSessions()
  const [confirmingStopAll, setConfirmingStopAll] = useState(false)
  const [isStoppingAll, setIsStoppingAll] = useState(false)
  const [operationError, setOperationError] = useState<string>()
  const activeSessions = useMemo(() => sessions.values.filter(isActiveProcess), [sessions.values])

  const stopAll = (): void => {
    setIsStoppingAll(true)
    setOperationError(undefined)
    void Promise.allSettled(
      activeSessions.map((session) =>
        window.desktopApp.workspace.terminal.close({
          version: TERMINAL_WORKSPACE_API_VERSION,
          sessionId: session.sessionId
        })
      )
    )
      .then((results) => {
        const failed = results.filter((result) => result.status === 'rejected')
        for (const result of results) {
          if (result.status === 'fulfilled') sessions.replace(result.value)
        }
        if (failed.length) {
          setOperationError(
            failed.length === activeSessions.length
              ? '无法停止后台进程。'
              : `${failed.length} 个后台进程未能停止。`
          )
        }
      })
      .finally(() => {
        setIsStoppingAll(false)
        setConfirmingStopAll(false)
      })
  }

  return (
    <section data-slot="workspace-processes" className="h-full overflow-y-auto p-4">
      <header className="flex flex-wrap items-center gap-2">
        <div className="flex flex-1 items-center gap-2 text-sm font-medium">
          <TerminalIcon aria-hidden className="size-4 text-muted-foreground" />
          <h2>进程</h2>
        </div>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={!activeSessions.length || isStoppingAll}
          onClick={() => setConfirmingStopAll(true)}
        >
          <SquareIcon aria-hidden className="size-3.5" />
          停止全部运行进程
        </Button>
      </header>
      <p className="mt-2 text-xs text-muted-foreground">仅显示并管理当前应用窗口创建的后台进程。</p>
      {sessions.status === 'loading' ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
          正在读取后台进程…
        </p>
      ) : sessions.values.length ? (
        <ul data-slot="workspace-process-list" className="mt-4 space-y-2">
          {sessions.values.map((session) => (
            <li
              key={session.sessionId}
              data-slot="workspace-process"
              data-process-status={session.status}
              className="rounded-md border border-border/60 bg-muted/15 px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{session.title}</span>
                <span
                  className={cn('shrink-0 text-xs', terminalProcessStatusClass(session.status))}
                >
                  {terminalProcessStatusLabel(session.status)}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={session.cwd}>
                {session.conversationId} · {session.cwd}
              </p>
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-7"
                  onClick={() => onOpenTerminal?.(session)}
                >
                  打开输出
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">当前窗口没有后台进程。</p>
      )}
      {sessions.error || operationError ? (
        <p className="mt-3 text-xs text-destructive">{operationError ?? sessions.error}</p>
      ) : null}

      <Dialog
        open={confirmingStopAll}
        onOpenChange={(open) => {
          if (!isStoppingAll) setConfirmingStopAll(open)
        }}
      >
        <DialogContent
          data-slot="workspace-stop-all-processes-dialog"
          showCloseButton={!isStoppingAll}
        >
          <DialogHeader>
            <DialogTitle>停止全部运行进程？</DialogTitle>
            <DialogDescription>
              这会停止当前应用窗口中的 {activeSessions.length} 个运行中或正在启动的后台进程。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isStoppingAll}
              onClick={() => setConfirmingStopAll(false)}
            >
              取消
            </Button>
            <Button type="button" variant="destructive" disabled={isStoppingAll} onClick={stopAll}>
              {isStoppingAll ? '正在停止…' : '停止全部'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

type WindowTerminalSessions = {
  status: 'loading' | 'ready'
  values: readonly TerminalWorkspaceSessionSnapshot[]
  error?: string
  replace(session: TerminalWorkspaceSessionSnapshot): void
}

function useWindowTerminalSessions(): WindowTerminalSessions {
  const [state, setState] = useState<Omit<WindowTerminalSessions, 'replace'>>(() => {
    const terminal = window.desktopApp?.workspace?.terminal
    return terminal
      ? { status: 'loading', values: [] }
      : { status: 'ready', values: [], error: '终端服务不可用。' }
  })

  useEffect(() => {
    let cancelled = false
    const terminal = window.desktopApp?.workspace?.terminal
    if (!terminal) return undefined

    const replace = (session: TerminalWorkspaceSessionSnapshot): void => {
      setState((current) => ({
        ...current,
        values: replaceSession(current.values, session)
      }))
    }
    const refresh = async (): Promise<void> => {
      try {
        const result = await terminal.list({ version: TERMINAL_WORKSPACE_API_VERSION })
        if (!cancelled) setState({ status: 'ready', values: orderSessions(result.sessions) })
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'ready',
            values: [],
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
  }, [])

  return {
    ...state,
    replace: (session) =>
      setState((current) => ({ ...current, values: replaceSession(current.values, session) }))
  }
}

function replaceSession(
  sessions: readonly TerminalWorkspaceSessionSnapshot[],
  session: TerminalWorkspaceSessionSnapshot
): TerminalWorkspaceSessionSnapshot[] {
  return orderSessions([
    ...sessions.filter((candidate) => candidate.sessionId !== session.sessionId),
    session
  ])
}

function orderSessions(
  sessions: readonly TerminalWorkspaceSessionSnapshot[]
): TerminalWorkspaceSessionSnapshot[] {
  return [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

function isActiveProcess(session: TerminalWorkspaceSessionSnapshot): boolean {
  return session.status === 'starting' || session.status === 'running'
}
