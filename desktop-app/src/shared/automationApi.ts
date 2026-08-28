import { z } from 'zod'

import { projectSelectionSchema } from './projects/projectSchemas'
import type { ProjectSelection } from './projects/projectTypes'

export type AutomationSchedule =
  | { kind: 'once'; at: string }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string }

export type AutomationRunStatus = 'running' | 'completed' | 'failed'

export type AutomationRun = {
  id: string
  startedAt: string
  completedAt?: string
  status: AutomationRunStatus
  conversationId?: string
  threadId?: string
  error?: string
}

export type ScheduledAutomation = {
  id: string
  sourceConversationId: string
  sourceThreadId?: string
  /** Project context captured when the schedule was created. */
  sourceProjectSelection?: ProjectSelection
  title: string
  prompt: string
  schedule: AutomationSchedule
  status: 'active' | 'paused'
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  runs: AutomationRun[]
}

export const automationRunSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['running', 'completed', 'failed']),
  conversationId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  error: z.string().min(1).max(1_000).optional()
}) satisfies z.ZodType<AutomationRun>

export const automationTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/u, 'time must use HH:MM')

export const automationScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.string().datetime({ offset: true }) }),
  z.object({ kind: z.literal('daily'), time: automationTimeSchema }),
  z.object({
    kind: z.literal('weekly'),
    weekday: z.number().int().min(0).max(6),
    time: automationTimeSchema
  })
]) satisfies z.ZodType<AutomationSchedule>

export const scheduledAutomationSchema = z.object({
  id: z.string().min(1),
  sourceConversationId: z.string().min(1),
  sourceThreadId: z.string().min(1).optional(),
  sourceProjectSelection: projectSelectionSchema.optional(),
  title: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(8_000),
  schedule: automationScheduleSchema,
  status: z.enum(['active', 'paused']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  nextRunAt: z.string().datetime({ offset: true }).optional(),
  runs: z.array(automationRunSchema).max(20)
}) satisfies z.ZodType<ScheduledAutomation>

export const scheduledAutomationListSchema = z.array(scheduledAutomationSchema)

const automationTitleSchema = z.string().trim().min(1).max(160)
const automationPromptSchema = z.string().trim().min(1).max(8_000)

export const automationCreateRequestSchema = z.object({
  sourceConversationId: z.string().min(1),
  sourceThreadId: z.string().min(1).optional(),
  title: automationTitleSchema,
  prompt: automationPromptSchema,
  schedule: automationScheduleSchema
})

export const automationUpdateRequestSchema = z
  .object({
    id: z.string().min(1),
    title: automationTitleSchema.optional(),
    prompt: automationPromptSchema.optional(),
    schedule: automationScheduleSchema.optional()
  })
  .refine(
    (input) =>
      input.title !== undefined || input.prompt !== undefined || input.schedule !== undefined,
    {
      message: 'at least one automation field must be updated'
    }
  )

export const automationActionRequestSchema = z.object({ id: z.string().min(1) })

export const automationStatusRequestSchema = automationActionRequestSchema.extend({
  status: z.enum(['active', 'paused'])
})

export type AutomationCreateRequest = z.infer<typeof automationCreateRequestSchema>
export type AutomationUpdateRequest = z.infer<typeof automationUpdateRequestSchema>
export type AutomationActionRequest = z.infer<typeof automationActionRequestSchema>
export type AutomationStatusRequest = z.infer<typeof automationStatusRequestSchema>

export const automationIpcChannels = {
  list: 'codex:automations:list',
  create: 'codex:automations:create',
  update: 'codex:automations:update',
  setStatus: 'codex:automations:set-status',
  remove: 'codex:automations:remove',
  runNow: 'codex:automations:run-now'
} as const

export type DesktopAutomationsApi = {
  list(): Promise<ScheduledAutomation[]>
  create(input: AutomationCreateRequest): Promise<ScheduledAutomation>
  update(input: AutomationUpdateRequest): Promise<ScheduledAutomation>
  setStatus(input: AutomationStatusRequest): Promise<ScheduledAutomation>
  remove(input: AutomationActionRequest): Promise<void>
  runNow(input: AutomationActionRequest): Promise<ScheduledAutomation>
}
