/** Sensitive provider settings passed from Main to the Codex app-server only. */
export type LocalClientModel = {
  model_id: string
  display_name: string
  description: string | null
  provider: string
  is_default: boolean
  capabilities: string[]
  api_base_url: string
  api_key: string
  api_format: 'openai'
  source: 'local'
  api_query_params?: Record<string, string>
}
