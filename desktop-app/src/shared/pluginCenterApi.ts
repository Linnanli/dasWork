import { z } from 'zod'

export const PLUGIN_CENTER_API_VERSION = 1 as const
export const PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH = 500 as const

export const pluginCenterIpcChannels = {
  getSnapshot: 'codex:plugin-center:get-snapshot',
  getInstalledPlugins: 'codex:plugin-center:get-installed-plugins',
  getPluginDetail: 'codex:plugin-center:get-plugin-detail',
  addMarketplace: 'codex:plugin-center:add-marketplace',
  installPlugin: 'codex:plugin-center:install-plugin',
  uninstallPlugin: 'codex:plugin-center:uninstall-plugin',
  setPluginEnabled: 'codex:plugin-center:set-plugin-enabled',
  setSkillEnabled: 'codex:plugin-center:set-skill-enabled',
  setAppEnabled: 'codex:plugin-center:set-app-enabled',
  setMcpServerEnabled: 'codex:plugin-center:set-mcp-server-enabled',
  upsertMcpServer: 'codex:plugin-center:upsert-mcp-server',
  removeMcpServer: 'codex:plugin-center:remove-mcp-server'
} as const

const nonEmptyStringSchema = z.string().trim().min(1)
const optionalDisplayStringSchema = z
  .string()
  .trim()
  .min(1)
  .max(PLUGIN_CENTER_DISPLAY_TEXT_MAX_LENGTH)
  .optional()
const idSchema = z.string().trim().min(1).max(300)
const stringListSchema = z.array(nonEmptyStringSchema).default([])

const httpUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  }, 'URL must use http or https')

const safeImageUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol
    return protocol === 'app:' || protocol === 'http:' || protocol === 'https:'
  }, 'Image URL must use app, http, or https')

const detailDisplayStringSchema = z.string().trim().min(1).max(5_000)

const uniqueTrimmedListSchema = z
  .array(z.string().trim().min(1).max(500))
  .max(100)
  .transform((values) => [...new Set(values)])

const trimmedListSchema = z.array(z.string().trim().min(1).max(500)).max(100).default([])

export const pluginCenterSourceKindSchema = z.enum([
  'builtin',
  'personal',
  'marketplace',
  'local',
  'unknown'
])

export type PluginCenterSourceKind = z.infer<typeof pluginCenterSourceKindSchema>

export const pluginCenterIconSchema = z
  .object({
    kind: z.enum(['url', 'data', 'initials', 'lucide']),
    value: z.string().trim().min(1).max(4_000)
  })
  .strict()

export type PluginCenterIcon = z.infer<typeof pluginCenterIconSchema>

export const pluginCenterRestrictionSchema = z
  .object({
    code: z.enum(['policy', 'inaccessible', 'readonly', 'unavailable', 'unsupported', 'error']),
    message: z.string().trim().min(1).max(1_000)
  })
  .strict()

export type PluginCenterRestriction = z.infer<typeof pluginCenterRestrictionSchema>

export const pluginCenterRequestContextSchema = z
  .object({
    version: z.literal(PLUGIN_CENTER_API_VERSION),
    cwd: z.string().trim().min(1).optional(),
    threadId: z.string().trim().min(1).optional()
  })
  .strict()

export type PluginCenterRequestContext = z.infer<typeof pluginCenterRequestContextSchema>

export const pluginCenterInstalledPluginsRequestSchema = z
  .object({
    version: z.literal(PLUGIN_CENTER_API_VERSION),
    cwd: z.string().trim().min(1).optional()
  })
  .strict()

export type PluginCenterInstalledPluginsRequest = z.infer<
  typeof pluginCenterInstalledPluginsRequestSchema
>

export const pluginCenterSnapshotSectionSchema = z.enum(['plugins', 'skills', 'apps', 'mcp'])

export type PluginCenterSnapshotSection = z.infer<typeof pluginCenterSnapshotSectionSchema>

export const pluginCenterSnapshotRequestSchema = pluginCenterRequestContextSchema.extend({
  forceRefresh: z.boolean().optional(),
  sections: z
    .array(pluginCenterSnapshotSectionSchema)
    .min(1)
    .max(4)
    .transform((sections) => [...new Set(sections)])
    .optional(),
  includePluginDetails: z.boolean().optional()
})

