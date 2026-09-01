import * as React from 'react'
import { CircleAlertIcon, Loader2Icon, PlusIcon, Trash2Icon } from 'lucide-react'

import type {
  PluginCenterMcpServerInput,
  PluginCenterNamedSecretPatch,
  PluginCenterUserMcpServer
} from '../../../../shared/pluginCenterApi'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type Transport = PluginCenterMcpServerInput['transport']
type StringRow = { value: string; editable: boolean }
type KeyValueRow = { name: string; value: string }
type SecretRow = KeyValueRow & {
  existing: boolean
  hasValue: boolean
  editable: boolean
  removed: boolean
}

export type McpServerEditorSaveInput = {
  serverId?: string
  displayName?: string
  server: PluginCenterMcpServerInput
}

export type McpServerEditorProps = {
  server?: PluginCenterUserMcpServer | null
  pending: boolean
  error?: string | null
  onBack: () => void
  onSave: (input: McpServerEditorSaveInput) => void
  onUninstall: () => void
  onOpenDocumentation: () => void
}

function blankStringRow(): StringRow {
  return { value: '', editable: true }
}

function blankKeyValueRow(): KeyValueRow {
  return { name: '', value: '' }
}

function blankSecretRow(): SecretRow {
  return { ...blankKeyValueRow(), existing: false, hasValue: false, editable: true, removed: false }
}

function withBlankStringRow(rows: StringRow[]): StringRow[] {
  return rows.length > 0 ? rows : [blankStringRow()]
}

function withBlankKeyValueRow(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.length > 0 ? rows : [blankKeyValueRow()]
}

function withBlankSecretRow(rows: SecretRow[]): SecretRow[] {
  return rows.some((row) => !row.removed) ? rows : [...rows, blankSecretRow()]
}

function normalizeStrings(rows: StringRow[], unique = false): string[] {
  const values = rows.map((row) => row.value.trim()).filter(Boolean)
  return unique ? [...new Set(values)] : values
}

function normalizeKeyValues(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.flatMap((row) => {
    const name = row.name.trim()
    const value = row.value.trim()
    return name && value ? [{ name, value }] : []
  })
}

function secretRows(
  entries: Array<{ name: string; hasValue: boolean; editable: boolean }>
): SecretRow[] {
  return withBlankSecretRow(
    entries.map((entry) => ({
      name: entry.name,
      value: '',
      existing: true,
      hasValue: entry.hasValue,
      editable: entry.editable,
      removed: false
    }))
  )
}

function secretPatches(rows: SecretRow[]): PluginCenterNamedSecretPatch[] {
  const patches = new Map<string, PluginCenterNamedSecretPatch>()
  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    if (row.removed) {
      if (row.existing) patches.set(name, { name, value: { action: 'remove' } })
      continue
    }
    const value = row.value.trim()
    if (value) {
      patches.set(name, { name, value: { action: 'set', value } })
    } else if (row.existing) {
      patches.set(name, { name, value: { action: 'keep' } })
    }
  }
  return [...patches.values()]
}

function displayServerName(server: PluginCenterUserMcpServer): string {
  const name = server.displayName ?? server.name
  return name ? `${name.slice(0, 1).toUpperCase()}${name.slice(1)}` : 'MCP'
}

function Field({
  label,
  required,
  children
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="grid gap-2">
      <div className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive"> *</span>}
      </div>
      {children}
    </div>
  )
}

function RowControls({
  onRemove,
  disabled,
  label = '删除此行'
}: {
  onRemove: () => void
  disabled: boolean
  label?: string
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={onRemove}
    >
      <Trash2Icon className="size-4" />
    </Button>
  )
}

function StringRows({
  rows,
  pending,
  placeholder,
  addLabel,
  onChange
}: {
  rows: StringRow[]
  pending: boolean
  placeholder: string
  addLabel: string
  onChange: (rows: StringRow[]) => void
}): React.JSX.Element {
  const update = (index: number, value: string): void => {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, value } : row)))
  }
  const remove = (index: number): void => {
    onChange(withBlankStringRow(rows.filter((_, rowIndex) => rowIndex !== index)))
  }
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={row.value}
            disabled={pending || !row.editable}
            placeholder={placeholder}
            onChange={(event) => update(index, event.target.value)}
          />
          <RowControls onRemove={() => remove(index)} disabled={pending || !row.editable} />
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() => onChange([...rows, blankStringRow()])}
      >
        <PlusIcon className="size-4" />
        {addLabel}
      </Button>
    </div>
  )
}

