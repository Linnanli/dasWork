import { useRef, useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export type RemoteProjectInput = {
  hostId: string
  label: string
  remotePath: string
  execServerUrl: string
  terminalCommand?: string
}

export type CreateRemoteProjectDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: RemoteProjectInput) => Promise<void>
}

export function CreateRemoteProjectDialog({
  open,
  onOpenChange,
  onCreate
}: CreateRemoteProjectDialogProps): React.JSX.Element {
  const hostInputRef = useRef<HTMLInputElement>(null)
  const [hostId, setHostId] = useState('')
  const [label, setLabel] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [execServerUrl, setExecServerUrl] = useState('')
  const [terminalCommand, setTerminalCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const resetForm = (): void => {
    setHostId('')
    setLabel('')
    setRemotePath('')
    setExecServerUrl('')
    setTerminalCommand('')
    setError(null)
    setCreating(false)
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) resetForm()
    onOpenChange(nextOpen)
  }

  const createProject = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const input = {
      hostId: hostId.trim(),
      label: label.trim(),
      remotePath: remotePath.trim(),
      execServerUrl: execServerUrl.trim(),
      ...(terminalCommand.trim() ? { terminalCommand: terminalCommand.trim() } : {})
    }
    if (!input.hostId || !input.label || !input.remotePath || !input.execServerUrl) {
      setError('请填写远程主机、项目名称、项目路径和执行服务地址')
      return
    }

    setCreating(true)
    setError(null)
    try {
      await onCreate(input)
      handleOpenChange(false)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={creating ? undefined : handleOpenChange}>
      <DialogContent
        data-slot="create-remote-project-dialog"
        className="bg-popover/90 sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          hostInputRef.current?.focus()
        }}
      >
        <form className="grid gap-4" onSubmit={(event) => void createProject(event)}>
          <DialogHeader>
            <DialogTitle>连接远程项目</DialogTitle>
            <DialogDescription>
              远程执行服务会在该主机的项目路径中运行 Codex。地址必须是 ws:// 或 wss://。
            </DialogDescription>
          </DialogHeader>
          <ProjectField
            autoComplete="off"
            dataSlot="remote-project-host-input"
            inputRef={hostInputRef}
            label="远程主机 ID"
            placeholder="例如：devbox"
            value={hostId}
            onChange={setHostId}
          />
          <ProjectField
            dataSlot="remote-project-label-input"
            label="项目名称"
            placeholder="例如：支付服务"
            value={label}
            onChange={setLabel}
          />
          <ProjectField
            autoComplete="off"
            dataSlot="remote-project-path-input"
            label="远程项目路径"
            placeholder="例如：/srv/payments"
            value={remotePath}
            onChange={setRemotePath}
          />
          <ProjectField
            autoComplete="url"
            dataSlot="remote-project-exec-server-input"
            label="Codex 执行服务地址"
            placeholder="例如：wss://exec.example.com/codex"
            value={execServerUrl}
            onChange={setExecServerUrl}
          />
          <ProjectField
            autoComplete="off"
            dataSlot="remote-project-terminal-command-input"
            label="终端命令（可选）"
            placeholder="例如：/bin/zsh"
            value={terminalCommand}
            onChange={setTerminalCommand}
          />
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              disabled={creating}
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              取消
            </Button>
            <Button disabled={creating} type="submit">
              {creating ? '正在连接…' : '连接项目'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ProjectField({
  autoComplete = 'off',
  dataSlot,
  inputRef,
  label,
  placeholder,
  value,
  onChange
}: {
  autoComplete?: string
  dataSlot: string
  inputRef?: React.RefObject<HTMLInputElement | null>
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <label className="grid gap-1.5 text-sm">
      <span>{label}</span>
      <input
        ref={inputRef}
        autoComplete={autoComplete}
        className="h-10 w-full rounded-md border bg-transparent px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        data-slot={dataSlot}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}