export type PluginCenterSnapshotRequest = z.infer<typeof pluginCenterSnapshotRequestSchema>

const catalogItemBaseSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    displayName: optionalDisplayStringSchema,
    description: optionalDisplayStringSchema,
    icon: pluginCenterIconSchema.optional(),
    sourceKind: pluginCenterSourceKindSchema,
    marketplaceId: idSchema.optional(),
    marketplaceName: optionalDisplayStringSchema,
    categories: stringListSchema,
    tags: stringListSchema,
    featured: z.boolean().default(false),
    installed: z.boolean(),
    enabled: z.boolean(),
    canInstall: z.boolean().default(true),
    canUninstall: z.boolean().default(true),
    canToggle: z.boolean().default(true),
    restriction: pluginCenterRestrictionSchema.optional()
  })
  .strict()

export const pluginCenterPluginSchema = catalogItemBaseSchema.extend({
  kind: z.literal('plugin'),
  versionLabel: optionalDisplayStringSchema,
  author: optionalDisplayStringSchema,
  skillCount: z.number().int().nonnegative().optional(),
  appCount: z.number().int().nonnegative().optional(),
  mcpServerCount: z.number().int().nonnegative().optional()
})

export type PluginCenterPlugin = z.infer<typeof pluginCenterPluginSchema>

export const pluginCenterSkillScopeSchema = z.enum([
  'personal',
  'workspace',
  'project',
  'plugin',
  'system',
  'unknown'
])

export type PluginCenterSkillScope = z.infer<typeof pluginCenterSkillScopeSchema>

export const pluginCenterSkillSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    displayName: optionalDisplayStringSchema,
    description: optionalDisplayStringSchema,
    scope: pluginCenterSkillScopeSchema,
    sourceKind: pluginCenterSourceKindSchema,
    pluginId: idSchema.optional(),
    pluginDisplayName: optionalDisplayStringSchema,
    enabled: z.boolean(),
    installed: z.boolean().default(true),
    recommended: z.boolean().default(false),
    canToggle: z.boolean().default(true),
    restriction: pluginCenterRestrictionSchema.optional(),
    tags: stringListSchema
  })
  .strict()

export type PluginCenterSkill = z.infer<typeof pluginCenterSkillSchema>

export const pluginCenterAppSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    displayName: optionalDisplayStringSchema,
    description: optionalDisplayStringSchema,
    icon: pluginCenterIconSchema.optional(),
    sourceKind: pluginCenterSourceKindSchema,
    pluginIds: z.array(idSchema).default([]),
    pluginDisplayNames: stringListSchema,
    enabled: z.boolean(),
    accessible: z.boolean(),
    canToggle: z.boolean().default(true),
    installUrl: httpUrlSchema.optional(),
    restriction: pluginCenterRestrictionSchema.optional()
  })
  .strict()

export type PluginCenterApp = z.infer<typeof pluginCenterAppSchema>

export const pluginCenterMcpAuthStatusSchema = z.enum([
  'unsupported',
  'notLoggedIn',
  'bearerToken',
  'oAuth',
  'unknown'
])

export type PluginCenterMcpAuthStatus = z.infer<typeof pluginCenterMcpAuthStatusSchema>

export const pluginCenterMcpOriginSchema = z.enum([
  'user',
  'project',
  'system',
  'managed',
  'plugin',
  'unknown'
])

export type PluginCenterMcpOrigin = z.infer<typeof pluginCenterMcpOriginSchema>

export const pluginCenterSecretMetadataSchema = z
  .object({
    name: nonEmptyStringSchema,
    hasValue: z.boolean(),
    editable: z.boolean().default(true)
  })
  .strict()

export type PluginCenterSecretMetadata = z.infer<typeof pluginCenterSecretMetadataSchema>

export const pluginCenterEnvVarMetadataSchema = z
  .object({
    name: nonEmptyStringSchema,
    source: z.enum(['local', 'remote']).optional(),
    editable: z.boolean().default(true)
  })
  .strict()

export type PluginCenterEnvVarMetadata = z.infer<typeof pluginCenterEnvVarMetadataSchema>

export const pluginCenterEnvHeaderMetadataSchema = z
  .object({
    name: nonEmptyStringSchema,
    envVarName: nonEmptyStringSchema,
    editable: z.boolean().default(true)
  })
  .strict()

