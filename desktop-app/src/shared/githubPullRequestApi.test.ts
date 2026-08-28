import { describe, expect, it } from 'vitest'

import {
  githubPullRequestCreateRequestSchema,
  githubPullRequestStatusResultSchema
} from './githubPullRequestApi'

const target = {
  conversationId: 'conversation-1',
  hostId: 'local',
  cwd: '/repo',
  gitRoot: '/repo'
}

describe('github pull request IPC schemas', () => {
  it('accepts a bounded create request and rejects reviewer command injection', () => {
    expect(
      githubPullRequestCreateRequestSchema.parse({
        target,
        title: 'Ready',
        body: '',
        base: 'main',
        draft: false,
        reviewers: ['ada']
      })
    ).toMatchObject({ title: 'Ready', reviewers: ['ada'] })
    expect(() =>
      githubPullRequestCreateRequestSchema.parse({
        target,
        title: 'Ready',
        body: '',
        base: 'main',
        draft: false,
        reviewers: ['ada --admin']
      })
    ).toThrow()
  })

  it('never permits non-HTTPS GitHub result URLs', () => {
    expect(() =>
      githubPullRequestStatusResultSchema.parse({
        status: 'ready',
        repository: { nameWithOwner: 'octo/repo', url: 'http://github.com/octo/repo', defaultBranch: 'main' },
        account: null,
        branch: 'feature',
        pullRequest: null
      })
    ).toThrow()
  })
})
