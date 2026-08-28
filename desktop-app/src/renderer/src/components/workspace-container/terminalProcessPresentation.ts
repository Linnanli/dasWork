import type { TerminalWorkspaceSessionSnapshot } from '../../../../shared/terminalWorkspaceApi'

export function terminalProcessStatusLabel(
  status: TerminalWorkspaceSessionSnapshot['status']
): string {
  if (status === 'starting') return '正在启动'
  if (status === 'running') return '运行中'
  if (status === 'connection-lost') return '连接断开'
  if (status === 'error') return '出错'
  return '已退出'
}

export function terminalProcessStatusClass(
  status: TerminalWorkspaceSessionSnapshot['status']
): string {
  if (status === 'running') return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'error' || status === 'connection-lost') return 'text-destructive'
  return 'text-muted-foreground'
}

export function isRestartableTerminalProcess(session: TerminalWorkspaceSessionSnapshot): boolean {
  return (
    session.status === 'exited' ||
    session.status === 'error' ||
    session.status === 'connection-lost'
  )
}