export type PluginCenterEnvHeaderMetadata = z.infer<typeof pluginCenterEnvHeaderMetadataSchema>

const mcpServerBaseSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    displayName: optionalDisplayStringSchema,
    enabled: z.boolean(),
    connected: z.boolean(),
    authStatus: pluginCenterMcpAuthStatusSchema,
    toolCount: z.number().int().nonnegative(),
    origin: pluginCenterMcpOriginSchema,
    editable: z.boolean(),
    restriction: pluginCenterRestrictionSchema.optional()
  })
  .strict()

export const pluginCenterStdioMcpServerSchema = mcpServerBaseSchema.extend({
  transport: z.literal('stdio'),
  command: nonEmptyStringSchema.optional(),
  args: stringListSchema,
  cwd: z.string().trim().min(1).optional(),
  env: z.array(pluginCenterSecretMetadataSchema).default([]),
  envVars: z.array(pluginCenterEnvVarMetadataSchema).default([])
})

export type PluginCenterStdioMcpServer = z.infer<typeof pluginCenterStdioMcpServerSchema>

export const pluginCenterHttpMcpServerSchema = mcpServerBaseSchema.extend({
  transport: z.literal('streamable-http'),
  url: httpUrlSchema.optional(),
  bearerTokenEnvVar: z.string().trim().min(1).optional(),
  httpHeaders: z.array(pluginCenterSecretMetadataSchema).default([]),
  envHttpHeaders: z.array(pluginCenterEnvHeaderMetadataSchema).default([])
})

export type PluginCenterHttpMcpServer = z.infer<typeof pluginCenterHttpMcpServerSchema>

export const pluginCenterUserMcpServerSchema = z.discriminatedUnion('transport', [
  pluginCenterStdioMcpServerSchema,
  pluginCenterHttpMcpServerSchema
])

export type PluginCenterUserMcpServer = z.infer<typeof pluginCenterUserMcpServerSchema>

export const pluginCenterPluginMcpServerSchema = mcpServerBaseSchema
  .extend({
    origin: z.literal('plugin'),
    editable: z.literal(false),
    pluginId: idSchema,
    pluginDisplayName: optionalDisplayStringSchema,
    transport: z.enum(['stdio', 'streamable-http', 'unknown'])
  })
  .strict()

export type PluginCenterPluginMcpServer = z.infer<typeof pluginCenterPluginMcpServerSchema>

export const pluginCenterMcpSnapshotSchema = z
  .object({
    userServers: z.array(pluginCenterUserMcpServerSchema),
    pluginServers: z.array(pluginCenterPluginMcpServerSchema)
  })
  .strict()

export type PluginCenterMcpSnapshot = z.infer<typeof pluginCenterMcpSnapshotSchema>

export const pluginCenterMarketplaceSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    source: nonEmptyStringSchema,
    refName: z.string().trim().min(1).optional(),
    sparsePaths: uniqueTrimmedListSchema.default([])
  })
  .strict()

export type PluginCenterMarketplace = z.infer<typeof pluginCenterMarketplaceSchema>

export const pluginCenterSnapshotCapabilitySchema = z
  .object({
    available: z.boolean(),
    restriction: pluginCenterRestrictionSchema.optional()
  })
  .strict()

export type PluginCenterSnapshotCapability = z.infer<typeof pluginCenterSnapshotCapabilitySchema>

export const pluginCenterSnapshotCapabilitiesSchema = z
  .object({
    plugins: pluginCenterSnapshotCapabilitySchema,
    skills: pluginCenterSnapshotCapabilitySchema,
    apps: pluginCenterSnapshotCapabilitySchema,
    mcp: pluginCenterSnapshotCapabilitySchema
  })
  .strict()

export type PluginCenterSnapshotCapabilities = z.infer<
  typeof pluginCenterSnapshotCapabilitiesSchema
>

