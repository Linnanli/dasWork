import { describe, expect, it, vi } from 'vitest'

import { createGithubPullRequestIpcHandlers } from './githubPullRequestIpc'

const target = {
  conversationId: 'conversation-1',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}

describe('createGithubPullRequestIpcHandlers', () => {
  it('validates every renderer payload before invoking the service', async () => {
    const service = {
      getStatus: vi.fn(async () => ({ status: 'unavailable', reason: 'missing', ghInstalled: false })),
      create: vi.fn(),
      comment: vi.fn(),
      submitReview: vi.fn(),
      requestReviewers: vi.fn()
    }
    const handlers = createGithubPullRequestIpcHandlers(service as never)

    await handlers.getStatus({}, { target })
    expect(service.getStatus).toHaveBeenCalledWith(target)
    await expect(handlers.create({}, { target, title: '', body: '', base: 'main', draft: true })).rejects.toThrow()
    await expect(handlers.requestReviewers({}, { target, reviewers: ['unsafe reviewer'] })).rejects.toThrow()
    expect(service.create).not.toHaveBeenCalled()
    expect(service.requestReviewers).not.toHaveBeenCalled()
  })
})
