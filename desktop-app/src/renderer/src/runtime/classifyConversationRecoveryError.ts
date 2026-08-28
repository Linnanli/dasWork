export type ConversationRecoveryErrorKind =
  | 'transient-runtime'
  | 'configuration'
  | 'conversation-missing'
  | 'workspace'
  | 'authorization'
  | 'unknown'

export type ConversationRecoveryDiagnostic = {
  readonly kind: ConversationRecoveryErrorKind
  readonly title: string
  readonly action: string
}

export function classifyConversationRecoveryError(
  error: Error | undefined
): ConversationRecoveryDiagnostic | undefined {
  if (!error) return undefined
  const code = recoveryErrorCode(error)
  if (code) return classifyRecoveryCode(code)
  const message = error.message.toLowerCase()
  if (matches(message, ['credential', 'unauthorized', 'forbidden', 'permission denied', 'auth'])) {
    return diagnostic('authorization', '任务需要授权', '请检查登录状态或处理待审批请求。')
  }
  if (matches(message, ['worktree', 'workspace', 'cwd', 'directory'])) {
    return diagnostic('workspace', '工作区不可用', '重新检查项目后再继续。')
  }
  if (matches(message, ['not found', 'does not exist', 'unknown thread', 'missing thread'])) {
    return diagnostic('conversation-missing', '找不到原任务', '已保留历史；请发送一条新消息继续。')
  }
  if (matches(message, ['provider', 'model', 'configuration', 'config'])) {
    return diagnostic('configuration', '模型配置不可用', '检查模型配置后重试。')
  }
  if (matches(message, ['disconnect', 'connect', 'restart', 'timeout', 'unavailable'])) {
    return diagnostic(
      'transient-runtime',
      '任务连接暂时中断',
      '任务仍可能在后台运行；稍后可再次打开此会话。'
    )
  }
  return diagnostic('unknown', '无法重新连接任务', '已保留历史；请发送一条新消息继续。')
}

function classifyRecoveryCode(code: string): ConversationRecoveryDiagnostic {
  switch (code) {
    case 'transport-unavailable':
    case 'app_server_transport_closed':
    case 'app_server_transport_terminated':
      return diagnostic(
        'transient-runtime',
        '任务连接暂时中断',
        '任务仍可能在后台运行；稍后可再次打开此会话。'
      )
    case 'active_turn_unavailable':
    case 'run-unavailable':
    case 'run-mismatch':
      return diagnostic(
        'conversation-missing',
        '找不到原任务',
        '已保留历史；请发送一条新消息继续。'
      )
    case 'journal-unavailable':
    case 'resync-required':
    case 'unknown-recovery':
      return diagnostic('unknown', '无法重新连接任务', '已保留历史；请发送一条新消息继续。')
    default:
      return diagnostic('unknown', '无法重新连接任务', '已保留历史；请发送一条新消息继续。')
  }
}

function recoveryErrorCode(error: Error): string | undefined {
  const candidate = error as Error & { code?: unknown }
  return typeof candidate.code === 'string' ? candidate.code : undefined
}

function matches(message: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => message.includes(fragment))
}

function diagnostic(
  kind: ConversationRecoveryErrorKind,
  title: string,
  action: string
): ConversationRecoveryDiagnostic {
  return { kind, title, action }
}