export const pluginCenterSnapshotSchema = z
  .object({
    version: z.literal(PLUGIN_CENTER_API_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
    plugins: z.array(pluginCenterPluginSchema),
    skills: z.array(pluginCenterSkillSchema),
    apps: z.array(pluginCenterAppSchema),
    mcp: pluginCenterMcpSnapshotSchema,
    marketplaces: z.array(pluginCenterMarketplaceSchema),
    capabilities: pluginCenterSnapshotCapabilitiesSchema.optional(),
    catalogUnavailableReason: optionalDisplayStringSchema
  })
  .strict()

export type PluginCenterSnapshot = z.infer<typeof pluginCenterSnapshotSchema>

export const pluginCenterSnapshotResultSchema = z
  .object({
    version: z.literal(PLUGIN_CENTER_API_VERSION),
    snapshot: pluginCenterSnapshotSchema
  })
  .strict()

export type PluginCenterSnapshotResult = z.infer<typeof pluginCenterSnapshotResultSchema>

export const pluginCenterInstalledPluginsResultSchema = z
  .object({
    version: z.literal(PLUGIN_CENTER_API_VERSION),
    generatedAt: z.string().datetime({ offset: true }),
    plugins: z.array(pluginCenterPluginSchema)
  })
  .strict()

export type PluginCenterInstalledPluginsResult = z.infer<
  typeof pluginCenterInstalledPluginsResultSchema
>

export const pluginCenterItemRefSchema = z
  .object({
    id: idSchema
  })
  .strict()

export type PluginCenterItemRef = z.infer<typeof pluginCenterItemRefSchema>

export const pluginCenterPluginRefSchema = pluginCenterItemRefSchema
  .extend({
    marketplaceId: idSchema.optional()
  })
  .strict()

export type PluginCenterPluginRef = z.infer<typeof pluginCenterPluginRefSchema>

export const pluginCenterGetPluginDetailRequestSchema = pluginCenterRequestContextSchema
  .extend({
    plugin: pluginCenterPluginRefSchema,
    forceRefresh: z.boolean().optional()
  })
  .strict()

export type PluginCenterGetPluginDetailRequest = z.infer<
  typeof pluginCenterGetPluginDetailRequestSchema
>

const pluginCenterPluginDetailAppSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    description: optionalDisplayStringSchema,
    category: optionalDisplayStringSchema,
    installUrl: httpUrlSchema.optional(),
    icon: pluginCenterIconSchema.optional(),
    enabled: z.boolean().default(true),
    accessible: z.boolean().default(true),
    canToggle: z.boolean().default(true),
    restriction: pluginCenterRestrictionSchema.optional()
  })
  .strict()

const pluginCenterPluginDetailSkillSchema = z
  .object({
    id: idSchema,
    name: nonEmptyStringSchema,
    displayName: optionalDisplayStringSchema,
    description: optionalDisplayStringSchema,
    icon: pluginCenterIconSchema.optional(),
    enabled: z.boolean(),
    canToggle: z.boolean().default(true)
  })
  .strict()

export const pluginCenterPluginDetailSchema = z
  .object({
    plugin: pluginCenterPluginSchema,
    mention: z
      .object({
        path: z
          .string()
          .trim()
          .regex(/^plugin:\/\/[^\s]+$/)
          .max(600),
        name: nonEmptyStringSchema.max(300)
      })
      .strict(),
    longDescription: detailDisplayStringSchema.optional(),
    capabilities: z.array(optionalDisplayStringSchema.unwrap()).max(30).default([]),
    defaultPrompts: z
      .array(z.string().trim().min(1).max(128))
      .max(3)
      .transform((values) => [...new Set(values)]),
    brandColor: z
      .string()
      .trim()
      .regex(/^(?:#[0-9a-fA-F]{3,8}|rgba?\([^()]{1,80}\))$/)
      .optional(),
    screenshots: z.array(safeImageUrlSchema).max(8).default([]),
    websiteUrl: httpUrlSchema.optional(),
    privacyPolicyUrl: httpUrlSchema.optional(),
    termsOfServiceUrl: httpUrlSchema.optional(),
    apps: z.array(pluginCenterPluginDetailAppSchema).max(50).default([]),
    skills: z.array(pluginCenterPluginDetailSkillSchema).max(100).default([]),
    mcpServers: z.array(nonEmptyStringSchema.max(300)).max(100).default([])
  })
  .strict()

export type PluginCenterPluginDetail = z.infer<typeof pluginCenterPluginDetailSchema>

export const pluginCenterGetPluginDetailResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      version: z.literal(PLUGIN_CENTER_API_VERSION),
      status: z.literal('ready'),
      detail: pluginCenterPluginDetailSchema
    })
    .strict(),
  z
    .object({
      version: z.literal(PLUGIN_CENTER_API_VERSION),
      status: z.literal('missing'),
      missingReason: z.enum(['not_found', 'ambiguous'])
    })
    .strict()
])

