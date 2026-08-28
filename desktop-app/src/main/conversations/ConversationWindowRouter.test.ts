import { describe, expect, it } from 'vitest'

import type { CodexApprovalRequest } from '../../shared/codexIpcApi'
import { ConversationWindowRouter } from './ConversationWindowRouter'

describe('ConversationWindowRouter', () => {
  it('routes a task approval only to the window that owns its thread', () => {
    const router = new ConversationWindowRouter()
    router.bindConversation('draft-task', 101)
    router.bindThread('thread-a', 101)

    const owner = router.bindApproval(approvalRequest('approval-a', 'thread-a'))

    expect(owner).toBe(101)
    expect(router.ownsApproval(101, 'approval-a')).toBe(true)
    expect(router.ownsApproval(202, 'approval-a')).toBe(false)
  })

  it('resolves a source task owner for a child task created later', () => {
    const router = new ConversationWindowRouter()
    router.bindConversation('source-task', 101)

    expect(router.ownerForConversation('source-task')).toBe(101)

    router.bindThread('source-task', 202)
    expect(router.ownerForConversation('source-task')).toBe(101)
  })

  it('does not route unknown approvals and clears a closed window ownership', () => {
    const router = new ConversationWindowRouter()
    router.bindThread('thread-a', 101)
    expect(router.bindApproval(approvalRequest('approval-a', 'thread-a'))).toBe(101)
    expect(router.bindApproval(approvalRequest('approval-b', 'thread-b'))).toBeUndefined()

    router.releaseWindow(101)

    expect(router.ownsApproval(101, 'approval-a')).toBe(false)
    expect(router.bindApproval(approvalRequest('approval-c', 'thread-a'))).toBeUndefined()
  })

  it('forgets settled approvals without dropping the task window ownership', () => {
    const router = new ConversationWindowRouter()
    router.bindThread('thread-a', 101)
    router.bindApproval(approvalRequest('approval-a', 'thread-a'))

    router.releaseApproval('approval-a')

    expect(router.ownsApproval(101, 'approval-a')).toBe(false)
    expect(router.bindApproval(approvalRequest('approval-b', 'thread-a'))).toBe(101)
  })

  it('lets the first reconnecting window claim an unowned running task', () => {
    const router = new ConversationWindowRouter()

    router.claimThreadIfUnowned('thread-a', 202)
    router.claimThreadIfUnowned('thread-a', 303)

    expect(router.bindApproval(approvalRequest('approval-a', 'thread-a'))).toBe(202)
  })
})

function approvalRequest(id: string, threadId: string): CodexApprovalRequest {
  return {
    id,
    kind: 'command',
    createdAt: '2026-08-28T00:00:00.000Z',
    context: { threadId },
    params: {
      threadId,
      networkPolicyScopes: [],
      availableIntents: ['approve', 'decline', 'cancel']
    }
  }
}
