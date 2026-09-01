// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginCenterUserMcpServer } from '../../../../shared/pluginCenterApi'
import { McpServerEditor, type McpServerEditorProps } from './McpServerEditor'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

async function cleanupRenderedEditors(): Promise<void> {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount()
    })
  }
  document.body.replaceChildren()
}

afterEach(async () => {
  await cleanupRenderedEditors()
  vi.restoreAllMocks()
})

const stdioServer: PluginCenterUserMcpServer = {
  id: 'local-tools',
  name: 'local-tools',
  displayName: 'Local tools',
  enabled: true,
  connected: true,
  authStatus: 'unsupported',
  toolCount: 1,
  origin: 'user',
  editable: true,
  canToggle: true,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@example/server'],
  cwd: '/repo',
  env: [{ name: 'API_KEY', hasValue: true, editable: true }],
  envVars: [{ name: 'PATH', editable: true }]
}

function editorProps(overrides: Partial<McpServerEditorProps> = {}): McpServerEditorProps {
  return {
    server: null,
    pending: false,
    error: null,
    onBack: vi.fn(),
    onSave: vi.fn(),
    onUninstall: vi.fn(),
    onOpenDocumentation: vi.fn(),
    ...overrides
  }
}

async function renderEditor(
  overrides: Partial<McpServerEditorProps> = {}
): Promise<McpServerEditorProps> {
  const props = editorProps(overrides)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<McpServerEditor {...props} />)
    await Promise.resolve()
  })
  return props
}

async function changeInput(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
  })
}

function button(text: string): HTMLButtonElement {
  const value = [...document.querySelectorAll<HTMLButtonElement>('button')].find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!value) throw new Error(`Missing button: ${text}`)
  return value
}

function buttons(text: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter((candidate) =>
    candidate.textContent?.includes(text)
  )
}

function inputByPlaceholder(placeholder: string): HTMLInputElement {
  const value = document.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)
  if (!value) throw new Error(`Missing input: ${placeholder}`)
  return value
}

describe('McpServerEditor', () => {
  it('uses the edit layout and preserves a saved secret as keep', async () => {
    const props = await renderEditor({ server: stdioServer })

    expect(document.body.textContent).toContain('更新 Local tools MCP')
    expect(document.body.textContent).toContain('如需切换 MCP 服务器类型，请先卸载当前配置。')
    expect(document.body.textContent).toContain('卸载')
    expect(document.body.querySelector('[role="group"][aria-label="MCP 服务器类型"]')).toBeNull()
    expect(
      document.body.querySelector<HTMLInputElement>('input[placeholder="已保存"]')?.value
    ).toBe('')
    expect(document.body.textContent).not.toContain('secret')

    await changeInput(inputByPlaceholder('npx'), ' node ')
    await act(async () => {
      button('保存').click()
    })

    expect(props.onSave).toHaveBeenCalledWith({
      serverId: 'local-tools',
      server: {
        transport: 'stdio',
        command: 'node',
        args: ['-y', '@example/server'],
        cwd: '/repo',
        env: [{ name: 'API_KEY', value: { action: 'keep' } }],
        envVars: ['PATH']
      }
    })
  })

  it('builds ordered array rows and filters incomplete key-value rows when creating a STDIO server', async () => {
    const props = await renderEditor()

    await changeInput(inputByPlaceholder('例如：本地工具'), '  New tools  ')
    await changeInput(inputByPlaceholder('npx'), ' npx ')
    await changeInput(inputByPlaceholder('参数'), ' -y ')
    await act(async () => {
      button('添加参数').click()
    })
    const argumentInputs = document.querySelectorAll<HTMLInputElement>('input[placeholder="参数"]')
    await changeInput(argumentInputs[1]!, ' @scope/server ')
    await changeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="名称 1"]')!,
      ' TOKEN '
    )
    await changeInput(
      document.querySelector<HTMLInputElement>('input[aria-label="值 1"]')!,
      ' secret '
    )
    await act(async () => {
      buttons('添加环境变量')[1]?.click()
    })
    const variableInputs = document.querySelectorAll<HTMLInputElement>(
      'input[placeholder="变量名"]'
    )
    await changeInput(variableInputs[0]!, ' PATH ')
    await changeInput(variableInputs[1]!, ' PATH ')
    await changeInput(inputByPlaceholder('可选'), ' /workspace ')

    await act(async () => {
      button('保存').click()
    })

    expect(props.onSave).toHaveBeenCalledWith({
      displayName: 'New tools',
      server: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@scope/server'],
        cwd: '/workspace',
        env: [{ name: 'TOKEN', value: { action: 'set', value: 'secret' } }],
        envVars: ['PATH']
      }
    })
  })

  it('emits a remove patch when an existing secret row is deleted', async () => {
    const props = await renderEditor({ server: stdioServer })
    const savedValue = inputByPlaceholder('已保存')
    const remove = savedValue.parentElement?.querySelector<HTMLButtonElement>(
      'button[aria-label="删除此行"]'
    )

    await act(async () => {
      remove?.click()
    })
    await changeInput(inputByPlaceholder('npx'), 'node')
    await act(async () => {
      button('保存').click()
    })

    expect(props.onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        server: expect.objectContaining({
          env: [{ name: 'API_KEY', value: { action: 'remove' } }]
        })
      })
    )
  })

  it('allows only a new server to switch transport and keeps sensitive HTTP values redacted', async () => {
    const httpServer: PluginCenterUserMcpServer = {
      id: 'remote',
      name: 'remote',
      enabled: true,
      connected: true,
      authStatus: 'bearerToken',
      toolCount: 1,
      origin: 'user',
      editable: true,
      canToggle: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.test',
      bearerTokenEnvVar: 'MCP_TOKEN',
      httpHeaders: [{ name: 'Authorization', hasValue: true, editable: true }],
      envHttpHeaders: [{ name: 'X-Trace', envVarName: 'TRACE_ID', editable: true }]
    }
    await renderEditor({ server: httpServer })

    expect(document.body.textContent).toContain('Bearer Token 环境变量')
    expect(document.body.textContent).not.toContain('Authorization')
    expect(document.body.querySelector('input[placeholder="已保存"]')).not.toBeNull()
    expect(document.body.querySelector('[role="group"][aria-label="MCP 服务器类型"]')).toBeNull()

    await cleanupRenderedEditors()
    await renderEditor()
    await act(async () => {
      button('HTTP').click()
    })
    expect(document.body.textContent).toContain('从环境变量读取的请求头')
    expect(document.body.textContent).not.toContain('启动命令')
  })

  it('leaves a blank row available after deleting the only dynamic value', async () => {
    await renderEditor()

    const deleteButton = document.querySelector<HTMLButtonElement>('button[aria-label="删除此行"]')
    if (!deleteButton) throw new Error('Missing row delete button')
    await act(async () => {
      deleteButton.click()
    })

    expect(document.querySelectorAll('input[placeholder="参数"]')).toHaveLength(1)
  })

  it('disables all editor actions while a save or uninstall is pending', async () => {
    await renderEditor({ server: stdioServer, pending: true })

    expect(button('取消').disabled).toBe(true)
    expect(button('卸载').disabled).toBe(true)
    expect(button('保存').disabled).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[placeholder="npx"]')?.disabled).toBe(
      true
    )
    expect(
      document.querySelectorAll<HTMLButtonElement>('button[aria-label="删除此行"]')[0]?.disabled
    ).toBe(true)
  })
})