export type PluginCenterGetPluginDetailResult = z.infer<
  typeof pluginCenterGetPluginDetailResultSchema
>

export const pluginCenterInstallPluginRequestSchema = pluginCenterRequestContextSchema
  .extend({
    plugin: pluginCenterPluginRefSchema
  })
  .strict()

export type PluginCenterInstallPluginRequest = z.infer<
  typeof pluginCenterInstallPluginRequestSchema
>

export const pluginCenterUninstallPluginRequestSchema = pluginCenterRequestContextSchema
  .extend({
    plugin: pluginCenterItemRefSchema
  })
  .strict()

export type PluginCenterUninstallPluginRequest = z.infer<
  typeof pluginCenterUninstallPluginRequestSchema
>

export const pluginCenterSetPluginEnabledRequestSchema = pluginCenterRequestContextSchema
  .extend({
    plugin: pluginCenterItemRefSchema,
    enabled: z.boolean()
  })
  .strict()

export type PluginCenterSetPluginEnabledRequest = z.infer<
  typeof pluginCenterSetPluginEnabledRequestSchema
>

export const pluginCenterSetSkillEnabledRequestSchema = pluginCenterRequestContextSchema
  .extend({
    skill: pluginCenterItemRefSchema,
    enabled: z.boolean()
  })
  .strict()

export type PluginCenterSetSkillEnabledRequest = z.infer<
  typeof pluginCenterSetSkillEnabledRequestSchema
>

export const pluginCenterSetAppEnabledRequestSchema = pluginCenterRequestContextSchema
  .extend({
    app: pluginCenterItemRefSchema,
    enabled: z.boolean()
  })
  .strict()

export type PluginCenterSetAppEnabledRequest = z.infer<
  typeof pluginCenterSetAppEnabledRequestSchema
>

export const pluginCenterSetMcpServerEnabledRequestSchema = pluginCenterRequestContextSchema
  .extend({
    server: pluginCenterItemRefSchema,
    enabled: z.boolean()
  })
  .strict()

export type PluginCenterSetMcpServerEnabledRequest = z.infer<
  typeof pluginCenterSetMcpServerEnabledRequestSchema
>

export const pluginCenterAddMarketplaceRequestSchema = pluginCenterRequestContextSchema
  .extend({
    source: nonEmptyStringSchema,
    refName: z.string().trim().min(1).optional(),
    sparsePaths: uniqueTrimmedListSchema.default([])
  })
  .strict()

export type PluginCenterAddMarketplaceRequest = z.infer<
  typeof pluginCenterAddMarketplaceRequestSchema
>

export const pluginCenterSecretPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep') }).strict(),
  z.object({ action: z.literal('set'), value: z.string().min(1).max(8_000) }).strict(),
  z.object({ action: z.literal('remove') }).strict()
])

export type PluginCenterSecretPatch = z.infer<typeof pluginCenterSecretPatchSchema>

export const pluginCenterNamedSecretPatchSchema = z
  .object({
    name: nonEmptyStringSchema,
    value: pluginCenterSecretPatchSchema
  })
  .strict()

export type PluginCenterNamedSecretPatch = z.infer<typeof pluginCenterNamedSecretPatchSchema>

export const pluginCenterEnvHeaderPatchSchema = z
  .object({
    name: nonEmptyStringSchema,
    envVarName: nonEmptyStringSchema
  })
  .strict()

export type PluginCenterEnvHeaderPatch = z.infer<typeof pluginCenterEnvHeaderPatchSchema>

export const pluginCenterStdioMcpServerInputSchema = z
  .object({
    transport: z.literal('stdio'),
    command: nonEmptyStringSchema,
    args: trimmedListSchema,
    cwd: z.string().trim().min(1).optional(),
    env: z.array(pluginCenterNamedSecretPatchSchema).max(200).default([]),
    envVars: uniqueTrimmedListSchema.default([])
  })
  .strict()

export type PluginCenterStdioMcpServerInput = z.infer<typeof pluginCenterStdioMcpServerInputSchema>