function KeyValueRows({
  rows,
  pending,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  onChange
}: {
  rows: KeyValueRow[]
  pending: boolean
  keyPlaceholder: string
  valuePlaceholder: string
  addLabel: string
  onChange: (rows: KeyValueRow[]) => void
}): React.JSX.Element {
  const update = (index: number, key: keyof KeyValueRow, value: string): void => {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)))
  }
  const remove = (index: number): void => {
    onChange(withBlankKeyValueRow(rows.filter((_, rowIndex) => rowIndex !== index)))
  }
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2"
        >
          <Input
            value={row.name}
            disabled={pending}
            placeholder={keyPlaceholder}
            aria-label={`${keyPlaceholder} ${index + 1}`}
            onChange={(event) => update(index, 'name', event.target.value)}
          />
          <Input
            value={row.value}
            disabled={pending}
            placeholder={valuePlaceholder}
            aria-label={`${valuePlaceholder} ${index + 1}`}
            onChange={(event) => update(index, 'value', event.target.value)}
          />
          <RowControls onRemove={() => remove(index)} disabled={pending} />
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() => onChange([...rows, blankKeyValueRow()])}
      >
        <PlusIcon className="size-4" />
        {addLabel}
      </Button>
    </div>
  )
}

function SecretRows({
  rows,
  pending,
  addLabel,
  onChange
}: {
  rows: SecretRow[]
  pending: boolean
  addLabel: string
  onChange: (rows: SecretRow[]) => void
}): React.JSX.Element {
  const update = (index: number, key: 'name' | 'value', value: string): void => {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, [key]: value } : row)))
  }
  const remove = (index: number): void => {
    const row = rows[index]
    if (!row) return
    const next = row.existing
      ? rows.map((candidate, candidateIndex) =>
          candidateIndex === index ? { ...candidate, removed: true } : candidate
        )
      : rows.filter((_, candidateIndex) => candidateIndex !== index)
    onChange(withBlankSecretRow(next))
  }
  return (
    <div className="grid gap-2">
      {rows.map((row, index) => {
        if (row.removed) return null
        return (
          <div
            key={`${row.existing ? 'saved' : 'new'}-${index}`}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2"
          >
            <Input
              value={row.name}
              disabled={pending || (row.existing && !row.editable)}
              readOnly={row.existing}
              placeholder="名称"
              aria-label={`名称 ${index + 1}`}
              onChange={(event) => update(index, 'name', event.target.value)}
            />
            <Input
              value={row.value}
              type="password"
              disabled={pending || !row.editable}
              placeholder={row.existing && row.hasValue ? '已保存' : '值'}
              aria-label={`值 ${index + 1}`}
              onChange={(event) => update(index, 'value', event.target.value)}
            />
            <RowControls onRemove={() => remove(index)} disabled={pending || !row.editable} />
          </div>
        )
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        disabled={pending}
        onClick={() => onChange([...rows, blankSecretRow()])}
      >
        <PlusIcon className="size-4" />
        {addLabel}
      </Button>
    </div>
  )
}

export function McpServerEditor({
  server,
  pending,
  error,
  onBack,
  onSave,
  onUninstall,
  onOpenDocumentation
}: McpServerEditorProps): React.JSX.Element {
  const editing = server ?? null
  const [transport, setTransport] = React.useState<Transport>('stdio')
  const [displayName, setDisplayName] = React.useState('')
  const [command, setCommand] = React.useState('')
  const [args, setArgs] = React.useState<StringRow[]>([blankStringRow()])
  const [env, setEnv] = React.useState<SecretRow[]>([blankSecretRow()])
  const [envVars, setEnvVars] = React.useState<StringRow[]>([blankStringRow()])
  const [cwd, setCwd] = React.useState('')
  const [url, setUrl] = React.useState('')
  const [bearerTokenEnvVar, setBearerTokenEnvVar] = React.useState('')
  const [httpHeaders, setHttpHeaders] = React.useState<SecretRow[]>([blankSecretRow()])
  const [envHttpHeaders, setEnvHttpHeaders] = React.useState<KeyValueRow[]>([blankKeyValueRow()])
  const initializedServerId = React.useRef<string | null>(null)

  React.useEffect(() => {
    const serverId = editing?.id ?? null
    if (initializedServerId.current === serverId) return
    initializedServerId.current = serverId
    setTransport(editing?.transport ?? 'stdio')
    setDisplayName(editing?.displayName ?? editing?.name ?? '')
    setCommand(editing?.transport === 'stdio' ? (editing.command ?? '') : '')
    setArgs(
      editing?.transport === 'stdio'
        ? withBlankStringRow(editing.args.map((value) => ({ value, editable: true })))
        : [blankStringRow()]
    )
    setEnv(editing?.transport === 'stdio' ? secretRows(editing.env) : [blankSecretRow()])
    setEnvVars(
      editing?.transport === 'stdio'
        ? withBlankStringRow(
            editing.envVars.map((entry) => ({ value: entry.name, editable: entry.editable }))
          )
        : [blankStringRow()]
    )
    setCwd(editing?.transport === 'stdio' ? (editing.cwd ?? '') : '')
    setUrl(editing?.transport === 'streamable-http' ? (editing.url ?? '') : '')
    setBearerTokenEnvVar(
      editing?.transport === 'streamable-http' ? (editing.bearerTokenEnvVar ?? '') : ''
    )
    setHttpHeaders(
      editing?.transport === 'streamable-http'
        ? secretRows(editing.httpHeaders)
        : [blankSecretRow()]
    )
    setEnvHttpHeaders(
      editing?.transport === 'streamable-http'
        ? withBlankKeyValueRow(
            editing.envHttpHeaders.map((entry) => ({ name: entry.name, value: entry.envVarName }))
          )
        : [blankKeyValueRow()]
    )
  }, [editing])

  const input = React.useMemo<PluginCenterMcpServerInput>(() => {
    if (transport === 'stdio') {
      return {
        transport,
        command: command.trim(),
        args: normalizeStrings(args),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
        env: secretPatches(env),
        envVars: normalizeStrings(
          envVars.filter((row) => row.editable),
          true
        )
      }
    }
    return {
      transport,
      url: url.trim(),
      ...(bearerTokenEnvVar.trim() ? { bearerTokenEnvVar: bearerTokenEnvVar.trim() } : {}),
      httpHeaders: secretPatches(httpHeaders),
      envHttpHeaders: normalizeKeyValues(envHttpHeaders).map((entry) => ({
        name: entry.name,
        envVarName: entry.value
      }))
    }
  }, [
    args,
    bearerTokenEnvVar,
    command,
    cwd,
    env,
    envHttpHeaders,
    envVars,
    httpHeaders,
    transport,
    url
  ])

  const initialInput = React.useMemo<PluginCenterMcpServerInput | null>(() => {
    if (!editing) return null
    if (editing.transport === 'stdio') {
      return {
        transport: 'stdio',
        command: editing.command ?? '',
        args: editing.args,
        ...(editing.cwd ? { cwd: editing.cwd } : {}),
        env: editing.env.map((entry) => ({ name: entry.name, value: { action: 'keep' as const } })),
        envVars: editing.envVars.filter((entry) => entry.editable).map((entry) => entry.name)
      }
    }
    return {
      transport: 'streamable-http',
      url: editing.url ?? '',
      ...(editing.bearerTokenEnvVar ? { bearerTokenEnvVar: editing.bearerTokenEnvVar } : {}),
      httpHeaders: editing.httpHeaders.map((entry) => ({
        name: entry.name,
        value: { action: 'keep' as const }
      })),
      envHttpHeaders: editing.envHttpHeaders.map((entry) => ({
        name: entry.name,
        envVarName: entry.envVarName
      }))
    }
  }, [editing])

  const isDirty = !initialInput || JSON.stringify(input) !== JSON.stringify(initialInput)
  const isValid =
    (editing ? true : displayName.trim().length > 0) &&
    (transport === 'stdio' ? command.trim().length > 0 : url.trim().length > 0)

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onBack()}>
      <DialogContent
        data-slot="mcp-server-editor"
        className="flex max-h-[min(720px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5 pe-14">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle>
                {editing ? `更新 ${displayServerName(editing)} MCP` : '连接至自定义 MCP'}
              </DialogTitle>
              {editing ? (
                <DialogDescription className="mt-2">
                  如需切换 MCP 服务器类型，请先卸载当前配置。
                </DialogDescription>
              ) : (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto px-0"
                  disabled={pending}
                  onClick={onOpenDocumentation}
                >
                  查看 MCP 服务器文档
                </Button>
              )}
            </div>
            {editing && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={pending}
                onClick={onUninstall}
              >
                {pending && <Loader2Icon className="size-4 animate-spin" />}
                卸载
              </Button>
            )}
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {!editing && (
            <Field label="名称" required>
              <Input
                value={displayName}
                disabled={pending}
                placeholder="例如：本地工具"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
          )}

          {!editing && (
            <Field label="服务器类型">
              <div className="flex gap-2" role="group" aria-label="MCP 服务器类型">
                <Button
                  type="button"
                  variant={transport === 'stdio' ? 'secondary' : 'outline'}
                  disabled={pending}
                  onClick={() => setTransport('stdio')}
                >
                  STDIO
                </Button>
                <Button
                  type="button"
                  variant={transport === 'streamable-http' ? 'secondary' : 'outline'}
                  disabled={pending}
                  onClick={() => setTransport('streamable-http')}
                >
                  HTTP
                </Button>
              </div>
            </Field>
          )}

          {transport === 'stdio' ? (
            <div className="grid gap-5">
              <Field label="启动命令" required>
                <Input
                  value={command}
                  disabled={pending}
                  placeholder="npx"
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              <Field label="参数">
                <StringRows
                  rows={args}
                  pending={pending}
                  placeholder="参数"
                  addLabel="添加参数"
                  onChange={setArgs}
                />
              </Field>
              <Field label="环境变量">
                <SecretRows
                  rows={env}
                  pending={pending}
                  addLabel="添加环境变量"
                  onChange={setEnv}
                />
              </Field>
              <Field label="环境变量传递">
                <StringRows
                  rows={envVars}
                  pending={pending}
                  placeholder="变量名"
                  addLabel="添加环境变量"
                  onChange={setEnvVars}
                />
              </Field>
              <Field label="工作目录">
                <Input
                  value={cwd}
                  disabled={pending}
                  placeholder="可选"
                  onChange={(event) => setCwd(event.target.value)}
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-5">
              <Field label="URL" required>
                <Input
                  value={url}
                  disabled={pending}
                  placeholder="https://example.com/mcp"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
              <Field label="Bearer Token 环境变量">
                <Input
                  value={bearerTokenEnvVar}
                  disabled={pending}
                  placeholder="TOKEN_ENV_NAME"
                  onChange={(event) => setBearerTokenEnvVar(event.target.value)}
                />
              </Field>
              <Field label="请求头">
                <SecretRows
                  rows={httpHeaders}
                  pending={pending}
                  addLabel="添加请求头"
                  onChange={setHttpHeaders}
                />
              </Field>
              <Field label="从环境变量读取的请求头">
                <KeyValueRows
                  rows={envHttpHeaders}
                  pending={pending}
                  keyPlaceholder="请求头名称"
                  valuePlaceholder="环境变量名"
                  addLabel="添加请求头"
                  onChange={setEnvHttpHeaders}
                />
              </Field>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-4">
          <Button type="button" variant="outline" disabled={pending} onClick={onBack}>
            取消
          </Button>
          <Button
            type="button"
            disabled={pending || !isDirty || !isValid}
            onClick={() =>
              onSave({
                ...(editing ? { serverId: editing.id } : { displayName: displayName.trim() }),
                server: input
              })
            }
          >
            {pending && <Loader2Icon className="size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
