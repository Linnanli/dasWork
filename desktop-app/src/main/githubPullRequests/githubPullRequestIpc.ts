import {
  githubPullRequestCommentRequestSchema,
  githubPullRequestCreateRequestSchema,
  githubPullRequestRequestReviewersRequestSchema,
  githubPullRequestStatusRequestSchema,
  githubPullRequestSubmitReviewRequestSchema
} from '../../shared/githubPullRequestApi'
import type { GithubPullRequestService } from './GithubPullRequestService'

export type GithubPullRequestIpcHandlers = {
  getStatus(_event: unknown, payload: unknown): Promise<unknown>
  create(_event: unknown, payload: unknown): Promise<unknown>
  comment(_event: unknown, payload: unknown): Promise<unknown>
  submitReview(_event: unknown, payload: unknown): Promise<unknown>
  requestReviewers(_event: unknown, payload: unknown): Promise<unknown>
}

export function createGithubPullRequestIpcHandlers(
  service: GithubPullRequestService
): GithubPullRequestIpcHandlers {
  return {
    getStatus: async (_event, payload) => service.getStatus(githubPullRequestStatusRequestSchema.parse(payload).target),
    create: async (_event, payload) => service.create(githubPullRequestCreateRequestSchema.parse(payload)),
    comment: async (_event, payload) => service.comment(githubPullRequestCommentRequestSchema.parse(payload)),
    submitReview: async (_event, payload) =>
      service.submitReview(githubPullRequestSubmitReviewRequestSchema.parse(payload)),
    requestReviewers: async (_event, payload) =>
      service.requestReviewers(githubPullRequestRequestReviewersRequestSchema.parse(payload))
  }
}