export const pluginCenterHttpMcpServerInputSchema = z
  .object({
    transport: z.literal('streamable-http'),
    url: httpUrlSchema,
    bearerTokenEnvVar: z.string().trim().min(1).optional(),
    httpHeaders: z.array(pluginCenterNamedSecretPatchSchema).max(200).default([]),
    envHttpHeaders: z.array(pluginCenterEnvHeaderPatchSchema).max(200).default([])
  })
  .strict()

export type PluginCenterHttpMcpServerInput = z.infer<typeof pluginCenterHttpMcpServerInputSchema>

export const pluginCenterMcpServerInputSchema = z.discriminatedUnion('transport', [
  pluginCenterStdioMcpServerInputSchema,
  pluginCenterHttpMcpServerInputSchema
])

export type PluginCenterMcpServerInput = z.infer<typeof pluginCenterMcpServerInputSchema>

export const pluginCenterUpsertMcpServerRequestSchema = pluginCenterRequestContextSchema
  .extend({
    serverId: idSchema.optional(),
    displayName: nonEmptyStringSchema.optional(),
    server: pluginCenterMcpServerInputSchema
  })
  .strict()

export type PluginCenterUpsertMcpServerRequest = z.infer<
  typeof pluginCenterUpsertMcpServerRequestSchema
>

export const pluginCenterRemoveMcpServerRequestSchema = pluginCenterRequestContextSchema
  .extend({
    server: pluginCenterItemRefSchema
  })
  .strict()

export type PluginCenterRemoveMcpServerRequest = z.infer<
  typeof pluginCenterRemoveMcpServerRequestSchema
>

export const pluginCenterChangedSectionSchema = z.enum([
  'catalog',
  'installed',
  'skills',
  'apps',
  'mcp'
])

export type PluginCenterChangedSection = z.infer<typeof pluginCenterChangedSectionSchema>

export const pluginCenterChangedSectionsSchema = z
  .array(pluginCenterChangedSectionSchema)
  .max(5)
  .transform((sections) => [...new Set(sections)])
  .default([])

export const pluginCenterMutationResultSchema = z
  .object({
    version: z.literal(PLUGIN_CENTER_API_VERSION),
    status: z.enum(['applied', 'unchanged', 'overridden', 'partial']),
    message: optionalDisplayStringSchema,
    changedItemId: idSchema.optional(),
    changedSections: pluginCenterChangedSectionsSchema,
    snapshot: pluginCenterSnapshotSchema.optional()
  })
  .strict()

export type PluginCenterMutationResult = z.infer<typeof pluginCenterMutationResultSchema>

export const pluginCenterAddMarketplaceResultSchema = pluginCenterMutationResultSchema
  .extend({
    marketplace: pluginCenterMarketplaceSchema.optional(),
    alreadyAdded: z.boolean().default(false)
  })
  .strict()

export type PluginCenterAddMarketplaceResult = z.infer<
  typeof pluginCenterAddMarketplaceResultSchema
>

export type DesktopPluginCenterApi = {
  getSnapshot(input: PluginCenterSnapshotRequest): Promise<PluginCenterSnapshotResult>
  getInstalledPlugins(
    input: PluginCenterInstalledPluginsRequest
  ): Promise<PluginCenterInstalledPluginsResult>
  getPluginDetail(
    input: PluginCenterGetPluginDetailRequest
  ): Promise<PluginCenterGetPluginDetailResult>
  addMarketplace(
    input: PluginCenterAddMarketplaceRequest
  ): Promise<PluginCenterAddMarketplaceResult>
  installPlugin(input: PluginCenterInstallPluginRequest): Promise<PluginCenterMutationResult>
  uninstallPlugin(input: PluginCenterUninstallPluginRequest): Promise<PluginCenterMutationResult>
  setPluginEnabled(input: PluginCenterSetPluginEnabledRequest): Promise<PluginCenterMutationResult>
  setSkillEnabled(input: PluginCenterSetSkillEnabledRequest): Promise<PluginCenterMutationResult>
  setAppEnabled(input: PluginCenterSetAppEnabledRequest): Promise<PluginCenterMutationResult>
  setMcpServerEnabled(
    input: PluginCenterSetMcpServerEnabledRequest
  ): Promise<PluginCenterMutationResult>
  upsertMcpServer(input: PluginCenterUpsertMcpServerRequest): Promise<PluginCenterMutationResult>
  removeMcpServer(input: PluginCenterRemoveMcpServerRequest): Promise<PluginCenterMutationResult>
}
