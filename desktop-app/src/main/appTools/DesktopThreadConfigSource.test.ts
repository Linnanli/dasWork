import { describe, expect, it } from 'vitest'

import { DesktopThreadConfigSource, mergeDesktopThreadConfig } from './DesktopThreadConfigSource'

describe('DesktopThreadConfigSource', () => {
  it('creates one main-owned MCP projection with the private pipe path', () => {
    const pluginRoot =
      '/Applications/dasCowork.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools'
    const config = new DesktopThreadConfigSource({
      pipePath: '/private/tmp/codex-app-tools.sock',
      pluginRoot,
      platform: 'darwin'
    }).snapshot()

    expect(config).toEqual({
      mcp_servers: {
        codex_app: {
          command:
            '/Applications/dasCowork.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools/scripts/launch_codex_app_tools_mcp',
          args: [
            '/Applications/dasCowork.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools/server.mjs'
          ],
          cwd: '/Applications/dasCowork.app/Contents/Resources/plugins/openai-bundled/plugins/codex-app-tools',
          enabled: true,
          env: {
            CODEX_APP_TOOLS_PIPE_PATH: '/private/tmp/codex-app-tools.sock',
            CODEX_MCP_NODE_PATH: process.execPath,
            ELECTRON_RUN_AS_NODE: '1'
          },
          startup_timeout_sec: 10,
          tool_timeout_sec: 3600
        }
      }
    })
  })

  it('keeps custom model-provider configuration intact', () => {
    const merged = mergeDesktopThreadConfig(
      {
        model_provider: 'company',
        model_providers: { company: { base_url: 'https://models.example.test/v1' } }
      },
      new DesktopThreadConfigSource({
        pipePath: '/tmp/c.sock',
        pluginRoot: '/plugin-root',
        platform: 'linux'
      }).snapshot()
    )

    expect(merged).toMatchObject({
      model_provider: 'company',
      model_providers: { company: { base_url: 'https://models.example.test/v1' } },
      mcp_servers: {
        codex_app: {
          env: expect.objectContaining({ CODEX_APP_TOOLS_PIPE_PATH: '/tmp/c.sock' })
        }
      }
    })
  })

  it('fails instead of silently replacing an owned MCP configuration', () => {
    expect(() =>
      mergeDesktopThreadConfig(
        { mcp_servers: { codex_app: { command: 'other' } } },
        new DesktopThreadConfigSource({
          pipePath: '/tmp/c.sock',
          pluginRoot: '/plugin-root'
        }).snapshot()
      )
    ).toThrow('Desktop MCP server configuration conflicts')
  })
})
