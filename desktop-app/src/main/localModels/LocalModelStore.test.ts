import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AddLocalModelInput } from '../../shared/codexIpcApi'
import { LocalModelStore } from './LocalModelStore'

const secretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: (value: Buffer) => value.toString('utf8').replace(/^encrypted:/, '')
}

const input: AddLocalModelInput = {
  platform: 'custom',
  baseUrl: 'https://models.example.test/v1',
  fullUrl: false,
  apiKey: 'secret-key',
  modelId: 'local-vision',
  imageInput: 'supported',
  apiMode: 'responses'
}

describe('LocalModelStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'dascowork-local-models-'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('creates one Codex-compatible file before any models are added', async () => {
    const store = new LocalModelStore({ userDataPath, secretStorage })
    const catalogPath = await store.prepareCatalog()
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      models: Array<{ visibility: string }>
      dascowork: { models: unknown[] }
    }

    expect(catalogPath).toBe(join(userDataPath, 'local-models.json'))
    expect(await readdir(userDataPath)).toEqual(['local-models.json'])
    expect(catalog.models).toEqual([expect.objectContaining({ visibility: 'none' })])
    expect(catalog.dascowork.models).toEqual([])
    expect(await store.listModels()).toEqual([])
  })

  it('keeps plaintext secrets out of the shared file and provider routing in Main', async () => {
    const store = new LocalModelStore({ userDataPath, secretStorage })
    const catalogPath = await store.prepareCatalog()
    const selectionId = await store.addModel(input)
    const saved = await readFile(join(userDataPath, 'local-models.json'), 'utf8')
    const document = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      models: Array<{ slug: string; input_modalities: string[] }>
      dascowork: { models: Array<{ platform: string; encryptedApiKey: string }> }
    }

    expect(saved).not.toContain('secret-key')
    expect(JSON.stringify(document.models)).not.toContain('models.example.test')
    expect(document.dascowork.models[0]).toMatchObject({
      platform: 'custom',
      encryptedApiKey: expect.any(String)
    })
    expect(await store.listModels()).toEqual([
      expect.objectContaining({ id: selectionId, inputModalities: ['text', 'image'] })
    ])
    expect(await store.resolveClientModel(selectionId)).toEqual(
      expect.objectContaining({
        model_id: 'local-vision',
        api_base_url: 'https://models.example.test/v1',
        api_key: 'secret-key',
        provider: expect.stringMatching(/^local_[a-f0-9]+$/)
      })
    )
    expect(document.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'local-vision', input_modalities: ['text', 'image'] })
      ])
    )
    const reloaded = new LocalModelStore({ userDataPath, secretStorage })
    expect(await reloaded.resolveClientModel(selectionId)).toMatchObject({
      model_id: 'local-vision',
      api_key: 'secret-key'
    })
  })

  it('upgrades the prior app config and removes its generated catalog', async () => {
    const configPath = join(userDataPath, 'local-models.json')
    const obsoleteCatalogPath = join(userDataPath, 'cache', 'model-catalog.generated.json')
    const legacyModel = {
      id: '30ce416b-5089-4da0-bd8e-af54c13b6704',
      platform: 'custom',
      baseUrl: input.baseUrl,
      fullUrl: false,
      encryptedApiKey: secretStorage.encryptString(input.apiKey).toString('base64'),
      modelId: input.modelId,
      imageInput: input.imageInput,
      apiMode: input.apiMode
    }
    await writeFile(configPath, JSON.stringify({ version: 1, models: [legacyModel] }))
    await mkdir(join(userDataPath, 'cache'))
    await writeFile(obsoleteCatalogPath, '{"models":[]}')

    const store = new LocalModelStore({ userDataPath, secretStorage })
    expect(await store.prepareCatalog()).toBe(configPath)
    expect(await store.listModels()).toEqual([
      expect.objectContaining({ modelId: input.modelId, displayName: 'local-vision · 自定义' })
    ])
    const document = JSON.parse(await readFile(configPath, 'utf8')) as {
      models: Array<{ slug: string }>
      dascowork: { models: unknown[] }
    }
    expect(document.models[0]?.slug).toBe(input.modelId)
    expect(document.dascowork.models).toHaveLength(1)
    await expect(readFile(obsoleteCatalogPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows the same model name on separate providers and normalizes a full Responses URL', async () => {
    const store = new LocalModelStore({ userDataPath, secretStorage })
    const firstId = await store.addModel(input)
    const secondId = await store.addModel({
      ...input,
      baseUrl: 'https://other.example.test/v1/responses',
      fullUrl: true
    })

    expect(secondId).not.toBe(firstId)
    expect(await store.listModels()).toHaveLength(2)
    expect((await store.resolveClientModel(secondId))?.api_base_url).toBe(
      'https://other.example.test/v1'
    )
  })

  it('stores DeepSeek as a platform and routes it to the official Responses base URL', async () => {
    const store = new LocalModelStore({ userDataPath, secretStorage })
    const selectionId = await store.addModel({
      ...input,
      platform: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-flash'
    })

    expect(await store.listModels()).toEqual([
      expect.objectContaining({ id: selectionId, displayName: 'deepseek-flash · DeepSeek' })
    ])
    expect(await store.resolveClientModel(selectionId)).toMatchObject({
      model_id: 'deepseek-flash',
      api_base_url: 'https://api.deepseek.com',
      api_key: 'secret-key'
    })
    const saved = JSON.parse(await readFile(join(userDataPath, 'local-models.json'), 'utf8')) as {
      dascowork: { models: Array<{ platform: string }> }
    }
    expect(saved.dascowork.models[0]?.platform).toBe('deepseek')
  })

  it('keeps previously saved OpenAI models readable', async () => {
    const store = new LocalModelStore({ userDataPath, secretStorage })
    const selectionId = await store.addModel(input)
    const configPath = join(userDataPath, 'local-models.json')
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as {
      dascowork: { models: Array<{ platform: string }> }
    }
    saved.dascowork.models[0]!.platform = 'openai'
    await writeFile(configPath, JSON.stringify(saved))

    const reloaded = new LocalModelStore({ userDataPath, secretStorage })
    expect(await reloaded.listModels()).toEqual([
      expect.objectContaining({ id: selectionId, displayName: 'local-vision · OpenAI' })
    ])
  })

  it('rejects an unsupported full request path', async () => {
    const store = new LocalModelStore({ userDataPath, secretStorage })
    await expect(
      store.addModel({
        ...input,
        baseUrl: 'https://models.example.test/v1/chat/completions',
        fullUrl: true
      })
    ).rejects.toThrow('Responses')
  })
})
