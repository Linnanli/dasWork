import { z } from 'zod'

import { gitRepositoryTargetSchema } from './localGitApi'

const githubTextSchema = z.string().trim().min(1).max(16_000)
const githubLoginSchema = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/u)
const githubBranchSchema = z.string().trim().min(1).max(255)
const githubUrlSchema = z.string().url().max(2_048).refine((value) => value.startsWith('https://'), {
  message: 'GitHub URLs must use HTTPS'
})

export const githubPullRequestCheckSchema = z
  .object({
    name: z.string().trim().min(1).max(1_000),
    status: z.string().trim().min(1).max(128),
    conclusion: z.string().trim().min(1).max(128).nullable(),
    detailsUrl: githubUrlSchema.nullable()
  })
  .strict()
export type GithubPullRequestCheck = z.infer<typeof githubPullRequestCheckSchema>

export const githubPullRequestReviewSchema = z
  .object({
    author: githubLoginSchema.nullable(),
    state: z.string().trim().min(1).max(128)
  })
  .strict()
export type GithubPullRequestReview = z.infer<typeof githubPullRequestReviewSchema>

export const githubPullRequestCommentSchema = z
  .object({
    author: githubLoginSchema.nullable(),
    body: z.string().max(16_000),
    url: githubUrlSchema.nullable()
  })
  .strict()
export type GithubPullRequestComment = z.infer<typeof githubPullRequestCommentSchema>

export const githubPullRequestSummarySchema = z
  .object({
    number: z.number().int().positive(),
    title: z.string().trim().min(1).max(2_000),
    url: githubUrlSchema,
    state: z.string().trim().min(1).max(128),
    isDraft: z.boolean(),
    baseRefName: githubBranchSchema,
    headRefName: githubBranchSchema,
    mergeStateStatus: z.string().trim().min(1).max(128).nullable(),
    reviewDecision: z.string().trim().min(1).max(128).nullable(),
    commentCount: z.number().int().nonnegative(),
    comments: z.array(githubPullRequestCommentSchema).max(100),
    checks: z.array(githubPullRequestCheckSchema).max(100),
    reviews: z.array(githubPullRequestReviewSchema).max(100),
    reviewRequests: z.array(githubLoginSchema).max(100)
  })
  .strict()
export type GithubPullRequestSummary = z.infer<typeof githubPullRequestSummarySchema>

export const githubPullRequestStatusRequestSchema = z
  .object({ target: gitRepositoryTargetSchema })
  .strict()
export type GithubPullRequestStatusRequest = z.infer<typeof githubPullRequestStatusRequestSchema>

export const githubPullRequestStatusResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      repository: z
        .object({
          nameWithOwner: z.string().trim().min(1).max(1_024),
          url: githubUrlSchema,
          defaultBranch: githubBranchSchema
        })
        .strict(),
      account: githubLoginSchema.nullable(),
      branch: githubBranchSchema.nullable(),
      pullRequest: githubPullRequestSummarySchema.nullable()
    })
    .strict(),
  z
    .object({
      status: z.literal('unavailable'),
      reason: z.string().trim().min(1).max(2_000),
      ghInstalled: z.boolean()
    })
    .strict()
])
export type GithubPullRequestStatusResult = z.infer<typeof githubPullRequestStatusResultSchema>

const githubReviewersSchema = z.array(githubLoginSchema).max(20).optional()

export const githubPullRequestCreateRequestSchema = z
  .object({
    target: gitRepositoryTargetSchema,
    title: githubTextSchema.max(256),
    body: z.string().max(16_000),
    base: githubBranchSchema,
    draft: z.boolean(),
    reviewers: githubReviewersSchema
  })
  .strict()
export type GithubPullRequestCreateRequest = z.infer<typeof githubPullRequestCreateRequestSchema>

export const githubPullRequestCommentRequestSchema = z
  .object({ target: gitRepositoryTargetSchema, body: githubTextSchema })
  .strict()
export type GithubPullRequestCommentRequest = z.infer<typeof githubPullRequestCommentRequestSchema>

export const githubPullRequestReviewEventSchema = z.enum(['approve', 'request-changes', 'comment'])
export type GithubPullRequestReviewEvent = z.infer<typeof githubPullRequestReviewEventSchema>

export const githubPullRequestSubmitReviewRequestSchema = z
  .object({
    target: gitRepositoryTargetSchema,
    event: githubPullRequestReviewEventSchema,
    body: z.string().max(16_000)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.event !== 'approve' && value.body.trim().length === 0) {
      context.addIssue({ code: 'custom', path: ['body'], message: 'review body is required' })
    }
  })
export type GithubPullRequestSubmitReviewRequest = z.infer<
  typeof githubPullRequestSubmitReviewRequestSchema
>

export const githubPullRequestRequestReviewersRequestSchema = z
  .object({ target: gitRepositoryTargetSchema, reviewers: z.array(githubLoginSchema).min(1).max(20) })
  .strict()
export type GithubPullRequestRequestReviewersRequest = z.infer<
  typeof githubPullRequestRequestReviewersRequestSchema
>

export const githubPullRequestMutationResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success'), pullRequest: githubPullRequestSummarySchema }).strict(),
  z.object({ status: z.literal('error'), message: z.string().trim().min(1).max(2_000) }).strict()
])
export type GithubPullRequestMutationResult = z.infer<typeof githubPullRequestMutationResultSchema>

export const githubPullRequestIpcChannels = {
  getStatus: 'github-pull-request:get-status',
  create: 'github-pull-request:create',
  comment: 'github-pull-request:comment',
  submitReview: 'github-pull-request:submit-review',
  requestReviewers: 'github-pull-request:request-reviewers'
} as const
