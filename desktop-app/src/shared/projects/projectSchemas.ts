import { z } from 'zod'

import type { ProjectActionScope, ProjectSelection } from './projectTypes'
import { normalizeRemoteExecServerUrl } from './remoteExecution'

export const projectSelectionSchema = z.discriminatedUnion('projectKind', [
  z.object({ projectKind: z.literal('local'), projectId: z.string().min(1) }),
  z.object({
    projectKind: z.literal('remote'),
    projectId: z.string().min(1),
    hostId: z.string().min(1)
  }),
  z.object({
    projectKind: z.literal('path'),
    path: z.string().min(1),
    hostId: z.literal('local').optional()
  }),
  z.object({ projectKind: z.literal('projectless') })
]) satisfies z.ZodType<ProjectSelection>

export const projectCreateLocalPayloadSchema = z.object({
  name: z.string().trim().optional(),
  sourceRoots: z.array(z.string().min(1)).min(1)
})

export const projectCreateBlankPayloadSchema = z.object({
  operationId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((name) => name !== '.' && name !== '..', {
      message: 'Project name cannot be "." or ".."'
    })
    .refine((name) => !/[\\/]/.test(name) && !name.includes('\0'), {
      message: 'Project name cannot contain path separators'
    })
})

export const projectCreateRemotePayloadSchema = z.object({
  hostId: z.string().trim().min(1).max(255),
  label: z.string().trim().min(1).max(80),
  remotePath: z
    .string()
    .trim()
    .min(1)
    .refine(
      (path) => path.startsWith('/') && !path.includes('\0') && !/[\r\n]/u.test(path),
      'Remote project path must be an absolute POSIX path'
    ),
  execServerUrl: z.string().transform((value, context) => {
    try {
      return normalizeRemoteExecServerUrl(value)
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error)
      })
      return z.NEVER
    }
  }),
  terminalCommand: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine(
      (command) =>
        !command.includes('\0') &&
        !/[\r\n]/u.test(command) &&
        (command.startsWith('/') || /^[A-Za-z0-9._+-]+$/u.test(command)),
      'Terminal command must be an executable name or absolute POSIX path'
    )
    .optional()
})

export const projectRenamePayloadSchema = z.discriminatedUnion('projectKind', [
  z.object({
    projectKind: z.literal('local'),
    projectId: z.string().min(1),
    label: z.string().trim().min(1)
  }),
  z.object({
    projectKind: z.literal('remote'),
    projectId: z.string().min(1),
    label: z.string().trim().min(1)
  }),
  z.object({
    projectKind: z.literal('path'),
    path: z.string().min(1),
    label: z.string().trim().min(1)
  })
])

export const projectSelectPayloadSchema = projectSelectionSchema

const absoluteLocalPathSchema = z
  .string()
  .min(1)
  .max(32_768)
  .refine(
    (path) =>
      !path.includes('\0') &&
      !/[\r\n]/u.test(path) &&
      !path.startsWith('//') &&
      !path.startsWith('\\\\') &&
      (path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)),
    'path must be an absolute local path'
  )

export const projectWorktreeListPayloadSchema = z
  .object({ source: projectSelectionSchema })
  .strict()

export const projectWorktreeSelectPayloadSchema = projectWorktreeListPayloadSchema.extend({
  path: absoluteLocalPathSchema
})

export const projectActionScopeSchema = z.discriminatedUnion('projectKind', [
  z.object({ projectKind: z.literal('local'), projectId: z.string().min(1) }),
  z.object({
    projectKind: z.literal('remote'),
    projectId: z.string().min(1),
    hostId: z.string().min(1)
  }),
  z.object({
    projectKind: z.literal('path'),
    path: z.string().min(1),
    hostId: z.literal('local').optional()
  })
]) satisfies z.ZodType<ProjectActionScope>

const projectActionFieldsSchema = z.object({
  title: z.string().trim().min(1).max(80),
  command: z
    .string()
    .trim()
    .min(1)
    .max(32_768)
    .refine((command) => !command.includes('\0'), {
      message: 'Action command cannot contain a NUL character'
    })
})

export const projectActionUpsertPayloadSchema = z
  .object({
    scope: projectActionScopeSchema,
    action: projectActionFieldsSchema.extend({ id: z.string().uuid().optional() })
  })
  .strict()

export const projectActionRemovePayloadSchema = z
  .object({ scope: projectActionScopeSchema, actionId: z.string().uuid() })
  .strict()
