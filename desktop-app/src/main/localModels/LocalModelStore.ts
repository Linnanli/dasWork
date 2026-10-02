import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

import fallbackInstructions from '../../../../codex/codex-rs/models-manager/prompt.md?raw'
import type { AddLocalModelInput, CodexModel } from '../../shared/codexIpcApi'
import type { LocalClientModel } from './LocalClientModel'

const storedModelSchema = z.object({
  id: z.string().uuid(),
  platform: z.enum(['custom', 'deepseek', 'openai']),
  baseUrl: z.string().url(),
  fullUrl: z.boolean(),
  encryptedApiKey: z.string().min(1),
  modelId: z.string().min(1),
  imageInput: z.enum(['auto', 'supported', 'unsupported']),
  apiMode: z.enum(['auto', 'responses']),
  queryParams: z.record(z.string(), z.string()).optional()
})

const appModelsSchema = z.object({
  version: z.literal(1),
  models: z.array(storedModelSchema)
})
const localCatalogSchema = z.object({
  models: z.array(z.unknown()).min(1),
  dascowork: appModelsSchema
})

type StoredModel = z.infer<typeof storedModelSchema>

export type LocalModelSecretStorage = {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export type LocalModelStoreOptions = {
  userDataPath: string
  secretStorage: LocalModelSecretStorage
}

const placeholderModelId = 'dascowork-local-model-placeholder'

export class LocalModelStore {
  private readonly configPath: string
  private readonly obsoleteCatalogPath: string
  private readonly secretStorage: LocalModelSecretStorage
  private models: StoredModel[] | undefined
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: LocalModelStoreOptions) {
    this.configPath = join(options.userDataPath, 'local-models.json')
    this.obsoleteCatalogPath = join(options.userDataPath, 'cache', 'model-catalog.generated.json')
    this.secretStorage = options.secretStorage
  }

  async prepareCatalog(): Promise<string> {
    const models = await this.load()
    await writePrivateJson(this.configPath, buildDocument(models))
    try {
      await unlink(this.obsoleteCatalogPath)
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
    return this.configPath
  }

  async addModel(input: AddLocalModelInput): Promise<string> {
    const run = async (): Promise<string> => {
      const models = await this.load()
      if (!this.secretStorage.isEncryptionAvailable()) {
        throw new Error('系统安全存储不可用，无法保存 API Key')
      }
      const normalizedUrl = normalizeBaseUrl(input.baseUrl, input.fullUrl)
      const modelId = input.modelId.trim()
      if (
        models.some(
          (model) =>
            model.baseUrl === normalizedUrl.baseUrl &&
            model.modelId === modelId &&
            model.platform === input.platform
        )
      ) {
        throw new Error('该平台和地址下已添加同名模型')
      }

      const entry: StoredModel = {
        id: randomUUID(),
        platform: input.platform,
        baseUrl: normalizedUrl.baseUrl,
        fullUrl: input.fullUrl,
        encryptedApiKey: this.secretStorage.encryptString(input.apiKey.trim()).toString('base64'),
        modelId,
        imageInput: input.imageInput,
        apiMode: input.apiMode,
        ...(normalizedUrl.queryParams ? { queryParams: normalizedUrl.queryParams } : {})
      }
      const next = [...models, entry]
      await writePrivateJson(this.configPath, buildDocument(next))
      this.models = next
      return selectionId(entry)
    }

    const result = this.writeQueue.then(run)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async listModels(): Promise<CodexModel[]> {
    return (await this.load()).map((model) => ({
      id: selectionId(model),
      modelId: model.modelId,
      displayName: `${model.modelId} · ${platformDisplayName(model.platform)}`,
      description: new URL(model.baseUrl).host,
      inputModalities: inputModalities(model),
      isDefault: false
    }))
  }

  async resolveClientModel(id: string): Promise<LocalClientModel | undefined> {
    const model = (await this.load()).find((candidate) => selectionId(candidate) === id)
    if (!model) return undefined
    if (!this.secretStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法读取模型 API Key')
    }
    return {
      model_id: model.modelId,
      display_name: model.modelId,
      description: null,
      provider: `local_${model.id.replaceAll('-', '')}`,
      is_default: false,
      capabilities: inputModalities(model),
      api_base_url: model.baseUrl,
      api_key: this.secretStorage.decryptString(Buffer.from(model.encryptedApiKey, 'base64')),
      api_format: 'openai',
      ...(model.queryParams ? { api_query_params: model.queryParams } : {}),
      source: 'local'
    }
  }

  private async load(): Promise<StoredModel[]> {
    if (this.models) return this.models
    let content: string
    try {
      content = await readFile(this.configPath, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        this.models = []
        return this.models
      }
      throw error
    }
    const parsed: unknown = JSON.parse(content)
    const current = localCatalogSchema.safeParse(parsed)
    this.models = current.success
      ? current.data.dascowork.models
      : appModelsSchema.parse(parsed).models
    return this.models
  }
}

function selectionId(model: StoredModel): string {
  return `local:${model.id}`
}

function platformDisplayName(platform: StoredModel['platform']): string {
  switch (platform) {
    case 'deepseek':
      return 'DeepSeek'
    case 'openai':
      return 'OpenAI'
    case 'custom':
      return '自定义'
  }
}

function inputModalities(model: StoredModel): string[] {
  if (model.imageInput === 'supported') return ['text', 'image']
  if (model.imageInput === 'unsupported') return ['text']
  return ['text']
}

function normalizeBaseUrl(
  value: string,
  fullUrl: boolean
): { baseUrl: string; queryParams?: Record<string, string> } {
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('API 请求地址必须是没有凭据或锚点的 HTTP(S) 地址')
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (fullUrl) {
    if (!path.endsWith('/responses')) {
      throw new Error('完整 URL 必须是 Responses 接口地址，以 /responses 结尾')
    }
    url.pathname = path.slice(0, -'/responses'.length) || '/'
  } else {
    if (path.endsWith('/responses')) {
      throw new Error('此地址已包含 /responses，请开启“完整 URL”')
    }
    url.pathname = path || '/'
  }
  const queryParams = Object.fromEntries(url.searchParams.entries())
  url.search = ''
  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    ...(Object.keys(queryParams).length > 0 ? { queryParams } : {})
  }
}

function buildDocument(models: StoredModel[]): {
  models: Record<string, unknown>[]
  dascowork: { version: 1; models: StoredModel[] }
} {
  const catalog: Record<string, unknown>[] = []
  if (models.length === 0) {
    catalog.push(catalogModel(placeholderModelId, ['text'], 'none', 0))
  }
  for (const model of models) {
    const modalities = inputModalities(model)
    if (catalog.some((candidate) => candidate.slug === model.modelId)) continue
    catalog.push(catalogModel(model.modelId, modalities, 'list', 100 + catalog.length))
  }
  return { models: catalog, dascowork: { version: 1, models } }
}

function catalogModel(
  modelId: string,
  inputModalities: string[],
  visibility: 'list' | 'none',
  priority: number
): Record<string, unknown> {
  return {
    slug: modelId,
    display_name: modelId,
    description: null,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'default',
    visibility,
    supported_in_api: true,
    priority,
    availability_nux: null,
    upgrade: null,
    base_instructions: fallbackInstructions,
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    supports_parallel_tool_calls: false,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    default_reasoning_summary: 'auto',
    web_search_tool_type: 'text',
    supports_image_detail_original: inputModalities.includes('image'),
    supports_search_tool: false,
    use_responses_lite: false
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporaryPath, path)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
