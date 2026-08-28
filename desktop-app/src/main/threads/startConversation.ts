import type { UIMessage } from 'ai'

import type { ProjectStore } from '../projects/ProjectStore'
import type { ProjectService } from '../projects/ProjectService'
import type { CodexChatRequest } from '../../shared/codexIpcApi'
import type {
  ResolvedExecutionTarget,
  ThreadProjectAssignment
} from '../../shared/projects/projectTypes'

export type ProjectServiceLike = Pick<
  ProjectService,
  'resolveNewThreadTarget' | 'resolveExistingThreadTarget'
>

export type ProjectStoreLike = Pick<ProjectStore, 'getState' | 'setState'>

export type ConversationExecutionTarget = {
  cwd?: string
  runtimeWorkspaceRoots?: string[]
  remoteEnvironment?: {
    environmentId: string
    cwd: string
    execServerUrl: string
  }
}

export type StartConversationResult = {
  executionTarget?: ConversationExecutionTarget
  projectAssignment?: ThreadProjectAssignment
}

export async function startConversation({
  request,
  projectService
}: {
  request: CodexChatRequest
  projectService?: ProjectServiceLike
}): Promise<StartConversationResult> {
  if (!projectService) return {}

  const resolvedTarget = await resolveExecutionTarget({ request, projectService })
  if (!resolvedTarget) return {}

  return {
    executionTarget: toConversationExecutionTarget(resolvedTarget),
    projectAssignment: resolvedTarget.projectAssignment
  }
}

async function resolveExecutionTarget({
  request,
  projectService
}: {
  request: CodexChatRequest
  projectService: ProjectServiceLike
}): Promise<ResolvedExecutionTarget | null> {
  const threadId = request.body?.threadId

  if (threadId) {
    return projectService.resolveExistingThreadTarget({
      conversationId: request.body?.conversationId ?? threadId,
      threadId
    })
  }

  return projectService.resolveNewThreadTarget({
    selection: request.body?.projectSelection,
    prompt: extractLatestUserPrompt(request.messages)
  })
}

export async function persistProjectAssignmentForThread({
  threadId,
  projectStore,
  projectAssignment
}: {
  threadId: string
  projectStore?: ProjectStoreLike
  projectAssignment?: ThreadProjectAssignment
}): Promise<void> {
  if (!projectStore || !projectAssignment) return

  const state = await projectStore.getState()
  await projectStore.setState({
    ...state,
    threadProjectAssignments: {
      ...state.threadProjectAssignments,
      [threadId]: state.threadProjectAssignments[threadId] ?? projectAssignment
    }
  })
}

function toConversationExecutionTarget(
  resolvedTarget: ResolvedExecutionTarget
): ConversationExecutionTarget {
  return {
    ...(resolvedTarget.cwd ? { cwd: resolvedTarget.cwd } : {}),
    ...(resolvedTarget.remoteEnvironment
      ? { remoteEnvironment: resolvedTarget.remoteEnvironment }
      : {}),
    ...(resolvedTarget.workspaceRoots.length > 0
      ? { runtimeWorkspaceRoots: resolvedTarget.workspaceRoots }
      : {})
  }
}

function extractLatestUserPrompt(messages: UIMessage[]): string {
  const latestUserMessage = messages.findLast((message) => message.role === 'user')
  if (!latestUserMessage) return ''

  return latestUserMessage.parts
    .map((part) => {
      if (part.type !== 'text') return ''
      return typeof part.text === 'string' ? part.text : ''
    })
    .filter(Boolean)
    .join('\n')
}
